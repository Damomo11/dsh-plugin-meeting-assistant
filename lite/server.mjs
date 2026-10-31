// lite/server.mjs — 轻量版会议助手：一个零依赖的本地 Node 服务（Node ≥ 20）。
//
// 用 `node lite/server.mjs` 启动，浏览器打开 http://127.0.0.1:8787 即可用。
// 架构与原 DSH 插件一致，只是宿主换成了独立 HTTP 服务：
//   浏览器 AudioWorklet 采集麦克风 → 16k PCM 经 /api/audio 送本服务 →
//   服务端 DashscopeAsrStream + ResilientAsrSession（vendor 内核，原样复用）转写 →
//   转写落盘 + 触发 MeetingCoach 自动分析 → OpenAI 兼容接口生成发言建议。
// LLM 的 baseUrl/model 存在服务端配置里，apiKey 由服务端持有，页面不接触密钥。

import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, chmodSync, statSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DashscopeAsrStream, ResilientAsrSession } from '../src/vendor/voice-kernel/index.mjs';
import { MeetingStore } from './store.mjs';
import { MeetingCoach, BriefStore } from './coach.mjs';
import { readConfig, saveVoiceConfig, voiceHome } from './config.mjs';
import { chatCompletion, polishGoalRequest, llmConfigValid } from './llm.mjs';
import { loadProjectContext } from './project-context.mjs';
import { redactCredentials } from './redact.mjs';
import { formatLogLine } from './diag.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MEETING_PORT ?? 8787);
const HOST = process.env.MEETING_HOST ?? '127.0.0.1';
const ROOT = voiceHome(); // ~/.agent-mesh/voice（MESH_VOICE_HOME 可覆盖）
export const SESSION_ID = 'lite'; // 单机单用户：一个固定会话名，录音目录沿用原插件布局

mkdirSync(ROOT, { recursive: true, mode: 0o700 });
const store = new MeetingStore(ROOT);
const briefs = new BriefStore(store);

// ---- 配置分两块：转写（百炼 SASR）与建议（OpenAI 兼容）。API Key 都只存本机配置文件。
const llmConfig = () => {
  let saved = {};
  try { saved = JSON.parse(readFileSync(join(ROOT, 'llm.json'), 'utf8')); } catch { /* 未配置 */ }
  return {
    baseUrl: saved.baseUrl ?? process.env.OPENAI_BASE_URL ?? '',
    model: saved.model ?? process.env.OPENAI_MODEL ?? '',
    apiKey: saved.apiKey ?? process.env.OPENAI_API_KEY ?? '',
  };
};
function saveLlmConfig(draft) {
  const previous = llmConfig();
  const next = {
    baseUrl: draft.baseUrl ?? previous.baseUrl,
    model: draft.model ?? previous.model,
    apiKey: draft.apiKey ?? previous.apiKey,
  };
  if (typeof next.baseUrl !== 'string' || !/^https?:\/\//.test(next.baseUrl)) throw new Error('LLM Base URL 必须是 http(s):// 地址。');
  if (!next.model?.trim()) throw new Error('请填写模型名。');
  const tmp = join(ROOT, `llm.json.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, join(ROOT, 'llm.json'));
  chmodSync(join(ROOT, 'llm.json'), 0o600);
  return { baseUrl: next.baseUrl, model: next.model, configured: !!next.apiKey };
}
function publicLlmConfig() {
  const c = llmConfig();
  return { baseUrl: c.baseUrl, model: c.model, configured: llmConfigValid(c) };
}

// ---- 录音服务：对应原插件 MeetingService，但事件用 SSE 推给页面而不是靠 1.5s 轮询。
let active = null;
const liveClients = new Set(); // SSE: status + 转写 + 建议状态实时推
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of liveClients) res.write(frame);
}

function startRecording() {
  if (active) throw new Error('已有会议正在录音，请先结束当前录音。');
  const config = readConfig(ROOT); // validateVoiceConfig 由 config.mjs 提供
  if (!config.apiKey) throw new Error('请先在设置中填写百炼 API Key。');
  briefs.initialize(SESSION_ID); // 录音前必须确认过会前准备
  const meta = store.create(SESSION_ID);
  store.select(SESSION_ID, meta.id);
  const token = randomUUID();
  const brief = briefs.read(SESSION_ID, meta.id);
  Object.assign(meta, { autoEnabled: brief.autoEnabled });
  const redact = message => message.split(config.apiKey).join('[redacted]').slice(0, 500);
  const session = new ResilientAsrSession({
    createStream: hooks => new DashscopeAsrStream({
      ...config, ...hooks,
      wsFactory: (url, headers) => new WebSocket(url, { headers }),
    }),
    onSentence: s => {
      try {
        const entry = store.append(meta, s);
        coach.transcribed(meta, entry);
        broadcast('transcript', { recordingId: meta.id, entry });
      } catch (e) { void stopRecording(token, String(e)); }
    },
    onState: state => {
      if (meta.endedAt || meta.state === 'stopping') return;
      meta.wsState = state;
      meta.state = state === 'ready' ? 'recording' : state === 'stopped' ? 'stopped' : 'reconnecting';
      store.save(meta);
      broadcast('recording-state', { recordingId: meta.id, state: meta.state, wsState });
    },
    onLog: message => {
      log('asr', redact(message));
      if (/fail|error|overflow|closed|lost|reconnect|timeout|stopp/i.test(message)) {
        meta.error = redact(message); store.save(meta);
        broadcast('recording-state', { recordingId: meta.id, state: meta.state, wsState: meta.wsState, error: meta.error });
      }
    },
  });
  const timer = setInterval(() => {
    const current = active;
    if (!current || current.token !== token || current.stopping) return;
    if (Date.now() - current.lastAudio > 15000) {
      void stopRecording(token, '麦克风连接已中断，录音已自动停止。');
      return;
    }
    Object.assign(meta, { reconnects: session.stats.reconnects, droppedBytes: session.stats.droppedBytes, wsState: session.stats.wsState });
    store.save(meta);
  }, 3000);
  timer.unref();
  active = { meta, token, session, lastAudio: Date.now(), nextSequence: 0, timer };
  void session.start().catch(e => {
    log('asr', `会话启动失败: ${redact(String(e))}`);
    return stopRecording(token, redact(String(e)));
  });
  coach.started(meta);
  return { token, recording: meta };
}

function acceptAudio(token, sequence, base64) {
  const current = active;
  if (!current || current.token !== token || current.stopping) throw new Error('录音已停止，请重新开始录音。');
  if (sequence < current.nextSequence) return { accepted: true }; // 重试确认，不重复收 PCM
  if (sequence !== current.nextSequence) throw new Error('音频片段顺序不一致，请重新开始录音。');
  if (typeof base64 !== 'string' || base64.length > 86000) throw new Error('无效的音频片段');
  const pcm = Buffer.from(base64, 'base64');
  if (!pcm.length || pcm.length % 2) throw new Error('音频必须为 16kHz 单声道 PCM16');
  try {
    store.audio(current.meta, pcm);
    current.session.feedAudio(pcm);
  } catch (e) { void stopRecording(token, '本地录音保存失败'); throw e; }
  current.nextSequence++;
  current.lastAudio = Date.now();
  return { accepted: true };
}

async function stopRecording(token, error) {
  const current = active;
  if (!current) return { stopped: true };
  if (current.token !== token) throw new Error('录音控制权不匹配');
  if (current.stopping) return current.stopping;
  clearInterval(current.timer);
  current.meta.state = 'stopping';
  store.save(current.meta);
  broadcast('recording-state', { recordingId: current.meta.id, state: 'stopping' });
  current.stopping = (async () => {
    try {
      const pending = await current.session.stop();
      Object.assign(current.meta, {
        endedAt: Date.now(), state: error ? 'error' : 'stopped',
        error: error ?? current.meta.error, untranscribedBytes: pending.length,
        reconnects: current.session.stats.reconnects, droppedBytes: current.session.stats.droppedBytes,
      });
      await store.finalize(current.meta);
      // 收尾时补一次自动分析，把最后几段转写纳入建议
      if (!error && current.meta.autoEnabled) { try { coach.request(SESSION_ID, current.meta.id, 'time'); } catch { /* 收尾分析失败不影响录音落盘 */ } }
    } catch (e) {
      current.meta.state = 'error';
      current.meta.error = '录音收尾失败，已保存的 PCM 和转写仍在本机';
      current.meta.endedAt = Date.now();
      store.save(current.meta);
    } finally {
      if (active === current) active = undefined;
      broadcast('recording-state', { recordingId: current.meta.id, state: current.meta.state });
      broadcast('status', statusPayload());
    }
  })();
  return current.stopping;
}

// ---- 建议：LLM 配置由服务端持有；会话模型/子 Agent 两条路径合并为这一条。
const coach = new MeetingCoach(store, {
  chat: async (input, signal) => {
    const cfg = llmConfig();
    if (!llmConfigValid(cfg)) throw new Error('请先在设置中配置 LLM（Base URL / 模型 / API Key）。');
    const result = await chatCompletion(cfg, input, { signal });
    return result;
  },
});
coach.briefs = briefs;

function statusPayload() {
  const recordings = store.list(SESSION_ID, 30).map(meta => {
    if (meta.id !== active?.meta.id && !meta.endedAt) {
      meta.state = 'interrupted';
      meta.endedAt = meta.startedAt + meta.audioBytes / 32;
      meta.error = '上次录音因服务退出而中断，已保存的音频和转写可以继续读取。';
      store.save(meta);
    }
    return meta;
  });
  const selected = recordings[0]?.id;
  const coachState = selected ? coach.status(store.get(SESSION_ID, selected)) : null;
  return {
    active: active ? { sessionId: SESSION_ID, id: active.meta.id, state: active.meta.state } : null,
    recordings,
    coach: coachState,
    llm: publicLlmConfig(),
    voice: (({ apiKey, ...rest }) => ({ ...rest, configured: !!apiKey }))(readConfig(ROOT)),
  };
}

// ---- 诊断日志（内存环 + stderr）
const logs = [];
function log(scope, message, extra) {
  const line = formatLogLine(scope, message, extra);
  logs.push(line); if (logs.length > 400) logs.shift();
  if (process.env.MEETING_DEBUG) console.error(line);
}

// ---- HTTP 路由 ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.json': 'application/json; charset=utf-8' };
function serveFile(res, file, fallbackType) {
  const type = MIME[extname(file)] ?? fallbackType ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
}
function json(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function route(req, res, pathname) {
  // 页面与静态资源
  if (req.method === 'GET' && pathname === '/') return serveFile(res, join(__dirname, 'public', 'index.html'));
  if (req.method === 'GET' && pathname === '/worklet.js') return serveFile(res, join(__dirname, 'worklet.mjs'), 'text/javascript; charset=utf-8');
  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    liveClients.add(res);
    req.on('close', () => liveClients.delete(res));
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/audio/')) {
    // 回放已结束录音的 WAV（目录不可遍历，路径由录音 ID 白名单校验）
    const id = pathname.slice('/audio/'.length).replace(/\.wav$/, '');
    const meta = store.get(SESSION_ID, id);
    const file = join(store.dir(SESSION_ID, meta.id), 'audio.wav');
    if (!existsSync(file)) return json(res, 404, { error: '尚未生成音频文件' });
    return serveFile(res, file);
  }

  // ---- API ----
  if (!pathname.startsWith('/api/')) return json(res, 404, { error: 'Not Found' });
  const api = pathname.slice('/api/'.length);
  const body = ['GET', 'HEAD'].includes(req.method) ? {} : JSON.parse((await readBody(req)).toString('utf8') || '{}');

  if (api === 'status' && req.method === 'GET') return json(res, 200, statusPayload());

  if (api === 'voice-config' && req.method === 'GET') {
    const c = readConfig(ROOT);
    return json(res, 200, { wsBase: c.wsBase, model: c.model, configured: !!c.apiKey });
  }
  if (api === 'voice-config' && req.method === 'POST') {
    if (active) throw new Error('请先停止录音，再修改语音识别设置。');
    return json(res, 200, saveVoiceConfig(ROOT, body));
  }
  if (api === 'llm-config' && req.method === 'GET') return json(res, 200, publicLlmConfig());
  if (api === 'llm-config' && req.method === 'POST') {
    coach.suspend();
    try { return json(res, 200, saveLlmConfig(body)); } finally { coach.resume(); }
  }

  if (api === 'brief' && req.method === 'GET') {
    const recordingId = body.recordingId || undefined;
    return json(res, 200, briefs.public(briefs.read(SESSION_ID, recordingId)));
  }
  if (api === 'brief' && req.method === 'POST') {
    const saved = await briefs.save(SESSION_ID, body.cwd ?? '', body.brief ?? body, body.recordingId);
    return json(res, 200, briefs.public(saved));
  }
  if (api === 'brief/polish' && req.method === 'POST') {
    const cfg = llmConfig();
    if (!llmConfigValid(cfg)) throw new Error('请先在设置中配置 LLM。');
    const candidates = await polishGoalRequest(cfg, body, { timeoutMs: 60_000 });
    return json(res, 200, { candidates });
  }
  if (api === 'files/list' && req.method === 'POST') {
    if (typeof body.cwd !== 'string' || !body.cwd.trim()) throw new Error('请先填写项目目录。');
    const ctx = await loadProjectContext(body.cwd, [body.query ?? '']);
    return json(res, 200, { cwd: ctx.cwd, files: ctx.index.slice(0, 400), notice: ctx.metadata.notice });
  }

  if (api === 'start' && req.method === 'POST') {
    const result = startRecording();
    log('http', `start -> token=${result.token ? 'yes' : 'MISSING'} rid=${result.recording?.id}`);
    return json(res, 200, result);
  }
  if (api === 'audio' && req.method === 'POST') return json(res, 200, acceptAudio(body.token, body.sequence, body.pcm));
  if (api === 'stop' && req.method === 'POST') return json(res, 200, await stopRecording(body.token));
  if (api === 'select' && req.method === 'POST') { store.select(SESSION_ID, body.recordingId); return json(res, 200, { selected: true }); }

  if (api === 'read' && req.method === 'POST') {
    const result = await store.read(SESSION_ID, body);
    return json(res, 200, result);
  }
  if (api === 'coach/generate' && req.method === 'POST') {
    if (!active && !store.get(SESSION_ID, body.recordingId)) throw new Error('无此录音');
    return json(res, 200, coach.request(SESSION_ID, body.recordingId, 'manual'));
  }
  if (api === 'coach/cancel' && req.method === 'POST') return json(res, 200, coach.cancel(SESSION_ID, body.recordingId, body.jobId));
  if (api === 'coach/auto' && req.method === 'POST') return json(res, 200, briefs.setAutomatic(SESSION_ID, body.recordingId, body.enabled));
  if (api === 'coach/read' && req.method === 'POST') return json(res, 200, coach.readAdvice(SESSION_ID, body.recordingId, body.adviceId));
  if (api === 'coach/state' && req.method === 'GET') {
    const id = new URL(req.url, 'http://x').searchParams.get('recordingId');
    return json(res, 200, coach.status(store.get(SESSION_ID, id || undefined)));
  }

  if (api === 'diag' && req.method === 'GET') return json(res, 200, { logs });

  return json(res, 404, { error: `未知的会议操作: ${api}` });
}

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
  try {
    await route(req, res, pathname);
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: redactCredentials(error instanceof Error ? error.message : String(error)) });
    log('http', `${pathname} 异常`, { error: redactCredentials(String(error?.message ?? error)) });
  }
});

// 音频上传中断处理：PCM 中途断掉就当一次失败的上传，下一次 start 会重建。
server.listen(PORT, HOST, () => {
  console.log(`[meeting-lite] http://${HOST}:${PORT}  数据目录: ${ROOT}`);
  console.log('[meeting-lite] 转写需百炼 API Key；发言建议需 OpenAI 兼容 LLM 配置（页面“设置”里填写）。');
});

process.on('SIGINT', async () => {
  if (active) await stopRecording(active.token).catch(() => {});
  await coach.dispose();
  process.exit(0);
});

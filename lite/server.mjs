// lite/server.mjs — 轻量版会议助手：一个零依赖的本地 Node 服务（Node ≥ 20）。
//
// 用 `node lite/server.mjs` 启动，浏览器打开 http://127.0.0.1:8787 即可用。
// 架构与原 DSH 插件一致，只是宿主换成了独立 HTTP 服务：
//   浏览器 AudioWorklet 采集麦克风 → 16k PCM 经 /api/audio 送本服务 →
//   服务端 DashscopeAsrStream + ResilientAsrSession（vendor 内核，原样复用）转写 →
//   转写落盘 + 触发 MeetingCoach 自动分析 → OpenAI 兼容接口生成发言建议。
// LLM 的 baseUrl/model 存在服务端配置里，apiKey 由服务端持有，页面不接触密钥。

import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, chmodSync, statSync, createReadStream, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DashscopeAsrStream, ResilientAsrSession } from '../src/vendor/voice-kernel/index.mjs';
import { MeetingStore } from './store.mjs';
import { MeetingCoach, BriefStore } from './coach.mjs';
import { readConfig, saveVoiceConfig, voiceHome } from './config.mjs';
import { chatCompletion, polishGoalRequest, llmConfigValid, listModels, testModel } from './llm.mjs';
import { loadProjectContext } from './project-context.mjs';
import { redactCredentials } from './redact.mjs';
import { formatLogLine } from './diag.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MEETING_PORT ?? 8787);
const HOST = process.env.MEETING_HOST ?? '127.0.0.1';
const ROOT = voiceHome(); // ~/.agent-mesh/voice（MESH_VOICE_HOME 可覆盖）
export const SESSION_ID = 'lite'; // 单机单用户：一个固定会话名，录音目录沿用原插件布局
// 版本指纹：页面与 server 各自上报，不一致 = git pull 后只刷新了一边，提示重启/强刷。
// 用 server 启动时刻：server 重启必变；页面刷新后与当前一致即可比对。
export const SERVER_STARTED_AT = Date.now();

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
    effort: saved.effort ?? 'low',
  };
};
function saveLlmConfig(draft) {
  const previous = llmConfig();
  // 只改 effort（baseUrl 留空）也应可保存：空串字段沿用已存的
  const pick = (v, fallback) => (typeof v === 'string' && v.trim() ? v : fallback);
  const next = {
    baseUrl: pick(draft.baseUrl, previous.baseUrl),
    model: pick(draft.model, previous.model),
    apiKey: pick(draft.apiKey, previous.apiKey),
    effort: ['low', 'high', 'max'].includes(draft.effort) ? draft.effort : previous.effort ?? 'low',
  };
  if (typeof next.baseUrl !== 'string' || !/^https?:\/\//.test(next.baseUrl)) throw new Error('LLM Base URL 必须是 http(s):// 地址。');
  if (!next.model?.trim()) throw new Error('请填写模型名。');
  // Key 明显是 URL 时直接指出，别等 401 才发现
  if (next.apiKey && /^(https?:|sk-)/i.test(next.baseUrl) && /^https?:\/\//.test(next.apiKey.trim())) {
    throw new Error('API Key 一栏填的看起来是个网址，请检查是否把 Base URL 粘到 Key 框里了。');
  }
  if (next.baseUrl.includes('/anthropic')) {
    throw new Error('这是 Anthropic 协议端点，本工具走 OpenAI 兼容协议。请填 OpenAI 兼容地址（如 https://api.deepseek.com）。');
  }
  const tmp = join(ROOT, `llm.json.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, join(ROOT, 'llm.json'));
  chmodSync(join(ROOT, 'llm.json'), 0o600);
  return { baseUrl: next.baseUrl, model: next.model, configured: !!next.apiKey };
}
function publicLlmConfig() {
  const c = llmConfig();
  const profiles = readLlmProfiles();
  return { baseUrl: c.baseUrl, model: c.model, effort: c.effort ?? 'low', configured: llmConfigValid(c), profiles, activeProfile: findActiveProfile(c, profiles) };
}

// ---- 个人最近动态（长期记忆）：领导突然问"最近干了什么/目标是什么"时的素材，
//      每场会议自动作为发言立足点带上。存 ROOT/profile.json，会前准备页可编辑/导入文件。
function profilePath() { return join(ROOT, 'profile.json'); }
function readProfile() {
  try { return JSON.parse(readFileSync(profilePath(), 'utf8')); } catch { return { log: '' }; }
}
function writeProfile(draft) {
  const previous = readProfile();
  const log = typeof draft.log === 'string' ? draft.log.slice(0, 16000) : previous.log;
  const next = { log };
  const tmp = join(ROOT, `profile.json.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, profilePath());
  chmodSync(profilePath(), 0o600);
  return next;
}
// 导入本地文件（txt/md/log 文本）进最近动态
async function importProfileFile(file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('请提供文件路径。');
  let raw;
  try { raw = readFileSync(file.trim(), 'utf8'); } catch { throw new Error(`读不了这个文件：${file}（请填本机绝对路径）`); }
  if (!raw.trim()) throw new Error('文件是空的。');
  if (raw.includes('\u0000')) throw new Error('这个文件是二进制，不是文本。');
  const previous = readProfile();
  const next = { log: (previous.log ? previous.log + '\n\n' : '') + raw.slice(0, 16000) };
  const tmp = join(ROOT, `profile.json.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, profilePath());
  chmodSync(profilePath(), 0o600);
  return next;
}

// ---- 多厂商预设：profiles.json 存多家 {name, baseUrl, model, apiKey}，一键切换即写回 llm.json ----
function profilesPath() { return join(ROOT, 'llm-profiles.json'); }
function readLlmProfiles() {
  try { return JSON.parse(readFileSync(profilesPath(), 'utf8')); } catch { return []; }
}
function writeLlmProfiles(list) {
  const tmp = join(ROOT, `llm-profiles.json.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  renameSync(tmp, profilesPath());
  chmodSync(profilesPath(), 0o600);
}
function findActiveProfile(cfg, profiles) {
  return profiles.find(p => p.baseUrl === cfg.baseUrl && p.model === cfg.model && p.apiKey === cfg.apiKey)?.id ?? null;
}
function upsertProfile(draft) {
  if (!draft || typeof draft !== 'object') throw new Error('无效的预设。');
  const profiles = readLlmProfiles();
  const entry = {
    id: typeof draft.id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(draft.id) ? draft.id : randomUUID().slice(0, 8),
    name: String(draft.name ?? '').trim().slice(0, 40) || '未命名',
    baseUrl: String(draft.baseUrl ?? '').trim(),
    model: String(draft.model ?? '').trim(),
    apiKey: String(draft.apiKey ?? '').trim(),
  };
  if (!/^https?:\/\//.test(entry.baseUrl)) throw new Error('Base URL 必须是 http(s)://。');
  if (!entry.model) throw new Error('请填写模型名。');
  if (!entry.apiKey) throw new Error('请填写 API Key。');
  if (entry.baseUrl.includes('/anthropic')) throw new Error('Anthropic 协议端点不受支持，请填 OpenAI 兼容地址。');
  const existing = profiles.findIndex(p => p.id === entry.id);
  if (existing >= 0) profiles[existing] = entry; else profiles.push(entry);
  writeLlmProfiles(profiles);
  return entry;
}
function deleteProfile(id) {
  const profiles = readLlmProfiles().filter(p => p.id !== id);
  writeLlmProfiles(profiles);
  return { deleted: true };
}
function activateProfile(id) {
  const p = readLlmProfiles().find(x => x.id === id);
  if (!p) throw new Error('预设不存在。');
  saveLlmConfig({ baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey });
  return publicLlmConfig();
}

// ---- 录音服务：对应原插件 MeetingService，但事件用 SSE 推给页面而不是靠 1.5s 轮询。
let active = null;
const liveClients = new Set(); // SSE: status + 转写 + 建议状态实时推
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of liveClients) res.write(frame);
}

async function startRecording() {
  if (active) {
    // 调试会话不是真录音：开始真会议时自动让它位
    if (active.session.constructor === DebugAsrSession) await stopRecording(active.token).catch(() => { });
    else throw new Error('已有会议正在录音，请先结束当前录音。');
  }
  const config = readConfig(ROOT); // validateVoiceConfig 由 config.mjs 提供
  if (!config.apiKey) throw new Error('请先在设置中填写百炼 API Key。');
  // 首次没保存过准备时不再硬拦：建一份空准备（会前准备页随时可补）
  const draft = briefs.read(SESSION_ID);
  if (!draft.revision) await briefs.save(SESSION_ID, '', { invitation: '', goal: '', role: '', initialViews: '', autoEnabled: true }).catch(() => { });
  briefs.initialize(SESSION_ID);
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
    // 调试会话没有音频流，30 秒无人发言提示但不停止
    if (current.session.constructor === DebugAsrSession) return;
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

// ---- 调试模式：与 ResilientAsrSession 同接口的假会话，say() 直接触发出句回调，
//      不连 ASR、不碰麦克风，建议链路与真实录音完全一致。
class DebugAsrSession {
  constructor(hooks) { this.hooks = hooks; this.meta = null; this.line = 0; }
  get stats() { return { fedBytes: 0, bufferedBytes: 0, queuedBytes: 0, reconnects: 0, droppedBytes: 0, wsState: 'ready' }; }
  async start() { this.hooks.onState?.('ready'); }
  async stop() { this.hooks.onState?.('stopped'); return Buffer.alloc(0); }
  forceDrop() { }
  say(text) {
    this.line++;
    const s = { text, beginMs: 0, endMs: 500, sentenceId: this.line, wallTs: Date.now() };
    this.hooks.onSentence(s);
    return s;
  }
}

function startDebugRecording() {
  if (active) throw new Error('已有会议正在录音，请先结束当前录音。');
  briefs.initialize(SESSION_ID);
  const meta = store.create(SESSION_ID);
  store.select(SESSION_ID, meta.id);
  const token = randomUUID();
  const brief = briefs.read(SESSION_ID, meta.id);
  Object.assign(meta, { autoEnabled: brief.autoEnabled });
  const session = new DebugAsrSession({
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
      broadcast('recording-state', { recordingId: meta.id, state: meta.state, wsState: state });
    },
    onLog: () => { },
  });
  const timer = setInterval(() => { }, 30_000);
  timer.unref();
  active = { meta, token, session, lastAudio: Date.now(), nextSequence: 0, timer };
  void session.start();
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
      return { stopped: true };
    }
  })();
  return current.stopping;
}

// ---- 建议：LLM 配置由服务端持有；会话模型/子 Agent 两条路径合并为这一条。
const coach = new MeetingCoach(store, {
  chat: async (input, signal, sessionId, metaId) => {
    const cfg = llmConfig();
    if (!llmConfigValid(cfg)) throw new Error('请先在设置中配置 LLM（Base URL / 模型 / API Key）。');
    // 生成进度实时推给页面：思考阶段（reasoning）报字数；第一段发言逐字推（立刻可跟读）；
    // <ANALYSIS_JSON> 之后的部分只报字数不推内容。
    let sent = 0;
    let inSpeech = true;
    const result = await chatCompletion(cfg, input, {
      signal,
      onReasoning: chars => {
        broadcast('advice-progress', { recordingId: metaId, chars, phase: 'thinking' });
      },
      onDelta: delta => {
        if (inSpeech && delta.includes('<ANALYSIS_JSON>')) inSpeech = false;
        if (inSpeech) {
          broadcast('advice-speech', { recordingId: metaId, delta });
        } else {
          sent += delta.length;
          broadcast('advice-progress', { recordingId: metaId, chars: sent, phase: 'analyzing' });
        }
      },
    });
    return result;
  },
});
coach.briefs = briefs;
coach.profile = readProfile;

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
  if (req.method === 'GET' && pathname === '/app.js') return serveFile(res, join(__dirname, 'public', 'app.js'), 'text/javascript; charset=utf-8');
  if (req.method === 'GET' && pathname === '/worklet.js') return serveFile(res, join(__dirname, 'worklet.mjs'), 'text/javascript; charset=utf-8');
  // 其余静态资源（样式、图标等）一律从 public/ 下取，禁止出目录。
  if (req.method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/audio/')) {
    const rel = pathname.replace(/^\/+/, '');
    if (rel && !rel.split('/').includes('..')) {
      const file = join(__dirname, 'public', rel);
      if (existsSync(file) && statSync(file).isFile()) return serveFile(res, file);
    }
  }
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

  if (api === 'status' && req.method === 'GET') return json(res, 200, { ...statusPayload(), serverStartedAt: SERVER_STARTED_AT });

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
  // 列出该 baseUrl 下的模型（用表单里填的临时配置，不必先保存）
  if (api === 'llm/models' && req.method === 'POST') {
    const cfg = { baseUrl: String(body.baseUrl ?? llmConfig().baseUrl), model: 'x', apiKey: String(body.apiKey ?? llmConfig().apiKey) };
    if (!cfg.baseUrl || !cfg.apiKey) throw new Error('请先填写 Base URL 和 API Key。');
    return json(res, 200, { models: await listModels(cfg) });
  }
  // 测试模型可用性：发一句真实请求
  if (api === 'llm/test' && req.method === 'POST') {
    const current = llmConfig();
    const cfg = {
      baseUrl: String(body.baseUrl ?? current.baseUrl),
      model: String(body.model ?? current.model),
      apiKey: String(body.apiKey ?? current.apiKey),
    };
    if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) throw new Error('Base URL / 模型 / API Key 都要有才能测试。');
    const result = await testModel(cfg);
    return json(res, 200, { ok: true, ...result });
  }
  // 预设管理
  if (api === 'llm/profiles' && req.method === 'GET') return json(res, 200, { profiles: readLlmProfiles() });
  if (api === 'llm/profiles' && req.method === 'POST') return json(res, 200, upsertProfile(body));
  if (api === 'llm/profiles/delete' && req.method === 'POST') return json(res, 200, deleteProfile(body.id));
  if (api === 'llm/profiles/activate' && req.method === 'POST') return json(res, 200, activateProfile(body.id));

  if (api === 'brief' && req.method === 'GET') {
    const recordingId = body.recordingId || undefined;
    return json(res, 200, briefs.public(briefs.read(SESSION_ID, recordingId)));
  }
  if (api === 'brief' && req.method === 'POST') {
    const saved = await briefs.save(SESSION_ID, body.cwd ?? '', body.brief ?? body, body.recordingId);
    return json(res, 200, briefs.public(saved));
  }
  // 个人最近动态（长期记忆）：读 / 存 / 从文件导入
  if (api === 'profile' && req.method === 'GET') return json(res, 200, readProfile());
  if (api === 'profile' && req.method === 'POST') return json(res, 200, writeProfile(body));
  if (api === 'profile/import' && req.method === 'POST') return json(res, 200, await importProfileFile(body.file));
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
    const result = await startRecording();
    return json(res, 200, result);
  }
  // 调试模式：不开麦克风，走同一条录音/转写/建议链路。
  if (api === 'debug/start' && req.method === 'POST') {
    if (active) {
      if (active.session.constructor !== DebugAsrSession) throw new Error('正在真实录音中，请先结束再调试。');
      return json(res, 200, { recording: active.meta });
    }
    return json(res, 200, startDebugRecording());
  }
  if (api === 'debug/say' && req.method === 'POST') {
    const current = active;
    if (!current || current.session.constructor !== DebugAsrSession) throw new Error('请先开始调试会议。');
    const text = String(body.text ?? '').trim();
    if (!text || text.length > 2000) throw new Error('发言内容为空或过长。');
    const entry = current.session.say(text);
    return json(res, 200, { entry });
  }
  if (api === 'debug/stop' && req.method === 'POST') {
    const current = active;
    if (!current || current.session.constructor !== DebugAsrSession) throw new Error('没有进行中的调试会话。');
    return json(res, 200, await stopRecording(current.token));
  }
  if (api === 'audio' && req.method === 'POST') return json(res, 200, acceptAudio(body.token, body.sequence, body.pcm));
  if (api === 'stop' && req.method === 'POST') return json(res, 200, await stopRecording(body.token));
  if (api === 'select' && req.method === 'POST') { store.select(SESSION_ID, body.recordingId); return json(res, 200, { selected: true }); }
  if (api === 'delete' && req.method === 'POST') {
    if (active && active.meta.id === body.recordingId) throw new Error('录音进行中，请先结束再删除。');
    const meta = store.get(SESSION_ID, body.recordingId);
    const dir = store.dir(SESSION_ID, meta.id);
    rmSync(dir, { recursive: true, force: true });
    return json(res, 200, { deleted: true });
  }

  if (api === 'read' && req.method === 'POST') {
    const result = await store.read(SESSION_ID, body);
    return json(res, 200, result);
  }
  // 转写人工修正：改单条文本（ASR 错字/漏字导致意思变了），改完前端可重新生成建议
  if (api === 'transcript/edit' && req.method === 'POST') {
    const meta = store.get(SESSION_ID, body.recordingId);
    const file = join(store.dir(SESSION_ID, meta.id), 'transcript.jsonl');
    if (!existsSync(file)) throw new Error('这场会议没有转写记录。');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const entry = entries.find(e => e.line === Number(body.line));
    if (!entry) throw new Error('没有这一条转写。');
    const text = String(body.text ?? '').trim();
    if (!text || text.length > 2000) throw new Error('内容为空或过长。');
    entry.text = text;
    writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
    return json(res, 200, { line: entry.line, text: entry.text });
  }
  if (api === 'coach/generate' && req.method === 'POST') {
    if (!active && !store.get(SESSION_ID, body.recordingId)) throw new Error('无此录音');
    const hint = typeof body.hint === 'string' ? body.hint.slice(0, 300) : '';
    return json(res, 200, coach.request(SESSION_ID, body.recordingId, 'manual', hint));
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

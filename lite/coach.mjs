// lite/coach.mjs — 会中建议编排：自动触发、窗口读取、落盘与状态机，逐行移植自 src/voice/coach.ts。
// 差别：generate 直接调 OpenAI 兼容接口（lite/llm.mjs），不再有 DSH 会话模型/子 Agent 两条路径。

import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writePrivateJson } from './store.mjs';
import { buildCoachInput, parseAdvice } from './coach-prompt.mjs';
import { loadProjectContext, unavailableProjectContext } from './project-context.mjs';
import { redactCredentials } from './redact.mjs';

export const countMeetingCharacters = text => Array.from(String(text).replace(/\s/g, '')).length;
export const COACH_RULE = { characters: 500, intervalMs: 5 * 60_000, cooldownMs: 60_000 };

export function automaticReason(state, latestLine, newChars, now) {
  if (state.running || latestLine <= state.throughLine || latestLine <= state.failedThroughLine
    || (state.lastAttemptAt > 0 && now - state.lastAttemptAt < COACH_RULE.cooldownMs)) return null;
  if (newChars >= COACH_RULE.characters) return 'characters';
  if (newChars > 0 && now - state.lastSuccessAt >= COACH_RULE.intervalMs) return 'time';
  return null;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.aborted ? signal.reason ?? new Error('aborted') : new Error('aborted'));
    if (signal?.aborted) { onAbort(); return; }
    promise.then(value => { signal?.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal?.removeEventListener('abort', onAbort); reject(error); });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class MeetingCoach {
  constructor(store, llm, { now = Date.now, timeoutMs = 90_000 } = {}) {
    this.store = store;
    this.llm = llm; // {chat(opts):Promise<{text,model,provider}>, configValid():boolean}
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.jobs = new Map();
    this.totals = new Map();
    this.disposed = false;
    this.suspended = false;
  }
  get busy() { return this.jobs.size > 0; }
  key(meta) { return `${meta.sessionId}/${meta.id}`; }
  statePath(meta) { return join(this.store.dir(meta.sessionId, meta.id), 'coach-state.json'); }
  state(meta) {
    let state = { throughLine: 0, coveredChars: 0, lastSuccessAt: meta.startedAt, lastAttemptAt: 0, failedThroughLine: -1, latestId: null, running: null, error: null, history: [] };
    try { state = { ...state, ...JSON.parse(readFileSync(this.statePath(meta), 'utf8')) }; } catch { /* 新录音 */ }
    if (state.running && !this.jobs.has(this.key(meta))) {
      state.running = null;
      state.error = '上次建议生成因服务退出而中断，可手动重新生成。';
      state.failedThroughLine = meta.segments;
      this.writeState(meta, state);
    }
    return state;
  }
  writeState(meta, state) { writePrivateJson(this.statePath(meta), state); }
  started(meta) { this.totals.set(this.key(meta), { line: 0, characters: 0 }); this.writeState(meta, this.state(meta)); }
  transcribed(meta, entry) {
    const total = this.totals.get(this.key(meta));
    if (total) { total.line = entry.line; total.characters += countMeetingCharacters(entry.text); }
    this.tick(meta);
  }
  tick(meta) {
    if (this.disposed || this.suspended || !['recording', 'reconnecting', 'connecting'].includes(meta.state)) return;
    if (!meta.autoEnabled) return;
    const total = this.totals.get(this.key(meta));
    if (!total) return;
    const state = this.state(meta);
    const reason = automaticReason(state, total.line, Math.max(0, total.characters - state.coveredChars), this.now());
    if (reason) this.request(meta.sessionId, meta.id, reason);
  }
  status(meta) {
    const state = this.state(meta);
    const total = this.totals.get(this.key(meta));
    return { ...state, autoEnabled: meta.autoEnabled, pendingChars: total ? Math.max(0, total.characters - state.coveredChars) : null, pendingLines: Math.max(0, meta.segments - state.throughLine), rule: COACH_RULE };
  }
  readAdvice(sessionId, recordingId, id) {
    this.store.get(sessionId, recordingId);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效的建议记录。');
    return JSON.parse(readFileSync(join(this.store.dir(sessionId, recordingId), 'advice', id + '.json'), 'utf8'));
  }
  request(sessionId, recordingId, reason = 'manual') {
    if (this.disposed) throw new Error('会议建议服务已关闭');
    if (this.suspended) throw new Error('会议分析正在重新连接，请稍后重试。');
    const meta = { ...this.store.get(sessionId, recordingId) }, key = this.key(meta), existing = this.jobs.get(key);
    if (existing) return { accepted: true, jobId: existing.id, reused: true };
    const brief = this.briefs.read(sessionId, recordingId);
    if (!meta.segments && !brief.invitation.trim() && !brief.goal.trim() && !brief.cwd
      && !brief.role.trim() && !brief.initialViews.trim() && !brief.files.length) {
      throw new Error('请先填写会议背景，或等待一些转写内容。');
    }
    const state = this.state(meta), id = randomUUID(), controller = new AbortController();
    const job = { id, meta, controller, promise: Promise.resolve() };
    state.running = { id, reason, startedAt: this.now(), throughLine: meta.segments, briefRevision: brief.revision };
    state.lastAttemptAt = this.now(); state.error = null;
    this.writeState(meta, state);
    this.jobs.set(key, job);
    const owns = () => this.jobs.get(key) === job;
    job.timer = setTimeout(() => this.retire(job, '分析已超时，请重新生成。'), this.timeoutMs);
    job.timer.unref?.();
    job.promise = Promise.resolve().then(async () => {
      try {
        if (!owns()) return;
        const signal = controller.signal;
        const window = await abortable(this.window(meta, signal), signal);
        signal.throwIfAborted();
        if (!owns()) return;
        const previous = state.latestId ? this.readAdvice(sessionId, recordingId, state.latestId).content : undefined;
        let project;
        if (brief.cwd) {
          try {
            project = await abortable(loadProjectContext(brief.cwd, [
              brief.goal, brief.invitation, brief.role, brief.initialViews,
              window.entries.map(e => e.text).join('\n').slice(-12000),
            ]), signal);
          } catch (error) {
            signal.throwIfAborted();
            project = unavailableProjectContext(brief.cwd, error);
          }
        }
        signal.throwIfAborted();
        if (!owns()) return;
        const input = buildCoachInput(brief, window.entries, previous, window.omittedLines, project);
        const generated = await abortable(this.llm.chat(input, signal, sessionId), signal);
        signal.throwIfAborted();
        if (!owns()) return;
        const content = parseAdvice(generated.text, input.evidence);
        const advice = {
          id, reason, createdAt: this.now(), fromLine: window.entries[0]?.line ?? 0, throughLine: meta.segments,
          briefRevision: brief.revision, content, evidence: input.evidence, omittedLines: window.omittedLines,
          model: generated.model, provider: generated.provider,
        };
        const dir = join(this.store.dir(sessionId, recordingId), 'advice');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writePrivateJson(join(dir, id + '.json'), advice);
        const { content: _c, evidence: _e, model: _m, provider: _p, omittedLines: _o, ...index } = advice;
        const current = this.state(meta);
        Object.assign(current, {
          throughLine: meta.segments, coveredChars: window.totalChars, lastSuccessAt: this.now(),
          latestId: id, running: null, error: null, failedThroughLine: -1,
          history: [index, ...current.history].slice(0, 30),
        });
        this.writeState(meta, current);
      } catch (error) {
        if (!owns()) return;
        const current = this.state(meta);
        current.running = null;
        current.failedThroughLine = meta.segments;
        current.error = controller.signal.aborted ? '已取消本次生成。'
          : `建议生成失败：${redactCredentials(error instanceof Error ? error.message : String(error))}`;
        try { this.writeState(meta, current); } catch { /* 分析不能影响录音 */ }
      } finally {
        if (job.timer !== undefined) clearTimeout(job.timer);
        if (owns()) this.jobs.delete(key);
      }
    });
    return { accepted: true, jobId: id, reused: false };
  }
  retire(job, message) {
    const key = this.key(job.meta);
    if (this.jobs.get(key) !== job) return false;
    try {
      const meta = this.store.get(job.meta.sessionId, job.meta.id), state = this.state(meta);
      if (state.running?.id === job.id) {
        state.running = null; state.failedThroughLine = meta.segments;
        state.lastAttemptAt = this.now(); state.error = message;
        this.writeState(meta, state);
      }
    } catch { /* 状态写不进去就放弃 */ } finally {
      this.jobs.delete(key);
      if (job.timer !== undefined) clearTimeout(job.timer);
      job.controller.abort(new Error(message));
    }
    return true;
  }
  cancel(sessionId, recordingId, jobId) {
    const meta = this.store.get(sessionId, recordingId), job = this.jobs.get(this.key(meta));
    if (!job || (jobId !== undefined && job.id !== jobId)) return { cancelled: false };
    return { cancelled: this.retire(job, '已取消本次生成。'), jobId: job.id };
  }
  async settled(sessionId, recordingId) { await this.jobs.get(`${sessionId}/${recordingId}`)?.promise; }
  async window(meta, signal) {
    signal.throwIfAborted();
    const file = join(this.store.dir(meta.sessionId, meta.id), 'transcript.jsonl');
    const entries = []; let chars = 0, totalChars = 0, omittedLines = 0;
    if (existsSync(file)) {
      const stream = createReadStream(file, { encoding: 'utf8', signal });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const raw of lines) {
          signal.throwIfAborted();
          let entry; try { entry = JSON.parse(raw); } catch { continue; }
          if (entry.line > meta.segments) break;
          totalChars += countMeetingCharacters(entry.text);
          entries.push(entry); chars += entry.text.length;
          while ((chars > 20000 || entries.length > 200) && entries.length > 1) {
            chars -= entries.shift().text.length; omittedLines++;
          }
        }
      } finally { lines.close(); stream.destroy(); }
    }
    return { entries, totalChars, omittedLines };
  }
  suspend() { this.suspended = true; for (const job of [...this.jobs.values()]) this.retire(job, '分析配置已更新，可重新生成。'); }
  resume() { if (!this.disposed) this.suspended = false; }
  async dispose() {
    this.disposed = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) this.retire(job, '分析因服务关闭而取消。');
    await Promise.allSettled(jobs.map(job => job.promise));
  }
}

// BriefStore 从 store.ts 的逻辑简化而来：会前草稿与录音绑定后的 brief 都存在录音目录旁。
export const EMPTY_BRIEF = { invitation: '', goal: '', role: '', initialViews: '', cwd: '', filePaths: [], autoEnabled: true, revision: 0, updatedAt: 0, files: [] };

export class BriefStore {
  constructor(store) { this.store = store; }
  path(sessionId, recordingId) {
    return join(recordingId ? this.store.dir(sessionId, recordingId) : this.store.sessionRoot(sessionId),
      recordingId ? 'brief.json' : 'preparation.json');
  }
  read(sessionId, recordingId) {
    if (recordingId) this.store.get(sessionId, recordingId);
    try {
      const saved = JSON.parse(readFileSync(this.path(sessionId, recordingId), 'utf8'));
      return {
        ...EMPTY_BRIEF, ...saved,
        goal: typeof saved.goal === 'string' ? saved.goal : '',
        files: Array.isArray(saved.files) ? saved.files : [],
        filePaths: Array.isArray(saved.filePaths) ? saved.filePaths : [],
      };
    } catch { return { ...EMPTY_BRIEF, files: [], filePaths: [] }; }
  }
  async save(sessionId, cwd, draft, recordingId) {
    if (!draft || typeof draft !== 'object') throw new Error('无效的会议准备信息。');
    if (recordingId) this.store.get(sessionId, recordingId);
    for (const key of ['invitation', 'role', 'initialViews']) {
      if (typeof draft[key] !== 'string' || draft[key].length > 8000) throw new Error('每项会议背景最多填写 8000 字符。');
    }
    if (draft.goal !== undefined && (typeof draft.goal !== 'string' || draft.goal.length > 8000)) throw new Error('会议目标最多填写 8000 字符。');
    if (typeof draft.autoEnabled !== 'boolean') throw new Error('无效的自动建议设置。');
    const previous = this.read(sessionId, recordingId);
    const brief = {
      invitation: draft.invitation, goal: draft.goal ?? previous.goal, role: draft.role,
      initialViews: draft.initialViews,
      autoEnabled: recordingId ? previous.autoEnabled : draft.autoEnabled,
      cwd: recordingId ? previous.cwd : (cwd ?? ''),
      filePaths: [], files: [], revision: previous.revision + 1, updatedAt: Date.now(),
    };
    mkdirSync(recordingId ? this.store.dir(sessionId, recordingId) : this.store.sessionRoot(sessionId), { recursive: true, mode: 0o700 });
    writePrivateJson(this.path(sessionId, recordingId), brief);
    return brief;
  }
  initialize(sessionId, recordingId) {
    const draft = this.read(sessionId);
    if (!draft.revision) throw new Error('请先填写或确认会前准备，再开始录音。');
    writePrivateJson(this.path(sessionId, recordingId), { ...draft, revision: 1, updatedAt: Date.now() });
  }
  setAutomatic(sessionId, recordingId, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('无效的自动建议设置。');
    const brief = this.read(sessionId, recordingId);
    brief.autoEnabled = enabled;
    writePrivateJson(this.path(sessionId, recordingId), brief);
    return { autoEnabled: enabled };
  }
  public(brief) { return { ...brief, files: brief.files.map(({ text, ...file }) => ({ ...file, characters: text.length })) }; }
}

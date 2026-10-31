// lite/store.mjs — 会议录音的本地文件存储，逐行移植自 src/voice/store.ts。
// 目录布局沿用原插件：`<root>/recordings/<sessionId 的 sha256>/<录音UUID>/`，
// 内含 meta.json / transcript.jsonl / audio.wav / advice/<id>.json / coach-state.json / brief.json。

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync,
  readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { wavHeader, WAV_MAX_DATA } from '../src/vendor/voice-kernel/index.mjs';

const TAIL_READ_BYTES = 96 * 1024;

export class MeetingStore {
  constructor(root) {
    this.root = root;
  }
  sessionRoot(sessionId) {
    if (!sessionId || sessionId.length > 200) throw new Error('无效的会话 ID');
    return join(this.root, 'recordings', createHash('sha256').update(sessionId).digest('hex'));
  }
  dir(sessionId, id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效的录音 ID');
    return join(this.sessionRoot(sessionId), id);
  }
  create(sessionId) {
    const meta = {
      id: randomUUID(), sessionId, startedAt: Date.now(), endedAt: null, state: 'connecting',
      segments: 0, audioBytes: 0, error: null, reconnects: 0, droppedBytes: 0,
      untranscribedBytes: 0, wsState: 'connecting',
    };
    mkdirSync(this.dir(sessionId, meta.id), { recursive: true, mode: 0o700 });
    this.save(meta);
    return meta;
  }
  save(meta) {
    const file = join(this.dir(meta.sessionId, meta.id), 'meta.json');
    // Windows 上 rename 到被读取中的目标会 EPERM；直接写（writeFileSync 对同一文件并发写最坏截断，
    // get() 处有重试）。tmp 文件留着堆积没意义，不再走 rename。
    writeFileSync(file, JSON.stringify(meta), { mode: 0o600 });
  }
  list(sessionId, limit = Number.POSITIVE_INFINITY) {
    const root = this.sessionRoot(sessionId);
    if (!existsSync(root)) return [];
    const ids = readdirSync(root).filter(id => /^[0-9a-f-]{36}$/.test(id));
    const recent = Number.isFinite(limit) && ids.length > limit
      ? ids.map(id => { try { return { id, mtime: statSync(join(root, id)).mtimeMs }; } catch { return { id, mtime: 0 }; } })
          .sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(0, limit)).map(e => e.id)
      : ids;
    return recent.flatMap(id => { try { return [this.get(sessionId, id)]; } catch { return []; } })
      .sort((a, b) => b.startedAt - a.startedAt);
  }
  get(sessionId, id) {
    if (!id) {
      try { id = readFileSync(join(this.sessionRoot(sessionId), 'selected'), 'utf8'); } catch { /* 未选择 */ }
      if (!id) {
        const latest = this.list(sessionId)[0];
        if (!latest) throw new Error('当前会话还没有会议记录，请先开始一场录音。');
        return latest;
      }
    }
    // 并发读写下 meta.json 可能读到半截（写入非原子）：重试一次，仍失败再当作损坏跳过。
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(this.dir(sessionId, id), 'meta.json'), 'utf8'));
    } catch {
      try {
        meta = JSON.parse(readFileSync(join(this.dir(sessionId, id), 'meta.json'), 'utf8'));
      } catch (error) {
        throw new Error(`会议记录 ${id} 的元数据读取失败（可能正在写入）：${error.message}`);
      }
    }
    if (meta.sessionId !== sessionId) throw new Error('会议记录不属于当前会话');
    return meta;
  }
  select(sessionId, id) {
    this.get(sessionId, id);
    writeFileSync(join(this.sessionRoot(sessionId), 'selected'), id, { mode: 0o600 });
  }
  append(meta, s) {
    const entry = { line: ++meta.segments, ts: s.wallTs, startMs: s.beginMs, endMs: s.endMs, text: s.text };
    appendFileSync(join(this.dir(meta.sessionId, meta.id), 'transcript.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    this.save(meta);
    return entry;
  }
  audio(meta, pcm) {
    appendFileSync(join(this.dir(meta.sessionId, meta.id), 'audio.pcm'), pcm, { mode: 0o600 });
    meta.audioBytes += pcm.length;
  }
  async finalize(meta) {
    const dir = this.dir(meta.sessionId, meta.id), pcm = join(dir, 'audio.pcm');
    if (existsSync(pcm)) {
      const size = statSync(pcm).size;
      if (size > 0 && size <= WAV_MAX_DATA) {
        const wav = join(dir, 'audio.wav'), out = createWriteStream(wav + '.tmp', { mode: 0o600 });
        out.write(wavHeader(size));
        await pipeline(createReadStream(pcm), out);
        renameSync(wav + '.tmp', wav);
        unlinkSync(pcm);
      }
    }
    this.save(meta);
  }
  async read(sessionId, query = {}, signal) {
    const meta = this.get(sessionId, query.recordingId);
    const file = join(this.dir(sessionId, meta.id), 'transcript.jsonl');
    const limit = Math.min(200, Math.max(1, Math.floor(query.lines ?? 80)));
    const after = Math.max(0, Math.floor(query.afterLine ?? 0));
    const cutoff = query.sinceMinutes === undefined ? 0
      : (meta.endedAt ?? Date.now()) - Math.max(0, query.sinceMinutes) * 60000;
    const entries = [];
    let hasMore = false, chars = 0;
    if (existsSync(file)) {
      const tailStart = query.tail ? Math.max(0, statSync(file).size - TAIL_READ_BYTES) : 0;
      const stream = createReadStream(file, tailStart > 0 ? { encoding: 'utf8', start: tailStart, signal } : { encoding: 'utf8', signal });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let skipPartial = tailStart > 0;
      try {
        for await (const line of lines) {
          if (skipPartial) { skipPartial = false; continue; }
          signal?.throwIfAborted();
          let entry; try { entry = JSON.parse(line); } catch { continue; }
          if (entry.line <= after || entry.ts < cutoff ||
              (query.query && !entry.text.toLowerCase().includes(query.query.toLowerCase()))) continue;
          if (!query.tail && (entries.length >= limit || chars + entry.text.length > 24000)) { hasMore = true; break; }
          entries.push(entry); chars += entry.text.length;
          if (query.tail) while (entries.length > limit || chars > 24000) { chars -= entries.shift().text.length; hasMore = true; }
        }
      } finally { lines.close(); stream.destroy(); }
    }
    return { recording: meta, entries, hasMore, nextAfterLine: entries.at(-1)?.line ?? after, transcriptPath: file };
  }
}

export function writePrivateJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  try { renameSync(tmp, path); } catch { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); try { unlinkSync(tmp); } catch { /* 已直接写入 */ } }
}

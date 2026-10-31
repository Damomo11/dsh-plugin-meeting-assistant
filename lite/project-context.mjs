// lite/project-context.mjs — 轻量版项目资料检索。
// 原版插件靠 DSH 注入工作区与读取预算，这里换成同样语义的独立实现：
//   - 索引：cwd 下最多 400 个文件路径（跳过 node_modules/.git/dist/build/隐藏目录）
//   - 片段：按关键词在文本文件（含 .docx 的纯文本提取）里检索，命中行附近取上下文，
//     单文件 8000 字、总预算 24000 字，读不完就写进 metadata.notice 的信息边界。

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { gunzipSync } from 'node:zlib';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', 'out', 'vendor', '__pycache__', '.venv']);
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log', '.xml', '.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.java', '.rs', '.c', '.h', '.cpp', '.sh', '.bat', '.ps1', '.sql', '.ini', '.cfg', '.conf', '.toml', '.env']);
const FILE_BUDGET = 8000;
const TOTAL_BUDGET = 24000;
const SNIPPET_CONTEXT_LINES = 4;

export async function buildProjectIndex(cwd) {
  const paths = [];
  let truncated = false;
  let budget = 2000;
  async function walk(dir, depth) {
    if (budget <= 0 || depth > 8) { if (budget > 0) truncated = true; return; }
    let rows;
    try { rows = await readdir(dir, { withFileTypes: true }); } catch { return; }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    for (const row of rows) {
      if (budget <= 0) { truncated = true; return; }
      if (row.name.startsWith('.') || SKIP_DIRS.has(row.name)) continue;
      const full = join(dir, row.name);
      if (row.isDirectory()) { budget--; await walk(full, depth + 1); }
      else if (row.isFile()) {
        budget--;
        paths.push({ path: relative(cwd, full), size: (await stat(full).catch(() => ({ size: 0 }))).size });
      }
    }
  }
  const root = resolve(cwd);
  await walk(root, 0);
  if (paths.length > 400) { paths.length = 400; truncated = true; }
  return { paths, truncated };
}

async function readDocxText(file) {
  // .docx 是 zip；word/document.xml 是正文。避免引入解压依赖：手写 zip 定位 + inflate。
  try {
    const handle = await (await import('node:fs/promises')).open(file, 'r');
    try {
      const { buffer } = await handle.readFile({ length: Math.min(await (await handle.stat()).size, 48 * 1024 * 1024) });
      // central directory 定位
      let eocd = -1;
      for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65536; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) return '';
      const entries = buffer.readUInt16LE(eocd + 8), cdOffset = buffer.readUInt32LE(eocd + 16);
      let p = cdOffset;
      for (let n = 0; n < entries; n++) {
        if (buffer.readUInt32LE(p) !== 0x02014b50) break;
        const method = buffer.readUInt16LE(p + 10), compSize = buffer.readUInt32LE(p + 20);
        const nameLen = buffer.readUInt16LE(p + 28), extraLen = buffer.readUInt16LE(p + 30), commentLen = buffer.readUInt16LE(p + 32);
        const lfhOffset = buffer.readUInt32LE(p + 42);
        const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
        if (name === 'word/document.xml') {
          const lfhNameLen = buffer.readUInt16LE(lfhOffset + 26), lfhExtraLen = buffer.readUInt16LE(lfhOffset + 28);
          const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
          const raw = buffer.subarray(dataStart, dataStart + compSize);
          const xml = method === 8 ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
          return xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        }
        p += 46 + nameLen + extraLen + commentLen;
      }
    } finally { await handle.close(); }
  } catch { return ''; }
  return '';
}

async function readFileText(file, maxChars) {
  const ext = extname(file).toLowerCase();
  if (ext === '.docx') return (await readDocxText(file)).slice(0, maxChars);
  if (!TEXT_EXTS.has(ext) && ext !== '') return null; // 二进制类不读
  const chunks = [];
  let chars = 0, truncated = false;
  try {
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.includes('\u0000')) { chunks.length = 0; truncated = false; return null; } // 二进制保护
      if (chars + line.length > maxChars) { chunks.push(line.slice(0, maxChars - chars)); truncated = true; break; }
      chunks.push(line); chars += line.length + 1;
    }
  } catch { return null; }
  const text = chunks.join('\n');
  return text.length ? { text, truncated } : null;
}

export async function loadProjectContext(cwd, keywords) {
  const index = await buildProjectIndex(cwd);
  const words = [...new Set((keywords ?? []).join(' ').split(/[\s，。、；：,.;:\n]+/).map(w => w.trim()).filter(w => w.length >= 2 && w.length <= 32))].slice(0, 40);
  const snippets = [];
  let total = 0, read = 0;
  const skipped = [];
  const files = index.paths.filter(p => p.path.includes('..') ? false : true).map(p => p);
  // 优先扫文本扩展名 + .docx；同一文件命中多个关键词只取一次
  const candidates = files.filter(f => TEXT_EXTS.has(extname(f.path).toLowerCase()) || extname(f.path).toLowerCase() === '.docx');
  for (const file of candidates) {
    if (total >= TOTAL_BUDGET || read >= 120) break;
    const full = join(cwd, file.path);
    const loaded = await readFileText(full, FILE_BUDGET);
    if (!loaded) continue;
    read++;
    const lines = loaded.text.split('\n');
    const hitLines = new Set();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      for (const w of words) { if (w && line.includes(w.toLowerCase())) { hitLines.add(i); break; } }
    }
    if (!hitLines.size) continue;
    // 命中行 ±4 行取上下文，合并相邻窗口
    const take = [...hitLines].flatMap(i => [Math.max(0, i - SNIPPET_CONTEXT_LINES), i + SNIPPET_CONTEXT_LINES + 1]);
    const merged = [];
    for (const f of take) {
      if (!merged.length || f > merged[merged.length - 1][1]) merged.push([f, f]);
      else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], f);
    }
    const kept = merged.slice(0, 3).map(([a, b]) => ({ a: Math.max(0, a), b: Math.min(lines.length, b) }));
    const text = kept.map(({ a, b }) => lines.slice(a, b).join('\n')).join('\n…\n');
    const budget = TOTAL_BUDGET - total;
    if (!text.trim() || budget <= 200) continue;
    snippets.push({ path: file.path, size: file.size, truncated: loaded.truncated || text.length > budget, savedAt: Date.now(), text: text.slice(0, budget) });
    total += Math.min(text.length, budget);
  }
  const notice = [
    `共索引 ${index.paths.length} 个文件${index.truncated ? '（超出 400 上限，已截断）' : ''}；`,
    `本轮读取文本文件 ${read} 个，命中关键词 ${words.length ? words.length : '无（转写为空时按会前背景检索）'} 个，摘出片段 ${snippets.length} 份，总计约 ${total} 字。`,
    `目录条目只代表该路径存在；未提供片段的文件未读取内容。`,
  ].join('');
  return { cwd, index: index.paths, metadata: { notice, skipped }, snippets };
}

export function unavailableProjectContext(cwd, error) {
  return {
    cwd, index: [], metadata: { notice: `项目目录读取失败：${String(error?.message ?? error).slice(0, 200)}；本轮建议不含项目资料。`, skipped: [] },
    snippets: [],
  };
}

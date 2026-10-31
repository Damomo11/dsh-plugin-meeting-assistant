import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const cfg = JSON.parse(readFileSync(homedir() + '/.agent-mesh/voice/llm.json', 'utf8'));
const { buildCoachInput } = await import('../../lite/coach-prompt.mjs');
const brief = { invitation: '我的世界椰汁橙小镇会议', goal: '椰汁橙应该建10台刷沙机', role: '小镇成员Damomo1', initialViews: '椰汁橙应该建更多的刷沙机', cwd: '', filePaths: [], files: [] };
const entries = [{ line: 1, ts: Date.now(), text: '今天讨论一下我们小镇的刷沙机建设，大家发表意见' }];
const input = buildCoachInput(brief, entries, undefined, 0, undefined);
const res = await fetch(cfg.baseUrl + '/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
  body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.prompt }], stream: true }),
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let raw = '';
while (true) { const { done, value } = await reader.read(); if (done) break; raw += dec.decode(value); }
let content = '';
for (const line of raw.split('\n')) {
  if (!line.startsWith('data:')) continue;
  const p = line.slice(5).trim();
  if (p === '[DONE]') continue;
  try { const d = JSON.parse(p).choices?.[0]?.delta; if (d?.content) content += d.content; } catch {}
}
console.log('=== 完整输出 ===');
console.log(content);
console.log('=== 含分隔符:', content.includes('<ANALYSIS_JSON>'));

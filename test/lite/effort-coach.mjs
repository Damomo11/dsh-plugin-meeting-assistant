import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const key = JSON.parse(readFileSync(homedir() + '/.agent-mesh/voice/llm.json', 'utf8')).apiKey;
const { buildCoachInput } = await import('../../lite/coach-prompt.mjs');
const brief = { invitation: '我的世界椰汁橙小镇会议', goal: '椰汁橙应该建10台刷沙机', role: '小镇成员Damomo1', initialViews: '椰汁橙应该建更多的刷沙机', cwd: '', filePaths: [], files: [] };
const entries = [{ line: 1, ts: Date.now(), text: '今天讨论一下我们小镇的刷沙机建设，大家发表意见' }];
const input = buildCoachInput(brief, entries, undefined, 0, undefined);
const tryBody = async (label, extra) => {
  const t0 = Date.now();
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.prompt }], stream: true, ...extra }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', firstContent = null, reasoning = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '[DONE]') continue;
      try {
        const d = JSON.parse(p).choices?.[0]?.delta;
        if (d?.reasoning_content) reasoning += d.reasoning_content.length;
        if (d?.content && firstContent === null) firstContent = Date.now() - t0;
      } catch {}
    }
  }
  console.log(label, '→ 首正文', firstContent, 'ms | 思考', reasoning, '字 | 总', Date.now() - t0, 'ms');
};
await tryBody('默认（effort=high）', {});
await tryBody('reasoning_effort=low', { reasoning_effort: 'low' });

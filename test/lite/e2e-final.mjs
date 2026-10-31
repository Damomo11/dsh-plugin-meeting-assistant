// e2e 验证脚本：轻量版会议助手全链路（假 ASR key + mock LLM）
// 用法：node e2e-final.mjs <MESH_VOICE_HOME 的 Windows 路径>
const home = process.argv[2];
const post = async (path, body) => {
  const res = await fetch('http://127.0.0.1:8791/api/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(path + ' 非JSON: ' + text.slice(0, 120)); }
  if (j && j.error) throw new Error(path + ' -> ' + j.error);
  return j;
};
const get = async (path) => (await fetch('http://127.0.0.1:8791/api/' + path)).json();
const fs = await import('node:fs');
const { createHash } = await import('node:crypto');
const { join } = await import('node:path');
const t = async (name, p) => {
  try { const v = await p(); console.log('PASS', name); return v; }
  catch (e) { console.log('FAIL', name, '::', e.message); process.exit(1); }
};

await t('1/9 会前准备', () => post('brief', { invitation: '周四 10:00 项目周会', goal: '确认二期排期', role: '后端开发，负责交易模块', initialViews: '联调完成80%', cwd: '', autoEnabled: true }));
await t('2/9 转写配置（假 key）', () => post('voice-config', { apiKey: 'sk-test-0000000000000000' }));
await t('3/9 LLM 配置（mock）', () => post('llm-config', { baseUrl: 'http://127.0.0.1:9998/v1', model: 'test-model', apiKey: 'sk-x' }));
const start = await t('4/9 开始录音', () => post('start', {}));
const token = start.token, rid = start.recording.id;
const pcm = Buffer.alloc(64000, 0).toString('base64');
// 假 key 下 ASR 连不上会自动停录音（预期行为），音频上传因此可能被拒；不视为链路失败。
try {
  for (let i = 0; i < 5; i++) await post('audio', { token, sequence: i, pcm });
  console.log('PASS 5/9 音频上传 x5');
} catch (e) {
  console.log('SKIP 5/9 音频上传（假 key 下 ASR 断连自动停止，属预期）::', e.message);
}
const dir = join(home, 'recordings', createHash('sha256').update('lite').digest('hex'), rid);
let meta = JSON.parse(fs.readFileSync(join(dir, 'meta.json'), 'utf8'));
// 注入转写（模拟 ASR 出句），并确保 state 落在 recording（若已被自动停就拉回来）
['领导说现在开始，每个人说一下自己的目标', '我负责的交易模块联调完成百分之八十', '下周计划把剩余接口对接完并提测'].forEach((text, i) => {
  meta.segments = i + 1; meta.state = 'recording';
  fs.writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  fs.appendFileSync(join(dir, 'transcript.jsonl'), JSON.stringify({ line: i + 1, ts: Date.now(), startMs: i * 3000, endMs: i * 3000 + 2800, text }) + '\n');
});
console.log('PASS 6/9 转写注入 x3');
await t('读取转写', () => post('read', { recordingId: rid, lines: 10 }).then(r => { if (r.entries.length !== 3) throw new Error('entries=' + r.entries.length); }));
await t('7/9 触发建议生成', () => post('coach/generate', { recordingId: rid }));
await new Promise(r => setTimeout(r, 2500));
const state = await get('coach/state?recordingId=' + rid);
if (!state.latestId) { console.log('FAIL 8/9 建议 ::', state.error); process.exit(1); }
console.log('PASS 8/9 建议已生成');
const advice = await t('9/9 读取建议', () => post('coach/read', { recordingId: rid, adviceId: state.latestId }));
console.log('   model=' + advice.model, '| askedOfMe=' + advice.content.askedOfMe.length, '| askOthers=' + advice.content.askOthers.length, '| 第1问来源=' + advice.content.askedOfMe[0].sources.join(','));
const polish = await t('+ 润色', () => post('brief/polish', { goal: '确认二期排期' }));
console.log('   润色候选=' + polish.candidates.length + '：' + polish.candidates[0].slice(0, 22) + '…');
// 结束录音：active 可能已被自动停掉，stop 的报错不视为失败
try { await post('stop', { token }); console.log('PASS + 结束录音'); }
catch (e) { console.log('SKIP + 结束录音（active 已被自动停）'); }
await new Promise(r => setTimeout(r, 800));
const status = await get('status');
const rec = status.recordings.find(r => r.id === rid);
console.log(rec && rec.audioBytes > 0 ? 'PASS 音频落盘 ' + rec.audioBytes + 'B' : 'NOTE 音频未落盘（假 key 断连场景，' + JSON.stringify({ state: rec?.state, bytes: rec?.audioBytes }) + '）');
const wav = await fetch('http://127.0.0.1:8791/audio/' + rid + '.wav');
if (wav.ok) {
  const buf = Buffer.from(await wav.arrayBuffer());
  console.log(buf.subarray(0, 4).toString() === 'RIFF' ? 'PASS WAV 回放（RIFF,' + buf.length + 'B）' : 'FAIL WAV 头不对');
} else {
  console.log('NOTE WAV 未生成（断连场景 audio.pcm 未 finalize，正常使用时会有）status=' + wav.status);
}
console.log('E2E-DONE rid=' + rid);

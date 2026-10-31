// 会议助手前端。单页 + hash 路由：#/ 首页，#/settings 设置，#/prepare 会前准备，#/debug 调试。

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = ms => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const pad = n => String(n).padStart(2, '0');
  return h ? `${pad(h)}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
};
const fmtClock = ts => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
const fmtDate = ts => new Date(ts).toLocaleString('zh-CN', { hour12: false });

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

async function api(path, body, method) {
  const res = await fetch(`/api/${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `请求失败 ${res.status}`);
  return data;
}

let status = null;
let capture = null;
let activeRecordingId = null;
let currentAdvice = null;
let pollTimer = null;
let brief = { invitation: '', goal: '', role: '', initialViews: '', cwd: '', autoEnabled: true };

async function refreshStatus() {
  status = await api('status');
  return status;
}

// ===================== 首页 =====================
function renderHome() {
  const rec = status?.active;
  $('#app').innerHTML = `
    <header style="display:flex;align-items:center;gap:12px;padding:10px 0 18px">
      <h1 style="font-size:18px;margin:0;flex:1">会议助手</h1>
      <span class="badge ${status?.voice?.configured ? 'ok' : 'err'}" id="vBadge">转写</span>
      <span class="badge ${status?.llm?.configured ? 'ok' : 'err'}" id="lBadge">AI</span>
      <button data-go="settings">设置</button>
    </header>
    <div class="card" style="text-align:center;padding:32px 24px">
      ${rec
        ? `<div class="row" style="justify-content:center;gap:12px"><span class="badge rec">录音中 ${fmtTime(Date.now() - rec.startedAt)}</span></div>`
        : `<button class="big primary" id="startBtn">开始会议</button>`}
      <div class="row" style="justify-content:center;margin-top:14px">
        <button data-go="prepare">会前准备</button>
        <button data-go="debug">调试</button>
      </div>
      ${!status?.voice?.configured || !status?.llm?.configured
        ? `<p class="muted" style="margin-top:14px">转写或 AI 还没配置，<a href="#/settings">去设置</a></p>`
        : ''}
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between"><strong>历史会议</strong><button id="refreshBtn">刷新</button></div>
      <div id="history"></div>
    </div>`;
  bindNav();
  $('#refreshBtn').onclick = async () => { await refreshStatus(); renderHome(); };
  const history = status?.recordings ?? [];
  $('#history').innerHTML = history.length ? history.map(r => `
    <div class="hist-item" data-open="${r.id}">
      <span class="badge">${r.state === 'stopped' ? '结束' : r.state === 'interrupted' ? '中断' : '进行中'}</span>
      <div class="grow"><div>${fmtDate(r.startedAt)}</div><div class="muted">${r.segments} 段</div></div>
      <button>回看</button>
    </div>`).join('') : '<div class="empty">还没有会议记录</div>';
  $('#history').querySelectorAll('[data-open]').forEach(el => el.onclick = () => openHistory(el.dataset.open));
  const startBtn = $('#startBtn');
  if (startBtn) startBtn.onclick = startRecording;
  if (rec) {
    activeRecordingId = rec.id;
    renderLive();
  } else {
    activeRecordingId = null;
  }
}

// ===================== 会前准备 =====================
async function renderPrepare() {
  brief = await api('brief');
  $('#app').innerHTML = `
    <header style="display:flex;align-items:center;gap:12px;padding:10px 0 18px">
      <button data-go="">←</button><h1 style="font-size:18px;margin:0;flex:1">会前准备</h1>
      <button class="primary" id="saveBriefBtn">保存</button>
    </header>
    <div class="card">
      <label>会议邀请</label>
      <textarea id="briefInvitation" rows="2">${esc(brief.invitation)}</textarea>
      <label>我的目标</label>
      <textarea id="briefGoal" rows="3">${esc(brief.goal)}</textarea>
      <div class="row"><button id="polishBtn" ${status?.llm?.configured ? '' : 'disabled'}>润色</button></div>
      <div id="polishArea"></div>
    </div>
    <div class="card">
      <label>我的角色</label>
      <textarea id="briefRole" rows="3">${esc(brief.role)}</textarea>
      <label>初始观点</label>
      <textarea id="briefViews" rows="3">${esc(brief.initialViews)}</textarea>
      <label>项目目录</label>
      <input id="briefCwd" value="${esc(brief.cwd)}">
      <label style="display:flex;align-items:center;gap:6px;margin-top:12px"><input type="checkbox" id="autoAdvice" style="width:auto" ${brief.autoEnabled ? 'checked' : ''}>会议中自动生成建议</label>
    </div>`;
  bindNav();
  $('#saveBriefBtn').onclick = async () => {
    try {
      brief = await api('brief', {
        invitation: $('#briefInvitation').value.trim(),
        goal: $('#briefGoal').value.trim(),
        role: $('#briefRole').value.trim(),
        initialViews: $('#briefViews').value.trim(),
        cwd: $('#briefCwd').value.trim(),
        autoEnabled: $('#autoAdvice').checked,
      });
      toast('已保存');
    } catch (e) { toast(e.message); }
  };
  $('#polishBtn').onclick = async () => {
    const goal = $('#briefGoal').value.trim();
    if (!goal) return toast('先写一句目标');
    const btn = $('#polishBtn');
    btn.disabled = true; btn.textContent = '润色中…';
    try {
      const { candidates } = await api('brief/polish', {
        goal,
        invitation: $('#briefInvitation').value.trim(),
        role: $('#briefRole').value.trim(),
        initialViews: $('#briefViews').value.trim(),
      });
      const area = $('#polishArea');
      area.innerHTML = candidates.map((c, i) => `<div class="q-card">${esc(c)}<button data-use="${i}">采用</button></div>`).join('');
      area.querySelectorAll('[data-use]').forEach(btn => btn.onclick = () => {
        $('#briefGoal').value = candidates[Number(btn.dataset.use)];
        area.innerHTML = '';
        toast('已替换，记得保存');
      });
    } catch (e) { toast(e.message); }
    btn.disabled = false; btn.textContent = '润色';
  };
}

// ===================== 设置 =====================
async function renderSettings() {
  const [voice, llm] = await Promise.all([api('voice-config'), api('llm-config')]);
  $('#app').innerHTML = `
    <header style="display:flex;align-items:center;gap:12px;padding:10px 0 18px">
      <button data-go="">←</button><h1 style="font-size:18px;margin:0;flex:1">设置</h1>
    </header>
    <div class="card">
      <strong>语音转写</strong>
      <label>百炼 API Key</label>
      <input id="cfgApiKey" type="password" placeholder="${voice.configured ? '已保存' : '必填'}">
      <label>WebSocket 地址</label>
      <input id="cfgWsBase" value="${esc(voice.wsBase)}">
      <label>模型</label>
      <input id="cfgAsrModel" value="${esc(voice.model)}">
    </div>
    <div class="card">
      <strong>AI 建议</strong>
      <label>Base URL</label>
      <input id="cfgLlmBase" value="${esc(llm.baseUrl)}" placeholder="https://api.deepseek.com/v1">
      <label>模型</label>
      <input id="cfgLlmModel" value="${esc(llm.model)}" placeholder="deepseek-chat">
      <label>API Key</label>
      <input id="cfgLlmKey" type="password" placeholder="${llm.configured ? '已保存' : '必填'}">
    </div>
    <button class="big primary" id="saveCfgBtn">保存</button>`;
  bindNav();
  $('#saveCfgBtn').onclick = async () => {
    try {
      const voiceDraft = {};
      if ($('#cfgApiKey').value.trim()) voiceDraft.apiKey = $('#cfgApiKey').value.trim();
      if ($('#cfgWsBase').value.trim()) voiceDraft.wsBase = $('#cfgWsBase').value.trim();
      if ($('#cfgAsrModel').value.trim()) voiceDraft.model = $('#cfgAsrModel').value.trim();
      if (Object.keys(voiceDraft).length) await api('voice-config', voiceDraft);
      const llmDraft = { baseUrl: $('#cfgLlmBase').value.trim(), model: $('#cfgLlmModel').value.trim() };
      if ($('#cfgLlmKey').value.trim()) llmDraft.apiKey = $('#cfgLlmKey').value.trim();
      if (llmDraft.baseUrl || llmDraft.model) await api('llm-config', llmDraft);
      await refreshStatus();
      toast('已保存');
      location.hash = '#/';
    } catch (e) { toast(e.message); }
  };
}

// ===================== 录音（会中） =====================
async function startRecording() {
  try {
    await api('brief', { ...brief, cwd: brief.cwd, autoEnabled: brief.autoEnabled, __touch: 1 }).catch(() => { });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    const context = new AudioContext();
    await context.resume();
    await context.audioWorklet.addModule('/worklet.js');
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'meeting-assistant');
    const started = await api('start');
    capture = { stream, context, node, token: started.token, startedAt: Date.now(), sequence: 0 };
    node.port.onmessage = async ev => {
      if (ev.data === 'flushed' || !(ev.data instanceof Uint8Array) || !capture) return;
      let binary = '';
      for (const byte of ev.data) binary += String.fromCharCode(byte);
      try {
        await api('audio', { token: capture.token, sequence: capture.sequence, pcm: btoa(binary) });
        capture.sequence++;
      } catch (e) {
        toast(`录音中断：${e.message}`);
        await stopRecording();
      }
    };
    source.connect(node); node.connect(context.destination);
    activeRecordingId = started.recording.id;
    renderLive();
  } catch (e) {
    toast(`无法开始：${e.message}`);
  }
}

async function stopRecording() {
  const c = capture;
  capture = null;
  if (c?.node) { try { c.node.port.postMessage('flush'); } catch { } }
  try { if (c?.token) await api('stop', { token: c.token }); } catch { }
  setTimeout(() => {
    try { c?.node?.disconnect(); } catch { }
    c?.stream?.getTracks().forEach(t => t.stop());
    c?.context?.close?.().catch?.(() => { });
  }, 400);
  if (pollTimer) clearInterval(pollTimer), pollTimer = null;
  await refreshStatus();
  renderHome();
}

function renderLive() {
  const rid = activeRecordingId;
  $('#app').innerHTML = `
    <header style="display:flex;align-items:center;gap:12px;padding:10px 0 18px">
      <span class="badge rec" id="recState">录音中</span>
      <span id="recTime" class="muted" style="font-size:16px"></span>
      <span class="grow"></span>
      <button id="stopBtn" style="border-color:var(--err);color:var(--err)">结束</button>
    </header>
    <div class="tabs" id="viewTabs">
      <button data-view="advice" class="active">回应</button>
      <button data-view="ask">追问</button>
      <button data-view="transcript">转写</button>
    </div>
    <div id="viewAdvice">
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <span class="muted" id="coachStatusText">等待建议</span>
        <span class="grow"></span>
        <button id="regenBtn">生成</button>
      </div>
      <div id="askedOfMe"><div class="empty">暂无建议</div></div>
    </div>
    <div id="viewAsk" style="display:none"><div id="askOthers"><div class="empty">暂无</div></div></div>
    <div id="viewTranscript" style="display:none"><div id="transcript"><div class="empty">等待说话</div></div></div>`;
  $('#stopBtn').onclick = stopRecording;
  $('#regenBtn').onclick = async () => {
    const btn = $('#regenBtn');
    btn.disabled = true; btn.textContent = '分析中…';
    try { await api('coach/generate', { recordingId: rid }); } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = '生成'; return; }
    // 密集轮询到结果出现（最长 90s），出现后直接展示
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 2000));
      let s;
      try { s = await api(`coach/state?recordingId=${encodeURIComponent(rid)}`, undefined, 'GET'); }
      catch { continue; }
      const text = $('#coachStatusText');
      if (text) text.textContent = s.running ? `分析中…（${(i + 1) * 2}s）` : s.error ? s.error : `已分析到第 ${s.throughLine} 段`;
      if (s.latestId) { await loadAdvice(s.latestId); break; }
      if (s.error && !s.running) break;
    }
    btn.disabled = false; btn.textContent = '生成';
  };
  document.querySelectorAll('#viewTabs button').forEach(btn => btn.onclick = () => {
    document.querySelectorAll('#viewTabs button').forEach(b => b.classList.toggle('active', b === btn));
    $('#viewAdvice').style.display = btn.dataset.view === 'advice' ? '' : 'none';
    $('#viewAsk').style.display = btn.dataset.view === 'ask' ? '' : 'none';
    $('#viewTranscript').style.display = btn.dataset.view === 'transcript' ? '' : 'none';
  });
  pollTimer = setInterval(pollCoach, 4000);
  pollCoach();
  // 恢复已有转写
  api('read', { recordingId: rid, lines: 60, tail: true }).then(r => {
    r.entries.forEach(e => appendTranscript(e));
  }).catch(() => { });
  setInterval(() => { if (capture) $('#recTime').textContent = fmtTime(Date.now() - capture.startedAt); }, 500);
}

function appendTranscript(entry) {
  const box = $('#transcript');
  if (!box) return;
  if (box.querySelector('.empty')) box.innerHTML = '';
  const div = document.createElement('div');
  div.className = 't-entry';
  div.innerHTML = `<time>${fmtClock(entry.ts)}</time><span>${esc(entry.text)}</span>`;
  box.appendChild(div);
  while (box.children.length > 400) box.firstChild.remove();
}

async function pollCoach() {
  const rid = activeRecordingId;
  if (!rid) return;
  try {
    const s = await api(`coach/state?recordingId=${encodeURIComponent(rid)}`, undefined, 'GET');
    const text = $('#coachStatusText');
    if (!text) return;
    if (s.running) {
      text.textContent = '分析中…';
    } else if (s.error) {
      text.textContent = s.error;
    } else {
      text.textContent = `已分析到第 ${s.throughLine} 段`;
      if (s.latestId && s.latestId !== currentAdvice?.id) {
        text.innerHTML = `<a href="#" id="newAdvice">有新建议，点击查看</a>`;
        $('#newAdvice').onclick = () => loadAdvice(s.latestId);
      }
    }
  } catch { }
}

async function loadAdvice(adviceId) {
  const rid = activeRecordingId;
  if (!rid) return;
  try {
    const advice = await api('coach/read', { recordingId: rid, adviceId });
    currentAdvice = advice;
    const c = advice.content;
    $('#askedOfMe').innerHTML = c.askedOfMe.map(q => `
      <div class="q-card">
        <h4>${esc(q.question)}</h4>
        <div class="reply"><span class="tag">直接说</span><p>${esc(q.conciseReply)}</p></div>
        <div class="reply"><span class="tag">展开说</span><p>${esc(q.tactfulReply)}</p></div>
      </div>`).join('');
    $('#askOthers').innerHTML = c.askOthers.map(q => `
      <div class="q-card"><h4>${esc(q.question)}</h4><div class="muted">${esc(q.purpose)}</div></div>`).join('') || '<div class="empty">暂无</div>';
    $('#coachStatusText').textContent = `建议来自最近 ${advice.throughLine} 段讨论`;
  } catch (e) { toast(e.message); }
}

// ===================== 调试模式 =====================
function renderDebug() {
  $('#app').innerHTML = `
    <header style="display:flex;align-items:center;gap:12px;padding:10px 0 18px">
      <button data-go="">←</button><h1 style="font-size:18px;margin:0;flex:1">调试</h1>
      <button class="primary" id="debugStart">开始调试会议</button>
    </header>
    <div class="card">
      <p class="muted" style="margin-top:0">不碰麦克风：在这里打字模拟会议中的发言（比如领导说的话），验证转写落盘、建议生成是否正常。走的是和真实录音完全相同的链路。</p>
      <textarea id="debugInput" rows="3" placeholder="例如：现在每个人说一下自己的目标"></textarea>
      <div class="row" style="margin-top:10px">
        <button id="debugSend">当作一句话发出去</button>
      </div>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <strong>转写流</strong>
        <button id="debugGen">手动生成建议</button>
      </div>
      <div id="debugTranscript"><div class="empty">还没输入</div></div>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between"><strong>最新建议</strong><span class="muted" id="debugStatus"></span></div>
      <div id="debugAdvice"><div class="empty">还没有建议</div></div>
    </div>`;
  bindNav();
  $('#debugStart').onclick = startDebug;
  $('#debugSend').onclick = sendDebugLine;
  $('#debugGen').onclick = async () => {
    if (!debugRid) return toast('先开始调试会议');
    try {
      await api('coach/generate', { recordingId: debugRid });
      setTimeout(refreshDebugAdvice, 2000);
    } catch (e) { toast(e.message); }
  };
}

let debugRid = null;
async function startDebug() {
  try {
    await api('brief', { invitation: brief.invitation, goal: brief.goal, role: brief.role, initialViews: brief.initialViews, cwd: brief.cwd, autoEnabled: true });
    const started = await api('debug/start', {});
    debugRid = started.recording.id;
    toast('调试会话已开始，直接输入发言');
    $('#debugStart').disabled = true;
  } catch (e) { toast(e.message); }
}
async function sendDebugLine() {
  const text = $('#debugInput').value.trim();
  if (!text) return;
  if (!debugRid) await startDebug();
  if (!debugRid) return;
  try {
    await api('debug/say', { recordingId: debugRid, text });
    // 转写行由 SSE 推送渲染，这里只清输入
    $('#debugInput').value = '';
    setTimeout(refreshDebugAdvice, 2500);
  } catch (e) { toast(e.message); }
}
async function refreshDebugAdvice() {
  if (!debugRid) return;
  try {
    const s = await api(`coach/state?recordingId=${encodeURIComponent(debugRid)}`, undefined, 'GET');
    $('#debugStatus').textContent = s.running ? '分析中…' : s.error ? s.error : `已分析 ${s.throughLine} 段`;
    if (s.latestId) {
      const advice = await api('coach/read', { recordingId: debugRid, adviceId: s.latestId });
      $('#debugAdvice').innerHTML = advice.content.askedOfMe.map(q => `
        <div class="q-card">
          <h4>${esc(q.question)}</h4>
          <div class="reply"><span class="tag">直接说</span><p>${esc(q.conciseReply)}</p></div>
          <div class="reply"><span class="tag">展开说</span><p>${esc(q.tactfulReply)}</p></div>
        </div>`).join('');
    }
  } catch { }
}

// ===================== 历史回看 =====================
async function openHistory(recordingId) {
  const [result, state] = await Promise.all([
    api('read', { recordingId, lines: 200 }),
    api(`coach/state?recordingId=${encodeURIComponent(recordingId)}`, undefined, 'GET').catch(() => null),
  ]);
  let advice = null;
  if (state?.latestId) advice = await api('coach/read', { recordingId, adviceId: state.latestId }).catch(() => null);
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <div class="inner">
      <h3>${fmtDate(result.recording.startedAt)}</h3>
      <div class="tabs"><button class="active" data-h="t">转写</button><button data-h="a">建议</button></div>
      <div id="hBody" style="max-height:60vh;overflow:auto"></div>
      <div class="actions"><button id="hExport">导出</button><button class="primary" id="hClose">关闭</button></div>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  const render = view => {
    if (view === 't') {
      $('#hBody', dlg).innerHTML = result.entries.map(e => `<div class="t-entry"><time>${fmtClock(e.ts)}</time><span>${esc(e.text)}</span></div>`).join('') || '<div class="empty">无转写</div>';
    } else {
      $('#hBody', dlg).innerHTML = advice ? advice.content.askedOfMe.map(q => `
        <div class="q-card"><h4>${esc(q.question)}</h4>
        <div class="reply"><span class="tag">直接说</span><p>${esc(q.conciseReply)}</p></div>
        <div class="reply"><span class="tag">展开说</span><p>${esc(q.tactfulReply)}</p></div></div>`).join('') : '<div class="empty">无建议</div>';
    }
  };
  dlg.querySelectorAll('[data-h]').forEach(btn => btn.onclick = () => {
    dlg.querySelectorAll('[data-h]').forEach(b => b.classList.toggle('active', b === btn));
    render(btn.dataset.h);
  });
  render('t');
  dlg.querySelector('#hClose').onclick = () => dlg.close();
  dlg.querySelector('#hExport').onclick = () => {
    const lines = [`会议记录 ${fmtDate(result.recording.startedAt)}`, ''];
    result.entries.forEach(e => lines.push(`[${fmtClock(e.ts)}] ${e.text}`));
    if (advice) {
      lines.push('', '建议');
      advice.content.askedOfMe.forEach(q => lines.push(`问：${q.question}`, `答（简）：${q.conciseReply}`, `答（详）：${q.tactfulReply}`, ''));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `会议记录-${recordingId.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  dlg.onclose = () => dlg.remove();
}

// ===================== 路由 =====================
function bindNav() {
  document.querySelectorAll('[data-go]').forEach(el => el.onclick = () => { location.hash = el.dataset.go ? `#/${el.dataset.go}` : '#/'; });
}

async function route() {
  const hash = location.hash.replace('#/', '').replace('#', '');
  if (pollTimer) clearInterval(pollTimer), pollTimer = null;
  await refreshStatus().catch(() => { });
  if (hash === 'settings') return renderSettings();
  if (hash === 'prepare') return renderPrepare();
  if (hash === 'debug') return renderDebug();
  return renderHome();
}

window.addEventListener('hashchange', route);

// SSE：实时转写与录音状态
const events = new EventSource('/events');
events.addEventListener('advice-progress', ev => {
  const { chars } = JSON.parse(ev.data);
  const el = $('#coachStatusText') || $('#debugStatus');
  if (el && el.textContent.startsWith('分析中')) el.textContent = `正在生成（已写 ${chars} 字）…`;
});
events.addEventListener('transcript', ev => {
  const { entry } = JSON.parse(ev.data);
  if (location.hash === '#/debug') {
    const box = $('#debugTranscript');
    if (box && box.querySelector('.empty')) box.innerHTML = '';
    const div = document.createElement('div');
    div.className = 't-entry';
    div.innerHTML = `<time>${fmtClock(entry.ts)}</time><span>${esc(entry.text)}</span>`;
    box?.appendChild(div);
  } else {
    appendTranscript(entry);
  }
});
events.addEventListener('recording-state', ev => {
  const { state } = JSON.parse(ev.data);
  const el = $('#recState');
  if (el) el.textContent = state === 'recording' ? '录音中' : state === 'reconnecting' ? '重连中' : state === 'stopping' ? '收尾中' : state;
});

route();

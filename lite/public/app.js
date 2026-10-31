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
  checkServerVersion(status);
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
    <div class="hist-item">
      <span class="badge">${r.state === 'stopped' ? '结束' : r.state === 'interrupted' ? '中断' : '进行中'}</span>
      <div class="grow" data-open="${r.id}" style="cursor:pointer"><div>${fmtDate(r.startedAt)}</div><div class="muted">${r.segments} 段</div></div>
      <button data-open2="${r.id}">回看</button>
      <button data-del="${r.id}" class="danger">删</button>
    </div>`).join('') : '<div class="empty">还没有会议记录</div>';
  $('#history').querySelectorAll('[data-open],[data-open2]').forEach(el => el.onclick = e => { e.stopPropagation(); openHistory(el.dataset.open || el.dataset.open2); });
  $('#history').querySelectorAll('[data-del]').forEach(el => el.onclick = async e => {
    e.stopPropagation();
    if (!confirm('删除这场会议记录？（转写、建议、音频一起删，不可恢复）')) return;
    try {
      await api('delete', { recordingId: el.dataset.del });
      await refreshStatus();
      renderHome();
      toast('已删除');
    } catch (err) { toast(err.message); }
  });
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
  const profile = await api('profile');
  $('#app').innerHTML = `
    <header style="display:flex;align-items:center;gap:12px;padding:10px 0 18px">
      <button data-go="">←</button><h1 style="font-size:18px;margin:0;flex:1">会前准备</h1>
      <button class="primary" id="saveBriefBtn">保存</button>
    </header>
    <div class="card">
      <label>会议邀请 <span class="muted">· 有会邀或议程就粘过来，临时会议可留空</span></label>
      <textarea id="briefInvitation" rows="2" placeholder="例：周四 10:00 项目周会，同步里程碑与风险">${esc(brief.invitation)}</textarea>
      <label>我的目标 <span class="muted">· 这场会我想拿到什么结论</span></label>
      <textarea id="briefGoal" rows="3" placeholder="例：确认二期排期，把测试资源定下来">${esc(brief.goal)}</textarea>
      <div class="row"><button id="polishBtn" ${status?.llm?.configured ? '' : 'disabled'}>润色</button></div>
      <div id="polishArea"></div>
    </div>
    <div class="card">
      <label>最近动态 <span class="muted">· 最近干了什么、目标、进行中的事——领导突然问就用这份答</span></label>
      <textarea id="profileLog" rows="5" placeholder="例：上周把交易模块联调推到 80%，卡在前端接口变更；在跟排期；顺手修了两个线上小 bug">${esc(profile.log ?? '')}</textarea>
      <div class="row" style="margin-top:8px">
        <button id="saveProfileBtn">保存动态</button>
        <button id="importProfileBtn">从文件导入</button>
        <button id="clearProfileBtn" class="danger">清空</button>
      </div>
      <p class="muted" style="margin:6px 0 0">这份内容长期保存（本机 profile.json），每场会议都会自动带上，不用每次重填。</p>
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
  $('#saveProfileBtn').onclick = async () => {
    try {
      await api('profile', { log: $('#profileLog').value });
      toast('最近动态已保存，开会时自动带上');
    } catch (e) { toast(e.message); }
  };
  $('#importProfileBtn').onclick = async () => {
    const file = prompt('填一个本地文本文件路径（txt/md/log，比如周报、笔记导出）', '');
    if (!file) return;
    try {
      await api('profile/import', { file });
      await renderPrepare();
      toast('已导入，追加到最近动态末尾');
    } catch (e) { toast(e.message); }
  };
  $('#clearProfileBtn').onclick = async () => {
    if (!confirm('清空最近动态？')) return;
    try {
      await api('profile', { log: '' });
      await renderPrepare();
      toast('已清空');
    } catch (e) { toast(e.message); }
  };
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
  const profiles = llm.profiles ?? [];
  const activeId = llm.activeProfile;
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
      <div class="row" style="justify-content:space-between">
        <strong>AI 建议</strong>
        <span class="muted">OpenAI 兼容接口</span>
      </div>
      ${profiles.length ? `
        <label>厂商预设（点击一键切换）</label>
        <div id="profileList">${profiles.map(p => `
          <div class="row" style="justify-content:space-between;padding:6px 4px;border-bottom:1px dashed var(--border)">
            <span>${esc(p.name)} <span class="muted">${esc(p.model)}</span></span>
            <span class="grow"></span>
            ${p.id === activeId ? '<span class="badge ok">使用中</span>' : `<button data-activate="${p.id}">切换</button>`}
            <button data-del="${p.id}" style="color:var(--err)">删</button>
          </div>`).join('')}
        </div>` : '<p class="muted" style="margin-bottom:4px">还没有预设：填好下面三项后点「存为预设」，以后一键切换。</p>'}
      <label>Base URL</label>
      <input id="cfgLlmBase" value="${esc(llm.baseUrl)}" placeholder="https://api.deepseek.com">
      <label>模型</label>
      <div class="row">
        <input id="cfgLlmModel" value="${esc(llm.model)}" placeholder="deepseek-chat" style="flex:1">
        <button id="fetchModelsBtn">获取模型列表</button>
      </div>
      <div id="modelList"></div>
      <label>API Key</label>
      <input id="cfgLlmKey" type="password" placeholder="${llm.configured ? '已保存' : '必填'}">
      <label>思考强度（推理模型；越低越快出字）</label>
      <div class="row">
        <select id="cfgEffort" style="flex:1">
          <option value="low" ${llm.effort !== 'high' && llm.effort !== 'max' ? 'selected' : ''}>low · 最快（推荐会中使用）</option>
          <option value="high" ${llm.effort === 'high' ? 'selected' : ''}>high · 慎重（默认）</option>
          <option value="max" ${llm.effort === 'max' ? 'selected' : ''}>max · 深思（最慢）</option>
        </select>
      </div>
      <p class="muted" style="margin:4px 0 0">提示：非推理模型（如 deepseek-chat）出字最快，首字约 0.5 秒。</p>
      <div class="row" style="margin-top:12px">
        <button id="testBtn">测试连接</button>
        <button id="saveProfileBtn">存为预设</button>
        <span class="grow"></span>
      </div>
      <div id="testResult" class="muted"></div>
    </div>
    <button class="big primary" id="saveCfgBtn">保存</button>`;
  bindNav();

  const llmDraft = () => {
    const draft = { baseUrl: $('#cfgLlmBase').value.trim(), model: $('#cfgLlmModel').value.trim() };
    if ($('#cfgLlmKey').value.trim()) draft.apiKey = $('#cfgLlmKey').value.trim();
    return draft;
  };
  // Key 输入框有值时优先用输入值，否则后端用已保存的
  const llmDraftFull = () => {
    const draft = llmDraft();
    if (!draft.apiKey) delete draft.apiKey; // 后端缺 apiKey 时回退已保存 key
    return draft;
  };

  $('#fetchModelsBtn').onclick = async () => {
    const btn = $('#fetchModelsBtn');
    btn.disabled = true; btn.textContent = '获取中…';
    $('#modelList').innerHTML = '';
    try {
      const draft = llmDraft();
      const { models } = await api('llm/models', draft.apiKey ? draft : { baseUrl: draft.baseUrl });
      $('#modelList').innerHTML = `<div class="q-card" style="max-height:200px;overflow:auto">${models.map(m => `<div data-model="${esc(m)}" style="padding:3px 0;cursor:pointer">· ${esc(m)}</div>`).join('')}</div>`;
      $('#modelList').querySelectorAll('[data-model]').forEach(el => el.onclick = () => {
        $('#cfgLlmModel').value = el.dataset.model;
        $('#modelList').innerHTML = '';
        toast(`已选模型：${el.dataset.model}`);
      });
    } catch (e) { toast(e.message); }
    btn.disabled = false; btn.textContent = '获取模型列表';
  };

  $('#testBtn').onclick = async () => {
    const btn = $('#testBtn');
    btn.disabled = true; btn.textContent = '测试中…';
    $('#testResult').textContent = '';
    try {
      const draft = llmDraft();
      if (!draft.model) throw new Error('先填模型名');
      const r = await api('llm/test', draft);
      $('#testResult').innerHTML = `<span class="badge ok">可用</span> 首字 ${r.ttfbMs}ms · 总 ${(r.totalMs / 1000).toFixed(1)}s · 回复「${esc(r.text.slice(0, 20))}」`;
    } catch (e) {
      $('#testResult').innerHTML = `<span class="badge err">失败</span> ${esc(e.message)}`;
    }
    btn.disabled = false; btn.textContent = '测试连接';
  };

  $('#saveProfileBtn').onclick = async () => {
    const draft = llmDraft();
    try {
      if (!draft.baseUrl || !draft.model) throw new Error('Base URL 和模型都填好才能存预设');
      if (!draft.apiKey) throw new Error('API Key 填上才能存预设（预设里保存的是这家的 Key）');
      const name = prompt('预设名称（比如：DeepSeek / 公司网关）', draft.baseUrl.match(/https?:\/\/([^/]+)/)?.[1] ?? '') ?? '';
      if (!name) return;
      await api('llm/profiles', { name, baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey });
      await renderSettings();
      toast('预设已保存');
    } catch (e) { toast(e.message); }
  };

  document.querySelectorAll('[data-activate]').forEach(el => el.onclick = async () => {
    try {
      await api('llm/profiles/activate', { id: el.dataset.activate });
      await refreshStatus();
      await renderSettings();
      toast('已切换');
    } catch (e) { toast(e.message); }
  });
  document.querySelectorAll('[data-del]').forEach(el => el.onclick = async () => {
    if (!confirm('删除这个预设？')) return;
    try {
      await api('llm/profiles/delete', { id: el.dataset.del });
      await renderSettings();
      toast('已删除');
    } catch (e) { toast(e.message); }
  });

  $('#saveCfgBtn').onclick = async () => {
    try {
      const voiceDraft = {};
      if ($('#cfgApiKey').value.trim()) voiceDraft.apiKey = $('#cfgApiKey').value.trim();
      if ($('#cfgWsBase').value.trim()) voiceDraft.wsBase = $('#cfgWsBase').value.trim();
      if ($('#cfgAsrModel').value.trim()) voiceDraft.model = $('#cfgAsrModel').value.trim();
      if (Object.keys(voiceDraft).length) await api('voice-config', voiceDraft);
      const draft = llmDraft();
      draft.effort = $('#cfgEffort').value;
      await api('llm-config', draft);
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
  const btn = $('#stopBtn');
  if (btn) { btn.disabled = true; btn.textContent = '结束中…'; }
  if (c?.node) { try { c.node.port.postMessage('flush'); } catch { } }
  // 停麦克风立刻做；server 收尾不等（ASR finish 最长 12s，不阻塞界面）
  setTimeout(() => {
    try { c?.node?.disconnect(); } catch { }
    c?.stream?.getTracks().forEach(t => t.stop());
    c?.context?.close?.().catch?.(() => { });
  }, 300);
  if (pollTimer) clearInterval(pollTimer), pollTimer = null;
  api('stop', { token: c?.token }).catch(() => { });
  // 界面立刻回首页，server 在后台收尾
  await refreshStatus();
  renderHome();
}

function renderLive() {
  const rid = activeRecordingId;
  $('#app').innerHTML = `
    <header class="rec-head" style="padding:10px 4px 16px">
      <span class="pulse-dot"></span>
      <span class="badge rec" id="recState">录音中</span>
      <span id="recTime" class="time" style="font-weight:700"></span>
      <span class="grow"></span>
      <button class="danger" id="stopBtn">结束</button>
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
        <button id="myTurnBtn" class="primary">轮到我了</button>
        <button id="regenBtn">生成</button>
      </div>
      <div id="speechStream"></div>
      <div id="askedOfMe"><div class="empty">暂无建议</div></div>
    </div>
    <div id="viewAsk" style="display:none"><div id="askOthers"><div class="empty">暂无</div></div></div>
    <div id="viewTranscript" style="display:none"><div id="transcript"><div class="empty">等待说话</div></div></div>`;
  $('#stopBtn').onclick = stopRecording;
  // 轮到我了：即使没有新转写也强制生成一段"现在就发言"的稿子（领导眼神示意时用）
  $('#myTurnBtn').onclick = async () => {
    const btn = $('#myTurnBtn');
    btn.disabled = true; btn.textContent = '写稿中…';
    speechBuffer = '';
    $('#speechStream').innerHTML = '';
    try { await api('coach/generate', { recordingId: rid, hint: '现在轮到用户发言了，请直接给出能立刻照念的发言稿' }); }
    catch (e) { toast(e.message); btn.disabled = false; btn.textContent = '轮到我了'; return; }
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 2000));
      let s;
      try { s = await api(`coach/state?recordingId=${encodeURIComponent(rid)}`, undefined, 'GET'); }
      catch { continue; }
      if (s.latestId) { await loadAdvice(s.latestId); break; }
      if (s.error && !s.running) break;
    }
    btn.disabled = false; btn.textContent = '轮到我了';
  };
  $('#regenBtn').onclick = async () => {
    const btn = $('#regenBtn');
    btn.disabled = true; btn.textContent = '分析中…';
    speechBuffer = '';
    $('#speechStream').innerHTML = '';
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
  // 点文字可改（ASR 错字导致意思变了时人工修正，改完可重新生成建议）
  div.innerHTML = `<time>${fmtClock(entry.ts)}</time><span data-line="${entry.line}" style="cursor:text" title="点击修改这段转写">${esc(entry.text)}</span>`;
  div.querySelector('[data-line]').onclick = async el => {
    const span = el.target ?? el;
    const line = Number(span.dataset.line);
    const current = span.textContent;
    const text = prompt('修正这段转写（改完在"回应"页点"生成"重新出建议）', current);
    if (!text || text === current) return;
    try {
      await api('transcript/edit', { recordingId: activeRecordingId, line, text });
      span.textContent = text;
      toast('已修正');
    } catch (e) { toast(e.message); }
  };
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
    if (c.speech) $('#speechStream').innerHTML = `<div class="q-card" style="border-color:var(--accent)"><span class="tag">发言（照着念）</span><p style="font-size:15px">${esc(c.speech)}</p></div>`;
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
      <div id="debugSpeech"></div>
      <div id="debugAdvice"><div class="empty">还没有建议</div></div>
    </div>`;
  bindNav();
  $('#debugStart').onclick = startDebug;
  $('#debugSend').onclick = sendDebugLine;
  $('#debugGen').onclick = async () => {
    if (!debugRid) return toast('先开始调试会议');
    speechBuffer = '';
    $('#debugSpeech').innerHTML = '';
    try {
      await api('coach/generate', { recordingId: debugRid });
      watchDebugAdvice();
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
    watchDebugAdvice();
  } catch (e) { toast(e.message); }
}
let debugWatchId = null;
function watchDebugAdvice() {
  if (!debugRid) return;
  if (debugWatchId) clearInterval(debugWatchId);
  debugWatchId = setInterval(async () => {
    if (!debugRid || !$('#debugStatus')) { clearInterval(debugWatchId); debugWatchId = null; return; }
    const s = await api(`coach/state?recordingId=${encodeURIComponent(debugRid)}`, undefined, 'GET').catch(() => null);
    if (!s) return;
    if (s.running) { $('#debugStatus').textContent = '分析中…'; return; }
    // 结束（成功或失败）就停轮询并渲染
    clearInterval(debugWatchId); debugWatchId = null;
    refreshDebugAdvice();
  }, 2500);
}
async function refreshDebugAdvice() {
  if (!debugRid) return;
  try {
    const s = await api(`coach/state?recordingId=${encodeURIComponent(debugRid)}`, undefined, 'GET');
    $('#debugStatus').textContent = s.running ? '分析中…' : s.error ? s.error : `已分析 ${s.throughLine} 段`;
    if (s.latestId) {
      const advice = await api('coach/read', { recordingId: debugRid, adviceId: s.latestId });
      if (advice.content.speech) $('#debugSpeech').innerHTML = `<div class="q-card" style="border-color:var(--accent)"><span class="tag">发言（照着念）</span><p style="font-size:15px">${esc(advice.content.speech)}</p></div>`;
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

// 版本指纹：记录页面加载时的 server 启动时间；不一致说明页面比 server 旧（git pull 后没刷新）
// 或 server 比页面新（git pull 后没强刷页面），SSE 端点可能不匹配，给用户提示。
let pageLoadedAtServer = null;
function checkServerVersion(status) {
  if (typeof status?.serverStartedAt !== 'number') return;
  if (pageLoadedAtServer === null) { pageLoadedAtServer = status.serverStartedAt; return; }
  if (status.serverStartedAt !== pageLoadedAtServer) {
    pageLoadedAtServer = status.serverStartedAt;
    toast('检测到服务端已重启，正在刷新页面…');
    setTimeout(() => location.reload(), 800);
  }
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
events.addEventListener('recording-state', ev => {
  const { state } = JSON.parse(ev.data);
  // server 侧已停（自动停/收尾）而页面还在录音视图 → 自动退回首页
  if (['stopped', 'interrupted', 'error'].includes(state) && capture === null && (location.hash === '' || location.hash === '#/' || location.hash === '#')) {
    renderHome();
  }
});
// 流式发言：第一段 speech 逐字到达，立刻显示可跟读的发言
let speechBuffer = '';
let speechEl = null;
events.addEventListener('advice-speech', ev => {
  const { delta } = JSON.parse(ev.data);
  if (activeRecordingId || location.hash.includes('debug')) speechBuffer += delta;
  const box = $('#speechStream') || $('#debugSpeech');
  if (box) {
    if (!box.querySelector('.q-card')) box.innerHTML = '<div class="q-card"><p id="speechText"></p></div>';
    box.querySelector('#speechText').textContent = speechBuffer;
    box.scrollIntoView({ block: 'nearest' });
  }
});
events.addEventListener('advice-progress', ev => {
  const { chars, phase } = JSON.parse(ev.data);
  const el = $('#coachStatusText') || $('#debugStatus');
  if (!el) return;
  if (phase === 'thinking') el.textContent = `正在思考（${chars} 字）…`;
  else if (phase === 'analyzing') el.textContent = `分析中（${chars} 字）…`;
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

// lite/public/app.js — 轻量版会议助手前端。
// 交互与原插件面板对齐：会前准备（含 AI 润色）→ 录音三视图（回应/追问/转写）→ 历史回看导出。
// 音频路径：AudioWorklet（lite/worklet.mjs 由服务端 /worklet.js 提供）→ 16k PCM → /api/audio。

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = ms => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
};
const fmtClock = ts => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
const fmtDate = ts => new Date(ts).toLocaleString('zh-CN', { hour12: false });

let toastTimer;
function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3200);
}

async function api(path, body, method) {
  const res = await fetch(`/api/${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data;
}

// ---------------- 全局状态 ----------------
let brief = { invitation: '', goal: '', role: '', initialViews: '', cwd: '', autoEnabled: true };
let capture = null;       // {stream, context, node, token, startedAt, sequence}
let status = null;        // 最近一次 /api/status
let coachStatus = null;   // 最近一次 coach 状态（轮询）
let pendingAdvice = null;  // 有新建议时先不切换，等用户点
let currentAdvice = null;
let jobId = null;
let statusTimer = null;
let activeRecordingId = null;
let afterLine = 0;
let loadingEarlier = false;

// ---------------- 会前准备 ----------------
async function loadBrief() {
  try { brief = await api('brief'); } catch { brief = { invitation: '', goal: '', role: '', initialViews: '', cwd: '', autoEnabled: true }; }
  $('briefInvitation').value = brief.invitation ?? '';
  $('briefGoal').value = brief.goal ?? '';
  $('briefRole').value = brief.role ?? '';
  $('briefViews').value = brief.initialViews ?? '';
  $('briefCwd').value = brief.cwd ?? '';
  $('autoAdvice').checked = brief.autoEnabled ?? true;
}

async function saveBrief() {
  const draft = {
    invitation: $('briefInvitation').value.trim(),
    goal: $('briefGoal').value.trim(),
    role: $('briefRole').value.trim(),
    initialViews: $('briefViews').value.trim(),
    autoEnabled: $('autoAdvice').checked,
  };
  if (!draft.invitation && !draft.goal && !draft.role && !draft.initialViews) {
    return toast('会前准备可以先留空，但建议至少填「角色」');
  }
  try {
    brief = await api('brief', { ...draft, cwd: $('briefCwd').value.trim() });
    toast('已保存会前准备');
  } catch (e) { toast(e.message); }
}

$('polishBtn').onclick = async () => {
  const goal = $('briefGoal').value.trim();
  if (!goal) return toast('先写一句目标底稿，再点润色');
  $('polishBtn').disabled = true; $('polishBtn').textContent = '润色中…';
  try {
    const { candidates } = await api('brief/polish', {
      invitation: $('briefInvitation').value.trim(),
      goal,
      role: $('briefRole').value.trim(),
      initialViews: $('briefViews').value.trim(),
    });
    const box = $('polishCandidates');
    box.innerHTML = candidates.map((text, i) => `
      <div class="q-card"><p>${esc(text)}</p>
      <button data-polish="${i}">采用</button></div>`).join('');
    box.querySelectorAll('[data-polish]').forEach(btn => btn.onclick = () => {
      $('briefGoal').value = candidates[Number(btn.dataset.polish)];
      $('polishArea').style.display = 'none';
      toast('已替换目标底稿，记得保存准备');
    });
    $('polishArea').style.display = '';
  } catch (e) { toast(e.message); }
  $('polishBtn').disabled = false; $('polishBtn').textContent = '✨ AI 润色目标';
};
$('polishClose').onclick = () => { $('polishArea').style.display = 'none'; };
$('saveBriefBtn').onclick = saveBrief;

// ---------------- 录音 ----------------
async function startRecording() {
  // 先把界面上的准备存下来（录音开始后就绑死这一份 brief）
  await saveBrief();
  try {
    const started = await api('start');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    const context = new AudioContext();
    await context.resume();
    await context.audioWorklet.addModule('/worklet.js');
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'meeting-assistant');
    capture = { stream, context, node, token: started.token, recordingId: started.recording.id, startedAt: Date.now(), sequence: 0 };
    node.port.onmessage = async ev => {
      if (ev.data === 'flushed' || !(ev.data instanceof Uint8Array)) return;
      updateLevel(ev.data);
      if (!capture) return;
      let binary = '';
      for (const byte of ev.data) binary += String.fromCharCode(byte);
      try {
        await api('audio', { token: capture.token, sequence: capture.sequence, pcm: btoa(binary) });
        capture.sequence++;
      } catch (e) {
        if (capture) { toast(`音频上传失败：${e.message}`); await stopRecording(); }
      }
    };
    source.connect(node); node.connect(context.destination);
    activeRecordingId = started.recording.id;
    afterLine = 0;
    $('recordingCard').style.display = '';
    $('prepareCard').style.display = 'none';
    $('recState').textContent = '连接中';
    startStatusPolling();
  } catch (e) {
    toast(`开始录音失败：${e.message}`);
    if (capture?.token) await api('stop', { token: capture.token }).catch(() => {});
    capture = null;
  }
}

function updateLevel(pcm) {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let peak = 0;
  for (let i = 0; i < pcm.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)) / 32768);
  $('recLevel').style.width = `${Math.min(100, peak * 260)}%`;
}

async function stopRecording() {
  const token = capture?.token;
  const node = capture?.node, stream = capture?.stream, context = capture?.context;
  capture = null;
  if (node) { try { node.port.postMessage('flush'); } catch { /* noop */ } }
  $('recState').textContent = '收尾中';
  try {
    if (token) await api('stop', { token });
  } catch (e) { toast(`结束失败：${e.message}`); }
  setTimeout(() => {
    try { node?.disconnect(); } catch { }
    stream?.getTracks().forEach(t => t.stop());
    context?.close().catch?.(() => { });
  }, 400);
  $('recordingCard').style.display = 'none';
  $('prepareCard').style.display = '';
  stopStatusPolling();
  await refreshHistory();
  toast('录音已结束，可在历史会议中回看');
}

$('startBtn').onclick = startRecording;
$('stopBtn').onclick = stopRecording;

// ---------------- 状态轮询 + SSE ----------------
function startStatusPolling() {
  stopStatusPolling();
  statusTimer = setInterval(pollCoachStatus, 4000);
}
function stopStatusPolling() {
  if (statusTimer) clearInterval(statusTimer), statusTimer = null;
}
async function pollCoachStatus() {
  if (!activeRecordingId) return;
  try {
    coachStatus = await api(`coach/state?recordingId=${encodeURIComponent(activeRecordingId)}`, undefined, 'GET');
    renderCoachStatus();
    if (coachStatus.latestId && coachStatus.latestId !== currentAdvice?.id) {
      if (!pendingAdvice || pendingAdvice !== coachStatus.latestId) {
        pendingAdvice = coachStatus.latestId;
        $('coachStatusText').innerHTML = '有新建议，<a href="#" id="viewNew">点击查看</a>';
        $('viewNew').onclick = () => loadAdvice(pendingAdvice);
      }
    }
  } catch { /* 状态拉取失败不打断录音 */ }
}
function renderCoachStatus() {
  const s = coachStatus;
  if (!s) return;
  if (s.running) {
    jobId = s.running.id;
    $('coachStatusText').textContent = `分析中（${s.running.reason === 'manual' ? '手动' : s.running.reason === 'time' ? '定时' : '新内容'}触发，覆盖到第 ${s.running.throughLine} 段）…`;
    $('cancelJobBtn').style.display = '';
  } else {
    jobId = null;
    $('cancelJobBtn').style.display = 'none';
    const pending = s.pendingLines > 0 ? ` · 新增 ${s.pendingLines} 段未分析` : '';
    $('coachStatusText').textContent = s.error ? s.error : `已覆盖到第 ${s.throughLine} 段${pending}`;
  }
}
$('cancelJobBtn').onclick = async () => {
  if (!activeRecordingId) return;
  try { await api('coach/cancel', { recordingId: activeRecordingId, jobId }); toast('已取消本次分析'); }
  catch (e) { toast(e.message); }
};
$('regenBtn').onclick = async () => {
  if (!activeRecordingId) return;
  try { await api('coach/generate', { recordingId: activeRecordingId }); pollCoachStatus(); }
  catch (e) { toast(e.message); }
};

// SSE：转写与录音状态实时到达
const events = new EventSource('/events');
events.addEventListener('transcript', ev => {
  const { entry } = JSON.parse(ev.data);
  appendTranscriptEntry(entry, $('transcript'));
});
events.addEventListener('recording-state', ev => {
  const { state, wsState, error } = JSON.parse(ev.data);
  if (state === 'recording') $('recState').textContent = '录音中';
  else if (state === 'reconnecting') $('recState').textContent = '转写重连中';
  else if (state === 'stopping') $('recState').textContent = '收尾中';
  else if (state === 'stopped') $('recState').textContent = '已结束';
  else $('recState').textContent = '连接中';
  if (error) $('coachStatusText').textContent = `转写服务：${error}`;
});
setInterval(() => { if (capture) $('recTime').textContent = fmtTime(Date.now() - capture.startedAt); }, 500);

// ---------------- 三视图渲染 ----------------
document.querySelectorAll('#viewTabs button').forEach(btn => btn.onclick = () => {
  document.querySelectorAll('#viewTabs button').forEach(b => b.classList.toggle('active', b === btn));
  $('viewAdvice').style.display = btn.dataset.view === 'advice' ? '' : 'none';
  $('viewAsk').style.display = btn.dataset.view === 'ask' ? '' : 'none';
  $('viewTranscript').style.display = btn.dataset.view === 'transcript' ? '' : 'none';
});

function sourcesHtml(sources, evidence) {
  if (!sources?.length) return '';
  const labels = (evidence ?? []).map(e => [e.id, e.label]);
  const text = sources.map(id => esc((labels.find(([k]) => k === id)?.[1]) ?? id)).join(' · ');
  return `<div class="sources">来源：${text}</div>`;
}

function renderAdvice(advice) {
  currentAdvice = advice;
  pendingAdvice = null;
  const c = advice.content;
  $('adviceSummary').textContent = c.summary ? `本段重点：${c.summary}` : '';
  $('askedOfMe').innerHTML = c.askedOfMe.map(q => `
    <div class="q-card">
      <h4>${esc(q.question)}</h4>
      <div class="why">${esc(q.why)}</div>
      <div class="reply"><span class="tag">精简版（可直接说）</span><p>${esc(q.conciseReply)}</p></div>
      <div class="reply"><span class="tag">高情商版</span><p>${esc(q.tactfulReply)}</p></div>
      ${sourcesHtml(q.sources, advice.evidence)}
    </div>`).join('') || '<div class="empty">还没有建议，点「立即生成」</div>';
  $('askOthers').innerHTML = c.askOthers.map(q => `
    <div class="q-card">
      <h4>${esc(q.question)}</h4>
      <div class="why">目的：${esc(q.purpose)}</div>
      <div class="why">时机：${esc(q.timing)}</div>
      ${sourcesHtml(q.sources, advice.evidence)}
    </div>`).join('') || '<div class="empty">暂无可追问的问题</div>';
  const un = c.uncertainties?.length ? `<div class="muted" style="margin-top:6px">需确认：${c.uncertainties.map(esc).join('；')}</div>` : '';
  $('coachStatusText').insertAdjacentHTML?.('afterend', '');
  if (un) $('adviceSummary').insertAdjacentHTML('afterend', un);
  $('coachStatusText').textContent = `建议生成于 ${fmtClock(advice.createdAt)}（${advice.model}）`;
}

async function loadAdvice(adviceId, recordingId) {
  const id = recordingId ?? activeRecordingId;
  if (!id) return;
  try {
    const advice = await api('coach/read', { recordingId: id, adviceId });
    renderAdvice(advice);
  } catch (e) { toast(e.message); }
}

// ---------------- 转写视图 ----------------
function appendTranscriptEntry(entry, container) {
  const div = document.createElement('div');
  div.className = 't-entry';
  div.innerHTML = `<time>${fmtClock(entry.ts)}</time><span>${esc(entry.text)}</span>`;
  container.appendChild(div);
  while (container.children.length > 400) container.firstChild.remove();
  container.parentElement.querySelector('.muted')?.remove;
  container.scrollTop = container.scrollTop; // 不打断阅读位置
  // 新转写到达时滚动到底（若用户本来就在底部附近）
  if (container.scrollHeight - container.scrollTop - container.clientHeight < 160) {
    container.lastElementChild?.scrollIntoView({ block: 'end' });
  }
}
$('loadEarlier').onclick = async () => {
  if (loadingEarlier || !activeRecordingId) return;
  loadingEarlier = true;
  try {
    const result = await api('read', { recordingId: activeRecordingId, lines: 80, afterLine: 0 });
    const box = $('transcript');
    box.innerHTML = '';
    result.entries.forEach(e => appendTranscriptEntry(e, box));
    if (result.hasMore) toast('还有更早内容，再次点击继续加载');
  } catch (e) { toast(e.message); }
  loadingEarlier = false;
};

// ---------------- 设置 ----------------
$('settingsBtn').onclick = async () => {
  const [voice, llm] = await Promise.all([api('voice-config'), api('llm-config')]);
  $('cfgWsBase').value = voice.wsBase ?? '';
  $('cfgAsrModel').value = voice.model ?? '';
  $('cfgLlmBase').value = llm.baseUrl ?? '';
  $('cfgLlmModel').value = llm.model ?? '';
  $('cfgApiKey').value = '';
  $('cfgLlmKey').value = '';
  $('settingsDialog').showModal();
};
$('saveCfgBtn').onclick = async () => {
  try {
    const voiceDraft = {};
    if ($('cfgApiKey').value.trim()) voiceDraft.apiKey = $('cfgApiKey').value.trim();
    if ($('cfgWsBase').value.trim()) voiceDraft.wsBase = $('cfgWsBase').value.trim();
    if ($('cfgAsrModel').value.trim()) voiceDraft.model = $('cfgAsrModel').value.trim();
    if (Object.keys(voiceDraft).length) await api('voice-config', voiceDraft);
    const llmDraft = { baseUrl: $('cfgLlmBase').value.trim(), model: $('cfgLlmModel').value.trim() };
    if ($('cfgLlmKey').value.trim()) llmDraft.apiKey = $('cfgLlmKey').value.trim();
    if (llmDraft.baseUrl || llmDraft.model) await api('llm-config', llmDraft);
    await refreshStatus();
    toast('设置已保存');
    $('settingsDialog').close();
  } catch (e) { toast(e.message); }
};

// ---------------- 历史会议 ----------------
async function refreshStatus() {
  status = await api('status', undefined, 'GET');
  $('llmBadge').textContent = status.llm.configured ? `LLM ${status.llm.model}` : 'LLM 未配置';
  $('llmBadge').className = 'badge' + (status.llm.configured ? ' ok' : '');
  $('voiceBadge').textContent = status.voice.configured ? '转写已配置' : '转写未配置';
  $('voiceBadge').className = 'badge' + (status.voice.configured ? ' ok' : '');
  $('polishBtn').disabled = !status.llm.configured;
  return status;
}

async function refreshHistory() {
  const status = await refreshStatus();
  const box = $('history');
  if (!status.recordings.length) {
    box.innerHTML = '<div class="empty">还没有录音记录</div>';
    return;
  }
  box.innerHTML = status.recordings.map(r => `
    <div class="hist-item" data-id="${r.id}">
      <span class="badge">${r.state === 'stopped' ? '已结束' : r.state === 'interrupted' ? '中断' : r.state}</span>
      <div class="meta">
        <div>${fmtDate(r.startedAt)}</div>
        <div class="muted">${r.segments} 段转写${r.audioBytes ? ` · ${(r.audioBytes / 1024 / 1024).toFixed(1)}MB 音频` : ''}${r.error ? ` · ${esc(r.error.slice(0, 40))}` : ''}</div>
      </div>
      <span class="grow"></span>
      <button data-open="${r.id}">回看</button>
    </div>`).join('');
  box.querySelectorAll('[data-open]').forEach(btn => btn.onclick = () => openHistory(btn.dataset.open));
}

let historyRecordingId = null;
async function openHistory(recordingId) {
  historyRecordingId = recordingId;
  const result = await api('read', { recordingId, lines: 200 });
  $('historyTitle').textContent = `会议记录 · ${fmtDate(result.recording.startedAt)}`;
  renderHistoryView('advice');
  try {
    const coachState = await api(`coach/state?recordingId=${encodeURIComponent(recordingId)}`, undefined, 'GET');
    if (coachState.latestId) {
      const advice = await api('coach/read', { recordingId, adviceId: coachState.latestId });
      $('histBody').dataset.advice = JSON.stringify(advice);
    } else {
      $('histBody').dataset.advice = '';
    }
  } catch { $('histBody').dataset.advice = ''; }
  $('histBody').dataset.transcript = JSON.stringify(result.entries);
  renderHistory('advice');
  const wavUrl = `/audio/${recordingId}.wav`;
  const audio = $('histAudio');
  fetch(wavUrl, { method: 'HEAD' }).then(r => {
    audio.style.display = r.ok ? '' : 'none';
    if (r.ok) audio.src = wavUrl;
  }).catch(() => { });
  $('historyDialog').showModal();
}
document.querySelectorAll('#histTabs button').forEach(btn => btn.onclick = () => {
  document.querySelectorAll('#histTabs button').forEach(b => b.classList.toggle('active', b === btn));
  renderHistory(btn.dataset.hview);
});
function renderHistoryView() { }
function renderHistory(view) {
  const body = $('histBody');
  if (view === 'advice') {
    const advice = body.dataset.advice ? JSON.parse(body.dataset.advice) : null;
    body.innerHTML = advice ? `
      <div class="muted" style="margin-bottom:8px">${esc(advice.content.summary ?? '')}</div>
      ${advice.content.askedOfMe.map(q => `
        <div class="q-card"><h4>${esc(q.question)}</h4>
        <div class="reply"><span class="tag">精简版</span><p>${esc(q.conciseReply)}</p></div>
        <div class="reply"><span class="tag">高情商版</span><p>${esc(q.tactfulReply)}</p></div></div>`).join('')}
      <div class="muted" style="margin-top:10px">可追问：</div>
      ${advice.content.askOthers.map(q => `<div class="q-card"><h4>${esc(q.question)}</h4><div class="why">${esc(q.purpose ?? '')}</div></div>`).join('')}`
      : '<div class="empty">这场会议没有生成过建议</div>';
  } else {
    const entries = body.dataset.transcript ? JSON.parse(body.dataset.transcript) : [];
    body.innerHTML = entries.map(e => `<div class="t-entry"><time>${fmtClock(e.ts)}</time><span>${esc(e.text)}</span></div>`).join('')
      || '<div class="empty">没有转写内容</div>';
  }
}
$('exportTxt').onclick = () => {
  const body = $('histBody');
  const title = $('historyTitle').textContent;
  const advice = body.dataset.advice ? JSON.parse(body.dataset.advice) : null;
  const entries = body.dataset.transcript ? JSON.parse(body.dataset.transcript) : [];
  const lines = [title, '', '—— 转写 ——', ...entries.map(e => `[${fmtClock(e.ts)}] ${e.text}`)];
  if (advice) {
    lines.push('', '—— 发言建议 ——');
    for (const q of advice.content.askedOfMe) {
      lines.push(`Q: ${q.question}`, `精简版: ${q.conciseReply}`, `高情商版: ${q.tactfulReply}`, '');
    }
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `会议记录-${historyRecordingId?.slice(0, 8) ?? 'export'}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('refreshHistory').onclick = refreshHistory;

// ---------------- 启动 ----------------
loadBrief();
refreshStatus().then(refreshHistory);
$('dataDir').textContent = '~/.agent-mesh/voice';
window.addEventListener('beforeunload', () => { if (capture) api('stop', { token: capture.token }).catch(() => { }); });

// lite/llm.mjs — 轻量版的建议生成后端：OpenAI 兼容 /chat/completions（非流式）。
// 替换原插件的 DSH 会话模型/子 Agent 两条路径 —— 浏览器页面直接调本服务的 /api/llm，
// 由服务端带上 API Key 转发，页面不接触密钥。

export function llmConfigValid(c) {
  return !!(c && c.baseUrl?.trim() && c.model?.trim() && c.apiKey?.trim());
}

export async function chatCompletion(cfg, { system, prompt }, { timeoutMs = 90_000, signal } = {}) {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('LLM 请求超时')), timeoutMs);
  signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        temperature: 0.5,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM 服务返回 ${res.status}：${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('LLM 未返回文本内容。');
    return { text: content, model: data?.model ?? cfg.model, provider: new URL(base).host };
  } finally {
    clearTimeout(timer);
  }
}

/** 会前目标润色：同样走 chat，让模型给出 2–3 个候选（保持原插件“候选由用户采用”的交互）。 */
export async function polishGoalRequest(cfg, { invitation, goal, role, initialViews }, opts = {}) {
  const system = `你是会议发言稿润色助手。用户给出会议邀请、角色、初始观点和一段自己写的会议目标，请润色这段目标，给出 2–3 个候选版本，每个 60–160 字，口吻是第一人称"我"，可直接在会上说出。不捏造事实、数据、进度或承诺；与角色无关的内容不要加。仅输出 JSON：{"candidates":["候选1","候选2"]}`;
  const prompt = JSON.stringify({ invitation, role, initialViews, 我的会议目标: goal, note: '请润色"我的会议目标"这一段。' });
  const { text } = await chatCompletion(cfg, { system, prompt }, opts);
  let parsed;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('模型未返回有效的润色结果，请重试。'); }
  if (!Array.isArray(parsed?.candidates) || !parsed.candidates.every(c => typeof c === 'string' && c.trim())) {
    throw new Error('模型返回的润色候选不完整，请重试。');
  }
  return parsed.candidates.filter(c => c.trim()).slice(0, 3);
}

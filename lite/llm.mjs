// lite/llm.mjs — 建议生成的 LLM 客户端：OpenAI 兼容 /chat/completions。
// 用流式（stream=true）收集 delta：网关类 provider 的非流式请求经常整包挂起几十秒才返回，
// 流式首字节只要 ~0.3s，且总耗时不劣化（实测见仓库调试记录）。

export function llmConfigValid(c) {
  return !!(c && c.baseUrl?.trim() && c.model?.trim() && c.apiKey?.trim());
}

export async function chatCompletion(cfg, { system, prompt }, { timeoutMs = 90_000, signal, onDelta } = {}) {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('LLM 请求超时')), timeoutMs);
  signal?.addEventListener('abort', () => controller.abort(signal.reason ?? new Error('aborted')), { once: true });
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
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM 服务返回 ${res.status}：${text.slice(0, 300)}`);
    }
    if (!res.body) throw new Error('LLM 未返回流式响应体。');
    // SSE 分帧：按空行切 event，data: 单行 JSON
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let model = cfg.model;
    let finish = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) { text += choice.delta.content; onDelta?.(choice.delta.content); }
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
    }
    if (!text.trim()) throw new Error(`LLM 未返回文本内容（finish=${finish ?? 'none'}）。`);
    return { text, model, provider: new URL(base).host };
  } finally {
    clearTimeout(timer);
  }
}

/** 会前目标润色：同样走 chat（流式），返回 2–3 个候选。 */
export async function polishGoalRequest(cfg, { invitation, goal, role, initialViews }, opts = {}) {
  const system = `你是会议发言稿润色助手。用户给出会议邀请、角色、初始观点和一段自己写的会议目标，请润色这段目标，给出 2–3 个候选版本，每个 60–160 字，第一人称口吻，可直接在会上说出。不捏造事实、数据、进度或承诺。仅输出 JSON：{"candidates":["候选1","候选2"]}`;
  const prompt = JSON.stringify({ invitation, role, initialViews, 我的会议目标: goal, note: '请润色"我的会议目标"这一段。' });
  const { text } = await chatCompletion(cfg, { system, prompt }, { ...opts, timeoutMs: opts.timeoutMs ?? 60_000 });
  let parsed;
  try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('模型未返回有效的润色结果，请重试。'); }
  if (!Array.isArray(parsed?.candidates) || !parsed.candidates.every(c => typeof c === 'string' && c.trim())) {
    throw new Error('模型返回的润色候选不完整，请重试。');
  }
  return parsed.candidates.filter(c => c.trim()).slice(0, 3);
}

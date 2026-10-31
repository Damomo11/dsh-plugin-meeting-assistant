// lite/llm.mjs — LLM 客户端：OpenAI 兼容 /chat/completions（流式收集）。
// baseUrl 兼容三种写法：裸域（自动补 /v1）、带 /v1、带尾斜杠；/anthropic 等
// 非 OpenAI 协议路径会在连接测试时给出明确报错，而不是玄学 404。

export function llmConfigValid(c) {
  return !!(c && c.baseUrl?.trim() && c.model?.trim() && c.apiKey?.trim() && c.apiKey !== 'ollama');
}

/** 规范化 baseUrl → { api: ".../chat/completions" 可用的前缀, clean: 规范后的 baseUrl } */
export function normalizeBaseUrl(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch { throw new Error('Base URL 不是合法地址。'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Base URL 必须是 http(s)://。');
  let base = url.origin + url.pathname.replace(/\/+$/, '');
  // 裸域或域名根：补 /v1（OpenAI 兼容惯例）
  const knownRoots = ['api.deepseek.com', 'api.openai.com', 'api.moonshot.cn', 'dashscope.aliyuncs.com/compatible-mode', 'open.bigmodel.cn', 'api.siliconflow.cn', 'api.mistral.ai', 'api.together.xyz', 'api.groq.com', 'api.lith.ink'];
  if (!/\/v\d+$/.test(base) && !/chat\/completions$/.test(base) && !knownRoots.some(r => base.includes(r))) {
    base += '/v1';
  }
  return { api: `${base}/chat/completions`, base };
}

/** 列出 provider 的可用模型（OpenAI 兼容 GET /models）。 */
export async function listModels(cfg, { timeoutMs = 15_000 } = {}) {
  const { base } = normalizeBaseUrl(cfg.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`列出模型失败 HTTP ${res.status}：${text.slice(0, 150)}`);
    }
    const data = await res.json();
    const ids = (data?.data ?? data?.models ?? []).map(m => m.id ?? m.name).filter(Boolean);
    if (!ids.length) throw new Error('该服务未返回模型列表（可能不支持 /models，请手动填写模型名）。');
    return ids.sort((a, b) => a.localeCompare(b));
  } finally { clearTimeout(timer); }
}

/** 测一句：验证 key + 模型 + 输出可用性，返回首字延迟与总耗时。 */
export async function testModel(cfg, { timeoutMs = 30_000 } = {}) {
  const start = Date.now();
  const result = await chatCompletion(cfg, {
    system: '你是一个测试助手。',
    prompt: '请只回复两个字：可用',
  }, { timeoutMs, wantTtfb: true });
  return { text: result.text.slice(0, 80), ttfbMs: result.ttfbMs, totalMs: Date.now() - start, model: result.model };
}

export async function chatCompletion(cfg, { system, prompt }, { timeoutMs = 90_000, signal, onDelta, onReasoning, wantTtfb } = {}) {
  const { api } = normalizeBaseUrl(cfg.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('LLM 请求超时')), timeoutMs);
  signal?.addEventListener('abort', () => controller.abort(signal.reason ?? new Error('aborted')), { once: true });
  const started = Date.now();
  let ttfbMs = null;
  try {
    const res = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        temperature: 0.5,
        // 推理模型的思考强度：low 让首正文 token 更早出现（实测 flash high≈3-6s / low≈可用但不保证）。
        // 非推理模型（deepseek-chat 等）不认这个参数——带上也无碍，OpenAI 网关忽略未知字段。
        reasoning_effort: cfg.effort ?? 'low',
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 常见错误翻译成人话
      if (res.status === 401 || res.status === 403) throw new Error(`鉴权失败（${res.status}）：API Key 无效或无权限。`);
      if (res.status === 404) throw new Error(`接口不存在（404）：Base URL 路径或模型名不对。${text.slice(0, 120)}`);
      if (res.status === 429) throw new Error(`请求过于频繁或额度不足（429）。`);
      throw new Error(`LLM 服务返回 ${res.status}：${text.slice(0, 200)}`);
    }
    if (!res.body) throw new Error('LLM 未返回流式响应体（该服务可能不支持 stream，请换一个兼容端点）。');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let model = cfg.model;
    let reasoningChars = 0;
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
        if (chunk.error) throw new Error(`LLM 返回错误：${JSON.stringify(chunk.error).slice(0, 200)}`);
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          if (ttfbMs === null) ttfbMs = Date.now() - started;
          text += choice.delta.content;
          onDelta?.(choice.delta.content);
        }
        // 推理模型的思考流（无正文输出前的等待阶段）只报进度
        else if (choice?.delta?.reasoning_content) {
          reasoningChars += choice.delta.reasoning_content.length;
          onReasoning?.(reasoningChars);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
    }
    if (!text.trim()) throw new Error(`LLM 未返回文本内容（finish=${finish ?? 'none'}）。流式响应里没有 delta.content，可能该端点只支持非流式或为其他协议。`);
    return { text, model, provider: new URL(api).host, ttfbMs };
  } finally {
    clearTimeout(timer);
  }
}

/** 会前目标润色：2–3 个候选。 */
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

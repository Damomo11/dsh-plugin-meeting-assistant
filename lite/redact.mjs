// lite/redact.mjs — 凭据脱敏（错误信息与提示词共用）。语义与原插件的 redactCredentials 一致。

export function redactCredentials(text) {
  return String(text ?? '')
    .replace(/\b(?:sk|nk|ak)-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9_.-]{16,}/gi, 'Bearer [redacted]');
}

// lite/diag.mjs — 诊断日志格式（内存环，GET /api/diage 查看）。

let seq = 0;
export function formatLogLine(scope, message, extra) {
  const time = new Date().toISOString();
  const tail = extra ? ` ${JSON.stringify(extra)}` : '';
  return `[${time}] #${++seq} ${scope} ${String(message).slice(0, 400)}${tail}`;
}

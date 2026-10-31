// lite/config.mjs — 转写（百炼 SASR）配置的读写与校验，逐行移植自 src/voice/config.ts。

import { readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_ENDPOINT = 'wss://llm-lnk338qatt81sj7u.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference';
const DEFAULT_MODEL = 'qwen-audio-3.0-asr-flash-streaming';

export const voiceHome = () => process.env.MESH_VOICE_HOME || join(homedir(), '.agent-mesh', 'voice');

export function readConfig(root) {
  let saved = {};
  try { saved = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')); } catch { /* 未配置 */ }
  return {
    apiKey: saved.apiKey || process.env.VR_API_KEY || process.env.DASHSCOPE_API_KEY || '',
    wsBase: saved.wsBase || process.env.VR_SASR_WS_BASE || DEFAULT_ENDPOINT,
    model: saved.model || DEFAULT_MODEL,
  };
}

export function validateVoiceConfig(c) {
  if (!c.apiKey?.trim()) throw new Error('请先在设置中填写百炼 API Key。');
  let url;
  try { url = new URL(c.wsBase); } catch { throw new Error('语音识别地址必须是有效的 wss:// 地址。'); }
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash) {
    throw new Error('语音识别地址必须使用 wss://，且不能包含用户名或密码。');
  }
  if (!c.model?.trim()) throw new Error('请填写语音识别模型。');
  return { apiKey: c.apiKey.trim(), wsBase: url.href, model: c.model.trim() };
}

export function publicConfig(root) {
  const { apiKey, ...config } = readConfig(root);
  return { ...config, configured: !!apiKey };
}

export function saveConfig(root, draft) {
  const previous = readConfig(root);
  const config = validateVoiceConfig({
    apiKey: draft.apiKey || previous.apiKey,
    wsBase: draft.wsBase ?? previous.wsBase,
    model: draft.model ?? previous.model,
  });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'config.json'), tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return publicConfig(root);
}

// server.mjs 里用的是这个名字（与原插件 host.ts 相同的语义）
export function saveVoiceConfig(root, draft) {
  return saveConfig(root, draft ?? {});
}

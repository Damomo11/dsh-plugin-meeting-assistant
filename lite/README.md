# DSH 会议助手 · 轻量版（lite/）

**不用 DSH 也能开箱即用的会议助手**：`node lite/server.mjs` 起一个本地服务，浏览器打开 `http://127.0.0.1:8787`，就能完成会前准备、麦克风录音、实时转写和会中发言建议。功能与交互对齐原 DSH 插件，数据目录与文件格式与原版兼容。

## 它解决什么

原版插件必须装进 DeepSeek Harness（DSH）。轻量版把同一个能力拆成独立可运行的本地应用：

- **不依赖 DSH**：普通 Node.js ≥ 20 + 一个浏览器即可，Windows/macOS/Linux 通用。
- **复用原版内核**：`src/vendor/voice-kernel`（DashScope SASR 客户端、断线重连会话、WAV 封装）原样引用，不复制代码。
- **数据互通**：录音/转写/建议仍存 `~/.agent-mesh/voice`（`MESH_VOICE_HOME` 可改），目录结构与原版插件一致，升级回 DSH 插件也能读。

## 快速开始

```bash
git clone https://github.com/Damomo11/dsh-plugin-meeting-assistant.git
cd dsh-plugin-meeting-assistant
npm install ws        # 唯一运行依赖
node lite/server.mjs  # 默认 127.0.0.1:8787
```

浏览器打开 **http://127.0.0.1:8787**，首次使用点右上角「⚙ 设置」：

| 配置项 | 说明 |
| --- | --- |
| 百炼 API Key | DashScope 流式语音识别（转写），按音频时长计费 |
| 流式 WebSocket 地址 / ASR 模型 | 默认 `run-task` 协议端点与 `qwen-audio-3.0-asr-flash-streaming` |
| LLM Base URL / 模型 / API Key | **任意 OpenAI 兼容接口**（DeepSeek、通义、OpenAI、本地 vLLM 等），用于会中建议与目标润色。Key 只存本机服务端，页面不接触 |

## 使用流程（与原插件面板一致）

1. **会前准备**：填会邀、会议目标，展开「更多背景」填角色与权限、初始观点、项目目录；点「✨ AI 润色」可拿 2–3 个目标候选，点「采用」才替换。
2. **开始录音**：点「🎙 开始录音」申请麦克风；面板显示时长/音量，转写与录音状态经 SSE 实时推送。
3. **会中三视图**：
   - **回应**：可能问我的问题 + 「精简版（20–60 字，可直接说）/ 高情商版（80–140 字）」两种回答参考，带来源标注；
   - **追问**：可以问什么、为什么问、什么时机问；
   - **转写**：逐句原话核对，可加载更早内容。
4. **建议节奏**：自动分析按新增 500 字或每 5 分钟触发（可在设置里调），新建议到达不直接切换，点「有新建议」才查看；也可手动「⟳ 立即生成」或取消本次分析。
5. **结束与回看**：点「■ 结束录音」收尾（音频 finalize 成 WAV）；历史会议里可回看建议、逐句转写、播放录音、导出文字记录。

## 与原插件的差别

| 能力 | 原 DSH 插件 | 轻量版 |
| --- | --- | --- |
| 宿主 | DSH 桌面/Web 内嵌面板 | 独立 Node HTTP 服务 + 浏览器页 |
| 会话标识 | 每个 DSH 会话独立 | 单机单用户固定会话 `lite` |
| 建议生成后端 | DSH 会话模型 / 子 Agent 继承上下文，双路径 | OpenAI 兼容接口单路径（服务端代理） |
| 项目资料 | DSH 工作区注入 + 读取预算 | 自研索引与关键词检索（目录索引 400 文件、片段预算 24000 字，含 .docx 纯文本提取） |
| 自动更新 | npm 稳定通道自动更新 | 无（git pull 手动更新） |
| 插件更新守护 | 有 | 无 |

其余语义保持一致：转写内核与断线重连、15 秒无音频自动停录音、凭据脱敏、错误不打断录音、建议只展示不代答。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEETING_PORT` | `8787` | 服务端口 |
| `MEETING_HOST` | `127.0.0.1` | 监听地址（改 `0.0.0.0` 可局域网访问，注意 API Key 存本机） |
| `MESH_VOICE_HOME` | `~/.agent-mesh/voice` | 数据目录（与原插件共用） |
| `MEETING_DEBUG` | 未设 | 设为 `1` 时诊断日志写 stderr |

## 验证

`test/lite/e2e-final.mjs` 为全链路验证脚本（1/8 假 ASR Key + mock OpenAI 接口）：会前准备 → 配置 → 录音 → 转写落盘 → 建议生成 → 读取建议 → 润色 → 停止 → WAV finalize。假 Key 下 ASR 连不上属预期断连场景，脚本对其容错。

## 目录

```
lite/
  server.mjs         # HTTP/SSE 服务与全部 API 路由（录音生命周期、配置、建议编排）
  store.mjs          # 录音/转写/音频落盘（移植自 src/voice/store.ts，Windows 并发写加固）
  coach.mjs          # 建议编排与状态机 + BriefStore（移植自 src/voice/coach.ts / brief.ts）
  coach-prompt.mjs   # 提示词与建议 JSON 解析（逐行移植 src/voice/coach-prompt.ts）
  llm.mjs            # OpenAI 兼容客户端 + 目标润色
  project-context.mjs# 项目索引与关键词检索（替代 DSH 工作区注入）
  config.mjs         # 转写配置读写（移植自 src/voice/config.ts）
  worklet.mjs        # AudioWorklet 处理器（含 PcmEncoder，由 /worklet.js 提供）
  pcm.mjs            # 浏览器端重采样（保留独立实现，worklet 内为内联副本）
  redact.mjs diag.mjs
  public/index.html public/app.js   # 前端单页
test/lite/e2e-final.mjs
src/vendor/voice-kernel/            # 复用原版 ASR 内核
```

## 许可

与主仓库一致：非商业使用免费，商业使用须取得授权（见 ../LICENSE）。

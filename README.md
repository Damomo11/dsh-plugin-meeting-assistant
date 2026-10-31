<div align="center">

# DSH 会议助手 🎙️

**在 DSH 里录下讨论，结合项目资料准备追问和回答。**

[安装](#安装) · [使用](#使用) · [项目资料与-ai](#项目资料与-ai) · [数据与边界](#数据与边界) · [开发](#开发)

[![npm](https://img.shields.io/npm/v/dsh-plugin-meeting-assistant?label=npm)](https://www.npmjs.com/package/dsh-plugin-meeting-assistant) · [![license](https://img.shields.io/badge/license-Noncommercial%20%2F%20Commercial-orange)](LICENSE) · ![DSH](https://img.shields.io/badge/DSH-plugin-4B6BFB)

</div>

会议助手直接装进 DeepSeek Harness：聊天输入框旁的一个入口，完成会前准备、麦克风录音、实时转写和会中辅助。录音、文字与会议背景保存在本机，历史记录可以回看和导出。

它可以独立安装。录音与转写由本插件提供，会中建议结合当前项目、你的会议目标和最近讨论生成。

> **不装 DSH 也能用**：本仓库 `lite/` 目录是[轻量版本地应用](lite/README.md) —— `node lite/server.mjs` 起本地服务、浏览器打开即用，转写内核与数据目录与插件互通。

**许可：非商业使用免费；企业内部使用、付费服务、SaaS 集成及其他商业使用，须向 [vianvio](https://github.com/vianvio) 付费并取得书面商业授权。** [查看条款](LICENSE)。

| 会前 | 会中 | 会后 |
| --- | --- | --- |
| 填写会邀和目标，按需润色 | 追问 / 回应 / 转写三个视图 | 回看录音、转写和分析记录 |
| 当前项目自动作为资料范围 | 收起面板、切换聊天仍继续录音 | 导出完整文字记录 |

## 安装

### 从 npm 装到 DSH

```bash
dsh plugin --profile desktop add dsh-plugin-meeting-assistant --registry=https://registry.npmjs.org/
```

`--profile` 填你实际使用的配置：桌面端通常是 `desktop`，Web 端是 `web`。这条命令从 npm 安装插件，并自动把它加入 profile 的 `dsh.profile.bundles`。

npm 包已带编译好的客户端和宿主代码，安装时无需克隆仓库或自己构建。**安装后完整退出并重新打开 DSH**，聊天输入框旁会出现「会议助手」，设置中会出现「会议语音」。

要求 DSH 提供 0.2.1 系列插件 API，具体 peer 范围见 [package.json](package.json)。本地验证环境为 macOS 上的 DSH Desktop 0.2.1-rc.5。

<details>
<summary>终端找不到 dsh 命令？</summary>

macOS 上，DeepSeek Harness 安装在 `/Applications` 时，可以直接使用应用内置命令：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add dsh-plugin-meeting-assistant --registry=https://registry.npmjs.org/
```

</details>

### 升级

每次打开会议助手面板时，会在后台检查新版。发现更新后，标题右侧显示「更新」按钮，点击即可进入更新操作；已经安装但尚未生效时显示「待重启」。检查失败不会影响录音。

右上角「⋯ → 插件更新」仍可查看版本、手动重试或关闭自动更新。

自动更新默认开启，每天检查一次 npm 稳定版；录音、分析或目标润色正在进行时先等待，空闲后再安装。更新期间不能开始新录音或分析，安装完成后按面板提示完整重开 DSH。未提供该能力的 DSH 可以使用下方命令手动更新。

npm 和本地 `.tgz` 安装均从官方 npm 稳定通道更新；`link:`、本地源码目录和 Git 安装保留开发来源，不会被自动替换。自动更新开关按 DSH profile 保存。

也可以继续使用命令行：

```bash
dsh plugin --profile desktop update dsh-plugin-meeting-assistant --registry=https://registry.npmjs.org/
```

升级后同样完整重启 DSH。前后端版本不一致时，会议面板会提示重新打开应用。

如果此前通过本地 `.tgz` 或 `link:` 安装，执行下面这条命令切换到 npm 版本：

```bash
dsh plugin --profile desktop add dsh-plugin-meeting-assistant@latest --registry=https://registry.npmjs.org/
```

### 卸载

```bash
dsh plugin --profile desktop remove dsh-plugin-meeting-assistant
```

## 使用

以下截图来自插件真实组件，使用演示数据；转写和 AI 内容仅作操作示例。

### 1. 配置转写服务

打开「设置 → 会议语音」，填写百炼 API Key，以及对应服务的流式 WebSocket 地址和模型名。地址与模型收在「服务地址与模型」中，也可以导入已有的 `.env` 或 JSON 配置。

插件使用 DashScope `run-task` 流式识别协议，请使用支持该协议的服务参数。转写服务按音频时长计费。

AI 建议和目标润色使用当前对话选择的模型，配置方式见下方[项目资料与 AI](#项目资料与-ai)。

<details>
<summary>查看语音设置截图</summary>

<img src="https://raw.githubusercontent.com/vianvio/dsh-plugin-meeting-assistant/main/assets/readme/02-settings.png" width="380" alt="语音设置：百炼 API Key、服务地址与模型、导入配置和保存设置">

在这里保存转写服务凭据；也可以从会议面板右上角菜单进入「语音设置」。

</details>

### 2. 准备会议

点击输入框旁的「会议助手」。会邀和会议目标直接展示，均可留空；角色与立场放在「更多背景」中。

<p><img src="https://raw.githubusercontent.com/vianvio/dsh-plugin-meeting-assistant/main/assets/readme/01-entry.png" width="135" alt="聊天输入框旁的会议助手入口"></p>

当前会话所在项目自动作为资料范围，无需选择文件。填写目标后，可以点击「AI 润色」获取 2–3 个候选，选择并点击「采用」才替换原文。打开面板、打字和开始录音都不会自动润色。

| 填写会邀与目标 | 按需选择润色方案 |
| --- | --- |
| <img src="https://raw.githubusercontent.com/vianvio/dsh-plugin-meeting-assistant/main/assets/readme/03-prepare.png" width="380" alt="会前准备：填写会邀和目标，其他背景折叠"> | <img src="https://raw.githubusercontent.com/vianvio/dsh-plugin-meeting-assistant/main/assets/readme/04-goal-polish.png" width="380" alt="点击 AI 润色，选中一个候选后点击采用"> |
| 填写讨论主题和希望得到的结论，然后点击「开始录音」。 | 点击「AI 润色」→ 选择候选 → 点击「采用」。 |

### 3. 开始录音

点击「开始录音」时才申请麦克风权限。等待授权可以取消，之后迟到的授权也不会自动恢复已取消的录音。

录音中，面板顶部显示时长、音量与结束操作；主区域通过三个视图切换：

- **追问**：结合讨论和项目资料，查看可提出的问题及依据。
- **回应**：展开可能被问到的问题，查看简短或展开的回答参考。
- **转写**：查看逐句原文，按需加载更早的内容。

| 追问：挑选值得继续讨论的问题 | 转写：核对会议原话 |
| --- | --- |
| <img src="https://raw.githubusercontent.com/vianvio/dsh-plugin-meeting-assistant/main/assets/readme/05-questions.png" width="380" alt="录音中的追问视图，包含三个问题、提问目的和折叠来源"> | <img src="https://raw.githubusercontent.com/vianvio/dsh-plugin-meeting-assistant/main/assets/readme/07-transcript.png" width="380" alt="录音中的转写视图，逐句显示时间和会议原文"> |
| 右上角刷新按钮手动生成建议，「来源」可展开查看依据。 | 点击「转写」即可查看逐句记录，顶部仍可结束录音。 |

<details>
<summary>查看「回应」：展开问题，参考两种回答</summary>

<img src="https://raw.githubusercontent.com/vianvio/dsh-plugin-meeting-assistant/main/assets/readme/06-replies.png" width="380" alt="回应视图：展开问题后显示精简版与高情商版回答">

点击「回应」，再展开一个问题；可复制「精简版」或「高情商版」，按实际情况调整后使用。

</details>

新建议到达时，点击「有新建议，点击查看」才切换版本，正在阅读的卡片会保留。自动分析可在右上角菜单调整，也可以手动更新或取消分析。取消只结束本次分析，录音继续。

### 4. 结束与回看

收起面板或切换聊天时，录音继续；点击「结束」才停止。每场会议属于发起录音的会话，全应用同时只录一场。

结束后停留在本场记录。右上角菜单提供历史记录、文字导出、会议背景和语音设置。也可以在原聊天里问“刚才讨论的结论是什么”，让 Agent 通过 `voice_log` 读取本会话的记录。

## 项目资料与 AI

项目目录是会议的默认资料范围。生成建议或润色目标时，插件才按会邀、目标和当前讨论检索相关内容，包括代码、文档、隐藏的 `.notes` 和 Word 文档；目录索引和内容片段有读取预算，依赖、构建目录和二进制内容会按规则跳过。

这表示整个项目可作为检索范围，不能等同于模型已经读完每个文件。每次生成会重新读取当前相关内容。旧会议中的文件快照仍可读取。

会中建议和目标润色都使用**对应对话当前选择的模型**，包括服务商、模型和思考强度。使用前，在 DSH 对话中选好并配置可用模型即可。

| 功能 | 使用的对话模型 |
| --- | --- |
| 会中建议 | 录音所属对话当前选择的模型；支持时通过子 Agent 继承对话上下文 |
| 会中建议的直调回落 | 仍使用该对话选择的模型 |
| 目标润色 | 点击「AI 润色」时使用该对话选择的模型 |

切换模型后，下一次分析或润色使用新选择；已经开始的请求继续使用发起时的模型。无法读取会话模型时会提示重新选择，不会静默切换到其他服务商。语音转写使用单独配置的百炼服务，不随对话模型变化。

建议只展示在面板中，由用户选择是否采用，不会自动代用户发言。

录音运行时支持短暂宿主重载后的接续。音频和停止请求遇到短暂路由不可用时会有限重试；取消分析会立即释放任务状态，迟到结果不会覆盖新的分析。

## 数据与边界

- **本机保存**：录音、转写、会前背景和分析记录默认位于 `~/.agent-mesh/voice`，可用 `MESH_VOICE_HOME` 更改。目录名沿用拆分前的位置，升级可以继续读取原有记录。
- **服务调用**：麦克风音频发送至配置的百炼转写服务；背景、相关项目片段和转写会交给对应的 DSH 模型服务。
- **凭据**：语音配置保存在本机，接口不回显密钥，配置文件权限为 `0600`。
- **音源**：当前直接采集麦克风，不直接采集系统声音；线上会议使用耳机时，需要自行确认麦克风能采到所需声音。
- **浏览器**：Web 端需要 HTTPS 或 localhost 等安全上下文，并允许访问麦克风。
- **中断恢复**：应用退出或刷新后停止采集，已落盘的音频与转写会保留；中断期间不会补录。部分音频未完成转写时，面板会提示。
- **诊断**：插件诊断日志默认在 `~/.agent-mesh/logs`。详细协议、上下文路径与恢复行为见 [设计说明](docs/VOICE.md)。

## 开发

使用 Node.js 24 和本仓库锁定的依赖：

```bash
git clone https://github.com/vianvio/dsh-plugin-meeting-assistant.git
cd dsh-plugin-meeting-assistant
npm ci
npm run check
```

本地开发安装：

```bash
dsh plugin --profile desktop add "link:$PWD"
npm run dev
```

客户端修改可由 DSH 的 HMR 接收；宿主代码修改或发版升级后，完整重启可以确认加载到同一版本。

```bash
npm run build       # 生成 lib/index.js 和 lib/client.js
npm test            # 先构建，再跑 Node 测试与 ASR 内核测试
npm run typecheck   # TypeScript 检查
npm run test:ui     # 可选：真实组件 + 模拟音频/RPC 的浏览器回归
```

`test:ui` 需要本机安装并连接 `browser-harness`；不请求真实麦克风或模型。源码目录、服务依赖与共享内核说明见 [开发与维护](docs/DEVELOPMENT.md)。

## 许可与来源

本项目自 **v0.1.9** 起采用[非商业与商业授权许可](LICENSE)：

- 个人非商业使用、学习和非商业研究可免费使用、修改，并依条款分发。
- 企业内部使用、付费服务、SaaS／托管服务、商业集成及销售分发，须事先向 **vianvio 付费并取得单独书面授权**。
- 授权价格、部署范围、期限及再分发权限由双方另行约定，请通过 [vianvio 的 GitHub 主页](https://github.com/vianvio) 联系维护者洽谈。

这是带商业使用限制的源码可见许可。公开仓库、npm 下载或自动更新均不代表获得商业授权。

v0.1.8 及更早版本已经依 MIT 授出的有效权利仍然保留，新条款不追溯收回这些授权。第三方组件继续适用各自的许可证，完整声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

会议助手从 Agent Mesh 拆分为独立插件；共享层和语音内核的来源分别记录在 [src/shared/README.md](src/shared/README.md) 与 [src/vendor/voice-kernel/README.md](src/vendor/voice-kernel/README.md)。

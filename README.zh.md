# 在 DeepSeek Harness 中使用 Codex 对话

[![npm 版本](https://img.shields.io/npm/v/relay-dsh-plugin-codex?label=npm)](https://www.npmjs.com/package/relay-dsh-plugin-codex)
[![CI](https://github.com/yangbobo2021/relay-dsh-plugin-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/yangbobo2021/relay-dsh-plugin-codex/actions/workflows/ci.yml)
[![npm 月下载量](https://img.shields.io/npm/dm/relay-dsh-plugin-codex?label=downloads)](https://www.npmjs.com/package/relay-dsh-plugin-codex)
[![GitHub Stars](https://img.shields.io/github/stars/yangbobo2021/relay-dsh-plugin-codex?style=flat)](https://github.com/yangbobo2021/relay-dsh-plugin-codex/stargazers)
[![MIT 许可证](https://img.shields.io/github/license/yangbobo2021/relay-dsh-plugin-codex)](LICENSE)
[![DSH 兼容版本](https://img.shields.io/badge/DSH-0.1.1--rc.2-2f7d68)](https://github.com/deepseek-ai/deepseek-harness)
[![npm 来源证明](https://img.shields.io/badge/npm_provenance-verified-2f9e44)](https://www.npmjs.com/package/relay-dsh-plugin-codex/v/0.1.5)

[English](README.md) | 中文

**npm 包名：** [`relay-dsh-plugin-codex`](https://www.npmjs.com/package/relay-dsh-plugin-codex)
· [全部 Relay DSH 插件](https://github.com/yangbobo2021/Relay/blob/codex/relay-foundation/docs/dsh-plugins.zh.md)

**无需切换界面或维护 DSH Fork，直接在官方 DeepSeek Harness 中运行
Codex。**

`relay-dsh-plugin-codex` 为官方
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web
界面增加原生 **Codex 对话后端**。你可以继续使用 DSH 的工作区、对话历史、
输入框、审批和工具；每个 DSH Session 会持续绑定一个 Codex App Server
Thread。本插件可独立安装，不需要下载 Relay 仓库。

## 在官方 DSH 中立即试用

首次创建 Session 前，请先通过官方 Codex 客户端完成认证。使用 Codex CLI 时
可以执行：

```bash
codex login
```

安装要求 Node.js 22.13 或更高版本，并且 `pnpm` 已加入 `PATH`。停止 DSH Web，
安装稳定版插件并重新启动：

```bash
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add relay-dsh-plugin-codex@latest
npx @deepseek-ai/dsh@0.1.1-rc.2 web
```

打开 **New Session**，选择工作区，再从模式菜单中选择 **Codex** 并发送消息。

![DSH 新建会话菜单中的 Codex 和 Claude Code](docs/images/dsh-new-session-backends.jpg)

上图来自安装了 Codex 和 Claude 插件的官方 DSH `0.1.1-rc.2`。如果只安装
本插件，菜单中只会新增 **Codex**。

[观看 Plugin Manager 在 38 秒内找到并安装本插件](https://github.com/yangbobo2021/Relay/blob/codex/relay-foundation/docs/media/dsh-plugin-manager-codex-install-demo.zh.mp4?raw=1)
· [查看全部 Relay DSH 插件](https://github.com/yangbobo2021/Relay/blob/codex/relay-foundation/docs/dsh-plugins.zh.md)

如果它能让你少切换一个界面，欢迎
[Star 本插件](https://github.com/yangbobo2021/relay-dsh-plugin-codex)，并
[反馈你的 DSH 版本或安装结果](https://github.com/yangbobo2021/relay-dsh-plugin-codex/issues)。
这些真实信号能帮助更多 DSH 用户找到经过验证的 Codex 后端。

## 什么情况下需要这个插件？

以下情况适合安装：

- 希望直接在 DSH 中使用 Codex，而不必切换到单独的 Codex 界面；
- 希望保留 DSH 原生的对话历史、输入框、审批和提问；
- 希望一个 DSH Session 在多轮对话中持续使用同一个 Codex App Server
  Thread；
- 希望在同一对话中使用 Codex 模型、reasoning effort、图片、中断以及 DSH
  插件贡献的工具。

使用 DSH 标准 Agent 不需要安装本插件。本插件也不提供 Relay Events、文件
浏览和终端面板，这些能力由其他可选插件提供。

## 完整安装与兼容性说明

以下步骤已经在这些版本上实际验证：

- DeepSeek Harness `0.1.1-rc.2`，commit
  [`b150a551`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e)
- Node.js 22.13 或更高版本
- `pnpm` 已加入 `PATH`

DSH 当前仍是开发者预览版本，可能发生不兼容修改。本仓库会跟进官方版本，
并在这里记录已经验证的版本。

### 1. 准备 Codex 认证

插件会安装一个固定版本的官方 `@openai/codex` 运行时，并以 App Server 模式
启动它。该运行时包含 macOS、Windows、Linux 的 x64 和 arm64 原生二进制，
因此 DSH 不需要从自身的 `PATH` 中寻找 `codex` 命令。

Codex 仍然需要认证。首次创建 DSH Codex 会话前，请安装或打开任一官方 Codex
客户端并完成登录。使用 CLI 时，可以通过以下命令检查共享的本地认证状态：

```bash
codex --version
codex login
```

安装及登录方式参见官方 [Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli)
和[认证文档](https://learn.chatgpt.com/docs/auth)。认证信息仍由 Codex 原有的
本地机制管理，本插件不会收集认证信息。安装本插件会提供 App Server 运行时，
但不会向系统全局安装 `codex` Shell 命令。

### 2. 选择安装来源并安装

修改 Profile 插件前，请先停止正在运行的 DSH Web，然后从以下来源中选择
一种。

#### npm 正式版

本插件发布到 npm 的正式包名是
[`relay-dsh-plugin-codex`](https://www.npmjs.com/package/relay-dsh-plugin-codex)。
使用 `@latest` 安装当前稳定版本：

```bash
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add relay-dsh-plugin-codex@latest
```

本文更新时，`latest` 指向稳定版 `0.1.5`。最新版本请以链接中的 npm 页面
为准。

#### npm 预发布版（DSH 预览阶段推荐）

使用 `@next` 安装已经通过本仓库 CI 发布流程和官方 DSH 兼容性测试的最新
候选版本。当前候选版本还内置了跨平台 App Server 运行时，因此 DSH 不依赖
系统全局的 `codex` 可执行文件：

```bash
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add relay-dsh-plugin-codex@next
```

本分支准备将 `0.1.6-rc.1` 发布到 `next`，不改变 `latest`。
安装前请以 npm 注册表中实际发布的 dist-tag 为准。

本次预发布保留原生服务档位和恢复后的配置，修复取消轮次的迟到命令清理，
拒绝失效绑定上的迟到回复，并保留动态工具错误。具体配置见下文“与桌面 Codex
对照执行”。默认仍捆绑 `@openai/codex@0.149.0`，不会分发或要求安装 Desktop
的实验版程序，也不宣称完整复刻 Desktop。

已知限制：原生命令事件偶尔缺少模型实际收到的错误文本；macOS 的 locale
问题可能影响 `shasum` 等工具。这两项尚未宣称修复。回滚时先停止 DSH，重新
安装 `relay-dsh-plugin-codex@0.1.5`，恢复曾修改的 profile 配置，再启动 DSH。

#### GitHub 开发版

如需测试尚未发布的修改，可以直接安装当前 `main` 分支：

```bash
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add github:yangbobo2021/relay-dsh-plugin-codex#main
```

`main` 会持续变化。如需可复现的 GitHub 安装，请固定 Tag 或完整 Commit
SHA。例如：

```bash
npx @deepseek-ai/dsh@0.1.1-rc.2 plugin --profile web add github:yangbobo2021/relay-dsh-plugin-codex#v0.1.6-rc.1
```

官方 DSH CLI 会在需要时初始化 `web` Profile，通过 `pnpm` 安装所选软件包，
并将插件加入 Bundle 配置。用户不需要下载 Relay 仓库。如果已经安装了持久
可用的 `dsh` 命令，可以将上述任一命令开头的
`npx @deepseek-ai/dsh@0.1.1-rc.2` 替换为 `dsh`。

### 3. 启动或重启 DSH Web

```bash
npx @deepseek-ai/dsh@0.1.1-rc.2 web
```

如果使用已经安装的命令，则执行 `dsh web`。DSH 只在启动时读取 Bundle
成员，因此安装、更新或删除插件后必须重启。

### 4. 新建 Codex 对话

1. 打开终端中显示的 DSH 地址，默认是 `http://127.0.0.1:3080`。
2. 首次启动时阅读 DSH 测试提示，然后点击 **Continue**。
3. 点击左侧栏的 **Add workspace**，选择允许 Codex 操作的项目目录。
4. 点击 **New Session**。
5. 打开当前显示为 **Standard mode** 的模式菜单，选择 **Codex**。
6. 输入消息并发送。请在发送第一条消息前选择后端；已有会话会继续使用创建
   时选择的后端。

插件不需要单独的激活命令。安装成功并重启 DSH 后，Bundle 会自动激活，
并注册由插件管理的 **Codex** 模式。

### 5. 导入 Workspace 中已有的 Codex 会话

1. 点击 Workspace 列表下方、Settings 上方的 **导入会话...**，再选择 **从 Codex 导入**。
2. 在弹窗中确认或切换可见的 **目标 Workspace**，然后点击 **扫描会话**。
   当前 Session 所属 Workspace 或最近 Workspace 只作为初始选项；确认前不会开始扫描。
3. 查看每个可导入 Codex Thread 的完整 ID、标题、源路径、最后活动时间以及
   “可导入”或“待恢复”状态，并勾选一个、多个或全部 Thread。
4. 点击 **导入所选会话**。
5. 确认导入的 Session 已直接显示 Codex 标题并按源活动时间排列，然后打开
   任一 Session 继续对话。

列表只显示精确属于用户所选 Workspace 的可导入 Thread；已绑定 Thread 和其他
Workspace 的 Thread 不可选择。标题和最后活动时间在打开 Session 前就必须可用；
批量导入时间不会覆盖 Codex inventory 的
`thread/list.updatedAt` 顺序。Codex App Server 继续负责
模型上下文、工具状态和压缩；DSH 只保存原生用户/助手展示历史以及一对一绑定，
不会复制 Codex 私有运行记录。每次打开已导入的 Session 时，插件会读取一次对应
的 Codex Thread，并将尚未显示的终态用户/助手 Turn 追加到 DSH 展示历史，其中
包括存在可见消息的 `interrupted` 和 `failed` Turn。只有 `inProgress` Turn 会等到
下次打开。Session 保持打开时不会后台轮询，也不会在发送消息时同步或增加手动
刷新入口。

## 支持的能力

- 每个 DSH Session 持续绑定一个 Codex App Server Thread
- 模型和 reasoning effort 选择
- 在 DSH 原生对话中流式显示回答和 reasoning
- 在新建 Session 中实时显示长时间运行的 Codex Shell 命令输出，并保留在 DSH 历史中
- DSH 原生审批和用户提问流程
- 图片、中断和会话延续
- 在 Codex App Server 的 `dsh` namespace 中提供通用 DSH 工具
- 安装独立 Relay 终端插件后，可选贡献终端传输 Provider

工具通过当前 Agent 的 DSH 工具运行时执行，并继续受到 DSH 权限和 Codex
审批机制约束。

## 可靠性与 App Server 生命周期

Codex App Server 进程由 DSH Host 插件负责。插件激活时、Codex 模型发现之前，
Host 会启动一个子进程；DSH 或插件退出时会停止它。默认子进程来自锁定版本的
`@openai/codex` 依赖，因此不要求系统中存在全局 `codex` 命令。

打开 **Settings → Advanced** 可以查看 Codex 是 **已连接**、**未启动**、
**正在启动**、**连接失败** 还是 **Codex 不可用**。如果 fork 子 Session 继承了
Codex 历史，却没有安全的一对一绑定，Session 标题栏会显示 **需要重新绑定**。
安装和连接错误会提供稳定错误码及下一步操作，不会把 `spawn codex ENOENT`
这样的底层错误直接当成用户提示。

在空白 New Session 中切换 Standard、Codex 和 Claude 时，模型选择会跟随对应
后端的能力组和默认 reasoning effort。Codex 模型发现较慢时会进行有界重试，
较早返回的异步结果不能覆盖用户更新的后端选择。

fork 通过 Codex App Server 的 `thread/fork` 实现。子 DSH Session 会提交继承的
父 Thread id 与已完成的 `lastTurnId`，并把返回的新 Thread 建立为持久的一对一
绑定。如果来源信息不完整、源 Thread 没有对应的 DSH Session，或 App Server
拒绝 fork，操作会 fail closed，绝不会回退到 `thread/start`。持久绑定 resume
失败时也会保留原绑定。重连后处理 pending approval 前，会再次核对 DSH Session、
Codex Thread、Turn、Item、request 和绑定代次；任何不匹配都会拒绝旧 approval，
并保留可诊断的来源信息。

完整约束见[可靠性规范](docs/reliability-spec.md)、
[可执行验收矩阵](docs/reliability-acceptance.md)以及审批与结构化提问的
[DSH 交互桥接规范](docs/spec/dsh-interaction-bridge.md)。

## 插件边界及与 Relay 的关系

本仓库在 [Relay](https://github.com/yangbobo2021/Relay) 项目中完成设计与
兼容性验证。Relay 是面向长时间运行 Agent、外部事件投递、可复用 DSH
工作台视图和多种对话后端的开源项目。

本插件可以独立安装。唯一依赖的 Relay 包是由包管理器自动安装的中立“会话
导入中心”；运行时不依赖 Relay 应用、Relay Events 或其他功能插件，也不会
替换 DSH 官方布局或安装 Files、Terminal 视图。用户可以只安装 Codex；需要
时，Relay 项目则可以进一步组合 Codex、Claude、事件、Wait、Monitor 和工作台
扩展。

可以访问或 Star Relay 仓库，关注这些更完整的工作：
<https://github.com/yangbobo2021/Relay>。

## 更新、检查或删除

修改 Bundle 前先停止 DSH Web，完成后重新启动。

```bash
# 检查插件为何被安装
dsh plugin --profile web why relay-dsh-plugin-codex

# 更新 npm 依赖
dsh plugin --profile web update relay-dsh-plugin-codex

# 删除插件
dsh plugin --profile web remove relay-dsh-plugin-codex
```

如果没有持久安装 `dsh` 命令，请将命令开头的 `dsh` 替换为
`npx @deepseek-ai/dsh@0.1.1-rc.2`。

## 常见问题

### 模式菜单中没有 Codex

先重启 DSH Web，再执行 `dsh plugin --profile web why
relay-dsh-plugin-codex`。如果 pnpm 找不到插件，请重新执行 npm 安装命令，
并查看最后显示的错误。

### 第一条消息提示认证失败或找不到可执行文件

请使用官方 Codex 客户端，以启动 DSH 的同一个操作系统用户执行 `codex
login`，然后重启 DSH。插件默认使用随插件安装的官方 `@openai/codex` 运行时，
不依赖 `PATH`。

如果错误提示随包运行时缺失，请更新或重新安装插件，让包管理器恢复当前平台
对应的 optional dependency。受管部署也可以明确指定其他 Codex 原生可执行文件：

```bash
# macOS 或 Linux
RELAY_CODEX_COMMAND=/absolute/path/to/codex dsh web
```

```powershell
# Windows PowerShell
$env:RELAY_CODEX_COMMAND = 'C:\absolute\path\to\codex.exe'
dsh web
```

DSH Bundle 配置项 `codexCommand` 的优先级高于 `RELAY_CODEX_COMMAND`。建议填写
原生可执行文件的绝对路径；两者都不设置时，会使用随插件发布并完成兼容性验证
的 Codex 版本。

### 与桌面 Codex 对照执行

`codexExecutionMode` 支持 `enhanced`（默认）和 `native`。增强模式接入
DSH 工具和下述执行规范；原生对照模式不注入这些动态工具和规范，用于区分
原生 Codex 行为与 DSH 扩展的影响。两种模式都保留 DSH 的界面、权限选择和
同一个 Codex Thread 的连续性。请用新建对话对照：切换模式不会删除历史上下文。
原生对照模式不是 Codex Desktop 的完整克隆，也不会增加账号或宿主能力。

客户端如实标识为 `relay_codex`，不声明尚未实现的 Desktop 身份证明和 MCP
App HTML 渲染能力。工作区依赖工具只返回已确认存在的路径，缺少运行时则明确
报告不可用。默认继续关闭 Shell 环境快照，避免将进程环境中的敏感值持久化。

适配器保留原生创建、恢复和设置通知返回的 `nativeSettings`，区分界面请求值
与原生确认值。恢复后的模型/推理设置若与 DSH 选择不同，会在下一轮正确同步。
原生服务意外退出时，正在执行的对话明确结束为失败；DSH 工具随所属轮次取消，
失效绑定上的迟到问题回复和工具结果不会被继续投递。
每轮开始前记录已有后台进程；取消时基于原生后台注册表清理本轮新增命令，
同时保留前一轮已有的后台服务。原生代码模式可能在“取消完成”之后才通知命令
启动，因此适配器保留被取消轮次的标记，继续通过原生 API 停止该轮迟到的命令；
迟到的命令、计划和 diff 通知不会把已结束的轮次重新标成运行中。清理失败明确
记录错误。该竞态修复通过了 20 次直接运行时及 6 次隔离 DSH 取消实测，但不代表
所有平台、原生版本和生命周期组合都已经通过验收。

插件会保留原生 Codex 配置或已有对话的服务档位，例如 `service_tier =
"priority"`。创建、分叉和开始新一轮时不发送 `serviceTier: null`，因为原生
App Server 将这个显式空值解释为重置到默认档位，而不是继承配置。
这不会自动为用户启用更高用量的档位；速度和用量仍由原生配置决定。

对照时需同时记录实际程序的 `--version`、模型、推理档位、权限和工具配置。
客户端名称相同不代表运行版本相同。可通过上述 `codexCommand` 在独立 DSH
profile 中指定参照程序；这不会自动升级默认捆绑运行时，也不保证其他平台兼容。

新建的原生 Codex 对话默认附加 Relay 自有的执行规范：限制工具发现和文件搜索
范围、保留命令状态和异步会话标识、并发独立检查、避免重复查询同一来源。
这不复制桌面客户端内部提示词，不改变工具授权或审批策略，也不重写已有或
导入对话的指令。可在 `relay-codex-host` 的配置中设置
`codexExecutionGuidance: false`，以单独验证运行版本的影响。

动态工具结果会保留工具名称、返回文本和明确的失败状态。HTTP 404 等负向查询
结果是否构成工具失败由来源工具决定，展示层不会把失败改成成功。

如果 Settings 显示 `CODEX_EXECUTABLE_NOT_FOUND`，请删除错误的
`codexCommand`/`RELAY_CODEX_COMMAND` 覆盖，或改为绝对路径。
`CODEX_RUNTIME_MISSING` 表示需要重新安装插件以恢复当前平台的 optional
dependency。**连接失败** 则表示已经找到可执行文件，但 App Server 初始化或
子进程运行失败。

### fork 子 Session 显示“需要重新绑定”

正常 fork 会调用 App Server `thread/fork` 并绑定返回的子 Thread。出现此状态
表示源 Thread/Turn 无法授权或完成该操作，例如 Turn 仍在运行、来源信息不完整，
或源绑定已不存在。请回到原 DSH Session 修复提示的问题后重新 Fork。插件不会
回退到全新的替代 Thread。

### 输入框不可用

DSH 在开始编码对话前必须选择工作区。点击 **Add workspace**，选择一个目录，
然后返回 **New Session**。

### 导入的 Session 提示 Codex Thread 正在被其他客户端使用

Codex 只允许一个 App Server 写入同一 Thread。在 Codex Desktop 中切换到其他
Thread 后，原 App Server 进程仍可能继续持有 writer。请完整退出或重启占用它的
Codex App、CLI 或 App Server 进程，然后在 DSH 中重试。插件会保留原有的一对一
绑定，绝不会创建替代 Thread。App Server 协议目前没有安全的强制接管操作。
打开 Session 时仍可通过 `thread/read` 同步终态展示历史；writer 所有权
只会阻止继续提交消息。

### 安装时提示找不到 pnpm

按照 pnpm 的[官方安装说明](https://pnpm.io/installation)安装，并在同一个
终端中确认 `pnpm --version` 可以执行。

### DSH 更新后插件无法启动

DSH 仍是开发者预览版本。请在
[GitHub Issue](https://github.com/yangbobo2021/relay-dsh-plugin-codex/issues)
中附上 `dsh --version` 输出、插件源码版本和启动错误。

## 开发验证

```bash
git clone https://github.com/yangbobo2021/relay-dsh-plugin-codex.git
cd relay-dsh-plugin-codex
npm install
DSH_ROOT=/path/to/deepseek-harness npm run verify
npm pack
```

`npm run verify` 会执行类型检查、测试和生产构建。边界测试仅允许中立的会话
导入中心依赖，并会阻止插件意外增加对 Relay 应用或其他功能插件的运行时依赖。

## 反馈

请通过本仓库的
[Issue Tracker](https://github.com/yangbobo2021/relay-dsh-plugin-codex/issues)
报告错误或提出功能建议。

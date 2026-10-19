# 上下文窗口选择器 · dsh-context-window-picker

在 DSH 的**模型选择弹窗**里，为**当前会话**临时切换上下文窗口大小（`contextWindow`），
与思考强度（推理等级）并列；新建会话自动恢复 Profile 默认值。

对标 WorkBuddy：模型详情面板同时展示「推理等级」+「上下文窗口」，会话级临时生效。

## 安装

```bash
git clone https://github.com/luyiheng1111/dsh-context-window-picker.git
```

然后在 DSH 的 Plugins 页面里用本地目录安装（Install from path / 本地 bundle）指向刚 clone 的目录，
或在终端：

```bash
dsh plugin --profile desktop add /path/to/dsh-context-window-picker
```

安装后重启 DSH 即可。插件本身没有构建步骤、没有运行时依赖（React 由宿主提供），
默认走 bundle patch 里的 `presets`/`completionRatio` 等默认值，无需任何配置。

## 交互

1. 打开输入框右侧的模型选择弹窗（或 `/model`）。
2. 详情面板里模型名右侧出现「上下文 1M」胶囊按钮（显示**当前生效**窗口；有覆盖时变为品牌色高亮），
   点击展开窗口选项：
   - 默认（跟随模型）
   - 128K / 256K / 512K（只列出**小于**模型默认窗口的档位）
3. 选择后立即写入当前会话；再发一条消息，`request/context` 事件中的上下文窗口即为新值。
   输入框上的模型按钮也会在覆盖生效时补一个 `· 256K` 之类的后缀。
4. 新建会话不携带该选择，自动回到适配器目录里的默认窗口。

## 为什么不是「改 Profile 配置」

`defaultContextWindow` 是适配器目录（`llm-pi-ai.providers.*.models[].contextWindow` / `llm-deepseek`）
的全局值，改它会影响所有会话。本插件只在宿主内存里按 **sessionId** 记录覆盖值，
不写任何配置文件，也不写会话日志（不污染 session log）。

## 实现要点

- **宿主半** 在 `llm` 服务的原型上包装两个公开方法（插件卸载时精确还原）：
  - `llm.prepareCall(config, signal, configure)`：通过官方 `configure` 回调收紧 `maxTokens`，
    并在返回的冻结调用对象上把 `context.contextWindow` 换成会话覆盖值。
    这一步保证 `request/context` 事件、token 计量、压缩阈值看到的是同一个窗口。
  - `llm.resolveModelInfo(provider, model)`：`compaction-basic` 通过它取窗口，
    所以压缩压力判断同样使用会话覆盖值。
- `Session#requestHeader` 在覆盖生效期间夹紧 `config.maxTokens`，
  避免压缩策略拿旧的 256K 完成预留去比新的小窗口而直接抛错。
- **客户端半** 以 `priority: -1000` 影子注册已发布的 `conversation.input.model.label` 槽位
  （`slots.inject` 保证在槽位声明后注册），菜单面板里渲染胶囊按钮，
  下拉层用 `ReactDOM.createPortal` 挂到 `document.body`（弹窗本身 `overflow:hidden`）。
- 客户端与宿主之间走本机回环 JSON 接口：
  `POST /dsh-context-window-picker/api/{state,set}`、`GET .../health`，
  请求校验 Host 为回环地址、拒绝 `sec-fetch-site: cross-site` 与非同源 `Origin`。

## 配置（bundle patch 里可改）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `presets` | `[131072, 262144, 524288, 1048576]` | 候选窗口（只显示小于模型默认值的） |
| `completionRatio` | `0.25` | 单次输出上限 ≤ 窗口 × 该比例 |
| `headroomTokens` | `65536` | 与压缩策略的 headroom 对齐，保证压缩不会因预留不足报错 |
| `minimumWindow` | `131072` | 最小可选窗口；低于它的模型只显示「默认」 |

## 文件

- `index.js` — 宿主插件（llm 拦截、按会话覆盖、回环 API）
- `client.js` — 客户端 UI（模型弹窗内的上下文窗口控件）
- `cordis.patch.yml` — bundle patch，插入宿主插件行
- `locale/{zh,en}.json` — 插件市场展示元数据

## 已验证

- 宿主：`GET /dsh-context-window-picker/api/health` 返回 patch 计数；把某会话设为 262144 后，
  下一个请求的 `request/context` 事件记录 `contextWindow: 262144`，`request/header.maxTokens`
  从 256000 收紧到 65536（压缩压力判断不再抛 `leaving no message budget`）。
- 客户端：刷新页面后模型弹窗内出现胶囊与下拉，选择即时生效；点「默认」回到 1048576。

> 修改 `index.js` 需要重启 DSH 才会重新加载宿主半边；只改 `client.js` 刷新页面即可。

## 安全说明

宿主半边通过包装 `llm` 服务原型的方法（`prepareCall` / `resolveModelInfo`）和
`Session#requestHeader` 来施加覆盖——DSH 目前没有官方的「按会话改上下文窗口」接口。
这些包装在插件卸载时精确还原。所有对客户端暴露的接口都是本机回环 JSON：

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/dsh-context-window-picker/api/state` | GET | 读取当前会话的基准窗口 / 覆盖值 / 候选档位 |
| `/dsh-context-window-picker/api/set` | POST | 设置或（传 `null`）清除本会话覆盖 |
| `/dsh-context-window-picker/api/health` | GET | patch 计数与当前配置（诊断用） |

请求会被校验：Host 必须是回环地址或 `webRuntime.trustedHosts` 中的授权域，
拒绝 `sec-fetch-site: cross-site`，且 `Origin` 必须缺失、为 `dsh-app://app` 或与 Host 同源。

## 已知限制

- 需要先打开模型选择弹窗（`placement: 'menu'`）或看输入框按钮（`'trigger'`）才会加载状态。
- 候选档位只显示**小于**模型基准窗口的值（放大窗口属于模型/Profile 层面的能力）。
- 覆盖只影响之后发出的请求；正在执行的 step 保持它启动时的窗口。
- 客户端半边影子注册了已发布的 `conversation.input.model.label` 槽位
  （`replaceRisk: shadows-shipped-ui`），若官方以后在该槽位加交互，插件需相应调整。

## 许可

[MIT](LICENSE) © 2026 luyiheng1111

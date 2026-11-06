# 依赖与第三方资产

本仓库的运行代码（`lib/`）**不引入任何第三方运行时依赖**：`lib/index.js`、
`lib/usage.js`、`lib/ledger-merge.js` 只用 Node.js 内置模块（`node:fs`、
`node:crypto`、`node:os`、`node:path`），`lib/client.js` 是手写的浏览器
bundle，直接使用宿主注入的 `react` 与 `react/jsx-runtime`。

`preview/`、`scripts/` 是**开发用的**，不属于插件运行时。

## 随仓库附带的第三方资产

这些文件是为了让 `preview/` 离线可跑而放进来的，不是本项目的代码：

| 路径 | 组件 | 版本/来源 | 许可 |
|---|---|---|---|
| `preview/react.js` | React | 生产构建 UMD | MIT |
| `preview/react-dom.js` | ReactDOM | 生产构建 UMD | MIT |
| `preview/fonts/KaTeX_*.woff2` | KaTeX 字体 | KaTeX 0.18.7 | MIT |
| `preview/fonts/montserrat-*.woff2` | Montserrat | Google Fonts | SIL OFL 1.1 |
| `preview/tokens.css` | 宿主设计令牌 + 内联 KaTeX 样式 | 提取自 DSH Web 前端 | 随 DSH |

React 与 ReactDOM 的文件头自带 `@license React ... MIT` 声明，保留原样未改动。

**关于字体**：Montserrat 采用 SIL Open Font License 1.1，允许随软件再分发；
KaTeX 字体为 MIT。这里仅作为本地预览的字体资源，不修改字体文件本身。如果你要
以商业产品形式再分发，请自行确认 OFL 的保留名称条款（不得使用 "Montserrat"
作为衍生字体名）。

**关于 `preview/tokens.css` / `theme-tokens.css`**：这两份是从 DeepSeek Harness
Web 前端提取的 CSS 变量与组件样式，用来让离线预览的外观与真实 GUI 一致。
它们不包含业务逻辑，也不含任何账号或数据。如果你的使用场景需要严格隔离，
可以删掉这两个文件并把 `preview.html` 去掉对应的 `<link>`——预览会退化成
无样式的裸页面，但插件本身不受影响（插件运行时**不加载**它们）。

## 开发依赖

`preview/` 与 `scripts/` 里的脚本会 `import` DeepSeek Harness 自身的包
（如 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-session-persistence-jsonl`）。
它们通过 `scripts/harness.mjs` 从**你本机已安装的 DSH** 解析，不随本仓库分发，
也不在 `package.json` 的 `dependencies` 里——因此克隆本仓库不需要 `npm install`
就能阅读和运行插件本体。

## 节点版本

`package.json` 声明 `node: "^22.19.0 || >=24.0.0"`，与 DSH 宿主的要求一致。

# 原创性与第三方依赖说明

本文记录本项目在**代码原创性**与**外部依赖**方面的核查结论，供使用者判断许可与
合规风险时参考。所有结论均可在仓库内复核，核查方法一并给出。

## 一、代码原创性

`lib/` 下的四个文件（`index.js`、`client.js`、`usage.js`、`ledger-merge.js`）
是本项目的实现，**不含任何来自其他项目的代码**。核查依据：

| 核查项 | 方法 | 结果 |
|---|---|---|
| 版权声明 | `grep -rniE "copyright\|SPDX\|@license\|adapted from\|ported from\|derived from" lib/` | 无任何第三方版权头或来源声明 |
| 外部 import | `grep -rn "^import\|require(" lib/*.js` | 只有 `node:*` 内置模块与项目内相对路径；`client.js` 只 `require("react")` / `react/jsx-runtime`（宿主注入） |
| 与早期同名包比对 | 下载早期曾计划使用的那个同名 npm 包解包，抽函数名与有效行比对 | 我方 64 个函数、对方 12 个，仅 `apply` 同名（DSH 插件强制入口）；行级完全相同占 **0.4%**，且全为不可避免的样板（`const name = "usage-dashboard";`、`"content-type": "application/json; charset=utf-8"`、`ctx.effect(() => ctx.webServer.register({`） |

> 关于 0.4% 的相同行：`apply` / `name` / `inject` 这三个导出是 DeepSeek Harness
> 插件协议的必填结构，任何第三方插件都只能是这个名字和形状，因此不构成实质性
> 相似。除此之外没有共享实现。

## 二、许可

本项目以 **MIT** 发布，见 [LICENSE](LICENSE)。你可以在 MIT 条款下使用、修改、
再分发、商用。

## 三、运行时依赖

**零第三方运行时依赖。** `lib/index.js`、`lib/usage.js`、`lib/ledger-merge.js`
只用 Node.js 内置模块（`node:fs`、`node:crypto`、`node:os`、`node:path`）；
`lib/client.js` 消费宿主已提供的 `react` 与 `react/jsx-runtime`，不自带 React。

## 四、读取的数据文件

插件会**读取**（不写入）以下本机文件，均为 DeepSeek Harness 或同机其他组件
留下的数据：

| 路径 | 读取目的 | 是否本项目写入 |
|---|---|---|
| 会话事件日志（`ctx.sessionPersistence` 暴露） | 统计 token 与调用次数 | 否 |
| `<DSH_HOME>/dsh-usage/usage-ledger.json` | 补充早于最早会话日志的历史用量 | 否 |

`usage-ledger.json` 由**运行在同一台机器上的其他组件**维护。本项目只按文件格式
读取其内容，不包含、也不依赖该组件的任何代码；若该文件不存在，插件跳过这一补充
来源，其余功能不受影响。

## 五、本项目的写入范围

只写自己的文件：

- `~/.dsh/dsh-usage-dashboard/statistics.json`（统计，防抖 1s 落盘）
- `<DSH_HOME>/storages/usage-dashboard-cache.json`（可重建的折叠缓存）
- `<DSH_HOME>/storages/usage-dashboard-digests.json`（校验用摘要）

不写会话存储、不写共享 ledger、不写其他组件的缓存。

## 六、文档中为何不点名其他插件

说明文档只描述**本插件自己的口径与行为**。统计规则（如「一次调用 = 一个有 usage
样本的请求」）属于技术事实，任何读取同一批会话日志的实现都会得到相同定义，因此
不需要、也不通过引用其他项目来说明。

本项目以 **`dsh-token-board`** 发布，与任何其他包均无代码、维护或授权关系。

## 七、随仓库附带的第三方资产

`preview/` 与 `scripts/` 是开发辅助，不属于插件运行时。其中 `preview/react.js`、
`preview/react-dom.js`（MIT）、`preview/fonts/KaTeX_*.woff2`（MIT）、
`preview/fonts/montserrat-*.woff2`（SIL OFL 1.1）为第三方资产，来源与许可
详见 [THIRD-PARTY.md](THIRD-PARTY.md)。

## 八、复核命令

```bash
# 无第三方版权头
grep -rniE "copyright|SPDX|@license" lib/

# 无外部包 import
grep -rn "^import" lib/*.js | grep -v '"\./\|node:'

# 与早期同名包做相似度比对（需网络；<legacy-name> 指该项目早期计划使用的名字）
npm pack <legacy-name>@0.1.0 --pack-destination /tmp
```

以上命令的输出应与本文结论一致。

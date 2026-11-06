# dsh-usage-dashboard

为 [DeepSeek Harness](https://github.com/deepseek-ai) 网页端（`dsh web`）提供 Token 用量看板的插件：它把本机会话日志折叠成日/提供商/模型三个维度的统计，在侧边栏加一个「使用统计」入口，并渲染今日、本月与所选区间的消耗卡片、3/6/12 个月热力日历、点开某天查看按来源拆分的明细（含缓存命中率）、提供商与模型排行，以及 Token 与调用次数的双轴趋势图；全部数据只来自本机、不联网不上报，插件也只写自己的统计与缓存文件。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen)](package.json)

---

## 它能回答什么

| 你想知道 | 页面在哪 |
|---|---|
| 今天花了多少 token、跑了几次 | 顶部「今日消耗」卡 |
| 这个月累计多少 | 「本月消耗」卡（不随所选区间变化） |
| 这段时间每天都用了多少 | 热力日历（3/6/12 个月，单色深浅编码 token） |
| 某一天具体花在哪个提供商/模型 | 点日历某天 → 弹出当日明细（含缓存命中率） |
| 哪个提供商/模型最费 | 「按提供商」/「按模型」页签 |
| 趋势怎么走 | 底部双指标趋势图（token 与调用次数各一条纵轴） |

## 安装

> ⚠️ **本包的 npm 名称 `dsh-usage-dashboard` 已被他人占用**
> （[zzdscs/dsh-usage-dashboard](https://github.com/1690834643/dsh-usage-dashboard)，另一个插件）。
> 所以下面一律使用 **GitHub 来源**安装，不要写裸包名。

一条命令完成安装（`dsh plugin` 会把参数转发给 pnpm，并自动登记 bundle）：

```bash
dsh plugin --profile web add "github:HTempt/dsh-usage-dashboard"
```

升级到最新提交（同一条，重跑即可）：

```bash
dsh plugin --profile web add "github:HTempt/dsh-usage-dashboard"
```

卸载：

```bash
dsh plugin --profile web remove dsh-usage-dashboard
```

Desktop 用户把 `--profile web` 换成 `--profile desktop`。装完**重启对应的 DSH Host**
（只刷新浏览器窗口不会加载新的服务端插件），然后 Ctrl+F5。

锁定到某个提交安装（避免跟随 `main` 变化）：

```bash
dsh plugin --profile web add "github:HTempt/dsh-usage-dashboard#<commit-sha>"
```

### 为什么不用 `npm` 名安装

`dsh plugin add <包名>` 默认从 npm registry 取包。本包与 npm 上同名包**不是同一个项目**，
若直接 `add dsh-usage-dashboard`，装到的是别人的插件。GitHub 来源由 pnpm 直接拉取本仓库，
不存在这个歧义。

> **若从 git 安装时报 `allowBuilds` 相关错误**：pnpm 默认阻止 git 依赖执行
> `prepare` 脚本。本包没有 `prepare` 脚本，正常情况下不会触发；万一被拦，按 pnpm
> 打印的键名把它加进 profile 的 `pnpm-workspace.yaml` → `allowBuilds` 后重跑。

### 装完应该看到什么

```bash
dsh --dump-config --profile web | grep -A1 usage-dashboard
# - id: usage-dashboard
#   name: dsh-usage-dashboard      ← 全树恰好出现 1 次
```

`dsh plugin add` 会自动把 `dsh-usage-dashboard` 写进 profile `package.json` 的
`dsh.profile.bundles`，并加进 `dependencies`；`remove` 会同时清掉两处。
**不要手工再在 profile 的 `cordis.patch.yml` 里写 insert**——注册点只有一个
（`dsh.profile.bundles`，行由本包自带的 `cordis.patch.yml` 插入）。手工重复注册会让
插件管理页的卡片读成「已关闭」而组件行显示「运行中」，因为开关只认 bundles，
组件行认 Loader 实际条目，两个字段来源不同。

### 手动安装（离线 / 开发）

```bash
git clone https://github.com/HTempt/dsh-usage-dashboard.git \
  ~/.dsh/profiles/web/local-plugins/dsh-usage-dashboard
cd ~/.dsh/profiles/web
dsh plugin --profile web add "link:./local-plugins/dsh-usage-dashboard"
```

## 它需要宿主提供什么

这是 DSH 插件，不是独立应用——**随 DSH 宿主加载**，不能 `node` 直接跑起来当服务。
宿主半声明了三个注入服务：

```js
const inject = ["webServer", "sessionPersistence", "sessions"];
```

| 服务 | 用来做什么 |
|---|---|
| `sessionPersistence` | 唯一权威：`list()` 拿 revision，`open(id,'read')` 读事件切片 |
| `sessions` | 读仍活跃会话的内存事件 |
| `webServer` | 注册两个只读 HTTP 路由 |

浏览器半声明 `dsh.client.inject`：`dsh-client-locale`、`dsh-client-ui-layout`、
`dsh-client-ui-sidebar`。

**可移植性**：`lib/` 里没有 `import` 任何 `@deepseek-ai/*` 包，只用 Node 内置模块。
所以在没有 DSH 的环境里 `import('./lib/index.js')` 也能成功（只拿到 `name`/`inject`/
`apply` 等导出，路由不会注册）；`lib/usage.js` 的 23 个纯函数可以脱离宿主单独使用或单测。

## 文档

| 文件 | 内容 |
|---|---|
| 本文件 | 安装、口径、数据模型、已知限制 |
| [THIRD-PARTY.md](THIRD-PARTY.md) | 随仓库附带的第三方资产与其许可 |
| [LICENSE](LICENSE) | MIT |

## 许可证

[MIT](LICENSE) © 2026 HTempt

---

## 页面内容

| 模块 | 说明 |
|---|---|
| 顶部指标卡 | 五张：今日消耗、**本月消耗**、所选范围消耗、累计消耗、调用次数。脚注一律写清该卡覆盖的时段与调用数，范围卡直接写区间名（「近 3 月」「近 1 年」或自选起止） |
| 每日热力图 | 每行 6 列；随区间显示 3/6/12 个月（1 年 = 2 行），每月从 1 号开始、不显示上月日期；单色深浅编码 Token 消耗 |
| 日期详情 | **点日历某天弹出对话框**：标题只有日期（不再有「日期详情」）；当日 Token 拆分、调用次数、各来源明细与**缓存命中率**（不显示占比百分比） |
| 提供商分布 | 环形图 + 占比条（仅「按提供商」页签） |
| 模型排名 | 按 Token 排名（仅「按模型」页签） |
| 双指标趋势 | Token 与调用次数各用一条独立纵轴，可 hover 查看某天 |
| 顶部导航 | 概览 / 按提供商 / 按模型 |
| 时间范围 | 近 3 月 / 近 6 月 / 近 1 年 / **自选起止日期**（最长 1 年，超出自动截断） |

### 指标卡的两个约定

- **本月 = 当前自然月的全部日期**（1 号到月末），由宿主单独计算，**不随所选范围变化**，
  所以切页签、改区间时它的数字保持稳定。它覆盖未来日期，因此月内会随使用增长。
- **数字字号分两级，按真实字宽拟合**：四张 token 卡共享同一字号（按该行最长数值拟合，
  上限 34px），调用次数卡固定为其 **0.72 倍**——token 是这个区块的主题，调用次数是
  支持数字。拟合用**实际字宽**（数字 ≈0.6em、千分位 ≈0.3em），不是"一个字符一个 em"：
  后者把 14 字符的合计当成 14em，会把本可 20.7px 的数字压到 11.5px。
  实测：5 列 20.7px / 3 列 29.5px / 单列 34px，调用次数恒小于 token 且不溢出。
  早期版本按每卡各自位数独立缩放，结果 6 位调用数显示 27px、11 位累计只有 15px，
  整行读成五个尺度——两级是这类指标带的上限。


## 关键口径（与用户约定一致）

- **调用次数 = 有 usage 样本的实际请求数**，不是消息数、不是 Token 数。
- 成功/失败来自持久事件，不做推断：`assistant/message`（带 `usage`）计 1 次成功，
  `assistant/attempt`（未产出可见消息）计 1 次失败，`llm/retry` 只计重试次数、
  不重复计调用。因此页面上能同时给出成功率与失败数。
- 全零 usage 的预热请求不计入。
- 热力图只编码 Token 消耗（调用次数的切换已移除）。

## 交互约定

- 时间范围与页签**永不因加载而禁用**：新的选择只是开始一次新读取并取消上一次，
  所以连点、来回切换都能立刻响应。
- 刷新返回相同内容时**保留原 payload 对象**，页面不再每 3 秒无谓重渲染
  （这正是此前点击被吞掉的原因）。
- 自选区间是一个小浮层（非模态），边看日历边选日期；开始/结束双向约束，
  超过 365 天给出提示并由宿主截断。

## 数据来源与统计模型

**历史只算一次，落盘后只读缓存；实时对话增量更新。** 不是每次读都重算。

`ctx.sessionPersistence` 是唯一权威来源（`list()` 拿 revision，`open(id,'read')` 读事件切片），
但读数分两条路径：

| 路径 | 何时发生 | 成本 |
|---|---|---|
| **冷启动 / 缓存缺失** | 首次有请求，后台折叠全部会话 | 一次性 ~95s / 500 余会话（并发 4），**不阻塞任何读** |
| **热启动** | 启动时从缓存恢复 | 首读 ~21ms，之后 **~10ms** |
| **实时增量** | 新会话、或日志被追加 | 只折受影响的会话 |
| **定期枚举** | 每 3 分钟（或手动刷新） | `list()` 一次；**字节数不变则不重读** |

### 一个会话只有一份折叠（单账本）

这是「今日消耗不准」的根因修复。旧实现给每个会话维护**两份**折叠：一份来自持久化日志，
一份来自 live 会话的内存增量（`liveFolds`），再把两者相加进聚合。同一批事件既已落盘、
又还在内存里，于是被加了两遍——实测该会话按小时正好是 2.00 倍：

```
2026-11-02T03  vendor-alpha/model-x  聚合 89.9M / 会话折叠 44.9M  ratio 2.00
```

现在与 `dsh-usage-stats` 0.3.7 一致：**每个 session 一份折叠 + `kind` 标记**，
标明它当前由哪个来源喂着（`live` / `persisted`）。来源切换时整份重折，
而不是把两个来源的产物叠起来。

- **live 是快路径**：会话在写入内存，折它的尾部让「今天」在每次读时都是当前值，
  代价是一次 seq 号比较，不是解码；
- **持久化是历史的权威**：定期枚举读变化的产物，并**按 id 补读**已退出 live store 的会话
  （例如结束的 sub-agent），让它的用量不等整轮扫描就进总量。

### 游标与空读取

- `consumed` 是**最后一个已折叠事件的 seq**（`-1` 表示尚未折叠）。持久化 `read(offset)`
  的偏移是**包含式**的，所以一次尾部读取总会含到游标事件本身，只应用游标之上的事件；
  旧实现把 `consumed` 当事件计数、又把 `read` 当包含式，于是每次增量都重折边界事件。
- **空读取不等于空日志**：已折叠过用量（或 `seeded` 会话）的日志读到 0 个事件时保留既有折叠，
  且**不记录 revision**，下一轮继续重试——否则真实历史会被替换成 0。
- seq 缺口、日志被重写/压缩、live↔persisted 切换：整份重折该会话。

### 并发与失败

- 持久化读取**有界并发 4**：DSH 0.1.7 首次打开一个日志要解码并校验整个文件（约 0.5 s/会话），
  顺序读大库会让一轮全量扫描耗时数分钟。
- 被后端**确定性拒绝**（`SessionFormatUnsupportedError` / `SessionPersistenceCorruptionError`）
  的日志按 `(id, revision)` 在本进程内记忆，日志变化前不再重试；**瞬时错误不记忆**，下一轮照常重试。
  每轮各汇总一条告警，且该记忆只存在于运行时、不写缓存文件。
- 聚合采用 **single-flight**，并在同一临界区原子保存缓存。

### 缓存与聚合的关系

缓存只存**逐会话折叠**；聚合是这些折叠的纯函数，每次 publish 重建。
旧实现把合并后的 `hours` 也存进缓存文件，那会成为第二个真相来源——一次部分扫描后
就可能与逐会话折叠对不上。现在删掉该文件只会触发一次重建。

### 实测（约 500 会话 / 约 230MB 的库，单账本版本）

```
冷启动首次读    9ms（返回 partial 聚合，随即后台折叠）
首次全量折叠    约 95s（并发 4，约 500 会话）
热启动首读      21ms（从缓存恢复，逐会话折叠完整）
后续读          ~10ms（仅 live 增量，无解码）
```

### 容错

- 确定性拒绝的日志（损坏/不支持的格式）**记住该 (id, revision)**，变化前不再重试；
  瞬时错误不记忆，下一轮重试；
- 日志被删 → 从逐会话折叠剔除（聚合随之重建）；
- 缓存缺失/损坏/schema 不符 → 整份忽略并从日志重建；
- 已折叠过用量的会话读到 0 个事件 → 保留折叠、不记 revision，下一轮重试。

## 写盘范围（只写自己的文件）

唯一写入是 `<DSH_HOME>/storages/usage-dashboard-cache.json`（临时文件 + rename 原子写）。
会话存储、共享 ledger、`dsh-usage-stats` 的缓存都不写。删掉该文件只会触发一次重建。

## 口径（与 dsh-usage-stats 一致）

- **调用次数** = 有 usage 样本的请求数（不计失败尝试、不计重试）；
- `failedCalls` / `retries` 另存，成功率按尝试数计算；
- 合并 `usage-ledger.json`：按 (天, 提供商家族) 取 token 较大侧、**绝不求和**，调用按模型取大；
- fork 会话按 `inheritedEventCount` 跳过继承前缀，避免父会话的用量被重算。

### 与官方插件的实测一致性（2026-11-02）

用官方 `GET /api/usage-stats/export/daily.csv` 作为基准，逐日逐模型对比：

```
窗口内 70 天，69 天完全相等；唯一差异是当天仍在写入的那一行
（dash 比 CSV 多 5.2M token / 6 calls，同一会话的后续增量，属预期）
```


## 接口

| 路径 | 查询 | 说明 |
|---|---|---|
| `/api/usage-dashboard/summary` | `days=30\|92\|365\|all`、`refresh=1` | 窗口内每日数据 + 全时段提供商/模型排名 |
| `/api/usage-dashboard/day` | `date=YYYY-MM-DD` | 单日明细 |

两者都是 `GET`，且只接受 loopback 对端（按 peer socket 判定，Host 头只作附加检查）。

请求头 `x-dsh-usage-dashboard-tz-offset`：浏览器时区偏移，**东为正**，单位秒
（客户端发 `-new Date().getTimezoneOffset() * 60`，UTC+8 → `28800`）。

> 这是**故意不用** `getTimezoneOffset` 自身符号（它在东半球为负）的约定。
> 宿主曾把两者混用：按「东为负」去减 `28800`，于是东半球每个用户的窗口末日都
> 退到**前一天**，今日那一行落在窗口外——「今日消耗」显示 0，本月卡也漏掉今天。
> `scripts/timezone.mjs` 锁死这条行为（UTC+8 / UTC / UTC-5 各验一遍）。

## 安装位置与文件要求（维护者）

安装命令见上。这里只记几条容易踩的约束：

- **注册点只有一个**：`dsh.profile.bundles`。行本身由本包自带的
  `cordis.patch.yml`（`dsh.bundle.patch`）插入
  `- id: usage-dashboard / name: dsh-usage-dashboard`。不要在 profile 自己的
  `cordis.patch.yml` 里再写一遍。
- **`cordis.patch.yml` 必须在发布内容里**：它同时出现在 `package.json` 的
  `files` 数组里。漏掉它的后果不是「少一个文件」而是**插件装不上**——
  `dsh plugin add` 会在校验阶段报
  `failed to read overlay … cordis.patch.yml` 并回滚整个安装。改动 `files`
  后请用 `npm pack --dry-run` 确认。
- **`icon.svg` 必须存在**：`package.json` 的 `"icon"` 指向它，缺文件会让插件
  管理页在卡片和组件行上各报一条「包元信息错误 … lstat … icon.svg」。
  图标必须是包目录内的相对路径、SVG/PNG/JPEG/WebP、≤ 256 KiB。
- 改 `lib/index.js` 等宿主半代码后**必须重启 `dsh web`**（HMR 只覆盖浏览器端）。

## 验证脚本

全部从插件目录直接运行（`scripts/harness.mjs` 会自行解析 harness 包所在的
`node_modules`，无需先 `cd` 到 profile，也无需软链接）：

```bash
node scripts/unit.mjs          # 纯折叠语义 5 项断言
node scripts/singleledger.mjs  # live+persisted 只计一次
node scripts/transition.mjs    # live→落盘→扫描 不变
node scripts/migrate.mjs       # v3 缓存迁移不丢历史
node scripts/timezone.mjs      # 窗口/本月跟随浏览器时区
node scripts/smoke-host.mjs    # 真实库自洽 + 重复读一致
node scripts/reconcile.mjs     # 与官方 CSV 逐日逐模型对账
```

`reconcile.mjs` 是这次修复的验收：它用真实日志跑本插件，再拿
`/api/usage-stats/export/daily.csv` 逐日逐模型比。只有「今天」允许有偏差
（会话仍在写入，报为 `DRIFT-TODAY`），其他任何一天不一致都会以非零退出。
实测结果：窗口内 70 天，**70 天全部相等**。

`smoke-host.mjs` / `reconcile.mjs` 读真实会话库，但**只写各自的 scratch home**
（`.smoke-home` / `.reconcile-home`），不会覆盖正在运行宿主的缓存。

## 结构

```
lib/usage.js        纯函数：小时折叠、日投影、行排序。可在宿主外单测。
lib/ledger-merge.js 共享 ledger 合并（与 dsh-usage-stats 同一规则）。
lib/index.js        宿主半：读持久化、插件私有缓存、聚合器、两个路由。
lib/client.js       浏览器半：手写 __ModuleLoader__ bundle（无构建步骤）。
scripts/            验证脚本（见上）；harness.mjs 负责解析 harness 包。
preview/            离线预览：直接加载 ../lib/client.js + 固定 fixture，用于看渲染。
```

`preview/` 里没有 client 副本：`loader.js` 加载的是 `../lib/client.js`，所以
改浏览器半只需改 `lib/client.js` 一处，预览与线上永远是同一份代码。

预览怎么跑：

```bash
node preview/server.mjs          # 静态服务 http://127.0.0.1:4599
# 打开 http://127.0.0.1:4599/preview.html?scene=loaded&locale=zh&tab=overview&theme=light
node preview/verify-single-source.mjs   # 无头校验：页面渲染成功且加载的就是 ../lib/client.js
```

`server.mjs` 允许 `/lib/...` 回上一级取真实包文件，其余路径仍锁在 `preview/` 内。

## 已知限制

- 不计价：只统计 Token 与调用次数，不折算金额（不同路由的定价口径不统一）。
- 不带别名合并：`vendor` 与 `vendor-ai` 这类同源路由按原始名称分别统计，不合并。
- **今天仍在写入的会话**每次刷新都会长一点：面板按读的时刻折叠内存事件，
  与官方插件差几秒就会差几条调用，这是数据在变，不是口径不一致。
- 首次全量折叠期间页面显示的是部分数据（有横幅提示）；仅首次如此，之后走缓存。
- v3 缓存迁移保留 token 与调用数，但那些「增量后又重扫」的会话
  `failedCalls` / `retries` 可能偏高几次（token 不受影响）；删掉缓存文件即精确重建。
- 日历固定锚定「今天」所在的月份，点选历史日期不会让三个月窗口滑动。
- 页面有三个页签：概览 / 按提供商 / 按模型，每个页签是独立视图，无重复卡片：
  概览 = 日历 + 趋势；按提供商 = 提供商分布；按模型 = 模型排名。
- 日期详情是模态对话框（Esc / 点遮罩 / 关闭按钮均可关闭，Tab 焦点锁定在框内），
  不再占用日历右侧的常驻栏位。标题只有日期，内容为当日拆分 + 各来源（含缓存命中率）。
- 日期详情里来源行的进度条仍表示相对大小，但**不再显示占比数字**：那是条的重复表达，
  而缓存命中率才是条无法表达、且最能解释"看着便宜"的那项信息。

## 只有一个源码目录（别再复制第二份）

这个插件**只有一份源码**，就是它自己所在的目录：

```
~/.dsh/profiles/web/local-plugins/dsh-usage-dashboard/   ← 唯一源码，宿主直接加载
```

profile 的 `package.json` 用 `link:` 指向它，`node_modules/dsh-usage-dashboard`
是指向同一位置的符号链接，所以编辑这里就等于编辑线上代码，**不需要**同步。

`~/.dsh/local-plugins/` 曾经被当成「编辑用的源」，那份目录已经不存在（现在是空的）。
不要在那里再复制一份：两份副本正是过去「改了没生效、重启后今日仍是 0」的来源。

改完的生效范围不同：

| 改了什么 | 怎么生效 |
|---|---|
| `lib/client.js` | 刷新浏览器即可（HMR 覆盖浏览器端） |
| `lib/index.js` / `lib/usage.js` / `lib/ledger-merge.js` | 必须重启 `dsh web`（宿主半） |
| `package.json` 或 `cordis.patch.yml` | 重启 `dsh web`，让组合层重新解析 |

注意**运行时数据**不在这个目录里，别混进备份：`~/.dsh/dsh-usage-dashboard/`
（`statistics.json`）和 `~/.dsh/storages/usage-dashboard-*.json` 都是数据，删掉会
按会话日志重建（慢，但不丢历史）。

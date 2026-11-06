# 更新日志

面向用户的变化记录在这里。**未发布的改动先记在「未发布」，发版时整段改成版本号**，
并同步 `package.json` 的 `version`。发布步骤见 [PUBLISHING.md](PUBLISHING.md)。

## 未发布

### 新增

- **模型行显示可读的模型名。** `qoder` / `qodercn` 两个渠道的目录键是短码
  （`dfmodel`、`qfmodel`、`gfmodel`……），日详情里原来直接显示短码，读不出是哪个模型。
  现在显示真名（`dfmodel` → `DeepSeek-Flash`、`qfmodel` → `Qwen3.8-Flash`、
  `gfmodel` → `GLM-5.3-Flash` 等），**鼠标悬停仍是原始路由 id**。
- 同一张表也用在同一页的 **分布 · 按模型**：那里保留提供商前缀
  （`qodercn/DeepSeek-Flash`），因为该列表混合了多个 provider，去掉前缀就分不清来源；
  环形图和图例同样用它，鼠标悬停仍是原始键 `qodercn/dfmodel`。
- 新增 `lib/model-names.js`：短码 → 模型名的显示表。**按提供商分开**，因为同一个
  短码在两个渠道可能指不同模型（`mmodel`：国际版 MiniMax-M3 / 中国版 MiniMax-M2.7；
  `q37fmodel`、`gm51model` 只在 CN 版；`smodel`、`cmodel`、`ultimate`、
  `performance`、`efficient` 只在国际版）。表的内容对齐渠道包
  `dsh-our-free-model/vendor/channel-pack/pack.js` 的两个模型目录
  （`QODER_FALLBACK_MODELS` / `QODER_CN_FALLBACK_MODELS`）。
- **0 消耗 + 0 调用的行不再显示。** 一条路由的请求全部失败时，它的 token 与调用都是 0，
  只有 attempts 有值，日详情里就出现一张 `0 / 0` 的提供商卡片（例如一直在失败重试的
  `qoder/dfmodel`）。现在日详情卡片与「提供商 / 模型」分布列表都跳过这类行；
  接口数据里仍保留该行，所以失败统计与 attempts 不受影响。整天没有任何有效用量时，
  日详情显示「这一天没有消耗记录」而不是一张空列表。
- README「口径」补了两条：可读模型名与 0 行的显示规则。
- **日详情新增「工作区分布」。** 对话框底部按项目列出当天花了多少：工作区名（目录末段）、
  token、占当天的比例、调用次数，最多列 6 条，其余收成「另有 N 个未列出」。
  它是一张**与上面提供商完全同款的卡片**：同样的底色、边框、圆角（10px）、内边距
  （10/12）、标题字号字重与计数胶囊（`2 个模型` ↔ `3 个工作区`）。行内版式与模型行
  也完全一致——同一条 140px 占比条、同样的数字列宽（token 64 / 占比 46 / 调用 44）、
  同样的字号与灰度，所以「某天各来源」和「某天各项目」读起来是同一张表。
  标题里**不重复 token 合计**：对话框顶部已经有当天总量，这里再说一遍只是同一数字的第三次出场；
  卡片标题下也不画汇总条——那张卡片没有「本卡片占全天多少」这个读者要看的量。
  早期历史（外部 ledger 导入的日子）没有 `cwd`，这些天只写「这一天的用量来自历史归档，
  没有工作区记录」，不猜测归属。数据来自宿主在每日行上新加的 `byWorkspace` 字段
  （summary 与 `/day` 两个接口都带）。
- **日详情顶部加了一行「资格说明」**：缓存命中率、`失败 4 / 共 2,154 次尝试`、重试次数。
  用原始比例而不是成功率：成功率四舍五入后会出现「100% · 失败 4」这种自相矛盾的组合。
  只在真有失败 / 重试时才出现，干净的天下这一行只有缓存命中率。
- **提供商卡片补上失败数**：`输入 · 输出 · 缓存读 · 失败 2`，只在该来源确有失败时追加，
  用来解释顶部那一行失败是谁造成的。

### 未变（有意保留）

- 行身份、`provider/model` 行键、排序、ledger 合并、占比、缓存命中率**全部按原始 id**，
  没有因为改名而改变任何数字。
- 表里没有的 id（渠道新增的模型、`workbuddy` / `trae` 等其它 provider）**原样显示**，
  不会因为缺映射而从面板消失。
- provider 分组标题仍是原始 id（`qodercn`、`qoder` 各一张卡片），本次不改。

### 内部

- `lib/usage.js`：`renderRows()` 给模型行附加 `name` 字段（仅在有映射时写入）。
  这是纯增量的线上字段：没有 `name` 的来源（如旧的预览 fixture）客户端仍按原始 id 显示。
- `lib/client.js`：日详情的模型行、分布 · 按模型的列表/图例改读 `name`；
  分布页的窗口聚合（客户端按天求和的那段 `windowModels`）原来只复制 `model/tokens/calls`，
  会把 `name` 丢掉，已改为一起带上。排名组件 `ModelSection` 也同步改了，
  但它目前没有挂到任何页签上（改动只是防止它被重新接入时又退回短码）。
- `lib/client.js`：新增 `hasFigure()` 谓词（`tokens > 0 || calls > 0`），日详情分组与两个
  分布列表共用；分组是遍历模型行时先过滤，所以一个 provider 的模型全被过滤掉时，
  整张提供商卡片一起消失，不用额外判空。
- `scripts/unit.mjs`：新增 7 组断言（按 provider 解析、大小写、未知码回退、
  原型键不解析、模型行带 `name`、provider 行不带、未映射行无 `name`）。
- `package.json` → `files[]` 增补 `lib/model-names.js` 与 `CHANGELOG.md`
  （漏了 `lib/model-names.js` 会发布出一个 import 失败的空包）。
- `lib/index.js`：`renderWorkspaces()` 现在可传 `dayRows`（`Map<date, rows>`），一次遍历
  同时产出窗口排行和「某天 × 某工作区」行，避免同一个工作区在两个视图里算出不同数字；
  日行在 `summaryPayload` / `dayPayload` 里挂上 `byWorkspace`（空数组 = 该天不可归因）。
- `lib/client.js`：日详情新增 `dayQualityOf()` 资格行与工作区卡片；卡片直接用
  `article.udw_providerCard`（所以在结构上不可能与提供商卡片漂移），标题行用
  `.udw_providerTop/.udw_providerName`、计数胶囊用 `.udw_providerModelCount`、
  说明文字用 `.udw_providerMeta`；只有行网格需要一条自己的规则（`.udw_dayWsList`：
  模型网格去掉提供商缩进线），单元格沿用 `.udw_modelBar / .udw_modelTokens /
  .udw_modelHit / .udw_modelCalls`，数字列宽与上面那组逐列相同。
  区块只在 `byWorkspace` 是数组时渲染：字段缺失（宿主半未更新）与「空数组」（真不可归因）
  是两件事，前者不显示该区块，后者显示说明文字。
- `scripts/smoke-host.mjs`：新增 3 条断言——每天都有 `byWorkspace` 数组、工作区行合计
  不超过当天 token（归档差额不归因）、同一天内按 token 降序。

### 验证记录（2026-11-06）

```
node scripts/unit.mjs          → usage.js unit: 15 passed, 0 failed
node scripts/check-client.mjs  → OK（id / patch name / exports / seats 全部匹配）
node scripts/smoke-host.mjs    → OK: payload is self-consistent（558 会话真实数据）
真实会话复算 2026-11-06        → qodercn/dfmodel → "DeepSeek-Flash"，
                                 300,108,383 tokens / 599 calls，与面板当日一致
headless Chrome + 真实数据预览 → 日详情只剩 4 张卡片（qodercn / workbuddy / trae /
                                 lobsterai），qoder 的 0/0 卡片消失；qodercn 行显示
                                 "DeepSeek-Flash"（title 仍是 "dfmodel"）；分布·按模型
                                 显示 "qodercn/DeepSeek-Flash"
2026-11-04 日详情（渲染实测）   → 资格行 "缓存命中 12% · 失败 1 / 共 1,587 次尝试"；
                                 trae 卡片 meta 带 "失败 1"；
                                 「工作区分布 [3 个工作区]」：.dsh 3.88亿 80% 873、
                                 novel-writing 6163万 13% 396、zy 3800万 7.8% 317；
                                 工作区卡与上方 provider 卡实测同 x/同宽/同底色/同圆角
                                 （x=178、w=722、radius 10px、padding 10px 12px），
                                 行内数字列逐列同宽：bar 140 / token 64 / 占比 46 / 调用 44
2026-08-07（仅归档的日期）      → 「工作区分布」显示"这一天的用量来自历史归档，
                                 没有工作区记录"，不出空白条
```

### 发版前还要做

1. `package.json` → `version`：`0.1.3` → `0.1.4`（本次为 patch）。
2. `npm pack --dry-run` 确认产物含 `lib/model-names.js` 与 `CHANGELOG.md`，
   且 `cordis.patch.yml` 仍在（缺它会发布成功但装不上）。加上这两份文件后是
   **17 个文件**（改动前 15 个），358.8 kB / 解包 617.8 kB。
3. 把本节内容改成 `## 0.1.4 — 2026-XX-XX`，再按 PUBLISHING.md 第 3、4 步发布与验证。
4. 客户端改动刷新浏览器即可见；宿主改动（`lib/usage.js`）需重启 `dsh web`。

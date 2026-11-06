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
- README「口径」补了一条：模型行显示可读名，但排序 / 合并 / 占比仍按原始路由 id 计算。

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
- `scripts/unit.mjs`：新增 7 组断言（按 provider 解析、大小写、未知码回退、
  原型键不解析、模型行带 `name`、provider 行不带、未映射行无 `name`）。
- `package.json` → `files[]` 增补 `lib/model-names.js` 与 `CHANGELOG.md`
  （漏了 `lib/model-names.js` 会发布出一个 import 失败的空包）。

### 验证记录（2026-11-06）

```
node scripts/unit.mjs          → usage.js unit: 15 passed, 0 failed
node scripts/check-client.mjs  → OK（id / patch name / exports / seats 全部匹配）
node scripts/smoke-host.mjs    → OK: payload is self-consistent（558 会话真实数据）
真实会话复算 2026-11-06        → qodercn/dfmodel → "DeepSeek-Flash"，
                                 300,108,383 tokens / 599 calls，与面板当日一致
headless Chrome + 真实数据预览 → 日详情 qodercn 行显示 "DeepSeek-Flash"（title 仍是
                                 "dfmodel"）；分布·按模型显示 "qodercn/DeepSeek-Flash"；
                                 workbuddy / trae / lobsterai 各行的原始 id 未受影响
```

### 发版前还要做

1. `package.json` → `version`：`0.1.3` → `0.1.4`（本次为 patch）。
2. `npm pack --dry-run` 确认产物含 `lib/model-names.js` 与 `CHANGELOG.md`，
   且 `cordis.patch.yml` 仍在（缺它会发布成功但装不上）。加上这两份文件后是
   **17 个文件**（改动前 15 个），358.8 kB / 解包 617.8 kB。
3. 把本节内容改成 `## 0.1.4 — 2026-XX-XX`，再按 PUBLISHING.md 第 3、4 步发布与验证。
4. 客户端改动刷新浏览器即可见；宿主改动（`lib/usage.js`）需重启 `dsh web`。

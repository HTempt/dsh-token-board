# 发布到 npm

包名：`dsh-token-board`（裸名，无 scope）
当前版本：`0.1.0` —— **已发布**
发布地址：https://www.npmjs.com/package/dsh-token-board

## 发布记录

2026-11-06 首次发布成功，registry 侧验证结果：

| 项 | 值 |
|---|---|
| `dist-tags.latest` | `0.1.0` |
| tarball shasum | `2f032402b00c5dbc718435d0000edac4e77861a0`（与本地 `npm publish` 输出一致） |
| license | `MIT` |
| `dsh.bundle.patch` | `./cordis.patch.yml` |
| 包大小 | 92.4 kB（解包 304.4 kB，10 个文件） |

从 registry 实装验证（不是本地文件）：

```
dsh plugin --profile web add dsh-token-board   → bundles 自动登记 dsh-token-board
dsh --dump-config --profile web                → - id: usage-dashboard / name: dsh-token-board（恰好 1 条）
import('dsh-token-board')                      → OK，inject 三服务齐全
readPluginMeta                                 → error 无、icon 1478 字节
重跑 add（升级路径）                            → Already up to date，不重复登记
remove                                          → bundles 与 dependencies 双清
```

### 关于 registry 上的 `0.0.0-stage`

发布后 registry 里会有一个 `0.0.0-stage` 版本（描述
"Temporary package placeholder for staged publishing"）。这是 npm 发布流程的
临时占位版本，`_npmUser` 就是发布者本人，比正式版早约 56 秒出现，内容是
366 字节的 `package.json` + `README.md`，**不含任何代码**。它不被 `latest`
引用，普通 `npm install dsh-token-board` 拿到的仍是 `0.1.0`，无需处理。

> 注意：npm 在发布成功后显示 "Your package is being processed and may take a
> few minutes to become available"。此时立即 `npm view` 可能**只看到占位版本**，
> 看起来像"被占用"或"发错了"。等 30–60 秒再查即可，`latest` 会指向正式版。

## 为什么叫这个名字

早期计划使用的名字在 npm 上已被注册，因此改用当前这个未被占用的裸名。

选名方法（可复现）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/<name>
# 404 = 未注册可用，200 = 已被占用
```

最终选定的 **`dsh-token-board`** 当时返回 404，发布后即为本包。命名只做了可用性
检测，不涉及任何其他包的功能或来源比较。

## 发布前已完成的准备

这些已经改好并验证过，不需要再动：

| 项 | 状态 |
|---|---|
| `package.json` → `name` | `dsh-token-board` |
| `package.json` → `private` | 已删除（`true` 会让 npm 静默拒绝发布） |
| `package.json` → `publishConfig` | `{ access: "public", registry: "https://registry.npmjs.org/" }` |
| `files[]` | 含 `cordis.patch.yml`，打包 10 个文件 |
| `cordis.patch.yml` | 行名已同步为 `dsh-token-board`（必须与包名一致，否则加载失败） |
| `LICENSE` / `THIRD-PARTY.md` | 已在打包内 |
| 打包自检 | `npm pack --dry-run` 通过，产物 `dsh-token-board-0.1.0.tgz` |

用本地 tgz 做过完整链路验证：`dsh plugin add` → bundle 自动登记 → `dsh --dump-config`
恰好 1 条 → 裸名可 `import` → 元信息（图标）可读。

## 执行步骤

### 1. 认证：token 必须带 publish 权限

`npm login` 只能证明「你是谁」，**不保证能发布**。2026-11-06 实际卡在这里：

```
npm error code E403
npm error 403 403 Forbidden - PUT https://registry.npmjs.org/dsh-token-board
npm error 403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

关键判断顺序（别被报错文案误导）：

1. 先查账号是否真的开了 2FA：
   `curl -H "Authorization: Bearer $TOKEN" https://registry.npmjs.org/-/npm/v1/user`
   → `"tfa": false` 说明**根本不是 2FA 问题**，报错文案里的 "Two-factor
   authentication **or** ..." 是并列的两种可能。
2. 再查 token 有没有写权限：拿它对一个不存在的测试名发 `PUT`，若仍报同一条
   403，就是 token 权限不足，与账号设置无关。
3. 本机那次用的是 `npm_` 前缀的 **granular access token**，创建时没勾
   **Read and write** / **Bypass 2FA**，所以必然被拒。

**正确的 token 设置**（npmjs.com → Access Tokens → Generate New Token → Granular）：

| 设置项 | 必须值 |
|---|---|
| Permissions | **Read and write** |
| Packages and scopes | `All packages`，或至少指定本包 |
| **Bypass 2FA** | ✅ 勾选（否则交互发布才会要 OTP，而 `.npmrc` 里有 token 时 npm 不弹提示，直接 403） |

写入 `.npmrc`：

```bash
npm config set //registry.npmjs.org/:_authToken "<token>"
```

> **注意**：`.npmrc` 里存了 token 时，`npm publish` **不会**再提示输入 OTP
> —— 它会直接拿这个 token 去发。所以「在终端手动发」并不会绕过权限问题，
> token 本身必须够权。这是最容易误判的地方。

`npm login` 本身仍值得跑一次（确认身份）：

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami    # 应输出你的用户名
```

裸名不需要组织/scope 权限，普通账号即可。

### 2. 在仓库目录检查

```bash
cd dsh-token-board          # 本地目录名 == 包名；GitHub 仓库名仍是 dsh-usage-dashboard
git status                 # 应为 clean，且已推送
npm pack --dry-run         # 应为 13 个文件，且含 cordis.patch.yml
```

**关键自检**：输出里必须能看到 `cordis.patch.yml`。之前 `files[]` 漏了它，
安装时 `dsh plugin add` 直接报
`failed to read overlay .../cordis.patch.yml` 并回滚整个安装。

### 3. 发布

```bash
npm publish --registry=https://registry.npmjs.org/
```

`publishConfig` 里已写死 `registry`，但**建议仍显式带上**：本机 `.npmrc` 的
默认 registry 是 `https://registry.npmmirror.com`（只读镜像），不带参数可能失败。

### 4. 验证发布结果

```bash
npm view dsh-token-board version --registry=https://registry.npmjs.org/
# 0.1.0

npm view dsh-token-board dist.tarball --registry=https://registry.npmjs.org/
```

然后在干净 profile 里试装：

```bash
DSH_HOME=/tmp/npm_e2e dsh plugin --profile web add dsh-token-board
DSH_HOME=/tmp/npm_e2e dsh --dump-config --profile web | grep -c "^- id: usage-dashboard"
# 期望 1
rm -rf /tmp/npm_e2e
```

## 后续版本

```bash
npm version patch          # 或 minor / major，会打 git tag
git push --follow-tags
npm publish --registry=https://registry.npmjs.org/
```

用户升级：

```bash
dsh plugin --profile web add dsh-token-board@latest
```

## 已知的坑

- **`private: true` 会阻止发布**：报 `This package has been marked as private
  and cannot be published`。已删除，别加回来。
- **`files[]` 必须含 `cordis.patch.yml`**：少了它包能发布但**装不上**，
  而且要等用户执行 `dsh plugin add` 才暴露。
- **`cordis.patch.yml` 里的 `name` 必须等于包名**：改包名时两处要一起改。
- **改包名后要同步本地 profile**：`dsh.profile.bundles` 与 `dependencies` 里的
  名字、以及 `node_modules` 的软链，否则组合出的条目解析不到模块
  （`MODULE_NOT_FOUND`）。改完跑 `dsh plugin --profile web install` 重建，
  并清掉旧名残留软链。
- 从 npm 安装不会有 `allowBuilds` / `prepare` 问题（那是 git 来源专有的），
  所以发布后应优先推荐 npm 安装。

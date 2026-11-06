# 发布到 npm

包名：`@htempt/dsh-usage-dashboard`
当前版本：`0.1.0`
发布地址：https://www.npmjs.com/package/@htempt/dsh-usage-dashboard

## 为什么需要你手动执行

发布用的 `registry.npmjs.org:443` 在这台机器上**连不通**（TCP 层超时，
IPv4/IPv6、直连/代理都试过；同一时刻 `api.github.com` 正常）。另外本机也没有
npm 登录凭据（`npm whoami` → `ENEEDAUTH`）。

所以下面的步骤需要在一台能访问 npm、且已登录的机器上执行。

## 发布前已完成的准备

这些已经改好并验证过，不需要再动：

| 项 | 状态 |
|---|---|
| `package.json` → `name` | `@htempt/dsh-usage-dashboard` |
| `package.json` → `private` | 已删除（`true` 会让 npm 拒绝发布） |
| `package.json` → `publishConfig` | `{ access: "public", registry: "https://registry.npmjs.org/" }`（scoped 包默认私有，必须显式 public） |
| `files[]` | 含 `cordis.patch.yml`，打包 10 个文件 |
| `cordis.patch.yml` | 行名已同步为 `@htempt/dsh-usage-dashboard`（必须与包名一致，否则加载失败） |
| `LICENSE` / `THIRD-PARTY.md` | 已在打包内 |
| 打包自检 | `npm pack --dry-run` 通过，产物 `htempt-dsh-usage-dashboard-0.1.0.tgz` |

用本地 tgz 做过完整的安装链路验证：`dsh plugin add` → bundle 自动登记 →
`dsh --dump-config` 恰好 1 条 → 包可加载 → 元信息（图标）可读。

## 执行步骤

### 1. 登录 npm

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami    # 应输出 htempt
```

需要 `@htempt` 这个 scope 下的发布权限。若是新注册的组织，确认账号已加入
`htempt` scope，否则发布会报 `E404` 或 `403`。

### 2. 在仓库目录检查

```bash
cd dsh-usage-dashboard
git status                 # 应为 clean，且已推送
npm pack --dry-run         # 确认 10 个文件、含 cordis.patch.yml
```

**关键自检**：输出里必须能看到 `cordis.patch.yml`。之前就是因为 `files[]` 漏了它，
安装时 `dsh plugin add` 直接报
`failed to read overlay .../cordis.patch.yml` 并回滚整个安装。

### 3. 发布

```bash
npm publish --access public --registry=https://registry.npmjs.org/
```

`publishConfig` 里已写死 `registry` 和 `access`，所以 `npm publish` 不带参数
也会走官方源并公开。但**冗余写一次更保险**，避免本机 `.npmrc` 把
`registry` 指向 npmmirror（这台机器的默认值就是 `https://registry.npmmirror.com`，
而镜像是只读的，直接 `npm publish` 会失败）。

### 4. 验证发布结果

```bash
npm view @htempt/dsh-usage-dashboard version --registry=https://registry.npmjs.org/
# 0.1.0

npm view @htempt/dsh-usage-dashboard dist.tarball --registry=https://registry.npmjs.org/
```

然后在一个干净的 profile 里试装：

```bash
DSH_HOME=/tmp/npm_e2e dsh plugin --profile web add "@htempt/dsh-usage-dashboard"
DSH_HOME=/tmp/npm_e2e dsh --dump-config --profile web | grep -c "name: '@htempt/dsh-usage-dashboard'"
# 期望 1
rm -rf /tmp/npm_e2e
```

## 后续版本

版本号遵循语义化版本，发布新版本：

```bash
npm version patch          # 或 minor / major，会打 git tag
git push --follow-tags
npm publish --access public --registry=https://registry.npmjs.org/
```

用户侧升级：

```bash
dsh plugin --profile web add "@htempt/dsh-usage-dashboard@latest"
```

## 已知的坑

- **不要用裸包名**：`dsh-usage-dashboard` 在 npm 上属于另一作者的无关插件
  （[zzdscs/dsh-usage-dashboard](https://github.com/1690834643/dsh-usage-dashboard)）。
  必须带 `@htempt/` scope。
- **`private: true` 会静默阻止发布**：报错是 `This package has been marked as
  private and cannot be published`。已删除，后续别加回来。
- **`files[]` 必须含 `cordis.patch.yml`**：少了它包能发布但装不上，
  而且要到用户执行 `dsh plugin add` 时才暴露。
- **`cordis.patch.yml` 里的 `name` 必须等于包名**：改成 scoped 后不同步，
  加载期会找不到模块。
- 从 npm 装不会有 `allowBuilds` / `prepare` 问题（那是 git 来源专有的），
  所以发布后应优先推荐 npm 安装。

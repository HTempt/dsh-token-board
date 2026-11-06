# AGENTS.md — 本仓库的协作约定

给在这个仓库里干活的助手看。**默认只动本地，不发不推**。

## 默认允许

- 读代码、改代码、写文档、跑测试与预览验证。
- `git commit`（**仅本地**）：改完就提交，让改动可 review、可回退。
- 打本地备份（`~/.dsh/dsh-token-board-备份-*`）这类你自己的保险动作。

## 必须先得到明确指令

| 动作 | 触发条件 |
|---|---|
| `git push`（含 tag） | 用户明确说「推送远程」 |
| `npm publish` | 用户明确说「发布 / 更新 npm」 |
| 改 `package.json` 的 `version` | 与发布同一条指令里一起做，不提前 bump |
| 建 GitHub Release / 传附件 | 与发布同一条指令 |
| 删用户的备份或历史数据 | 用户明确说删 |

用户说「下次一起发」时**不要**顺手发；停在「本地已提交、远端未动」。

## 发布时怎么做

完整步骤见 [PUBLISHING.md](PUBLISHING.md)，要点：

- 版本号要同时改 `package.json` 与 **README 的 5 处**（当前版本行 + 4 个安装示例），
  自检 `grep -n "0\.1\.[0-9]" README.md`。
- CHANGELOG 的「未发布」整段改成版本号，并在发版记录里写清验证结果。
- 本机环境：`git push` 需走代理 `-c http.proxy=http://127.0.0.1:7897`；
  npm 默认 registry 是 npmmirror，发布必须显式 `--registry=https://registry.npmjs.org/`。
- 发完核三样：远端 HEAD、tag、`registry.npmjs.org/dsh-token-board/latest` 的版本与 shasum。

## 没有凭据时

`gh` 没装；GitHub API 用仓库已存的 git 凭据（`git credential fill`）调，
**不要把 token 打印到终端或写进任何文件**。

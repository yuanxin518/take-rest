# 订阅分支模板（对应 take-rest 的 `packs` 分支）

> 正式订阅源：**https://github.com/yuanxin518/take-rest**
> 分支约定：`main` 放代码，`packs` 放动作包。下面的地址都可以在面板里直接粘。

| 订阅内容 | 粘贴地址 |
|---|---|
| 整个仓库（自动找到 `packs` 分支） | `https://github.com/yuanxin518/take-rest` |
| 锁定 `packs` 分支（推荐） | `https://raw.githubusercontent.com/yuanxin518/take-rest/packs/manifest.json` |

## 这个目录是什么

本目录是 `packs` 分支内容的本地副本，也是给别人复用的模板：一个 `manifest.json` + 若干 `packs/*.json`。

## 分支怎么被绑定

- 粘**仓库地址**：先试 `HEAD / main / master`，都没有 `manifest.json` 就去问 GitHub API 有哪些分支，逐个分支找；找到后提示「动作包分支：packs」，订阅源地址记成该分支的 raw 地址。
- 粘 **raw 地址**：分支就是 URL 里那一段，不再探测。
- API 被限流或断网：退回常见分支名（`packs` / `data` / `actions`）再试一轮，仍失败才报错，报错里会说明「所有分支里都没找到 manifest.json」。

## 加动作

在 `packs/` 下新建 JSON → 相对路径写进 `manifest.json` 的 `packs` 数组 → 推到 `packs` 分支 → 面板点「立即同步」（或等 6 小时自动同步）。

动作包格式见 [packs 分支的 README](https://github.com/yuanxin518/take-rest/blob/packs/README.md)。

## 注意

- 只支持**公开仓库**：软件不带 token，私有仓库拉不到。
- 本机实测：`raw.githubusercontent.com` 直连时好时坏，`github.com` 的 git 通道基本必须走代理。软件已内置「直连失败自动改用系统代理」的回退，不用手动配。
- 同 `id` 的动作：订阅包优先于软件内置包（订阅是权威源）。

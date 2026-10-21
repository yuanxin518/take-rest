# 动作包分支（packs）

这个分支**只放动作包数据**，软件代码在 `main` 分支。

## 怎么用

在「站立提醒」面板 → 订阅 → 粘贴以下任一地址：

| 订阅内容 | 粘贴地址 |
|---|---|
| 这个仓库（自动找到 packs 分支） | `https://github.com/yuanxin518/take-rest` |
| 锁定 packs 分支（推荐，地址不会随默认分支变） | `https://raw.githubusercontent.com/yuanxin518/take-rest/packs/manifest.json` |

软件粘贴仓库地址时，如果默认分支（main）上没有 `manifest.json`，会自动去别的分支里找，找到后记下「动作包分支：packs」。

## 目录约定

```
manifest.json          订阅清单
packs/
  工位五连环.json        5 个工位微动作（坐姿踮脚/蹬自行车/腹式深呼吸/肩胛骨夹紧/坐着扭腰）
  加练-站立版.json       同一套动作的站立变体（站立提踵等）
```

## 加动作

1. 在 `packs/` 下新建一个 JSON，格式见下。
2. 把相对路径写进 `manifest.json` 的 `packs` 数组。
3. 推到本分支。
4. 软件面板里对该订阅点「立即同步」（或等 6 小时自动同步）。

## 动作包格式（v1）

```json
{
  "format": "gongwei-tixing-pack/1",
  "id": "my-pack",
  "name": "我的动作包",
  "version": "1.0.0",
  "description": "一句话说明",
  "categories": [
    {
      "id": "body", "name": "身体", "order": 1,
      "parts": [
        {
          "id": "calf", "name": "小腿", "order": 1,
          "moves": [
            {
              "id": "my-calf-raise",
              "level": "静音",
              "name": "坐姿踮脚",
              "order": 1,
              "prompt": "坐姿踮脚 · 脚平踩用力踮脚尖，停 2 秒重重放下 · 连做 20 个",
              "dosage": "连续做 20 个",
              "durationSec": 40,
              "tags": ["下肢泵血"]
            }
          ]
        }
      ]
    }
  ]
}
```

- 三级结构：`类别 → 部位 → 幅度档位（level）→ 动作`，首版档位只有 `静音`（`轻响` / `震动` 预留）。
- `prompt` 就是任务栏上弹出来的那一行字，建议 40 字内，用 ` · ` 分成「动作 · 要领 · 数量」。
- `durationSec` 决定提醒条停留秒数（面板里「弹出停留」填 0 时用它）。
- 跨包的 `id` 不能重复，重复时以后装的那个为准。

# cortico-world-proactive（主动想念）

给 [Coopanion](https://github.com/Pal-AI-Lab/Cortico) 桌宠加一层「它会想你」的机制：

安静一段时间后，按一个**随沉默时长递增的概率**，宠物的脑子里会冒出一个「内心想法」；要不要真的来找你聊天，由它自己决定。**不是命令模型去发消息**，而是像人一样先想起你。

## 机制

- 计时从**上一次和主人聊天**开始（桌面宠物的对话、QQ/Telegram 里主人发的消息都算；宠物自己说的话也算「聊过了」）
- 安静满 `idleMinutes`（默认 30）分钟后开始尝试
- 初始概率 `initialChance`（默认 10%），每多安静 `stepMinutes`（默认 10）分钟加 `stepChance`（默认 10%），封顶 `maxChance`（默认 80%）
- 每个 10 分钟档位只掷一次，不中不重复掷，等下一档
- 掷中后推一条 `proactive.thought` 事件，内容形如：

  ```
  内心想法：已经有一阵没和主人说话了。要不要凑过去看看，还是先别打扰？
  ```

- 模型决定来找你（说了话）→ 进入宽限：等 `graceMinutes`（默认 10）分钟
  - 你回了 → 计时归零、概率回到初始值
  - 你没回 → 安静计时**退回它开口之前**，概率保持不动，下一次的内心想法会多一句「之前好像找过，但是没有回复，要不要换一种方式」
- 你主动找它 → 计时归零、概率回到初始值，之前没回应的记录也清掉
- 模型没理这个念头 → 下个档位概率继续涨，想法也越来越强
- **休息时间段**内完全静默：不掷概率、不推想法；休息结束的那一刻，计时从 0 开始、概率回到初始值（之前没回应的记录也清掉）

## 休息时间段

`restWindows` 填 `HH:MM-HH:MM`，多个用逗号或分号分隔，支持跨午夜：

```
23:00-07:00
23:00-07:00, 12:00-13:30
```

- 在窗口内：计时照走但**不会触发**，也不推任何想法
- 窗口结束后的第一次检查：计时归零、概率回初始值（等于「刚聊过」重新开始）
- 留空 = 不休息

## 档位与提示词

内置四档（30 / 60 / 120 / 240 分钟），每档两句话，触发时随机选一句；`{owner}` 会替换成配置的称呼。

可以在设置里用 `levelsJson` 覆盖：

```json
[
  { "afterMinutes": 30,  "thoughts": ["第一句 {owner}", "第二句 {owner}"] },
  { "afterMinutes": 120, "thoughts": ["第三句 {owner}", "第四句 {owner}"] }
]
```

留空用内置四档；JSON 写坏了也会回落到内置。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `worlds.proactive.enabled` | `true` | 总开关 |
| `worlds.proactive.ownerName` | `主人` | 内心想法里对主人的称呼 |
| `worlds.proactive.idleMinutes` | `30` | 安静多少分钟后开始尝试 |
| `worlds.proactive.stepMinutes` | `10` | 每过多少分钟涨一次概率 |
| `worlds.proactive.initialChance` | `10` | 初始概率（%） |
| `worlds.proactive.stepChance` | `10` | 每次增加（%） |
| `worlds.proactive.maxChance` | `80` | 概率上限（%） |
| `worlds.proactive.restWindows` | 空 | 休息时间段，`23:00-07:00, 12:00-13:00`；支持跨午夜 |
| `worlds.proactive.graceMinutes` | `10` | 找过但没回复的宽限（分钟），过期就退回计时、概率不降 |
| `worlds.proactive.levelsJson` | 空 | 档位与提示词覆盖，见上 |

状态（上次聊天时间、已掷到第几档）保存在部署数据目录的 `proactive-state.json`，重启不丢。

## 安装

```powershell
# <data> 是 Coopanion 的数据目录：%LOCALAPPDATA%\Coopanion\data-location.json 里的 "data"
cd "<data>\extensions"
pnpm add link:"<本仓库的绝对路径>"
```

在 `<data>\home\companion\config.json` 的 `worlds` 里加：

```json
"proactive": { "enabled": true }
```

完全退出 Coopanion 再打开，日志里会出现：

```
proactive: 已启动，主人称呼=主人，上次聊天 …
```

## 开发

```bash
node test/run.mjs
```

测试覆盖：概率递增与封顶、档位选择、两句话随机、坏 JSON 回落、同一档位不重复触发、宽限期内没回复退回计时并补「之前找过」的独白、回复后归零、状态持久化。

## 许可

MIT。社区扩展，与 Coopanion / Pal AI Lab 官方无关。

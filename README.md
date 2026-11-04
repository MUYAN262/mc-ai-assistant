# 小把罢 · Minecraft 基岩版 AI 助手

给基岩版服务器（LeviLamina + LegacyScriptEngine）用的 AI 助手插件：一个会走路、会聊天、能改名、**不会作弊**的模拟玩家；附送一个 QQ 群版本，让群里的消息也有人接。

> 名字里的「小把罢」只是默认值，`/ai 改名 <新名字>` 可以改成任意名字。

```
玩家:  小把罢 过来
小把罢: 来了来了
玩家:  小把罢 给我 64 个钻石块
小把罢: 我要有那本事早给自己囤一箱了，可惜只会动嘴
```

## 两个形态

| 形态 | 位置 | 说明 |
|---|---|---|
| **游戏内助手**（本仓库主体） | `plugin/` | LSE nodejs 插件，用 `mc.spawnSimulatedPlayer` 造一个模拟玩家，能走位、能聊天、能改名 |
| **QQ 群助手** | `qqmcbridge-mod/` | QQMCBridge 子插件，让机器人在群里回话，带知识库和 FAQ |

## 特性

- **付费服务**：`/ai 购买 <分钟>`，默认 20 金币/分钟、最少 10 分钟，扣费走服务器经济插件
- **常驻公共助手**：不买也能聊天、也能指挥它走位；重启、掉线会自动补位
- **会走路**：`过来` / `去 x y z` / `跟随` / `停下` / `跳` / `看向我`，带距离上限和卡住检测
- **会聊天**：接入任意 OpenAI 兼容接口（本地 wb-proxy、官方 API、自建网关都行）
- **能改名**：`/ai 改名 <新名字>` 或聊天里说「小把罢 改名 小蓝」，名字存本地，重启不丢
- **不会作弊**：动作白名单 + 只读播报 + 审计日志，见 [反作弊设计](docs/反作弊与安全.md)

## 安装

### 依赖

- BDS 1.26.x（本项目在 1.26.51 上验证）
- [LeviLamina](https://github.com/LiteLDev/LeviLamina) 26.51.x
- [LegacyScriptEngine](https://github.com/LiteLDev/LegacyScriptEngine) 的 **nodejs** 引擎（`legacy-script-engine-nodejs`）

### 步骤

1. 把 `plugin/` 整个目录复制到服务器的 `plugins/ai-assistant/`
2. 复制 `plugin/config.example.json` 为 `config.json`，按需修改
3. 把模型密钥写进 `plugins/ai-assistant/llm.key`（一行，纯文本，不要引号）
4. 重启服务器（LSE 没有配置热重载）

详细步骤和排错见 [部署文档](docs/部署.md)。

## 配置速查

```jsonc
{
  "assistantName": "小把罢",        // 默认名字
  "llm": {
    "url": "http://127.0.0.1:8788/v1/chat/completions",  // OpenAI 兼容接口
    "keyFile": "plugins/ai-assistant/llm.key",
    "model": "deepseek-v4.1-flash",
    "timeoutMs": 45000,
    "maxTokens": 400
  },
  "price":  { "perMinute": 20, "minMinutes": 10, "maxMinutes": 240, "currency": "金币" },
  "limits": { "chatPer10Min": 20, "maxAssistants": 3, "maxMoveDistance": 48, "moveSpeed": 0.9 },
  "resident": {
    "enabled": true,      // 常驻公共助手
    "name": "小把罢",
    "freeChat": true,     // 不买也能聊
    "allowMove": true,    // 不买也能指挥
    "chatPer10Min": 12,
    "spawn": { "x": 394, "y": 128, "z": 1942, "dim": 0 }
  },
  "triggers": ["小把罢", "@小把罢", "小鲸", "!ai"]
}
```

## 命令

玩家（`PermType.Any`）：

| 命令 | 作用 |
|---|---|
| `/ai 购买 <分钟>` | 买服务时长 |
| `/ai 召唤` | 把助手叫到身边 |
| `/ai 过来` | 让它走到你身边 |
| `/ai 去 <x> <y> <z>` | 走到坐标（最远 48 格） |
| `/ai 跟随` / `/ai 停下` | 跟随 / 原地待命 |
| `/ai 跳` / `/ai 看向我` | 小动作 |
| `/ai 改名 <新名字>` | 给专属助手改名（1-8 字） |
| `/ai 剩余` / `/ai 离开` | 剩余时间 / 让它走 |

管理员（`PermType.GameMasters`）：

| 命令 | 作用 |
|---|---|
| `aiadmin status` | 在线助手数、付费玩家数、key 状态 |
| `aiadmin grant <玩家> [分钟]` | 加时长（默认 30 分钟） |
| `aiadmin spawn <玩家>` / `aiadmin dismiss <玩家>` | 召唤 / 解散 |
| `aiadmin rename <新名字>` | 给常驻助手改名（**控制台不能输中文**，中文名请用游戏内或改 `data/names.json`） |
| `aiadmin selftest` | 自检：key、白名单、代码里有没有危险调用、扣费逻辑 |

聊天里也能用：`小把罢 购买 30`、`小把罢 改名 小蓝`、`小把罢 过来`、`小把罢 怎么做下界合金`。

## 数据文件

| 文件 | 内容 |
|---|---|
| `data/service.json` | 每个玩家的服务到期时间、买过多少、助手名字 |
| `data/names.json` | 自定义名字（`{"resident": "小把罢", "players": {"<xuid>": "小蓝"}}`） |
| `logs/audit.log` | 审计日志：召唤、移动、改名、扣费、被拦截的动作 |

`data/` 和 `logs/` 都不该进版本库，`.gitignore` 已经排除。

## QQ 群版本

`qqmcbridge-mod/` 是给 [QQMCBridge](https://github.com/) 用的子插件（需要机器人本体），支持：

- 群里 @ 或叫名字就回话，带服务器知识库 `knowledge.md` 和 12 条 FAQ
- 本地只读命令：`帮助`、`在线`、`状态`、`时间`、`余额`、`查 <玩家>`、`公告 <文本>`（管理员）
- `chatty` 模式：群里有人说话、游戏里有人说话、有人进出服，它会主动接一句

配置里的 `api_key` 留空，密钥放 `llm.key` 或机器人侧的 `settings.api`。

## 已知限制

- **没有寻路**：`simulateMoveTo` 是直线移动，遇到墙只会跳一下，卡 14 秒就放弃并告诉你「被挡住了」
- **改名要重建实体**：模拟玩家的名字在生成时写死，所以改名是「断开旧的、原地生成新的」
- `mc.getSpawnPoint()` 在 LSE 0.22.4 里不存在，常驻助手用配置里的坐标兜底
- 助手占一个玩家位，会触发进服/退服播报
- 离线客户端 `xuid` 为空，余额和改名会退化用名字匹配

## 文档

- [部署文档](docs/部署.md)
- [命令速查](docs/命令速查.md)
- [反作弊与安全](docs/反作弊与安全.md)
- [常见问题](docs/FAQ.md)
- [变更记录](CHANGELOG.md)

## 许可

MIT，见 [LICENSE](LICENSE)。

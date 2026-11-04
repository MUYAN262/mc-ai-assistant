# 常见问题

## 助手没出现

**先看审计日志** `plugins/ai-assistant/logs/audit.log`，插件加载成功一定有这一行：

```
[START] ai-assistant v1.2.0 已加载：...
```

- 没有 `[START]` → 插件没加载。检查 `manifest.json` 里的 `entry` 是否指向 `ai-assistant.js`，
  以及服务器日志里有没有 `ai-assistant` 的报错。
- 有 `[START]` 但没有 `[RESIDENT] 已就位` → 出生点定位失败。LSE 0.22.4 没有 `mc.getSpawnPoint()`，
  请在有玩家在线时重启，或在 `config.json` 里写死 `resident.spawn`。
- 都没有，但玩家 `/ai 召唤` 报「需要购买」→ 先 `/ai 购买 10`，或把 `resident.enabled` 设为 true。

## 助手不动 / 只抖一下

`simulateMoveTo` 是**直线移动，没有寻路**。目标在墙后面时会卡住，插件的处理是：

1. 连续 5 秒没位移 → `simulateJump()` 试着跳过去
2. 14 秒还没动 → 放弃，并告诉你「被挡住了，走不到那里」

需要跨地形的话，把目标点设在开阔地，或分几段走。

## `Wrong type of argument!`（simulateMoveTo）

LSE 0.22.4 的 `simulateMoveTo` 只接受 **FloatPos 对象**，而且：

- `new FloatPos(x,y,z)` → `can't create class FloatPos`（nodejs 引擎没有这个全局类）
- `mc.newFloatPos(x,y,z,dim)` → `Wrong type of argument!` / `Too Few arguments!`
- `sp.simulateMoveTo(x, y, z)` → `Wrong type of argument!`

唯一可行的写法是**复制 API 返回的对象再改字段**：

```js
const fp = sp.pos;   // FloatPos 对象
fp.x = tx; fp.y = ty; fp.z = tz;
sp.simulateMoveTo(fp);   // true
```

插件里的 `moveToPos()` 就是这么做的。

## 改名没生效

- 模拟玩家的名字在生成时写死，改名 = 断开旧实体 + 原地生成新实体（会有一瞬间进服/退服播报）
- **控制台不能输中文**：`aiadmin rename 小蓝` 会写成 `??`。中文名用游戏内 `/ai 改名 小蓝`，
  或直接改 `data/names.json` 后重启
- 名字限制 1-8 字，不能纯数字，不能带 `§`、引号、斜杠、尖括号

## 扣费不生效 / 余额读不到

插件按顺序找经济接口：

1. `player.getMoney()` / `player.reduceMoney(n)`
2. `ll.import('LLMoney', 'LLMoney_Get' / 'LLMoney_Reduce')`

都没有就会报「读取不到你的余额」。注意 `ll.import` 找不到导出时会**抛异常**，
所以代码里先用 `ll.hasExported` 预检。

另外：离线客户端（假人）`xuid` 为空，余额和名字会退回用玩家名匹配。

## 模型返回空 / 401

- `401 invalid api key` → `llm.key` 没读到。检查路径、文件编码（UTF-8 无 BOM）、有没有多余引号
- 返回空字符串 → 可能是 reasoning 模型把 token 花在思考上，把 `maxTokens` 调到 400 以上
- 超时 → 调 `llm.timeoutMs`（默认 45000），或换更快的模型

## 重启服务器后助手不见了

常驻助手在插件加载 8 秒后自动召唤，之后每 30 秒自检一次、有人进服时再检查一次。
如果一直没回来，看审计日志里有没有 `[RESIDENT] 召唤失败`，通常是出生点被方块占了或者维度不对。

## 服务器提示「达到自动重启最大次数上限」

这是 MCSM 的限制（`autoRestartMaxTimes: 3`），不是插件的问题。手动杀进程次数多了就会触发，
需要重启 MCSM 守护进程才会恢复 autoStart。

# 小把罢 AI 助手（QQMCBridge 子插件）

群聊问答 + 知识库/FAQ + 游戏内主动接话。模型走 OpenAI 兼容接口，**API 位置全部预留成配置项**，本机想用 wb-proxy 直接改两行就行。

---

## 一、填 API 的位置（三种，优先级从高到低）

### 1. 密钥写文件（推荐，`api.key`）

`config.json` 里 `api.api_key_file` 指向的文本文件，一行密钥、不要引号：

```
plugins/QQMCBridge/mods/ai-assistant/api.key
```

现在这个文件里已经有本机 wb-proxy 的密钥，所以开箱可用。

### 2. 密钥写 `config.json`（`api.api_key`）

```json
"api": {
  "provider": "wb-proxy",
  "base_url": "http://127.0.0.1:8788/v1",
  "model": "deepseek-v4.1-flash",
  "api_key": "在这里填你的 key",
  "api_key_file": "plugins/QQMCBridge/mods/ai-assistant/api.key",
  "timeout": 45
}
```

`api.api_key` 非空时优先用它，`api_key_file` 就不看了。

### 3. 全机器人共用一份（机器人 `config.json`）

`C:\Users\Administrator\Desktop\这里面才是真正的机器人脚本！！！！！！！！！！！！！！！！！\python-adapter\config.json`：

```json
"openai_base_url": "http://127.0.0.1:8788/v1",
"openai_model": "deepseek-v4.1-flash",
"openai_api_key": "",
```

子插件没填 key 时会退到这三个全局键。

---

## 二、三种常见配置抄作业

| 用途 | provider | base_url | model | 密钥 |
|---|---|---|---|---|
| 本机 wb-proxy | `wb-proxy` | `http://127.0.0.1:8788/v1` | `deepseek-v4.1-flash` | 本机 wb-proxy 的 key（`wb-...`） |
| DeepSeek 官方 | `openai` | `https://api.deepseek.com/v1` | `deepseek-chat` | `sk-...` |
| 任意 OpenAI 兼容（OneAPI/NewAPI 等） | `custom` | 你自己的 `https://xxx/v1` | 服务商给的模型名 | 服务商给的 key |

注意 `base_url` **不要**带 `/chat/completions`，程序自己会拼。

---

## 三、其它可调项（`config.json` 的 `settings`）

| 键 | 说明 | 默认 |
|---|---|---|
| `mode` | `chatty` 活跃 / `smart` 只答问 / `half` 只答被叫的 / `off` 关闭 | `chatty` |
| `chatterChance` | 群闲聊被接话的概率 | `0.35` |
| `groupCooldown` | 群闲聊最短间隔（秒） | `60` |
| `gameCooldown` | 游戏内事件最短间隔（秒） | `25` |
| `chatLineChance` | 游戏内聊天被接话的概率 | `0.4` |
| `joinLine` / `leaveLine` | 进服/退服要不要来一句 | `true` |
| `triggers` | 触发词，逗号分隔 | `小把罢,@小把罢,!,！` |
| `kb_path` / `faq_path` | 知识库 / 精确问答文件 | 同目录 |

改完保存即可，**下一条群消息就会热重载**，不用重启服务端。

---

## 四、工作原理（为什么 mod 里看不到 http 请求）

LSE 的 nodejs 子插件运行环境里 `require('http')` 不可用，所以本插件不发网络请求，只做三件事：

1. 命中 FAQ / 本地只读命令 → 直接返回文字（0 token）；
2. 需要模型 → 把 `__QQMC_AI_PLUGIN__:` + JSON 交给机器人（python 侧）去请求模型；
3. 游戏内事件（进服/退服/聊天）和群闲聊 → 把 `__QQMC_AI_SAY__:` + JSON 交给机器人，生成一句短话再发群。

所以 **机器人必须在跑**，模型回复才出得来；机器人不在时，进服/退服会退回内置模板句。

---

## 五、文件说明

| 文件 | 作用 |
|---|---|
| `ai-assistant.js` | 主逻辑（钩子注册、FAQ、命令、协议下发） |
| `config.json` | 配置（含 `api` 段） |
| `api.key` | 模型密钥（一行，不进 JSON） |
| `knowledge.md` | 服务器知识库，注入到 system prompt |
| `faq.json` | 精确问答（正则匹配，命中秒回） |
| `data.json` | 运行期状态（冷却时间戳等） |

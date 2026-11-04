// 小鲸 AI 助手 · QQ 群 + 游戏内活跃版 v2.1.0
// - 群里被叫到/问到必答：知识库 knowledge.md + 精确问答 faq.json + 本地只读查询
// - 活跃模式（chatty）：群里有人说话、游戏里有人说话、有人进出服，都会主动接一句
// - 主动接话直接调本机模型（异步 HTTP，不卡服务器 tick），失败时回落到内置模板
// - 管理员：小鲸 公告 <文本> 广播到游戏内

const PROTO = "__QQMC_AI_PLUGIN__:"
const SAY_PROTO = "__QQMC_AI_SAY__:"
const MOD_DIR = "plugins/QQMCBridge/mods/ai-assistant/"
const DEFAULT_KB = MOD_DIR + "knowledge.md"
const DEFAULT_FAQ = MOD_DIR + "faq.json"

module.exports.name = "小鲸 AI 助手（群 + 知识库 + 活跃）"
module.exports.version = "2.2.0"
module.exports.description = "群里问答 + 游戏内主动接话；知识库/FAQ 命中秒回，其余交给模型。"
module.exports.help = "群里发「小鲸 服务器地址」或 @机器人；活跃模式下有人说话/进出服会自己接一句。"
module.exports.allowWithoutMention = true

module.exports.settingsSchema = [
  { key: "enabled", label: "启用 AI", type: "boolean", default: true },
  { key: "mode", label: "回复模式", type: "select", default: "chatty", options: ["chatty", "smart", "full", "half", "off"] },
  { key: "model", label: "模型", type: "string", default: "deepseek-v4.1-flash" },
  { key: "base_url", label: "OpenAI 兼容 Base URL", type: "string", default: "http://127.0.0.1:8788/v1" },
  { key: "api_key", label: "API Key（留空则读 api_key_file）", type: "password", default: "" },
  { key: "api_key_file", label: "API Key 文件路径", type: "string", default: "plugins/QQMCBridge/mods/ai-assistant/api.key" },
  { key: "timeout", label: "请求超时秒", type: "number", default: 45 },
  { key: "max_tokens", label: "最大 Tokens", type: "number", default: 500 },
  { key: "chatterChance", label: "群闲聊接话概率(0-1)", type: "number", default: 0.35 },
  { key: "groupCooldown", label: "群接话冷却(秒)", type: "number", default: 60 },
  { key: "gameCooldown", label: "游戏内接话冷却(秒)", type: "number", default: 25 },
  { key: "chatLineChance", label: "游戏内闲聊接话概率(0-1)", type: "number", default: 0.4 },
  { key: "joinLine", label: "有人进服就说一句", type: "boolean", default: true },
  { key: "leaveLine", label: "有人退服就说一句", type: "boolean", default: true },
  { key: "kb_path", label: "知识库文件", type: "string", default: DEFAULT_KB },
  { key: "faq_path", label: "FAQ 文件", type: "string", default: DEFAULT_FAQ },
  { key: "triggers", label: "触发词（逗号分隔）", type: "string", default: "小鲸,@小鲸,!" },
  { key: "system_prompt", label: "系统提示词", type: "textarea", default: "你是「星辰」Minecraft 基岩版服务器的群助手小鲸。用简短自然的中文回答，最多 3 行，不用 markdown。只答服务器/游戏/群务相关；不确定就说「这个我不确定，问一下服主」。绝不编造人数、TPS、价格、地址等数据。不需要回复时只输出 [NO_REPLY]。" }
]

// ---------------- 通用工具 ----------------

function logw (msg) {
  try {
    if (typeof logger !== "undefined" && logger && logger.warn) logger.warn(msg)
  } catch (e) {}
}

function readText (path, fallback) {
  try {
    const t = File.readFrom(path)
    if (t && String(t).trim()) return String(t)
  } catch (e) {}
  return fallback || ""
}

function stripAt (text) {
  let t = String(text || "")
  t = t.replace(/\[CQ:at,[^\]]*\]/g, " ")
  t = t.replace(/^[\s@]+/, " ")
  t = t.replace(/^<@[^>]*>\s*/g, "")
  return t.replace(/\s+/g, " ").trim()
}

function triggers (settings) {
  const raw = String(settings.triggers || "小鲸,@小鲸,!")
  return raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
}

function splitTrigger (text, list) {
  for (const t of list) {
    if (text.indexOf(t) === 0) {
      return { hit: true, body: text.slice(t.length).replace(/^[：:，,、\s]+/, "").trim() }
    }
  }
  return { hit: false, body: text }
}


// ---------------- API 配置解析 ----------------
// 支持三种填法（优先级从高到低）：
//   1) config.json 里的 api.api_key 明文
//   2) api.api_key_file 指向的文本文件（推荐，密钥不进 JSON）
//   3) 旧版扁平键 api_key / base_url / model（向后兼容）
const DEFAULT_API = {
  provider: "wb-proxy",
  base_url: "http://127.0.0.1:8788/v1",
  model: "deepseek-v4.1-flash",
  timeout: 45
}

function readKeyFile (p) {
  try {
    if (!p) return ""
    if (typeof File === "undefined" || !File.readFrom) return ""
    return String(File.readFrom(p) || "").replace(/^\uFEFF/, "").trim()
  } catch (e) { return "" }
}

function apiOf (settings) {
  const st = settings || {}
  const nest = st.api && typeof st.api === "object" ? st.api : {}
  const base_url = String(nest.base_url || st.base_url || DEFAULT_API.base_url).replace(/\/+$/, "")
  const model = String(nest.model || st.model || DEFAULT_API.model)
  const timeout = Number(nest.timeout || st.timeout || DEFAULT_API.timeout)
  let api_key = String(nest.api_key || st.api_key || "").trim()
  if (!api_key) api_key = readKeyFile(nest.api_key_file || st.api_key_file || "")
  return { provider: String(nest.provider || "wb-proxy"), base_url: base_url, model: model, timeout: timeout, api_key: api_key }
}

function looksLikeQuestion (text) {
  if (!text || text.length > 120) return false
  if (/[?？]/.test(text)) return true
  const words = ["怎么", "如何", "为什么", "为啥", "能不能", "可不可以", "可以吗", "在哪", "哪里", "多少", "几个", "是不是", "有没有", "怎么办", "求助", "帮忙", "求", "问一下", "请问", "什么", "啥"]
  for (const w of words) if (text.indexOf(w) >= 0) return true
  const topics = ["服", "服务器", "游戏", "进服", "卡", "延迟", "掉线", "金币", "领地", "版本", "地址", "端口", "地图", "ai", "助手", "小鲸", "指令", "规则", "群规", "跨服", "传送"]
  const low = text.toLowerCase()
  for (const t of topics) if (low.indexOf(t) >= 0) return true
  return false
}

function loadFaq (path) {
  try {
    const raw = File.readFrom(path)
    if (!raw) return []
    const obj = JSON.parse(String(raw))
    return Array.isArray(obj.faq) ? obj.faq : []
  } catch (e) {
    logw("[小鲸] FAQ 读取失败: " + e.message)
    return []
  }
}

function matchFaq (text, path) {
  if (!text) return ""
  const list = loadFaq(path)
  for (const item of list) {
    const pats = item.patterns || []
    for (const p of pats) {
      try {
        if (new RegExp(p, "i").test(text)) return String(item.answer || "")
      } catch (e) {}
    }
  }
  return ""
}

// ---------------- 模型调用（异步，失败返回空） ----------------

function llmOnce (settings, systemText, userText, maxTokens, cb) {
  let done = false
  const finish = (t) => { if (!done) { done = true; try { cb(t) } catch (e) {} } }
  try {
    if (typeof require !== "function") return finish("")
    const base = String(settings.base_url || "").replace(/\/+$/, "")
    if (!base) return finish("")
    const full = base + "/chat/completions"
    const isHttps = full.indexOf("https://") === 0
    const lib = require(isHttps ? "https" : "http")
    const m = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(full)
    if (!m) return finish("")
    const payload = JSON.stringify({
      model: String(settings.model || "deepseek-v4.1-flash"),
      messages: [{ role: "system", content: systemText }, { role: "user", content: userText }],
      temperature: 0.95,
      max_tokens: maxTokens || 60,
      stream: false
    })
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + String(settings.api_key || "")
    }
    try { headers["Content-Length"] = Buffer.byteLength(payload) } catch (e) {}
    const req = lib.request({
      hostname: m[2],
      port: m[3] || (isHttps ? 443 : 80),
      path: m[4] || "/chat/completions",
      method: "POST",
      headers: headers
    }, (res) => {
      let data = ""
      try { res.setEncoding("utf8") } catch (e) {}
      res.on("data", (c) => { data += c })
      res.on("end", () => {
        try {
          const j = JSON.parse(data)
          const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
          finish(String(c || "").trim())
        } catch (e) { finish("") }
      })
    })
    req.on("error", () => finish(""))
    try { req.setTimeout(9000, () => { try { req.destroy() } catch (e) {} finish("") }) } catch (e) {}
    req.write(payload)
    req.end()
  } catch (e) { finish("") }
}

function cleanLine (text, limit) {
  let t = String(text || "").replace(/\r/g, " ").replace(/\n+/g, " ").trim()
  t = t.replace(/^[「『"'“]+|[」』"'”]+$/g, "").trim()
  t = t.replace(/^小鲸[：:，,]\s*/, "").trim()
  const max = limit || 40
  if (t.length > max) t = t.slice(0, max - 1) + "…"
  return t
}

// ---------------- 状态（跨热重载保留） ----------------

const G = globalThis
try {
  File.writeTo("plugins/QQMCBridge/mods/ai-assistant/selfcheck.txt",
    "require=" + (typeof require) + " Buffer=" + (typeof Buffer) + " mc=" + (typeof mc) +
    " File=" + (typeof File) + " logger=" + (typeof logger) + " http=" +
    (function () { try { return typeof require("http").request } catch (e) { return "ERR:" + e.message } })())
} catch (e) {}
if (!G.__QQMC_CHAT) G.__QQMC_CHAT = { lastGroup: 0, lastGame: 0, lastLine: "" }
const S = G.__QQMC_CHAT

function nowSec () { return Math.floor(Date.now() / 1000) }

function tooSoon (key, cooldownSec) {
  const t = nowSec()
  if (t - (S[key] || 0) < cooldownSec) return true
  S[key] = t
  return false
}

const PERSONA = "你是「星辰」Minecraft 基岩版服务器群里的助手小鲸：活泼、有点皮、爱接梗，说话像群友，口语化。"

const TPL = {
  join: ["{n} 回来了，正好缺个苦力。", "哟，{n} 上线了，今天想挖矿还是拆家？", "{n} 一进来服务器都热闹了。", "欢迎 {n}，别又迷路了啊。", "{n} 来了，我先看看在线人数。", "上线了 {n}，背包带够了吗？"],
  leave: ["{n} 溜了，估计又去吃饭。", "{n} 下线了，明天继续。", "走好 {n}，别忘了收菜。", "{n} 退了，服务器安静了三秒。", "拜拜 {n}，下次别挖到岩浆。"],
  chat: ["{n} 这话有点东西。", "{n} 说得对，我记下了。", "同意 {n}，继续。", "{n} 又开始整活了。", "{n} 你这话我不好接。", "有意思，{n} 展开说说？"],
  group: ["有道理，不过我建议先看群公告。", "这问题问得好，我猜服主知道。", "我就静静看着你们聊。", "别急，慢慢来，服务器不跑。", "这条我记下了，回头提醒服主。", "听起来是个大工程。"]
}

function pick (kind, name) {
  const arr = TPL[kind] || TPL.group
  let line = ""
  for (let i = 0; i < 4; i++) {
    line = arr[Math.floor(Math.random() * arr.length)].replace(/\{n\}/g, name || "你")
    if (line !== S.lastLine || arr.length === 1) break
  }
  S.lastLine = line
  return line
}

// ---------------- 主动接话 ----------------

function reactToGame (kind, name, message, apiRef, settings) {
  try {
    if (settings.enabled === false) return
    if (!name) return
    if (String(name).indexOf("小鲸") === 0) return
    const mode = String(settings.mode || "chatty").toLowerCase()
    if (mode === "off" || mode === "half") return

    if (kind === "join" && settings.joinLine === false) return
    if (kind === "leave" && settings.leaveLine === false) return
    if (kind === "chat") {
      const chance = Number(settings.chatLineChance === undefined ? 0.4 : settings.chatLineChance)
      if (Math.random() > chance) return
      if (!message || String(message).length < 2) return
    }
    const cd = Number(settings.gameCooldown || 25)
    if (tooSoon("lastGame", kind === "join" ? Math.max(10, cd) : cd)) return

    const emit = (line) => {
      const t = cleanLine(line, 60)
      if (!t) return
      try { if (apiRef && apiRef.enqueueReply) apiRef.enqueueReply(t, "") } catch (e) { logw("[小鲸] 发群失败: " + e.message) }
    }

    // mod 里没有 http 模块（require('http') 不可用），事件交给机器人侧生成一句话
    const apiCfg = apiOf(settings)
    if (!apiCfg.api_key) { emit(pick(kind, name)); return }
    const payload = {
      kind: kind,
      name: String(name || ""),
      message: String(message || "").slice(0, 120),
      settings: {
        model: apiCfg.model,
        base_url: apiCfg.base_url,
        api_key: apiCfg.api_key,
        timeout: apiCfg.timeout,
        max_tokens: 400
      }
    }
    try {
      if (apiRef && apiRef.enqueueReply) apiRef.enqueueReply(SAY_PROTO + JSON.stringify(payload), "")
      else emit(pick(kind, name))
    } catch (e) { logw("[小鲸] 发群失败: " + e.message) }
  } catch (e) { logw("[小鲸] 游戏事件处理失败: " + e.message) }
}

function ensureGameHooks (apiRef, settings) {
  G.__QQMC_CHAT.api = apiRef
  G.__QQMC_CHAT.settings = settings
  if (G.__QQMC_CHAT.hooked) return
  G.__QQMC_CHAT.hooked = true
  const getApi = () => G.__QQMC_CHAT.api
  const getCfg = () => G.__QQMC_CHAT.settings || {}
  try {
    mc.listen("onJoin", (player) => {
      try { reactToGame("join", player && player.realName, "", getApi(), getCfg()) } catch (e) {}
    })
    mc.listen("onLeft", (player) => {
      try { reactToGame("leave", player && player.realName, "", getApi(), getCfg()) } catch (e) {}
    })
    mc.listen("onChat", (player, msg) => {
      try {
        const name = player && player.realName
        const cfg = getCfg()
        const text = String(msg || "")
        const called = triggers(cfg).some((t) => text.indexOf(t) === 0)
        if (!called) reactToGame("chat", name, text, getApi(), cfg)
      } catch (e) {}
      return true
    })
    logw("[小鲸] 已挂上游戏内事件监听（进服/退服/聊天）")
  } catch (e) {
    G.__QQMC_CHAT.hooked = false
    logw("[小鲸] 挂事件监听失败: " + e.message)
  }
}

// ---------------- 本地只读命令 ----------------

function playerListText (api) {
  let list = []
  try { list = api.getOnlinePlayers() || [] } catch (e) { list = [] }
  const names = list.map((p) => (p && (p.realName || p.name)) || "?").filter(Boolean)
  if (!names.length) return "现在服务器里没人。"
  return "在线 " + names.length + " 人：" + names.join("、")
}

function localCommand (body, context, api, settings) {
  const t = String(body || "").trim()
  if (!t) return ""
  const low = t.toLowerCase()

  if (/^(帮助|help|指令|命令|怎么用|用法|功能)$/.test(t)) {
    return "我是小鲸，可以：\n1) 回答服务器问题（地址/版本/金币/AI助手/领地/规则）\n2) 实时查询：「小鲸 在线」「小鲸 状态」「小鲸 查 <玩家>」「小鲸 余额」\n3) 管理员：「小鲸 公告 <内容>」广播到游戏内"
  }
  if (/^(在线|在线人数|谁在线|在线玩家|人数|几个在线)$/.test(t)) return playerListText(api)
  if (/^(状态|服务器状态|tps|性能)$/.test(low)) {
    try { return String(api.getServerStatusMessage() || playerListText(api)) } catch (e) { return playerListText(api) }
  }
  if (/^(时间|几点|现在几点)$/.test(t)) {
    const d = new Date(Date.now() + 8 * 3600 * 1000)
    return "服务器时间 " + d.toISOString().replace("T", " ").slice(0, 19) + "（UTC+8）"
  }
  if (/^(余额|我的金币|我有多少钱|查余额)$/.test(t)) {
    const p = context.boundPlayer
    if (!p) return "你还没绑定游戏账号，先在游戏里绑定，或者直接问我服务器的事。"
    try {
      const money = p.getMoney()
      if (money === null || money === undefined) return "读不到你的金币余额，可能是经济插件没启用。"
      return "你的金币：" + money
    } catch (e) { return "读不到你的金币余额（" + e.message + "）。" }
  }
  const look = /^(查|查询|看看)\s*([A-Za-z0-9_\u4e00-\u9fa5]{2,16})$/.exec(t)
  if (look) {
    const name = look[2]
    try {
      const p = api.getPlayerByName(name)
      if (!p) return name + " 现在不在线。"
      const pos = p.pos || {}
      const dim = (typeof p.dim !== "undefined") ? p.dim : "?"
      return name + " 在线：坐标 " + Math.round(pos.x || 0) + ", " + Math.round(pos.y || 0) + ", " + Math.round(pos.z || 0) + "（维度 " + dim + "）"
    } catch (e) { return "查询失败：" + e.message }
  }
  const notice = /^公告\s+([\s\S]{1,200})$/.exec(t)
  if (notice) {
    if (!context.isAdmin) return "公告只有管理员能用。"
    try {
      api.broadcast("§e[公告] §f" + notice[1])
      return "已广播到游戏内。"
    } catch (e) { return "广播失败：" + e.message }
  }
  return ""
}

// ---------------- 主入口 ----------------

module.exports.handleQQ = function (context) {
  try {
    const settings = context.pluginSettings || {}
    if (settings.enabled === false) return ""
    const mode = String(settings.mode || "chatty").toLowerCase()
    if (mode === "off") return ""

    const apiRef = context.api || api
    try { ensureGameHooks(apiRef, settings) } catch (e) {}

    const raw = stripAt(context.content)
    if (!raw) return ""
    const sp = splitTrigger(raw, triggers(settings))
    const addressed = sp.hit || Boolean(context.replyEnabled)
    const body = sp.body || raw

    // 1) 闸门
    const question = looksLikeQuestion(body)
    if (mode === "half" && !addressed) return ""
    if (mode === "smart" && !addressed && !question) return ""
    if (mode === "chatty" && !addressed && !question) {
      const chance = Number(settings.chatterChance === undefined ? 0.35 : settings.chatterChance)
      const cd = Number(settings.groupCooldown || 60)
      if (Math.random() <= chance && !tooSoon("lastGroup", cd) && body.length >= 3 && !/^[\[\/]/.test(body)) {
        const apiCfg = apiOf(settings)
        const payload = {
          kind: "group",
          name: String(context.senderName || "群友"),
          message: body.slice(0, 120),
          settings: {
            model: apiCfg.model,
            base_url: apiCfg.base_url,
            api_key: apiCfg.api_key,
            timeout: apiCfg.timeout,
            max_tokens: 400
          }
        }
        try {
          if (apiCfg.api_key && apiRef && apiRef.enqueueReply) {
            apiRef.enqueueReply(SAY_PROTO + JSON.stringify(payload), "")
          } else {
            const t = cleanLine(pick("group"), 40)
            if (t && apiRef && apiRef.enqueueReply) apiRef.enqueueReply(t, "")
          }
        } catch (e) {}
      }
      return ""
    }

    // 2) 本地只读命令
    const local = localCommand(body, context, apiRef, settings)
    if (local) return local

    // 3) FAQ 精确匹配
    const faqHit = matchFaq(body, settings.faq_path || DEFAULT_FAQ)
    if (faqHit) return faqHit

    // 4) 交给机器人侧的模型（带知识库）
    const kb = readText(settings.kb_path || DEFAULT_KB, "")
    const base = String(settings.system_prompt || "")
    const apiCfg = apiOf(settings)
    const merged = Object.assign({}, settings, {
      api_key: apiCfg.api_key,
      base_url: apiCfg.base_url,
      model: apiCfg.model,
      timeout: apiCfg.timeout,
      system_prompt: kb ? (base + "\n\n【服务器知识库（以此为准）】\n" + kb.slice(0, 6000)) : base
    })
    return PROTO + JSON.stringify({
      sender: String(context.senderId || ""),
      content: body,
      mentioned: addressed,
      settings: merged
    })
  } catch (e) {
    logw("[小鲸] 处理群消息失败: " + e.message)
    return ""
  }
}

// ---------------- 加载即挂钩子（不依赖第一条群消息） ----------------
try {
  const rawCfg = (typeof File !== "undefined" && File.readFrom)
    ? String(File.readFrom("plugins/QQMCBridge/mods/ai-assistant/config.json") || "")
    : ""
  const bootCfg = rawCfg ? (JSON.parse(rawCfg).settings || {}) : {}
  if (typeof mc !== "undefined" && mc.listen && bootCfg.enabled !== false) {
    ensureGameHooks(api, bootCfg)
    logw("[小鲸] 游戏事件钩子已就绪（加载时注册）")
  }
} catch (e) { logw("[小鲸] 加载时挂钩失败: " + e.message) }
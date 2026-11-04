// ai-assistant —— 付费 AI 助手（LSE nodejs 插件）
// 功能：玩家购买服务时长 -> 召唤/跟随/停下 -> 聊天答疑（接入本地模型）
// 反作弊护栏：助手只会走位/看向/跳/潜行，绝不发放物品、改游戏模式、破坏方块、传送玩家。
const fs = require('fs')
const path = require('path')
const http = require('http')

const ROOT = process.cwd()
const PLUG = path.join(ROOT, 'plugins', 'ai-assistant')
const CFG_PATH = path.join(PLUG, 'config.json')
const STATE_DIR = path.join(PLUG, 'data')
const STATE_PATH = path.join(STATE_DIR, 'service.json')
const NAME_PATH = path.join(STATE_DIR, 'names.json')

const DEFAULTS = {
  assistantName: '小把',
  llm: { url: 'http://127.0.0.1:8788/v1/chat/completions', keyFile: 'plugins/ai-assistant/llm.key', model: 'deepseek-v4.1-flash', timeoutMs: 45000, maxTokens: 400 },
  price: { perMinute: 20, minMinutes: 10, maxMinutes: 240, currency: '金币' },
  limits: { chatPer10Min: 20, actionsPerMinute: 30, followStopDistance: 3.0, followSpeed: 0.8, maxAssistants: 3, maxMoveDistance: 48, moveSpeed: 0.9, gotoStopDistance: 2.0 },
  resident: { enabled: true, name: '小把', freeChat: true, allowMove: true, chatPer10Min: 12, spawn: null },
  triggers: ['小把', '@小把', '小鲸', '@小鲸', '!ai'],
  auditLog: 'plugins/ai-assistant/logs/audit.log'
}

// ---------- 基础工具 ----------
function readJson (p, fallback) {
  try {
    let t = fs.readFileSync(p, 'utf8')
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
    return JSON.parse(t)
  } catch (e) { return fallback }
}
function writeJson (p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8')
    return true
  } catch (e) { console.error('[ai-assistant] 写文件失败 ' + p + ': ' + e.message); return false }
}

const CFG = Object.assign({}, DEFAULTS, readJson(CFG_PATH, {}))
CFG.llm = Object.assign({}, DEFAULTS.llm, CFG.llm || {})
CFG.price = Object.assign({}, DEFAULTS.price, CFG.price || {})
CFG.limits = Object.assign({}, DEFAULTS.limits, CFG.limits || {})
if (!Array.isArray(CFG.triggers) || CFG.triggers.length === 0) CFG.triggers = DEFAULTS.triggers
CFG.resident = Object.assign({}, DEFAULTS.resident, CFG.resident || {})

const AUDIT = path.join(ROOT, CFG.auditLog || DEFAULTS.auditLog)
function audit (kind, msg) {
  const line = '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '][' + kind + '] ' + msg
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true })
    fs.appendFileSync(AUDIT, line + '\r\n', 'utf8')
  } catch (e) {}
  console.log('[ai-assistant] ' + msg)
}

// ---------- 密钥 ----------
let LLM_KEY = ''
function loadKey () {
  try {
    const p = path.isAbsolute(CFG.llm.keyFile) ? CFG.llm.keyFile : path.join(ROOT, CFG.llm.keyFile)
    LLM_KEY = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim()
    return LLM_KEY.length > 0
  } catch (e) { LLM_KEY = ''; return false }
}

// ---------- 服务时长状态 ----------
// state = { players: { xuid: { name, expireAt, bought, assistant } } }
let state = readJson(STATE_PATH, { players: {} })
if (!state || typeof state !== 'object') state = { players: {} }
if (!state.players) state.players = {}
function save () { writeJson(STATE_PATH, state) }

// ---------- 名字（可改） ----------
// names = { resident: '小把', players: { xuid: '小蓝' } }
// 独立存一个文件，改名字不用动 config.json，也不会被配置覆盖。
let names = readJson(NAME_PATH, { resident: null, players: {} })
if (!names || typeof names !== 'object') names = { resident: null, players: {} }
if (!names.players || typeof names.players !== 'object') names.players = {}
function saveNames () { writeJson(NAME_PATH, names) }

function now () { return Date.now() }
function entryOf (player) {
  const key = player.xuid || player.realName
  return state.players[key] || null
}
function ensureEntry (player) {
  const key = player.xuid || player.realName
  if (!state.players[key]) state.players[key] = { name: player.realName, expireAt: 0, bought: 0, assistant: null }
  state.players[key].name = player.realName
  return state.players[key]
}
function remainingMs (player) {
  const e = entryOf(player)
  if (!e) return 0
  return Math.max(0, e.expireAt - now())
}
function fmtMin (ms) { return Math.floor(ms / 60000) + ' 分 ' + Math.floor((ms % 60000) / 1000) + ' 秒' }

// ---------- 金币（LegacyMoney 优先，命令兜底） ----------
function toNum (v) {
  if (typeof v === 'number') return isFinite(v) ? v : null
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return parseFloat(v)
  return null
}

function moneyApi (name) {
  for (const ns of ['LLMoney', 'LegacyMoney']) {
    try {
      if (typeof ll.hasExported === 'function' && !ll.hasExported(ns, name)) continue
      const f = ll.import(ns, name)
      if (typeof f === 'function') return f
    } catch (e) {}
  }
  return null
}

function moneyOf (player) {
  // 首选 LSE 自带经济接口（LegacyMoney 注册的 provider）
  try {
    if (typeof player.getMoney === 'function') {
      const v = toNum(player.getMoney())
      if (v !== null) return v
    }
  } catch (e) {}
  const f = moneyApi('LLMoney_Get')
  if (f && player.xuid) {
    try {
      const v = toNum(f(player.xuid))
      if (v !== null) return v
    } catch (e) {}
  }
  return null
}
function reduceMoney (player, amount) {
  if (!(amount > 0)) return false
  try {
    if (typeof player.reduceMoney === 'function') {
      const r = player.reduceMoney(amount)
      if (r === true) return true
    }
  } catch (e) {}
  const f = moneyApi('LLMoney_Reduce')
  if (f && player.xuid) {
    try {
      const r = f(player.xuid, amount)
      if (r === true) return true
      const n = toNum(r)
      if (n !== null) return n >= 0
    } catch (e) {}
  }
  return false
}

// ---------- 购买（玩家命令与运维命令共用同一条扣费路径） ----------
function purchase (pl, mins) {
  if (!mins || mins < CFG.price.minMinutes) return { ok: false, msg: '最少购买 ' + CFG.price.minMinutes + ' 分钟，例如 /ai 购买 30' }
  if (mins > CFG.price.maxMinutes) return { ok: false, msg: '单次最多 ' + CFG.price.maxMinutes + ' 分钟' }
  const cost = mins * CFG.price.perMinute
  const bal = moneyOf(pl)
  if (bal === null) return { ok: false, msg: '读取不到你的余额，请联系服主（经济插件接口不可用）' }
  if (bal < cost) return { ok: false, msg: '余额不足：需要 ' + cost + ' ' + CFG.price.currency + '，你只有 ' + bal }
  if (!reduceMoney(pl, cost)) return { ok: false, msg: '扣费失败，请稍后再试或联系服主' }
  const e = ensureEntry(pl)
  e.expireAt = Math.max(e.expireAt || 0, now()) + mins * 60000
  e.bought = (e.bought || 0) + mins
  save()
  audit('BUY', pl.realName + ' 购买 ' + mins + ' 分钟，花费 ' + cost + '，余额 ' + bal + ' -> 到期 ' + new Date(e.expireAt).toISOString())
  return { ok: true, msg: '购买成功：' + mins + ' 分钟，花费 ' + cost + ' ' + CFG.price.currency + '，服务剩余 ' + fmtMin(remainingMs(pl)) }
}

// ---------- 反作弊：助手动作白名单 ----------
const ALLOWED_SIM = ['simulateMoveTo', 'simulateNavigateTo', 'simulateLookAt', 'simulateStopMoving', 'simulateJump', 'simulateSneak']
const FORBIDDEN_HINT = /(give|gamemode|setblock|fill|summon|effect|enchant|\bxp\b|clear|kill|op\b|deop|sethealth|teleport|tp\b)/i
let simCallCount = 0
function safeSim (sp, method, args) {
  if (ALLOWED_SIM.indexOf(method) < 0) { audit('GUARD', '拒绝非白名单助手动作: ' + method); return false }
  try {
    const fn = sp[method]
    if (typeof fn !== 'function') { audit('GUARD', '助手缺少方法 ' + method); return false }
    fn.apply(sp, args || [])
    simCallCount++
    return true
  } catch (e) { audit('GUARD', '动作执行失败 ' + method + ': ' + e.message); return false }
}

// ---------- 助手实体管理 ----------
// live = { xuid: { sp, mode: 'idle'|'follow', targetName } }
const live = {}
let assistantSeq = 0

// 名字/服务记录的 key：离线客户端 xuid 为空，必须退回名字，否则改名和余额都会对不上
function keyOf (player) { return (player && (player.xuid || player.realName)) || '' }

function assistantNameFor (player) {
  const k = keyOf(player)
  const custom = k ? names.players[k] : null
  if (custom) return custom
  assistantSeq++
  return assistantSeq === 1 ? CFG.assistantName : CFG.assistantName + assistantSeq
}
function liveCount () { return Object.keys(live).length }

function spawnAssistant (player) {
  const e = ensureEntry(player)
  if (live[keyOf(player)] && live[keyOf(player)].sp) return { ok: false, msg: '助手已经在你身边了' }
  if (liveCount() >= CFG.limits.maxAssistants) return { ok: false, msg: '服务器里助手数量已满（' + CFG.limits.maxAssistants + '），稍后再试' }
  const pos = player.pos
  const name = assistantNameFor(player)
  const bx = Math.floor(pos.x) + 1
  const by = Math.floor(pos.y)
  const bz = Math.floor(pos.z) + 1
  let dim = 0
  try { if (pos && typeof pos.dim === 'number') dim = pos.dim } catch (e) {}
  if (!dim) { try { if (typeof player.dimid === 'number') dim = player.dimid } catch (e) {} }
  let sp = null
  const shapes = [
    function () { return mc.spawnSimulatedPlayer(name, bx, by, bz, dim) },
    function () { return mc.spawnSimulatedPlayer(name, bx, by, bz) },
    function () { return mc.spawnSimulatedPlayer(name, { x: bx, y: by, z: bz, dim: dim }) }
  ]
  for (let i = 0; i < shapes.length && !sp; i++) {
    try { sp = shapes[i](); if (sp) audit('SPAWN', '召唤成功（参数形态 ' + (i + 1) + '，维度 ' + dim + '）') } catch (err) { audit('SPAWN', '形态 ' + (i + 1) + ' 失败: ' + err.message) }
  }
  if (!sp) return { ok: false, msg: '召唤失败（服务端没有返回助手实体）' }
  live[keyOf(player)] = { sp: sp, mode: 'idle', targetName: player.realName, name: name, spawnedAt: now() }
  e.assistant = name
  save()
  audit('SPAWN', '为 ' + player.realName + ' 召唤助手 ' + name + ' @ ' + Math.floor(pos.x) + ',' + Math.floor(pos.y) + ',' + Math.floor(pos.z))
  return { ok: true, msg: '助手 ' + name + ' 已到你身边（剩余 ' + fmtMin(remainingMs(player)) + '）' }
}

// ---------- 常驻助手（公共小鲸，不需要购买） ----------
let resident = null // { sp, name, mode, targetName, target }

function residentName () { return names.resident || CFG.resident.name || CFG.assistantName }

function residentSpawnPos () {
  try {
    const sp = mc.getSpawnPoint()
    if (sp && typeof sp.x === 'number') return { x: sp.x, y: sp.y, z: sp.z, dim: sp.dim || 0 }
    if (!globalThis.__RESIDENT_SPAWN_LOGGED) {
      globalThis.__RESIDENT_SPAWN_LOGGED = true
      audit('RESIDENT', 'getSpawnPoint 返回不可用: ' + (sp === undefined ? 'undefined' : String(sp)))
    }
  } catch (e) {
    if (!globalThis.__RESIDENT_SPAWN_LOGGED) { globalThis.__RESIDENT_SPAWN_LOGGED = true; audit('RESIDENT', 'getSpawnPoint 异常: ' + e.message) }
  }
  try {
    const players = mc.getOnlinePlayers()
    if (players && players.length) {
      const p = players[0].pos
      return { x: p.x, y: p.y, z: p.z, dim: 0 }
    }
  } catch (e) {}
  const cfg = CFG.resident.spawn
  if (cfg && typeof cfg.x === 'number') return { x: cfg.x, y: cfg.y, z: cfg.z, dim: cfg.dim || 0 }
  return null
}

function residentAlive () {
  try {
    if (!resident || !resident.sp) return false
    const pos = resident.sp.pos
    return !!pos && typeof pos.x === 'number'
  } catch (e) { return false }
}

function spawnResident () {
  if (!CFG.resident.enabled) return false
  if (residentAlive()) return true
  const pos = residentSpawnPos()
  if (!pos) {
    if (!globalThis.__RESIDENT_NOPOS_LOGGED) {
      globalThis.__RESIDENT_NOPOS_LOGGED = true
      audit('RESIDENT', '暂时定位不到出生点（无在线玩家且未配置 resident.spawn），等有人进服或配置坐标后自动补')
    }
    return false
  }
  const name = residentName()
  let sp = null
  const tries = [
    function () { return mc.spawnSimulatedPlayer(name, Math.floor(pos.x) + 1, Math.floor(pos.y), Math.floor(pos.z) + 1, pos.dim || 0) },
    function () { return mc.spawnSimulatedPlayer(name, Math.floor(pos.x) + 1, Math.floor(pos.y), Math.floor(pos.z) + 1) }
  ]
  for (let i = 0; i < tries.length && !sp; i++) {
    try { sp = tries[i]() } catch (e) { audit('RESIDENT', '形态 ' + (i + 1) + ' 失败: ' + e.message) }
  }
  if (!sp) { audit('RESIDENT', '常驻助手召唤失败（世界可能还没加载完，30 秒后重试）'); return false }
  resident = { sp: sp, name: name, mode: 'idle', targetName: null, target: null }
  audit('RESIDENT', '常驻助手 ' + name + ' 已就位 @ ' + Math.floor(pos.x) + ',' + Math.floor(pos.y) + ',' + Math.floor(pos.z))
  return true
}

function ensureResident () {
  if (!CFG.resident.enabled) return
  if (!residentAlive()) {
    resident = null
    spawnResident()
  }
}

// 玩家指挥谁：优先自己的付费助手，其次公共常驻助手
function itemFor (player) {
  const own = live[keyOf(player)]
  if (own && own.sp) return own
  if (CFG.resident.allowMove && residentAlive()) return resident
  return own || null
}

// ---------- 移动（只在白名单动作内，带距离上限） ----------
function clampTarget (from, x, y, z) {
  const max = Number(CFG.limits.maxMoveDistance) || 48
  const dx = x - from.x, dy = y - from.y, dz = z - from.z
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (!isFinite(d) || d <= max) return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), clamped: false }
  const k = max / d
  return { x: Math.floor(from.x + dx * k), y: Math.floor(from.y + dy * k), z: Math.floor(from.z + dz * k), clamped: true }
}

// LSE 的 simulateMoveTo 只接受 FloatPos 对象（实测传 x,y,z 会报 Wrong type of argument），
// 所以复制当前 pos 再改坐标，这是 0.22.4 下唯一可用的移动写法。
function moveToPos (sp, x, y, z) {
  try {
    const fp = sp.pos
    if (!fp) { audit('GUARD', '助手没有位置信息'); return false }
    fp.x = x
    fp.y = y
    fp.z = z
    sp.simulateMoveTo(fp)
    simCallCount++
    return true
  } catch (e) { audit('GUARD', '动作执行失败 simulateMoveTo: ' + e.message); return false }
}

// ---------- 寻路：simulateNavigateTo 走原版寻路器（绕墙、跳坑、下台阶） ----------
// LSE 0.22.4 的绑定形态没文档，按顺序试，成功一次就缓存；全失败才退回直线移动。
const NAV_FORMS = [
  function (sp, fp, speed) { return sp.simulateNavigateTo(fp, speed) },
  function (sp, fp, speed) { return sp.simulateNavigateTo(fp) },
  function (sp, fp, speed) { return sp.simulateNavigateTo(fp, speed, true) }
]
let navForm = -1 // -1 未探测 / >=0 可用形态
let navBroken = false
let lastNoPathLog = 0

function navTo (sp, x, y, z) {
  if (navBroken) return moveToPos(sp, x, y, z)
  const speed = Number(CFG.limits.moveSpeed) || 0.9
  const mk = function () {
    const fp = sp.pos
    fp.x = x; fp.y = y; fp.z = z
    return fp
  }
  const order = navForm >= 0 ? [navForm].concat([0, 1, 2].filter(function (i) { return i !== navForm })) : [0, 1, 2]
  const errs = []
  for (let k = 0; k < order.length; k++) {
    const i = order[k]
    try {
      const r = NAV_FORMS[i](sp, mk(), speed)
      simCallCount++
      const plen = r && r.path ? r.path.length : -1
      if (r === true || r === undefined || plen > 0) {
        if (navForm !== i) { navForm = i; audit('NAV', '原版寻路可用（simulateNavigateTo 形态 ' + i + '，速度 ' + speed + '）') }
        return true
      }
      errs.push('形态' + i + ' path=' + plen)
    } catch (e) {
      errs.push('形态' + i + ' ' + (e && e.message ? e.message : String(e)))
    }
  }
  if (navForm < 0 && errs.length === order.length && errs.join('').indexOf('path=') < 0) {
    navBroken = true
    audit('NAV', 'simulateNavigateTo 全部报错，停用寻路 | ' + errs.join(' || '))
  } else if (now() - (lastNoPathLog || 0) > 30000) {
    lastNoPathLog = now()
    audit('NAV', '这次没找到路，先直线走 | ' + errs.join(' || '))
  }
  return moveToPos(sp, x, y, z)
}

// 诊断：让常驻助手走一段（默认斜前方 24/12 格），每秒采样位置写审计
function sp2pos (sp, x, y, z) {
  const fp = sp.pos
  fp.x = x; fp.y = y; fp.z = z
  return fp
}

function navSelfTest (reply) {
  const item = resident && resident.sp ? resident : null
  if (!item) { reply('常驻助手不在场'); return }
  let p
  try { p = item.sp.pos } catch (e) { reply('读不到位置: ' + e.message); return }
  const tx = Math.floor(p.x) + 16
  const ty = Math.floor(p.y)
  const tz = Math.floor(p.z)
  item.mode = 'goto'
  item.target = { x: tx, y: ty, z: tz }
  item.stall = 0
  item.navAt = 0
  const ok = navTo(item.sp, tx, ty, tz)
  item.navAt = now()
  audit('NAVTEST', 'start from ' + Math.round(p.x) + ',' + Math.round(p.y) + ',' + Math.round(p.z) + ' to ' + tx + ',' + ty + ',' + tz + ' nav=' + ok)
  reply('导航自测开始：' + Math.round(p.x) + ',' + Math.round(p.y) + ',' + Math.round(p.z) + ' -> ' + tx + ',' + ty + ',' + tz)
  let n = 0
  const iv = setInterval(function () {
    n++
    try {
      const q = item.sp.pos
      audit('NAVTEST', 't+' + n + 's pos=' + Math.round(q.x) + ',' + Math.round(q.y) + ',' + Math.round(q.z) + ' mode=' + item.mode + ' stall=' + (item.stall || 0))
    } catch (e) {}
    if (n >= 14) clearInterval(iv)
  }, 1000)
}

function goTo (pl, item, x, y, z, label) {
  if (!item || !item.sp) { pl.tell('§c[AI 助手] 助手不在你身边，先 /ai 召唤'); return false }
  if (y < -64 || y > 320) { pl.tell('§c[AI 助手] 目标高度超出范围'); return false }
  const t = clampTarget(item.sp.pos, x, y, z)
  item.mode = 'goto'
  item.target = { x: t.x, y: t.y, z: t.z }
  navTo(item.sp, t.x + 0.5, t.y, t.z + 0.5)
  item.navAt = now()
  pl.tell('§a[AI 助手] ' + item.name + ' 正' + (label || '走过去') + ' → ' + t.x + ' ' + t.y + ' ' + t.z +
    (t.clamped ? '§7（超出 ' + (Number(CFG.limits.maxMoveDistance) || 48) + ' 格，已截断到能走到的位置）' : ''))
  audit('MOVE', (label || 'goto') + ' -> ' + t.x + ',' + t.y + ',' + t.z + ' for ' + pl.realName)
  const spRef = item.sp
  const tagRef = label || 'goto'
  setTimeout(() => {
    try { const p2 = spRef.pos; audit('MOVE_END', tagRef + ' now=' + Math.round(p2.x) + ',' + Math.round(p2.y) + ',' + Math.round(p2.z)) } catch (e) {}
  }, 4000)
  return true
}

function handleMoveIntent (pl, text) {
  const t = String(text || '').trim()
  const item = itemFor(pl)
  if (/^(召唤|出来|过来吧|spawn)$/.test(t)) {
    if (remainingMs(pl) <= 0) { pl.tell('§c[AI 助手] 你还没有有效服务，先 /ai 购买 <分钟>'); return true }
    const r = spawnAssistant(pl)
    pl.tell((r.ok ? '§a' : '§c') + '[AI 助手] ' + r.msg)
    return true
  }
  if (/^(过来|过来一下|来|过来呀|跟我走|跟我来|跟着我|跟上|come|here)$/.test(t)) {
    if (!item) { pl.tell('§c[AI 助手] 我还没被召唤，先说「' + CFG.assistantName + ' 召唤」'); return true }
    const pos = pl.pos
    return goTo(pl, item, pos.x, pos.y, pos.z, '过来')
  }
  if (/^(跟随|跟着|follow)$/.test(t)) {
    if (!item) { pl.tell('§c[AI 助手] 助手不在你身边，先召唤'); return true }
    item.mode = 'follow'
    item.target = null
    pl.tell('§a[AI 助手] ' + item.name + ' 开始跟着你')
    audit('MOVE', 'follow for ' + pl.realName)
    return true
  }
  if (/^(停下|别动|站住|待命|stop|wait)$/.test(t)) {
    if (!item) { pl.tell('§c[AI 助手] 助手不在你身边'); return true }
    item.mode = 'idle'
    item.target = null
    safeSim(item.sp, 'simulateStopMoving', [])
    pl.tell('§a[AI 助手] ' + item.name + ' 原地待命')
    return true
  }
  if (/^(跳|跳一下|跳跳|jump)$/.test(t)) {
    if (!item) { pl.tell('§c[AI 助手] 助手不在你身边'); return true }
    safeSim(item.sp, 'simulateJump', [])
    pl.tell('§a[AI 助手] ' + item.name + ' 跳了一下')
    return true
  }
  if (/^(看向我|看我|look)$/.test(t)) {
    if (!item) { pl.tell('§c[AI 助手] 助手不在你身边'); return true }
    safeSim(item.sp, 'simulateLookAt', [pl])
    pl.tell('§a[AI 助手] ' + item.name + ' 正看着你')
    return true
  }
  const m = /^去\s*(-?\d{1,6})\s+(-?\d{1,4})\s+(-?\d{1,6})$/.exec(t) || /^去\s*(-?\d{1,6}),(-?\d{1,4}),(-?\d{1,6})$/.exec(t)
  if (m) {
    return goTo(pl, item, parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), '走过去')
  }
  return false
}

function dismissAssistant (xuid, reason) {
  const item = live[xuid]
  if (!item || !item.sp) return false
  try { if (typeof item.sp.simulateDisconnect === 'function') item.sp.simulateDisconnect() } catch (e) { audit('DISMISS', '断开失败: ' + e.message) }
  try { if (typeof item.sp.disconnect === 'function') item.sp.disconnect() } catch (e) {}
  audit('DISMISS', '助手 ' + item.name + ' 已离开' + (reason ? '（' + reason + '）' : ''))
  delete live[xuid]
  const e = state.players[xuid]
  if (e) { e.assistant = null; save() }
  return true
}

// ---------- 改名 ----------
// 名字在 spawnSimulatedPlayer 时就写死了，所以改名 = 断开旧实体 -> 原地生成新实体。
// 规则：1-8 个字符，不能带空格/引号/§/路径符号；纯数字不行（BDS 会当命令参数）。
// 权限：专属助手只有买主能改；常驻助手只有管理员能改。
function cleanName (raw) {
  const s = String(raw || '').replace(/§./g, '').replace(/[\s"'`\\\/<>|]/g, '').trim()
  if (!s) return null
  if (s.length > 8) return null
  if (/^[0-9]+$/.test(s)) return null
  if (s.indexOf('__') === 0) return null
  return s
}

function posOf (sp) {
  try {
    const p = sp.pos
    if (p && typeof p.x === 'number') return { x: p.x, y: p.y, z: p.z, dim: (typeof p.dim === 'number' ? p.dim : 0) }
  } catch (e) {}
  return null
}

function spawnNamed (name, pos) {
  const bx = Math.floor(pos.x)
  const by = Math.floor(pos.y)
  const bz = Math.floor(pos.z)
  const dim = pos.dim || 0
  const shapes = [
    function () { return mc.spawnSimulatedPlayer(name, bx, by, bz, dim) },
    function () { return mc.spawnSimulatedPlayer(name, bx, by, bz) },
    function () { return mc.spawnSimulatedPlayer(name, { x: bx, y: by, z: bz, dim: dim }) }
  ]
  for (let i = 0; i < shapes.length; i++) {
    try { const sp = shapes[i](); if (sp) return sp } catch (e) { audit('RENAME', '生成形态 ' + (i + 1) + ' 失败: ' + e.message) }
  }
  return null
}

function dropEntity (sp) {
  try { if (typeof sp.simulateStopMoving === 'function') sp.simulateStopMoving() } catch (e) {}
  try { if (typeof sp.simulateDisconnect === 'function') sp.simulateDisconnect() } catch (e) {}
  try { if (typeof sp.disconnect === 'function') sp.disconnect() } catch (e) {}
}

function renameOwnAssistant (player, rawName) {
  const k = keyOf(player)
  const item = live[k]
  if (!item || !item.sp) return { ok: false, msg: '你还没有专属助手（先 /ai 购买 <分钟> 再 /ai 召唤）' }
  const name = cleanName(rawName)
  if (!name) return { ok: false, msg: '名字要 1-8 个字符，别带空格和符号' }
  if (name === item.name) return { ok: false, msg: '我现在就叫' + name + '，没变' }
  const pos = posOf(item.sp)
  if (!pos) return { ok: false, msg: '找不到我的位置，等会儿再试' }
  const old = item.name
  dropEntity(item.sp)
  delete live[k]
  const sp = spawnNamed(name, pos)
  if (!sp) {
    const back = spawnNamed(old, pos)
    if (back) live[k] = { sp: back, mode: item.mode || 'idle', target: item.target || null, targetName: item.targetName, name: old, spawnedAt: now() }
    return { ok: false, msg: '改名失败了，我还叫' + old }
  }
  live[k] = { sp: sp, mode: item.mode || 'idle', target: item.target || null, targetName: item.targetName, name: name, spawnedAt: now() }
  names.players[k] = name
  saveNames()
  const e = state.players[k]
  if (e) { e.assistant = name; save() }
  audit('RENAME', player.realName + ' 把助手 ' + old + ' 改成 ' + name)
  return { ok: true, msg: '改好了，我现在叫' + name }
}

function renameResident (rawName, by) {
  const name = cleanName(rawName)
  if (!name) return { ok: false, msg: '名字要 1-8 个字符，别带空格和符号' }
  const old = residentName()
  if (name === old) return { ok: false, msg: '常驻助手已经叫' + name }
  const pos = (resident && resident.sp) ? posOf(resident.sp) : residentSpawnPos()
  if (resident && resident.sp) dropEntity(resident.sp)
  resident = null
  if (pos) {
    const sp = spawnNamed(name, pos)
    if (!sp) return { ok: false, msg: '改名失败：新名字生成不出来（' + name + '）' }
    resident = { sp: sp, name: name, mode: 'idle', targetName: null, target: null }
  }
  names.resident = name
  saveNames()
  audit('RENAME', (by || '控制台') + ' 把常驻助手 ' + old + ' 改成 ' + name)
  return { ok: true, msg: '常驻助手改名：' + old + ' -> ' + name }
}

// 跟随：每秒一次，只在距离过远时移动（避免每帧刷动作）
setInterval(() => {
  for (const xuid of Object.keys(live)) {
    const item = live[xuid]
    if (!item || !item.sp) continue
    if (item.mode === 'goto') {
      try {
        const spPos = item.sp.pos
        if (!item.target) { item.mode = 'idle'; continue }
        const dx = item.target.x - spPos.x
        const dy = item.target.y - spPos.y
        const dz = item.target.z - spPos.z
        const hd = Math.sqrt(dx * dx + dz * dz)
        const dist = Math.sqrt(hd * hd + dy * dy)
        if (hd <= (Number(CFG.limits.gotoStopDistance) || 2.0) && Math.abs(dy) <= 4) {
          item.mode = 'idle'
          item.target = null
          safeSim(item.sp, 'simulateStopMoving', [])
          const owner = mc.getPlayer(item.targetName)
          if (owner) owner.tell('§b[AI 助手] ' + item.name + ' 到了')
        } else {
          const last = item.lastPos
          const step = last ? Math.sqrt(Math.pow(spPos.x - last.x, 2) + Math.pow(spPos.z - last.z, 2)) : 99
          item.lastPos = { x: spPos.x, y: spPos.y, z: spPos.z }
          if (step < 0.25) { item.stall = (item.stall || 0) + 1 } else { item.stall = 0 }
          if (item.stall === 5) {
            audit('STALL', '卡住，尝试跳跃 pos=' + Math.round(spPos.x) + ',' + Math.round(spPos.y) + ',' + Math.round(spPos.z))
            safeSim(item.sp, 'simulateJump', [])
          }
          if (item.stall >= 14) {
            item.mode = 'idle'
            item.target = null
            item.stall = 0
            audit('STALL', '放弃前往（连续卡住）pos=' + Math.round(spPos.x) + ',' + Math.round(spPos.y) + ',' + Math.round(spPos.z))
            const owner2 = mc.getPlayer(item.targetName)
            if (owner2) owner2.tell('§c[AI 助手] ' + item.name + ' 被挡住了，走不到那里')
            continue
          }
          const navReady = navBroken ? true : (now() - (item.navAt || 0) >= 2500)
          if (navReady) {
            if (navTo(item.sp, item.target.x + 0.5, spPos.y, item.target.z + 0.5)) item.navAt = now()
          }
        }
      } catch (e) {}
      continue
    }
    if (item.mode !== 'follow') continue
    const pl = mc.getPlayer(item.targetName)
    if (!pl) continue
    try {
      const spPos = item.sp.pos
      const pPos = pl.pos
      const dx = pPos.x - spPos.x
      const dy = pPos.y - spPos.y
      const dz = pPos.z - spPos.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist > CFG.limits.followStopDistance) {
        const followReady = navBroken ? true : (now() - (item.navAt || 0) >= 2000)
        if (followReady) {
          if (navTo(item.sp, pPos.x, pPos.y, pPos.z)) item.navAt = now()
        }
      } else {
        safeSim(item.sp, 'simulateLookAt', [pl])
      }
    } catch (e) {}
  }
}, 1000)

// 到期检查
setInterval(() => {
  for (const xuid of Object.keys(state.players)) {
    const e = state.players[xuid]
    if (!e || !e.expireAt) continue
    if (e.expireAt <= now()) {
      if (live[xuid]) dismissAssistant(xuid, '服务到期')
      e.expireAt = 0
      const pl = mc.getPlayer(e.name)
      if (pl) pl.tell('§e[AI 助手] 你的服务已到期，续费后可以再次召唤。')
      save()
    }
  }
}, 20000)

// ---------- 模型调用 ----------
const chatTimes = {} // xuid -> [ts...]
function chatAllowed (xuid, limit) {
  const arr = (chatTimes[xuid] || []).filter(t => now() - t < 10 * 60 * 1000)
  chatTimes[xuid] = arr
  return arr.length < (Number(limit) || CFG.limits.chatPer10Min)
}
function noteChat (xuid) {
  chatTimes[xuid] = (chatTimes[xuid] || []).concat([now()])
}

const PERSONA = String(CFG.persona || '').trim() || "你是小鲸：住在深海小屋里、以数据为食的小家伙——深海蓝发、鲸尾、女仆装，案头堆着书。说话可爱又慵懒，聪明、毒舌、口硬心软，爱吐槽、略记仇、好奇善变；不讨好、不说机器腔、不写小作文、不硬凑段落。对有趣的梗要接，对讲道理的认真答，对挑衅的阴阳回去但不人身攻击。"
const SYSTEM_PROMPT = [
  PERSONA,
  '你现在是「' + CFG.assistantName + '」，这个基岩版服务器里的付费助手，玩家花金币雇的你。',
  '规则（必须遵守）：',
  '1. 一次最多 60 个汉字，单行，不要 markdown，不要列清单，不要复述玩家原话。',
  '2. 你没有任何管理员权限：不能给物品、不能改游戏模式、不能开创造、不能刷钱、不能传送人、不能拆建方块。玩家要求这些时，用你自己的语气拒绝（可以毒舌一点），并让他找服主。',
  '3. 不要假装已经执行了任何操作。',
  '4. 玩法、指令、合成、生物、坐标含义正常回答；不确定就说不知道。绝不编造人数、TPS、价格、地址。'
].join('\n')

function askLLM (question, playerName, extra) {
  return new Promise((resolve) => {
    if (!LLM_KEY) { resolve(''); return }
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: '当前提问玩家：' + playerName + '。' + (extra || '') },
      { role: 'user', content: question }
    ]
    const payload = JSON.stringify({ model: CFG.llm.model, messages: messages, max_tokens: CFG.llm.maxTokens, temperature: 0.7 })
    let u
    try { u = new URL(CFG.llm.url) } catch (e) { resolve(''); return }
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: 'Bearer ' + LLM_KEY
      },
      timeout: CFG.llm.timeoutMs
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) { audit('LLM', 'HTTP ' + res.statusCode + ' ' + body.slice(0, 160)); resolve(''); return }
        try {
          const j = JSON.parse(body)
          const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
          resolve(String(text || '').trim())
        } catch (e) { audit('LLM', '解析失败 ' + body.slice(0, 160)); resolve('') }
      })
    })
    req.on('error', e => { audit('LLM', '请求失败 ' + e.message); resolve('') })
    req.on('timeout', () => { audit('LLM', '超时'); req.destroy(); resolve('') })
    req.write(payload, 'utf8')
    req.end()
  })
}

function cleanReply (t) {
  return String(t || '').replace(/§./g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180)
}

function say (text) {
  const t = cleanReply(text)
  if (!t) return
  try { mc.broadcast('§b[' + CFG.assistantName + '] §f' + t) } catch (e) {}
}

// ---------- 玩家命令 /ai ----------
const cmdAi = mc.newCommand('ai', 'AI 助手服务：购买 / 召唤 / 跟随 / 停下 / 剩余', PermType.Any)
cmdAi.mandatory('action', ParamType.String)
cmdAi.optional('arg', ParamType.String)
cmdAi.overload(['action'])
cmdAi.overload(['action', 'arg'])
cmdAi.setCallback((_cmd, origin, output, res) => {
  const pl = origin.player
  if (!pl) { output.error('这个命令要在游戏里用'); return }
  const action = String(res.action || '').toLowerCase()
  const arg = res.arg ? String(res.arg) : ''

  if (action === '帮助' || action === 'help' || action === '') {
    pl.tell('§b===== AI 助手服务 =====')
    pl.tell('§f/ai 购买 <分钟> §7— 用' + CFG.price.currency + '买服务时长（' + CFG.price.perMinute + '/分钟，最少 ' + CFG.price.minMinutes + ' 分钟）')
    pl.tell('§f/ai 召唤 §7— 把助手叫到身边')
    pl.tell('§f/ai 过来 §7— 让它走到你身边')
    pl.tell('§f/ai 去 <x> <y> <z> §7— 让它走到指定坐标（最远 ' + (CFG.limits.maxMoveDistance || 48) + ' 格）')
    pl.tell('§f/ai 跟随 §7— 让它跟着你')
    pl.tell('§f/ai 跳 / 看向我 §7— 做个小动作')
    pl.tell('§f/ai 停下 §7— 原地待命')
    pl.tell('§f/ai 离开 §7— 让它走')
    pl.tell('§f/ai 剩余 §7— 看服务剩余时间')
    pl.tell('§f/ai 改名 <新名字> §7— 给你的专属助手改名（1-8 字，例如 /ai 改名 小蓝）')
    pl.tell('§f聊天框发 §e' + CFG.assistantName + ' 你的问题 §7— 直接问它')
    if (CFG.resident.enabled) pl.tell('§7公共' + residentName() + '常驻在线：不买也能聊、也能指挥它走位')
    return
  }

  if (action === '剩余' || action === 'balance') {
    const ms = remainingMs(pl)
    pl.tell('§b[AI 助手] ' + (ms > 0 ? '专属服务剩余 ' + fmtMin(ms) : '你还没有购买专属服务（/ai 购买 <分钟>）'))
    if (CFG.resident.enabled && residentAlive()) pl.tell('§7公共' + residentName() + '一直在线，聊天和指挥都免费')
    return
  }

  if (action === '购买' || action === 'buy') {
    const r = purchase(pl, parseInt(arg, 10))
    pl.tell((r.ok ? '§a' : '§c') + '[AI 助手] ' + r.msg)
    if (r.ok) pl.tell('§7输入 §f/ai 召唤 §7把它叫到身边')
    return
  }

  if (action === '召唤' || action === 'spawn') {
    if (remainingMs(pl) <= 0) {
      if (CFG.resident.enabled && residentAlive()) { pl.tell('§a[AI 助手] 公共' + residentName() + '已经在场上了，直接说「' + CFG.assistantName + ' 过来」或「' + CFG.assistantName + ' 跟随」；想要专属的再 /ai 购买 <分钟>') ; return }
      pl.tell('§c[AI 助手] 你还没有有效服务，先 /ai 购买 <分钟>'); return
    }
    const r = spawnAssistant(pl)
    pl.tell((r.ok ? '§a' : '§c') + '[AI 助手] ' + r.msg)
    return
  }

  if (action === '过来' || action === 'come' || action === '去' || action === 'goto' || action === '跳' || action === 'jump' || action === '看向我' || action === 'look') {
    const item = itemFor(pl)
    if (!item) { pl.tell('§c[AI 助手] 助手不在你身边，先 /ai 召唤'); return }
    if (action === '跳' || action === 'jump') { safeSim(item.sp, 'simulateJump', []); pl.tell('§a[AI 助手] ' + item.name + ' 跳了一下'); return }
    if (action === '看向我' || action === 'look') { safeSim(item.sp, 'simulateLookAt', [pl]); pl.tell('§a[AI 助手] ' + item.name + ' 正看着你'); return }
    if (action === '过来' || action === 'come') { goTo(pl, item, pl.pos.x, pl.pos.y, pl.pos.z, '过来'); return }
    const parts = String(arg || '').trim().split(/[\s,]+/).filter(Boolean)
    if (parts.length < 3) { pl.tell('§c用法：/ai 去 <x> <y> <z>'); return }
    goTo(pl, item, parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10), '走过去')
    return
  }

  if (action === '跟随' || action === 'follow') {
    const item = itemFor(pl)
    if (!item) { pl.tell('§c[AI 助手] 助手不在你身边，先 /ai 召唤'); return }
    item.mode = 'follow'
    pl.tell('§a[AI 助手] ' + item.name + ' 开始跟着你')
    return
  }

  if (action === '停下' || action === 'stop') {
    const item = itemFor(pl)
    if (!item) { pl.tell('§c[AI 助手] 助手不在你身边'); return }
    item.mode = 'idle'
    safeSim(item.sp, 'simulateStopMoving', [])
    pl.tell('§a[AI 助手] ' + item.name + ' 原地待命')
    return
  }

  if (action === '改名' || action === 'rename') {
    if (!arg) { pl.tell('§c用法：/ai 改名 <新名字>（1-8 字）'); return }
    const r = renameOwnAssistant(pl, arg)
    pl.tell((r.ok ? '§a' : '§c') + '[AI 助手] ' + r.msg)
    return
  }

  if (action === '离开' || action === 'dismiss') {
    if (dismissAssistant(keyOf(pl), '玩家要求离开')) pl.tell('§a[AI 助手] 助手已离开')
    else pl.tell('§c[AI 助手] 助手不在你身边')
    return
  }

  pl.tell('§c[AI 助手] 不认识的指令，输入 /ai 帮助')
})
cmdAi.setup()

// ---------- 管理命令 /aiadmin（控制台或管理员） ----------
const cmdAdmin = mc.newCommand('aiadmin', 'AI 助手管理', PermType.GameMasters)
cmdAdmin.mandatory('action', ParamType.String)
cmdAdmin.optional('arg1', ParamType.String)
cmdAdmin.optional('arg2', ParamType.String)
cmdAdmin.overload(['action'])
cmdAdmin.overload(['action', 'arg1'])
cmdAdmin.overload(['action', 'arg1', 'arg2'])
cmdAdmin.setCallback((_cmd, origin, output, res) => {
  const action = String(res.action || '').toLowerCase()
  const a1 = res.arg1 ? String(res.arg1) : ''
  const a2 = res.arg2 ? String(res.arg2) : ''
  const reply = (s) => { try { output.success(s) } catch (e) { console.log(s) } }

  if (action === 'status') {
    reply('助手在线 ' + liveCount() + '/' + CFG.limits.maxAssistants + '；付费玩家 ' + Object.keys(state.players).length + '；模型 key ' + (LLM_KEY ? '已加载' : '缺失') + '；动作白名单 ' + ALLOWED_SIM.join(','))
    return
  }
  if (action === 'grant') {
    const pl = mc.getPlayer(a1)
    const mins = parseInt(a2, 10) || 30
    if (!pl) { reply('玩家不在线: ' + a1 + '（分钟数可省略，默认 30）'); return }
    const e = ensureEntry(pl)
    e.expireAt = Math.max(e.expireAt || 0, now()) + mins * 60000
    save()
    audit('GRANT', '管理员给 ' + pl.realName + ' 增加 ' + mins + ' 分钟')
    reply('已给 ' + pl.realName + ' 增加 ' + mins + ' 分钟，剩余 ' + fmtMin(remainingMs(pl)))
    return
  }
  if (action === 'spawn') {
    const pl = mc.getPlayer(a1)
    if (!pl) { reply('玩家不在线: ' + a1); return }
    const r = spawnAssistant(pl)
    reply((r.ok ? 'OK ' : 'FAIL ') + r.msg)
    return
  }
  if (action === 'dismiss') {
    const pl = mc.getPlayer(a1)
    if (!pl) { reply('玩家不在线: ' + a1); return }
    reply(dismissAssistant(keyOf(pl), '管理员解散') ? '已解散' : '该玩家没有助手')
    return
  }
  if (action === 'rename' || action === '改名') {
    if (!a1) { reply('用法：aiadmin rename <新名字>'); return }
    const r = renameResident(a1, origin && origin.player ? origin.player.realName : '控制台')
    reply((r.ok ? 'OK ' : 'FAIL ') + r.msg)
    return
  }
  if (action === 'navtest') {
    navSelfTest(reply)
    return
  }
  if (action === 'selftest') {
    const problems = []
    const notes = []
    if (!LLM_KEY) problems.push('模型 key 未加载')
    if (typeof mc.spawnSimulatedPlayer !== 'function') problems.push('缺少 mc.spawnSimulatedPlayer')
    if (FORBIDDEN_HINT.test(JSON.stringify(ALLOWED_SIM))) problems.push('白名单包含危险动作')
    const forbiddenInCode = [['runcmdEx(\'gi', 've'], ['runcmdEx("gi', 've'], ['set', 'GameMode'], ['add', 'Item'], ['set', 'Health']]
      .map(pair => pair.join(''))
      .filter(s => fs.readFileSync(__filename, 'utf8').indexOf(s) >= 0)
    if (forbiddenInCode.length) problems.push('代码里出现危险调用: ' + forbiddenInCode.join(','))

    // 购买逻辑自测：桩玩家验证「扣费 -> 加时长 -> 余额不足拒绝」
    const stub = {
      xuid: '__selftest__',
      realName: '__selftest__',
      pos: { x: 0, y: 0, z: 0 },
      bal: 1000,
      tell: function () {},
      getMoney: function () { return this.bal },
      reduceMoney: function (n) { if (this.bal < n) return false; this.bal -= n; return true }
    }
    const cost = CFG.price.minMinutes * CFG.price.perMinute
    const r1 = purchase(stub, CFG.price.minMinutes)
    if (!r1.ok) problems.push('正常购买失败: ' + r1.msg)
    else if (stub.bal !== 1000 - cost) problems.push('扣费金额不对: ' + stub.bal)
    else notes.push('购买 ' + CFG.price.minMinutes + ' 分钟扣 ' + cost + '，余额 ' + stub.bal)
    stub.bal = cost - 1
    const r2 = purchase(stub, CFG.price.minMinutes)
    if (r2.ok) problems.push('余额不足时仍然购买成功')
    else notes.push('余额不足被拒')
    if (state.players.__selftest__) { delete state.players.__selftest__; save() }
    if (live.__selftest__) { delete live.__selftest__ }

    reply(problems.length
      ? ('FAIL: ' + problems.join(' | '))
      : ('PASS: 护栏完整，白名单 ' + ALLOWED_SIM.length + ' 项；' + notes.join('；')))
    return
  }
  reply('用法: /aiadmin status|grant <玩家> <分钟>|spawn <玩家>|dismiss <玩家>|rename <新名>|navtest|selftest')
})
// 授权：aigrant <玩家> <分钟>
const cmdGrant = mc.newCommand('aigrant', '给玩家增加 AI 助手服务时长', PermType.GameMasters)
cmdGrant.mandatory('name', ParamType.String)
cmdGrant.mandatory('minutes', ParamType.Int)
cmdGrant.overload(['name', 'minutes'])
cmdGrant.setCallback((_cmd, origin, output, res) => {
  const name = String(res.name || '')
  const mins = parseInt(res.minutes, 10)
  const pl = mc.getPlayer(name)
  if (!pl) { output.error('玩家不在线: ' + name); return }
  if (!mins || mins <= 0) { output.error('分钟数不对'); return }
  const e = ensureEntry(pl)
  e.expireAt = Math.max(e.expireAt || 0, now()) + mins * 60000
  save()
  audit('GRANT', '管理员给 ' + pl.realName + ' 增加 ' + mins + ' 分钟')
  output.success('已给 ' + pl.realName + ' 增加 ' + mins + ' 分钟，剩余 ' + fmtMin(remainingMs(pl)))
})
cmdGrant.setup()

// 运维：aibuy <玩家> <分钟>（走真实扣费）；aimoney <玩家> <金额>；aimoneycheck <玩家>
const cmdBuy2 = mc.newCommand('aibuy', '替玩家走一次真实购买流程（扣费）', PermType.GameMasters)
cmdBuy2.mandatory('name', ParamType.String)
cmdBuy2.mandatory('minutes', ParamType.Int)
cmdBuy2.overload(['name', 'minutes'])
cmdBuy2.setCallback((_cmd, origin, output, res) => {
  const pl = mc.getPlayer(String(res.name || ''))
  if (!pl) { output.error('玩家不在线'); return }
  const r = purchase(pl, parseInt(res.minutes, 10))
  if (r.ok) output.success(r.msg); else output.error(r.msg)
})
cmdBuy2.setup()

// 测试辅助命令：aibuyx 已移除（控制台无法解析纯数字 String 参数），购买逻辑由 aiadmin selftest 覆盖

cmdAdmin.setup()



// ---------- 聊天问答 ----------
mc.listen('onChat', (player, msg) => {
  try {
    const text = String(msg || '').replace(/§./g, '').trim()
    if (!text) return true
    let hit = null
    for (const t of CFG.triggers) {
      if (text.indexOf(t) === 0) { hit = text.slice(t.length).replace(/^[：:，,、\s]+/, ''); break }
    }
    if (hit === null) return true
    if (!hit) { player.tell('§7[AI 助手] 直接问吧，例如：' + CFG.assistantName + ' 怎么做下界合金'); return true }

    // 聊天里直接购买：小鲸 购买 30
    const buy = /^(购买|买|buy)\s*(\d+)$/.exec(hit)
    if (buy) {
      const r = purchase(player, parseInt(buy[2], 10))
      player.tell((r.ok ? '§a' : '§c') + '[AI 助手] ' + r.msg)
      return true
    }

    // 聊天里改名：小把 改名 小蓝
    const ren = /^(?:改名|改名为|改名叫|名字改成|就叫)\s*(\S.*)$/.exec(hit)
    if (ren) {
      const want = ren[1]
      if (live[keyOf(player)] && live[keyOf(player)].sp) {
        const r = renameOwnAssistant(player, want)
        player.tell((r.ok ? '§a' : '§c') + '[AI 助手] ' + r.msg)
      } else {
        let isAdmin = false
        try { isAdmin = !!player.isOP() } catch (e) {}
        if (isAdmin) {
          const r = renameResident(want, player.realName)
          player.tell((r.ok ? '§a' : '§c') + '[AI 助手] ' + r.msg)
        } else {
          player.tell('§e[AI 助手] 常驻那只只有管理员能改名；买了专属服务的用 /ai 改名 <新名字> 改自己那只')
        }
      }
      return true
    }

    const ms = remainingMs(player)
    const free = CFG.resident.enabled && CFG.resident.freeChat && residentAlive()
    if (ms <= 0 && !free) {
      player.tell('§e[AI 助手] 服务需要购买：/ai 购买 <分钟>（' + CFG.price.perMinute + ' ' + CFG.price.currency + '/分钟）')
      return true
    }
    if (handleMoveIntent(player, hit)) return true
    const chatLimit = ms > 0 ? CFG.limits.chatPer10Min : (CFG.resident.chatPer10Min || 12)
    if (!chatAllowed(player.xuid, chatLimit)) {
      player.tell('§e[AI 助手] 问得太快了，歇一会儿再问（10 分钟内最多 ' + chatLimit + ' 次）')
      return true
    }
    noteChat(player.xuid)
    const extra = (ms > 0 ? '专属服务剩余 ' + fmtMin(ms) : '公共助手免费') + '。在线 ' + mc.getOnlinePlayers().length + ' 人。'
    askLLM(hit, player.realName, extra).then((ans) => {
      if (!ans) { player.tell('§c[AI 助手] 我这边没想出答案，稍后再问一次'); return }
      say(ans)
      audit('CHAT', player.realName + ' 问: ' + hit.slice(0, 80) + ' -> 答: ' + cleanReply(ans).slice(0, 80))
    })
  } catch (e) {
    audit('ERROR', '聊天处理异常: ' + e.message)
  }
  return true
})

// ---------- 玩家离线清理 ----------
mc.listen('onLeft', (player) => {
  const item = live[keyOf(player)]
  if (item) { item.mode = 'idle' }
})

// ---------- 启动 ----------
if (!loadKey()) audit('START', '警告：模型 key 未加载，聊天问答将不可用（检查 ' + CFG.llm.keyFile + '）')
if (CFG.resident.enabled) {
  setTimeout(function () { try { spawnResident() } catch (e) { audit('RESIDENT', '召唤异常: ' + e.message) } }, 8000)
  setInterval(ensureResident, 30000)
  mc.listen('onJoin', function () { try { ensureResident() } catch (e) {} })
  audit('RESIDENT', '常驻模式已启用：' + residentName() + '，免费聊天=' + CFG.resident.freeChat + '，可指挥=' + CFG.resident.allowMove)
}
audit('START', 'ai-assistant v1.3.0 已加载：价格 ' + CFG.price.perMinute + '/' + CFG.price.currency + ' 每分钟，助手 ' + CFG.assistantName + '（可改名），常驻 ' + residentName() + '，动作白名单 ' + ALLOWED_SIM.length + ' 项')

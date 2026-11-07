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
  assistantName: '小鲸',
  llm: { url: 'http://127.0.0.1:8788/v1/chat/completions', keyFile: 'plugins/ai-assistant/llm.key', model: 'deepseek-v4.1-flash', timeoutMs: 45000, maxTokens: 400 },
  price: { perMinute: 20, minMinutes: 10, maxMinutes: 240, currency: '金币' },
  limits: { chatPer10Min: 20, actionsPerMinute: 30, followStopDistance: 3.0, followSpeed: 0.8, maxAssistants: 3, maxMoveDistance: 48, moveSpeed: 0.9, gotoStopDistance: 2.0 },
  resident: { enabled: true, name: '小鲸', freeChat: true, allowMove: true, chatPer10Min: 30, spawn: null, chatter: { enabled: true, chance: 0.45, idleMinMs: 150000, idleMaxMs: 360000, interjectCooldownMs: 25000 } },
  triggers: ['小鲸', '@小鲸', '!ai'],
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
  if (bal === null) {
    let g = false, r = false
    try { g = typeof pl.getMoney === 'function' } catch (e) {}
    try { r = typeof pl.reduceMoney === 'function' } catch (e) {}
    audit('BUY_FAIL', pl.realName + ' 读不到余额 | getMoney=' + g + ' reduceMoney=' + r + ' xuid=' + (pl.xuid || '空'))
    return { ok: false, msg: '读取不到你的余额，请联系服主（经济插件接口不可用）' }
  }
  if (bal < cost) { audit('BUY_FAIL', pl.realName + ' 余额不足：' + bal + ' < ' + cost); return { ok: false, msg: '余额不足：需要 ' + cost + ' ' + CFG.price.currency + '，你只有 ' + bal } }
  if (!reduceMoney(pl, cost)) { audit('BUY_FAIL', pl.realName + ' 扣费失败，余额 ' + bal); return { ok: false, msg: '扣费失败，请稍后再试或联系服主' } }
  const e = ensureEntry(pl)
  e.expireAt = Math.max(e.expireAt || 0, now()) + mins * 60000
  e.bought = (e.bought || 0) + mins
  save()
  audit('BUY', pl.realName + ' 购买 ' + mins + ' 分钟，花费 ' + cost + '，余额 ' + bal + ' -> 到期 ' + new Date(e.expireAt).toISOString())
  return { ok: true, msg: '购买成功：' + mins + ' 分钟，花费 ' + cost + ' ' + CFG.price.currency + '，服务剩余 ' + fmtMin(remainingMs(pl)) }
}

// ---------- 反作弊：助手动作白名单 ----------
const ALLOWED_SIM = ['simulateMoveTo', 'simulateNavigateTo', 'simulateLookAt', 'simulateStopMoving', 'simulateJump', 'simulateSneak',
  // 战斗/交互（v1.4.0）：只允许打非玩家实体、只允许用手里的物品，禁止任何破坏方块的白名单外动作
  'simulateAttack', 'simulateInteract', 'simulateUseItem', 'simulateSwing']
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

// 服务器里正在线的助手总数：付费的 + 常驻的那个（常驻也算一个名额）
function assistantTotal () {
  let n = 0
  try { Object.keys(live).forEach(function (k) { const it = live[k]; if (it && aliveSp(it.sp)) n++ }) } catch (e) {}
  try { if (CFG.resident && CFG.resident.enabled && residentAlive()) n++ } catch (e) {}
  return n
}

// 付费助手能用的名额：常驻在场就给它留一个位置
function paidSlotCap () {
  const max = Number(CFG.limits.maxAssistants) || 3
  const reserve = (CFG.resident && CFG.resident.enabled) ? 1 : 0
  return Math.max(1, max - reserve)
}

function spawnAssistant (player) {
  const e = ensureEntry(player)
  if (live[keyOf(player)] && live[keyOf(player)].sp && aliveSp(live[keyOf(player)].sp)) return { ok: false, msg: '助手已经在你身边了' }
  if (live[keyOf(player)]) { try { dropEntity(live[keyOf(player)].sp) } catch (e0) {} delete live[keyOf(player)] }
  if (liveCount() >= paidSlotCap() || assistantTotal() >= CFG.limits.maxAssistants) return { ok: false, msg: '§e服务器里最多同时 ' + CFG.limits.maxAssistants + ' 个助手（含常驻的 §b' + residentName() + '§e），现在满了，等别人下线再试' }
  const pos = player.pos
  let name = assistantNameFor(player)
  const bx = Math.floor(pos.x) + 1
  const by = Math.floor(pos.y)
  const bz = Math.floor(pos.z) + 1
  let dim = 0
  try { if (pos && typeof pos.dim === 'number') dim = pos.dim } catch (e) {}
  if (!dim) { try { if (typeof player.dimid === 'number') dim = player.dimid } catch (e) {} }
  let sp = null
  const shapes = [
    function (nm) { return mc.spawnSimulatedPlayer(nm, bx, by, bz, dim) },
    function (nm) { return mc.spawnSimulatedPlayer(nm, bx, by, bz) },
    function (nm) { return mc.spawnSimulatedPlayer(nm, { x: bx, y: by, z: bz, dim: dim }) }
  ]
  const cands = [name, name + '2', name + '3', name + '4', name + '5']
  for (let c = 0; c < cands.length && !sp; c++) {
    for (let i = 0; i < shapes.length && !sp; i++) {
      try { sp = shapes[i](cands[c]); if (sp) { name = cands[c]; audit('SPAWN', '召唤成功（' + name + '，参数形态 ' + (i + 1) + '，维度 ' + dim + '）') } } catch (err) { audit('SPAWN', '形态 ' + (i + 1) + ' 失败: ' + err.message) }
    }
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
  try { audit('SITUATION', '刚出生时的处境: ' + (situationOf(resident) || '取不到')) } catch (e) { audit('SITUATION', '处境探测异常: ' + e.message) }
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

// ---------- 水里自救 ----------
// 模拟玩家不会游泳：进水里会往下沉，寻路解不出来，表现就是「卡住」。
// 对策：脚下是液体就持续跳（水里跳=往上划），并给寻路抬高目标点。
function liquidAt (sp) {
  try {
    const b = (typeof sp.getBlock === 'function') ? sp.getBlock() : (sp.block || null)
    if (!b) return ''
    let liq = false
    try { if (typeof b.isLiquid === 'boolean') liq = b.isLiquid } catch (e) {}
    const t = String(b.type || '')
    if (!liq && !/water|lava/.test(t)) return ''
    return t || 'liquid'
  } catch (e) { return '' }
}

function inLiquid (sp) {
  return !!liquidAt(sp)
}

// ---------- 环境感知：让它知道自己在哪、在干什么 ----------
// 之前它说话全是「诶」「怎么啦」这种，因为它对周围一无所知：不知道自己在哪、
// 白天黑夜、脚下是什么、旁边有谁、刚被打过还是刚打完怪。这里把这些搓成一句
// 中文描述塞进提示词，让它能接上环境（比如「天黑了你还站河边发呆」）。
const recentEvents = []
function noteEvent (text) {
  try {
    const t = String(text || '').slice(0, 40)
    if (!t) return
    recentEvents.push({ at: now(), text: t })
    while (recentEvents.length > 12) recentEvents.shift()
  } catch (e) {}
}
function recentEventsText (spanMs) {
  try {
    const from = now() - (Number(spanMs) || 180000)
    const arr = recentEvents.filter(e => e.at >= from).slice(-3).map(e => e.text)
    return arr.join('、')
  } catch (e) { return '' }
}

function dimLabel (d) {
  try {
    if (typeof mc.getDimensionName === 'function') {
      const n = String(mc.getDimensionName(d) || '').replace('minecraft:', '').toLowerCase()
      if (n === 'overworld') return '主世界'
      if (n === 'nether') return '下界'
      if (n === 'the_end' || n === 'theend' || n === 'end') return '末地'
      if (n) return n
    }
  } catch (e) {}
  return ['主世界', '下界', '末地'][Number(d)] || ('维度' + d)
}

function timeLabel (dim) {
  try {
    if (typeof mc.getTime !== 'function') return ''
    const t = Number(mc.getTime(dim))
    if (!isFinite(t)) return ''
    const m = ((t % 24000) + 24000) % 24000
    if (m < 1000) return '清晨'
    if (m < 5000) return '白天'
    if (m < 11000) return '下午'
    if (m < 13000) return '黄昏'
    if (m < 18000) return '夜里'
    return '深夜'
  } catch (e) { return '' }
}

function shortBlock (b) {
  try {
    if (!b) return ''
    const t = String(b.type || b.name || '')
    if (!t) return ''
    return t.replace('minecraft:', '')
  } catch (e) { return '' }
}

const BIOME_ZH = {
  ocean: '海洋', deep_ocean: '深海', warm_ocean: '温暖海洋', lukewarm_ocean: '温水海洋', cold_ocean: '寒冷海洋',
  frozen_ocean: '冻洋', deep_frozen_ocean: '冻深海', river: '河流', beach: '沙滩', stone_beach: '石岸',
  plains: '平原', sunflower_plains: '向日葵平原', forest: '森林', birch_forest: '桦木森林',
  dark_forest: '黑森林', taiga: '针叶林', cold_taiga: '冷针叶林', savanna: '热带草原', desert: '沙漠',
  jungle: '丛林', swamp: '沼泽', mangrove_swamp: '红树林沼泽', cherry_grove: '樱花林',
  meadow: '草甸', grove: '林地', snowy_plains: '雪原', snowy_taiga: '积雪针叶林', ice_plains: '冰原',
  mountains: '山地', jagged_peaks: '尖峭山峰', frozen_peaks: '冰封山峰', stony_peaks: '裸岩山峰',
  hills: '丘陵', extreme_hills: '风袭丘陵', mushroom_fields: '蘑菇岛',
  the_end: '末地', end_barrens: '末地荒地', nether_wastes: '下界荒地', soul_sand_valley: '灵魂沙峡谷',
  crimson_forest: '绯红森林', warped_forest: '诡异森林', basalt_deltas: '玄武岩三角洲',
  roofed_forest: '黑森林', forest_hills: '森林丘陵', taiga_hills: '针叶林丘陵',
  jungle_hills: '丛林丘陵', birch_forest_hills: '桦木森林丘陵', giant_tree_taiga: '巨型针叶林',
  cold_taiga_hills: '冷针叶林丘陵', mega_taiga: '原始针叶林', savanna_plateau: '热带草原高原',
  desert_hills: '沙漠丘陵', stone_shore: '石岸', cold_beach: '寒冷沙滩', warm_biome: '温暖水域',
  lukewarm_biome: '温水水域', deep_lukewarm_ocean: '温水深海', legacy_frozen_ocean: '冻洋',
  bamboo_jungle: '竹林', sunflower: '向日葵平原', flower_forest: '繁花森林', ice_spikes: '冰刺之地'
}

function biomeLabel (sp) {
  try {
    if (typeof sp.getBiomeName !== 'function') return ''
    const raw = String(sp.getBiomeName() || '').replace('minecraft:', '').toLowerCase()
    if (!raw) return ''
    return BIOME_ZH[raw] || raw
  } catch (e) { return '' }
}

// 把助手此刻的处境拼成一句话；任何一项取不到就跳过，绝不让它抛异常
function situationOf (item) {
  const parts = []
  const sp = item && item.sp
  if (!sp) return ''
  let dim = 0
  try {
    const p = sp.pos
    dim = Number(p.dimid) || 0
    parts.push(dimLabel(dim) + ' ' + Math.round(p.x) + ',' + Math.round(p.y) + ',' + Math.round(p.z))
  } catch (e) {}
  try {
    const tl = timeLabel(dim)
    if (tl) parts.push(tl)
  } catch (e) {}
  try {
    const bio = biomeLabel(sp)
    if (bio) parts.push('群系 ' + bio)
  } catch (e) {}
  try {
    if (typeof sp.getBlockStandingOn === 'function') {
      const s = shortBlock(sp.getBlockStandingOn())
      // 注意：这个 API 取到的经常是脚部所在格（站立时本来就是空气），所以只在明确是水/岩浆时才写
      if (s && (s === 'water' || s === 'flowing_water')) parts.push('泡在水里')
      else if (s && (s === 'lava' || s === 'flowing_lava')) parts.push('泡在岩浆里')
      else if (s && s !== 'air') parts.push('脚踩 ' + s)
    }
  } catch (e) {}
  try {
    if (typeof sp.getHealth === 'function') {
      const h = Number(sp.getHealth())
      if (isFinite(h)) {
        let mh = 20
        try { if (typeof sp.getMaxHealth === 'function') mh = Number(sp.getMaxHealth()) || 20 } catch (e) {}
        parts.push('血量 ' + Math.round(h) + '/' + Math.round(mh))
      }
    }
  } catch (e) {}
  try { if (inLiquid(sp)) parts.push('泡在水里') } catch (e) {}

  // 它在干什么
  const doing = []
  if (item.mode === 'follow') doing.push('正跟着 ' + (item.targetName || '主人'))
  else if (item.mode === 'goto') doing.push('正走去一个点')
  if (item.swimTill && now() < item.swimTill) doing.push('正在往上游')
  if (false) doing.push('')
  if (item.autoPlace) doing.push('开自动放置')
  if (item.stall && item.stall >= 3) doing.push('刚卡住过')
  if (!doing.length) doing.push('闲着没事干')
  parts.push(doing.join('、'))

  try {
    const others = mc.getOnlinePlayers()
      .filter(p => { try { return p.realName !== item.name } catch (e) { return false } })
      .map(p => p.realName)
    if (others.length) parts.push('服里还有 ' + others.slice(0, 3).join('、') + (others.length > 3 ? ' 等 ' + others.length + ' 人' : ''))
    else parts.push('服里没别人')
  } catch (e) {}
  try {
    const e = nearestHostile(sp, 8)
    if (e) parts.push('旁边有' + shortBlock({ type: e.type }))
  } catch (e) {}
  const rec = recentEventsText()
  if (rec) parts.push('刚刚：' + rec)
  return parts.join('，')
}

function startSwim (item, ms, why) {
  if (!item || !item.sp) return
  const until = now() + (Number(ms) || 5000)
  const already = item.swimTill && item.swimTill > now()
  if (!item.swimTill || item.swimTill < until) item.swimTill = until
  if (already) return
  audit('SWIM', '助手开始上浮（' + (why || '入水') + '）pos=' + Math.round(item.sp.pos.x) + ',' + Math.round(item.sp.pos.y) + ',' + Math.round(item.sp.pos.z))
  try { noteEvent('掉水里了，正在往上游') } catch (e) {}
}

// 250ms 顶一次，直到出水或超时
setInterval(() => {
  const items = Object.keys(live).map(function (k) { return live[k] }).filter(function (i) { return i && i.sp })
  if (resident && resident.sp) items.push(resident)
  for (const item of items) {
    try {
      if (!item.swimTill || now() >= item.swimTill) continue
      const sp = item.sp
      safeSim(sp, 'simulateJump', [])
      const p = sp.pos
      try { moveToPos(sp, p.x, p.y + 2, p.z) } catch (e) {}
      if (!inLiquid(sp)) item.swimTill = 0
    } catch (e) {}
  }
}, 250)

// 兜底巡检：任何助手泡在液体里就自己开始自救
setInterval(() => {
  const items = Object.keys(live).map(function (k) { return live[k] }).filter(function (i) { return i && i.sp })
  if (resident && resident.sp) items.push(resident)
  for (const item of items) {
    try {
      if (inLiquid(item.sp) && !(item.swimTill && now() < item.swimTill)) startSwim(item, 6000, '巡检发现入水')
    } catch (e) {}
  }
}, 10000)

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
    if (remainingMs(pl) <= 0) { pl.tell('§c[AI 助手] §f你还没有服务时长——按 §b/ai 菜单 §f点「§a购买时长§f」买（' + CFG.price.perMinute + ' 金币/分钟）'); return true }
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
    startFollow(item, pl)
    pl.tell('§a[AI 助手] ' + item.name + ' 开始跟着你')
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
    function (nm) { return mc.spawnSimulatedPlayer(nm, bx, by, bz, dim) },
    function (nm) { return mc.spawnSimulatedPlayer(nm, bx, by, bz) },
    function (nm) { return mc.spawnSimulatedPlayer(nm, { x: bx, y: by, z: bz, dim: dim }) }
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
  if (!item || !item.sp) return { ok: false, msg: '你还没有专属助手（先在 /ai 菜单 里点「购买时长」买时长，再点「召唤 / 上线助手」）' }
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
          if (item.stall >= 14 && !inLiquid(item.sp)) {
            item.mode = 'idle'
            item.target = null
            item.stall = 0
            audit('STALL', '放弃前往（连续卡住）pos=' + Math.round(spPos.x) + ',' + Math.round(spPos.y) + ',' + Math.round(spPos.z))
            const owner2 = mc.getPlayer(item.targetName)
            if (owner2) owner2.tell('§c[AI 助手] ' + item.name + ' 被挡住了，走不到那里')
            continue
          }
          const liquid = inLiquid(item.sp)
          if (liquid) startSwim(item, 4000, '前往目标时泡在水里')
          const navReady = navBroken ? true : (now() - (item.navAt || 0) >= 2500)
          if (navReady) {
            const navY = liquid ? spPos.y + 2 : spPos.y
            if (navTo(item.sp, item.target.x + 0.5, navY, item.target.z + 0.5)) item.navAt = now()
          }
        }
      } catch (e) {}
      continue
    }
    if (item.mode !== 'follow') continue
    try { followStep(item) } catch (eF) {}
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

function tellLines (pl, text) {
  const s = String(text || '')
  if (!s) return
  const arr = s.split('\n')
  for (let i = 0; i < arr.length; i++) {
    if (!arr[i]) continue
    try { pl.tell(arr[i]) } catch (e) {}
  }
}

function say (text, kind) {
  const t = cleanReply(text)
  if (!t) return
  lastResidentSayAt = now()
  try { mc.broadcast('§b[' + CFG.assistantName + '] §f' + t) } catch (e) {}
  // 自言自语 / 旁听搭话只留在游戏里，别一股脑倒进 QQ 群（群里看着就像它在刷屏碎碎念）
  if (kind === 'idle' || kind === 'interject') {
    const c = (CFG.resident && CFG.resident.chatter) || {}
    const gap = Number(kind === 'idle' ? (c.mirrorIdleMs || 1800000) : (c.mirrorInterjectMs || 300000))
    if (now() - (kind === 'idle' ? lastIdleMirrorAt : lastInterjectMirrorAt) < gap) return
    if (kind === 'idle') lastIdleMirrorAt = now()
    else lastInterjectMirrorAt = now()
  }
  mirrorToQQ(t)
}

// 把助手在游戏里说的话同步到 QQ 群（经 QQMCBridge 本地接口；失败只写审计，不影响游戏）
let bridgeConf = null
let bridgeConfAt = 0
function bridgeEndpoint () {
  const t = now()
  if (!bridgeConf || t - bridgeConfAt > 60000) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'QQMCBridge', 'config.json'), 'utf8'))
      bridgeConf = { port: Number(j.local_port) || 10724, token: String(j.local_token || 'QQMCBridgeLocalToken') }
    } catch (e) {
      bridgeConf = { port: 10724, token: 'QQMCBridgeLocalToken' }
    }
    bridgeConfAt = t
  }
  return bridgeConf
}

function mirrorToQQ (text) {
  if (CFG.mirrorToQQ === false) return
  try {
    const b = bridgeEndpoint()
    const body = JSON.stringify({ sender: CFG.assistantName, content: text })
    const req = http.request({
      host: '127.0.0.1',
      port: b.port,
      path: '/qqmcbridge/say',
      method: 'POST',
      timeout: 3000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-QQMC-Token': b.token
      }
    }, (res) => { res.resume() })
    req.on('error', (e) => audit('QQ_MIRROR_FAIL', String(e && e.message)))
    req.on('timeout', () => { try { req.destroy() } catch (e) {} })
    req.write(body)
    req.end()
  } catch (e) {
    audit('QQ_MIRROR_FAIL', String(e && e.message))
  }
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

  if (action === '菜单' || action === 'menu') { openMenu(pl); return }
  if (action === '购买菜单' || action === 'buyform') { openBuyForm(pl); return }
  if (action === '诊断' || action === 'diag') { diagnose(pl); return }
  if (action === '自动攻击' || action === 'attack' || action === '自动放置' || action === 'place') {
    const it = itemFor(pl)
    if (!it) { pl.tell('§c[AI 助手] 助手不在你身边，先 /ai 召唤'); return }
    const isAttack = (action === '自动攻击' || action === 'attack')
    const label = isAttack ? '自动攻击' : '自动放置'
    if (!arg) {
      // 不写参数就切换
      it[isAttack ? 'autoAttack' : 'autoPlace'] = !it[isAttack ? 'autoAttack' : 'autoPlace']
      pl.tell('§a[AI 助手] ' + it.name + ' 的' + label + '已' + (it[isAttack ? 'autoAttack' : 'autoPlace'] ? '开启' : '关闭'))
      audit('TOGGLE', label + '=' + (it[isAttack ? 'autoAttack' : 'autoPlace'] ? 'on' : 'off') + ' for ' + pl.realName)
      return
    }
    toggleFlag(pl, it, isAttack ? 'autoAttack' : 'autoPlace', label, arg)
    return
  }

  if (action === '帮助' || action === 'help' || action === '') {
    const BAR = '§9§m                                §r'
    const H = function (t) { pl.tell(BAR); pl.tell(t) }
    const L = function (cmd, desc) { pl.tell(' §b▸ §f' + cmd + ' §9— §b' + desc) }
    pl.tell('§b§l✦ AI 助手 ✦ §8v1.5.0  §7买时长 · 指挥 · 商店 · 记忆')
    H('§e§l基础')
    L('/ai 菜单', '§a图形菜单（推荐，所有功能都在里面）')
    L('/ai 菜单 → 购买时长', '用' + CFG.price.currency + '买服务时长（' + CFG.price.perMinute + '/分钟，最少 ' + CFG.price.minMinutes + '）；也可以在聊天里说「' + CFG.assistantName + ' 买 30」')
    L('/ai 剩余', '看服务剩余时间')
    H('§b§l指挥')
    L('/ai 召唤', '把助手叫到身边')
    L('/ai 过来', '让它走到你身边')
    L('/ai 跟随', '让它跟着你')
    L('/ai 停下', '原地待命')
    L('/ai 跳 · /ai 看向我', '做个小动作')
    L('/ai 上来', '卡在水里时让它浮上来')
    L('/ai 去 <x> <y> <z>', '走到指定坐标（最远 ' + (CFG.limits.maxMoveDistance || 48) + ' 格）')
    L('/ai 离开', '让它走')
    H('§6§l自动')
    L('/ai 自动攻击 on|off', '自动打附近的怪（只打怪，不打玩家）')
    L('/ai 自动放置 on|off', '每秒用手里的物品（放方块 / 吃东西）')
    L('/ai 钓鱼', '开关自动钓鱼（它手里要拿钓竿）')
    H('§a§l商店')
    L('查价 <物品>', '问官方商店卖多少、回收多少')
    L('买 <物品> [数量]', '直接下单扣款（钱够、背包放得下才成）')
    L('卖 <物品> [数量]', '直接回收换钱（0 = 有多少卖多少）')
    H('§d§l记忆 / 统计')
    L('记住 xxx', '让它记住你的事（下次聊天会带上）')
    L('你记得我什么', '看它记了什么 · §f忘记 xxx §8— §7抹掉一条')
    L('我挖了多少', '读行为日志，报近 24 小时的破坏/放置/捡起/死亡')
    L('我死在哪', '上次死亡坐标（死了它会主动告诉你）')
    L('我多少钱 · 利率', '查余额 · 查银行利率')
    H('§7§l其它')
    L('/ai 诊断', '买不了 / 不动 / 查不到钱时看这里')
    L('/ai 改名 <新名字>', '给你的专属助手改名（1-8 字，例如 /ai 改名 小蓝）')
    L(CFG.assistantName + ' <你的问题>', '聊天框直接问它')
    pl.tell(BAR)
    if (CFG.resident.enabled) pl.tell('§e公共 §b' + residentName() + '§e 常驻在线：不买也能聊、也能指挥它走位')
    return
  }

  if (action === '剩余' || action === 'balance') {
    const ms = remainingMs(pl)
    pl.tell('§b[AI 助手] ' + (ms > 0 ? '专属服务剩余 ' + fmtMin(ms) : '你还没有购买专属服务（按 /ai 菜单 点「购买时长」）'))
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
      if (CFG.resident.enabled && residentAlive()) { pl.tell('§a[AI 助手] 公共' + residentName() + '已经在场上了，直接说「' + CFG.assistantName + ' 过来」或「' + CFG.assistantName + ' 跟随」；想要专属的再按 /ai 菜单 点「购买时长」买') ; return }
      pl.tell('§c[AI 助手] §f你还没有服务时长——按 §b/ai 菜单 §f点「§a购买时长§f」买（' + CFG.price.perMinute + ' 金币/分钟）'); return
    }
    const r = spawnAssistant(pl)
    pl.tell((r.ok ? '§a' : '§c') + '[AI 助手] ' + r.msg)
    return
  }

  if (action === '上来' || action === '上浮' || action === 'swim') {
    const item = itemFor(pl)
    if (!item) { pl.tell('§c[AI 助手] 助手不在你身边，先 /ai 召唤'); return }
    startSwim(item, 10000, '玩家指挥上浮')
    item.mode = 'idle'
    item.target = null
    pl.tell('§a[AI 助手] ' + item.name + ' 正在挣扎着往上浮…')
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
    startFollow(item, pl)
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

  if (runExtAction(pl, action, arg)) return
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
    reply('助手在线 ' + assistantTotal() + '/' + CFG.limits.maxAssistants + '（含常驻）' + '；付费玩家 ' + Object.keys(state.players).length + '；模型 key ' + (LLM_KEY ? '已加载' : '缺失') + '；动作白名单 ' + ALLOWED_SIM.join(','))
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
    try { noteEvent(player.realName + ' 在游戏里说话') } catch (e) {}
    let hit = null
    for (const t of CFG.triggers) {
      if (text.indexOf(t) === 0) { hit = text.slice(t.length).replace(/^[：:，,、\s]+/, ''); break }
    }
    if (hit === null) {
      // 不带唤醒词也能用的固定指令（查价 / 买卖 / 记忆 / 统计 …）
      if (handleExtIntent(player, text)) return true
      maybeInterject(player, text)
      return true
    }
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
      player.tell('§e[AI 助手] 先买时长：按 §b/ai 菜单 §e点「§a购买时长§e」（' + CFG.price.perMinute + ' ' + CFG.price.currency + '/分钟）')
      return true
    }
    // 聊天里开菜单：小把罢 菜单
    if (/^(菜单|界面|menu|gui)$/.test(hit)) { openMenu(player); return true }
    if (handleMoveIntent(player, hit)) return true
    if (handleExtIntent(player, hit)) return true
    const chatLimit = ms > 0 ? CFG.limits.chatPer10Min : (CFG.resident.chatPer10Min || 12)
    if (!chatAllowed(player.xuid, chatLimit)) {
      player.tell('§e[AI 助手] 问得太快了，歇一会儿再问（10 分钟内最多 ' + chatLimit + ' 次）')
      return true
    }
    noteChat(player.xuid)
    const sit = situationOf(resident)
    const extra = (ms > 0 ? '专属服务剩余 ' + fmtMin(ms) : '公共助手免费') + '。在线 ' + mc.getOnlinePlayers().length + ' 人。'
      + '【你自己的真实处境，只能照这个说】' + (sit || '不清楚') + '。'
      + '（处境里没有的地点、建筑、物品、人，一律不许出现；问到你在干嘛、在哪、在做什么，就照处境里的写；处境说闲着就是闲着，不要编出爬楼梯、逛街、看星星这类没发生的事）'
    audit('SITUATION', '回答前的处境: ' + (sit || '取不到'))
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

// ---------- 主动说话（话多模式）----------
// 目标：不再“点名才吭声”。两个来源：旁听搭话（别人聊天时随机接一句）+ 自言自语（安静太久自己嘟囔）。
let lastResidentSayAt = 0
let lastIdleMirrorAt = 0
let lastInterjectMirrorAt = 0
let nextIdleAt = 0
let lastInterjectAt = 0

function chatterCfg () {
  const c = (CFG.resident && CFG.resident.chatter) || {}
  return {
    enabled: c.enabled !== false,
    chance: c.chance === undefined ? 0.45 : Number(c.chance),
    idleMinMs: Number(c.idleMinMs || 150000),
    idleMaxMs: Number(c.idleMaxMs || 360000),
    interjectCooldownMs: Number(c.interjectCooldownMs || 25000)
  }
}

function scheduleNextIdle () {
  const c = chatterCfg()
  const span = Math.max(1000, c.idleMaxMs - c.idleMinMs)
  nextIdleAt = now() + c.idleMinMs + Math.floor(Math.random() * span)
}

function residentCanTalk () {
  try { return CFG.resident.enabled && residentAlive() && mc.getOnlinePlayers().length > 0 } catch (e) { return false }
}

// 旁听搭话：玩家没叫它，也随机接一句
function maybeInterject (player, text) {
  const c = chatterCfg()
  if (!c.enabled || !residentCanTalk()) return
  if (Math.random() > c.chance) return
  if (now() - lastInterjectAt < c.interjectCooldownMs) return
  const limit = Number(CFG.resident.chatPer10Min) || 30
  if (!chatAllowed('resident_side', limit)) return
  lastInterjectAt = now()
  noteChat('resident_side')
  const q = '（旁听）玩家 ' + player.realName + ' 在聊天里说：' + String(text).slice(0, 60) + '。你顺口搭一句，别像客服，短一点'
  askLLM(q, player.realName, '在线 ' + mc.getOnlinePlayers().length + ' 人。【你自己的真实处境，只能照这个说】' + (situationOf(resident) || '不清楚') + '。').then((ans) => {
    if (!ans) return
    say(ans, 'interject')
    audit('CHATTER', '搭话 ' + player.realName + ': ' + String(text).slice(0, 40) + ' -> ' + cleanReply(ans).slice(0, 60))
  })
}

// 自言自语：安静太久自己嘟囔一句
setInterval(() => {
  try {
    if (!nextIdleAt) { scheduleNextIdle(); return }
    if (now() < nextIdleAt) return
    scheduleNextIdle()
    const c = chatterCfg()
    if (!c.enabled || !residentCanTalk()) return
    if (!chatAllowed('resident_idle', 8)) return
    noteChat('resident_idle')
    const pool = [
      '（自言自语）没人跟你说话，你随口嘟囔一句，特别短。可以顺带提一句你眼前的处境',
      '（自言自语）你在这儿待着有点闲，嘀咕一句。别喊话、别提问，最好能扯到你身边正在发生的事',
      '（自言自语）你想让人注意到你，小声说一句短的，可以吐槽一下你这会儿的处境'
    ]
    const sit = situationOf(resident)
    const extra = '别提问、别说教、别报数据、别像在汇报。'
      + (sit ? '你现在的处境（只用来借题发挥，不要逐条念出来，最多自然带进一两个细节）：' + sit + '。' : '')
    askLLM(pool[Math.floor(Math.random() * pool.length)], '自己', extra).then((ans) => {
      if (!ans) return
      say(ans, 'idle')
      audit('CHATTER', '自言自语 -> ' + cleanReply(ans).slice(0, 60))
    })
  } catch (e) {}
}, 20000)

// ---------- 玩家离线清理 ----------
mc.listen('onLeft', (player) => {
  const item = live[keyOf(player)]
  if (item) { item.mode = 'idle' }
})

// ================= v1.4.0 新增：跟随修复 / GUI 菜单 / 自动战斗 =================

// 跟随：必须记住主人是谁，否则 tick 里 mc.getPlayer(undefined) 直接跳过（旧版就是这个 bug）
function startFollow (item, pl) {
  if (!item || !pl) return false
  item.mode = 'follow'
  item.targetName = pl.realName
  item.target = null
  item.stall = 0
  item.navAt = 0
  audit('MOVE', 'follow -> ' + pl.realName)
  return true
}

// 实体查询：LSE 各版本签名不一样，按可用性依次尝试，成功后缓存
let entityProbe = null
function nearbyEntities (sp, radius) {
  const r = Number(radius) || 8
  const tries = [
    function () { return level.getEntities(r) },
    function () { return level.getEntities(null, r) },
    function () { return level.getEntities('minecraft:zombie', r) },
    function () { return sp.getEntities(r) },
    function () { return mc.getEntities(r) }
  ]
  for (let i = 0; i < tries.length; i++) {
    if (entityProbe !== null && entityProbe !== i) continue
    try {
      const list = tries[i]()
      if (Array.isArray(list)) { entityProbe = i; return list }
    } catch (e) {}
  }
  if (entityProbe !== null) entityProbe = -1
  return []
}

function isHostileEntity (e) {
  try {
    if (!e) return false
    if (typeof e.isPlayer === 'function' && e.isPlayer()) return false
    const t = String(e.type || '')
    if (t.indexOf('minecraft:player') >= 0) return false
    // 只打怪：排除掉落物/经验球/箭/船等非生物实体
    if (/(arrow|item|xp_orb|boat|minecart|tnt|snowball|fireball|egg|potion|fishing_hook)/.test(t)) return false
    return t.length > 0
  } catch (err) { return false }
}

function nearestHostile (sp, radius) {
  const spPos = sp.pos
  const list = nearbyEntities(sp, radius)
  let best = null
  let bestD = radius * radius
  for (const e of list) {
    try {
      if (!isHostileEntity(e)) continue
      const p = e.pos
      if (!p) continue
      const d = Math.pow(p.x - spPos.x, 2) + Math.pow(p.y - spPos.y, 2) + Math.pow(p.z - spPos.z, 2)
      if (d < bestD) { bestD = d; best = e }
    } catch (err) {}
  }
  return best
}

// 自动战斗/自动放置：每个助手独立开关，默认关闭
function autoCombatTick () {
  return // v1.7.0 已移除自动攻击
  const items = Object.keys(live).map(function (k) { return live[k] }).filter(function (i) { return i && i.sp })
  if (resident && resident.sp) items.push(resident)
  for (const item of items) {
    try {
      if (item.autoAttack) {
        const e = nearestHostile(item.sp, Number(item.attackRange) || 6)
        if (e) {
          safeSim(item.sp, 'simulateAttack', [e])
          item.lastHitAt = now()
          if (now() - (item.lastHitNote || 0) > 20000) {
            item.lastHitNote = now()
            noteEvent('刚跟一只' + shortBlock({ type: e.type }) + '打起来')
          }
        } else if (typeof item.sp.simulateSwing === 'function') {
          try { item.sp.simulateSwing() } catch (err) {}
        }
      }
      if (item.autoPlace) {
        safeSim(item.sp, 'simulateUseItem', [])
      }
    } catch (e) {}
  }
}
setInterval(autoCombatTick, 1000)

function toggleFlag (pl, item, key, label, arg) {
  const want = String(arg || '').toLowerCase()
  const on = /^(on|开|开启|true|1|)$/.test(want)
  const off = /^(off|关|关闭|false|0)$/.test(want)
  if (!on && !off) { pl.tell('§c用法：' + label + ' on|off'); return }
  item[key] = on
  pl.tell('§a[AI 助手] ' + item.name + ' 的' + label + '已' + (on ? '§a开启' : '§c关闭'))
  audit('TOGGLE', label + '=' + (on ? 'on' : 'off') + ' for ' + pl.realName)
}

// ---------- GUI 菜单 ----------
function runAction (pl, action, arg) {
  if (action === '购买' || action === 'buy') {
    const mm = parseInt(String(arg || '').replace(/[^0-9]/g, ''), 10)
    if (mm > 0) { const r = purchase(pl, mm); pl.tell((r.ok ? '§a' : '§c') + '[AI 助手] ' + (r.msg || (r.ok ? '买好了' : '没买成'))); return }
    return openBuyForm(pl)
  }
  if (action === '购买菜单') return openBuyForm(pl)
  if (action === '菜单') return openMenu(pl)
  if (action === '诊断') return diagnose(pl)
  if (action === '统计') { runExtAction(pl, '统计', arg); return }
  if (action === '钓鱼') { runExtAction(pl, '钓鱼', arg); return }
  if (action === '查价') { runExtAction(pl, '查价', arg); return }
  if (action === '买') { runExtAction(pl, '买', arg); return }
  if (action === '卖') { runExtAction(pl, '卖', arg); return }
  if (action === '自动攻击' || action === '自动放置' || action === '自动') {
    const item = itemFor(pl)
    if (!item) { pl.tell('§c[AI 助手] 助手不在你身边，先 /ai 召唤'); return }
    if (action === '自动') { item.autoAttack = !item.autoAttack; pl.tell('§a[AI 助手] 自动攻击已' + (item.autoAttack ? '开启' : '关闭')); return }
    if (action === '自动攻击') {
      item.autoAttack = !item.autoAttack
      pl.tell('§a[AI 助手] ' + item.name + ' 的自动攻击已' + (item.autoAttack ? '§a开启（只打怪，不打玩家）' : '§c关闭'))
      audit('TOGGLE', 'autoAttack=' + (item.autoAttack ? 'on' : 'off') + ' for ' + pl.realName)
      return
    }
    item.autoPlace = !item.autoPlace
    pl.tell('§a[AI 助手] ' + item.name + ' 的自动放置已' + (item.autoPlace ? '§a开启（每秒用手里的物品）' : '§c关闭'))
    audit('TOGGLE', 'autoPlace=' + (item.autoPlace ? 'on' : 'off') + ' for ' + pl.realName)
    return
  }
  const item = itemFor(pl)
  if (action === '上来') {
    if (!item) { pl.tell('§c[AI 助手] 助手不在你身边，先 /ai 召唤'); return }
    item.mode = 'idle'
    item.target = null
    startSwim(item, 10000, '菜单指挥上浮')
    pl.tell('§a[AI 助手] ' + item.name + ' 正在挣扎着往上浮…')
    return
  }
  if (action === '剩余') { pl.tell('§b[AI 助手] ' + (remainingMs(pl) > 0 ? '专属服务剩余 ' + fmtMin(remainingMs(pl)) : '还没有购买专属服务')); return }
  if (action === '召唤') {
    if (remainingMs(pl) <= 0) { pl.tell('§c[AI 助手] §f先按 §b/ai 菜单 §f点「§a购买时长§f」'); return }
    const r = spawnAssistant(pl); pl.tell((r.ok ? '§a' : '§c') + '[AI 助手] ' + r.msg); return
  }
  if (!item) { pl.tell('§c[AI 助手] 助手不在你身边，先 /ai 召唤'); return }
  if (action === '跟随') { startFollow(item, pl); pl.tell('§a[AI 助手] ' + item.name + ' 开始跟着你'); return }
  if (action === '过来') { goTo(pl, item, pl.pos.x, pl.pos.y, pl.pos.z, '过来'); return }
  if (action === '停下') { item.mode = 'idle'; item.target = null; safeSim(item.sp, 'simulateStopMoving', []); pl.tell('§a[AI 助手] ' + item.name + ' 原地待命'); return }
  if (action === '跳') { safeSim(item.sp, 'simulateJump', []); pl.tell('§a[AI 助手] ' + item.name + ' 跳了一下'); return }
  if (action === '看向我') { safeSim(item.sp, 'simulateLookAt', [pl]); pl.tell('§a[AI 助手] ' + item.name + ' 正看着你'); return }
  if (action === '离开') { dismissAssistant(keyOf(pl), '玩家要求离开'); pl.tell('§a[AI 助手] 助手已离开'); return }
}

function openMenu (pl) {
  if (!pl) return
  let form
  try { form = mc.newSimpleForm() } catch (e) { pl.tell('§c[AI 助手] 当前版本不支持表单，请用 /ai 帮助'); return }
  const item = itemFor(pl)
  const ms = remainingMs(pl)
  const DIV = '§9§m                                        §r'
  const lines = []
  lines.push(DIV)
  lines.push('§e§l状态')
  lines.push(' §b服务 §8|§f ' + (ms > 0 ? '剩余 ' + fmtMin(ms) : '未购买') + ' §9(' + CFG.price.perMinute + ' ' + CFG.price.currency + '/分钟)')
  const money = moneyOf(pl)
  lines.push(' §b余额 §8|§e ' + (money === null ? '读取不到（点诊断）' : money + ' ' + CFG.price.currency))
  lines.push(' §b助手 §8|§f ' + (item
    ? item.name + ' ' + (item.mode === 'follow' ? '§a[跟随中]' : '§e[待命]')
    : '§e未召唤'))
  lines.push(' §b在线 §8|§f ' + mc.getOnlinePlayers().length + ' 人   §b常驻 §8| ' + (residentAlive() ? '§a在线' : '§c不在'))
  lines.push(DIV)
  lines.push('§e点按钮操作 · 或聊天直接说 §f「' + CFG.assistantName + ' 跟随」')
  form.setTitle('§l§b✦ AI 助手 ✦')
  form.setContent(lines.join('\n'))
  const buttons = [
    ['§a§l购买时长', 'textures/items/gold_ingot'],
    ['§f剩余时间', 'textures/items/clock_item'],
    ['§b召唤 / 上线助手', 'textures/items/ender_pearl'],
    ['§b跟随我', 'textures/items/lead'],
    ['§d改名', 'textures/items/name_tag'],
    ['§f原地停下', 'textures/items/string'],
    ['§f跳一下', 'textures/items/rabbit_foot'],
    ['§b上浮 / 出水', 'textures/items/snowball'],
    ['§f看向我', 'textures/items/ender_eye'],
    ['§6商店查价 / 买卖', 'textures/items/emerald'],
    ['§d我的统计', 'textures/items/book_writable'],
    ['§f诊断信息', 'textures/items/compass_item'],
    ['§9返回主菜单', 'textures/ui/icon_import'],
    ['§c关闭', 'textures/blocks/barrier']
  ]
  buttons.forEach(function (b) { try { form.addButton(b[0], b[1]) } catch (e) { try { form.addButton(b[0]) } catch (e2) {} } })
  pl.sendForm(form, function (player, id) {
    if (id === undefined || id === null || id < 0) return
    const map = ['购买菜单', '剩余', '召唤', '跟随', '改名', '停下', '跳', '上来', '看向我', '商店', '统计', '诊断', '主菜单', '关闭']
    const act = map[id]
    if (!act || act === '关闭') { try { player.tell('§b[AI 助手] §f已关闭菜单') } catch (e) {} return }
    if (act === '改名') { try { openRenameForm(player) } catch (e) { player.tell('§c[AI 助手] 改名表单打不开') } return }
    if (act === '主菜单') {
      try { player.runcmd('menu') } catch (e) { player.tell('§c[AI 助手] 主菜单打开失败（CMENU 未装或命令被占用）') }
      return
    }
    if (act === '商店') {
      player.tell('§9§m────────────────────────────')
      player.tell('§6§l商城')
      player.tell(' §b查价 §8|§f 查价 石头')
      player.tell(' §b购买 §8|§f 买 面包 3')
      player.tell(' §b回收 §8|§f 卖 钻石 5')
      player.tell(' §b行情 §8|§f 回收排行 §e（看现在什么涨得最凶）')
      player.tell('§9§m────────────────────────────')
      return
    }
    try { runAction(player, act, 'toggle') } catch (e) { audit('ERROR', '菜单动作异常: ' + e.message) }
  })
}
function openRenameForm (pl) {
  if (!pl) return
  const item = itemFor(pl)
  const cur = item ? item.name : residentName()
  let form
  try { form = mc.newCustomForm() } catch (e) { pl.tell('§c[AI 助手] 当前版本不支持表单'); return }
  form.setTitle('§l§b✦ 给助手改个名字 ✦')
  form.addInput('§b新名字 §8（留空就取消）', '§f2-12 个字，别带颜色符', cur)
  pl.sendForm(form, function (player, data) {
    if (!data || !data[0]) { try { player.tell('§b[AI 助手] §f没改，还是叫 ' + cur) } catch (e) {} return }
    const raw = cleanName(String(data[0]))
    if (!raw) { player.tell('§c[AI 助手] 这名字不太行，换一个'); return }
    let r
    if (item) r = renameOwnAssistant(player, raw)
    else r = renameResident(raw, player.realName)
    if (r && r.ok !== false) {
      try { player.tell('§b[AI 助手] §f以后我就叫「' + (r.name || raw) + '」了') } catch (e) {}
      try { say('叫我' + (r.name || raw) + '也行呀', 'interject') } catch (e) {}
    } else {
      try { player.tell('§c[AI 助手] 改名失败：' + ((r && r.msg) || '未知原因')) } catch (e) {}
    }
  })
}

function openBuyForm (pl) {
  let form
  try { form = mc.newCustomForm() } catch (e) { pl.tell('§c[AI 助手] §f当前版本不支持表单，请用 /ai 菜单'); return }
  form.setTitle('§l§6✦ 购买服务时长 ✦')
  const bal = moneyOf(pl)
  form.addLabel('§9§m                                    §r')
  form.addLabel('§e单价 §f' + CFG.price.perMinute + ' ' + CFG.price.currency + ' §8/ §e分钟 §8· §e最少 §f' + CFG.price.minMinutes + ' §e分钟')
  form.addLabel('§e余额 §f' + (bal === null ? '§c读取不到（点菜单里的「诊断信息」）' : bal + ' ' + CFG.price.currency + ' §8(最多可买 ' + fmtMin(Math.floor(bal / CFG.price.perMinute) * 60000) + ')'))
  form.addSlider('§b购买分钟数', CFG.price.minMinutes, CFG.price.maxMinutes, 10, CFG.price.minMinutes)
  form.addLabel('§b拖动滑块选分钟数，点下方「购买」扣款')
  form.addLabel('§9§m                                    §r')
  pl.sendForm(form, function (player, data) {
    if (!data || data.length < 4) return
    const mins = parseInt(data[3], 10)
    try {
      const r = purchase(player, mins)
      player.tell((r.ok ? '§a' : '§c') + '[AI 助手] ' + r.msg)
      if (r.ok) {
        player.tell('§8§m────────────────────────────')
        player.tell('§a✔ 购买成功 §8· §7剩余 §f' + fmtMin(remainingMs(player)))
        player.tell('§7点菜单里的 §b「召唤 / 过来」§7 就能把它叫过来')
        player.tell('§8§m────────────────────────────')
      }
    } catch (e) { player.tell('§c[AI 助手] 购买异常: ' + e.message) }
  })
}

// 诊断：把经济接口的真实情况报给玩家/控制台，用来定位“买不了”
function diagnose (pl) {
  const out = []
  let hasGet = false; let hasReduce = false
  try { hasGet = typeof pl.getMoney === 'function' } catch (e) {}
  try { hasReduce = typeof pl.reduceMoney === 'function' } catch (e) {}
  let exported = []
  try {
    if (typeof ll.hasExported === 'function') {
      for (const ns of ['LLMoney', 'LegacyMoney']) {
        for (const fn of ['LLMoney_Get', 'LLMoney_Reduce', 'LLMoney_Add', 'getMoney', 'reduceMoney']) {
          try { if (ll.hasExported(ns, fn)) exported.push(ns + '.' + fn) } catch (e) {}
        }
      }
    }
  } catch (e) {}
  const bal = moneyOf(pl)
  out.push('getMoney: ' + hasGet + '  reduceMoney: ' + hasReduce)
  out.push('导出的经济接口: ' + (exported.length ? exported.join(', ') : '无'))
  out.push('当前余额: ' + (bal === null ? '读取失败' : bal))
  out.push('实体查询: ' + (entityProbe === null ? '未探测' : (entityProbe < 0 ? '全部失败' : '形态' + entityProbe + '可用')))
  out.push('xuid: ' + (pl.xuid || '空') + '  名字: ' + pl.realName)
  try { out.push('环境感知: ' + (situationOf(itemFor(pl) || resident) || '取不到')) } catch (e) { out.push('环境感知: 异常 ' + e.message) }
  for (const line of out) pl.tell('§7[诊断] §f' + line)
  audit('DIAG', pl.realName + ' | ' + out.join(' | '))
}

// 启动 ----------
if (!loadKey()) audit('START', '警告：模型 key 未加载，聊天问答将不可用（检查 ' + CFG.llm.keyFile + '）')
if (CFG.resident.enabled) {
  setTimeout(function () { try { spawnResident() } catch (e) { audit('RESIDENT', '召唤异常: ' + e.message) } }, 8000)
  setInterval(ensureResident, 30000)
  mc.listen('onJoin', function () { try { ensureResident() } catch (e) {} })
  audit('RESIDENT', '常驻模式已启用：' + residentName() + '，免费聊天=' + CFG.resident.freeChat + '，可指挥=' + CFG.resident.allowMove)
}
audit('START', 'ai-assistant v1.7.7 已加载：价格 ' + CFG.price.perMinute + '/' + CFG.price.currency + ' 每分钟，助手 ' + CFG.assistantName + '（可改名），常驻 ' + residentName() + '，动作白名单 ' + ALLOWED_SIM.length + ' 项')


// ===== v1.5.0 扩展：记忆 / 指令代办 / 死亡提醒 / 危险预警 / 日志问答 / 自动钓鱼 / 经济 / 商城对接 =====

// ---------- 1. 私人记忆 ----------
const MEM_PATH = path.join(STATE_DIR, 'memory.json')
let MEM = readJson(MEM_PATH, {})
function memSave () { writeJson(MEM_PATH, MEM) }
function memOf (pl) {
  const k = keyOf(pl)
  if (!MEM[k]) MEM[k] = { name: pl.realName, facts: [] }
  if (!Array.isArray(MEM[k].facts)) MEM[k].facts = []
  return MEM[k]
}
function memAdd (pl, text) {
  const m = memOf(pl)
  const t = String(text || '').trim().slice(0, 120)
  if (!t) return { ok: false, msg: '要记什么？' }
  if (m.facts.indexOf(t) >= 0) return { ok: true, msg: '这个我早记着了' }
  m.facts.push(t)
  if (m.facts.length > 20) m.facts.shift()
  memSave()
  audit('MEM', pl.realName + ' 记住: ' + t)
  return { ok: true, msg: '记住了，你说过「' + t + '」' }
}
function memForget (pl, text) {
  const m = memOf(pl)
  const t = String(text || '').trim()
  const i = m.facts.findIndex(function (x) { return x.indexOf(t) >= 0 })
  if (i < 0) return { ok: false, msg: '我没记过这个' }
  const gone = m.facts.splice(i, 1)[0]
  memSave()
  return { ok: true, msg: '忘了：「' + gone + '」' }
}
function memText (pl) {
  const m = memOf(pl)
  if (!m.facts.length) return ''
  return m.facts.slice(-6).join('；')
}

// ---------- 2. 商城接口（ShoppingMall 的 sm_aiQuery / sm_aiBuy / sm_aiSell） ----------
function shopCall (fnName) {
  const args = Array.prototype.slice.call(arguments, 1)
  try {
    if (typeof ll.hasExported === 'function' && !ll.hasExported('ShoppingMall', fnName)) {
      return { ok: false, msg: '商城插件没开放接口（可能没装或版本不对）' }
    }
    const f = ll.import('ShoppingMall', fnName)
    if (typeof f !== 'function') return { ok: false, msg: '商城接口不可用' }
    const raw = f.apply(null, args)
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    return obj || { ok: false, msg: '商城返回空' }
  } catch (e) {
    audit('SHOP', '调用 ' + fnName + ' 失败: ' + e.message)
    return { ok: false, msg: '商城接口出错：' + e.message }
  }
}
function shopPriceText (keyword) {
  const kw = String(keyword || '').trim()
  const buy = shopCall('sm_aiQuery', kw, 'buy')
  const sell = shopCall('sm_aiQuery', kw, 'sell')
  const buyItems = (buy && buy.ok && buy.items) ? buy.items : []
  const sellItems = (sell && sell.ok && sell.items) ? sell.items : []
  if (!buyItems.length && !sellItems.length) {
    return '§7官方商店里没找到「' + (kw || '') + '」，换个关键词试试（比如只打「钻」「铁」「面包」）'
  }
  const CAP = 8
  const lines = []
  lines.push('§b===== 商店查价：' + (kw || '全部') + ' =====')
  if (buyItems.length) {
    lines.push('§a【购买】你花钱买（共 ' + buyItems.length + ' 项）')
    buyItems.slice(0, CAP).forEach(function (x) {
      lines.push('§f  ' + x.name + ' §7— §e' + x.price + ' 金币/个' +
        (x.quantity === -1 ? ' §7库存不限' : (x.quantity > 0 ? ' §7剩 ' + x.quantity : ' §c已售罄')))
    })
    if (buyItems.length > CAP) lines.push('§7  …还有 ' + (buyItems.length - CAP) + ' 项，关键词再具体一点')
  } else {
    lines.push('§a【购买】§7官方商店不卖这个')
  }
  if (sellItems.length) {
    lines.push('§6【回收】你卖给它（共 ' + sellItems.length + ' 项）')
    sellItems.slice(0, CAP).forEach(function (x) {
      const per = x.perCount > 1 ? '§7（每 ' + x.perCount + ' 个算 1 份）' : ''
      const orig = Number(x.originalPrice)
      const now = Number(x.dynamicPrice === undefined ? x.price : x.dynamicPrice)
      let priceTxt
      if (isFinite(orig) && isFinite(now) && orig !== now) {
        const diff = now - orig
        const pct = orig > 0 ? Math.round((diff / orig) * 100) : 0
        const arrow = diff > 0 ? '§a↑' : '§c↓'
        priceTxt = '§8原价 ' + orig + ' §7→ §e现价 ' + now + ' ' + arrow + Math.abs(pct) + '%'
      } else {
        priceTxt = '§e' + now + ' 金币/个 §7（原价，未调整）'
      }
      lines.push('§f  ' + x.name + ' §7— ' + priceTxt + per)
    })
    if (sellItems.length > CAP) lines.push('§7  …还有 ' + (sellItems.length - CAP) + ' 项')
  } else {
    lines.push('§6【回收】§7官方商店不收这个')
  }
  const topTxt = recycleTopText(3, true)
  if (topTxt) { lines.push(topTxt) }
  return lines.join('\n')
}

// 行情：回收涨价 Top N（给玩家“现在该去攒什么”的建议）
function recycleTopText (n, compact) {
  let raw
  try {
    if (!ll || typeof ll.import !== 'function') return ''
    if (typeof ll.hasExported === 'function' && !ll.hasExported('ShoppingMall', 'sm_aiTopRecycle')) return ''
    raw = JSON.parse(ll.import('ShoppingMall', 'sm_aiTopRecycle')(n || 5) || '{}')
  } catch (e) { return '' }
  if (!raw || !raw.ok || !raw.items || !raw.items.length) return ''
  const bars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  const lines = []
  lines.push(raw.mode === 'up' ? '§8§m────────────────────────────' : '§8§m────────────────────────────')
  lines.push(raw.mode === 'up' ? '§6§l回收涨价榜 §7（现在卖最划算）' : '§6§l回收价排行 §7（按单价）')
  raw.items.forEach(function (x, i) {
    const bar = raw.mode === 'up' && x.pct > 0 ? ' §a' + bars[Math.min(7, Math.max(0, Math.round(x.pct / 6)))] : ''
    const unit = x.perCount > 1 ? ' §8(≈' + x.unit + '/个)' : ''
    if (x.pct > 0) {
      lines.push(' §8' + (i + 1) + '. §f' + x.name + ' §a+' + x.pct + '% §7现价 §e' + x.now + bar + unit)
    } else {
      lines.push(' §8' + (i + 1) + '. §f' + x.name + ' §e' + x.unit + ' §7/个' + unit)
    }
  })
  if (!compact) {
    lines.push('§7现价会随时间跌回原价，趁高出手；发 §f回收排行 §7看完整榜')
  } else {
    lines.push('§7完整榜单发 §f回收排行')
  }
  return lines.join('\n')
}

// ---------- 3. 行为日志问答 ----------
function behaviorStats (pl, hours) {
  const span = (hours || 24) * 3600 * 1000
  const since = Date.now() - span
  const out = { breakBlocks: 0, placeBlocks: 0, pickups: 0, cmd: 0, chat: 0, deaths: 0, logins: 0, total: 0 }
  let files = []
  try {
    const dir = path.join(ROOT, 'logs')
    for (let d = 0; d < 3; d++) {
      const dt = new Date(Date.now() - d * 86400000)
      const nm = 'BehaviorLog-' + dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0') + '.csv'
      const fp = path.join(dir, nm)
      if (fs.existsSync(fp)) files.push(fp)
    }
  } catch (e) {}
  if (!files.length) return null
  const want = pl.realName
  for (const fp of files) {
    let txt = ''
    try { txt = fs.readFileSync(fp, 'utf8') } catch (e) { continue }
    const lines = txt.split(/\r?\n/)
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i]
      if (!row || row.indexOf(want) < 0) continue
      const c = row.split(',')
      if (c.length < 7) continue
      const ts = Date.parse(String(c[0]).replace(/-/g, '/'))
      if (!ts || ts < since) continue
      const src = c[2] || ''
      if (src !== want) continue
      const ev = c[6] || ''
      out.total++
      if (ev === '破坏方块') out.breakBlocks++
      else if (ev === '放置方块') out.placeBlocks++
      else if (ev === '捡起物品') out.pickups++
      else if (ev === '玩家执行命令') out.cmd++
      else if (ev === '发送对话') out.chat++
      else if (ev === '死亡') out.deaths++
      else if (ev === '进入服务器') out.logins++
    }
  }
  return out
}

// ---------- 4. 经济（IKBank 利率 + 余额） ----------
function bankInfo () {
  const p = path.join(ROOT, 'plugins', 'IKBank', 'BankConfig.json')
  const c = readJson(p, null)
  if (!c) return null
  return c
}
function moneyText (pl) {
  const v = moneyOf(pl)
  return v === null || v === undefined ? '查不到余额' : String(v)
}

// ---------- 5. 死亡提醒 ----------
const deathMarks = {}
mc.listen('onPlayerDie', (player, source) => {
  try {
    const p = player.pos
    const pos = Math.floor(p.x) + ', ' + Math.floor(p.y) + ', ' + Math.floor(p.z)
    deathMarks[keyOf(player)] = { name: player.realName, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: Date.now() }
    let killer = ''
    try { if (source && source.name) killer = ' 被 ' + source.name + ' 收走了' } catch (e) {}
    noteEvent(player.realName + ' 死了（' + pos + '）')
    player.tell('§c[AI 助手] 你在 §f' + pos + '§c 没了' + killer + '，回头可以问我要坐标')
    audit('DEATH', player.realName + ' @ ' + pos + killer)
    if (residentAlive() && residentCanTalk()) {
      say('§7…' + player.realName + ' 在 ' + pos + ' 躺了，我记下了', 'interject')
    }
  } catch (e) { audit('ERROR', '死亡提醒: ' + e.message) }
})

// ---------- 6. 危险预警 ----------
const lastWarn = {}
setInterval(function () {
  try {
    for (const pl of mc.getOnlinePlayers()) {
      const k = keyOf(pl)
      if (Date.now() - (lastWarn[k] || 0) < 30000) continue
      let hp = null, maxHp = null
      try { hp = pl.getHealth(); maxHp = pl.getMaxHealth() } catch (e) { continue }
      if (hp === null || maxHp === null) continue
      const ratio = hp / maxHp
      let hostile = null
      try { hostile = nearestHostile(pl, 10) } catch (e) {}
      if (ratio <= 0.35 && hostile) {
        lastWarn[k] = Date.now()
        pl.tell('§c[AI 助手] 你只剩 ' + Math.round(hp) + '/' + Math.round(maxHp) + ' 血，旁边有怪，快跑或者吃东西')
        try { pl.sendToast('§c危险', '血量低，附近有敌对生物') } catch (e) {}
      }
    }
  } catch (e) {}
}, 5000)

// ---------- 7. 自动钓鱼（用 simulateUseItem 循环） ----------
setInterval(function () {
  try {
    for (const k of Object.keys(live)) {
      const it = live[k]
      if (true) continue // v1.7.0 已移除自动钓鱼
      safeSim(it.sp, 'simulateUseItem', [])
    }
  } catch (e) {}
}, 3000)

// ---------- 8. 指令代办（只读白名单） ----------
const SAFE_CMDS = { 'list': 1, 'tps': 1, 'version': 1, 'gamerules': 1, 'difficulty': 1 }
function runSafeCmd (cmd) {
  const c = String(cmd || '').trim().replace(/^\//, '')
  const base = c.split(/\s+/)[0].toLowerCase()
  if (!SAFE_CMDS[base]) return null
  try {
    const r = mc.runcmdEx(c)
    return r && r.output ? String(r.output).trim() : '（无输出）'
  } catch (e) { return '执行失败：' + e.message }
}

// ---------- 9. 聊天里的扩展意图 ----------
function handleExtIntent (player, hit) {
  try {
    // [PATCH] 排行优先：否则「回收排行」会被「卖/回收」分支当成要卖一个叫“排行”的东西
    if (/^(回收排行|回收榜|涨价榜|价格榜|行情榜|行情|什么值钱|最赚钱)\/?(\d+)?$/.test(hit.trim())) {
      const n = Math.max(1, Math.min(20, parseInt((hit.match(/(\d+)/) || [])[1], 10) || 8))
      const txt = recycleTopText(n, false)
      player.tell(txt || '§b[商城] §f回收行情暂时读不到（商店没配回收价？）')
      return true
    }
    let m = /^(?:买|购买|buy)\s*(\S+?)(?:\s*(?:x|×|\*)?\s*(\d+))?$/i.exec(hit)
    if (m) {
      const kw = m[1], qty = m[2] ? parseInt(m[2], 10) : 1
      if (/^\d+$/.test(kw)) return false
      const r = shopCall('sm_aiBuy', player.realName, kw, qty)
      player.tell((r.ok ? '§a' : '§c') + '[商城] ' + (r.msg || (r.ok ? '买好了' : '没买成')))
      return true
    }
    m = /^(?:卖|出售|回收|sell)\s*(\S+?)(?:\s*(?:x|×|\*)?\s*(\d+))?$/i.exec(hit)
    if (m) {
      const r = shopCall('sm_aiSell', player.realName, m[1], m[2] ? parseInt(m[2], 10) : 0)
      player.tell((r.ok ? '§a' : '§c') + '[商城] ' + (r.msg || (r.ok ? '卖好了' : '没卖成')))
      return true
    }
    if (/^(回收排行|回收榜|涨价榜|价格榜|行情|什么值钱|最赚钱)$/.test(hit)) {
      tellLines(player, recycleTopText(8, false))
      return true
    }
    m = /^(?:查价|价格|多少钱|回收价|收购价)\s*(\S.*)?$/.exec(hit)
    if (m) {
      tellLines(player, shopPriceText((m[1] || '').trim()))
      return true
    }
    m = /^(?:记住|记一下|帮我记)[\s:：]*(.+)$/.exec(hit)
    if (m) { const r = memAdd(player, m[1]); player.tell((r.ok ? '§a' : '§c') + '[AI] ' + r.msg); return true }
    m = /^(?:忘记|忘掉|别记)[\s:：]*(.+)$/.exec(hit)
    if (m) { const r = memForget(player, m[1]); player.tell((r.ok ? '§a' : '§c') + '[AI] ' + r.msg); return true }
    if (/^(?:你记得我|记得什么|我的资料|记忆)/.test(hit)) {
      const t = memText(player)
      player.tell('§b[AI] ' + (t ? '我记得你说过：' + t : '我这边还没记过你的事，跟我说「记住 xxx」就行'))
      return true
    }
    if (/^(?:我挖了多少|我的统计|今日统计|统计给我|我干了啥)/.test(hit)) {
      const s = behaviorStats(player, 24)
      if (!s) { player.tell('§7[AI] 今天的日志还没写出来'); return true }
      player.tell('§b[AI] 近 24 小时：破坏 ' + s.breakBlocks + ' 个方块，放置 ' + s.placeBlocks + ' 个，捡起 ' + s.pickups + ' 次，聊天 ' + s.chat + ' 条，执行命令 ' + s.cmd + ' 次，死亡 ' + s.deaths + ' 次')
      return true
    }
    if (/^(?:我死在哪|死亡点|上次死)/.test(hit)) {
      const d = deathMarks[keyOf(player)]
      player.tell('§b[AI] ' + (d ? '你上次在 ' + d.x + ', ' + d.y + ', ' + d.z + ' 没的' : '我还没记到你的死亡点'))
      return true
    }
    if (/^(?:我多少钱|余额|我有多少)/.test(hit)) {
      player.tell('§b[AI] 你现在有 ' + moneyText(player) + ' 金币')
      return true
    }
    if (/^(?:利率|银行利率|存款利率)/.test(hit)) {
      const b = bankInfo()
      if (!b) { player.tell('§7[AI] 读不到银行配置'); return true }
      player.tell('§b[AI] 存款利率 ' + (b.depositInterestRate) + '，贷款利率 ' + (b.loanInterestRate) + '，最高可贷 ' + (b.maxLoanAmount) + '，转账手续费 ' + (b.transferFeeRate))
      return true
    }
    m = /^(?:执行|帮我执行|查一下)\s*(\S.*)$/.exec(hit)
    if (m) {
      const r = runSafeCmd(m[1])
      if (r === null) { player.tell('§7[AI] 这条不在只读白名单里（list / tps / version / gamerules / difficulty）'); return true }
      player.tell('§b[AI] ' + String(r).slice(0, 300))
      return true
    }
    if (/^(?:钓鱼|自动钓鱼)/.test(hit)) {
      const it = itemFor(player)
      if (!it) { player.tell('§c[AI] 助手不在你身边，先 /ai 召唤'); return true }
      it.autoFish = !it.autoFish
      player.tell('§a[AI] ' + it.name + ' 自动钓鱼' + (it.autoFish ? '开' : '关') + '（要给它手里拿钓竿）')
      audit('TOGGLE', 'autoFish=' + (it.autoFish ? 'on' : 'off') + ' for ' + player.realName)
      return true
    }
  } catch (e) {
    audit('ERROR', '扩展意图异常: ' + e.message)
  }
  return false
}

// ---------- 10. /ai 扩展动作 ----------
function runExtAction (pl, action, arg) {
  if (action === '记忆' || action === 'remember') {
    if (!arg) { pl.tell('§7' + (memText(pl) || '还没记过什么')); return true }
    const r = memAdd(pl, arg); pl.tell((r.ok ? '§a' : '§c') + '[AI] ' + r.msg); return true
  }
  if (action === '买' || action === 'buy') {
    if (!arg) { pl.tell('§c用法：/ai 买 <物品> [数量]'); return true }
    const parts = arg.trim().split(/\s+/)
    const r = shopCall('sm_aiBuy', pl.realName, parts[0], parts[1] ? parseInt(parts[1], 10) : 1)
    pl.tell((r.ok ? '§a' : '§c') + '[商城] ' + (r.msg || '')); return true
  }
  if (action === '卖' || action === 'sell') {
    if (!arg) { pl.tell('§c用法：/ai 卖 <物品> [数量]'); return true }
    const parts = arg.trim().split(/\s+/)
    const r = shopCall('sm_aiSell', pl.realName, parts[0], parts[1] ? parseInt(parts[1], 10) : 0)
    pl.tell((r.ok ? '§a' : '§c') + '[商城] ' + (r.msg || '')); return true
  }
  if (action === '查价' || action === 'price') {
    tellLines(pl, shopPriceText(arg || '')); return true
  }
  if (action === '行情' || action === '回收排行' || action === '涨价榜' || action === 'top') {
    tellLines(pl, recycleTopText(8, false)); return true
  }
  if (action === '统计' || action === 'stats') {
    const s = behaviorStats(pl, 24)
    pl.tell('§b[AI] ' + (s ? '近24小时 破坏' + s.breakBlocks + ' 放置' + s.placeBlocks + ' 捡起' + s.pickups + ' 死亡' + s.deaths : '没有日志'))
    return true
  }
  if (action === '死亡点' || action === 'death') {
    const d = deathMarks[keyOf(pl)]
    pl.tell('§b[AI] ' + (d ? d.x + ', ' + d.y + ', ' + d.z : '还没记到')); return true
  }
  if (action === '钓鱼' || action === 'fish') {
    const it = itemFor(pl)
    if (!it) { pl.tell('§c[AI] 助手不在你身边'); return true }
    it.autoFish = !it.autoFish
    pl.tell('§a[AI] 自动钓鱼' + (it.autoFish ? '开' : '关')); return true
  }
  if (action === '余额' || action === 'money') {
    pl.tell('§b[AI] 你有 ' + moneyText(pl) + ' 金币'); return true
  }
  return false
}


// ---------- 控制台自检：aitest ----------
try {
  mc.regConsoleCmd('aitest', 'ai-assistant 自检（商城接口 / 记忆 / 日志）', function () {
    const out = []
    try {
      const q = shopCall('sm_aiQuery', '', 'buy')
      out.push('shop_query_ok=' + (q && q.ok) + ' buy_items=' + (q && q.items ? q.items.length : 'n/a') + ' msg=' + (q && q.msg ? q.msg : ''))
      const s = shopCall('sm_aiQuery', '', 'sell')
      out.push('shop_sell_ok=' + (s && s.ok) + ' sell_items=' + (s && s.items ? s.items.length : 'n/a'))
    } catch (e) { out.push('shop_err=' + e.message) }
    try { out.push('mem_players=' + Object.keys(MEM).length) } catch (e) {}
    try { out.push('resident=' + (residentAlive() ? residentName() : 'none')) } catch (e) {}
    out.push('version=1.5.0')
    mc.broadcast('§7[AI自检] §f' + out.join(' | '))
    for (const l of out) logger.info('[AI自检] ' + l)
  })
} catch (e) { logger.warn('[AI自检] 注册失败: ' + e.message) }
// ---------- 跟随 v1.7.0：不用寻路，每 500ms 朝主人迈一步，卡住就跳 ----------
function followStep (item) {
  if (!item || !item.sp) return
  const pl = item.targetName ? mc.getPlayer(String(item.targetName)) : null
  if (!pl) { item.mode = 'idle'; return }
  let s0 = null
  try { s0 = item.sp.pos } catch (e) { return }
  const p0 = pl.pos
  const dx = p0.x - s0.x, dy = p0.y - s0.y, dz = p0.z - s0.z
  const hd = Math.sqrt(dx * dx + dz * dz)
  const stop = Number(CFG.limits.followStopDistance || 3)
  if (hd <= stop && Math.abs(dy) <= 3) {
    if (now() - (item.lastLook || 0) > 3000) { item.lastLook = now(); try { item.sp.simulateLookAt(pl) } catch (e1) {} }
    return
  }
  const t = now()
  if (t - (item.stepAt || 0) < 450) return
  item.stepAt = t
  const nx = s0.x + dx * 0.85
  const nz = s0.z + dz * 0.85
  let ny = p0.y
  try {
    const gp = item.sp.pos
    gp.x = nx; gp.y = ny; gp.z = nz
    item.sp.simulateMoveTo(gp)
  } catch (e2) {}
  if (dy > 1.2 && t - (item.jumpAt || 0) > 900) { item.jumpAt = t; try { item.sp.simulateJump() } catch (e3) {} }
  if (Math.abs(hd - (item.lastHd === undefined ? hd : item.lastHd)) < 0.4) {
    if (t - (item.stuckAt || 0) > 2500) { item.stuckAt = t; try { item.sp.simulateJump() } catch (e4) {} }
  } else { item.stuckAt = t }
  item.lastHd = hd
}
setInterval(function () {
  for (const k of Object.keys(live)) { const it = live[k]; if (it && it.mode === 'follow') { try { followStep(it) } catch (e) {} } }
  if (resident && resident.mode === 'follow') { try { followStep(resident) } catch (e) {} }
}, 500)

// ---------- 常驻助手阵亡自动重召（v1.7.1）----------
function residentSpAlive (sp) {
  if (!sp) return false
  try {
    const pos = sp.pos
    if (!pos || typeof pos.x !== 'number' || !isFinite(pos.x)) return false
    const h = sp.health
    if (typeof h === 'number' && h <= 0) return false
    return true
  } catch (e) { return false }
}
function reviveResidentNow () {
  if (!CFG.resident.enabled) return false
  let pos = null
  // 优先在在线玩家身边重生（而不是世界出生点），这样死了能立刻回到人身边
  try {
    const pls = mc.getOnlinePlayers() || []
    for (let i = 0; i < pls.length; i++) {
      const pp = pls[i] && pls[i].pos
      if (pp && typeof pp.x === 'number') { pos = { x: Math.floor(pp.x) + 1, y: Math.floor(pp.y), z: Math.floor(pp.z) + 1, dim: (typeof pls[i].dimid === 'number' ? pls[i].dimid : 0) }; break }
    }
  } catch (eP) {}
  if (!pos) { try { pos = residentSpawnPos() } catch (e) { pos = null } }
  if (!pos) { try { pos = { x: 394, y: 128, z: 1942, dim: 0 } } catch (e2) {} }
  const base = residentName()
  const cands = [base, base + '2', base + '3', base + '4', base + '5', base + '6', base + '7', base + '8', base + '9']
  for (let i = 0; i < cands.length; i++) {
    const nm = cands[i]
    let sp = null
    try { sp = spawnNamed(nm, pos) } catch (e) {}
    if (sp) {
      resident = { sp: sp, name: nm, mode: 'idle', targetName: null, target: null }
      audit('REVIVE', '常驻助手重新就位：' + nm + ' @ ' + Math.floor(pos.x) + ',' + Math.floor(pos.y) + ',' + Math.floor(pos.z))
      try { audit('SITUATION', '刚出生时的处境: ' + (situationOf(resident) || '取不到')) } catch (e3) {}
      return true
    }
  }
  audit('REVIVE', '重召失败：名字全被占用或世界未加载，5 秒后再试')
  return false
}
setInterval(function () {
  if (!CFG.resident.enabled) return
  if (resident && residentSpAlive(resident.sp)) return
  if (resident) { audit('REVIVE', '常驻助手已阵亡/掉线，准备重召'); resident = null }
  if (now() - (globalThis.__lastRevive || 0) < 5000) return
  globalThis.__lastRevive = now()
  reviveResidentNow()
}, 3000)

// 判断一个模拟玩家实体是否还活着（pos 可读且血量不为 0）
function aliveSp (sp) {
  if (!sp) return false
  try {
    const pos = sp.pos
    if (!pos || typeof pos.x !== 'number' || !isFinite(pos.x)) return false
    const h = sp.health
    if (typeof h === 'number' && h <= 0) return false
    return true
  } catch (e) { return false }
}

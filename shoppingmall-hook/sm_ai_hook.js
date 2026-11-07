// 把本文件内容追加到 ShoppingMall.js 末尾（已装过就别重复）

// ================= __AI_SHOP_API__ 对外接口（AI 助手调用，勿删） =================
function __aiFindItems(keyword, kind) {
  const kw = String(keyword||'').trim().toLowerCase();
  const src = kind === 'sell' ? (officialShopData.recycleItems||{}) : (officialShopData.purchaseItems||{});
  let dynOn = false;
  try { dynOn = !!(config.get('dynamicRecycle') && config.get('dynamicRecycle').enabled); } catch (e) {}
  const out = [];
  for (const k of Object.keys(src)) {
    const it = src[k]; if (!it) continue;
    const nm = String(it.displayName || it.name || '');
    const raw = String(it.name || '');
    const nmLow = nm.toLowerCase();
    const rawLow = raw.toLowerCase();
    if (kw && nmLow.indexOf(kw) < 0 && rawLow.indexOf(kw) < 0) continue;
    // 相关度排序：完全相等(0) > 前缀(1) > 包含(3)
    let rel = 3;
    if (kw) {
      if (nmLow === kw || rawLow === kw) rel = 0;
      else if (nmLow.indexOf(kw) === 0 || rawLow.indexOf(kw) === 0) rel = 1;
    }
    const base = Number(it.price) || 0;
    let dynamicPrice = base;
    if (kind === 'sell') {
      // 优先只读取现价（动态数据由插件自己维护），避免每次查价都触发写入/落盘
      try {
        const dp = (typeof dynamicRecycleData !== 'undefined' && dynamicRecycleData && dynamicRecycleData.itemPrices)
          ? dynamicRecycleData.itemPrices[k] : null;
        if (dp && typeof dp.currentPrice === 'number') dynamicPrice = dp.currentPrice;
        else if (dynOn) dynamicPrice = Number(getDynamicRecyclePrice(k, it.price));
      } catch (e) { dynamicPrice = base; }
      if (!isFinite(dynamicPrice)) dynamicPrice = base;
    }
    out.push({
      key: k, name: nm, rawName: raw, rel: rel,
      price: dynamicPrice,
      originalPrice: base,
      dynamicPrice: dynamicPrice,
      dynamic: (kind === 'sell' && dynOn && dynamicPrice !== base),
      perCount: it.perCount || 1,
      quantity: (it.quantity === undefined ? -1 : it.quantity),
      stackValue: dynamicPrice * (it.perCount || 1)
    });
  }
  out.sort(function (a, b) {
    if (a.rel !== b.rel) return a.rel - b.rel;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name);
  });
  return out;
}
function sm_aiQuery(keyword, kind) {
  try {
    const list = __aiFindItems(keyword, kind || 'buy');
    return JSON.stringify({ ok: true, kind: kind||'buy', count: list.length, items: list.slice(0, 40) });
  } catch (e) { return JSON.stringify({ ok:false, msg:'查询失败: '+e.message }); }
}
function __aiPlayer(name) {
  if (!name) return null;
  let pl = null;
  try { pl = mc.getPlayer(String(name)); } catch (e) {}
  if (pl) return pl;
  try { for (const p of mc.getOnlinePlayers()) { if (p.realName === name || p.xuid === name) return p; } } catch (e) {}
  return null;
}
function sm_aiBuy(playerName, keyword, qty) {
  try {
    const pl = __aiPlayer(playerName);
    if (!pl) return JSON.stringify({ ok:false, msg:'玩家不在线' });
    const n = parseInt(qty, 10) || 1;
    const list = __aiFindItems(keyword, 'buy');
    if (!list.length) return JSON.stringify({ ok:false, msg:'官方商店没有「'+keyword+'」这个商品' });
    if (list.length > 1) {
      const names = list.slice(0,6).map(x=>x.name).join('、');
      return JSON.stringify({ ok:false, msg:'有多个匹配：'+names+'，说得更具体点' });
    }
    const hit = list[0];
    const itemKey = hit.key;
    const shopItem = officialShopData.purchaseItems[itemKey];
    if (!shopItem) return JSON.stringify({ ok:false, msg:'该商品已下架' });
    if (shopItem.quantity !== -1 && shopItem.quantity < n) return JSON.stringify({ ok:false, msg:'库存不够，只剩 '+shopItem.quantity });
    const economy = getEconomyInterface();
    let totalPrice = shopItem.price * n, taxAmount = 0;
    if (config.get('enableTaxSystem')) {
      const rate = config.get('taxRate') || 0;
      if (rate > 0 && (config.get('taxOnlyOfficialShop') ? true : true)) { taxAmount = Math.floor(totalPrice*rate); }
    }
    const finalPrice = totalPrice + taxAmount;
    const bal = economy.get(pl);
    if (bal < finalPrice) return JSON.stringify({ ok:false, msg:'余额不够，需要 '+finalPrice+'（含税 '+taxAmount+'），你有 '+bal });
    const nbt = NBT.parseSNBT(shopItem.itemData);
    if (!canPlayerReceiveItem(pl, nbt, n)) return JSON.stringify({ ok:false, msg:'你背包满了，先清点位置' });
    economy.reduce(pl, finalPrice);
    if (taxAmount > 0) { try { recordTaxCollection(pl.xuid, taxAmount, shopItem.name); } catch(e){} }
    const ok = distributeItemsToPlayer(pl, nbt, n);
    if (!ok) { economy.add(pl, finalPrice); return JSON.stringify({ ok:false, msg:'发货失败，钱已退回' }); }
    if (shopItem.quantity !== -1) {
      shopItem.quantity -= n;
      if (shopItem.quantity <= 0) delete officialShopData.purchaseItems[itemKey];
      saveOfficialShopData();
    }
    try { logPurchase(pl, null, shopItem, n, true); } catch(e) {}
    return JSON.stringify({ ok:true, item: hit.name, qty:n, paid: finalPrice, tax: taxAmount, balance: economy.get(pl),
      msg: '买到 '+hit.name+' x'+n+'，扣了 '+finalPrice+'，余额 '+economy.get(pl) });
  } catch (e) { return JSON.stringify({ ok:false, msg:'购买异常: '+e.message }); }
}
function sm_aiSell(playerName, keyword, qty) {
  try {
    const pl = __aiPlayer(playerName);
    if (!pl) return JSON.stringify({ ok:false, msg:'玩家不在线' });
    const list = __aiFindItems(keyword, 'sell');
    if (!list.length) return JSON.stringify({ ok:false, msg:'官方回收站不收「'+keyword+'」' });
    if (list.length > 1) {
      const names = list.slice(0,6).map(x=>x.name).join('、');
      return JSON.stringify({ ok:false, msg:'有多个匹配：'+names+'，说得更具体点' });
    }
    const hit = list[0];
    const rec = officialShopData.recycleItems[hit.key];
    if (!rec) return JSON.stringify({ ok:false, msg:'该回收项已下架' });
    const perCount = rec.perCount || 1;
    const have = getPlayerItemCount(pl, rec.itemData);
    if (have < perCount) return JSON.stringify({ ok:false, msg:'你身上只有 '+have+' 个，至少 '+perCount+' 个才收' });
    let n = parseInt(qty, 10);
    if (!n || n <= 0) n = have;
    if (n > have) n = have;
    const sets = Math.floor(n / perCount);
    if (sets <= 0) return JSON.stringify({ ok:false, msg:'数量不够一组（每组 '+perCount+' 个）' });
    const realQty = sets * perCount;
    const unit = getDynamicRecyclePrice(hit.key, rec.price);
    try { if (typeof checkRecycleLimit === 'function' && !checkRecycleLimit(pl, hit.key, realQty)) return JSON.stringify({ ok:false, msg:'超过今天的回收上限了' }); } catch(e) {}
    const economy = getEconomyInterface();
    const got = unit * sets;
    const removed = removeItemsFromPlayer(pl, rec.itemData, realQty);
    if (!removed) return JSON.stringify({ ok:false, msg:'扣除物品失败' });
    economy.add(pl, got);
    try { recordRecycleEvent(hit.key); recordRecycleUsage(pl, hit.key, realQty); } catch(e) {}
    return JSON.stringify({ ok:true, item: hit.name, qty: realQty, got: got, balance: economy.get(pl),
      msg: '卖掉 '+hit.name+' x'+realQty+'，到手 '+got+'，余额 '+economy.get(pl) });
  } catch (e) { return JSON.stringify({ ok:false, msg:'回收异常: '+e.message }); }
}
// 回收行情排行：按涨幅（现价相对原价）排序，涨幅相同则看单价，用来回答“现在收什么最划算”
function sm_aiTopRecycle(limit) {
  try {
    const n = Math.max(1, Math.min(20, parseInt(limit, 10) || 5));
    const src = officialShopData.recycleItems || {};
    let dynOn = false;
    try { dynOn = !!(config.get('dynamicRecycle') && config.get('dynamicRecycle').enabled); } catch (e) {}
    const rows = [];
    for (const k of Object.keys(src)) {
      const it = src[k]; if (!it) continue;
      const orig = Number(it.price) || 0;
      if (!(orig > 0)) continue;
      let now = orig;
      try {
        const dp = (typeof dynamicRecycleData !== 'undefined' && dynamicRecycleData && dynamicRecycleData.itemPrices)
          ? dynamicRecycleData.itemPrices[k] : null;
        if (dp && typeof dp.currentPrice === 'number') now = dp.currentPrice;
        else if (dynOn) now = Number(getDynamicRecyclePrice(k, it.price));
      } catch (e) {}
      if (!isFinite(now) || now <= 0) now = orig;
      const per = Math.max(1, Number(it.perCount) || 1);
      const pct = orig > 0 ? ((now - orig) / orig) * 100 : 0;
      rows.push({
        name: String(it.name || it.displayName || k).replace(/§./g, ''),
        orig: orig, now: now, pct: Math.round(pct),
        unit: Math.round((now / per) * 100) / 100, perCount: per
      });
    }
    const up = rows.filter(function (r) { return r.pct > 0; })
      .sort(function (a, b) { return b.pct - a.pct || b.unit - a.unit; });
    const byUnit = rows.slice().sort(function (a, b) { return b.unit - a.unit; });
    const pick = (up.length ? up : byUnit).slice(0, n);
    return JSON.stringify({
      ok: true, mode: up.length ? 'up' : 'unit', dynamic: dynOn,
      total: rows.length, upCount: up.length, items: pick
    });
  } catch (e) { return JSON.stringify({ ok: false, msg: '行情异常: ' + e.message }); }
}

try {
  if (ll && typeof ll.exports === 'function') {
    ll.exports(sm_aiQuery, 'ShoppingMall', 'sm_aiQuery');
    ll.exports(sm_aiBuy, 'ShoppingMall', 'sm_aiBuy');
    ll.exports(sm_aiSell, 'ShoppingMall', 'sm_aiSell');
    ll.exports(sm_aiTopRecycle, 'ShoppingMall', 'sm_aiTopRecycle');
    colorLog('green', '[AI 接口] 已开放 sm_aiQuery / sm_aiBuy / sm_aiSell / sm_aiTopRecycle');
  }
} catch (e) { console.log('[AI 接口] 导出失败: ' + e.message); }
// ================= __AI_SHOP_API__ end =================

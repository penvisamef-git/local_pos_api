// Promotions engine — the same file in 3 places (keep them identical):
//   local_pos_api/src/promo.js (CommonJS) · local_pos/src/promo.js · inventory_pos_admin/src/page/cloudpos/promo.js
// Made in the admin (Promotions), pulled by every POS, applied offline at the counter.
//
// promo: { _id, code, name_kh, name_en, type, value, buy_qty, get_qty, get_percent, bundle_items: [{ product_id, variant_id, qty }], bundle_price,
//          scope: all | category | brand | product, category_ids, brand_ids, product_ids, min_qty, min_amount,
//          start_at, end_at, days: [0-6], time_from, time_to ("HH:mm"), warehouse_ids, member_only, priority }
// type:  percent      x% off the items in scope              amount_off  $x off each item in scope
//        buy_x_get_y  buy X get Y (cheapest) at get_percent% off (100 = free)
//        bundle       these items together for bundle_price  bill_percent / bill_amount  off the whole bill when it reaches min_amount
const pr2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const TZ_OFFSET_MS = 7 * 3600 * 1000; // Asia/Phnom_Penh (no daylight saving)

function ppClock(now) {
  const d = new Date(new Date(now).getTime() + TZ_OFFSET_MS);
  return { day: d.getUTCDay(), hhmm: d.toISOString().slice(11, 16) };
}

// is the promotion on now, in this shop, for this sale?
function promoActive(p, ctx) {
  if (!p || p.status === false || p.deleted) return false;
  const now = ctx.now ? new Date(ctx.now) : new Date();
  if (p.start_at && new Date(p.start_at) > now) return false;
  if (p.end_at && new Date(p.end_at) < now) return false;
  const { day, hhmm } = ppClock(now);
  if (Array.isArray(p.days) && p.days.length && !p.days.includes(day)) return false;
  if (p.time_from && p.time_to) {
    const inside = p.time_from <= p.time_to ? hhmm >= p.time_from && hhmm < p.time_to : hhmm >= p.time_from || hhmm < p.time_to;
    if (!inside) return false;
  }
  if (Array.isArray(p.warehouse_ids) && p.warehouse_ids.length && ctx.warehouse_id && !p.warehouse_ids.map(String).includes(String(ctx.warehouse_id))) return false;
  if (p.member_only && !ctx.has_customer) return false;
  return true;
}

// does the line belong to the promotion's items?
function inScope(p, l, ctx) {
  const ids = (a) => (a || []).map(String);
  if (p.scope === "category") {
    const chain = ctx.categoryChain ? ctx.categoryChain(l.category_id) : [l.category_id];
    return chain.some((c) => c && ids(p.category_ids).includes(String(c)));
  }
  if (p.scope === "brand") return !!l.brand_id && ids(p.brand_ids).includes(String(l.brand_id));
  if (p.scope === "product") return ids(p.product_ids).includes(String(l.product_id)) || ids(p.product_ids).includes(String(l.variant_id));
  return l.allow_discount !== false; // "all": not the items marked "no discount"
}

/**
 * lines: [{ key, product_id, variant_id, category_id, brand_id, qty, price, allow_discount }]  (qty in the sale unit)
 * ctx:   { now, warehouse_id, has_customer, categoryChain(categoryId) → [id, parent, …] }
 * → { discounts: { [key]: USD }, applied: [{ promo_id, code, name_kh, name_en, amount }], total }
 */
function applyPromotions(lines, promos, ctx = {}) {
  const rows = lines.map((l) => ({ ...l, left: Number(l.qty) || 0, disc: 0, gross: pr2((Number(l.price) || 0) * (Number(l.qty) || 0)), taken: false }));
  const applied = [];
  const add = (p, amount) => {
    amount = pr2(amount);
    if (amount <= 0) return;
    const a = applied.find((x) => String(x.promo_id) === String(p._id));
    if (a) a.amount = pr2(a.amount + amount);
    else applied.push({ promo_id: p._id, code: p.code || "", name_kh: p.name_kh || "", name_en: p.name_en || p.name_kh || "", amount });
  };
  const active = (promos || []).filter((p) => promoActive(p, ctx)).sort((a, b) => (b.priority || 0) - (a.priority || 0));

  // 1. bundles — complete sets only
  for (const p of active.filter((x) => x.type === "bundle")) {
    const items = (p.bundle_items || []).filter((i) => (i.product_id || i.variant_id) && Number(i.qty) > 0);
    if (!items.length || !(Number(p.bundle_price) >= 0)) continue;
    const match = (i, r) => (i.variant_id ? String(r.variant_id) === String(i.variant_id) : String(r.product_id) === String(i.product_id));
    for (let guard = 0; guard < 50; guard++) {
      const can = items.every((i) => rows.filter((r) => match(i, r)).reduce((t, r) => t + Math.floor(r.left + 1e-9), 0) >= i.qty);
      if (!can) break;
      let normal = 0;
      const used = [];
      items.forEach((i) => {
        let need = Number(i.qty);
        rows.filter((r) => match(i, r)).sort((a, b) => b.price - a.price).forEach((r) => {
          const n = Math.min(need, Math.floor(r.left + 1e-9));
          if (n <= 0) return;
          r.left -= n;
          need -= n;
          normal += n * r.price;
          used.push({ r, value: n * r.price });
        });
      });
      const off = pr2(normal - Number(p.bundle_price));
      if (off <= 0) break;
      let rest = off;
      used.forEach((u, k) => {
        const share = k === used.length - 1 ? rest : pr2((off * u.value) / normal);
        u.r.disc = pr2(u.r.disc + share);
        rest = pr2(rest - share);
      });
      add(p, off);
    }
  }

  // 2. item promotions — each item gets the best one (greedy: biggest saving first)
  const itemTypes = ["percent", "amount_off", "buy_x_get_y"];
  const evalPromo = (p) => {
    const elig = rows.filter((r) => !r.taken && r.left > 1e-9 && inScope(p, r, ctx));
    const qty = elig.reduce((t, r) => t + r.left, 0);
    if (!elig.length || qty + 1e-9 < (Number(p.min_qty) || 0)) return null;
    const per = new Map();
    if (p.type === "percent") {
      const v = Math.min(Math.max(Number(p.value) || 0, 0), 100);
      elig.forEach((r) => per.set(r, (r.left * r.price * v) / 100));
    } else if (p.type === "amount_off") {
      const v = Math.max(Number(p.value) || 0, 0);
      elig.forEach((r) => per.set(r, r.left * Math.min(v, r.price)));
    } else {
      const buy = Math.max(1, Math.trunc(p.buy_qty) || 1);
      const get = Math.max(1, Math.trunc(p.get_qty) || 1);
      const pct = Math.min(Math.max(Number(p.get_percent ?? 100), 0), 100);
      const units = [];
      elig.forEach((r) => {
        for (let k = 0; k < Math.floor(r.left + 1e-9); k++) units.push(r);
      });
      units.sort((a, b) => b.price - a.price);
      const free = Math.floor(units.length / (buy + get)) * get;
      units.slice(units.length - free).forEach((r) => per.set(r, (per.get(r) || 0) + (r.price * pct) / 100));
      if (!free) return null;
    }
    const total = [...per.values()].reduce((t, v) => t + v, 0);
    return total > 0.004 ? { p, per, total, elig } : null;
  };
  const pool = active.filter((x) => itemTypes.includes(x.type));
  for (let guard = 0; guard < 50 && pool.length; guard++) {
    const best = pool.map(evalPromo).filter(Boolean).sort((a, b) => b.total - a.total)[0];
    if (!best) break;
    best.per.forEach((v, r) => {
      r.disc = pr2(r.disc + Math.min(v, r.left * r.price));
    });
    best.elig.forEach((r) => {
      r.taken = true;
    });
    add(best.p, best.total);
    pool.splice(pool.indexOf(best.p), 1);
  }

  // 3. whole bill (one: the biggest saving) when the bill reaches min_amount
  const net = pr2(rows.reduce((t, r) => t + r.gross - r.disc, 0));
  const bills = active
    .filter((x) => (x.type === "bill_percent" || x.type === "bill_amount") && net + 1e-9 >= (Number(x.min_amount) || 0))
    .map((p) => ({ p, off: pr2(p.type === "bill_percent" ? (net * Math.min(Math.max(Number(p.value) || 0, 0), 100)) / 100 : Math.min(Number(p.value) || 0, net)) }))
    .filter((b) => b.off > 0)
    .sort((a, b) => b.off - a.off);
  if (bills.length && net > 0) {
    const { p, off } = bills[0];
    let rest = off;
    const share = rows.filter((r) => r.gross - r.disc > 0);
    share.forEach((r, k) => {
      const part = k === share.length - 1 ? rest : pr2((off * (r.gross - r.disc)) / net);
      r.disc = pr2(r.disc + part);
      rest = pr2(rest - part);
    });
    add(p, off);
  }

  const discounts = {};
  rows.forEach((r) => {
    discounts[r.key] = pr2(Math.min(r.disc, r.gross));
  });
  return { discounts, applied, total: pr2(Object.values(discounts).reduce((t, v) => t + v, 0)) };
}

module.exports = { applyPromotions, promoActive, inScope };

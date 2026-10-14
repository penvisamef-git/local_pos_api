// Invoice maths — done on the POS server (never trusted from the browser).
//   lines: price × qty · bill discount (amount or %) shared over the lines that allow discount
//   tax:   none | exclusive (added on top) | inclusive (already in the price)
//   KHR:   total × rate, rounded to Setting.khr_rounding (100 ៛)
const { applyPromotions } = require("./promo");
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const roundKhr = (n, step = 100) => (step > 1 ? Math.round(n / step) * step : Math.round(n));

/**
 * cart:   [{ product, variant, unit, qty }]   (product / variant / unit from the local copy)
 * opts:   { discount: { type: "amount" | "percent", value }, setting, rate,
 *           promotions, promo: { now, warehouse_id, has_customer, categories } }   (promotions first, then the manual discount)
 * → { lines, subtotal, promo_total, promotions, discount_total, tax_amount, total, total_khr } | { error }
 */
// category → [itself, parent, grandparent …] (a promotion on "Clothing" covers "Clothing › Tops")
function chainOf(categories) {
  const parent = new Map((categories || []).map((c) => [String(c._id), c.parent_id ? String(c.parent_id) : null]));
  return (id) => {
    const out = [];
    let cur = id ? String(id) : null;
    for (let k = 0; cur && k < 10; k++) {
      out.push(cur);
      cur = parent.get(cur) || null;
    }
    return out;
  };
}

function priceCart(cart, { discount, setting, rate, promotions, promo }) {
  if (!cart.length) return { error: "មិនមានទំនិញក្នុងកន្ត្រក / The cart is empty" };
  const lines = [];
  for (const c of cart) {
    const price = c.variant.prices?.[String(c.unit._id)];
    if (price === undefined || price === null) return { error: `${c.variant.code}: មិនទាន់មានតម្លៃលក់ / no sale price` };
    const qty = r4(c.qty);
    if (!(qty > 0)) return { error: `${c.variant.code}: ចំនួនមិនត្រឹមត្រូវ / wrong qty` };
    lines.push({
      product_id: c.product._id,
      variant_id: c.variant._id,
      sku: c.variant.code,
      name_kh: c.variant.name_kh,
      name_en: c.variant.name_en,
      unit_id: c.unit._id,
      unit_code: c.unit.code,
      unit_name_kh: c.unit.name_kh,
      unit_name_en: c.unit.name_en,
      factor: c.unit.factor || 1,
      qty,
      base_qty: r4(qty * (c.unit.factor || 1)),
      price: r4(price),
      gross: r2(price * qty),
      discount: 0,
      promo_discount: 0,
      category_id: c.product.category_id || null,
      brand_id: c.product.brand_id || null,
      allow_discount: c.product.allow_discount !== false,
      is_taxable: c.product.is_taxable !== false,
    });
  }
  const subtotal = r2(lines.reduce((t, l) => t + l.gross, 0));

  // promotions (admin) — applied by themselves
  let promoTotal = 0;
  let applied = [];
  if (Array.isArray(promotions) && promotions.length) {
    const r = applyPromotions(
      lines.map((l, k) => ({ key: k, product_id: l.product_id, variant_id: l.variant_id, category_id: l.category_id, brand_id: l.brand_id, qty: l.qty, price: l.price, allow_discount: l.allow_discount })),
      promotions,
      { now: promo?.now || new Date(), warehouse_id: promo?.warehouse_id, has_customer: !!promo?.has_customer, categoryChain: chainOf(promo?.categories) },
    );
    lines.forEach((l, k) => {
      l.promo_discount = r2(Math.min(r.discounts[k] || 0, l.gross));
    });
    promoTotal = r2(lines.reduce((t, l) => t + l.promo_discount, 0));
    applied = r.applied;
  }

  // bill discount → shared over the discountable lines by their value (after promotions)
  let discountTotal = 0;
  const value = Number(discount?.value) || 0;
  const after = (l) => r2(l.gross - l.promo_discount);
  if (value > 0) {
    const base = lines.filter((l) => l.allow_discount).reduce((t, l) => t + after(l), 0);
    if (base <= 0) return { error: "ទំនិញទាំងនេះមិនអនុញ្ញាតបញ្ចុះតម្លៃ / These items can't be discounted" };
    if (discount.type === "percent") {
      if (value > 100) return { error: "បញ្ចុះតម្លៃលើស 100% / Discount over 100%" };
      discountTotal = r2((base * value) / 100);
    } else {
      if (value > base + 0.0001) return { error: "បញ្ចុះតម្លៃលើសតម្លៃទំនិញ / Discount is more than the items" };
      discountTotal = r2(value);
    }
    let left = discountTotal;
    const dl = lines.filter((l) => l.allow_discount);
    dl.forEach((l, i) => {
      const share = i === dl.length - 1 ? left : r2((discountTotal * after(l)) / base);
      l.discount = r2(Math.min(share, after(l)));
      left = r2(left - l.discount);
    });
  }
  lines.forEach((l) => {
    l.discount = r2(l.discount + l.promo_discount); // the line keeps promotion + its share of the bill discount
    l.line_total = r2(l.gross - l.discount);
  });
  const net = r2(subtotal - promoTotal - discountTotal);

  const mode = setting?.tax_mode || "none";
  const taxRate = Number(setting?.tax_rate) || 0;
  const taxable = lines.filter((l) => l.is_taxable).reduce((t, l) => t + l.line_total, 0);
  let tax = 0;
  let total = net;
  if (mode === "exclusive" && taxRate > 0) {
    tax = r2((taxable * taxRate) / 100);
    total = r2(net + tax);
  } else if (mode === "inclusive" && taxRate > 0) {
    tax = r2((taxable * taxRate) / (100 + taxRate));
  }
  const rateValue = Number(rate?.rate) || 4100;
  return {
    lines: lines.map(({ gross, allow_discount, is_taxable, category_id, brand_id, ...l }) => l),
    subtotal,
    promo_total: promoTotal,
    promotions: applied,
    discount_total: discountTotal,
    tax_mode: mode,
    tax_rate: taxRate,
    tax_amount: tax,
    total,
    rate: rateValue,
    total_khr: roundKhr(total * rateValue, Number(setting?.khr_rounding) || 100),
  };
}

/**
 * payments: [{ method, amount, reference }]  (method from the local copy)
 * → { payments, paid_usd, change_usd, change_khr } | { error }
 * Cash may be more than the total (change is given back, shown in USD and KHR);
 * QR / card / bank must not be more than what is left to pay.
 */
function settle(totals, payments, setting) {
  const rate = totals.rate;
  const step = Number(setting?.khr_rounding) || 100;
  if (!payments.length) return { error: "សូមជ្រើសរើសវិធីបង់ប្រាក់ / Choose how the customer pays" };
  const out = [];
  let paid = 0;
  let nonCash = 0;
  for (const p of payments) {
    const m = p.method;
    const amount = Number(p.amount);
    if (!(amount > 0)) return { error: `${m.name_en}: ចំនួនទឹកប្រាក់ខុស / wrong amount` };
    if (m.requires_reference && !String(p.reference || "").trim()) return { error: `${m.name_en}: សូមបញ្ចូលលេខយោង / reference no. required` };
    const currency = m.currency === "KHR" ? "KHR" : "USD";
    const usd = currency === "KHR" ? amount / rate : amount;
    paid += usd;
    // exchange credit can be more than the bill: the rest is handed back like cash change
    if (m.type !== "cash" && m.type !== "credit") nonCash += usd;
    out.push({
      method_id: m._id,
      code: m.code,
      name_kh: m.name_kh,
      name_en: m.name_en,
      type: m.type,
      currency,
      amount: currency === "KHR" ? Math.round(amount) : r2(amount),
      amount_usd: r4(usd),
      reference: String(p.reference || "").trim().slice(0, 60),
    });
  }
  // paid enough? (in KHR the total is rounded, so compare both ways)
  const enough = paid + 0.005 >= totals.total || paid * rate + 1 >= totals.total_khr;
  if (!enough) return { error: `មិនទាន់គ្រប់ — ខ្វះ $${r2(totals.total - paid).toFixed(2)} / Not enough paid` };
  if (nonCash > totals.total + 0.005) return { error: "QR / កាត មិនអាចលើសតម្លៃ (គ្មានប្រាក់អាប់) / QR / card can't be more than the total" };
  // change back: whole dollars in USD + the rest in riel when the customer paid some USD cash,
  // all in riel when they paid in riel only (less than the smallest riel note is not given)
  const change = Math.max(0, r4(paid - totals.total));
  const paidUsdCash = out.some((p) => (p.type === "cash" || p.type === "credit") && p.currency === "USD");
  const giveUsd = paidUsdCash ? Math.floor(change + 0.0001) : 0;
  const giveKhr = roundKhr((change - giveUsd) * rate, step);
  const given = r2(giveUsd + giveKhr / rate);
  return {
    payments: out,
    paid_usd: r4(paid),
    change_usd: giveUsd || giveKhr ? r2(change) : 0, // what the customer gets back (USD value)
    change_khr: roundKhr(change * rate, step), // the same, all in riel (for the screen)
    change_give_usd: giveUsd, // handed back in USD notes
    change_give_khr: giveKhr, // handed back in riel
    change_given_usd: given,
  };
}

module.exports = { priceCart, settle, r2, r4, roundKhr };

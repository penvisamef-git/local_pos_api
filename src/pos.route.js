const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcrypt");
const { Config, Data, Product, User, Session, Shift, Sale, Hold, Refund, PosEvent, nextSeq } = require("./models");
const sync = require("./sync");
const { priceCart, settle, r2, r4, roundKhr } = require("./money");
const L2 = (kh, en) => `${kh} / ${en}`;

// /api/pos — called by the POS screen (local_pos) on this computer.
// Login is a staff PIN; the answer gives a token for the header  x-pos-token.
const router = express.Router();
const SESSION_HOURS = 14;
const LOCK_AFTER = 5; // wrong PINs in a row → wait 1 minute
const wrong = new Map(); // user_id → { count, until }

const ok = (res, data, message) => res.json({ success: true, data, message });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err.offline || (err.status && err.status < 500)) console.warn(`⚠️  ${req.method} ${req.originalUrl}: ${err.message}`);
    else console.error(err);
    res.status(err.offline ? 503 : err.status && err.status < 500 ? err.status : 500).json({ success: false, message: err.message });
  }
};
const fullName = (u) => `${u.firstname || ""} ${u.lastname || ""}`.trim() || u.email;
const yymm = (d = new Date()) => {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", year: "2-digit", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return { ym: `${g("year")}${g("month")}`, ymd: `${g("year")}${g("month")}${g("day")}` };
};

// ---------------- session (x-pos-token) ----------------
async function auth(req, res, next) {
  try {
    const token = String(req.headers["x-pos-token"] || "");
    const s = token ? await Session.findOne({ token, expires_at: { $gt: new Date() } }).lean() : null;
    if (!s) return bad(res, "សូមចូលម្តងទៀត / Please log in again", 401);
    req.pos = s;
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}
const needPaired = async (req, res, next) => {
  const cfg = await sync.getConfig();
  if (!cfg?.device_key) return bad(res, "POS មិនទាន់ភ្ជាប់ / POS is not paired", 409);
  req.cfg = cfg;
  next();
};

async function checkPin(userId, pin) {
  const lock = wrong.get(String(userId));
  if (lock && lock.until > Date.now()) return { error: `សូមរង់ចាំ ${Math.ceil((lock.until - Date.now()) / 1000)} វិនាទី / Wait a moment`, status: 429 };
  const u = await User.findById(String(userId)).lean();
  if (!u || !u.pin_hash) return { error: "រកមិនឃើញអ្នកប្រើ / User not found", status: 404 };
  if (!(await bcrypt.compare(String(pin || ""), u.pin_hash))) {
    const c = (lock?.count || 0) + 1;
    wrong.set(String(userId), { count: c, until: c >= LOCK_AFTER ? Date.now() + 60 * 1000 : 0 });
    return { error: "លេខ PIN ខុស / Wrong PIN", status: 401 };
  }
  wrong.delete(String(userId));
  return { user: u };
}

// ===================================== STATUS / PAIRING / SYNC ================================================
router.get("/status", wrap(async (req, res) => {
  const [cfg, data, pending, failed, open, held] = await Promise.all([
    sync.getConfig(),
    Data.findById("main").select("pulled_at warehouse device rate setting.ui_theme").lean(),
    Sale.countDocuments({ synced: false, state: "paid" }).then(async (n) => n + (await Refund.countDocuments({ synced: false }))),
    Sale.countDocuments({ synced: false, state: "paid", sync_error: { $ne: "" } }),
    Shift.findOne({ state: "open" }).lean(),
    Hold.countDocuments({}),
  ]);
  ok(res, {
    held_carts: held,
    ui_theme: data?.setting?.ui_theme || "forest",
    display_screens: watchers.size, // customer displays open now
    paired: !!cfg?.device_key,
    has_data: !!data?.pulled_at,
    device: cfg?.device || null,
    warehouse: cfg?.warehouse || null,
    cloud_url: sync.CLOUD_URL(),
    online: sync.state.online,
    last_online_at: cfg?.last_online_at || null,
    last_pull_at: cfg?.last_pull_at || null,
    last_push_at: cfg?.last_push_at || null,
    last_error: cfg?.last_error || "",
    revoked_at: cfg?.revoked_at || null, // unlinked by the admin web → the screen shows why
    revoked_reason: cfg?.revoked_reason || "",
    pending_sales: pending,
    failed_sales: failed,
    shift: open ? { _id: open._id, shift_no: open.shift_no, opened_by_name: open.opened_by_name, opened_at: open.opened_at } : null,
    server_time: new Date(),
  });
}));

router.post("/pair", wrap(async (req, res) => {
  const cfg = await sync.getConfig();
  if (cfg?.device_key) return bad(res, "POS នេះបានភ្ជាប់រួចហើយ / Already paired", 409);
  const code = String(req.body?.code || "").replace(/\D/g, "");
  if (code.length !== 6) return bad(res, "លេខកូដមាន 6 ខ្ទង់ / The code has 6 digits");
  const d = await sync.pair(code);
  ok(res, { device: d.device, warehouse: d.warehouse }, `បានភ្ជាប់ ${d.device.code}`);
}));

// a manager can unlink this computer (only when every sale is in the cloud)
router.post("/unpair", auth, wrap(async (req, res) => {
  if (!req.pos.is_manager) return bad(res, "សម្រាប់អ្នកគ្រប់គ្រងហាង / Shop manager only", 403);
  if (await Sale.exists({ synced: false, state: "paid" })) return bad(res, "មានវិក្កយបត្រមិនទាន់ផ្ញើទៅ Cloud — ភ្ជាប់អ៊ីនធឺណិតសិន / Some sales are not sent yet");
  await Config.deleteOne({ _id: "main" });
  await Session.deleteMany({});
  ok(res, true, "បានផ្តាច់ POS");
}));

router.post("/sync", auth, needPaired, wrap(async (req, res) => {
  const pushed = await sync.push();
  // the admin unlinked this POS meanwhile → say why (the screen goes back to the pairing code)
  const unlinked = async () => {
    const c = await sync.getConfig();
    return c?.device_key ? null : c?.revoked_reason || "POS មិនទាន់ភ្ជាប់ / POS is not paired";
  };
  if (await unlinked()) return bad(res, await unlinked(), 403);
  let pulled;
  try {
    pulled = await sync.pull();
  } catch (err) {
    if (await unlinked()) return bad(res, await unlinked(), 403);
    throw err;
  }
  const theme = (await Data.findById("main").select("setting.ui_theme").lean())?.setting?.ui_theme || "forest";
  watchers.forEach((w) => w.write(`event: shop\ndata: ${JSON.stringify({ ui_theme: theme })}\n\n`)); // customer displays reload logo / theme
  ok(res, { pushed, pulled, ui_theme: theme }, "បានធ្វើសមកាលកម្ម / Synced");
}));

// ===================================== LOGIN (PIN) ================================================
router.get("/users", needPaired, wrap(async (req, res) => {
  const users = await User.find({}).select("firstname lastname role is_manager").sort({ is_manager: 1, firstname: 1 }).lean();
  ok(res, users.map((u) => ({ _id: u._id, name: fullName(u), role: u.role, is_manager: !!u.is_manager })));
}));

router.post("/login", needPaired, wrap(async (req, res) => {
  const r = await checkPin(req.body?.user_id, req.body?.pin);
  if (r.error) return bad(res, r.error, r.status);
  const token = crypto.randomBytes(24).toString("base64url");
  const s = await Session.create({ token, user_id: r.user._id, name: fullName(r.user), role: r.user.role, is_manager: !!r.user.is_manager, expires_at: new Date(Date.now() + SESSION_HOURS * 3600 * 1000) });
  PosEvent.create({ uuid: crypto.randomUUID(), action: "login", user_id: s.user_id, name: s.name }).then(() => sync.push()).catch(() => {});
  ok(res, { token, user: { _id: s.user_id, name: s.name, role: s.role, is_manager: s.is_manager } }, `សួស្តី ${s.name}`);
}));

// a shop manager approves something on the cashier's screen (sell out-of-stock items …) — checks the PIN only
router.post("/approve", auth, wrap(async (req, res) => {
  const r = await checkPin(req.body?.user_id, req.body?.pin);
  if (r.error) return bad(res, r.error, r.status === 401 ? 403 : r.status); // 401 would log the cashier out
  if (!r.user.is_manager) return bad(res, "ត្រូវការ PIN អ្នកគ្រប់គ្រងហាង / A shop manager's PIN is needed", 403);
  ok(res, { user_id: r.user._id, name: fullName(r.user) });
}));

router.post("/logout", auth, wrap(async (req, res) => {
  await Session.deleteOne({ token: req.pos.token });
  PosEvent.create({ uuid: crypto.randomUUID(), action: "logout", user_id: req.pos.user_id, name: req.pos.name }).then(() => sync.push()).catch(() => {});
  ok(res, true);
}));

router.get("/me", auth, wrap(async (req, res) => ok(res, { _id: req.pos.user_id, name: req.pos.name, role: req.pos.role, is_manager: req.pos.is_manager })));

// ===================================== CATALOG (everything the sell screen needs) ================================================
router.get("/catalog", auth, wrap(async (req, res) => {
  const [data, products] = await Promise.all([Data.findById("main").lean(), Product.find({}).sort({ sort: 1 }).lean()]);
  if (!data) return bad(res, "មិនទាន់មានទិន្នន័យ — សូមភ្ជាប់អ៊ីនធឺណិត ហើយធ្វើសមកាលកម្ម / No data yet — connect and sync", 409);
  ok(res, { ...data, products: products.map((p) => p.doc) });
}));

// ===================================== SHIFT ================================================
const shiftTotals = async (shift) => {
  const sales = await Sale.find({ shift_id: String(shift._id), state: "paid" }).lean();
  const byMethod = {};
  let cashUsd = 0;
  let cashKhr = 0;
  sales.forEach((s) => {
    s.payments.forEach((p) => {
      const k = p.code;
      if (!byMethod[k]) byMethod[k] = { code: p.code, name_kh: p.name_kh, name_en: p.name_en, type: p.type, currency: p.currency, amount: 0, amount_usd: 0, count: 0 };
      byMethod[k].amount += p.amount;
      byMethod[k].amount_usd += p.amount_usd;
      byMethod[k].count += 1;
      if (p.type === "cash") {
        if (p.currency === "KHR") cashKhr += p.amount;
        else cashUsd += p.amount;
      }
    });
    // change handed back from the drawer
    cashUsd -= s.change_give_usd || 0;
    cashKhr -= s.change_give_khr || 0;
  });
  // money given back (refund / void) from this drawer
  const refunds = await Refund.find({ shift_id: String(shift._id) }).lean();
  const refundMethods = {};
  refunds.forEach((rf) =>
    rf.payments.forEach((p) => {
      const k = p.code;
      if (!refundMethods[k]) refundMethods[k] = { code: p.code, name_kh: p.name_kh, name_en: p.name_en, type: p.type, currency: p.currency, amount: 0, amount_usd: 0, count: 0 };
      refundMethods[k].amount += p.amount;
      refundMethods[k].amount_usd += p.amount_usd;
      refundMethods[k].count += 1;
      if (p.type === "cash") {
        if (p.currency === "KHR") cashKhr -= p.amount;
        else cashUsd -= p.amount;
      }
    }),
  );
  [...Object.values(byMethod), ...Object.values(refundMethods)].forEach((m) => {
    m.amount = m.currency === "KHR" ? Math.round(m.amount) : r2(m.amount);
    m.amount_usd = r2(m.amount_usd);
  });
  const refundTotal = r2(refunds.reduce((t, r) => t + r.total, 0));
  const salesTotal = r2(sales.reduce((t, s) => t + s.total, 0));
  return {
    refund_count: refunds.length,
    refund_total: refundTotal,
    refund_methods: Object.values(refundMethods),
    net_total: r2(salesTotal - refundTotal),
    invoice_count: sales.length,
    sales_total: r2(sales.reduce((t, s) => t + s.total, 0)),
    discount_total: r2(sales.reduce((t, s) => t + (s.discount_total || 0), 0)),
    tax_total: r2(sales.reduce((t, s) => t + (s.tax_amount || 0), 0)),
    items_qty: sales.reduce((t, s) => t + s.items.reduce((a, i) => a + i.qty, 0), 0),
    methods: Object.values(byMethod),
    expected_usd: r2(shift.opening_usd + cashUsd),
    expected_khr: Math.round(shift.opening_khr + cashKhr),
  };
};

router.get("/shift/current", auth, wrap(async (req, res) => {
  const s = await Shift.findOne({ state: "open" }).lean();
  ok(res, s ? { ...s, totals: await shiftTotals(s) } : null);
}));

router.post("/shift/open", auth, needPaired, wrap(async (req, res) => {
  if (await Shift.exists({ state: "open" })) return bad(res, "មានវេនកំពុងបើករួចហើយ / A shift is already open", 409);
  const usd = Number(req.body?.opening_usd) || 0;
  const khr = Math.round(Number(req.body?.opening_khr) || 0);
  if (usd < 0 || khr < 0) return bad(res, "ចំនួនខុស / Wrong amount");
  const { ymd } = yymm();
  const shiftNo = `${req.cfg.device.code}-S${ymd}-${await nextSeq(`S${ymd}`)}`;
  const s = await Shift.create({ shift_no: shiftNo, opened_by: req.pos.user_id, opened_by_name: req.pos.name, opening_usd: r2(usd), opening_khr: khr });
  ok(res, { ...s.toObject(), totals: await shiftTotals(s) }, `បានបើកវេន ${shiftNo}`);
}));

router.post("/shift/close", auth, wrap(async (req, res) => {
  const s = await Shift.findOne({ state: "open" });
  if (!s) return bad(res, "មិនមានវេនកំពុងបើក / No open shift", 404);
  const totals = await shiftTotals(s);
  const usd = r2(Number(req.body?.counted_usd) || 0);
  const khr = Math.round(Number(req.body?.counted_khr) || 0);
  const data = await Data.findById("main").select("rate").lean();
  const rate = Number(data?.rate?.rate) || 4100;
  const diffUsd = r2(usd - totals.expected_usd);
  const diffKhr = khr - totals.expected_khr;
  s.state = "closed";
  s.closed_by = req.pos.user_id;
  s.closed_by_name = req.pos.name;
  s.closed_at = new Date();
  s.counted_usd = usd;
  s.counted_khr = khr;
  s.note = String(req.body?.note || "").slice(0, 300);
  s.report = { ...totals, counted_usd: usd, counted_khr: khr, diff_usd: diffUsd, diff_khr: diffKhr, diff_total_usd: r2(diffUsd + diffKhr / rate), rate };
  s.synced = false; // the closing goes to the cloud with the next push
  await s.save();
  sync.push().catch(() => {});
  ok(res, s.toObject(), `បានបិទវេន ${s.shift_no}`);
}));

router.get("/shift/:id", auth, wrap(async (req, res) => {
  const s = await Shift.findById(req.params.id).lean().catch(() => null);
  if (!s) return bad(res, "រកមិនឃើញវេន / Shift not found", 404);
  ok(res, s.state === "open" ? { ...s, totals: await shiftTotals(s) } : s);
}));

router.get("/shift", auth, wrap(async (req, res) => {
  ok(res, await Shift.find({}).sort({ opened_at: -1 }).limit(Math.min(Number(req.query.limit) || 20, 100)).lean());
}));

// ===================================== HOLD (park a cart) ================================================
// A customer goes back to shop more → hold their cart, serve the next customer, resume it later.
router.get("/hold", auth, wrap(async (req, res) => {
  ok(res, await Hold.find({}).sort({ created_date: 1 }).lean());
}));

// { label, items: [{ variant_id, unit_id, qty }], discount: { type, value }, note, total }
router.post("/hold", auth, wrap(async (req, res) => {
  const b = req.body || {};
  const items = (Array.isArray(b.items) ? b.items : [])
    .filter((i) => i && i.variant_id && Number(i.qty) > 0)
    .slice(0, 300)
    .map((i) => ({ variant_id: String(i.variant_id), unit_id: String(i.unit_id || ""), qty: Number(i.qty) }));
  if (!items.length) return bad(res, "មិនមានទំនិញក្នុងកន្ត្រក / The cart is empty");
  if ((await Hold.countDocuments({})) >= 50) return bad(res, "រក្សាទុកច្រើនពេក (50) — សូមលុប ឬបន្តលក់ខ្លះសិន / Too many held carts (50)");
  const { ymd } = yymm();
  const no = await nextSeq(`H${ymd}`);
  const discount = b.discount && Number(b.discount.value) > 0 ? { type: b.discount.type === "percent" ? "percent" : "amount", value: Number(b.discount.value) } : null;
  const h = await Hold.create({
    hold_no: no,
    label: String(b.label || "").trim().slice(0, 60),
    items,
    discount,
    note: String(b.note || "").slice(0, 200),
    total: r2(Number(b.total) || 0),
    user_id: req.pos.user_id,
    user_name: req.pos.name,
  });
  ok(res, h.toObject(), `បានរក្សាទុក #${no}`);
}));

// resume = take it back (it leaves the list) · or just delete it
router.delete("/hold/:id", auth, wrap(async (req, res) => {
  const h = await Hold.findByIdAndDelete(req.params.id).lean().catch(() => null);
  if (!h) return bad(res, "រកមិនឃើញ / Held cart not found", 404);
  ok(res, h);
}));

// ===================================== SALE ================================================
// body: { items: [{ variant_id, unit_id, qty }], discount: { type, value }, approver: { user_id, pin },
//         payments: [{ method_id, amount, reference }], note }
router.post("/sale", auth, needPaired, wrap(async (req, res) => {
  const shift = await Shift.findOne({ state: "open" }).lean();
  if (!shift) return bad(res, "សូមបើកវេនសិន / Open a shift first", 409);
  const data = await Data.findById("main").lean();
  if (!data) return bad(res, "មិនទាន់មានទិន្នន័យ / No data — sync first", 409);
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length || items.length > 300) return bad(res, "មិនមានទំនិញក្នុងកន្ត្រក / The cart is empty");

  // look up every line in the local copy
  const docs = await Product.find({ "doc.variants._id": { $in: items.map((i) => String(i.variant_id)) } }).lean();
  const cart = [];
  for (const i of items) {
    const p = docs.map((d) => d.doc).find((d) => d.variants.some((v) => String(v._id) === String(i.variant_id)));
    if (!p) return bad(res, "រកមិនឃើញទំនិញ — សូមធ្វើសមកាលកម្ម / Item not found — sync");
    const v = p.variants.find((x) => String(x._id) === String(i.variant_id));
    const unit = p.units.find((u) => String(u._id) === String(i.unit_id)) || p.units[0];
    cart.push({ product: p, variant: v, unit, qty: Number(i.qty) });
  }

  // selling more than the shop stock (0 or less left): a shop manager may; a cashier needs a manager's PIN
  const need = new Map();
  for (const c of cart) {
    if (c.product.track_stock === false) continue;
    const k = String(c.variant._id);
    need.set(k, (need.get(k) || 0) + Number(c.qty) * (c.unit.factor || 1));
  }
  const over = [];
  for (const c of cart) {
    const k = String(c.variant._id);
    if (!need.has(k) || over.some((o) => o.variant_id === k)) continue;
    const stock = Number(c.variant.stock) || 0;
    if (need.get(k) > stock + 1e-9) over.push({ variant_id: k, sku: c.variant.code, name_kh: c.variant.name_kh, name_en: c.variant.name_en, stock, qty: need.get(k) });
  }
  let stockBy = null;
  if (over.length) {
    if (req.pos.is_manager) stockBy = { _id: req.pos.user_id, name: req.pos.name };
    else {
      const a = b.stock_approver || {};
      const refuse = (msg, status = 403) => res.status(status).json({ success: false, code: "STOCK_APPROVAL", message: msg, items: over });
      if (!a.user_id || !a.pin) return refuse("ទំនិញអស់ស្តុក — ត្រូវការ PIN អ្នកគ្រប់គ្រងហាង / Out of stock — a shop manager's PIN is needed");
      const r = await checkPin(a.user_id, a.pin);
      if (r.error) return refuse(`អស់ស្តុក: ${r.error}`, r.status === 401 ? 403 : r.status);
      if (!r.user.is_manager) return refuse("ត្រូវការ PIN អ្នកគ្រប់គ្រងហាង / A shop manager's PIN is needed");
      stockBy = { _id: r.user._id, name: fullName(r.user) };
    }
  }

  // discount: shop managers may give it; a cashier needs a manager's PIN
  const discount = b.discount && Number(b.discount.value) > 0 ? { type: b.discount.type === "percent" ? "percent" : "amount", value: Number(b.discount.value) } : null;
  let discountBy = null;
  if (discount) {
    if (req.pos.is_manager) discountBy = { _id: req.pos.user_id, name: req.pos.name };
    else {
      const a = b.approver || {};
      if (!a.user_id || !a.pin) return bad(res, "ត្រូវការ PIN អ្នកគ្រប់គ្រងហាង / A shop manager's PIN is needed", 403);
      const r = await checkPin(a.user_id, a.pin);
      if (r.error) return bad(res, `ការអនុម័តបញ្ចុះតម្លៃ: ${r.error}`, r.status === 401 ? 403 : r.status);
      if (!r.user.is_manager) return bad(res, "ត្រូវការ PIN អ្នកគ្រប់គ្រងហាង / A shop manager's PIN is needed", 403);
      discountBy = { _id: r.user._id, name: fullName(r.user) };
    }
  }

  const totals = priceCart(cart, { discount, setting: data.setting, rate: data.rate });
  if (totals.error) return bad(res, totals.error);
  const methods = new Map((data.payment_methods || []).map((m) => [String(m._id), m]));
  const pays = [];
  for (const p of Array.isArray(b.payments) ? b.payments : []) {
    const m = methods.get(String(p.method_id));
    if (!m) return bad(res, "វិធីបង់ប្រាក់មិនត្រឹមត្រូវ / Unknown payment method");
    pays.push({ method: m, amount: p.amount, reference: p.reference });
  }
  const paid = settle(totals, pays, data.setting);
  if (paid.error) return bad(res, paid.error);

  const { ym } = yymm();
  const invoiceNo = `${req.cfg.device.code}-${ym}-${String(await nextSeq(`INV${ym}`)).padStart(5, "0")}`;
  const sale = await Sale.create({
    uuid: crypto.randomUUID(),
    invoice_no: invoiceNo,
    shift_id: String(shift._id),
    shift_no: shift.shift_no,
    cashier_id: req.pos.user_id,
    cashier_name: req.pos.name,
    discount_by: discountBy?._id || null,
    discount_by_name: discountBy?.name || "",
    stock_override_by: stockBy?._id || null,
    stock_override_by_name: stockBy?.name || "",
    stock_override_items: over,
    sold_at: new Date(),
    items: totals.lines,
    subtotal: totals.subtotal,
    discount_type: discount?.type || null,
    discount_value: discount?.value || 0,
    discount_total: totals.discount_total,
    tax_mode: totals.tax_mode,
    tax_rate: totals.tax_rate,
    tax_name: data.setting?.tax_name || "VAT",
    tax_amount: totals.tax_amount,
    total: totals.total,
    rate: totals.rate,
    total_khr: totals.total_khr,
    payments: paid.payments,
    paid_usd: paid.paid_usd,
    change_usd: paid.change_usd,
    change_khr: paid.change_khr,
    change_give_usd: paid.change_give_usd,
    change_give_khr: paid.change_give_khr,
    note: String(b.note || "").slice(0, 300),
  });
  // the shop stock on this screen goes down at once (the cloud gets it with the push)
  for (const l of totals.lines) {
    await Product.updateOne({ "doc.variants._id": l.variant_id }, { $inc: { "doc.variants.$.stock": -l.base_qty } }).catch(() => {});
  }
  sync.push().catch(() => {});
  ok(res, sale.toObject(), `បានលក់ ${invoiceNo}`);
}));

router.get("/sale", auth, wrap(async (req, res) => {
  const filter = {};
  if (req.query.shift_id) filter.shift_id = String(req.query.shift_id);
  if (req.query.q) filter.invoice_no = { $regex: String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  if (req.query.pending === "true") Object.assign(filter, { synced: false, state: "paid" });
  // invoices the cloud refused (any shift): see why, try again, or remove (manager)
  if (req.query.problem === "true") Object.assign(filter, { synced: false, state: "paid", sync_error: { $ne: "" } });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  ok(res, await Sale.find(filter).sort({ sold_at: -1 }).limit(limit).lean());
}));

// an invoice the cloud refused: try to send it again now
router.post("/sale/:id/retry", auth, needPaired, wrap(async (req, res) => {
  const s = await Sale.findOne({ $or: [{ uuid: req.params.id }, { invoice_no: req.params.id }] });
  if (!s) return bad(res, "រកមិនឃើញវិក្កយបត្រ / Invoice not found", 404);
  if (s.synced) return ok(res, s.toObject(), "បានផ្ញើរួចហើយ / Already sent");
  s.sync_error = "";
  await s.save();
  await sync.push().catch(() => {});
  const after = await Sale.findById(s._id).lean();
  if (after.synced) return ok(res, after, `បានផ្ញើ ${after.invoice_no} / Sent`);
  bad(res, after.sync_error || "មិនទាន់អាចផ្ញើបាន / Could not send yet", 409);
}));

// an invoice that can never be sent (item deleted in the cloud, wrong POS, test sale …):
// a shop manager removes it → kept here as "discarded", never sent, left out of totals
router.post("/sale/:id/discard", auth, wrap(async (req, res) => {
  const s = await Sale.findOne({ $or: [{ uuid: req.params.id }, { invoice_no: req.params.id }] });
  if (!s) return bad(res, "រកមិនឃើញវិក្កយបត្រ / Invoice not found", 404);
  if (s.synced) return bad(res, "វិក្កយបត្រនេះបានផ្ញើទៅ Cloud រួចហើយ / Already in the cloud — cannot remove here", 409);
  if (s.state !== "paid") return bad(res, "បានដកចេញរួចហើយ / Already removed", 409);
  const reason = String(req.body?.reason || "").trim().slice(0, 200);
  if (!reason) return bad(res, "សូមសរសេរមូលហេតុ / Write the reason");
  let by = req.pos.is_manager ? { _id: req.pos.user_id, name: req.pos.name } : null;
  if (!by) {
    const a = req.body?.approver || {};
    if (!a.user_id || !a.pin) return bad(res, "ត្រូវការ PIN អ្នកគ្រប់គ្រងហាង / A shop manager's PIN is needed", 403);
    const r = await checkPin(a.user_id, a.pin);
    if (r.error) return bad(res, r.error, r.status === 401 ? 403 : r.status);
    if (!r.user.is_manager) return bad(res, "ត្រូវការ PIN អ្នកគ្រប់គ្រងហាង / A shop manager's PIN is needed", 403);
    by = { _id: r.user._id, name: fullName(r.user) };
  }
  Object.assign(s, { state: "discarded", discarded_at: new Date(), discarded_by: by._id, discarded_by_name: by.name, discard_reason: reason });
  await s.save();
  console.warn(`🗑  ${s.invoice_no} removed by ${by.name}: ${reason} (was: ${s.sync_error})`);
  ok(res, s.toObject(), `បានដក ${s.invoice_no} / Removed`);
}));

router.get("/sale/:id", auth, wrap(async (req, res) => {
  const s = await Sale.findOne({ $or: [{ uuid: req.params.id }, { invoice_no: req.params.id }] }).lean();
  if (!s) return bad(res, "រកមិនឃើញវិក្កយបត្រ / Invoice not found", 404);
  ok(res, s);
}));

// receipt data (sale + shop header) for printing / reprinting
router.get("/receipt/:id", auth, wrap(async (req, res) => {
  const [s, data] = await Promise.all([Sale.findOne({ $or: [{ uuid: req.params.id }, { invoice_no: req.params.id }] }).lean(), Data.findById("main").select("setting warehouse device").lean()]);
  if (!s) return bad(res, "រកមិនឃើញវិក្កយបត្រ / Invoice not found", 404);
  ok(res, { sale: s, setting: data?.setting || {}, warehouse: data?.warehouse || {}, device: data?.device || {} });
}));

// ===================================== REFUND / VOID ================================================
// Money back for some items (refund) or the whole invoice (void). The drawer of the OPEN shift pays it back.
// A shop manager may; a cashier needs a manager's PIN. Stock comes back on this screen at once and in the cloud with the push.
// body: { lines: [{ index, qty }] | all: true, reason, method_id, approver: { user_id, pin } }
router.post("/sale/:id/refund", auth, needPaired, wrap(async (req, res) => {
  const b = req.body || {};
  const s = await Sale.findOne({ $or: [{ uuid: req.params.id }, { invoice_no: req.params.id }] });
  if (!s) return bad(res, "រកមិនឃើញវិក្កយបត្រ / Invoice not found", 404);
  if (s.state !== "paid") return bad(res, "វិក្កយបត្រនេះត្រូវបានដកចេញ / This invoice was removed", 409);
  const shift = await Shift.findOne({ state: "open" }).lean();
  if (!shift) return bad(res, "សូមបើកវេនសិន (លុយសងចេញពីថតលុយ) / Open a shift first (the money comes from the drawer)", 409);
  const reason = String(b.reason || "").trim().slice(0, 200);
  if (!reason) return bad(res, "សូមសរសេរមូលហេតុ / Write the reason");

  // what is asked, line by line (never more than what is left)
  const items = s.items.map((i) => ({ ...i }));
  const want = new Map();
  if (b.all) items.forEach((i, k) => want.set(k, r4(i.qty - (i.refunded_qty || 0))));
  else (Array.isArray(b.lines) ? b.lines : []).forEach((l) => want.set(Number(l.index), r4((want.get(Number(l.index)) || 0) + Number(l.qty))));
  const lines = [];
  for (const [k, q] of want) {
    const i = items[k];
    if (!i) return bad(res, "បន្ទាត់ទំនិញខុស / Wrong line");
    if (!(q > 0)) continue;
    const left = r4(i.qty - (i.refunded_qty || 0));
    if (q > left + 1e-9) return bad(res, `${i.sku}: ${L2("សងបានតែ", "can refund only")} ${left}`);
    lines.push({ k, i, q });
  }
  if (!lines.length) return bad(res, "សូមជ្រើសទំនិញដែលត្រូវសង / Choose what to refund");

  // approval
  let by = req.pos.is_manager ? { _id: req.pos.user_id, name: req.pos.name } : null;
  if (!by) {
    const a = b.approver || {};
    if (!a.user_id || !a.pin) return bad(res, "ត្រូវការ PIN អ្នកគ្រប់គ្រងហាង / A shop manager's PIN is needed", 403);
    const r = await checkPin(a.user_id, a.pin);
    if (r.error) return bad(res, r.error, r.status === 401 ? 403 : r.status);
    if (!r.user.is_manager) return bad(res, "ត្រូវការ PIN អ្នកគ្រប់គ្រងហាង / A shop manager's PIN is needed", 403);
    by = { _id: r.user._id, name: fullName(r.user) };
  }

  // money: each line's share of what the customer paid (bill discount and added tax included)
  const sumLines = s.items.reduce((t, i) => t + (i.line_total || 0), 0);
  const factor = sumLines > 0 ? s.total / sumLines : 1;
  const out = lines.map(({ k, i, q }) => ({
    index: k,
    variant_id: i.variant_id,
    product_id: i.product_id,
    unit_id: i.unit_id,
    sku: i.sku,
    name_kh: i.name_kh,
    name_en: i.name_en,
    unit_code: i.unit_code,
    unit_name_kh: i.unit_name_kh,
    unit_name_en: i.unit_name_en,
    factor: i.factor || 1,
    qty: q,
    base_qty: r4((i.base_qty / i.qty) * q),
    price: i.price,
    amount: r2(((i.line_total || 0) / i.qty) * q * factor),
  }));
  const fullLeft = s.items.reduce((t, i) => t + r2(((i.line_total || 0) / i.qty) * r4(i.qty - (i.refunded_qty || 0)) * factor), 0);
  let total = r2(out.reduce((t, l) => t + l.amount, 0));
  const everything = lines.length === s.items.filter((i) => i.qty - (i.refunded_qty || 0) > 1e-9).length && lines.every(({ i, q }) => Math.abs(q - (i.qty - (i.refunded_qty || 0))) < 1e-9);
  if (everything) total = r2(Math.min(s.total - (s.refunded_total || 0), Math.max(total, fullLeft))); // the last refund takes the rounding cents
  const data = await Data.findById("main").lean();
  const methods = data?.payment_methods || [];
  const m = methods.find((x) => String(x._id) === String(b.method_id)) || methods.find((x) => x.type === "cash" && x.currency !== "KHR") || methods[0];
  if (!m) return bad(res, "គ្មានវិធីបង់ប្រាក់ / No payment method");
  const rate = s.rate || Number(data?.rate?.rate) || 4100;
  const step = Number(data?.setting?.khr_rounding) || 100;
  const khrAmount = roundKhr(total * rate, step);
  const payment = { method_id: m._id, code: m.code, name_kh: m.name_kh, name_en: m.name_en, type: m.type, currency: m.currency === "KHR" ? "KHR" : "USD", amount: m.currency === "KHR" ? khrAmount : total, amount_usd: total };

  const { ym } = yymm();
  const refundNo = `${req.cfg.device.code}-R${ym}-${String(await nextSeq(`R${ym}`)).padStart(5, "0")}`;
  const refund = await Refund.create({
    uuid: crypto.randomUUID(),
    refund_no: refundNo,
    kind: everything && !(s.refunded_total > 0) ? "void" : "refund",
    sale_uuid: s.uuid,
    invoice_no: s.invoice_no,
    shift_id: String(shift._id),
    shift_no: shift.shift_no,
    cashier_id: req.pos.user_id,
    cashier_name: req.pos.name,
    approved_by: by._id,
    approved_by_name: by.name,
    refunded_at: new Date(),
    reason,
    items: out,
    total,
    rate,
    total_khr: khrAmount,
    payments: [payment],
  });
  // the invoice remembers what went back
  lines.forEach(({ k, q }) => {
    items[k].refunded_qty = r4((items[k].refunded_qty || 0) + q);
  });
  s.items = items;
  s.refunded_total = r2((s.refunded_total || 0) + total);
  s.refund_status = items.every((i) => i.qty - (i.refunded_qty || 0) < 1e-9) ? "full" : "partial";
  s.markModified("items");
  await s.save();
  // stock back on this screen
  for (const l of out) await Product.updateOne({ "doc.variants._id": l.variant_id }, { $inc: { "doc.variants.$.stock": l.base_qty } }).catch(() => {});
  sync.push().catch(() => {});
  ok(res, { refund: refund.toObject(), sale: s.toObject() }, `${refundNo} · ${L2("សង", "refund")} $${total.toFixed(2)}`);
}));

router.get("/refund", auth, wrap(async (req, res) => {
  const filter = {};
  if (req.query.shift_id) filter.shift_id = String(req.query.shift_id);
  if (req.query.sale) filter.sale_uuid = String(req.query.sale);
  ok(res, await Refund.find(filter).sort({ refunded_at: -1 }).limit(Math.min(Number(req.query.limit) || 50, 200)).lean());
}));

// ===================================== REPORT (sales of one day) ================================================
// A cashier sees only their own sales; a shop manager sees everyone, or one person (?user_id=).
const PP_MS = 7 * 3600 * 1000; // Asia/Phnom_Penh
const DAY_MS = 86400000;
const ymdPP = (d) => new Date(new Date(d).getTime() + PP_MS).toISOString().slice(0, 10);

router.get("/report", auth, wrap(async (req, res) => {
  const q = String(req.query.date || "");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : ymdPP(Date.now());
  const from = new Date(Date.parse(`${date}T00:00:00+07:00`));
  if (Number.isNaN(from.getTime())) return bad(res, "កាលបរិច្ឆេទខុស / Wrong date");
  const to = new Date(from.getTime() + DAY_MS);
  const userId = req.pos.is_manager ? String(req.query.user_id || "") : String(req.pos.user_id);
  const who = userId ? { cashier_id: userId } : {};
  const [sales, week, refunds] = await Promise.all([
    Sale.find({ ...who, state: "paid", sold_at: { $gte: from, $lt: to } }).sort({ sold_at: 1 }).lean(),
    Sale.find({ ...who, state: "paid", sold_at: { $gte: new Date(from.getTime() - 6 * DAY_MS), $lt: to } }).select("sold_at total").lean(),
    Refund.find({ ...(userId ? { cashier_id: userId } : {}), refunded_at: { $gte: from, $lt: to } }).lean(),
  ]);
  const refundTotal = r2(refunds.reduce((t, r) => t + r.total, 0));

  const methods = {};
  const items = {};
  const hours = {};
  const shifts = {};
  const cashiers = {};
  for (const s of sales) {
    // payments (net of the change given back, so the methods add up to the sales)
    let change = s.change_usd || 0;
    for (const p of s.payments || []) {
      const k = p.code || p.method_id;
      if (!methods[k]) methods[k] = { code: k, name_kh: p.name_kh, name_en: p.name_en, type: p.type, currency: p.currency, count: 0, amount_usd: 0 };
      let usd = p.amount_usd || 0;
      if (p.type === "cash" && change > 0) {
        const take = Math.min(change, usd);
        usd -= take;
        change -= take;
      }
      methods[k].count += 1;
      methods[k].amount_usd += usd;
    }
    for (const i of s.items || []) {
      const k = `${i.variant_id}:${i.unit_id}`;
      if (!items[k]) items[k] = { sku: i.sku, name_kh: i.name_kh, name_en: i.name_en, unit_name_kh: i.unit_name_kh, unit_name_en: i.unit_name_en, qty: 0, total: 0 };
      items[k].qty += i.qty;
      items[k].total += i.line_total ?? i.qty * i.price;
    }
    const h = new Date(new Date(s.sold_at).getTime() + PP_MS).getUTCHours();
    if (!hours[h]) hours[h] = { hour: h, count: 0, total: 0 };
    hours[h].count += 1;
    hours[h].total += s.total;
    if (!shifts[s.shift_id]) shifts[s.shift_id] = { _id: s.shift_id, shift_no: s.shift_no, count: 0, total: 0 };
    shifts[s.shift_id].count += 1;
    shifts[s.shift_id].total += s.total;
    if (!cashiers[s.cashier_id]) cashiers[s.cashier_id] = { _id: s.cashier_id, name: s.cashier_name, count: 0, total: 0 };
    cashiers[s.cashier_id].count += 1;
    cashiers[s.cashier_id].total += s.total;
  }
  const shiftRows = await Shift.find({ _id: { $in: Object.keys(shifts).filter((x) => /^[0-9a-f]{24}$/.test(x)) } }).select("opened_at closed_at state opened_by_name closed_by_name").lean();
  const shiftInfo = new Map(shiftRows.map((x) => [String(x._id), x]));
  const days = Array.from({ length: 7 }, (_, k) => ({ date: ymdPP(from.getTime() - (6 - k) * DAY_MS), count: 0, total: 0 }));
  for (const s of week) {
    const d = days.find((x) => x.date === ymdPP(s.sold_at));
    if (d) {
      d.count += 1;
      d.total += s.total;
    }
  }
  const sum = (f) => r2(sales.reduce((t, s) => t + (f(s) || 0), 0));
  const salesTotal = sum((s) => s.total);
  const fix = (o) => ({ ...o, total: r2(o.total) });
  ok(res, {
    date,
    scope: req.pos.is_manager ? (userId ? "user" : "all") : "own",
    user_id: userId || null,
    invoice_count: sales.length,
    sales_total: salesTotal,
    sales_total_khr: Math.round(sales.reduce((t, s) => t + (s.total_khr || 0), 0)),
    subtotal: sum((s) => s.subtotal),
    discount_total: sum((s) => s.discount_total),
    discount_count: sales.filter((s) => s.discount_total > 0).length,
    tax_total: sum((s) => s.tax_amount),
    items_qty: r2(sales.reduce((t, s) => t + (s.items || []).reduce((a, i) => a + i.qty, 0), 0)),
    average: sales.length ? r2(salesTotal / sales.length) : 0,
    refund_count: refunds.length, // money given back this day (refund / void)
    refund_total: refundTotal,
    net_total: r2(salesTotal - refundTotal),
    first_at: sales[0]?.sold_at || null,
    last_at: sales[sales.length - 1]?.sold_at || null,
    methods: Object.values(methods).map((m) => ({ ...m, amount_usd: r2(m.amount_usd) })).sort((a, b) => b.amount_usd - a.amount_usd),
    hours: Object.values(hours).map(fix).sort((a, b) => a.hour - b.hour),
    top_items: Object.values(items).map((i) => ({ ...fix(i), qty: r2(i.qty) })).sort((a, b) => b.total - a.total).slice(0, 10),
    shifts: Object.values(shifts).map((x) => ({ ...fix(x), ...(shiftInfo.get(String(x._id)) || {}), _id: x._id })),
    cashiers: req.pos.is_manager && !userId ? Object.values(cashiers).map(fix).sort((a, b) => b.total - a.total) : [],
    days: days.map(fix),
  });
}));

// ===================================== CUSTOMER DISPLAY (second screen) ================================================
// The sell screen sends what the customer should see (cart / pay / thank you); the display page
// (/display on the POS screen app) listens with Server-Sent Events. Kept in memory only.
let display = { mode: "idle", at: Date.now(), data: {} };
const watchers = new Set();
const DISPLAY_MODES = ["idle", "cart", "pay", "done"];

router.put("/display", auth, wrap(async (req, res) => {
  const b = req.body || {};
  display = { mode: DISPLAY_MODES.includes(b.mode) ? b.mode : "idle", at: Date.now(), data: b.data && typeof b.data === "object" ? b.data : {} };
  const msg = `data: ${JSON.stringify(display)}\n\n`;
  watchers.forEach((w) => w.write(msg));
  ok(res, { screens: watchers.size });
}));

// shop name / logo + what is on the display now (no login: it only shows the cart that is on the counter)
router.get("/display", wrap(async (req, res) => {
  const d = await Data.findById("main").select("setting warehouse").lean();
  const st = d?.setting || {};
  const wh = d?.warehouse || {};
  ok(res, {
    ...display,
    screens: watchers.size,
    shop: { name_kh: wh.name_kh, name_en: wh.name_en, company_kh: st.company_name_kh, company_en: st.company_name_en, logo: st.logo || "", phone: wh.phone || st.phone || "", ui_theme: st.ui_theme || "forest" },
  });
}));

router.get("/display/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 2000\n\n");
  res.write(`data: ${JSON.stringify(display)}\n\n`);
  watchers.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    watchers.delete(res);
  });
});

module.exports = router;
module.exports.roundKhr = roundKhr;

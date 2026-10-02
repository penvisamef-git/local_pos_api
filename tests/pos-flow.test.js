// End-to-end test: cloud API (inventory_pos_api, test DB) + this local POS server (local MongoDB).
//   pair with a code → pull → PIN login → open shift → sell (USD / KHR, change, discount with manager PIN)
//   → push → the cloud has the sale and the shop stock went down → close shift (expected cash).
// Run:  MONGO_DB_LOCAL=mongodb://127.0.0.1:27017/pos_test node tests/pos-flow.test.js
//   (needs ../inventory_pos_api with its .env pointing to a TEST database, and a local MongoDB)
const path = require("path");
const LOCAL = path.resolve(__dirname, "..");
const CLOUD = process.env.CLOUD_DIR || path.resolve(LOCAL, "../inventory_pos_api");
process.env.TELEGRAM_WORKER = "off";
process.env.SYNC_WORKER = "off";
const LOCAL_DB = process.env.MONGO_DB_LOCAL_TEST || process.env.MONGO_DB_LOCAL || "mongodb://127.0.0.1:27017/pos_test";
if (!/test/i.test(LOCAL_DB)) throw new Error("Use a local test database (name with 'test'), e.g. mongodb://127.0.0.1:27017/pos_test");

// ---- cloud (its own mongoose / .env) ----
const cwd = process.cwd();
process.chdir(CLOUD);
require(CLOUD + "/node_modules/dotenv").config({ path: CLOUD + "/.env" });
require(CLOUD + "/scripts/lib/test_db_guard").assertTestDb("POS flow test");
const cloudMongoose = require(CLOUD + "/node_modules/mongoose");
const cloudApp = require(CLOUD + "/index.js");
const CM = (p) => require(CLOUD + "/src/v1/admin/" + p);
const cloudBcrypt = require(CLOUD + "/node_modules/bcrypt");
process.chdir(cwd);

// ---- local ----
const mongoose = require(LOCAL + "/node_modules/mongoose");
const { app: localApp } = require(LOCAL + "/index.js");
const { Sale: LSale, Product: LProduct } = require(LOCAL + "/src/models");

const results = [];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const check = (n, c, i = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + i}`); };
const KEY = process.env.API_AUTH_KEY;

(async () => {
  while (cloudMongoose.connection.readyState !== 1) await new Promise((r) => setTimeout(r, 300));
  await mongoose.connect(LOCAL_DB);
  await mongoose.connection.db.dropDatabase();
  const cs = cloudApp.listen(0); const cloudBase = `http://127.0.0.1:${cs.address().port}`;
  process.env.CLOUD_API_URL = cloudBase;
  process.env.CLOUD_API_KEY = KEY;
  const ls = localApp.listen(0); const lbase = `http://127.0.0.1:${ls.address().port}/api/pos`;

  const User = CM("user/user.model"), Session = CM("session/session.model"), ActivityLog = CM("activity_log/activity_log.model");
  const Unit = CM("product/unit/unit.model"), Category = CM("product/category/category.model");
  const Product = CM("product/item/product.model"), Variant = CM("product/item/variant.model"), Price = CM("product/price/price.model");
  const Warehouse = CM("setup/warehouse/warehouse.model"), Movement = CM("stock/movement.model"), Opening = CM("stock/opening/opening.model");
  const { StockBalanceModel: Bal } = CM("stock/balance.model"); const Counter = CM("counter/counter.model");
  const { PosDeviceModel: Device, SaleModel: Sale } = CM("pos/pos.model");
  const PayMethod = CM("setup/payment_method/payment_method.model");
  const { ROLES } = require(CLOUD + "/src/util/user_roles");
  const counters = await Counter.find({}).lean();

  const ccall = async (m, p, t, b) => { const r = await fetch(cloudBase + "/api/admin" + p, { method: m, headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const lcall = async (m, p, t, b) => { const r = await fetch(lbase + p, { method: m, headers: { "Content-Type": "application/json", ...(t ? { "x-pos-token": t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const ids = []; const PASS = "TestPass#2026";
  const mk = async (email, extra) => { const id = new cloudMongoose.Types.ObjectId(); ids.push(id); await User.create({ _id: id, firstname: email.split("@")[0].split(".")[2], lastname: "T", email, password: await cloudBcrypt.hash(PASS, 10), is_first_login: false, status: true, created_by: id, updated_by: id, ...extra }); return { id, t: (await ccall("POST", "/auth/login", null, { email, password: PASS })).json.data?.access_token }; };

  try {
    // ---------- cloud data ----------
    const admin = await mk("zz.f.admin@local.test", { is_super_admin: true });
    let r = await ccall("POST", "/setup/warehouse", admin.t, { code: "ZZF1", name_kh: "ហាងតេស្ត POS", type: "shop" }); const S1 = r.json.data._id;
    const cashier = await mk("zz.f.cashier@local.test", { role: ROLES.CASHIER.value, warehouse_ids: [S1], pos_pin: await cloudBcrypt.hash("1111", 10) });
    const manager = await mk("zz.f.manager@local.test", { role: ROLES.SHOP_MANAGER.value, warehouse_ids: [S1], pos_pin: await cloudBcrypt.hash("2222", 10) });
    const pcs = (await Unit.findOne({ code: "pcs" }))._id;
    r = await ccall("POST", "/product/item", admin.t, { code: "ZZ-FTEE", name_kh: "អាវ​តេស្ត", name_en: "Test tee", category_id: (await Category.findOne({ code: "clothing_tops" }))._id, base_unit_id: pcs, variants: [{ barcode: "ZZ77001" }] });
    const TEE = String(r.json.data.variants[0]._id);
    await ccall("POST", "/product/price", admin.t, { variant_id: TEE, price: 4.6 });
    r = await ccall("POST", "/stock/opening", admin.t, { warehouse_id: S1, items: [{ variant_id: TEE, qty: 20, unit_cost: 2 }] });
    await ccall("PUT", "/stock/opening/post/" + r.json.data._id, admin.t);
    r = await ccall("POST", "/pos/device", admin.t, { warehouse_id: S1, name: "Counter 1" });
    const code = r.json.data.pair_code;
    const cashUsd = await PayMethod.findOne({ deleted: false, type: "cash", currency: "USD" }).lean();
    const cashKhr = await PayMethod.findOne({ deleted: false, type: "cash", currency: "KHR" }).lean();
    const qr = await PayMethod.findOne({ deleted: false, type: { $ne: "cash" } }).lean();

    // ---------- pair + pull ----------
    r = await lcall("GET", "/status");
    check("fresh POS → not paired", r.status === 200 && r.json.data.paired === false);
    r = await lcall("POST", "/pair", null, { code: "12" });
    check("pair: code must have 6 digits", r.status === 400);
    r = await lcall("POST", "/pair", null, { code });
    check("pair with the admin's code → paired + data pulled", r.status === 200 && r.json.data.device.code === "ZZF1-P1", JSON.stringify(r.json).slice(0, 200));
    r = await lcall("GET", "/status");
    check("status: paired, has data, online", r.json.data.paired && r.json.data.has_data && r.json.data.online === true && r.json.data.warehouse.code === "ZZF1");

    // ---------- login ----------
    r = await lcall("GET", "/users");
    const uC = r.json.data.find((u) => String(u._id) === String(cashier.id)); const uM = r.json.data.find((u) => String(u._id) === String(manager.id));
    check("users with a PIN of this shop listed (no PIN hash)", uC && uM && uM.is_manager && !JSON.stringify(r.json).includes("pin_hash"));
    r = await lcall("POST", "/login", null, { user_id: uC._id, pin: "9999" });
    check("wrong PIN → 401", r.status === 401);
    r = await lcall("POST", "/login", null, { user_id: uC._id, pin: "1111" });
    const T = r.json.data?.token;
    check("cashier logs in with PIN", r.status === 200 && T);
    r = await lcall("GET", "/catalog", T);
    const tee = r.json.data?.products?.find((p) => p.code === "ZZ-FTEE");
    check("catalog: product, price 4.6, stock 20, payment methods, rate", tee && tee.variants[0].prices[String(pcs)] === 4.6 && tee.variants[0].stock === 20 && r.json.data.payment_methods.length && r.json.data.rate?.rate > 0);
    const rate = r.json.data.rate.rate; const step = r.json.data.setting.khr_rounding || 100;

    // ---------- shift + sales ----------
    const line = (q) => ({ variant_id: TEE, unit_id: String(pcs), qty: q });
    r = await lcall("POST", "/sale", T, { items: [line(1)], payments: [{ method_id: cashUsd._id, amount: 5 }] });
    check("no shift → can't sell (409)", r.status === 409);
    r = await lcall("POST", "/shift/open", T, { opening_usd: 20, opening_khr: 40000 });
    check("open shift with float", r.status === 200 && r.json.data.state === "open" && /^ZZF1-P1-S\d{6}-\d+$/.test(r.json.data.shift_no), JSON.stringify(r.json).slice(0, 150));

    r = await lcall("POST", "/sale", T, { items: [line(2)], payments: [{ method_id: cashUsd._id, amount: 9 }] });
    check("not enough paid (9 < 9.20) → 400", r.status === 400);
    r = await lcall("POST", "/sale", T, { items: [line(2)], payments: [{ method_id: cashUsd._id, amount: 10 }] });
    const s1 = r.json.data;
    check("sale 2 × 4.60 = 9.20, paid $10 → change $0.80 given in riel", r.status === 200 && s1.total === 9.2 && s1.change_usd === 0.8 && s1.change_give_usd === 0 && s1.change_give_khr === Math.round((0.8 * rate) / step) * step && /^ZZF1-P1-\d{4}-00001$/.test(s1.invoice_no), JSON.stringify(r.json).slice(0, 300));
    check("KHR total rounded to the riel step", s1.total_khr === Math.round((9.2 * rate) / step) * step);

    r = await lcall("POST", "/sale", T, { items: [line(1)], discount: { type: "percent", value: 10 }, payments: [{ method_id: cashUsd._id, amount: 5 }] });
    check("cashier discount without manager PIN → refused", r.status === 403, r.status);
    r = await lcall("POST", "/sale", T, { items: [line(1)], discount: { type: "percent", value: 10 }, approver: { user_id: uM._id, pin: "2222" }, payments: [{ method_id: cashKhr._id, amount: Math.round((4.14 * rate) / step) * step }] });
    const s2 = r.json.data;
    check("10% discount approved by manager PIN, paid in KHR", r.status === 200 && s2.discount_total === 0.46 && s2.total === 4.14 && String(s2.discount_by) === String(manager.id) && s2.change_usd < 0.05, JSON.stringify(r.json).slice(0, 300));
    if (qr) {
      r = await lcall("POST", "/sale", T, { items: [line(1)], payments: [{ method_id: qr._id, amount: 10, reference: "X1" }] });
      check("QR / card can't be more than the total", r.status === 400);
    }
    const lp = await LProduct.findById(String(tee._id)).lean();
    check("local stock goes down at once (20 → 17)", lp.doc.variants[0].stock === 17, lp.doc.variants[0].stock);

    // ---------- hold a cart ----------
    r = await lcall("POST", "/hold", T, { label: "Red shirt lady", items: [line(3)], discount: { type: "percent", value: 5 }, total: 13.11 });
    const H1 = r.json.data;
    check("hold a cart → #n, label, items, discount kept", r.status === 200 && H1.hold_no >= 1 && H1.label === "Red shirt lady" && H1.items[0].qty === 3 && H1.discount.value === 5, JSON.stringify(r.json));
    r = await lcall("POST", "/hold", T, { items: [] });
    check("empty cart can't be held", r.status === 400);
    r = await lcall("GET", "/status");
    check("status counts held carts", r.json.data.held_carts === 1);
    r = await lcall("GET", "/hold", T);
    check("list held carts", r.json.data.length === 1 && r.json.data[0]._id === H1._id);
    r = await lcall("DELETE", "/hold/" + H1._id, T);
    check("resume = take it back (gone from the list)", r.status === 200 && r.json.data.items.length === 1 && (await lcall("GET", "/hold", T)).json.data.length === 0);

    r = await lcall("GET", "/status");
    check("admin theme comes with the shop data", ["forest", "ocean", "candy", "navy"].includes(r.json.data.ui_theme), r.json.data.ui_theme);

    // ---------- daily report ----------
    r = await lcall("GET", "/report", T);
    const R = r.json.data || {};
    check("cashier report today: own scope, 2 invoices, methods add up to sales, top items, 7 days", r.status === 200 && R.scope === "own" && R.invoice_count === 2 && Math.abs((R.methods || []).reduce((t, m) => t + m.amount_usd, 0) - R.sales_total) < 0.02 && R.top_items.length >= 1 && R.days.length === 7 && R.days[6].count === 2 && R.hours.length >= 1 && R.shifts.length === 1, JSON.stringify(R).slice(0, 500));
    r = await lcall("GET", "/report?user_id=" + uM._id, T);
    check("a cashier can't open someone else's report", r.json.data.scope === "own" && r.json.data.invoice_count === 2);
    r = await lcall("POST", "/login", null, { user_id: uM._id, pin: "2222" });
    const MT = r.json.data?.token;
    r = await lcall("GET", "/report", MT);
    check("shop manager sees all staff + by cashier", r.json.data?.scope === "all" && r.json.data.invoice_count === 2 && r.json.data.cashiers.length === 1, JSON.stringify(r.json).slice(0, 300));
    r = await lcall("GET", "/report?user_id=" + uM._id, MT);
    check("manager picks one person", r.json.data.scope === "user" && r.json.data.invoice_count === 0);
    r = await lcall("GET", "/report?date=2020-01-01", T);
    check("another day → empty", r.json.data.invoice_count === 0 && r.json.data.date === "2020-01-01");

    // ---------- customer display ----------
    const ctl = new AbortController();
    const sr = await fetch(lbase + "/display/stream", { signal: ctl.signal });
    const rd = sr.body.getReader();
    const dec = new TextDecoder();
    let got = dec.decode((await rd.read()).value);
    r = await lcall("PUT", "/display", T, { mode: "cart", data: { total: 5.5 } });
    const until = Date.now() + 3000;
    while (!got.includes('"cart"') && Date.now() < until) got += dec.decode((await rd.read()).value);
    check("customer display: the stream gets the cart at once", sr.headers.get("content-type").includes("text/event-stream") && r.json.data?.screens === 1 && got.includes('"total":5.5'), got.slice(0, 200));
    ctl.abort();
    r = await lcall("PUT", "/display", null, { mode: "cart" });
    check("only a logged-in POS can change the display", r.status === 401);
    r = await lcall("GET", "/display");
    check("display page data: shop name + what is on screen", r.json.data.mode === "cart" && !!r.json.data.shop.name_kh);

    // ---------- push ----------
    r = await lcall("POST", "/sync", T);
    check("sync → every sale is in the cloud", r.status === 200 && r.json.data.pushed.failed === 0, JSON.stringify(r.json) + JSON.stringify(await LSale.find({}).select("invoice_no synced sync_error").lean()));
    check("local sales marked synced", (await LSale.countDocuments({ synced: false })) === 0);
    const cloudSales = await Sale.find({ warehouse_id: S1 }).lean();
    check("cloud has both sales with cost", cloudSales.length === 2 && cloudSales.every((s) => s.cost_total > 0));
    const { PosShiftModel: CShift } = CM("pos/pos.model");
    check("open shift sent to the cloud", (await CShift.findOne({ warehouse_id: S1 }))?.state === "open");
    check("cloud shop stock 20 → 17", (await Bal.findOne({ warehouse_id: S1, variant_id: TEE })).qty === 17);
    check("after pull the POS shows the cloud stock (17)", (await LProduct.findById(String(tee._id)).lean()).doc.variants[0].stock === 17);

    // ---------- close shift ----------
    r = await lcall("GET", "/shift/current", T);
    const exp = r.json.data.totals;
    check("shift totals: 2 invoices, expected USD = 20 + 10 (change given in riel)", exp.invoice_count === 2 && exp.expected_usd === 30 && exp.expected_khr === 40000 + s2.payments[0].amount - s1.change_give_khr - s2.change_give_khr, JSON.stringify(exp));
    r = await lcall("POST", "/shift/close", T, { counted_usd: 30, counted_khr: exp.expected_khr - 1000 });
    check("close shift → report with difference (−1,000 ៛)", r.status === 200 && r.json.data.state === "closed" && r.json.data.report.diff_khr === -1000 && r.json.data.report.diff_usd === 0, JSON.stringify(r.json.data?.report));
    await lcall("POST", "/sync", T);
    const cs = await CShift.findOne({ warehouse_id: S1 }).lean();
    check("closed shift in the cloud with the counted cash", cs?.state === "closed" && cs.report.diff_khr === -1000 && cs.counted_usd === 30, JSON.stringify(cs).slice(0, 200));
    r = await lcall("GET", "/receipt/" + s1.invoice_no, T);
    check("receipt data for reprint", r.status === 200 && r.json.data.sale.invoice_no === s1.invoice_no && r.json.data.warehouse.code === "ZZF1");

    // ---------- out of stock: a cashier needs a shop manager's PIN ----------
    r = await lcall("POST", "/shift/open", T, { opening_usd: 0, opening_khr: 0 });
    const left = (await LProduct.findById(String(tee._id)).lean()).doc.variants[0].stock;
    const tooMany = { items: [line(left + 1)], payments: [{ method_id: cashUsd._id, amount: 200 }] };
    r = await lcall("POST", "/sale", T, tooMany);
    check(`more than the stock (${left}) without approval → refused, items listed`, r.status === 403 && r.json.code === "STOCK_APPROVAL" && r.json.items[0].stock === left, JSON.stringify(r.json).slice(0, 200));
    r = await lcall("POST", "/approve", T, { user_id: uC._id, pin: "1111" });
    check("a cashier's own PIN can't approve", r.status === 403);
    r = await lcall("POST", "/approve", T, { user_id: uM._id, pin: "9999" });
    check("wrong manager PIN → refused (403, the cashier stays logged in)", r.status === 403 && (await lcall("GET", "/me", T)).status === 200);
    r = await lcall("POST", "/approve", T, { user_id: uM._id, pin: "2222" });
    check("manager PIN checked (approve)", r.status === 200 && String(r.json.data.user_id) === String(uM._id));
    r = await lcall("POST", "/sale", T, { ...tooMany, stock_approver: { user_id: uM._id, pin: "2222" } });
    check("with the manager's PIN → sold, who allowed it is saved, stock goes below 0", r.status === 200 && String(r.json.data.stock_override_by) === String(uM._id) && r.json.data.stock_override_items.length === 1 && (await LProduct.findById(String(tee._id)).lean()).doc.variants[0].stock === -1, JSON.stringify(r.json).slice(0, 200));
    r = await lcall("POST", "/sale", MT, { items: [line(1)], payments: [{ method_id: cashUsd._id, amount: 5 }] });
    check("a shop manager sells it directly", r.status === 200 && String(r.json.data.stock_override_by) === String(uM._id));
    r = await lcall("POST", "/sale", T, { items: [line(1)], payments: [{ method_id: cashUsd._id, amount: 5 }] });
    check("stock already below 0 → still asks", r.status === 403 && r.json.code === "STOCK_APPROVAL");

    // ---------- invoice the cloud refuses: see why, try again, remove (manager) ----------
    r = await lcall("POST", "/sale", MT, { items: [line(1)], payments: [{ method_id: cashUsd._id, amount: 5 }] });
    const bad1 = r.json.data;
    await LSale.updateOne({ uuid: bad1.uuid }, { invoice_no: "BAD-2610-00001", synced: false }); // e.g. made on another POS
    await lcall("POST", "/sync", T);
    r = await lcall("GET", "/sale?problem=true", T);
    check("refused invoice listed with the reason (any shift)", r.json.data.length === 1 && /BAD-2610/.test(r.json.data[0].invoice_no) && r.json.data[0].sync_error.length > 0 && (await lcall("GET", "/status")).json.data.failed_sales === 1, JSON.stringify(r.json.data[0]?.sync_error));
    r = await lcall("POST", `/sale/${bad1.uuid}/retry`, T);
    check("try again → still refused, says why", r.status === 409 && r.json.message.length > 0, r.status);
    r = await lcall("POST", `/sale/${bad1.uuid}/discard`, T, { reason: "test sale" });
    check("cashier can't remove it without a manager PIN", r.status === 403, r.status);
    r = await lcall("POST", `/sale/${bad1.uuid}/discard`, T, { approver: { user_id: uM._id, pin: "2222" } });
    check("a reason is needed", r.status === 400, r.status);
    r = await lcall("POST", `/sale/${bad1.uuid}/discard`, T, { reason: "made on another POS", approver: { user_id: uM._id, pin: "2222" } });
    const stx = (await lcall("GET", "/status")).json.data;
    check("removed with the manager PIN → not pending, no problem left, who + why kept", r.status === 200 && r.json.data.state === "discarded" && r.json.data.discarded_by_name && stx.failed_sales === 0 && stx.pending_sales === 0 && (await lcall("GET", "/sale?problem=true", T)).json.data.length === 0, JSON.stringify(stx).slice(0, 200));
    r = await lcall("POST", `/sale/${s1.uuid}/discard`, MT, { reason: "x" });
    check("an invoice already in the cloud can't be removed here", r.status === 409, r.status);

    // ---------- refund / void ----------
    r = await lcall("POST", "/sale", MT, { items: [line(2)], payments: [{ method_id: cashUsd._id, amount: 20 }] });
    const rs = r.json.data;
    const stockBefore = (await LProduct.findById(String(tee._id)).lean()).doc.variants[0].stock;
    r = await lcall("POST", `/sale/${rs.uuid}/refund`, T, { lines: [{ index: 0, qty: 1 }], reason: "wrong size" });
    check("cashier refund without a manager PIN → refused", r.status === 403, r.status);
    r = await lcall("POST", `/sale/${rs.uuid}/refund`, T, { lines: [{ index: 0, qty: 3 }], reason: "x", approver: { user_id: uM._id, pin: "2222" } });
    check("refund more than sold → refused", r.status === 400, r.status);
    r = await lcall("POST", `/sale/${rs.uuid}/refund`, T, { lines: [{ index: 0, qty: 1 }], reason: "wrong size", approver: { user_id: uM._id, pin: "2222" } });
    const R1 = r.json.data?.refund;
    check("refund 1 of 2 with the manager PIN → half back, partial, stock +1", r.status === 200 && R1.total === rs.total / 2 && R1.kind === "refund" && R1.approved_by_name && r.json.data.sale.refund_status === "partial" && (await LProduct.findById(String(tee._id)).lean()).doc.variants[0].stock === stockBefore + 1, JSON.stringify(r.json).slice(0, 300));
    let sh = (await lcall("GET", "/shift/current", T)).json.data.totals;
    check("shift: refund counted, expected cash goes down", sh.refund_total === R1.total && sh.net_total === r2(sh.sales_total - R1.total), JSON.stringify(sh).slice(0, 200));
    r = await lcall("POST", `/sale/${rs.uuid}/refund`, MT, { all: true, reason: "customer changed mind" });
    check("manager refunds the rest → full", r.status === 200 && r.json.data.sale.refund_status === "full" && Math.abs(r.json.data.sale.refunded_total - rs.total) < 0.001);
    r = await lcall("POST", `/sale/${rs.uuid}/refund`, MT, { all: true, reason: "again" });
    check("nothing left to refund", r.status === 400, r.status);
    r = await lcall("GET", "/report", MT);
    check("day report: refunds and net", r.json.data.refund_count === 2 && Math.abs(r.json.data.refund_total - rs.total) < 0.001 && r.json.data.net_total === r2(r.json.data.sales_total - r.json.data.refund_total));
    await lcall("POST", "/sync", T);
    const { RefundModel: CRefund } = CM("pos/pos.model");
    const cr = await CRefund.find({ invoice_no: rs.invoice_no }).lean();
    const cs2 = await Sale.findOne({ invoice_no: rs.invoice_no }).lean();
    const backIn = await Movement.find({ ref_type: "refund", ref_id: { $in: cr.map((x) => x._id) } }).lean();
    check("cloud: 2 refunds, invoice fully refunded, 2 back into stock (refund_in)", cr.length === 2 && cs2.refund_status === "full" && cs2.refund_count === 2 && backIn.reduce((t, m) => t + m.qty, 0) === 2 && backIn.every((m) => m.type === "refund_in"), JSON.stringify({ n: cr.length, st: cs2?.refund_status, back: backIn.length }));
    check("all refunds sent", (await lcall("GET", "/status")).json.data.pending_sales === 0);
    check("logins sent to the cloud (attendance)", (await CM("pos/pos.model").PosAttendanceModel.countDocuments({ warehouse_id: S1, action: "login" })) >= 2);

    // ---------- device turned off in the admin ----------
    const dev = await Device.findOne({ warehouse_id: S1 });
    await ccall("PUT", "/pos/device/" + dev._id, admin.t, { status: false });
    r = await lcall("POST", "/sync", T);
    check("POS turned off in the admin → sync refused, POS shows the reason", r.status === 403 && (await lcall("GET", "/status")).json.data.last_error, r.status + JSON.stringify(r.json));
    let st = (await lcall("GET", "/status")).json.data;
    check("turned off → POS forgets the shop data, back to the pair screen, unsent sales kept", !st.paired && /turned off/.test(st.revoked_reason) && (await LProduct.countDocuments()) === 0 && (await lcall("GET", "/me", T)).status === 401 && (await LSale.countDocuments()) > 0, JSON.stringify(st).slice(0, 300));
    await ccall("PUT", "/pos/device/" + dev._id, admin.t, { status: true });
    r = await ccall("PUT", "/pos/device/pair-code/" + dev._id, admin.t);
    r = await lcall("POST", "/pair", null, { code: r.json.data.pair_code });
    st = (await lcall("GET", "/status")).json.data;
    check("pair again with the new code → shop data back, message gone", r.status === 200 && st.paired && !st.revoked_reason && (await LProduct.countDocuments()) > 0, JSON.stringify(r.json).slice(0, 200));
    await ccall("PUT", "/pos/device/pair-code/" + dev._id, admin.t);
    await require(LOCAL + "/src/sync").ping().catch(() => {});
    st = (await lcall("GET", "/status")).json.data;
    check("new pairing code in the admin → the next ping unlinks this POS", !st.paired && /new pairing code/.test(st.revoked_reason) && (await LProduct.countDocuments()) === 0, st.revoked_reason);
  } catch (e) { console.log("ERR", e); } finally {
    await require(LOCAL + "/src/sync").idle();
    const ws = await Warehouse.find({ code: /^ZZF/ }).select("_id"); const w = ws.map((x) => x._id);
    const ps = await Product.find({ code: /^ZZ-F/ }).select("_id"); const p = ps.map((x) => x._id);
    await Sale.deleteMany({ $or: [{ warehouse_id: { $in: w } }, { invoice_no: /^ZZF1-/ }] }); await CM("pos/pos.model").PosShiftModel.deleteMany({ warehouse_id: { $in: w } }); await CM("pos/pos.model").RefundModel.deleteMany({ warehouse_id: { $in: w } }); await CM("pos/pos.model").PosAttendanceModel.deleteMany({ warehouse_id: { $in: w } }); await Device.deleteMany({ warehouse_id: { $in: w } });
    await Price.deleteMany({ product_id: { $in: p } });
    await Movement.deleteMany({ warehouse_id: { $in: w } }); await Bal.deleteMany({ warehouse_id: { $in: w } }); await Opening.deleteMany({ warehouse_id: { $in: w } });
    await Variant.deleteMany({ product_id: { $in: p } }); await Product.deleteMany({ _id: { $in: p } }); await Warehouse.deleteMany({ _id: { $in: w } });
    await Session.deleteMany({ user_id: { $in: ids } }); await ActivityLog.deleteMany({ create_by_id: { $in: ids } }); await User.deleteMany({ _id: { $in: ids } });
    await Counter.deleteMany({ key: { $nin: counters.map((c) => c.key) } });
    for (const c of counters) await Counter.updateOne({ _id: c._id }, { seq: c.seq });
    await mongoose.connection.db.dropDatabase();
    const left = (await Warehouse.countDocuments({ code: /^ZZF/ })) + (await Product.countDocuments({ code: /^ZZ-F/ })) + (await User.countDocuments({ email: /^zz\.f\./ }));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed · cloud test rows left: ${left}`);
    cs.close(); ls.close(); await mongoose.connection.close(); await cloudMongoose.connection.close(); process.exit(0);
  }
})();

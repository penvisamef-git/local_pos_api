const { Customer, Config, Data, Product, User, Sale, Shift, Session, Hold, Refund, PosEvent } = require("./models");
const pkg = require("../package.json");

// ---------------------------------------------------------------------------------------------
// Talking to the cloud API (inventory_pos_api). The POS sells offline from its own database;
// this file brings the shop's data down (pull) and sends the sales up (push) whenever there is internet.
// ---------------------------------------------------------------------------------------------
const CLOUD_URL = () => (process.env.CLOUD_API_URL || "https://inventory-pos-api.vercel.app").replace(/\/$/, "");
const API_KEY = () => process.env.CLOUD_API_KEY || process.env.API_AUTH_KEY || "";
const PUSH_EVERY_MS = Number(process.env.SYNC_PUSH_SECONDS || 15) * 1000;
const PULL_EVERY_MS = Number(process.env.SYNC_PULL_MINUTES || 5) * 60 * 1000;
const TIMEOUT_MS = 20000;
const PING_EVERY_MS = Number(process.env.SYNC_PING_SECONDS || 20) * 1000; // notice quickly when the admin unlinks this POS

const state = { pulling: false, pushing: false, online: null };
// one pull and one push at a time: a call while one runs waits for it, then runs once more
const queue = { pull: Promise.resolve(), push: Promise.resolve() };
const serial = (name, fn) => {
  const next = queue[name].catch(() => {}).then(fn);
  queue[name] = next;
  return next;
};

async function getConfig() {
  return (await Config.findById("main").lean()) || null;
}

async function cloud(method, path, { body, key } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CLOUD_URL()}/api/admin${path}`, {
      method,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY(), "x-app-version": pkg.version, ...(key ? { "x-device-key": key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    state.online = true;
    Config.updateOne({ _id: "main" }, { last_online_at: new Date() }).catch(() => {});
    if (!res.ok || json.success === false) {
      const err = new Error(json.message || `Cloud error ${res.status}`);
      err.status = res.status;
      err.code = json.code;
      if (key && (res.status === 401 || res.status === 403)) {
        if (json.code === "DEVICE_UNPAIRED" || json.code === "DEVICE_OFF") await revoke(err.message);
        else Config.updateOne({ _id: "main" }, { last_error: err.message }).catch(() => {});
      }
      throw err;
    }
    return json.data;
  } catch (err) {
    if (err.name === "AbortError" || err.cause || err.message === "fetch failed") {
      state.online = false;
      // say why (ECONNREFUSED = nothing running at that address, ENOTFOUND = wrong host, timeout = too slow)
      const why = err.name === "AbortError" ? `timeout ${TIMEOUT_MS / 1000}s` : err.cause?.code || err.cause?.message || err.message;
      const e = new Error(`មិនអាចភ្ជាប់ Cloud / No connection to the cloud (${CLOUD_URL()} · ${why})`);
      e.offline = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// ---------------- the admin unlinked this POS (deleted / turned off / new pairing code) ----------------
// Forget the shop's data and the key → the screen goes back to "type the 6-digit code".
// Sales and shifts not sent yet are KEPT: after pairing again (same POS) they are sent.
async function revoke(reason) {
  const cfg = await getConfig();
  if (!cfg?.device_key) return;
  console.warn(`⛔ POS unlinked by the admin web: ${reason} — local shop data cleared`);
  await Config.updateOne({ _id: "main" }, { device_key: null, last_error: reason, revoked_at: new Date(), revoked_reason: reason });
  await Promise.all([Data.deleteMany({}), Product.deleteMany({}), User.deleteMany({}), Session.deleteMany({}), Hold.deleteMany({ deposit_usd: { $not: { $gt: 0 } } })]); // layaways (deposit paid) are kept
}

// is the key still good? (cheap call; unlinking is noticed within PING_EVERY_MS)
async function ping() {
  const cfg = await getConfig();
  if (!cfg?.device_key) return null;
  return cloud("GET", "/pos-device/ping", { key: cfg.device_key });
}

// ---------------- pair (once, with the 6-digit code from the admin web) ----------------
async function pair(code) {
  const data = await cloud("POST", "/pos-device/pair", { body: { code, app_version: pkg.version } });
  await Config.updateOne(
    { _id: "main" },
    { cloud_url: CLOUD_URL(), device_key: data.device_key, device: data.device, warehouse: data.warehouse, paired_at: new Date(), last_error: "", revoked_at: null, revoked_reason: "" },
    { upsert: true },
  );
  await pull();
  return data;
}

// ---------------- pull: replace the local copy of the shop's data ----------------
// QR pictures of the payment methods are kept inside the local data (data: URI), so the customer display
// still shows them when the internet is down. The previous copy is reused when the download fails.
async function keepQrOffline(methods, before) {
  const old = new Map((before || []).map((m) => [String(m._id), m]));
  for (const m of methods || []) {
    const url = m.qr_image;
    if (!url || !/^https?:\/\//.test(url)) continue;
    const prev = old.get(String(m._id));
    if (prev?.qr_source === url && String(prev.qr_image || "").startsWith("data:")) {
      m.qr_source = url;
      m.qr_image = prev.qr_image;
      continue;
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.ok && buf.length < 2 * 1024 * 1024) {
        m.qr_source = url;
        m.qr_image = `data:${res.headers.get("content-type") || "image/png"};base64,${buf.toString("base64")}`;
      }
    } catch {
      // keep the URL (shows when online)
    }
  }
}

const pull = () => serial("pull", doPull);
async function doPull() {
  const cfg = await getConfig();
  if (!cfg?.device_key) throw new Error("POS មិនទាន់ភ្ជាប់ / POS is not paired");
  state.pulling = true;
  try {
    const d = await cloud("GET", "/pos-device/pull", { key: cfg.device_key });
    // stock still waiting to be pushed is taken off the pulled shop qty, so the screen stays right
    const pending = await Sale.find({ synced: false, state: "paid" }).select("items").lean();
    const waiting = new Map();
    pending.forEach((s) => s.items.forEach((i) => waiting.set(String(i.variant_id), (waiting.get(String(i.variant_id)) || 0) + i.base_qty)));
    // refunds not sent yet: the stock is already back here
    const pendingRefunds = await Refund.find({ synced: false }).select("items").lean();
    pendingRefunds.forEach((r) => r.items.forEach((i) => waiting.set(String(i.variant_id), (waiting.get(String(i.variant_id)) || 0) - i.base_qty)));

    const products = d.products.map((p, i) => {
      p.variants.forEach((v) => {
        v.stock = Math.round(((v.stock || 0) - (waiting.get(String(v._id)) || 0)) * 10000) / 10000;
      });
      const barcodes = [];
      p.variants.forEach((v) => {
        if (v.barcode) barcodes.push(v.barcode);
        (v.unit_barcodes || []).forEach((b) => b.barcode && barcodes.push(b.barcode));
        barcodes.push(String(v.code).toUpperCase());
      });
      const text = [p.code, p.name_kh, p.name_en, ...p.variants.map((v) => `${v.code} ${v.name_kh} ${v.name_en}`)].join(" ").toLowerCase();
      return { _id: String(p._id), doc: p, text, barcodes, sort: i };
    });
    await Product.deleteMany({});
    if (products.length) await Product.insertMany(products, { ordered: false });
    await User.deleteMany({});
    if (d.users.length) await User.insertMany(d.users.map((u) => ({ ...u, _id: String(u._id) })), { ordered: false });
    // customers: the cloud list (upsert by cloud id, so local links stay) + the ones added here and not sent yet
    if (Array.isArray(d.customers)) {
      const ops = d.customers.map((c) => ({
        updateOne: {
          filter: { cloud_id: String(c._id) },
          update: { $set: { cloud_id: String(c._id), uuid: c.uuid || null, code: c.code, name: c.name, phone: c.phone, kid_name: c.kid_name || "", kid_birthday: c.kid_birthday || "", kid_gender: c.kid_gender || "", points: c.points || 0, text: [c.name, c.code, c.kid_name].join(" ").toLowerCase(), synced: true, sync_error: "" } },
          upsert: true,
        },
      }));
      for (let k = 0; k < ops.length; k += 1000) await Customer.bulkWrite(ops.slice(k, k + 1000), { ordered: false });
      await Customer.deleteMany({ synced: true, cloud_id: { $nin: d.customers.map((c) => String(c._id)) } });
    }
    const { products: _p, users: _u, customers: _c, ...rest } = d;
    const before = await Data.findById("main").select("payment_methods").lean();
    await keepQrOffline(rest.payment_methods, before?.payment_methods);
    await Data.replaceOne({ _id: "main" }, { _id: "main", ...rest, pulled_at: new Date() }, { upsert: true });
    await Config.updateOne({ _id: "main" }, { last_pull_at: new Date(), device: d.device, warehouse: d.warehouse, last_error: "" });
    return { products: products.length, users: d.users.length };
  } catch (err) {
    throw err;
  } finally {
    state.pulling = false;
  }
}

// ---------------- push: send sales that are not in the cloud yet ----------------
const forCloud = (s) => ({
  uuid: s.uuid,
  invoice_no: s.invoice_no,
  shift_no: s.shift_no,
  cashier_id: s.cashier_id,
  cashier_name: s.cashier_name,
  discount_by: s.discount_by,
  discount_by_name: s.discount_by_name,
  stock_override_by: s.stock_override_by,
  stock_override_by_name: s.stock_override_by_name,
  stock_override_items: s.stock_override_items,
  sold_at: s.sold_at,
  items: s.items,
  subtotal: s.subtotal,
  discount_total: s.discount_total,
  tax_mode: s.tax_mode,
  tax_rate: s.tax_rate,
  tax_amount: s.tax_amount,
  total: s.total,
  rate: s.rate,
  total_khr: s.total_khr,
  payments: s.payments,
  paid_usd: s.paid_usd,
  change_usd: s.change_usd,
  change_khr: s.change_khr,
  change_give_usd: s.change_give_usd,
  change_give_khr: s.change_give_khr,
  note: s.note,
  promo_total: s.promo_total || 0,
  promotions: s.promotions || [],
  customer_id: s.customer_id || null,
  customer_uuid: s.customer_uuid || null,
  points_earned: s.points_earned || 0,
  points_redeemed: s.points_redeemed || 0,
});
const shiftForCloud = (s) => ({
  shift_no: s.shift_no,
  state: s.state,
  opened_by: s.opened_by,
  opened_by_name: s.opened_by_name,
  opened_at: s.opened_at,
  opening_usd: s.opening_usd,
  opening_khr: s.opening_khr,
  closed_by: s.closed_by,
  closed_by_name: s.closed_by_name,
  closed_at: s.closed_at,
  counted_usd: s.counted_usd,
  counted_khr: s.counted_khr,
  report: s.report,
  note: s.note,
  cash_moves: s.cash_moves || [],
});

const push = () => serial("push", doPush);
async function doPush() {
  const cfg = await getConfig();
  if (!cfg?.device_key) return null;
  state.pushing = true;
  const out = { sent: 0, failed: 0 };
  // the cloud's new point balances → the local copies (after this, the pending part is gone)
  const applyPoints = async (r) => {
    for (const [id, pts] of Object.entries(r?.customer_points || {})) await Customer.updateOne({ cloud_id: id }, { points: pts });
  };
  try {
    // customers added on this POS — before the invoices that use them
    const newCustomers = await Customer.find({ synced: false }).limit(200).lean();
    if (newCustomers.length) {
      const r = await cloud("POST", "/pos-device/push", { key: cfg.device_key, body: { invoices: [], customers: newCustomers.map((c) => ({ uuid: c.uuid, name: c.name, phone: c.phone, kid_name: c.kid_name, kid_birthday: c.kid_birthday, kid_gender: c.kid_gender })) } });
      for (const x of r.customers?.saved || []) {
        const local = newCustomers.find((c) => c.uuid === x.uuid);
        if (!local) continue;
        await Customer.updateOne({ _id: local._id }, { synced: true, cloud_id: String(x._id), code: x.code || "", sync_error: "" });
        await Sale.updateMany({ customer_local: String(local._id), customer_id: null }, { customer_id: String(x._id) });
      }
      for (const f of r.customers?.failed || []) await Customer.updateOne({ uuid: f.uuid }, { sync_error: f.error });
      await applyPoints(r);
    }
    for (let round = 0; round < 20; round++) {
      const list = await Sale.find({ synced: false, state: "paid" }).sort({ sold_at: 1 }).limit(50).lean();
      if (!list.length) break;
      const r = await cloud("POST", "/pos-device/push", { key: cfg.device_key, body: { invoices: list.map(forCloud) } });
      const done = [...r.accepted, ...r.duplicate];
      if (done.length) await Sale.updateMany({ uuid: { $in: done } }, { synced: true, synced_at: new Date(), sync_error: "" });
      await applyPoints(r);
      for (const f of r.failed) await Sale.updateOne({ uuid: f.uuid }, { sync_error: f.error });
      out.sent += done.length;
      out.failed += r.failed.length;
      if (!done.length) break; // only failures left — try again next time
    }
    // refunds / voids — after the sales they belong to
    const refunds = await Refund.find({ synced: false }).sort({ refunded_at: 1 }).limit(50).lean();
    if (refunds.length) {
      const r = await cloud("POST", "/pos-device/push", { key: cfg.device_key, body: { invoices: [], refunds: refunds.map(({ _id, synced, synced_at, sync_error, created_date, updated_date, __v, ...x }) => x) } });
      const rr = r.refunds || { accepted: [], duplicate: [], failed: [] };
      const ok = [...rr.accepted, ...rr.duplicate];
      if (ok.length) await Refund.updateMany({ uuid: { $in: ok } }, { synced: true, synced_at: new Date(), sync_error: "" });
      await applyPoints(r);
      for (const f of rr.failed) await Refund.updateOne({ uuid: f.uuid }, { sync_error: f.error });
      out.refunds = ok.length;
    }
    // login / logout (attendance)
    const events = await PosEvent.find({ synced: false }).sort({ at: 1 }).limit(200).lean();
    if (events.length) {
      const r = await cloud("POST", "/pos-device/push", { key: cfg.device_key, body: { invoices: [], events: events.map(({ _id, synced, ...e }) => e) } });
      const saved = r.events?.saved || [];
      if (saved.length) await PosEvent.updateMany({ uuid: { $in: saved } }, { synced: true });
    }
    // cash drawer shifts (opened / closed) — after the sales
    const shifts = await Shift.find({ synced: false }).sort({ opened_at: 1 }).limit(50).lean();
    if (shifts.length) {
      const r = await cloud("POST", "/pos-device/push", { key: cfg.device_key, body: { invoices: [], shifts: shifts.map(shiftForCloud) } });
      const saved = r.shifts?.saved || [];
      // only mark what did not change while it was being sent
      for (const s of shifts) if (saved.includes(s.shift_no)) await Shift.updateOne({ _id: s._id, updated_date: s.updated_date }, { synced: true });
      out.shifts = saved.length;
    }
    await Config.updateOne({ _id: "main" }, { last_push_at: new Date(), last_error: "" });
    return out;
  } finally {
    state.pushing = false;
  }
}

// ---------------- background: push often, pull now and then ----------------
let timers = null;
function startWorker() {
  if (timers || process.env.SYNC_WORKER === "off") return;
  const quiet = (fn) => () => fn().catch(() => {});
  timers = [setInterval(quiet(push), PUSH_EVERY_MS), setInterval(quiet(pull), PULL_EVERY_MS), setInterval(quiet(ping), PING_EVERY_MS)];
  setTimeout(quiet(async () => {
    await push();
    await pull();
  }), 2000);
}
function stopWorker() {
  (timers || []).forEach(clearInterval);
  timers = null;
}

// wait until running pulls / pushes are done (tests, shutdown)
const idle = () => Promise.all([queue.pull.catch(() => {}), queue.push.catch(() => {})]);

module.exports = { idle, cloud, pair, pull, push, ping, revoke, startWorker, stopWorker, getConfig, state, CLOUD_URL };

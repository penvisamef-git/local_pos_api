const mongoose = require("mongoose");

// Local POS database (MongoDB on the POS computer). Everything the POS needs to sell offline lives here:
// a copy of the shop's data pulled from the cloud, plus the sales / shifts made on this computer.
const { Schema } = mongoose;
const opts = { timestamps: { createdAt: "created_date", updatedAt: "updated_date" } };

// ---------------- link to the cloud (one row: _id "main") ----------------
const Config = mongoose.model(
  "PosConfig",
  new Schema(
    {
      _id: { type: String, default: "main" },
      cloud_url: String,
      device_key: { type: String, default: null }, // <deviceId>.<secret> — never sent to the browser
      device: { type: Object, default: null }, // { _id, name, code }
      warehouse: { type: Object, default: null },
      paired_at: Date,
      last_pull_at: Date,
      last_push_at: Date,
      last_online_at: Date,
      last_error: { type: String, default: "" },
      revoked_at: { type: Date, default: null }, // the admin removed / turned off / re-coded this POS
      revoked_reason: { type: String, default: "" },
    },
    opts,
  ),
);

// ---------------- shop data from the last pull (one row: _id "main") ----------------
const Data = mongoose.model(
  "PosData",
  new Schema(
    {
      _id: { type: String, default: "main" },
      server_time: Date,
      warehouse: Object,
      device: Object,
      setting: Object,
      rate: Object,
      payment_methods: { type: Array, default: [] },
      categories: { type: Array, default: [] },
      brands: { type: Array, default: [] },
      pulled_at: Date,
    },
    opts,
  ),
);

// products as pulled (variants, sale units, prices, barcodes, shop stock) + search helpers
const Product = mongoose.model(
  "PosProduct",
  new Schema(
    {
      _id: String,
      doc: Object,
      text: { type: String, index: true }, // lowercase name / code / SKU text
      barcodes: { type: [String], index: true },
      sort: { type: Number, default: 0 },
    },
    { versionKey: false },
  ),
);

// staff who may log in on this POS (PIN hash from the cloud)
const User = mongoose.model(
  "PosUser",
  new Schema({ _id: String, firstname: String, lastname: String, email: String, role: String, is_manager: Boolean, pin_hash: String }, { versionKey: false }),
);

const Session = mongoose.model(
  "PosSession",
  new Schema({ token: { type: String, index: true, unique: true }, user_id: String, name: String, role: String, is_manager: Boolean, expires_at: Date }, opts),
);

// ---------------- cash drawer shift ----------------
const Shift = mongoose.model(
  "PosShift",
  new Schema(
    {
      shift_no: { type: String, required: true, unique: true },
      state: { type: String, enum: ["open", "closed"], default: "open" },
      opened_by: String,
      opened_by_name: String,
      opened_at: { type: Date, default: Date.now },
      opening_usd: { type: Number, default: 0 },
      opening_khr: { type: Number, default: 0 },
      closed_by: String,
      closed_by_name: String,
      closed_at: Date,
      counted_usd: Number,
      counted_khr: Number,
      report: Object, // totals at close
      note: { type: String, default: "" },
      synced: { type: Boolean, default: false, index: true }, // sent to the cloud (again after closing)
    },
    opts,
  ),
);

// ---------------- sale (invoice) made on this POS ----------------
const Sale = mongoose.model(
  "PosSale",
  new Schema(
    {
      uuid: { type: String, required: true, unique: true },
      invoice_no: { type: String, required: true, unique: true },
      shift_id: { type: String, index: true },
      shift_no: String,
      cashier_id: String,
      cashier_name: String,
      discount_by: { type: String, default: null },
      discount_by_name: { type: String, default: "" },
      stock_override_by: { type: String, default: null }, // manager who allowed selling with 0 or less stock
      stock_override_by_name: { type: String, default: "" },
      stock_override_items: { type: Array, default: [] }, // [{ variant_id, sku, stock, qty }]
      sold_at: { type: Date, default: Date.now, index: true },
      items: { type: Array, default: [] },
      subtotal: Number,
      discount_type: { type: String, default: null },
      discount_value: { type: Number, default: 0 },
      discount_total: { type: Number, default: 0 },
      tax_mode: String,
      tax_rate: Number,
      tax_name: String,
      tax_amount: { type: Number, default: 0 },
      total: Number,
      rate: Number,
      total_khr: Number,
      payments: { type: Array, default: [] },
      paid_usd: Number,
      change_usd: Number,
      change_khr: Number,
      change_give_usd: { type: Number, default: 0 },
      change_give_khr: { type: Number, default: 0 },
      note: { type: String, default: "" },
      state: { type: String, default: "paid" }, // paid | discarded (could not be sent, removed by a manager — never sent, not in totals)
      discarded_at: Date,
      discarded_by: String,
      discarded_by_name: String,
      discard_reason: { type: String, default: "" },
      refunded_total: { type: Number, default: 0 }, // USD given back (items[].refunded_qty per line)
      refund_status: { type: String, default: "" }, // "" | partial | full
      synced: { type: Boolean, default: false, index: true },
      synced_at: Date,
      sync_error: { type: String, default: "" },
    },
    opts,
  ),
);

// ---------------- held carts (customer still shopping → serve the next one, resume later) ----------------
const Hold = mongoose.model(
  "PosHold",
  new Schema(
    {
      hold_no: { type: Number, required: true }, // 1, 2, 3 … per day
      label: { type: String, default: "" }, // "Lady in red", phone no. …
      items: { type: Array, default: [] }, // [{ variant_id, unit_id, qty }]
      discount: { type: Object, default: null }, // { type, value } — approval is asked again on resume
      note: { type: String, default: "" },
      total: { type: Number, default: 0 }, // for the list (re-priced on resume)
      user_id: String,
      user_name: String,
    },
    opts,
  ),
);

// ---------------- refund / void (money back for some or all items of an invoice) ----------------
const Refund = mongoose.model(
  "PosRefund",
  new Schema(
    {
      uuid: { type: String, required: true, unique: true },
      refund_no: { type: String, required: true, unique: true }, // PP01-P1-R2610-00001
      kind: { type: String, default: "refund" }, // void (everything, first time) | refund (part / rest)
      sale_uuid: { type: String, index: true },
      invoice_no: String,
      shift_id: { type: String, index: true }, // the shift whose drawer pays the money back
      shift_no: String,
      cashier_id: String,
      cashier_name: String,
      approved_by: String,
      approved_by_name: String,
      refunded_at: { type: Date, default: Date.now, index: true },
      reason: { type: String, default: "" },
      items: { type: Array, default: [] }, // [{ index, variant_id, unit_id, sku, name_*, unit_*, factor, qty, base_qty, price, amount }]
      total: Number, // USD given back
      rate: Number,
      total_khr: Number,
      payments: { type: Array, default: [] }, // [{ method_id, code, name_*, type, currency, amount, amount_usd }]
      synced: { type: Boolean, default: false, index: true },
      synced_at: Date,
      sync_error: { type: String, default: "" },
    },
    opts,
  ),
);

// login / logout on this POS (attendance) → sent to the cloud with the next push (Telegram, attendance report)
const PosEvent = mongoose.model(
  "PosEvent",
  new Schema({ uuid: { type: String, unique: true }, action: String, user_id: String, name: String, at: { type: Date, default: Date.now }, synced: { type: Boolean, default: false, index: true } }, { versionKey: false }),
);

const Counter = mongoose.model("PosCounter", new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false }));

async function nextSeq(key) {
  const doc = await Counter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  return doc.seq;
}

module.exports = { Config, Data, Product, User, Session, Shift, Sale, Hold, Refund, PosEvent, Counter, nextSeq };

# local_pos_api — POS server in the shop

Runs on the POS computer (Windows / Mac) next to a **local MongoDB**. The shop sells from this computer even without internet; when there is internet it syncs with the cloud API (`inventory_pos_api`):

- **pull** (every 5 min + on demand): the shop's products, variants, sale units, barcodes, **shop prices**, shop stock, payment methods, exchange rate, company / tax / receipt settings, and the staff who may log in (with their POS PIN hash).
- **push** (every 15 s + after each sale): new invoices → the cloud saves them and takes the stock out of the shop (`sale_out`, FEFO batches, negative allowed). Safe to repeat (each invoice has a `uuid`).

```
local_pos (screen)  ──►  local_pos_api :8087  ──►  local MongoDB
                               │  (when online)
                               └──►  inventory_pos_api (cloud)  /api/admin/pos-device/*
```

## Setup

1. MongoDB on the computer (default `mongodb://127.0.0.1:27017/local_pos`).
2. `cp .env.example .env` → set `CLOUD_API_URL` and `CLOUD_API_KEY` (= `API_AUTH_KEY` of the cloud API).
3. `npm install` · `npm run dev` (or `npm start`).
4. In the admin web: **CONNECT → POS devices → Add POS** for the shop → a 6-digit code (30 min).
5. On the POS screen type the code once → the POS is linked and pulls the shop's data.

Production: build the screen (`cd ../local_pos && npm run build`); this server then also serves it — open `http://localhost:8087`.

## API — `/api/pos` (the screen only; header `x-pos-token` after login)

| Method | Route | |
|---|---|---|
| `GET` | `/status` | paired?, device, shop, online, last pull / push, sales waiting to be sent, open shift |
| `POST` | `/pair` | `{ code }` — the 6-digit code from the admin web (once) |
| `POST` | `/unpair` | shop manager; only when every sale is in the cloud |
| `POST` | `/sync` | push + pull now |
| `GET` | `/users` | staff of this shop with a PIN (no PIN hash) |
| `POST` | `/login` | `{ user_id, pin }` → `{ token, user }` · 5 wrong PINs → wait 1 minute |
| `POST` | `/logout` · `GET /me` | |
| `GET` | `/catalog` | everything the sell screen needs (products with prices + stock, payment methods, rate, settings) |
| `GET` | `/shift/current` · `/shift` · `/shift/:id` | open shift with live totals · history |
| `POST` | `/shift/open` | `{ opening_usd, opening_khr }` — one open shift per POS |
| `POST` | `/shift/close` | `{ counted_usd, counted_khr, note }` → report: sales, per payment method, expected vs counted cash |
| `POST` | `/sale` | `{ items: [{ variant_id, unit_id, qty }], discount: { type: amount\|percent, value }, approver: { user_id, pin }, stock_approver: { user_id, pin }, payments: [{ method_id, amount, reference }], customer_id, redeem_points, hold_id (layaway: its deposit pays first), exchange_refund_id (exchange credit pays first), note }` — promotions applied by themselves |
| `GET` · `POST` | `/customer?q=` · `/customer/:id` · `/customer` | loyalty customers (search by phone / name) · add one here (also offline; 409 + the customer when the phone exists) |
| `POST` | `/khqr/check` | `{ md5 }` → asks the cloud whether the Bakong KHQR is paid (`{ ready, paid, hash }`, `offline: true` without internet) |
| `POST` | `/shift/cash` | `{ type: in\|out, kind: expense\|safe_drop\|float\|other, amount, currency, note, approver }` — money in / out of the drawer that is not a sale; **out** needs a shop manager and never more than the drawer should have |
| `GET` | `/sale` · `/sale/:id` · `/receipt/:id` | today's / shift's invoices · one invoice · receipt data (reprint) |
| `GET` | `/sale?problem=true` | invoices the cloud refused (any shift), with `sync_error` |
| `POST` | `/sale/:id/retry` | send it again now → 200 sent · 409 with the cloud's reason |
| `POST` | `/sale/:id/discard` | `{ reason, approver: { user_id, pin } }` (shop manager) → `state: discarded`: never sent, left out of totals; only for invoices not in the cloud |
| `POST` | `/refund/:id/exchange-cash` · `GET /exchange/open` | an exchange the customer did not use → the credit is paid in cash from the drawer (once) · exchanges with credit waiting |
| `POST` | `/sale/:id/refund` | `{ lines: [{ index, qty }] \| all: true, reason, method_id, exchange (true = keep it as credit for new items, no cash), approver: { user_id, pin } }` → money back from the **open shift's** drawer (shop manager, or a manager's PIN); never more than left; stock back here at once; `kind: void` = everything, first time → `{ refund, sale }` |
| `GET` | `/refund` | `?shift_id=&sale=` refunds made on this POS |
| `POST` | `/approve` | `{ user_id, pin }` — checks a shop manager's PIN on the cashier's screen (wrong PIN → 403, the cashier stays logged in) |
| `GET` | `/hold` | held (parked) carts of this POS, oldest first |
| `POST` | `/hold` | `{ label, items: [{ variant_id, unit_id, qty }], discount, note, total, customer_id, deposit: { amount, currency } }` → park the cart (max 50, no `H<yymmdd>-n`); with a deposit = **layaway** (cash into the open shift's drawer) |
| `POST` | `/hold/:id/resume` | take it back: a plain hold leaves the list; a layaway stays until its sale (`hold_id`) is done |
| `POST` | `/hold/:id/deposit` | `{ amount, currency }` — more deposit on a layaway |
| `DELETE` | `/hold/:id` | delete; a layaway needs a shop manager (`approver`) and gives the deposit back from the drawer (`give_back: false` = the shop keeps it) |
| `GET` | `/report?date=YYYY-MM-DD&user_id=` | sales of one day (Phnom Penh time): totals, payments (net of change), by hour, top items, shifts, last 7 days; a shop manager also gets *by cashier*. A cashier always gets only their own sales (`user_id` ignored) |
| `PUT` | `/display` | `{ mode: idle\|cart\|pay\|done, data }` — what the customer display shows (sent by the sell screen) |
| `GET` | `/display` · `/display/stream` | no login: shop name / logo + current screen · live updates (Server-Sent Events) for the customer display |

### Sale rules (`src/money.js`)
- Prices come from the local copy (never from the screen). Bill discount (amount or %) is shared over the items that allow discount. **A cashier's discount needs a shop manager's PIN**; a manager can give it directly.
- Tax from the cloud setting: none · exclusive (added) · inclusive (inside the price).
- KHR total = USD × rate, rounded to the riel step (100 ៛).
- Payments: cash USD / KHR may be more than the total; QR / card / bank can't. Change: whole dollars in USD + the rest in riel when the customer paid USD cash; all in riel when they paid in riel. Less than the smallest riel note is not given.
- Invoice no. `<POS code>-<yymm>-00001` (e.g. `PP01-P1-2610-00001`), shift no. `<POS code>-S<yymmdd>-1`.

## Test (end to end)

Needs a local MongoDB and `../inventory_pos_api` with a **test** database in its `.env`:

```
MONGO_DB_LOCAL_TEST=mongodb://127.0.0.1:27017/pos_test npm test
```

It pairs with a real code, logs in with PINs, opens a shift, sells (USD, KHR, discount with a manager PIN), pushes to the cloud, checks the cloud sale + stock, closes the shift, and cleans everything up.

## Unlinked in the admin web

When the admin **deletes** this POS, **turns it off**, or makes a **new pairing code**, the cloud refuses the POS key with `code: DEVICE_UNPAIRED | DEVICE_OFF`. The POS notices within ~20 s (ping, `SYNC_PING_SECONDS`) or at the next sync and then:
- forgets the key and the shop's data (products, prices, staff, sessions, held carts) — the screen goes back to the 6-digit code with the reason (`/status` → `revoked_reason`);
- keeps sales and shifts not sent yet: they are sent after this same POS is paired again.

## Refund / void, attendance

- Refunds go to the cloud with the push (after the invoices); the shift report and the day report show them (`refund_total`, `net_total`), and the expected cash goes down by what was given back in cash.
- Each login / logout is kept (`PosEvent`) and sent with the push → attendance report and Telegram in the cloud.

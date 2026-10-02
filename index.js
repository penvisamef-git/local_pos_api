// Local POS server — runs on the POS computer in the shop (Windows / Mac).
// Keeps a copy of the shop's data in a local MongoDB so the shop can sell without internet,
// and syncs with the cloud API (inventory_pos_api) when it can: pull products / prices / staff, push sales.
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const mongoose = require("mongoose");
const sync = require("./src/sync");

const PORT = Number(process.env.api_port || process.env.PORT || 8087);
const HOST = process.env.HOST || "127.0.0.1"; // only this computer (set 0.0.0.0 to allow other devices)
const MONGO_URL = process.env.MONGO_DB_LOCAL || "mongodb://127.0.0.1:27017/local_pos";

const app = express();
// the POS screen runs on this computer (http://localhost:3001 in development, or served below)
app.use(cors({ origin: (origin, cb) => cb(null, !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) }));
app.use(compression());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ ok: mongoose.connection.readyState === 1, online: sync.state.online }));
app.use("/api/pos", require("./src/pos.route"));

// Production: serve the built POS screen from ../local_pos/build (or POS_WEB_DIR) → open http://localhost:8087
const webDir = process.env.POS_WEB_DIR || path.resolve(__dirname, "../local_pos/build");
if (fs.existsSync(path.join(webDir, "index.html"))) {
  app.use(express.static(webDir, { index: false, maxAge: "7d" }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(webDir, "index.html")));
}

app.use((req, res) => res.status(404).json({ success: false, message: "Route not found" }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ success: false, message: "Invalid JSON body" });
  console.error(err);
  res.status(500).json({ success: false, message: "Internal Server Error" });
});

async function start() {
  await mongoose.connect(MONGO_URL);
  console.log(`✅ Local MongoDB: ${MONGO_URL.replace(/\/\/[^@]*@/, "//***@")}`);
  app.listen(PORT, HOST, () => console.log(`🛒 POS server on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} · cloud ${sync.CLOUD_URL()}`));
  sync.startWorker();
}

if (require.main === module) {
  start().catch((err) => {
    console.error("❌ POS server could not start:", err.message);
    process.exit(1);
  });
}

process.on("SIGINT", async () => {
  sync.stopWorker();
  await mongoose.connection.close();
  process.exit(0);
});

module.exports = { app, start };

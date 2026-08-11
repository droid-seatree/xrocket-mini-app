// Local-only signing/token server. Run with: npm install && npm start
// Holds your xRocket Bearer token and (optionally) your Changelly private key.
// Never move these into the browser dashboard.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN === "*" ? true : process.env.ALLOWED_ORIGIN,
  })
);

const XROCKET_BASE = process.env.XROCKET_TESTNET === "true"
  ? "https://exchange.api.testnet.xrocket.exchange"
  : "https://exchange.api.xrocket.exchange";
const CHANGELLY_BASE = "https://api.changelly.com/v2";

/* ---------------------------------------------------------------------------
 * xRocket Exchange API
 * Auth: `Authorization: Bearer <token>` (from @xRocket bot > Settings >
 * Exchange settings > API token). No request signing needed.
 *
 * IMPORTANT CAVEAT: xRocket's docs render exact request-body schemas in a
 * client-side Swagger widget I can't execute from here. The field names below
 * (symbol, side, type, size, funds, timeInForce) are inferred from their
 * visible order-history example, which closely mirrors KuCoin's API shape.
 * Before trusting this with real money: open
 * https://docs.xrocket.exchange/api/exchange/reference/http/exchange-order-controller-place-order
 * and use its "Try it" panel to confirm the exact body once, with the
 * smallest possible test order.
 * ------------------------------------------------------------------------- */
async function xrocketCall(method, path, { query, body } = {}) {
  const token = process.env.XROCKET_API_TOKEN;
  if (!token) throw new Error("XROCKET_API_TOKEN not configured in .env");

  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const res = await fetch(`${XROCKET_BASE}${path}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`xRocket ${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Changelly Exchange API v2 signing (RSA-SHA256 over the raw JSON body)
// Kept as an optional fallback sweep path — see /api/sweep-execute below.
// ---------------------------------------------------------------------------
function changellyKeys() {
  const hex = process.env.CHANGELLY_PRIVATE_KEY_HEX;
  if (!hex) throw new Error("CHANGELLY_PRIVATE_KEY_HEX not configured in .env");
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(hex, "hex"), format: "der", type: "pkcs8" });
  const publicKeyDer = crypto.createPublicKey(privateKey).export({ type: "pkcs1", format: "der" });
  const apiKey = crypto.createHash("sha256").update(publicKeyDer).digest("base64");
  return { privateKey, apiKey };
}

async function changellyCall(method, params = {}) {
  const { privateKey, apiKey } = changellyKeys();
  const message = { jsonrpc: "2.0", id: String(Date.now()), method, params };
  const bodyStr = JSON.stringify(message);
  const signature = crypto.sign("sha256", Buffer.from(bodyStr), privateKey).toString("base64");

  const res = await fetch(CHANGELLY_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey, "X-Api-Signature": signature },
    body: bodyStr,
  });
  const json = await res.json();
  if (json.error) throw new Error(`Changelly ${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

const path = require("path");

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next(); // static assets: no secret needed to load the page shell
  const required = process.env.BACKEND_SHARED_SECRET;
  if (!required) return res.status(500).json({ ok: false, error: "BACKEND_SHARED_SECRET not configured in .env — refusing to run open." });
  if (req.header("x-backend-secret") !== required) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/api/ping", (req, res) => res.json({ ok: true, time: Date.now() }));

// Server-side CoinGecko proxy — avoids any browser CORS/CSP issues and keeps
// your optional demo key out of client-visible requests.
app.get("/api/market", async (req, res) => {
  try {
    const perPage = Math.min(Math.max(Number(req.query.perPage) || 100, 20), 250);
    const key = process.env.COINGECKO_DEMO_KEY ? `&x_cg_demo_api_key=${encodeURIComponent(process.env.COINGECKO_DEMO_KEY)}` : "";
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1&price_change_percentage=1h,24h${key}`;
    const cgRes = await fetch(url);
    if (!cgRes.ok) {
      const bodyText = await cgRes.text().catch(() => "");
      throw new Error(`CoinGecko HTTP ${cgRes.status}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ""}`);
    }
    const data = await cgRes.json();
    res.json({ ok: true, result: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Trading-balance snapshot (funds available for opening new positions).
app.get("/api/balance", async (req, res) => {
  try {
    const result = await xrocketCall("GET", "/api/v1/accounts/trading/balances");
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// body: { symbol: "BTC" (base asset only, we append -USDT), side: "BUY"|"SELL", sizeUsd?, qty? }
// BUY sizes by USD funds (matches our $25 / 25% risk cap directly).
// SELL sizes by base-asset quantity (closing a specific held position).
app.post("/api/order", async (req, res) => {
  try {
    const { symbol, side, sizeUsd, qty } = req.body;
    if (!symbol || !side) throw new Error("symbol and side are required");
    const pair = `${symbol.toUpperCase()}-USDT`;
    const body = { symbol: pair, side: side.toLowerCase(), type: "market", timeInForce: "IOC" };
    if (side.toUpperCase() === "BUY") {
      if (!sizeUsd) throw new Error("sizeUsd required for BUY");
      body.funds = String(sizeUsd);
    } else {
      if (!qty) throw new Error("qty required for SELL");
      body.size = String(qty);
    }
    const result = await xrocketCall("POST", "/api/v1/orders", { body });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Move funds from trading balance to funding balance — required before a
// withdrawal, since trades settle into the trading balance.
app.post("/api/transfer-to-funding", async (req, res) => {
  try {
    const { asset, amount } = req.body;
    if (!asset || !amount) throw new Error("asset and amount required");
    const result = await xrocketCall("POST", "/api/v1/transfers", {
      body: { asset: asset.toUpperCase(), amount: String(amount), direction: "trading-to-funding" },
    });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// body: { asset, amount, address, network? }
app.post("/api/withdraw", async (req, res) => {
  try {
    const { asset, amount, address, network } = req.body;
    if (!asset || !amount || !address) throw new Error("asset, amount, address required");
    const body = { asset: asset.toUpperCase(), amount: String(amount), address };
    if (network) body.network = network;
    const result = await xrocketCall("POST", "/api/v1/accounts/funding/withdrawals", { body });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Simplest sweep: pairs already trade vs USDT, so a closed trade leaves you
// holding USDT in the trading balance. Move it to funding, then withdraw to
// your TON wallet over the TON network — xRocket's native chain, so this
// should need no conversion step at all.
app.post("/api/sweep-direct", async (req, res) => {
  try {
    const { amount } = req.body;
    const address = process.env.TON_PAYOUT_ADDRESS;
    if (!address) throw new Error("TON_PAYOUT_ADDRESS not configured in .env");
    if (!amount) throw new Error("amount required");

    await xrocketCall("POST", "/api/v1/transfers", {
      body: { asset: "USDT", amount: String(amount), direction: "trading-to-funding" },
    });
    const result = await xrocketCall("POST", "/api/v1/accounts/funding/withdrawals", {
      body: { asset: "USDT", amount: String(amount), address, network: "TON" },
    });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Fallback via Changelly, for assets xRocket can't withdraw directly on TON.
app.post("/api/sweep-execute", async (req, res) => {
  try {
    const { from, amountFrom } = req.body;
    const to = process.env.CHANGELLY_USDT_TON_TICKER || "usdtton";
    const address = process.env.TON_PAYOUT_ADDRESS;
    if (!address) throw new Error("TON_PAYOUT_ADDRESS not configured in .env");

    const tx = await changellyCall("createTransaction", { from, to, address, amountFrom: String(amountFrom) });
    await xrocketCall("POST", "/api/v1/transfers", {
      body: { asset: from.toUpperCase(), amount: String(amountFrom), direction: "trading-to-funding" },
    });
    const withdrawal = await xrocketCall("POST", "/api/v1/accounts/funding/withdrawals", {
      body: { asset: from.toUpperCase(), amount: String(amountFrom), address: tx.payinAddress },
    });
    res.json({ ok: true, changelly: tx, withdrawal });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 8787;

app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Spike-bot server listening on http://localhost:${PORT}`);
  console.log(`Open that URL in a browser — the dashboard and API now live together.`);
});

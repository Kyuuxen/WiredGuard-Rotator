const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();

// ==============================
// CONFIG
// ==============================

const PORT = process.env.PORT || 3000;
const SECRET_TOKEN = process.env.SECRET_TOKEN || "changeme";
const BOT_TOKEN = process.env.BOT_TOKEN;

const ROTATION_MIN = 4 * 60 * 1000;
const ROTATION_MAX = 6 * 60 * 1000;

// ==============================
// LOAD CONFIGS
// ==============================

let allConfigs = [];
let currentConfig = null;
let rotationCount = 0;
let nextRotationAt = null;

function guessCountry(hostname) {
const map = {
"us-": "United States",
"jp-": "Japan",
"sg-": "Singapore",
"nl-": "Netherlands",
"uk-": "United Kingdom",
"de-": "Germany",
"fr-": "France",
"ca-": "Canada",
"au-": "Australia"
};

const lower = hostname.toLowerCase();

for (const [prefix, country] of Object.entries(map)) {
if (lower.includes(prefix)) {
return country;
}
}

return "Unknown";
}

function loadConfigs() {
const configs = [];
const count = parseInt(process.env.WG_CONFIG_COUNT || "0");

for (let i = 1; i <= count; i++) {
const b64 = process.env["WG_CONFIG_${i}"];

if (!b64) continue;

try {
  const raw = Buffer.from(b64, "base64").toString("utf8");

  const endpointMatch =
    raw.match(/Endpoint\s*=\s*(.+):(\d+)/i);

  const ip = endpointMatch?.[1] || `server-${i}`;
  const port = endpointMatch?.[2] || "51820";

  configs.push({
    raw,
    ip,
    port,
    country: guessCountry(ip),
    index: i
  });

} catch (err) {
  console.error(`[CONFIG ${i}] Failed to decode`);
}

}

return configs;
}

// ==============================
// AUTH
// ==============================

function requireToken(req, res, next) {
const token =
req.headers["x-secret-token"] ||
req.query.token;

if (token !== SECRET_TOKEN) {
return res.status(401).json({
error: "Unauthorized"
});
}

next();
}

// ==============================
// ROTATION
// ==============================

function pickRandom(exclude = null) {
if (allConfigs.length === 0) return null;

let pool =
allConfigs.filter(c => c.ip !== exclude);

if (pool.length === 0) {
pool = allConfigs;
}

return pool[
Math.floor(Math.random() * pool.length)
];
}

function rotationLoop() {
if (allConfigs.length === 0) {
console.log("[ROTATE] No configs loaded");

setTimeout(rotationLoop, 10000);
return;

}

const previous = currentConfig?.ip || null;

currentConfig = pickRandom(previous);

rotationCount++;

const delay =
ROTATION_MIN +
Math.floor(
Math.random() *
(ROTATION_MAX - ROTATION_MIN)
);

nextRotationAt = Date.now() + delay;

console.log(
"[ROTATE #${rotationCount}] ${currentConfig.country} -> ${currentConfig.ip}:${currentConfig.port}"
);

setTimeout(rotationLoop, delay);
}

// ==============================
// ROUTES
// ==============================

app.get("/status", (req, res) => {
res.json({
ok: true,
configs_loaded: allConfigs.length,
rotation_count: rotationCount,
current_country: currentConfig?.country || null,
next_rotation:
nextRotationAt
? new Date(nextRotationAt).toISOString()
: null
});
});

app.get("/endpoint", requireToken, (req, res) => {

if (!currentConfig) {
return res.status(503).json({
error: "No config loaded"
});
}

res.json({
ip: currentConfig.ip,
port: currentConfig.port,
country: currentConfig.country,
rotation: rotationCount,
next_rotation:
new Date(nextRotationAt).toISOString()
});
});

app.get("/endpoint/config", requireToken, (req, res) => {

if (!currentConfig) {
return res.status(503).json({
error: "No config loaded"
});
}

res.setHeader(
"Content-Type",
"text/plain"
);

res.send(currentConfig.raw);
});

app.post("/endpoint/rotate", requireToken, (req, res) => {

if (!allConfigs.length) {
return res.status(503).json({
error: "No configs available"
});
}

currentConfig =
pickRandom(currentConfig?.ip);

rotationCount++;

res.json({
message: "Rotated",
ip: currentConfig.ip,
country: currentConfig.country
});
});

// ==============================
// TELEGRAM BOT
// ==============================

if (BOT_TOKEN) {

const bot =
new TelegramBot(BOT_TOKEN, {
polling: true
});

console.log("[BOT] Started");

bot.onText(//status/, msg => {

bot.sendMessage(
  msg.chat.id,
  `🟢 VPN Status

Configs: ${allConfigs.length}
Rotation: ${rotationCount}
Country: ${currentConfig?.country || "None"}`
);

});

bot.onText(//current/, msg => {

if (!currentConfig) {
  return bot.sendMessage(
    msg.chat.id,
    "No config loaded"
  );
}

bot.sendMessage(
  msg.chat.id,
  `🌍 Current VPN

IP: ${currentConfig.ip}
Port: ${currentConfig.port}
Country: ${currentConfig.country}`
);

});

bot.onText(//rotate/, msg => {

if (!allConfigs.length) {
  return bot.sendMessage(
    msg.chat.id,
    "No configs available"
  );
}

currentConfig =
  pickRandom(currentConfig?.ip);

rotationCount++;

bot.sendMessage(
  msg.chat.id,
  `🔄 Rotated

Country: ${currentConfig.country}
IP: ${currentConfig.ip}`
);

});

}

// ==============================
// START
// ==============================

allConfigs = loadConfigs();

console.log(
"[INIT] Loaded ${allConfigs.length} configs"
);

rotationLoop();

app.listen(PORT, "0.0.0.0", () => {
console.log(
"[SERVER] Running on port ${PORT}"
);
});

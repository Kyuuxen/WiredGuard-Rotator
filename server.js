const express = require("express");
const axios = require("axios");
const net = require("net");

const app = express();

// ── Config ────────────────────────────────────────────
const SECRET_TOKEN = process.env.SECRET_TOKEN || "changeme";
const ROTATION_MIN = 4 * 60 * 1000;
const ROTATION_MAX = 6 * 60 * 1000;

// Optional: auto-fetch from URL (your nordgen or other source)
const CONFIG_SOURCE_URL = process.env.CONFIG_SOURCE_URL || null;

// ── State ─────────────────────────────────────────────
let allConfigs = [];
let currentConfig = null;
let rotationCount = 0;
let nextRotationAt = null;

// ── AUTH ──────────────────────────────────────────────
function requireToken(req, res, next) {
  const token = req.headers["x-secret-token"] || req.query.token;
  if (!token || token !== SECRET_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── COUNTRY GUESS ─────────────────────────────────────
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
    "au-": "Australia",
  };

  for (const [prefix, country] of Object.entries(map)) {
    if (hostname.toLowerCase().includes(prefix)) return country;
  }
  return "Unknown";
}

// ── LOAD FROM ENV (fallback) ──────────────────────────
function loadFromEnv() {
  const configs = [];
  const count = parseInt(process.env.WG_CONFIG_COUNT || "0");

  for (let i = 1; i <= count; i++) {
    const b64 = process.env[`WG_CONFIG_${i}`];
    if (!b64) continue;

    const raw = Buffer.from(b64, "base64").toString("utf-8");
    configs.push(parseConfig(raw, i));
  }

  return configs;
}

// ── PARSE CONFIG ──────────────────────────────────────
function parseConfig(raw, index = 0) {
  const endpointMatch = raw.match(/Endpoint\s*=\s*(.+):(\d+)/i);

  const ip = endpointMatch?.[1] || `server-${index}`;
  const port = endpointMatch?.[2] || "1194";

  return {
    raw,
    ip,
    port,
    country: guessCountry(ip),
    index,
  };
}

// ── CHECK IF ENDPOINT ALIVE ───────────────────────────
function checkEndpoint(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let alive = false;

    socket.setTimeout(timeout);

    socket
      .on("connect", () => {
        alive = true;
        socket.destroy();
      })
      .on("error", () => {})
      .on("timeout", () => socket.destroy())
      .on("close", () => resolve(alive));

    socket.connect(port, host);
  });
}

// ── HEALTH CHECK + REMOVE DEAD ────────────────────────
async function filterDeadConfigs() {
  const alive = [];

  for (const cfg of allConfigs) {
    const match = cfg.raw.match(/Endpoint\s*=\s*(.+):(\d+)/i);
    if (!match) continue;

    const host = match[1];
    const port = parseInt(match[2]);

    const ok = await checkEndpoint(host, port);

    if (ok) {
      alive.push(cfg);
    } else {
      console.log("[REMOVED DEAD]", host);
    }
  }

  allConfigs = alive;
  console.log(`[HEALTH] Alive configs: ${allConfigs.length}`);
}

// ── OPTIONAL AUTO-FETCH ───────────────────────────────
async function fetchConfigs() {
  if (!CONFIG_SOURCE_URL) return;

  try {
    console.log("[FETCH] Downloading configs...");

    const res = await axios.get(CONFIG_SOURCE_URL);

    const matches = res.data.match(/https?:\/\/[^\s'"]+\.conf/g);
    if (!matches) return;

    const configs = [];

    for (const url of matches) {
      try {
        const file = await axios.get(url);
        configs.push(parseConfig(file.data));
      } catch {}
    }

    allConfigs = configs;
    console.log(`[FETCH] Loaded ${configs.length} configs`);
  } catch (err) {
    console.log("[FETCH ERROR]", err.message);
  }
}

// ── ROTATION ──────────────────────────────────────────
function pickRandom(exclude = null) {
  if (allConfigs.length === 0) return null;

  let pool = allConfigs.filter((c) => c.ip !== exclude);
  if (pool.length === 0) pool = allConfigs;

  return pool[Math.floor(Math.random() * pool.length)];
}

function rotationLoop() {
  if (allConfigs.length === 0) {
    console.log("[ROTATE] No configs available");
    return setTimeout(rotationLoop, 10000);
  }

  const prev = currentConfig?.ip;
  currentConfig = pickRandom(prev);

  rotationCount++;

  console.log(
    `[ROTATE #${rotationCount}] ${currentConfig.country} → ${currentConfig.ip}:${currentConfig.port}`
  );

  const delay =
    ROTATION_MIN + Math.random() * (ROTATION_MAX - ROTATION_MIN);

  nextRotationAt = Date.now() + delay;

  setTimeout(rotationLoop, delay);
}

// ── ROUTES ────────────────────────────────────────────
app.get("/endpoint", requireToken, (req, res) => {
  if (!currentConfig) {
    return res.status(503).json({ error: "No config loaded" });
  }

  res.json({
    ip: currentConfig.ip,
    port: currentConfig.port,
    country: currentConfig.country,
    rotation: rotationCount,
    next_rotation: new Date(nextRotationAt).toISOString(),
  });
});

app.get("/endpoint/config", requireToken, (req, res) => {
  if (!currentConfig) {
    return res.status(503).json({ error: "No config loaded" });
  }

  res.setHeader("Content-Type", "text/plain");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="vpn-${currentConfig.country}.conf"`
  );

  res.send(currentConfig.raw);
});

app.get("/endpoint/list", requireToken, (req, res) => {
  res.json({
    count: allConfigs.length,
    current: currentConfig?.ip,
    servers: allConfigs.map((c) => ({
      ip: c.ip,
      port: c.port,
      country: c.country,
      active: c.ip === currentConfig?.ip,
    })),
  });
});

app.post("/endpoint/rotate", requireToken, (req, res) => {
  const prev = currentConfig?.ip;
  currentConfig = pickRandom(prev);
  rotationCount++;

  res.json({
    message: "Rotated",
    ip: currentConfig.ip,
    country: currentConfig.country,
  });
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    configs_loaded: allConfigs.length,
    rotation_count: rotationCount,
    current_country: currentConfig?.country || null,
    next_rotation: nextRotationAt
      ? new Date(nextRotationAt).toISOString()
      : "pending",
  });
});

// ── START SYSTEM ──────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  // 1. load configs
  allConfigs = loadFromEnv();

  // 2. optional auto-fetch
  await fetchConfigs();

  // 3. remove dead servers
  await filterDeadConfigs();

  // 4. start rotation
  rotationLoop();

  // 5. periodic refresh
  setInterval(fetchConfigs, 30 * 60 * 1000);
  setInterval(filterDeadConfigs, 10 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`[SERVER] Running on port ${PORT}`);
    console.log(`[INIT] Configs loaded: ${allConfigs.length}`);
  });
}

start();

const express = require("express");
const app = express();

// ── Config ────────────────────────────────────────────
const SECRET_TOKEN = process.env.SECRET_TOKEN || "changeme";
const ROTATION_MIN = 4 * 60 * 1000;
const ROTATION_MAX = 6 * 60 * 1000;

// ── Load WireGuard configs from env ──────────────────
function loadConfigs() {
  const configs = [];
  const count = parseInt(process.env.WG_CONFIG_COUNT || "0");

  for (let i = 1; i <= count; i++) {
    const b64 = process.env[`WG_CONFIG_${i}`];
    if (!b64) continue;

    const raw = Buffer.from(b64, "base64").toString("utf-8");

    // Parse endpoint line for metadata
    const endpointMatch = raw.match(/Endpoint\s*=\s*(.+):(\d+)/i);
    const ip = endpointMatch?.[1] || `server-${i}`;
    const port = endpointMatch?.[2] || "1194";

    // Try to guess country from hostname
    const country = guessCountry(ip);

    configs.push({ raw, ip, port, country, index: i });
  }

  console.log(`[INIT] Loaded ${configs.length} WireGuard configs`);
  return configs;
}

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

// ── State ─────────────────────────────────────────────
const allConfigs = loadConfigs();
let currentConfig = null;
let rotationCount = 0;
let nextRotationAt = null;

// ── Auth Middleware ───────────────────────────────────
function requireToken(req, res, next) {
  const token = req.headers["x-secret-token"] || req.query.token;
  if (!token || token !== SECRET_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Rotation Logic ────────────────────────────────────
function pickRandom(exclude = null) {
  if (allConfigs.length === 0) return null;
  if (allConfigs.length === 1) return allConfigs[0];

  let available = allConfigs.filter((c) => c.ip !== exclude);
  if (available.length === 0) available = allConfigs;
  return available[Math.floor(Math.random() * available.length)];
}

function rotationLoop() {
  const prev = currentConfig?.ip || null;
  currentConfig = pickRandom(prev); // avoid picking same server twice
  rotationCount++;

  console.log(
    `[ROTATE #${rotationCount}] ${currentConfig.country} → ${currentConfig.ip}:${currentConfig.port}`
  );

  const delay =
    ROTATION_MIN + Math.floor(Math.random() * (ROTATION_MAX - ROTATION_MIN));
  nextRotationAt = Date.now() + delay;
  console.log(`[NEXT] in ${Math.round(delay / 1000)}s`);

  setTimeout(rotationLoop, delay);
}

// ── Routes ────────────────────────────────────────────

// Current server info (no config)
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

// Download current WireGuard .conf file
app.get("/endpoint/config", requireToken, (req, res) => {
  if (!currentConfig) {
    return res.status(503).json({ error: "No config loaded" });
  }
  res.setHeader("Content-Type", "text/plain");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="privado-${currentConfig.country.replace(/\s/g, "-")}.conf"`
  );
  res.send(currentConfig.raw);
});

// List all available servers (no raw configs exposed)
app.get("/endpoint/list", requireToken, (req, res) => {
  res.json({
    count: allConfigs.length,
    current: currentConfig?.ip || null,
    servers: allConfigs.map((c) => ({
      ip: c.ip,
      port: c.port,
      country: c.country,
      active: c.ip === currentConfig?.ip,
    })),
  });
});

// Force manual rotation
app.post("/endpoint/rotate", requireToken, (req, res) => {
  const prev = currentConfig?.ip;
  currentConfig = pickRandom(prev);
  rotationCount++;
  console.log(`[MANUAL ROTATE #${rotationCount}] → ${currentConfig.ip}`);
  res.json({
    message: "Rotated",
    ip: currentConfig.ip,
    country: currentConfig.country,
  });
});

// Public status (no token needed — for UptimeRobot)
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

// ── Start ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
  if (allConfigs.length === 0) {
    console.warn("[WARN] No WireGuard configs found in environment!");
  }
  rotationLoop();
});

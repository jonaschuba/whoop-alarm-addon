// HTTP-Server fuers WHOOP-Wecker-Add-on.
// Endpunkte:
//   GET  /health            -> { ok: true }
//   GET  /alarm             -> aktueller Wecker { time, enabled, ... }
//   POST /set-alarm         -> Body { time: "HH:MM", enabled?: bool }  setzt den Wecker
//
// Optionaler Schutz: wenn AUTH_TOKEN gesetzt ist, muss jeder Request den Header
//   x-auth-token: <AUTH_TOKEN>  mitschicken.

import { createServer } from "node:http";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { TokenStore, getAccessToken, apiGet, apiPut } from "./whoop-core.mjs";

const DATA_DIR = process.env.DATA_DIR || "/data";

// HA-Add-on legt die Optionen in /data/options.json ab. Lokal (Test) greifen wir
// auf Umgebungsvariablen zurueck.
function loadConfig() {
  let opts = {};
  const path = resolve(DATA_DIR, "options.json");
  if (existsSync(path)) {
    try { opts = JSON.parse(readFileSync(path, "utf8")); } catch {}
  }
  return {
    refreshToken: opts.whoop_refresh_token || process.env.WHOOP_REFRESH_TOKEN || "",
    authToken: opts.auth_token || process.env.AUTH_TOKEN || "",
    timezone: opts.timezone || process.env.WHOOP_TIMEZONE || "Europe/Berlin",
    port: Number(opts.port || process.env.PORT || 9590),
    // HA-Ueberwachung (Weg 2): Add-on liest diese Entitaeten selbst und synct zu WHOOP.
    weckzeitEntity: opts.weckzeit_entity || process.env.WECKZEIT_ENTITY || "input_datetime.weckzeit",
    alarmEntity: opts.alarm_entity || process.env.ALARM_ENTITY || "input_boolean.alarm",
    pollInterval: Number(opts.poll_interval || process.env.POLL_INTERVAL || 30),
  };
}

const CONFIG = loadConfig();
if (CONFIG.timezone) process.env.WHOOP_TIMEZONE = CONFIG.timezone;

const PORT = CONFIG.port;
const SEED_REFRESH_TOKEN = CONFIG.refreshToken;
const AUTH_TOKEN = CONFIG.authToken;
const PREFS = "/smart-alarm-service/v1/smartalarm/preferences";

// Supervisor-Token: nur im HA-Add-on-Kontext vorhanden. Damit liest das Add-on
// HA-Entitaeten ueber die Core-API (http://supervisor/core/api/...).
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN || "";

const store = new TokenStore(resolve(DATA_DIR, "tokens.json"));

function log(...a) { console.log(new Date().toISOString(), ...a); }

function normTime(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s).trim());
  if (!m) return null;
  return `${String(m[1]).padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`;
}

function subtractMinutes(hms, mins) {
  const [h, m, s] = hms.split(":").map(Number);
  let total = (((h * 60 + m - mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function getAlarm() {
  const token = await getAccessToken(store, SEED_REFRESH_TOKEN);
  const p = await apiGet(token, PREFS);
  return {
    time: p.upper_time_bound,
    enabled: p.enabled,
    goal: p.goal,
    time_zone_offset: p.time_zone_offset,
    window_minutes: p.window_minutes,
  };
}

// Setzt Weckzeit (+ optional an/aus). read-modify-write: behaelt Zeitzone/Modus.
async function setAlarm({ time, enabled }) {
  const upper = normTime(time);
  if (!upper) throw new Error(`Ungueltige Zeit: ${time} (erwartet HH:MM)`);
  const token = await getAccessToken(store, SEED_REFRESH_TOKEN);
  const cur = await apiGet(token, PREFS);
  const window = cur.window_minutes ?? 60;
  const body = {
    lower_time_bound: subtractMinutes(upper, window),
    upper_time_bound: upper,
    goal: cur.goal ?? "EXACT_TIME_PEAK",
    enabled: typeof enabled === "boolean" ? enabled : cur.enabled,
    schedule_enabled: cur.schedule_enabled ?? false,
    time_zone_offset: cur.time_zone_offset ?? "+0200", // von WHOOP gepflegt
    weekly_plan_goal: cur.weekly_plan_goal ?? 0,
    default: false,
  };
  await apiPut(token, PREFS, body);
  return { time: upper, enabled: body.enabled };
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((done) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { done(data ? JSON.parse(data) : {}); }
      catch { done(null); }
    });
  });
}

const server = createServer(async (req, res) => {
  try {
    if (AUTH_TOKEN && req.headers["x-auth-token"] !== AUTH_TOKEN) {
      return send(res, 401, { error: "unauthorized" });
    }
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/alarm") {
      return send(res, 200, await getAlarm());
    }
    if (req.method === "POST" && url.pathname === "/set-alarm") {
      const body = await readJsonBody(req);
      if (!body || body.time === undefined) {
        return send(res, 400, { error: "Body braucht { time: 'HH:MM', enabled?: bool }" });
      }
      const result = await setAlarm(body);
      log("set-alarm ->", JSON.stringify(result));
      return send(res, 200, { ok: true, ...result });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    log("FEHLER", e.message);
    return send(res, 500, { error: e.message });
  }
});

// --- HA-Ueberwachung (Weg 2) -------------------------------------------------
// Liest eine HA-Entitaet ueber die Supervisor-Core-API.
async function haGetState(entityId) {
  const res = await fetch(`http://supervisor/core/api/states/${entityId}`, {
    headers: { authorization: `Bearer ${SUPERVISOR_TOKEN}` },
  });
  if (!res.ok) throw new Error(`HA GET ${entityId} (${res.status})`);
  return (await res.json()).state;
}

let lastSynced = null; // "HH:MM|true" - verhindert unnoetige WHOOP-Calls

async function syncFromHa() {
  try {
    const rawTime = await haGetState(CONFIG.weckzeitEntity); // "07:00:00"
    const rawAlarm = await haGetState(CONFIG.alarmEntity);   // "on"/"off"
    if (!rawTime || rawTime === "unknown" || rawTime === "unavailable") return;
    const time = rawTime.slice(0, 5);          // "07:00"
    const enabled = rawAlarm === "on";
    const key = `${time}|${enabled}`;
    if (key === lastSynced) return;            // nichts geaendert
    await setAlarm({ time, enabled });
    lastSynced = key;
    log(`HA-Sync: Wecker -> ${time}, an: ${enabled}`);
  } catch (e) {
    log("HA-Sync Fehler:", e.message);
  }
}

server.listen(PORT, "0.0.0.0", () => {
  log(`WHOOP-Wecker-Add-on laeuft auf Port ${PORT}`);
  if (!SEED_REFRESH_TOKEN && !store.load()?.refreshToken) {
    log("Kein Refresh-Token! Bitte in den Add-on-Optionen 'whoop_refresh_token' setzen.");
  }
  if (SUPERVISOR_TOKEN) {
    log(`HA-Ueberwachung aktiv: ${CONFIG.weckzeitEntity} + ${CONFIG.alarmEntity} alle ${CONFIG.pollInterval}s`);
    syncFromHa(); // sofort beim Start
    setInterval(syncFromHa, CONFIG.pollInterval * 1000);
  } else {
    log("Kein SUPERVISOR_TOKEN - HA-Ueberwachung aus (nur HTTP-API aktiv).");
  }
});

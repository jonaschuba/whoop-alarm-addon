// WHOOP-Kern: Cognito-Auth, Token-Speicher (Auto-Refresh), API-Zugriff.
// Auth-/Header-Logik adaptiert aus dem Open-Source-Projekt "totem"
// (github.com/briangaoo/totem). Dependency-frei (nur Node-Bordmittel).

import { randomUUID } from "node:crypto";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

const AUTH_ENDPOINT = "https://api.prod.whoop.com/auth-service/v3/whoop/";
const BASE_URL = "https://api.prod.whoop.com";
const API_VERSION = "7";
const AWS_USER_AGENT =
  "aws-sdk-swift/1.5.86 ua/2.1 api/cognito_identity_provider#1.5.86 os/ios#26.3.1 lang/swift#5.10 m/D,N,Z,b";

let INSTALLATION_ID = randomUUID().toUpperCase();
const TIMEZONE = process.env.WHOOP_TIMEZONE || "Europe/Berlin";

function deviceHeaders() {
  return {
    "user-agent": "iOS",
    "x-whoop-device-platform": "iOS",
    "x-whoop-ios-version": "5.52.0",
    "x-whoop-ios-build-number": "595097",
    "x-whoop-bundle-name": "com.whoop.iphone",
    "x-whoop-installation-identifier": INSTALLATION_ID,
    "x-whoop-time-zone": TIMEZONE,
    "x-whoop-clock-format": "TWELVE_HOUR",
    currency: "EUR",
    locale: "de_DE",
    "accept-language": "de",
    accept: "*/*",
    priority: "u=3",
  };
}

async function readBody(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  const enc = (res.headers.get("content-encoding") || "").toLowerCase();
  try {
    if (enc.includes("br")) return brotliDecompressSync(buf).toString("utf8");
    if (enc.includes("gzip")) return gunzipSync(buf).toString("utf8");
    if (enc.includes("deflate")) return inflateSync(buf).toString("utf8");
  } catch {}
  return buf.toString("utf8");
}

function decodeJwtExp(jwt) {
  const parts = jwt.split(".");
  if (parts.length < 2) return 0;
  const p = parts[1].padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), "=");
  try {
    return JSON.parse(Buffer.from(p, "base64").toString("utf8")).exp ?? 0;
  } catch {
    return 0;
  }
}

async function callCognito(target, body) {
  const res = await fetch(AUTH_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
      "amz-sdk-request": "attempt=1; max=1",
      "amz-sdk-invocation-id": randomUUID(),
      "user-agent": AWS_USER_AGENT,
      accept: "*/*",
      "accept-encoding": "gzip, deflate, br", // PFLICHT (sonst Cloudflare-401)
      "accept-language": "en-US,en;q=0.9",
    },
    body: JSON.stringify(body),
  });
  const text = await readBody(res);
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = `${j.__type ?? "error"}: ${j.message ?? text}`;
    } catch {}
    throw new Error(`Cognito ${target} (${res.status}): ${detail}`);
  }
  return JSON.parse(text);
}

export async function refresh(refreshToken) {
  const resp = await callCognito("InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    AuthParameters: { REFRESH_TOKEN: refreshToken },
    ClientId: "",
  });
  const ar = resp.AuthenticationResult;
  if (!ar) throw new Error("Refresh gab keine Tokens zurück.");
  return {
    accessToken: ar.AccessToken,
    refreshToken: ar.RefreshToken ?? refreshToken,
    expiresAt: decodeJwtExp(ar.AccessToken) * 1000,
  };
}

export class TokenStore {
  constructor(path) {
    this.path = path;
    this.data = null;
  }
  load() {
    if (existsSync(this.path)) {
      this.data = JSON.parse(readFileSync(this.path, "utf8"));
      if (this.data.installationId) INSTALLATION_ID = this.data.installationId;
    }
    return this.data;
  }
  save(data) {
    this.data = { ...this.data, ...data, installationId: INSTALLATION_ID };
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try { chmodSync(this.path, 0o600); } catch {}
  }
}

export async function apiGet(token, path) {
  const url = new URL(BASE_URL + path);
  url.searchParams.set("apiVersion", API_VERSION);
  const res = await fetch(url, {
    method: "GET",
    headers: { ...deviceHeaders(), authorization: `Bearer ${token}` },
  });
  const text = await readBody(res);
  if (!res.ok) throw new Error(`GET ${path} (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export async function apiPut(token, path, body) {
  const url = new URL(BASE_URL + path);
  url.searchParams.set("apiVersion", API_VERSION);
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      ...deviceHeaders(),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await readBody(res);
  if (!res.ok) throw new Error(`PUT ${path} (${res.status}): ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : { ok: true };
}

// Liefert einen gültigen Access-Token: lädt Refresh-Token aus Store oder
// (beim ersten Start) aus seedRefreshToken, refresht und persistiert.
export async function getAccessToken(store, seedRefreshToken) {
  let data = store.load();
  let rt = data?.refreshToken || seedRefreshToken;
  if (!rt) throw new Error("Kein Refresh-Token vorhanden (Add-on-Option setzen).");
  const t = await refresh(rt);
  store.save({ refreshToken: t.refreshToken });
  return t.accessToken;
}

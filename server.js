"use strict";
/*
 * Copyright (C) 2026 Sean O'Neill
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Range Book is free software under the GNU Affero General Public License, version 3 or later. See the LICENSE file.
 *
 * Range Book server — trajectory calculator + reloading log with user accounts.
 * No third-party packages: Node's built-in http, crypto and sqlite only.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const { exportXlsx, exportPdf, targetPdf, tripReportPdf, gunsXlsx, gunsPdf, zip } = require("./export.js");
const backupKit = require("./backup.js");

/* ---------------- configuration ---------------- */
const PORT = parseInt(process.env.PORT || "9090", 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC_DIR = path.join(__dirname, "public");
const SEED_FILE = process.env.SEED_FILE || path.join(__dirname, "seed", "initial.json");
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "admin").trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
// the version is the newest entry in public/changelog.json (the What's new page reads the same file)
// where people can get this copy's source code (the AGPL asks a hosted copy to say); shown on How to Use
// the official project; a changed copy run for other people should set SOURCE_URL to where its own code is published
const DEFAULT_SOURCE_URL = "https://github.com/saoneill01-a11y/rangebook";
const SOURCE_URL = /^https?:\/\/[^\s"'<>]+$/.test(process.env.SOURCE_URL || "") ? process.env.SOURCE_URL : DEFAULT_SOURCE_URL;
const APP_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "public", "changelog.json"), "utf8")).releases[0].version; } catch { return "dev"; } })();
const COOKIE_SECURE = /^(1|true|yes)$/i.test(process.env.COOKIE_SECURE || "");
const SESSION_DAYS = Math.max(1, parseInt(process.env.SESSION_DAYS || "30", 10));
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || "");
const COOKIE = "rb_session";
const PHOTO_DIR = path.join(DATA_DIR, "photos");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || "14", 10));
const BACKUP_HOUR = Math.min(23, Math.max(0, parseInt(process.env.BACKUP_HOUR || "3", 10)));

fs.mkdirSync(PHOTO_DIR, { recursive: true });

/* When started as root (the Docker default), hand the data folder to PUID/PGID
   (Unraid's nobody:users = 99:100 by default) and drop root before doing anything else. */
if (typeof process.getuid === "function" && process.getuid() === 0 && !/^(0|false|no)$/i.test(process.env.DROP_ROOT || "")) {
  const uid = parseInt(process.env.PUID || "99", 10), gid = parseInt(process.env.PGID || "100", 10);
  const walk = (p) => { try { fs.lchownSync(p, uid, gid); } catch {} try { if (fs.lstatSync(p).isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f)); } catch {} };
  walk(DATA_DIR);
  process.setgid(gid); process.setuid(uid);
  console.log(`Running as uid ${uid}, gid ${gid}.`);
}

/* ---------------- database ---------------- */
const db = new DatabaseSync(path.join(DATA_DIR, "rangebook.db"));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  pass TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  must_change INTEGER NOT NULL DEFAULT 1,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS loads(
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS load_shares(
  load_id TEXT NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(load_id, user_id)
);
CREATE TABLE IF NOT EXISTS photos(
  id TEXT PRIMARY KEY,
  load_id TEXT NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caption TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL,
  w INTEGER, h INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trip_photos(
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caption TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL,
  w INTEGER, h INTEGER,
  measure TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shared_ammo(
  id TEXT PRIMARY KEY,
  owner_id INTEGER,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS box_photos(
  id TEXT PRIMARY KEY,
  cat_item TEXT,
  ammo_id TEXT,
  owner_id INTEGER,
  file TEXT NOT NULL,
  w INTEGER, h INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gun_photos(
  id TEXT PRIMARY KEY,
  rifle_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  w INTEGER, h INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_docs(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, key)
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS loads_owner ON loads(owner_id);
CREATE INDEX IF NOT EXISTS photos_load ON photos(load_id);
CREATE INDEX IF NOT EXISTS trip_photos_trip ON trip_photos(owner_id, trip_id);
CREATE INDEX IF NOT EXISTS shares_user ON load_shares(user_id);
CREATE INDEX IF NOT EXISTS gun_photos_owner ON gun_photos(owner_id, rifle_id);
`);
const q = (sql) => db.prepare(sql);
if (!q("PRAGMA table_info(photos)").all().some((c) => c.name === "measure")) db.exec("ALTER TABLE photos ADD COLUMN measure TEXT");
// which ladder test (inside the load's data) a target photo was shot with
if (!q("PRAGMA table_info(photos)").all().some((c) => c.name === "ladder_id")) db.exec("ALTER TABLE photos ADD COLUMN ladder_id TEXT");
if (!q("PRAGMA table_info(users)").all().some((c) => c.name === "accepted_terms")) db.exec("ALTER TABLE users ADD COLUMN accepted_terms INTEGER");
const ladderIdOf = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v) ? v : null);
const parseMeasure = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
const getSetting = (k, d) => { const r = q("SELECT value FROM settings WHERE key=?").get(k); return r ? JSON.parse(r.value) : d; };
const setSetting = (k, v) => q("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, JSON.stringify(v));
const now = () => Date.now();

/* ---------------- passwords ---------------- */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, key] = String(stored).split("$");
    if (alg !== "scrypt") return false;
    const want = Buffer.from(key, "base64");
    const got = crypto.scryptSync(pw, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(want, got);
  } catch { return false; }
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));
function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Passwords need at least 8 characters.";
  if (pw.length > 200) return "That password is too long.";
  return null;
}
function tempPassword() {
  const words = "able acorn amber anvil arrow aspen badge birch blaze brass cedar cliff comet copper crane delta eagle ember falcon fern flint forge grove hawk hazel iron jasper kestrel lake maple meadow mesa oak onyx otter pine quail raven ridge river sage scout slate spruce stone summit thistle timber trail valley willow".split(" ");
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(100, 1000)}`;
}

/* ---------------- first run ---------------- */
const needsSetup = () => q("SELECT COUNT(*) AS n FROM users").get().n === 0;
function firstRun() {
  if (!needsSetup()) return;
  // No ADMIN_PASSWORD: leave it to the setup page, where the first person to open Range Book creates the admin account.
  if (!ADMIN_PASSWORD) {
    console.log("======================================================");
    console.log(" Range Book: no accounts yet. Open it in your browser to");
    console.log(" create the admin account (do this right away).");
    console.log("======================================================");
    return;
  }
  const pw = ADMIN_PASSWORD;
  const info = q("INSERT INTO users(username,display_name,pass,is_admin,must_change,created_at) VALUES(?,?,?,?,?,?)")
    .run(ADMIN_USERNAME, ADMIN_USERNAME, hashPassword(pw), 1, ADMIN_PASSWORD ? 0 : 1, now());
  const adminId = Number(info.lastInsertRowid);
  console.log("======================================================");
  console.log(` Range Book: created admin account "${ADMIN_USERNAME}"`);
  if (!ADMIN_PASSWORD) console.log(` Temporary password: ${pw}   (you'll be asked to change it)`);
  else console.log(" Password: the ADMIN_PASSWORD you set");
  console.log("======================================================");
  maybeImportSeed(adminId, ADMIN_USERNAME);
}
function maybeImportSeed(uid, uname) {
  if (fs.existsSync(SEED_FILE) && !/^(0|false|no)$/i.test(process.env.IMPORT_SEED || "")) {
    try { importSeed(uid, JSON.parse(fs.readFileSync(SEED_FILE, "utf8")), uname); }
    catch (e) { console.error("Seed import failed:", e.message); }
  }
}
function importSeed(uid, seed, uname) {
  const t = now();
  let nl = 0, np = 0;
  db.exec("BEGIN");
  try {
    for (const L of seed.loads || []) {
      q("INSERT OR REPLACE INTO loads(id,owner_id,data,created_at,updated_at) VALUES(?,?,?,?,?)").run(L.id, uid, JSON.stringify(L.data), t, t); nl++;
    }
    if (seed.brass) q("INSERT OR REPLACE INTO user_docs(user_id,key,data,updated_at) VALUES(?,?,?,?)").run(uid, "brass", JSON.stringify(seed.brass), t);
    for (const p of seed.photos || []) {
      const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(p.data || "");
      if (!m) continue;
      const id = crypto.randomUUID(), file = `${id}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
      fs.writeFileSync(path.join(PHOTO_DIR, file), Buffer.from(m[2], "base64"));
      q("INSERT INTO photos(id,load_id,owner_id,caption,file,w,h,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, p.loadId, uid, p.caption || "", file, p.w || null, p.h || null, p.createdAt || t); np++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  console.log(` Imported ${nl} loads and ${np} photos into ${uname || ADMIN_USERNAME}'s account.`);
}

/* ---------------- sessions ---------------- */
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
// Did this request reach us over https? Direct TLS, or (with TRUST_PROXY) the Cloudflare tunnel, which says so in its headers.
// A plain http visit on the home network (http://<server IP>:9090) is not.
function viaHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (!TRUST_PROXY) return false;
  if (/^https$/i.test(String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim())) return true;
  return /"scheme"\s*:\s*"https"/i.test(String(req.headers["cf-visitor"] || ""));
}
// With COOKIE_SECURE on, the sign-in cookie is https-only on the Cloudflare address, and a normal cookie on the local
// http address (a browser throws away an https-only cookie it gets over http, so local sign-in would never stick).
function cookieHeader(req, value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${COOKIE_SECURE && viaHttps(req) ? "; Secure" : ""}`;
}
function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const ms = SESSION_DAYS * 86400000;
  q("INSERT INTO sessions(token_hash,user_id,created_at,expires) VALUES(?,?,?,?)").run(sha(token), userId, now(), now() + ms);
  res.setHeader("Set-Cookie", cookieHeader(req, token, Math.floor(ms / 1000)));
}
function getUser(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const h = sha(token);
  const row = q(`SELECT s.expires, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(h);
  if (!row) return null;
  if (row.expires < now() || row.disabled) { q("DELETE FROM sessions WHERE token_hash=?").run(h); return null; }
  // slide the expiry forward when more than a day has passed
  const ms = SESSION_DAYS * 86400000;
  if (row.expires - now() < ms - 86400000) {
    q("UPDATE sessions SET expires=? WHERE token_hash=?").run(now() + ms, h);
    res.setHeader("Set-Cookie", cookieHeader(req, token, Math.floor(ms / 1000)));
  }
  row.token_hash = h;
  return row;
}
setInterval(() => { try { q("DELETE FROM sessions WHERE expires<?").run(now()); } catch {} }, 3600000).unref();

/* ---------------- login throttling ---------------- */
const fails = new Map();
function clientIp(req) {
  if (TRUST_PROXY && req.headers["cf-connecting-ip"]) return String(req.headers["cf-connecting-ip"]).trim(); // Cloudflare tunnel
  if (TRUST_PROXY && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  return req.socket.remoteAddress || "?";
}
function throttled(key) {
  const f = fails.get(key);
  if (!f) return false;
  if (now() - f.first > 15 * 60000) { fails.delete(key); return false; }
  return f.n >= 10;
}
function noteFail(key) {
  const f = fails.get(key);
  if (!f || now() - f.first > 15 * 60000) fails.set(key, { n: 1, first: now() }); else f.n++;
}

/* ---------------- http helpers ---------------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(data);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, "That upload is too large.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); } catch { throw new HttpError(400, "The request wasn't valid JSON."); }
}
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.display_name || u.username, isAdmin: !!u.is_admin, mustChange: !!u.must_change, acceptedTerms: !!u.accepted_terms });

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    // the offline helper (sw.js) runs under this policy too, and it fetches the spreadsheet reader and fonts to keep copies
    "connect-src 'self' https://api.open-meteo.com https://cdnjs.cloudflare.com https://fonts.googleapis.com https://fonts.gstatic.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
};

/* ---------------- data access ---------------- */
function canRead(user, loadId) {
  const L = q("SELECT owner_id FROM loads WHERE id=?").get(loadId);
  if (!L) return null;
  if (L.owner_id === user.id) return "owner";
  const s = q("SELECT 1 AS ok FROM load_shares WHERE load_id=? AND user_id=?").get(loadId, user.id);
  return s ? "shared" : null;
}
function deletePhotoFiles(rows) {
  for (const r of rows) { try { fs.unlinkSync(path.join(PHOTO_DIR, path.basename(r.file))); } catch {} }
}
function getDoc(uid, key) {
  const r = q("SELECT data FROM user_docs WHERE user_id=? AND key=?").get(uid, key);
  return r ? JSON.parse(r.data) : null;
}
function putDoc(uid, key, data) {
  q("INSERT INTO user_docs(user_id,key,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
    .run(uid, key, JSON.stringify(data), now());
}

/* ---------------- export ---------------- */
function collectUser(uid) {
  const user = q("SELECT id, username, display_name FROM users WHERE id=?").get(uid);
  const loads = q("SELECT id, data FROM loads WHERE owner_id=?").all(uid).map((r) => ({
    id: r.id, data: JSON.parse(r.data),
    sharedWith: q("SELECT u.display_name, u.username FROM load_shares s JOIN users u ON u.id=s.user_id WHERE s.load_id=?").all(r.id).map((u) => u.display_name || u.username),
  }));
  const photos = q("SELECT id, load_id, ladder_id, caption, file, w, h, measure, created_at FROM photos WHERE owner_id=? ORDER BY created_at").all(uid).map((r) => ({ ...r, measure: parseMeasure(r.measure) }));
  const tripPhotos = q("SELECT id, trip_id, caption, file, w, h, measure, created_at FROM trip_photos WHERE owner_id=? ORDER BY created_at").all(uid).map((r) => ({ ...r, measure: parseMeasure(r.measure) }));
  return { user, loads, photos, tripPhotos, brass: getDoc(uid, "brass"), calc: getDoc(uid, "calc"), rifles: getDoc(uid, "rifles"), components: getDoc(uid, "components"), trips: getDoc(uid, "trips"), ammo: getDoc(uid, "ammo"), notes: getDoc(uid, "notes"), prefs: getDoc(uid, "prefs") };
}
function sendGunExport(res, uid, kind) {
  const d = collectUser(uid);
  if (!d.user) throw new HttpError(404, "User not found.");
  d.gunPhotos = q("SELECT id, rifle_id, file, created_at FROM gun_photos WHERE owner_id=? ORDER BY created_at").all(uid);
  const safe = (d.user.username || "user").replace(/[^A-Za-z0-9._-]/g, "_");
  const n = new Date(), day = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  const buf = kind === "xlsx" ? gunsXlsx(d) : gunsPdf(d, (file) => { try { return fs.readFileSync(path.join(PHOTO_DIR, path.basename(file))); } catch { return null; } });
  res.writeHead(200, {
    "Content-Type": kind === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf",
    "Content-Disposition": `attachment; filename="RangeBook-guns-${safe}-${day}.${kind}"`,
    "Content-Length": buf.length, "Cache-Control": "no-store", ...SECURITY_HEADERS,
  });
  res.end(buf);
}
let BK = null; // backups and imports (backup.js), set up once the database helpers exist
function backups() { return BK || (BK = backupKit({ q, db, PHOTO_DIR, getDoc, putDoc, now, APP_VERSION, zip })); }
function sendExport(res, uid, kind) {
  const d = collectUser(uid);
  if (!d.user) throw new HttpError(404, "User not found.");
  if (kind === "zip") {
    const buf = backups().backupZip(uid);
    const safe = (d.user.username || "user").replace(/[^A-Za-z0-9._-]/g, "_");
    const n = new Date(), day = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="RangeBook-backup-${safe}-${day}.zip"`, "Content-Length": buf.length, "Cache-Control": "no-store", ...SECURITY_HEADERS });
    return res.end(buf);
  }
  if (kind === "xlsx") d.dataRows = backups().dataSheetRows(uid);
  const safe = (d.user.username || "user").replace(/[^A-Za-z0-9._-]/g, "_");
  const n = new Date(), day = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  const buf = kind === "xlsx" ? exportXlsx(d) : exportPdf(d, (file) => { try { return fs.readFileSync(path.join(PHOTO_DIR, path.basename(file))); } catch { return null; } });
  res.writeHead(200, {
    "Content-Type": kind === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf",
    "Content-Disposition": `attachment; filename="RangeBook-${safe}-${day}.${kind}"`,
    "Content-Length": buf.length, "Cache-Control": "no-store", ...SECURITY_HEADERS,
  });
  res.end(buf);
}

/* ---------------- routes ---------------- */
async function api(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  // CSRF: every state-changing call must come from our own page's fetch().
  if (method !== "GET" && method !== "HEAD" && req.headers["x-requested-with"] !== "rangebook")
    throw new HttpError(403, "Request blocked.");

  /* ---- public settings (for the sign-in page) ---- */
  if (p === "/api/public/config" && method === "GET") {
    const setup = needsSetup();
    return send(res, 200, { version: APP_VERSION, sourceUrl: SOURCE_URL, guestEnabled: !!getSetting("guestEnabled", false), setup, ...(setup ? { suggestedUser: process.env.ADMIN_USERNAME ? ADMIN_USERNAME : "" } : {}) });
  }
  /* ---- first-run setup: only while there are no accounts at all ---- */
  if (p === "/api/setup" && method === "POST") {
    const b = await readJson(req);
    if (!needsSetup()) throw new HttpError(409, "Range Book is already set up. Sign in instead.");
    const username = String(b.username || "").trim();
    if (!/^[A-Za-z0-9._@-]{2,40}$/.test(username)) throw new HttpError(400, "Usernames are 2–40 characters: letters, numbers, dot, dash, underscore or @.");
    const pw = String(b.password || "");
    const prob = passwordProblem(pw); if (prob) throw new HttpError(400, prob);
    const name = String(b.name || username).trim().slice(0, 80) || username;
    let uid;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!needsSetup()) throw new HttpError(409, "Range Book is already set up. Sign in instead.");
      uid = Number(q("INSERT INTO users(username,display_name,pass,is_admin,must_change,created_at) VALUES(?,?,?,1,0,?)").run(username, name, hashPassword(pw), now()).lastInsertRowid);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    console.log(` Range Book: admin account "${username}" created from the setup page.`);
    maybeImportSeed(uid, username);
    createSession(req, res, uid);
    return send(res, 200, { user: publicUser(q("SELECT * FROM users WHERE id=?").get(uid)) });
  }

  /* ---- auth ---- */
  if (p === "/api/login" && method === "POST") {
    const { username, password } = await readJson(req);
    const uname = String(username || "").trim();
    const key = clientIp(req) + "|" + uname.toLowerCase();
    if (throttled(key)) throw new HttpError(429, "Too many failed sign-ins. Wait 15 minutes and try again.");
    const u = q("SELECT * FROM users WHERE username=?").get(uname);
    const ok = verifyPassword(String(password || ""), u ? u.pass : DUMMY_HASH);
    if (!u || !ok || u.disabled) { noteFail(key); throw new HttpError(401, u && ok && u.disabled ? "This account is turned off. Ask the admin to turn it back on." : "Wrong username or password."); }
    fails.delete(key);
    q("UPDATE users SET last_login=? WHERE id=?").run(now(), u.id);
    createSession(req, res, u.id);
    return send(res, 200, { user: publicUser(u) });
  }
  if (p === "/api/logout" && method === "POST") {
    const token = parseCookies(req)[COOKIE];
    if (token) q("DELETE FROM sessions WHERE token_hash=?").run(sha(token));
    return send(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(req, "", 0) });
  }

  const user = getUser(req, res);
  if (!user) throw new HttpError(401, "Please sign in.");
  let m0;

  if (p === "/api/me" && method === "GET") return send(res, 200, { user: publicUser(user) });
  m0 = /^\/api\/targets\/([a-z0-9]+)\.pdf$/.exec(p);
  if (m0 && method === "GET") {
    const T = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, "targets.json"), "utf8"));
    const qp = (k, n) => String(url.searchParams.get(k) || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
    const fill = { load: qp("load", 60), date: qp("date", 24), dist: qp("dist", 8), gun: qp("gun", 40) };
    const pr = getDoc(user.id, "prefs");
    const buf = targetPdf(T, m0[1], fill.load || fill.date || fill.dist || fill.gun ? fill : null, pr && pr.units === "metric" ? "m" : "yd");
    if (!buf) throw new HttpError(404, "No such target.");
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="RangeBook-target-${m0[1]}.pdf"`, "Content-Length": buf.length, ...SECURITY_HEADERS });
    return res.end(buf);
  }
  if (p === "/api/me/accept-terms" && method === "POST") { q("UPDATE users SET accepted_terms=? WHERE id=?").run(now(), user.id); user.accepted_terms = now(); return send(res, 200, { user: publicUser(user) }); }
  if (p === "/api/me/password" && method === "POST") {
    const { current, next } = await readJson(req);
    if (!verifyPassword(String(current || ""), user.pass)) throw new HttpError(400, "Your current password isn't right.");
    const prob = passwordProblem(next); if (prob) throw new HttpError(400, prob);
    if (next === current) throw new HttpError(400, "Choose a password different from the current one.");
    q("UPDATE users SET pass=?, must_change=0 WHERE id=?").run(hashPassword(next), user.id);
    q("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").run(user.id, user.token_hash);
    return send(res, 200, { ok: true });
  }
  if (user.must_change) throw new HttpError(403, "Change your password to continue.");

  /* ---- export your own data ---- */
  const gx = /^\/api\/export\/guns\.(xlsx|pdf)$/.exec(p);
  if (gx && method === "GET") return sendGunExport(res, user.id, gx[1]);
  let ex = /^\/api\/export\.(xlsx|pdf)$/.exec(p);
  if (ex && method === "GET") return sendExport(res, user.id, ex[1]);
  if (p === "/api/backup.zip" && method === "GET") return sendExport(res, user.id, "zip");
  /* ---- import a backup or an Excel export into your own account (adds; skips what's already here) ---- */
  if (p === "/api/import" && method === "POST") {
    const buf = await readBody(req, 700 * 1024 * 1024);
    if (!buf.length) throw new HttpError(400, "Pick a file to import.");
    let r;
    try { r = backups().importInto(user.id, buf); } catch (e) { throw new HttpError(400, e && e.message ? e.message : "That file couldn't be imported."); }
    console.log(` Import into ${user.username}: ${r.kind}, ${r.loads.added} loads added, ${r.photos.added} photos added`);
    return send(res, 200, { ok: true, result: r });
  }

  /* ---- people directory (for sharing) ---- */
  if (p === "/api/users" && method === "GET") {
    const rows = q("SELECT id, username, display_name FROM users WHERE disabled=0 AND id<>? ORDER BY display_name COLLATE NOCASE").all(user.id);
    return send(res, 200, { users: rows.map((r) => ({ id: r.id, username: r.username, name: r.display_name || r.username })) });
  }

  /* ---- per-user documents: calculator state, brass notes ---- */
  let m = /^\/api\/doc\/(calc|brass|rifles|components|prefs|trips|ammo|notes)$/.exec(p);
  if (m) {
    if (method === "GET") return send(res, 200, { data: getDoc(user.id, m[1]) });
    if (method === "PUT") { const body = await readJson(req, 2 * 1024 * 1024); putDoc(user.id, m[1], body.data ?? null); return send(res, 200, { ok: true }); }
  }

  /* ---- loads ---- */
  if (p === "/api/loads" && method === "GET") {
    const own = q("SELECT id, data, updated_at FROM loads WHERE owner_id=?").all(user.id);
    const shares = q("SELECT ls.load_id, ls.user_id FROM load_shares ls JOIN loads l ON l.id=ls.load_id WHERE l.owner_id=?").all(user.id);
    const shareMap = {};
    for (const s of shares) (shareMap[s.load_id] ||= []).push(s.user_id);
    const shared = q(`SELECT l.id, l.data, l.updated_at, u.display_name, u.username, u.id AS owner_id
                      FROM load_shares s JOIN loads l ON l.id=s.load_id JOIN users u ON u.id=l.owner_id
                      WHERE s.user_id=? AND u.disabled=0`).all(user.id);
    const ph = {};
    const addPh = (r) => { const o = (ph[r.load_id] ||= { photoId: r.id, photoCount: 0 }); o.photoCount++; };
    q("SELECT load_id, id FROM photos WHERE owner_id=? ORDER BY created_at").all(user.id).forEach(addPh);
    q("SELECT p.load_id, p.id FROM photos p JOIN load_shares s ON s.load_id=p.load_id WHERE s.user_id=? ORDER BY p.created_at").all(user.id).forEach(addPh);
    const pinfo = (id) => ph[id] || { photoId: null, photoCount: 0 };
    return send(res, 200, {
      loads: [
        ...own.map((r) => ({ id: r.id, mine: true, data: JSON.parse(r.data), sharedWith: shareMap[r.id] || [], updatedAt: r.updated_at, ...pinfo(r.id) })),
        ...shared.map((r) => ({ id: r.id, mine: false, owner: { id: r.owner_id, name: r.display_name || r.username }, data: JSON.parse(r.data), updatedAt: r.updated_at, ...pinfo(r.id) })),
      ],
    });
  }
  m = /^\/api\/loads\/([^/]+)$/.exec(p);
  if (m) {
    const id = m[1];
    if (!ID_RE.test(id)) throw new HttpError(400, "Bad load id.");
    const row = q("SELECT owner_id FROM loads WHERE id=?").get(id);
    if (method === "PUT") {
      const body = await readJson(req, 2 * 1024 * 1024);
      if (!body.data || typeof body.data !== "object") throw new HttpError(400, "Missing load data.");
      if (row && row.owner_id !== user.id) throw new HttpError(403, "Only the owner can change this load.");
      const t = now();
      if (row) q("UPDATE loads SET data=?, updated_at=? WHERE id=?").run(JSON.stringify(body.data), t, id);
      else q("INSERT INTO loads(id,owner_id,data,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, user.id, JSON.stringify(body.data), t, t);
      return send(res, 200, { ok: true, updatedAt: t });
    }
    if (method === "DELETE") {
      if (!row) return send(res, 200, { ok: true });
      if (row.owner_id !== user.id) throw new HttpError(403, "Only the owner can delete this load.");
      deletePhotoFiles(q("SELECT file FROM photos WHERE load_id=?").all(id));
      q("DELETE FROM loads WHERE id=?").run(id);
      return send(res, 200, { ok: true });
    }
  }
  m = /^\/api\/loads\/([^/]+)\/shares$/.exec(p);
  if (m && method === "PUT") {
    const id = m[1];
    const row = q("SELECT owner_id FROM loads WHERE id=?").get(id);
    if (!row || row.owner_id !== user.id) throw new HttpError(403, "Only the owner can share this load.");
    const { userIds } = await readJson(req);
    const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number).filter((n) => Number.isInteger(n) && n !== user.id))];
    db.exec("BEGIN");
    try {
      q("DELETE FROM load_shares WHERE load_id=?").run(id);
      for (const uid of ids) if (q("SELECT 1 AS ok FROM users WHERE id=?").get(uid)) q("INSERT INTO load_shares(load_id,user_id) VALUES(?,?)").run(id, uid);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    return send(res, 200, { ok: true, sharedWith: q("SELECT user_id FROM load_shares WHERE load_id=?").all(id).map((r) => r.user_id) });
  }

  /* ---- photos ---- */
  m = /^\/api\/loads\/([^/]+)\/photos$/.exec(p);
  if (m) {
    const id = m[1];
    const access = canRead(user, id);
    if (method === "GET") {
      if (!access) return send(res, 200, { photos: [] });
      const rows = q("SELECT id, caption, w, h, measure, ladder_id, created_at FROM photos WHERE load_id=? ORDER BY created_at").all(id);
      return send(res, 200, { photos: rows.map((r) => ({ id: r.id, caption: r.caption, w: r.w, h: r.h, measure: parseMeasure(r.measure), ladderId: r.ladder_id || null, url: `/api/photos/${r.id}` })) });
    }
    if (method === "POST") {
      if (access !== "owner") throw new HttpError(403, "Only the owner can add photos to this load.");
      const body = await readJson(req, 15 * 1024 * 1024);
      const mm = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(body.data || "");
      if (!mm) throw new HttpError(400, "That isn't a JPEG, PNG or WebP image.");
      const buf = Buffer.from(mm[2], "base64");
      const pid = crypto.randomUUID(), file = `${pid}.${mm[1] === "jpeg" ? "jpg" : mm[1]}`;
      fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
      const lad = ladderIdOf(body.ladderId);
      q("INSERT INTO photos(id,load_id,owner_id,caption,file,w,h,created_at,ladder_id) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(pid, id, user.id, String(body.caption || "").slice(0, 500), file, body.w | 0 || null, body.h | 0 || null, now(), lad);
      return send(res, 200, { photo: { id: pid, caption: body.caption || "", w: body.w | 0 || null, h: body.h | 0 || null, measure: null, ladderId: lad, url: `/api/photos/${pid}` } });
    }
  }
  /* ---- factory loads people chose to share with everyone on this server ---- */
  if (p === "/api/sharedammo" && method === "GET") {
    const rows = q("SELECT s.id, s.owner_id, s.data, s.updated_at, u.display_name, u.username FROM shared_ammo s LEFT JOIN users u ON u.id=s.owner_id ORDER BY s.updated_at DESC").all();
    return send(res, 200, { ammo: rows.map((r) => ({ id: r.id, data: JSON.parse(r.data), by: r.display_name || r.username || "a former member", mine: r.owner_id != null && r.owner_id === user.id, at: r.updated_at })) });
  }
  m = /^\/api\/sharedammo\/([A-Za-z0-9_-]{1,80})$/.exec(p);
  if (m) {
    const row = q("SELECT * FROM shared_ammo WHERE id=?").get(m[1]);
    if (method === "PUT") {
      if (row && row.owner_id !== user.id) throw new HttpError(403, "Someone else shared this one.");
      const b = await readJson(req);
      const keep = ["mfr", "name", "cartridge", "bullet", "weight", "bc", "bcm", "dia", "boxVel", "testBarrel"], d = {};
      for (const k of keep) if (b.data && b.data[k] != null && b.data[k] !== "") d[k] = typeof b.data[k] === "number" ? b.data[k] : String(b.data[k]).slice(0, 120);
      if (!d.mfr && !d.name && !d.cartridge) throw new HttpError(400, "Fill in at least the maker and cartridge before sharing.");
      if (row) q("UPDATE shared_ammo SET data=?, updated_at=? WHERE id=?").run(JSON.stringify(d), now(), row.id);
      else q("INSERT INTO shared_ammo(id,owner_id,data,created_at,updated_at) VALUES(?,?,?,?,?)").run(m[1], user.id, JSON.stringify(d), now(), now());
      return send(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      if (!row) return send(res, 200, { ok: true });
      if (row.owner_id !== user.id && !user.is_admin) throw new HttpError(403, "Only the person who shared it or an admin can remove it.");
      q("DELETE FROM shared_ammo WHERE id=?").run(row.id);
      return send(res, 200, { ok: true });
    }
  }

  /* ---- ammo box photos: a photo of catalog ammo is shared with everyone; a photo of your own entry is private ---- */
  if (p === "/api/boxphotos" && method === "GET") {
    const rows = q("SELECT b.id, b.cat_item, b.ammo_id, b.owner_id, b.w, b.h, b.created_at, u.display_name, u.username FROM box_photos b LEFT JOIN users u ON u.id=b.owner_id WHERE b.cat_item IS NOT NULL OR b.owner_id=? OR b.ammo_id IN (SELECT id FROM shared_ammo) ORDER BY b.created_at DESC").all(user.id);
    return send(res, 200, { photos: rows.map((r) => ({ id: r.id, item: r.cat_item, ammo: r.cat_item ? null : r.ammo_id, w: r.w, h: r.h, at: r.created_at, by: r.display_name || r.username || "a former member", mine: r.owner_id != null && r.owner_id === user.id, url: `/api/photos/${r.id}` })) });
  }
  if (p === "/api/boxphotos" && method === "POST") {
    const body = await readJson(req, 4 * 1024 * 1024);
    const item = body.item ? String(body.item).slice(0, 40) : null, ammoId = body.ammo ? String(body.ammo).slice(0, 80) : null;
    if (!item && !ammoId) throw new HttpError(400, "Which ammo is this a photo of?");
    const mm = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(body.data || "");
    if (!mm) throw new HttpError(400, "That isn't a JPEG, PNG or WebP image.");
    const buf = Buffer.from(mm[2], "base64");
    const pid = crypto.randomUUID(), file = `${pid}.${mm[1] === "jpeg" ? "jpg" : mm[1]}`;
    fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
    q("INSERT INTO box_photos(id,cat_item,ammo_id,owner_id,file,w,h,created_at) VALUES(?,?,?,?,?,?,?,?)").run(pid, item, item ? null : ammoId, user.id, file, body.w | 0 || null, body.h | 0 || null, now());
    return send(res, 200, { photo: { id: pid, item, ammo: item ? null : ammoId, w: body.w | 0 || null, h: body.h | 0 || null, at: now(), by: user.display_name || user.username, mine: true, url: `/api/photos/${pid}` } });
  }
  m = /^\/api\/boxphotos\/([A-Za-z0-9-]{1,80})$/.exec(p);
  if (m && method === "DELETE") {
    const ph = q("SELECT * FROM box_photos WHERE id=?").get(m[1]);
    if (!ph) return send(res, 200, { ok: true });
    if (ph.owner_id !== user.id && !user.is_admin) throw new HttpError(403, "Only the person who added it or an admin can delete this photo.");
    deletePhotoFiles([ph]); q("DELETE FROM box_photos WHERE id=?").run(ph.id);
    return send(res, 200, { ok: true });
  }

  /* ---- gun photos: private to the person who owns the gun ---- */
  if (p === "/api/gunphotos" && method === "GET") {
    const rows = q("SELECT id, rifle_id, w, h, created_at FROM gun_photos WHERE owner_id=? ORDER BY created_at").all(user.id);
    return send(res, 200, { photos: rows.map((r) => ({ id: r.id, rifle: r.rifle_id, w: r.w, h: r.h, at: r.created_at, url: `/api/photos/${r.id}` })) });
  }
  if (p === "/api/gunphotos" && method === "POST") {
    const body = await readJson(req, 8 * 1024 * 1024);
    const rid = body.rifle ? String(body.rifle).slice(0, 80) : "";
    if (!rid) throw new HttpError(400, "Which gun is this a photo of?");
    const mm = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(body.data || "");
    if (!mm) throw new HttpError(400, "That isn't a JPEG, PNG or WebP image.");
    const buf = Buffer.from(mm[2], "base64");
    const pid = crypto.randomUUID(), file = `${pid}.${mm[1] === "jpeg" ? "jpg" : mm[1]}`;
    fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
    q("INSERT INTO gun_photos(id,rifle_id,owner_id,file,w,h,created_at) VALUES(?,?,?,?,?,?,?)").run(pid, rid, user.id, file, body.w | 0 || null, body.h | 0 || null, now());
    return send(res, 200, { photo: { id: pid, rifle: rid, w: body.w | 0 || null, h: body.h | 0 || null, at: now(), url: `/api/photos/${pid}` } });
  }
  m = /^\/api\/gunphotos\/([A-Za-z0-9-]{1,80})$/.exec(p);
  if (m && method === "DELETE") {
    const rows = q("SELECT file FROM gun_photos WHERE id=? AND owner_id=?").all(m[1], user.id);
    deletePhotoFiles(rows); q("DELETE FROM gun_photos WHERE id=? AND owner_id=?").run(m[1], user.id);
    return send(res, 200, { ok: true });
  }
  m = /^\/api\/rifles\/([A-Za-z0-9_-]{1,80})\/photos$/.exec(p);
  if (m && method === "DELETE") {
    const rows = q("SELECT file FROM gun_photos WHERE rifle_id=? AND owner_id=?").all(m[1], user.id);
    deletePhotoFiles(rows); q("DELETE FROM gun_photos WHERE rifle_id=? AND owner_id=?").run(m[1], user.id);
    return send(res, 200, { ok: true });
  }

  /* ---- range trip photos (private to their owner; trips themselves live in the "trips" doc) ---- */
  m = /^\/api\/trips\/([A-Za-z0-9_-]{1,80})\/report\.pdf$/.exec(p);
  if (m && method === "GET") {
    const doc = getDoc(user.id, "trips"), t = doc && Array.isArray(doc.trips) ? doc.trips.find((x) => x.id === m[1]) : null;
    if (!t) throw new HttpError(404, "That range trip isn't on the server yet. If you made it without a signal, open Range Book with a signal so it syncs, then try again.");
    const photos = q("SELECT id, caption, file, w, h, measure FROM trip_photos WHERE owner_id=? AND trip_id=? ORDER BY created_at").all(user.id, t.id).map((r) => ({ ...r, measure: parseMeasure(r.measure) }));
    const buf = tripReportPdf({ calc: getDoc(user.id, "calc"), rifles: getDoc(user.id, "rifles"), prefs: getDoc(user.id, "prefs") }, t, photos, (file) => { try { return fs.readFileSync(path.join(PHOTO_DIR, path.basename(file))); } catch { return null; } });
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="RangeBook-trip-${String(t.date || "undated").replace(/[^0-9-]/g, "")}.pdf"`, "Content-Length": buf.length, ...SECURITY_HEADERS });
    return res.end(buf);
  }
  m = /^\/api\/trips\/([A-Za-z0-9_-]{1,80})\/photos$/.exec(p);
  if (m) {
    const tid = m[1];
    if (method === "GET") {
      const rows = q("SELECT id, caption, w, h, measure, created_at FROM trip_photos WHERE owner_id=? AND trip_id=? ORDER BY created_at").all(user.id, tid);
      return send(res, 200, { photos: rows.map((r) => ({ id: r.id, caption: r.caption, w: r.w, h: r.h, measure: parseMeasure(r.measure), url: `/api/photos/${r.id}` })) });
    }
    if (method === "POST") {
      const body = await readJson(req, 15 * 1024 * 1024);
      const mm = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(body.data || "");
      if (!mm) throw new HttpError(400, "That isn't a JPEG, PNG or WebP image.");
      const buf = Buffer.from(mm[2], "base64");
      const pid = crypto.randomUUID(), file = `${pid}.${mm[1] === "jpeg" ? "jpg" : mm[1]}`;
      fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
      q("INSERT INTO trip_photos(id,trip_id,owner_id,caption,file,w,h,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(pid, tid, user.id, String(body.caption || "").slice(0, 500), file, body.w | 0 || null, body.h | 0 || null, now());
      return send(res, 200, { photo: { id: pid, caption: body.caption || "", w: body.w | 0 || null, h: body.h | 0 || null, measure: null, url: `/api/photos/${pid}` } });
    }
    if (method === "DELETE") {
      const rows = q("SELECT file FROM trip_photos WHERE owner_id=? AND trip_id=?").all(user.id, tid);
      deletePhotoFiles(rows); q("DELETE FROM trip_photos WHERE owner_id=? AND trip_id=?").run(user.id, tid);
      return send(res, 200, { ok: true });
    }
  }
  m = /^\/api\/photos\/([^/]+)$/.exec(p);
  if (m) {
    let ph = q("SELECT * FROM photos WHERE id=?").get(m[1]), table = "photos", access = null;
    if (ph) access = canRead(user, ph.load_id);
    else { ph = q("SELECT * FROM trip_photos WHERE id=? AND owner_id=?").get(m[1], user.id); table = "trip_photos"; if (ph) access = "owner"; }
    if (!ph) { const g = q("SELECT * FROM gun_photos WHERE id=? AND owner_id=?").get(m[1], user.id); if (g) { if (method !== "GET") throw new HttpError(400, "Use the gun photo controls for this one."); ph = g; table = "gun_photos"; access = "shared"; } }
    if (!ph) { const b = q("SELECT * FROM box_photos WHERE id=?").get(m[1]); if (b && (b.cat_item || b.owner_id === user.id || (b.ammo_id && q("SELECT 1 AS ok FROM shared_ammo WHERE id=?").get(b.ammo_id)))) { if (method !== "GET") throw new HttpError(400, "Use the box photo controls for this one."); ph = b; table = "box_photos"; access = "shared"; } }
    if (!ph || !access) throw new HttpError(404, "Photo not found.");
    if (method === "GET") {
      const fp = path.join(PHOTO_DIR, path.basename(ph.file));
      if (!fs.existsSync(fp)) throw new HttpError(404, "Photo file is missing.");
      const ext = path.extname(fp).slice(1);
      res.writeHead(200, { "Content-Type": ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg", "Cache-Control": "private, max-age=86400", ...SECURITY_HEADERS });
      return fs.createReadStream(fp).pipe(res);
    }
    if (access !== "owner") throw new HttpError(403, "Only the owner can change this photo.");
    if (method === "PATCH") {
      const b = await readJson(req);
      if ("caption" in b) q(`UPDATE ${table} SET caption=? WHERE id=?`).run(String(b.caption || "").slice(0, 500), ph.id);
      if ("ladderId" in b && table === "photos") q("UPDATE photos SET ladder_id=? WHERE id=?").run(ladderIdOf(b.ladderId), ph.id);
      if ("measure" in b) {
        let mtext = null;
        if (b.measure != null) {
          if (typeof b.measure !== "object" || Array.isArray(b.measure)) throw new HttpError(400, "Bad measurement.");
          mtext = JSON.stringify(b.measure);
          if (mtext.length > 50000) throw new HttpError(400, "That measurement has too many marks.");
        }
        q(`UPDATE ${table} SET measure=? WHERE id=?`).run(mtext, ph.id);
      }
      return send(res, 200, { ok: true });
    }
    if (method === "DELETE") { deletePhotoFiles([ph]); q(`DELETE FROM ${table} WHERE id=?`).run(ph.id); return send(res, 200, { ok: true }); }
  }

  /* ---- admin ---- */
  if (p.startsWith("/api/admin/")) {
    if (!user.is_admin) throw new HttpError(403, "Admins only.");
    if (p === "/api/admin/backups") {
      if (method === "POST") { const r = makeBackup(); if (!r.ok) throw new HttpError(500, "Backup failed: " + r.error); }
      return send(res, 200, { backups: listBackups(), keep: BACKUP_KEEP, hour: BACKUP_HOUR, lastError: lastBackupError });
    }
    if (p === "/api/admin/settings") {
      if (method === "PUT") { const b = await readJson(req); if ("guestEnabled" in b) setSetting("guestEnabled", !!b.guestEnabled); }
      return send(res, 200, { guestEnabled: !!getSetting("guestEnabled", false) });
    }
    if (p === "/api/admin/users" && method === "GET") {
      const rows = q(`SELECT u.id, u.username, u.display_name, u.is_admin, u.must_change, u.disabled, u.created_at, u.last_login,
                        (SELECT COUNT(*) FROM loads l WHERE l.owner_id=u.id) AS loads
                      FROM users u ORDER BY u.username COLLATE NOCASE`).all();
      return send(res, 200, { users: rows.map((r) => ({ id: r.id, username: r.username, name: r.display_name, isAdmin: !!r.is_admin, mustChange: !!r.must_change, disabled: !!r.disabled, createdAt: r.created_at, lastLogin: r.last_login, loads: r.loads, isMe: r.id === user.id })) });
    }
    if (p === "/api/admin/users" && method === "POST") {
      const b = await readJson(req);
      const username = String(b.username || "").trim();
      if (!/^[A-Za-z0-9._@-]{2,40}$/.test(username)) throw new HttpError(400, "Usernames are 2–40 characters: letters, numbers, dot, dash, underscore or @.");
      if (q("SELECT 1 AS ok FROM users WHERE username=?").get(username)) throw new HttpError(409, "That username is already taken.");
      const pw = b.password ? String(b.password) : tempPassword();
      const prob = passwordProblem(pw); if (prob) throw new HttpError(400, prob);
      const info = q("INSERT INTO users(username,display_name,pass,is_admin,must_change,created_at) VALUES(?,?,?,?,1,?)")
        .run(username, String(b.name || username).trim().slice(0, 80), hashPassword(pw), b.isAdmin ? 1 : 0, now());
      return send(res, 200, { id: Number(info.lastInsertRowid), username, tempPassword: pw });
    }
    const ax = /^\/api\/admin\/users\/(\d+)\/export\.(xlsx|pdf|zip)$/.exec(p);
    if (ax && method === "GET") return sendExport(res, +ax[1], ax[2]);
    m = /^\/api\/admin\/users\/(\d+)(\/reset-password)?$/.exec(p);
    if (m) {
      const id = +m[1];
      const target = q("SELECT * FROM users WHERE id=?").get(id);
      if (!target) throw new HttpError(404, "User not found.");
      const otherAdmins = q("SELECT COUNT(*) AS n FROM users WHERE is_admin=1 AND disabled=0 AND id<>?").get(id).n;
      if (m[2] && method === "POST") {
        const b = await readJson(req);
        const pw = b.password ? String(b.password) : tempPassword();
        const prob = passwordProblem(pw); if (prob) throw new HttpError(400, prob);
        q("UPDATE users SET pass=?, must_change=1 WHERE id=?").run(hashPassword(pw), id);
        q("DELETE FROM sessions WHERE user_id=?").run(id);
        return send(res, 200, { tempPassword: pw });
      }
      if (!m[2] && method === "PATCH") {
        const b = await readJson(req);
        if ("isAdmin" in b) {
          if (!b.isAdmin && target.is_admin && !otherAdmins) throw new HttpError(400, "There has to be at least one admin.");
          q("UPDATE users SET is_admin=? WHERE id=?").run(b.isAdmin ? 1 : 0, id);
        }
        if ("disabled" in b) {
          if (id === user.id) throw new HttpError(400, "You can't turn off your own account.");
          q("UPDATE users SET disabled=? WHERE id=?").run(b.disabled ? 1 : 0, id);
          if (b.disabled) q("DELETE FROM sessions WHERE user_id=?").run(id);
        }
        if ("name" in b) q("UPDATE users SET display_name=? WHERE id=?").run(String(b.name || "").trim().slice(0, 80), id);
        return send(res, 200, { ok: true });
      }
      if (!m[2] && method === "DELETE") {
        if (id === user.id) throw new HttpError(400, "You can't delete your own account.");
        if (target.is_admin && !otherAdmins) throw new HttpError(400, "There has to be at least one admin.");
        deletePhotoFiles(q("SELECT file FROM photos WHERE owner_id=?").all(id));
        deletePhotoFiles(q("SELECT file FROM trip_photos WHERE owner_id=?").all(id));
        deletePhotoFiles(q("SELECT file FROM gun_photos WHERE owner_id=?").all(id));
        // private box photos go with the account; photos of catalog loads and of loads they shared stay for everyone
        const privBox = "owner_id=? AND cat_item IS NULL AND (ammo_id IS NULL OR ammo_id NOT IN (SELECT id FROM shared_ammo))";
        deletePhotoFiles(q("SELECT file FROM box_photos WHERE " + privBox).all(id));
        q("DELETE FROM box_photos WHERE " + privBox).run(id);
        q("UPDATE box_photos SET owner_id=NULL WHERE owner_id=?").run(id);
        q("UPDATE shared_ammo SET owner_id=NULL WHERE owner_id=?").run(id);
        q("DELETE FROM users WHERE id=?").run(id);
        return send(res, 200, { ok: true });
      }
    }
  }
  throw new HttpError(404, "Not found.");
}

/* ---------------- static files ---------------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };
/* Text files (the app page, scripts, JSON) are sent compressed, about a quarter of the size: the browser unpacks them
   to exactly the same bytes. Each file is packed once and kept in memory until it changes on disk; gzip is ready at
   once, and the smaller brotli copy is made in the background and used from then on. Images are already compressed. */
const PACK = new Set([".html", ".js", ".css", ".json", ".svg", ".webmanifest"]);
const packed = new Map();
function packFile(fp, rel, st, cb) {
  const hit = packed.get(fp);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return cb(null, hit);
  fs.readFile(fp, (err, buf) => {
    if (err) return cb(err);
    // stamp the running version into the page so an open app can tell when the server has a newer one
    if (rel === "/index.html") buf = Buffer.from(buf.toString("utf8").replace("__RB_VERSION__", APP_VERSION));
    const e = { mtime: st.mtimeMs, size: st.size, raw: buf, gz: null, br: null };
    if (PACK.has(path.extname(fp)) && buf.length > 1024) {
      e.gz = zlib.gzipSync(buf, { level: 9 });
      zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }, (e2, br) => { if (!e2) e.br = br; });
    }
    packed.set(fp, e);
    cb(null, e);
  });
}
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || !path.extname(rel)) rel = "/index.html";
  const fp = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!fp.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, "Not found");
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found");
    const head = { "Content-Type": TYPES[path.extname(fp)] || "application/octet-stream", "Cache-Control": rel === "/index.html" || rel === "/sw.js" ? "no-cache" : "public, max-age=3600", ...SECURITY_HEADERS };
    if (!PACK.has(path.extname(fp)) && rel !== "/index.html") { res.writeHead(200, head); return fs.createReadStream(fp).pipe(res); }
    packFile(fp, rel, st, (e2, e) => {
      if (e2) return send(res, 500, "Couldn't read the file");
      const ae = String(req.headers["accept-encoding"] || "");
      let body = e.raw;
      if (e.br && /\bbr\b/.test(ae)) { body = e.br; head["Content-Encoding"] = "br"; }
      else if (e.gz && /\bgzip\b/.test(ae)) { body = e.gz; head["Content-Encoding"] = "gzip"; }
      if (e.gz) head["Vary"] = "Accept-Encoding";
      head["Content-Length"] = body.length;
      res.writeHead(200, head);
      res.end(req.method === "HEAD" ? undefined : body);
    });
  });
}

/* ---------------- server ---------------- */
firstRun();
// Locked out? Start the container once with RESET_ADMIN_PASSWORD set, sign in, then remove the variable.
if (process.env.RESET_ADMIN_PASSWORD) {
  const prob = passwordProblem(process.env.RESET_ADMIN_PASSWORD);
  const u = q("SELECT id FROM users WHERE username=?").get(ADMIN_USERNAME);
  if (prob) console.log("RESET_ADMIN_PASSWORD ignored: " + prob);
  else if (!u) console.log(`RESET_ADMIN_PASSWORD ignored: no user named "${ADMIN_USERNAME}".`);
  else {
    q("UPDATE users SET pass=?, must_change=1, disabled=0, is_admin=1 WHERE id=?").run(hashPassword(process.env.RESET_ADMIN_PASSWORD), u.id);
    q("DELETE FROM sessions WHERE user_id=?").run(u.id);
    console.log(`Password for "${ADMIN_USERNAME}" was reset from RESET_ADMIN_PASSWORD. Remove that setting now.`);
  }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/healthz") return send(res, 200, "ok");
    if (url.pathname.startsWith("/api/")) {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      return await api(req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    return serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "Something went wrong on the server." });
  }
});
/* ---------------- nightly backups ----------------
   One folder per day in DATA_DIR/backups: a consistent copy of the database
   (VACUUM INTO) plus the photos (hard links when possible, so they take no extra space). */
let lastBackupError = null;
function localDate(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function listBackups() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)); } catch {}
  return names.sort().reverse().map((n) => {
    const dir = path.join(BACKUP_DIR, n); let size = 0, photos = 0, at = null;
    try { const st = fs.statSync(path.join(dir, "rangebook.db")); size = st.size; at = st.mtime.toISOString(); } catch {}
    try { photos = fs.readdirSync(path.join(dir, "photos")).length; } catch {}
    return { name: n, at, dbBytes: size, photos };
  }).filter((b) => b.at);
}
function makeBackup() {
  const name = localDate(), dir = path.join(BACKUP_DIR, name), tmp = path.join(BACKUP_DIR, "." + name + "-" + process.pid);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, "photos"), { recursive: true });
    db.exec(`VACUUM INTO '${path.join(tmp, "rangebook.db").replace(/'/g, "''")}'`);
    for (const f of fs.readdirSync(PHOTO_DIR)) {
      const src = path.join(PHOTO_DIR, f), dst = path.join(tmp, "photos", f);
      try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    const all = listBackups();
    for (const b of all.slice(BACKUP_KEEP)) fs.rmSync(path.join(BACKUP_DIR, b.name), { recursive: true, force: true });
    lastBackupError = null;
    console.log(`Backup saved: backups/${name}`);
    return { ok: true, name };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    lastBackupError = { at: new Date().toISOString(), message: String(e.message || e) };
    console.error("Backup failed:", e);
    return { ok: false, error: lastBackupError.message };
  }
}
function scheduleBackups() {
  if (/^(0|false|no|off)$/i.test(process.env.BACKUPS || "")) { console.log("Nightly backups are turned off."); return; }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!fs.existsSync(path.join(BACKUP_DIR, localDate(), "rangebook.db"))) makeBackup();
  const next = () => {
    const n = new Date(), t = new Date(n.getFullYear(), n.getMonth(), n.getDate(), BACKUP_HOUR, 0, 0);
    if (t <= n) t.setDate(t.getDate() + 1);
    setTimeout(() => { makeBackup(); next(); }, Math.min(t - n, 2 ** 31 - 1));
  };
  next();
}
scheduleBackups();

server.listen(PORT, () => {
  console.log(`Range Book ${APP_VERSION} listening on port ${PORT} (data in ${DATA_DIR})`);
  // pack the app page now, so the first visitor already gets the small copy
  const ip = path.join(PUBLIC_DIR, "index.html");
  fs.stat(ip, (err, st) => { if (!err) packFile(ip, "/index.html", st, () => {}); });
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); try { db.close(); } catch {} process.exit(0); });

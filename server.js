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
const { exportXlsx, exportPdf, targetPdf, tripReportPdf, gunsXlsx, gunsPdf, zip, buildXlsx } = require("./export.js");
const backupKit = require("./backup.js");
const MERGE = require("./merge.js");

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
CREATE TABLE IF NOT EXISTS vault_keys(
  owner_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_docs(
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  meta TEXT NOT NULL,
  file TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gear_files(
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  file TEXT NOT NULL,
  size INTEGER NOT NULL,
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
// sharing ammo with everyone (box photos of catalog ammo, loads people share, and their photos) is on unless the
// admin turns it off (Admin › Community sharing, 2.42.5), e.g. on a big public server
const shareBoxPhotos = () => getSetting("shareAmmo", true) !== false;
/* The super admin (2.42.7): the first admin account, or whoever it's been handed to. Other admins can't delete, turn off,
   demote, rename, export or reset the password of this account, and only it can hand the role on, download the whole
   site or restore it. Stored as the setting "superAdmin" (a user id); if that's missing or no longer an active admin
   (an older Range Book, a restore), it goes to the oldest active admin. */
function superId() {
  const v = getSetting("superAdmin", null);
  if (v != null && q("SELECT 1 AS ok FROM users WHERE id=? AND is_admin=1 AND disabled=0").get(v)) return v;
  const r = q("SELECT id FROM users WHERE is_admin=1 AND disabled=0 ORDER BY created_at, id LIMIT 1").get();
  if (r) { setSetting("superAdmin", r.id); return r.id; }
  return null;
}
const isSuper = (u) => !!u && u.id === superId();
const getSetting = (k, d) => { const r = q("SELECT value FROM settings WHERE key=?").get(k); return r ? JSON.parse(r.value) : d; };
const setSetting = (k, v) => q("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, JSON.stringify(v));
const now = () => Date.now();
// Live target remote sessions (in memory): id -> { uid, device, frame, state, cmds, waiters, ... }
const REMOTE = new Map();
function remoteEnd(id) { const r = REMOTE.get(id); if (!r) return; REMOTE.delete(id); for (const w of r.waiters) w(); r.waiters.clear(); }
setInterval(() => { const t = Date.now(); for (const r of REMOTE.values()) if (t - r.last > 900000) remoteEnd(r.id); }, 30000).unref();

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
  setSetting("superAdmin", adminId);
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
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.display_name || u.username, isAdmin: !!u.is_admin, isSuper: !!u.is_admin && isSuper(u), mustChange: !!u.must_change, acceptedTerms: !!u.accepted_terms });

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
    "connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com https://nominatim.openstreetmap.org https://cdnjs.cloudflare.com https://fonts.googleapis.com https://fonts.gstatic.com",
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
function getDocRow(uid, key) {
  const r = q("SELECT data, updated_at FROM user_docs WHERE user_id=? AND key=?").get(uid, key);
  return r ? { data: JSON.parse(r.data), at: r.updated_at } : null;
}
function getDoc(uid, key) {
  const r = q("SELECT data FROM user_docs WHERE user_id=? AND key=?").get(uid, key);
  return r ? JSON.parse(r.data) : null;
}
/* Saves from several devices are merged, keeping the newest edit to each piece (see merge.js).
   edit_times remembers when each piece of a document was last changed. */
db.exec(`CREATE TABLE IF NOT EXISTS edit_times(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  times TEXT NOT NULL,
  PRIMARY KEY(user_id, key)
)`);
const KEEP_TIMES = 90 * 24 * 3600 * 1000;
function getTimes(uid, key) {
  const r = q("SELECT times FROM edit_times WHERE user_id=? AND key=?").get(uid, key);
  try { return r ? JSON.parse(r.times) || {} : {}; } catch { return {}; }
}
function putTimes(uid, key, times) {
  const old = now() - KEEP_TIMES;
  for (const k of Object.keys(times)) if (!(Number(times[k]) > old)) delete times[k];
  q("INSERT INTO edit_times(user_id,key,times) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET times=excluded.times").run(uid, key, JSON.stringify(times));
}
// what to save for a PUT: this device's version merged with what the server has now
function mergeSave(uid, timesKey, body, theirs, theirsAt) {
  const mine = body.data ?? null, at = now();
  const t0 = Number(body.t) > 0 ? Math.min(Number(body.t), at) : at; // when the change was made (a queued offline change sends its own time)
  const ct = body.times && typeof body.times === "object" ? body.times : null;
  const tMine = (p) => Math.min(MERGE.timeAt(ct, p, t0), at);
  const st = getTimes(uid, timesKey);
  let data = mine;
  if (body.base !== undefined && theirs != null && mine != null)
    data = MERGE.merge3({ base: body.base, seen: body.seen, hasSeen: "seen" in body, mine, theirs, tMine, tTheirs: (p) => MERGE.timeAt(st, p, theirsAt || 0) });
  const changed = MERGE.diffPaths(theirs, data);
  if (changed.length) { for (const p of changed) st[p] = tMine(p); putTimes(uid, timesKey, st); }
  return { data, merged: !MERGE.eq(data, mine) };
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
  return { user, loads, photos, tripPhotos, brass: getDoc(uid, "brass"), calc: getDoc(uid, "calc"), rifles: getDoc(uid, "rifles"), components: getDoc(uid, "components"), trips: getDoc(uid, "trips"), ammo: getDoc(uid, "ammo"), notes: getDoc(uid, "notes"), prefs: getDoc(uid, "prefs"), training: getDoc(uid, "training") };
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
      setSetting("superAdmin", uid);
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

  // a printable target (no personal data in it): signed-in people, and guests when guest mode is on (2.41.3)
  {
    const mt = /^\/api\/targets\/([a-z0-9]+)\.pdf$/.exec(p);
    if (mt && method === "GET") {
      const who = getUser(req, res);
      if (!who && !getSetting("guestEnabled", false)) throw new HttpError(401, "Please sign in.");
      const T = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, "targets.json"), "utf8"));
      const qp = (k, n) => String(url.searchParams.get(k) || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
      const fill = { load: qp("load", 60), date: qp("date", 24), dist: qp("dist", 8), gun: qp("gun", 40) };
      // yards or metres: the page says which (a guest has no saved settings), otherwise your setting
      const pr = who ? getDoc(who.id, "prefs") : null, uq = qp("u", 2);
      const units = uq === "m" ? "m" : uq === "yd" ? "yd" : pr && pr.units === "metric" ? "m" : "yd";
      const buf = targetPdf(T, mt[1], fill.load || fill.date || fill.dist || fill.gun ? fill : null, units);
      if (!buf) throw new HttpError(404, "No such target.");
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="RangeBook-target-${mt[1]}.pdf"`, "Content-Length": buf.length, ...SECURITY_HEADERS });
      return res.end(buf);
    }
  }

  /* ---- the whole site for a scheduled download (2.42.10): another computer (a home server) fetches the site backup with
     the backup key in an "Authorization: Bearer" header instead of signing in. Only a hash of the key is kept. ---- */
  if (p === "/api/backup/site.tar.gz" && (method === "GET" || method === "HEAD")) {
    const ip = clientIp(req), fk = "bk:" + ip;
    if (throttled(fk)) throw new HttpError(429, "Too many wrong keys. Try again in 15 minutes.");
    const k = getSetting("backupKey", null), auth = String(req.headers.authorization || "");
    const tok = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
    const ok = !!(k && k.hash && tok) && crypto.timingSafeEqual(Buffer.from(sha256hex(tok)), Buffer.from(k.hash));
    if (!ok) { noteFail(fk); throw new HttpError(401, k ? "That backup key isn't right." : "Scheduled backups are turned off on this Range Book."); }
    setSetting("backupKeyUsed", { at: now(), ip });
    console.log(`Site backup downloaded with the backup key (from ${ip}).`);
    if (method === "HEAD") return send(res, 200, "");
    return sendSiteBackup(res);
  }

  const user = getUser(req, res);
  if (!user) throw new HttpError(401, "Please sign in.");
  let m0;

  if (p === "/api/me" && method === "GET") return send(res, 200, { user: publicUser(user) });
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

  /* ---- Import from a spreadsheet: read any .xlsx into rows (the app matches and adds them itself) ---- */
  if (p === "/api/sheet/read" && method === "POST") {
    const buf = await readBody(req, 25 * 1024 * 1024);
    if (!buf.length) throw new HttpError(400, "Pick a file to import.");
    let sheets;
    try { sheets = backupKit.readSheets(buf); } catch (e) { throw new HttpError(400, e && e.message ? e.message : "That file couldn't be read."); }
    return send(res, 200, { sheets });
  }
  /* ---- a spreadsheet the app lays out (the import template): tabs, columns, rows and drop-down lists ---- */
  if (p === "/api/sheet/build" && method === "POST") {
    const b = await readJson(req, 8 * 1024 * 1024);
    const str = (v, n) => String(v == null ? "" : v).slice(0, n);
    const cell = (c) => (c == null ? null : typeof c === "number" ? (isFinite(c) ? c : null) : typeof c === "object" ? ("date" in c ? { date: str(c.date, 10) } : { v: typeof c.v === "number" ? c.v : str(c.v, 32000), s: [0, 3, 4, 5, 6, 7].includes(c.s) ? c.s : 0 }) : str(c, 32000));
    if (!Array.isArray(b.sheets) || !b.sheets.length || b.sheets.length > 30) throw new HttpError(400, "Nothing to build.");
    const sheets = b.sheets.map((sh, i) => ({
      name: str(sh.name, 31).replace(/[\\/?*\[\]:]/g, " ") || "Sheet" + (i + 1), hidden: !!sh.hidden, noFilter: !!sh.noFilter, selected: i === 0,
      cols: (Array.isArray(sh.cols) ? sh.cols : []).slice(0, 60).map((c) => ({ h: str(c.h, 200), w: Math.min(120, Math.max(4, +c.w || 14)), s: [0, 3, 4, 5, 7].includes(c.s) ? c.s : 0 })),
      rows: (Array.isArray(sh.rows) ? sh.rows : []).slice(0, 5000).map((r) => (Array.isArray(r) ? r.slice(0, 60).map(cell) : [])),
      validations: (Array.isArray(sh.validations) ? sh.validations : []).slice(0, 60).map((v) => ({ col: Math.max(0, v.col | 0), src: Array.isArray(v.src) ? v.src.slice(0, 40).map((x) => str(x, 60)) : str(v.src, 120), to: Math.min(5000, Math.max(2, v.to | 0 || 1000)), prompt: Array.isArray(v.prompt) ? [str(v.prompt[0], 32), str(v.prompt[1], 255)] : null })),
    })).filter((sh) => sh.cols.length);
    if (!sheets.length) throw new HttpError(400, "Nothing to build.");
    const buf = buildXlsx(sheets), fname = str(b.filename, 80).replace(/[^A-Za-z0-9 ._-]/g, "_") || "RangeBook.xlsx";
    res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${fname}"`, "Content-Length": buf.length, "Cache-Control": "no-store", ...SECURITY_HEADERS });
    return res.end(buf);
  }

  /* ---- people directory (for sharing) ---- */
  if (p === "/api/users" && method === "GET") {
    const rows = q("SELECT id, username, display_name FROM users WHERE disabled=0 AND id<>? ORDER BY display_name COLLATE NOCASE").all(user.id);
    return send(res, 200, { users: rows.map((r) => ({ id: r.id, username: r.username, name: r.display_name || r.username })) });
  }

  /* ---- per-user documents: calculator state, brass notes ---- */
  let m = /^\/api\/doc\/(calc|brass|rifles|components|prefs|trips|ammo|notes|training)$/.exec(p);
  if (m) {
    if (method === "GET") return send(res, 200, { data: getDoc(user.id, m[1]) });
    if (method === "PUT") {
      const body = await readJson(req, 8 * 1024 * 1024), row = getDocRow(user.id, m[1]);
      const r = mergeSave(user.id, "doc:" + m[1], body, row ? row.data : null, row ? row.at : 0);
      putDoc(user.id, m[1], r.data);
      return send(res, 200, { ok: true, merged: r.merged });
    }
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
    const row = q("SELECT owner_id, data, updated_at FROM loads WHERE id=?").get(id);
    if (method === "PUT") {
      const body = await readJson(req, 8 * 1024 * 1024);
      if (!body.data || typeof body.data !== "object") throw new HttpError(400, "Missing load data.");
      if (row && row.owner_id !== user.id) throw new HttpError(403, "Only the owner can change this load.");
      let theirs = null;if (row) { try { theirs = JSON.parse(row.data); } catch {} }
      const r = mergeSave(user.id, "load:" + id, body, theirs, row ? row.updated_at : 0);
      const t = now();
      if (row) q("UPDATE loads SET data=?, updated_at=? WHERE id=?").run(JSON.stringify(r.data), t, id);
      else q("INSERT INTO loads(id,owner_id,data,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, user.id, JSON.stringify(r.data), t, t);
      return send(res, 200, { ok: true, updatedAt: t, merged: r.merged });
    }
    if (method === "DELETE") {
      if (!row) return send(res, 200, { ok: true });
      if (row.owner_id !== user.id) throw new HttpError(403, "Only the owner can delete this load.");
      deletePhotoFiles(q("SELECT file FROM photos WHERE load_id=?").all(id));
      q("DELETE FROM loads WHERE id=?").run(id);
      q("DELETE FROM edit_times WHERE user_id=? AND key=?").run(user.id, "load:" + id);
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
    if (!shareBoxPhotos() && !(user.is_admin && url.searchParams.get("all") === "1")) return send(res, 200, { shared: false, ammo: [] });
    const rows = q("SELECT s.id, s.owner_id, s.data, s.updated_at, u.display_name, u.username FROM shared_ammo s LEFT JOIN users u ON u.id=s.owner_id ORDER BY s.updated_at DESC").all();
    return send(res, 200, { shared: shareBoxPhotos(), ammo: rows.map((r) => ({ id: r.id, data: JSON.parse(r.data), by: r.display_name || r.username || "a former member", mine: r.owner_id != null && r.owner_id === user.id, at: r.updated_at })) });
  }
  m = /^\/api\/sharedammo\/([A-Za-z0-9_-]{1,80})$/.exec(p);
  if (m) {
    const row = q("SELECT * FROM shared_ammo WHERE id=?").get(m[1]);
    if (method === "PUT") {
      if (!shareBoxPhotos()) throw new HttpError(403, "Sharing loads with everyone is turned off on this Range Book.");
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

  /* ---- ammo box photos: a photo of catalog ammo is shared with everyone; a photo of your own entry is private ----
     The admin can turn sharing off (Admin › Community sharing, 2.42.5; it covers shared loads too): then everyone sees only their own box photos,
     new ones are saved private (even for catalog ammo), and ?all=1 still lists the shared ones for an admin to clean up. */
  if (p === "/api/boxphotos" && method === "GET") {
    const sharing = shareBoxPhotos(), adminAll = user.is_admin && url.searchParams.get("all") === "1";
    const rows = sharing || adminAll
      ? q("SELECT b.id, b.cat_item, b.ammo_id, b.owner_id, b.w, b.h, b.created_at, u.display_name, u.username FROM box_photos b LEFT JOIN users u ON u.id=b.owner_id WHERE b.cat_item IS NOT NULL OR b.owner_id=? OR b.ammo_id IN (SELECT id FROM shared_ammo) ORDER BY b.created_at DESC").all(user.id)
      : q("SELECT b.id, b.cat_item, b.ammo_id, b.owner_id, b.w, b.h, b.created_at, u.display_name, u.username FROM box_photos b LEFT JOIN users u ON u.id=b.owner_id WHERE b.owner_id=? ORDER BY b.created_at DESC").all(user.id);
    return send(res, 200, { shared: sharing, photos: rows.map((r) => ({ id: r.id, item: r.cat_item, ammo: r.cat_item ? null : r.ammo_id, w: r.w, h: r.h, at: r.created_at, by: r.display_name || r.username || "a former member", mine: r.owner_id != null && r.owner_id === user.id, url: `/api/photos/${r.id}` })) });
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
    // with sharing off, a catalog box photo is kept as a private photo of your own ammo entry
    const catItem = shareBoxPhotos() ? item : null, ownAmmo = catItem ? null : (ammoId || null);
    if (!catItem && !ownAmmo) throw new HttpError(400, "Which ammo is this a photo of?");
    q("INSERT INTO box_photos(id,cat_item,ammo_id,owner_id,file,w,h,created_at) VALUES(?,?,?,?,?,?,?,?)").run(pid, catItem, ownAmmo, user.id, file, body.w | 0 || null, body.h | 0 || null, now());
    return send(res, 200, { photo: { id: pid, item: catItem, ammo: ownAmmo, w: body.w | 0 || null, h: body.h | 0 || null, at: now(), by: user.display_name || user.username, mine: true, url: `/api/photos/${pid}` } });
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

  /* ---- document vault (2.20): documents are encrypted in the browser with a key only the owner's vault passphrase can
     unlock. The server stores the wrapped key and the encrypted files as they arrive and can't read either; it only
     checks sizes and ownership. Files sit in the photo folder as <uuid>.rbv so the nightly backup keeps them, but they
     are never served by /api/photos (they aren't in any photo table). ---- */
  if (p === "/api/vault" && method === "GET") {
    const k = q("SELECT data FROM vault_keys WHERE owner_id=?").get(user.id);
    const docs = q("SELECT id, item_id, meta, size, created_at FROM vault_docs WHERE owner_id=? ORDER BY created_at").all(user.id);
    res.setHeader("Cache-Control", "no-store");
    return send(res, 200, { key: k ? JSON.parse(k.data) : null, docs: docs.map((r) => ({ id: r.id, item: r.item_id, meta: JSON.parse(r.meta), size: r.size, at: r.created_at })) });
  }
  if (p === "/api/vault/key" && method === "PUT") {
    const body = await readJson(req, 16 * 1024), k = body && body.key;
    const b64 = (v, max) => typeof v === "string" && v.length <= max && /^[A-Za-z0-9+/=]+$/.test(v);
    if (!k || k.v !== 1 || !b64(k.salt, 64) || !b64(k.iv, 32) || !b64(k.ct, 256) || !(Number.isInteger(k.iter) && k.iter >= 100000 && k.iter <= 10000000))
      throw new HttpError(400, "That vault key isn't valid.");
    const had = q("SELECT 1 AS x FROM vault_keys WHERE owner_id=?").get(user.id);
    // replacing a key is only for a new passphrase on the same vault; the browser sends the key it unlocked with
    if (had && !body.replace) throw new HttpError(409, "There's already a vault on this account.");
    q("INSERT INTO vault_keys(owner_id,data,updated_at) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
      .run(user.id, JSON.stringify({ v: 1, salt: k.salt, iter: k.iter, iv: k.iv, ct: k.ct }), now());
    return send(res, 200, { ok: true });
  }
  if (p === "/api/vault/docs" && method === "POST") {
    if (!q("SELECT 1 AS x FROM vault_keys WHERE owner_id=?").get(user.id)) throw new HttpError(400, "Set up the vault first.");
    const item = String(url.searchParams.get("item") || "");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(item)) throw new HttpError(400, "Which item is this document for?");
    let meta = null;
    try { meta = JSON.parse(Buffer.from(String(req.headers["x-vault-meta"] || ""), "base64").toString("utf8")); } catch { meta = null; }
    if (!meta || typeof meta.iv !== "string" || typeof meta.ct !== "string" || meta.iv.length > 32 || meta.ct.length > 2048) throw new HttpError(400, "That document's details aren't valid.");
    const buf = await readBody(req, 20 * 1024 * 1024);
    if (buf.length < 29) throw new HttpError(400, "That document is empty.");
    const id = crypto.randomUUID(), file = id + ".rbv";
    fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
    q("INSERT INTO vault_docs(id,owner_id,item_id,meta,file,size,created_at) VALUES(?,?,?,?,?,?,?)").run(id, user.id, item, JSON.stringify({ iv: meta.iv, ct: meta.ct }), file, buf.length, now());
    return send(res, 200, { doc: { id, item, meta: { iv: meta.iv, ct: meta.ct }, size: buf.length, at: now() } });
  }
  m = /^\/api\/vault\/docs\/([A-Za-z0-9-]{1,80})$/.exec(p);
  if (m && method === "GET") {
    const r = q("SELECT file FROM vault_docs WHERE id=? AND owner_id=?").get(m[1], user.id);
    if (!r) throw new HttpError(404, "Not found.");
    let buf; try { buf = fs.readFileSync(path.join(PHOTO_DIR, path.basename(r.file))); } catch { throw new HttpError(404, "That document's file is missing."); }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": buf.length, "Cache-Control": "no-store", ...SECURITY_HEADERS });
    return res.end(buf);
  }
  if (m && method === "DELETE") {
    const rows = q("SELECT file FROM vault_docs WHERE id=? AND owner_id=?").all(m[1], user.id);
    deletePhotoFiles(rows); q("DELETE FROM vault_docs WHERE id=? AND owner_id=?").run(m[1], user.id);
    return send(res, 200, { ok: true });
  }

  /* ---- files on a gear note (2.27): PDFs and other documents, private to their owner and NOT encrypted (a locked note's
     files go in the vault instead). Stored in the photo folder as <uuid>.rbf. Only PDFs and pictures are shown in the
     browser; anything else is always downloaded, so an uploaded web page can't run here. ---- */
  if (p === "/api/files" && method === "GET") {
    const rows = q("SELECT id, item_id, name, type, size, created_at FROM gear_files WHERE owner_id=? ORDER BY created_at").all(user.id);
    res.setHeader("Cache-Control", "no-store");
    return send(res, 200, { files: rows.map((r) => ({ id: r.id, item: r.item_id, name: r.name, type: r.type, size: r.size, at: r.created_at })) });
  }
  if (p === "/api/files" && method === "POST") {
    const item = String(url.searchParams.get("item") || "");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(item)) throw new HttpError(400, "Which note is this file for?");
    let name = "file";
    try { name = Buffer.from(String(req.headers["x-file-name"] || ""), "base64").toString("utf8").replace(/[\u0000-\u001f\\/]/g, "_").slice(0, 160) || "file"; } catch { name = "file"; }
    const type = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].trim().toLowerCase().slice(0, 100);
    const buf = await readBody(req, 20 * 1024 * 1024);
    if (!buf.length) throw new HttpError(400, "That file is empty.");
    const id = crypto.randomUUID(), file = id + ".rbf";
    fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
    q("INSERT INTO gear_files(id,owner_id,item_id,name,type,file,size,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, user.id, item, name, type, file, buf.length, now());
    return send(res, 200, { file: { id, item, name, type, size: buf.length, at: now() } });
  }
  m = /^\/api\/files\/([A-Za-z0-9-]{1,80})$/.exec(p);
  if (m && method === "GET") {
    const r = q("SELECT name, type, file FROM gear_files WHERE id=? AND owner_id=?").get(m[1], user.id);
    if (!r) throw new HttpError(404, "Not found.");
    let buf; try { buf = fs.readFileSync(path.join(PHOTO_DIR, path.basename(r.file))); } catch { throw new HttpError(404, "That file is missing."); }
    const safe = /^(application\/pdf|image\/(jpeg|png|gif|webp|heic|heif)|text\/plain)$/.test(r.type);
    const dl = url.searchParams.get("dl") === "1" || !safe;
    res.writeHead(200, { "Content-Type": safe ? r.type : "application/octet-stream", "Content-Length": buf.length, "Cache-Control": "private, max-age=3600",
      "Content-Disposition": (dl ? "attachment" : "inline") + "; filename*=UTF-8''" + encodeURIComponent(r.name), ...SECURITY_HEADERS, "X-Content-Type-Options": "nosniff" });
    return res.end(buf);
  }
  if (m && method === "DELETE") {
    const rows = q("SELECT file FROM gear_files WHERE id=? AND owner_id=?").all(m[1], user.id);
    deletePhotoFiles(rows); q("DELETE FROM gear_files WHERE id=? AND owner_id=?").run(m[1], user.id);
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
  /* ---- Live target remote: the phone on the scope sends its screen and state here, another device signed in to the
     same account watches and sends taps back. Kept in memory only; nothing is saved. ---- */
  if (p === "/api/remote" && method === "GET") {
    const t = now();
    return send(res, 200, { sessions: [...REMOTE.values()].filter((r) => r.uid === user.id && t - r.last < 20000).map((r) => ({ id: r.id, device: r.device, role: r.role, started: r.created, watching: t - r.watchSeen < 15000, alive: t - r.last < 6000, standby: !!(r.state && r.state.standby) })) });
  }
  if (p === "/api/remote" && method === "POST") {
    const b = await readJson(req);
    const mine = [...REMOTE.values()].filter((r) => r.uid === user.id).sort((a, c) => a.last - c.last);
    while (mine.length >= 3) remoteEnd(mine.shift().id);
    const id = crypto.randomUUID(), t = now();
    // role "camera" (2.37): a phone waiting to be the camera for a Live target started on another device (an iPad)
    REMOTE.set(id, { id, uid: user.id, device: String(b.device || "Phone").slice(0, 40), role: b.role === "camera" ? "camera" : "", created: t, last: t, seq: 0, frame: null, state: null, cmds: [], waiters: new Set(), watchSeen: 0, result: null });
    return send(res, 200, { id });
  }
  m = /^\/api\/remote\/([0-9a-f-]{36})(\/push|\/wait|\/frame|\/cmd|\/result)?$/.exec(p);
  if (m) {
    const r = REMOTE.get(m[1]);
    if (!r || r.uid !== user.id) {
      if (m[2] === "/wait") return send(res, 200, { ended: true });
      throw new HttpError(404, "That Live target isn't running any more.");
    }
    const t = now();
    if (m[2] === "/push" && method === "POST") {
      const b = await readJson(req, 3 * 1024 * 1024);
      const mm = /^data:image\/jpeg;base64,(.+)$/.exec(b.frame || "");
      if (mm) r.frame = Buffer.from(mm[1], "base64");
      if (b.state && typeof b.state === "object") r.state = b.state;
      r.last = t; r.seq++;
      for (const w of r.waiters) w(); r.waiters.clear();
      const cmds = r.cmds; r.cmds = [];
      return send(res, 200, { cmds, watching: t - r.watchSeen < 15000 });
    }
    if (m[2] === "/wait" && method === "GET") {
      r.watchSeen = t;
      const since = Number(url.searchParams.get("since")) || 0;
      const reply = () => { const x = REMOTE.get(r.id); if (!x) return send(res, 200, { ended: true }); send(res, 200, { seq: x.seq, state: x.state, alive: now() - x.last < 6000, hasFrame: !!x.frame }); };
      if (r.seq > since) return reply();
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(timer); r.waiters.delete(fin); reply(); };
      const timer = setTimeout(fin, 12000);
      r.waiters.add(fin); req.on("close", () => { if (!done) { done = true; clearTimeout(timer); r.waiters.delete(fin); } });
      return;
    }
    // the camera phone hands the finished target (picture and marks) to the device that started it, which saves it
    if (m[2] === "/result" && method === "POST") { const b = await readJson(req, 16 * 1024 * 1024); r.result = { data: String(b.data || ""), w: Number(b.w) || 0, h: Number(b.h) || 0, M: b.M || null, tok: String(b.tok || "") }; return send(res, 200, { ok: true }); }
    if (m[2] === "/result" && method === "GET") { r.watchSeen = t; if (!r.result) throw new HttpError(404, "Nothing to save yet."); return send(res, 200, r.result); }
    if (m[2] === "/frame" && method === "GET") {
      r.watchSeen = t;
      if (!r.frame) throw new HttpError(404, "No picture yet.");
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": r.frame.length, "Cache-Control": "no-store", ...SECURITY_HEADERS });
      return res.end(r.frame);
    }
    if (m[2] === "/cmd" && method === "POST") {
      const b = await readJson(req);
      if (typeof b.cmd !== "string" || b.cmd.length > 40) throw new HttpError(400, "Bad command.");
      r.watchSeen = t;
      if (r.cmds.length < 30) r.cmds.push({ cmd: b.cmd, id: typeof b.id === "string" ? b.id.slice(0, 40) : undefined, k: typeof b.k === "string" ? b.k.slice(0, 20) : undefined, v: typeof b.v === "boolean" ? b.v : typeof b.v === "string" || typeof b.v === "number" ? String(b.v).slice(0, 80) : undefined, u: Number(b.u), w: Number(b.w),
        // starting a session from another device (2.37): who started it, its setup, and the answer to a save
        ...(b.cmd === "start" ? { host: String(b.host || "").slice(0, 40), cfg: b.cfg && typeof b.cfg === "object" ? b.cfg : {} } : {}), ...(b.cmd === "saved" ? { ok: !!b.ok, tok: String(b.tok || "").slice(0, 40) } : {}) });
      return send(res, 200, { ok: true });
    }
    if (!m[2] && method === "DELETE") { remoteEnd(r.id); return send(res, 200, { ok: true }); }
  }

  /* ---- Live target pictures saved without a load or trip: kept as trip photos with no trip yet, so they're in
     backups and can be moved into a range trip (or a load's ladder) later ---- */
  if (p === "/api/live" && method === "GET") {
    const rows = q("SELECT id, caption, w, h, measure, created_at FROM trip_photos WHERE owner_id=? AND trip_id='' ORDER BY created_at DESC").all(user.id);
    return send(res, 200, { photos: rows.map((r) => ({ id: r.id, caption: r.caption, w: r.w, h: r.h, measure: parseMeasure(r.measure), created: r.created_at, url: `/api/photos/${r.id}` })) });
  }
  if (p === "/api/live" && method === "POST") {
    const body = await readJson(req, 15 * 1024 * 1024);
    const mm = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(body.data || "");
    if (!mm) throw new HttpError(400, "That isn't a JPEG, PNG or WebP image.");
    let mtext = null;
    if (body.measure != null) {
      if (typeof body.measure !== "object" || Array.isArray(body.measure)) throw new HttpError(400, "Bad measurement.");
      mtext = JSON.stringify(body.measure);
      if (mtext.length > 50000) throw new HttpError(400, "That measurement has too many marks.");
    }
    const pid = crypto.randomUUID(), file = `${pid}.${mm[1] === "jpeg" ? "jpg" : mm[1]}`;
    fs.writeFileSync(path.join(PHOTO_DIR, file), Buffer.from(mm[2], "base64"));
    const at = Number(body.created) > 0 && Number(body.created) <= now() ? Math.round(Number(body.created)) : now();
    q("INSERT INTO trip_photos(id,trip_id,owner_id,caption,file,w,h,measure,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(pid, "", user.id, String(body.caption || "").slice(0, 500), file, body.w | 0 || null, body.h | 0 || null, mtext, at);
    return send(res, 200, { photo: { id: pid, caption: String(body.caption || "").slice(0, 500), w: body.w | 0 || null, h: body.h | 0 || null, measure: body.measure || null, created: at, url: `/api/photos/${pid}` } });
  }
  m = /^\/api\/live\/([^/]+)\/move$/.exec(p);
  if (m && method === "POST") {
    const ph = q("SELECT * FROM trip_photos WHERE id=? AND owner_id=? AND trip_id=''").get(m[1], user.id);
    if (!ph) throw new HttpError(404, "That saved Live target wasn't found. It may have been moved already.");
    const b = await readJson(req);
    if (b.tripId && ID_RE.test(String(b.tripId))) {
      q("UPDATE trip_photos SET trip_id=? WHERE id=?").run(String(b.tripId), ph.id);
      return send(res, 200, { photo: { id: ph.id, caption: ph.caption, w: ph.w, h: ph.h, measure: parseMeasure(ph.measure), url: `/api/photos/${ph.id}` } });
    }
    if (b.loadId) {
      const L = q("SELECT id FROM loads WHERE id=? AND owner_id=?").get(String(b.loadId), user.id);
      if (!L) throw new HttpError(404, "That load wasn't found.");
      const lad = ladderIdOf(b.ladderId);
      q("INSERT INTO photos(id,load_id,owner_id,caption,file,w,h,measure,ladder_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(ph.id, L.id, user.id, ph.caption, ph.file, ph.w, ph.h, ph.measure, lad, ph.created_at);
      q("DELETE FROM trip_photos WHERE id=?").run(ph.id);
      return send(res, 200, { photo: { id: ph.id, caption: ph.caption, w: ph.w, h: ph.h, measure: parseMeasure(ph.measure), ladderId: lad, url: `/api/photos/${ph.id}` } });
    }
    throw new HttpError(400, "Pick a range trip or a load.");
  }
  m = /^\/api\/photos\/([^/]+)$/.exec(p);
  if (m) {
    let ph = q("SELECT * FROM photos WHERE id=?").get(m[1]), table = "photos", access = null;
    if (ph) access = canRead(user, ph.load_id);
    else { ph = q("SELECT * FROM trip_photos WHERE id=? AND owner_id=?").get(m[1], user.id); table = "trip_photos"; if (ph) access = "owner"; }
    if (!ph) { const g = q("SELECT * FROM gun_photos WHERE id=? AND owner_id=?").get(m[1], user.id); if (g) { if (method !== "GET") throw new HttpError(400, "Use the gun photo controls for this one."); ph = g; table = "gun_photos"; access = "shared"; } }
    if (!ph) { const b = q("SELECT * FROM box_photos WHERE id=?").get(m[1]); if (b && (b.owner_id === user.id || ((shareBoxPhotos() || user.is_admin) && (b.cat_item || (b.ammo_id && q("SELECT 1 AS ok FROM shared_ammo WHERE id=?").get(b.ammo_id)))))) { if (method !== "GET") throw new HttpError(400, "Use the box photo controls for this one."); ph = b; table = "box_photos"; access = "shared"; } }
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
    /* ---- the whole site in one file (2.35): download it, or bring it back on a fresh install ---- */
    // the whole site holds everyone's data and passwords: the super admin's job (2.42.7)
    if ((p.startsWith("/api/admin/site-backup") || p.startsWith("/api/admin/site-restore") || p.startsWith("/api/admin/backup-")) && !isSuper(user)) throw new HttpError(403, "Only the super admin can download or restore the whole site.");
    if (p === "/api/admin/site-backup" && method === "GET") return send(res, 200, siteInfo());
    // the optional backup passphrase: only the key made from it is kept
    if (p === "/api/admin/backup-crypt") {
      if (method === "PUT") {
        const b = await readJson(req), pass = String(b.passphrase || "");
        if (pass.length < 12) throw new HttpError(400, "Use at least 12 characters. A few words with spaces works well.");
        const salt = crypto.randomBytes(16);
        setSetting("backupCrypt", { salt: salt.toString("base64"), key: encKey(pass, salt).toString("base64"), set: now() });
        console.log(`Site backups now encrypted (passphrase set by "${user.username}").`);
      }
      if (method === "DELETE") { setSetting("backupCrypt", null); console.log(`Site backup encryption turned off by "${user.username}".`); }
      const c = backupCrypt();
      return send(res, 200, { on: !!c, set: c ? c.set : null });
    }
    // the backup key for scheduled downloads: shown once when it's made, then only its hash is kept
    if (p === "/api/admin/backup-key") {
      if (method === "GET") { const k = getSetting("backupKey", null); return send(res, 200, { on: !!(k && k.hash), created: k ? k.created : null, lastUsed: k ? getSetting("backupKeyUsed", null) : null }); }
      if (method === "POST") {
        const key = "rbk_" + crypto.randomBytes(30).toString("base64url");
        setSetting("backupKey", { hash: sha256hex(key), created: now() }); setSetting("backupKeyUsed", null);
        console.log(`New backup key made by "${user.username}".`);
        return send(res, 200, { key });
      }
      if (method === "DELETE") { setSetting("backupKey", null); setSetting("backupKeyUsed", null); console.log(`Backup key turned off by "${user.username}".`); return send(res, 200, { on: false }); }
    }
    if (p === "/api/admin/site-backup.tar.gz" && method === "GET") return sendSiteBackup(res);
    if (p === "/api/admin/site-restore/start" && method === "POST") {
      const inf = siteInfo(); if (!inf.fresh) throw new HttpError(409, inf.why);
      const id = crypto.randomBytes(8).toString("hex"), dir = path.join(DATA_DIR, ".restore-" + id);
      for (const n of fs.readdirSync(DATA_DIR)) if (/^\.restore-/.test(n)) fs.rmSync(path.join(DATA_DIR, n), { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "upload"), "");
      return send(res, 200, { id, chunk: RESTORE_CHUNK });
    }
    {const mr = /^\/api\/admin\/site-restore\/([0-9a-f]{16})\/(chunk|finish|cancel)$/.exec(p);
    if (mr && method === "POST") {
      const dir = path.join(DATA_DIR, ".restore-" + mr[1]), up = path.join(dir, "upload");
      if (!fs.existsSync(up)) throw new HttpError(404, "That upload isn't here any more. Start again.");
      if (mr[2] === "cancel") { fs.rmSync(dir, { recursive: true, force: true }); return send(res, 200, { ok: true }); }
      if (mr[2] === "chunk") {
        const off = Number(url.searchParams.get("off")), have = fs.statSync(up).size;
        if (off !== have) return send(res, 409, { error: "Out of order.", have });
        const buf = await readBody(req, RESTORE_CHUNK + 1024);
        fs.appendFileSync(up, buf); return send(res, 200, { have: have + buf.length });
      }
      const b = await readJson(req).catch(() => ({}));
      // a missing or wrong passphrase keeps the upload, so it can be tried again without sending the file again
      let keep = false;
      try { const r = siteRestore(dir, user, b && b.passphrase ? String(b.passphrase) : ""); return send(res, 200, r); }
      catch (e) { keep = e instanceof HttpError && e.status === 422; throw e; }
      finally { if (!keep) fs.rmSync(dir, { recursive: true, force: true }); }
    }}
    if (p === "/api/admin/settings") {
      if (method === "PUT") { const b = await readJson(req); if ("guestEnabled" in b) setSetting("guestEnabled", !!b.guestEnabled); if ("shareAmmo" in b) setSetting("shareAmmo", !!b.shareAmmo); }
      return send(res, 200, { guestEnabled: !!getSetting("guestEnabled", false), shareAmmo: shareBoxPhotos() });
    }
    if (p === "/api/admin/super" && method === "POST") {
      if (!isSuper(user)) throw new HttpError(403, "Only the super admin can hand that role on.");
      const b = await readJson(req), to = q("SELECT * FROM users WHERE id=?").get(Number(b.id));
      if (!to || !to.is_admin || to.disabled) throw new HttpError(400, "Pick another admin whose account is turned on.");
      if (to.id === user.id) return send(res, 200, { superId: user.id });
      setSetting("superAdmin", to.id);
      console.log(`Super admin handed from "${user.username}" to "${to.username}".`);
      return send(res, 200, { superId: to.id });
    }
    if (p === "/api/admin/users" && method === "GET") {
      const sid = superId();
      const rows = q(`SELECT u.id, u.username, u.display_name, u.is_admin, u.must_change, u.disabled, u.created_at, u.last_login,
                        (SELECT COUNT(*) FROM loads l WHERE l.owner_id=u.id) AS loads
                      FROM users u ORDER BY u.username COLLATE NOCASE`).all();
      return send(res, 200, { users: rows.map((r) => ({ id: r.id, username: r.username, name: r.display_name, isAdmin: !!r.is_admin, mustChange: !!r.must_change, disabled: !!r.disabled, createdAt: r.created_at, lastLogin: r.last_login, loads: r.loads, isMe: r.id === user.id, isSuper: r.id === sid })), meSuper: user.id === sid });
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
    if (ax && method === "GET") {
      if (+ax[1] === superId() && !isSuper(user)) throw new HttpError(403, "Only the super admin can download the super admin's data.");
      return sendExport(res, +ax[1], ax[2]);
    }
    m = /^\/api\/admin\/users\/(\d+)(\/reset-password)?$/.exec(p);
    if (m) {
      const id = +m[1];
      const target = q("SELECT * FROM users WHERE id=?").get(id);
      if (!target) throw new HttpError(404, "User not found.");
      const otherAdmins = q("SELECT COUNT(*) AS n FROM users WHERE is_admin=1 AND disabled=0 AND id<>?").get(id).n;
      const targetSuper = id === superId();
      if (targetSuper && !isSuper(user)) throw new HttpError(403, "That's the super admin's account. Only they can change it.");
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
          if (!b.isAdmin && targetSuper) throw new HttpError(400, "You're the super admin. Hand that on to another admin first, then remove your admin.");
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
        deletePhotoFiles(q("SELECT file FROM vault_docs WHERE owner_id=?").all(id));
        deletePhotoFiles(q("SELECT file FROM gear_files WHERE owner_id=?").all(id));
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
    // the page, its worker and the data files it reads (targets, what's new, the app manifest) are checked on every load,
    // so an update shows up right away; icons and libraries can be kept for an hour
    const fresh = rel === "/index.html" || rel === "/sw.js" || /\.(json|webmanifest)$/.test(rel);
    const head = { "Content-Type": TYPES[path.extname(fp)] || "application/octet-stream", "Cache-Control": fresh ? "no-cache" : "public, max-age=3600", "Last-Modified": st.mtime.toUTCString(), ...SECURITY_HEADERS };
    // nothing changed since the browser's copy: say so instead of sending it again
    const ims = Date.parse(req.headers["if-modified-since"] || "");
    if (rel !== "/index.html" && !isNaN(ims) && Math.floor(st.mtimeMs / 1000) * 1000 <= ims) { res.writeHead(304, head); return res.end(); }
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
    setSetting("superAdmin", u.id); // whoever can restart the server with this setting owns it
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
/* ---------------- the whole site in one file (2.35) ----------------
   Download: a .tar.gz with site-backup.json, a consistent copy of the database (VACUUM INTO) and every file in the photos
   folder (photos, videos, vault and gear files), streamed so any size works. Restore (only on a fresh install: one account
   and no pictures or files): the file is uploaded in pieces (so it gets through Cloudflare's upload limit), unpacked into a
   folder, checked, and then every table is copied into the open database (columns both have), so the server keeps running.
   It also takes a .zip or a plain .tar of a nightly backup folder (rangebook.db + photos/). What was there before is kept in
   pre-restore-<time>/ in the data folder. */
const RESTORE_CHUNK = Math.max(65536, parseInt(process.env.RESTORE_CHUNK || "", 10) || 32 * 1024 * 1024); // RESTORE_CHUNK: only for testing
const TABLES = () => q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
function siteInfo() {
  const users = q("SELECT COUNT(*) AS n FROM users").get().n;
  let files = 0, bytes = 0;
  try { for (const f of fs.readdirSync(PHOTO_DIR)) { files++; try { bytes += fs.statSync(path.join(PHOTO_DIR, f)).size; } catch {} } } catch {}
  try { bytes += fs.statSync(path.join(DATA_DIR, "rangebook.db")).size; } catch {}
  const why = users > 1 ? "This Range Book already has " + users + " accounts. Restoring only works on a fresh install (just the account you set it up with, and no pictures or files)." :
    files > 0 ? "This Range Book already has pictures or files. Restoring only works on a fresh install (just the account you set it up with, and no pictures or files)." : "";
  return { fresh: !why, why, users, files, bytes, version: APP_VERSION };
}
function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 99), 0, "utf8");
  h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124); h.write(Math.floor(mtime / 1000).toString(8).padStart(11, "0") + "\0", 136);
  h.write("        ", 148); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
const sha256hex = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
/* Encrypted site backups (2.42.11, optional): with a backup passphrase set, every whole-site download is
   "RBENC" 0x01 + salt(16) + iv(12) + AES-256-GCM(gzipped tar) + tag(16). Only the key derived from the passphrase is
   kept (setting "backupCrypt"), never the passphrase, and Restore the whole site asks for it. */
const ENC_MAGIC = Buffer.from([0x52, 0x42, 0x45, 0x4e, 0x43, 0x01]);
const ENC_KDF = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const encKey = (pass, salt) => crypto.scryptSync(String(pass).normalize("NFC"), salt, 32, ENC_KDF);
function backupCrypt() {
  const c = getSetting("backupCrypt", null);
  return c && c.key && c.salt ? { key: Buffer.from(c.key, "base64"), salt: Buffer.from(c.salt, "base64"), set: c.set } : null;
}
function decryptSiteBackup(buf, pass) {
  if (!pass) throw new HttpError(422, "This backup is encrypted. Enter its backup passphrase, then tap Restore again.");
  if (buf.length < ENC_MAGIC.length + 28 + 16) throw new HttpError(400, "That encrypted backup is cut short.");
  const salt = buf.subarray(6, 22), iv = buf.subarray(22, 34), tag = buf.subarray(buf.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(pass, salt), iv); d.setAuthTag(tag);
  try { return Buffer.concat([d.update(buf.subarray(34, buf.length - 16)), d.final()]); }
  catch { throw new HttpError(422, "That passphrase doesn't open this backup (or the file is damaged). Check it and tap Restore again."); }
}
function sendSiteBackup(res) {
  const tmp = path.join(DATA_DIR, ".site-" + process.pid + "-" + Date.now() + ".db");
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const day = localDate(), names = fs.readdirSync(PHOTO_DIR).filter((n) => !n.startsWith("."));
  const info = Buffer.from(JSON.stringify({ app: "Range Book", kind: "site-backup", format: 1, version: APP_VERSION, created: new Date().toISOString(),
    users: q("SELECT COUNT(*) AS n FROM users").get().n, files: names.length }, null, 2));
  const ck = backupCrypt();
  res.writeHead(200, { "Content-Type": ck ? "application/octet-stream" : "application/gzip", "Content-Disposition": `attachment; filename="RangeBook-site-backup-${day}.tar.gz${ck ? ".enc" : ""}"`, "Cache-Control": "no-store", ...SECURITY_HEADERS });
  const gz = zlib.createGzip({ level: 1 });
  if (ck) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", ck.key, iv);
    res.write(Buffer.concat([ENC_MAGIC, ck.salt, iv]));
    gz.pipe(c); c.pipe(res, { end: false }); c.on("end", () => res.end(c.getAuthTag()));
  } else gz.pipe(res);
  const pad = (n) => (n % 512 ? Buffer.alloc(512 - (n % 512)) : null);
  const entries = [["site-backup.json", null], ["rangebook.db", tmp], ...names.map((n) => ["photos/" + n, path.join(PHOTO_DIR, n)])];
  let i = 0, done = false;
  const finish = () => { if (done) return; done = true; try { fs.rmSync(tmp, { force: true }); } catch {} };
  res.on("close", finish);
  const pump = () => {
    while (i < entries.length) {
      const [name, file] = entries[i++];
      let data;
      if (file === null) data = info;
      else { try { data = fs.readFileSync(file); } catch { continue; } }
      gz.write(tarHeader(name, data.length, Date.now())); const ok = gz.write(data); const pd = pad(data.length); if (pd) gz.write(pd);
      if (!ok) { gz.once("drain", pump); return; }
    }
    gz.end(Buffer.alloc(1024)); finish();
  };
  pump();
}
// the files in a .tar(.gz) or .zip, as [name, Buffer] one at a time
function* tarEntries(buf) {
  let o = 0, longName = null;
  while (o + 512 <= buf.length) {
    const h = buf.subarray(o, o + 512); if (h.every((b) => b === 0)) break;
    let name = h.toString("utf8", 0, 100).replace(/\0.*$/s, ""); const prefix = h.toString("utf8", 345, 500).replace(/\0.*$/s, "");
    if (prefix && h.toString("utf8", 257, 262) === "ustar") name = prefix + "/" + name;
    const size = parseInt(h.toString("utf8", 124, 136).replace(/\0.*$/s, "").trim() || "0", 8), type = String.fromCharCode(h[156] || 48);
    const data = buf.subarray(o + 512, o + 512 + size); o += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = data.toString("utf8").replace(/\0.*$/s, ""); continue; }
    if (longName) { name = longName; longName = null; }
    if (type === "0" || type === "\0") yield [name, data];
  }
}
function siteRestore(dir, user, pass) {
  const inf = siteInfo(); if (!inf.fresh) throw new HttpError(409, inf.why);
  let buf = fs.readFileSync(path.join(dir, "upload"));
  if (buf.length < 100) throw new HttpError(400, "That file is empty.");
  if (buf.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) buf = decryptSiteBackup(buf, pass);
  let list;
  if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf, { maxOutputLength: 2 ** 31 }); } catch { throw new HttpError(400, "That file couldn't be unpacked."); } }
  if (buf.length >= 512 && buf.toString("utf8", 257, 262) === "ustar") list = [...tarEntries(buf)];
  else if (buf.readUInt32LE(0) === 0x04034b50) { try { const z = backupKit.unzip(buf); list = [...z.keys()].map((n) => [n, z.get(n)]); } catch { throw new HttpError(400, "That .zip couldn't be read."); } }
  else throw new HttpError(400, "That isn't a Range Book site backup. Use the .tar.gz from Download site backup, or a .zip of a nightly backup folder.");
  // the folder the database is in counts as the top (a zipped nightly folder has its date in front)
  const dbe = list.find(([n]) => /(^|\/)rangebook\.db$/.test(n));
  if (!dbe) throw new HttpError(400, "There's no rangebook.db in that file, so it isn't a whole-site backup. (A backup from Account › Download backup is one person's data: import that from Account › Import instead.)");
  const root = dbe[0].slice(0, -"rangebook.db".length);
  const x = path.join(dir, "x"), xp = path.join(x, "photos"); fs.mkdirSync(xp, { recursive: true });
  let nfiles = 0;
  for (const [n, d] of list) {
    if (!n.startsWith(root)) continue; const rel = n.slice(root.length);
    const data = typeof d === "function" ? d() : d;
    if (rel === "rangebook.db") fs.writeFileSync(path.join(x, "rangebook.db"), data);
    else if (/^photos\/[^/]+$/.test(rel)) { const b = path.basename(rel); if (b && !b.startsWith(".") && b !== ".." ) { fs.writeFileSync(path.join(xp, b), data); nfiles++; } }
  }
  buf = null; list = null;
  // check it before touching anything
  let admins = [], nusers = 0;
  try { const bk = new DatabaseSync(path.join(x, "rangebook.db"), { readOnly: true });
    try { nusers = bk.prepare("SELECT COUNT(*) AS n FROM users").get().n; admins = bk.prepare("SELECT username FROM users WHERE is_admin=1 ORDER BY username").all().map((r) => r.username); } finally { bk.close(); } }
  catch { throw new HttpError(400, "The database in that file couldn't be opened, so nothing was changed."); }
  if (!nusers) throw new HttpError(400, "That backup has no accounts in it, so nothing was changed.");
  // keep what's here now
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19), keep = path.join(DATA_DIR, "pre-restore-" + stamp);
  fs.mkdirSync(path.join(keep, "photos"), { recursive: true });
  db.exec(`VACUUM INTO '${path.join(keep, "rangebook.db").replace(/'/g, "''")}'`);
  // copy every table across, in one transaction
  const bkPath = path.join(x, "rangebook.db").replace(/'/g, "''");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`ATTACH DATABASE '${bkPath}' AS bk`);
  try {
    const theirs = new Set(db.prepare("SELECT name FROM bk.sqlite_master WHERE type='table'").all().map((r) => r.name));
    db.exec("BEGIN");
    try {
      for (const t of TABLES()) {
        db.exec(`DELETE FROM main."${t}"`);
        if (!theirs.has(t)) continue;
        const mine = db.prepare(`PRAGMA main.table_info("${t}")`).all().map((c) => c.name), have = new Set(db.prepare(`PRAGMA bk.table_info("${t}")`).all().map((c) => c.name));
        const cols = mine.filter((c) => have.has(c)).map((c) => `"${c}"`).join(",");
        if (cols) db.exec(`INSERT INTO main."${t}"(${cols}) SELECT ${cols} FROM bk."${t}"`);
      }
      if (theirs.has("sqlite_sequence")) { db.exec("DELETE FROM main.sqlite_sequence"); db.exec("INSERT INTO main.sqlite_sequence SELECT * FROM bk.sqlite_sequence"); }
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw new HttpError(500, "Restoring failed, and nothing was changed: " + (e.message || e)); }
  } finally { try { db.exec("DETACH DATABASE bk"); } catch {} db.exec("PRAGMA foreign_keys = ON"); }
  // the files: what was here goes with the old copy, the backup's go in
  for (const f of fs.readdirSync(PHOTO_DIR)) { try { fs.renameSync(path.join(PHOTO_DIR, f), path.join(keep, "photos", f)); } catch {} }
  for (const f of fs.readdirSync(xp)) { try { fs.renameSync(path.join(xp, f), path.join(PHOTO_DIR, f)); } catch { try { fs.copyFileSync(path.join(xp, f), path.join(PHOTO_DIR, f)); } catch {} } }
  for (const r of [...REMOTE.keys()]) remoteEnd(r);
  console.log(`Site restored by ${user.username}: ${nusers} accounts, ${nfiles} files. The data that was here is in ${path.basename(keep)}/.`);
  return { ok: true, users: nusers, admins, files: nfiles, kept: path.basename(keep) };
}
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

server.requestTimeout = 60 * 60 * 1000; // big uploads and the site backup download can take a while
server.listen(PORT, () => {
  console.log(`Range Book ${APP_VERSION} listening on port ${PORT} (data in ${DATA_DIR})`);
  // pack the app page now, so the first visitor already gets the small copy
  const ip = path.join(PUBLIC_DIR, "index.html");
  fs.stat(ip, (err, st) => { if (!err) packFile(ip, "/index.html", st, () => {}); });
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); try { db.close(); } catch {} process.exit(0); });

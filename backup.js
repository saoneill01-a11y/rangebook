"use strict";
/*
 * Copyright (C) 2026 Sean O'Neill
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Range Book is free software under the GNU Affero General Public License, version 3 or later. See the LICENSE file.
 *
 * Backups and imports.
 *  - A backup (.zip) holds everything that belongs to one account: its reloading loads, its own lists (Shooting profiles,
 *    guns, ammo, components, brass, range trips, notes, settings) and its photos, with the photo files themselves.
 *  - The Excel export carries the same data (without photos) on a hidden "RangeBook data" sheet.
 *  - Importing either one ADDS to the account: anything already there (same load, gun, trip, photo...) is left alone,
 *    so importing the same file twice changes nothing.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const DOC_KEYS = ["calc", "brass", "rifles", "components", "prefs", "trips", "ammo", "notes"];
const DATA_SHEET = "RangeBook data";

/* ---------- reading a .zip (backups and .xlsx files are both zips) ---------- */
function unzip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("not a zip");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  let o = cdOff;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error("bad zip directory");
    const method = buf.readUInt16LE(o + 10), csize = buf.readUInt32LE(o + 20), nlen = buf.readUInt16LE(o + 28), elen = buf.readUInt16LE(o + 30), clen = buf.readUInt16LE(o + 32), loc = buf.readUInt32LE(o + 42);
    const name = buf.toString("utf8", o + 46, o + 46 + nlen);
    o += 46 + nlen + elen + clen;
    files.set(name, () => {
      if (buf.readUInt32LE(loc) !== 0x04034b50) throw new Error("bad zip entry");
      const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28), raw = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return zlib.inflateRawSync(raw);
      throw new Error("unsupported zip compression");
    });
  }
  return files;
}

/* ---------- the data sheet inside an Excel export ---------- */
const xmlUnesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");
const allText = (x) => { let t = ""; x.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, v) => { t += xmlUnesc(v); }); x.replace(/<t\s*\/>/g, ""); return t; };
// data rows of the "RangeBook data" sheet, column A from row 2, whether the file was saved by Range Book (inline text)
// or re-saved by Excel, Numbers or Google Sheets (shared strings)
function readDataSheet(files) {
  const get = (n) => (files.has(n) ? files.get(n)().toString("utf8") : null);
  const wb = get("xl/workbook.xml"); if (!wb) return null;
  const sm = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0]).find((t) => xmlUnesc((/name="([^"]*)"/.exec(t) || [])[1] || "") === DATA_SHEET);
  if (!sm) return null;
  const rid = (/r:id="([^"]+)"/.exec(sm) || [])[1];
  const rels = get("xl/_rels/workbook.xml.rels") || "";
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => (/Id="([^"]+)"/.exec(t) || [])[1] === rid);
  let target = rel ? (/Target="([^"]+)"/.exec(rel) || [])[1] : null; if (!target) return null;
  target = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
  const sheet = get(target); if (!sheet) return null;
  const sstXml = get("xl/sharedStrings.xml"), sst = sstXml ? [...sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => allText(m[1])) : [];
  const cells = [];
  for (const m of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1], inner = m[2] || "", ref = (/r="([A-Z]+)(\d+)"/.exec(attrs) || []);
    if (ref[1] !== "A" || +ref[2] < 2) continue;
    const t = (/t="([^"]+)"/.exec(attrs) || [])[1];
    let v = "";
    if (t === "s") v = sst[+((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1])] || "";
    else if (t === "inlineStr") v = allText(inner);
    else v = xmlUnesc((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] || "");
    cells.push([+ref[2], v]);
  }
  if (!cells.length) return null;
  return cells.sort((a, b) => a[0] - b[0]).map((c) => c[1]).join("");
}

/* ---------- any spreadsheet's tabs, for Import from a spreadsheet ----------
   Every visible tab as rows of cells: text, numbers, true/false, and dates as "YYYY-MM-DD" (a number formatted as a
   date). Works on files saved by Excel, Numbers, Google Sheets, LibreOffice or Range Book. */
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const colIndex = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
function readSheets(buf) {
  let files;
  try { files = unzip(buf); } catch { throw new Error("That isn't an .xlsx file. In Excel or Numbers, save it as an Excel workbook (.xlsx) or a .csv file and try again."); }
  const get = (n) => (files.has(n) ? files.get(n)().toString("utf8") : null);
  const wb = get("xl/workbook.xml");
  if (!wb) throw new Error("That file doesn't look like a spreadsheet. Save it as an Excel workbook (.xlsx) or a .csv file and try again.");
  const d1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wb);
  const rels = get("xl/_rels/workbook.xml.rels") || "";
  const relT = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [(/Id="([^"]+)"/.exec(m[0]) || [])[1], (/Target="([^"]+)"/.exec(m[0]) || [])[1]]));
  const sstXml = get("xl/sharedStrings.xml"), sst = sstXml ? [...sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => allText(m[1])) : [];
  // which cell styles are dates
  const st = get("xl/styles.xml") || "", custom = new Map();
  for (const m of st.matchAll(/<numFmt\b[^>]*>/g)) { const id = +((/numFmtId="(\d+)"/.exec(m[0]) || [])[1]); const code = xmlUnesc((/formatCode="([^"]*)"/.exec(m[0]) || [])[1] || ""); custom.set(id, code); }
  const isDateFmt = (id) => { if (DATE_IDS.has(id)) return true; const c = custom.get(id); if (!c) return false; const t = c.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ""); return /[dy]/i.test(t) && !/^General$/i.test(t); };
  const xfs = ((/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st) || [])[1] || "").match(/<xf\b[^>]*\/?>/g) || [];
  const dateStyle = xfs.map((x) => isDateFmt(+((/numFmtId="(\d+)"/.exec(x) || [])[1] || 0)));
  const iso = (n) => { const ms = Math.round((n + (d1904 ? 1462 : 0)) * 86400000) + Date.UTC(1899, 11, 30); const d = new Date(ms); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
  const out = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = m[0], name = xmlUnesc((/name="([^"]*)"/.exec(tag) || [])[1] || ""), hidden = /state="(hidden|veryHidden)"/.test(tag);
    let target = relT.get((/r:id="([^"]+)"/.exec(tag) || [])[1]);
    if (!target) continue;
    target = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    const x = get(target); if (!x) continue;
    const rows = [];
    for (const rm of x.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rn = +((/\br="(\d+)"/.exec(rm[1]) || [])[1] || rows.length + 1) - 1;
      if (rn > 20000) break;
      let ci = 0;
      for (const cm of (rm[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = cm[1], inner = cm[2] || "", ref = /\br="([A-Z]+)\d+"/.exec(a);
        const col = ref ? colIndex(ref[1]) : ci; ci = col + 1;
        if (col > 200) continue;
        const t = (/\bt="([^"]+)"/.exec(a) || [])[1], sIdx = +((/\bs="(\d+)"/.exec(a) || [])[1] || 0);
        const raw = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        let v = null;
        if (t === "s") v = raw != null ? sst[+raw] ?? "" : "";
        else if (t === "inlineStr") v = allText(inner);
        else if (t === "str") v = raw != null ? xmlUnesc(raw) : "";
        else if (t === "b") v = raw === "1";
        else if (t === "e") v = null;
        else if (raw != null && raw !== "") { const n = Number(raw); v = isFinite(n) ? (dateStyle[sIdx] ? iso(n) : n) : xmlUnesc(raw); }
        if (v === null || v === "") continue;
        (rows[rn] || (rows[rn] = []))[col] = typeof v === "string" ? v.trim() : v;
      }
    }
    const dense = [];
    for (let i = 0; i < rows.length; i++) { const r = rows[i] || []; const row = []; for (let j = 0; j < r.length; j++) row.push(r[j] === undefined ? null : r[j]); dense.push(row); }
    while (dense.length && !dense[dense.length - 1].some((c) => c !== null && c !== "")) dense.pop();
    out.push({ name, hidden, rows: dense });
  }
  return out;
}

module.exports = function makeBackup({ q, db, PHOTO_DIR, getDoc, putDoc, now, APP_VERSION, zip }) {
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

  /* ---------- everything that belongs to one account ---------- */
  function payload(uid, withPhotos) {
    const u = q("SELECT username, display_name FROM users WHERE id=?").get(uid) || {};
    const out = {
      format: "rangebook-data", version: 1, app: APP_VERSION, exportedAt: new Date().toISOString(),
      account: { username: u.username || "", name: u.display_name || "" },
      loads: q("SELECT id, data, created_at FROM loads WHERE owner_id=? ORDER BY created_at").all(uid).map((r) => ({ id: r.id, data: parse(r.data), created: r.created_at })),
      docs: Object.fromEntries(DOC_KEYS.map((k) => [k, getDoc(uid, k)]).filter(([, v]) => v != null)),
    };
    if (withPhotos) {
      out.photos = q("SELECT id, load_id, ladder_id, caption, file, w, h, measure, created_at FROM photos WHERE owner_id=? ORDER BY created_at").all(uid).map((r) => ({ ...r, measure: parse(r.measure) }));
      out.tripPhotos = q("SELECT id, trip_id, caption, file, w, h, measure, created_at FROM trip_photos WHERE owner_id=? ORDER BY created_at").all(uid).map((r) => ({ ...r, measure: parse(r.measure) }));
      out.gunPhotos = q("SELECT id, rifle_id, file, w, h, created_at FROM gun_photos WHERE owner_id=? ORDER BY created_at").all(uid);
      out.boxPhotos = q("SELECT id, cat_item, ammo_id, file, w, h, created_at FROM box_photos WHERE owner_id=? ORDER BY created_at").all(uid);
      // the document vault, still encrypted: without the owner's passphrase it can't be read here or after a restore
      const vk = q("SELECT data FROM vault_keys WHERE owner_id=?").get(uid);
      if (vk) out.vault = { key: parse(vk.data), docs: q("SELECT id, item_id, meta, file, size, created_at FROM vault_docs WHERE owner_id=? ORDER BY created_at").all(uid).map((r) => ({ ...r, meta: parse(r.meta) })) };
      // files on gear notes (not encrypted)
      out.files = q("SELECT id, item_id, name, type, file, size, created_at FROM gear_files WHERE owner_id=? ORDER BY created_at").all(uid);
    }
    return out;
  }

  // the backup file: the data as JSON plus every photo file under photos/
  function backupZip(uid) {
    const d = payload(uid, true);
    d.format = "rangebook-backup";
    const files = [{ name: "rangebook-backup.json", data: JSON.stringify(d) }];
    const seen = new Set();
    for (const p of [...d.photos, ...d.tripPhotos, ...d.gunPhotos, ...d.boxPhotos]) {
      const f = path.basename(p.file || ""); if (!f || seen.has(f)) continue; seen.add(f);
      try { files.push({ name: "photos/" + f, data: fs.readFileSync(path.join(PHOTO_DIR, f)) }); } catch { /* a missing file is skipped */ }
    }
    for (const v of (d.vault && d.vault.docs) || []) {
      const f = path.basename(v.file || ""); if (!f) continue;
      try { files.push({ name: "vault/" + f, data: fs.readFileSync(path.join(PHOTO_DIR, f)) }); } catch { /* a missing file is skipped */ }
    }
    for (const v of d.files || []) {
      const f = path.basename(v.file || ""); if (!f) continue;
      try { files.push({ name: "files/" + f, data: fs.readFileSync(path.join(PHOTO_DIR, f)) }); } catch { /* a missing file is skipped */ }
    }
    files.push({ name: "README.txt", data: "Range Book backup made " + d.exportedAt + " (Range Book " + APP_VERSION + ").\r\nTo restore it, open Range Book, go to Account and use Import, then pick this file.\r\nrangebook-backup.json holds your data; the photos folder holds your photos.\r\n" });
    return zip(files);
  }

  // the rows for the Excel export's hidden data sheet (cells hold at most 32,767 characters)
  function dataSheetRows(uid) {
    const s = JSON.stringify(payload(uid, false)), rows = [];
    for (let i = 0; i < s.length; i += 30000) rows.push([s.slice(i, i + 30000)]);
    return rows;
  }

  /* ---------- importing ---------- */
  function readFile(buf) {
    let files;
    try { files = unzip(buf); } catch { throw new Error("That file isn't a Range Book backup (.zip) or an Excel export from Range Book."); }
    if (files.has("rangebook-backup.json")) {
      const d = parse(files.get("rangebook-backup.json")().toString("utf8"));
      if (!d || !Array.isArray(d.loads)) throw new Error("That backup file is damaged.");
      return { d, files, kind: "backup" };
    }
    if (files.has("xl/workbook.xml")) {
      const text = readDataSheet(files), d = parse(text);
      if (!d || !Array.isArray(d.loads)) throw new Error("That Excel file doesn't have Range Book's data in it. Only Excel exports made with Range Book 2.2 or newer can be imported; use Download backup for a complete copy.");
      return { d, files: null, kind: "excel" };
    }
    throw new Error("That file isn't a Range Book backup (.zip) or an Excel export from Range Book.");
  }

  // a row's identity inside a list: its id, or (for rows without one) the row itself
  const rowKey = (r) => (r && typeof r === "object" && r.id != null ? "id:" + r.id : "row:" + JSON.stringify(r));
  // add the rows a list doesn't have yet; returns how many were added and skipped
  function mergeList(cur, inc, tally) {
    const have = new Set(cur.map(rowKey));
    for (const r of inc) { const k = rowKey(r); if (have.has(k)) tally.skipped++; else { cur.push(r); have.add(k); tally.added++; } }
    return cur;
  }
  // a list-of-lists document (rows, bullets/powders/…, Shooting profiles): merge each list by row; keep everything else as it is
  function mergeDoc(cur, inc, tally) {
    if (inc == null || typeof inc !== "object" || Array.isArray(inc)) return cur;
    if (cur == null || typeof cur !== "object" || Array.isArray(cur)) {
      for (const v of Object.values(inc)) if (Array.isArray(v)) tally.added += v.length;
      return JSON.parse(JSON.stringify(inc));
    }
    const out = { ...cur };
    for (const [k, v] of Object.entries(inc)) {
      if (Array.isArray(v)) out[k] = mergeList(Array.isArray(cur[k]) ? cur[k].slice() : [], v, tally);
      else if (!(k in cur)) out[k] = v;
    }
    return out;
  }

  function importInto(uid, buf) {
    const { d, files, kind } = readFile(buf);
    const res = { kind, loads: { added: 0, skipped: 0 }, lists: {}, photos: { added: 0, skipped: 0 }, vault: null, from: d.account || null, made: d.exportedAt || null };
    const written = [], t = now();
    const newFile = (orig) => {
      const ext = (/\.(jpg|jpeg|png|webp)$/i.exec(orig || "") || [, "jpg"])[1].toLowerCase().replace("jpeg", "jpg");
      const data = files && files.has("photos/" + path.basename(orig || "")) ? files.get("photos/" + path.basename(orig))() : null;
      if (!data) return null;
      const f = crypto.randomUUID() + "." + ext;
      fs.writeFileSync(path.join(PHOTO_DIR, f), data); written.push(f); return f;
    };
    // the id to use for an imported load or photo: its own id when it's free; when it's someone else's (a backup from
    // another account on this server), an id made from this account and the original one, so importing the same file
    // again finds it and skips it instead of making a second copy
    const alias = (id) => "i" + crypto.createHash("sha256").update(uid + ":" + id).digest("hex").slice(0, 31);
    const freeId = (table, id) => {
      if (!id) return { id: crypto.randomUUID(), skip: false };
      for (const cand of [id, alias(id)]) {
        const r = q(`SELECT owner_id FROM ${table} WHERE id=?`).get(cand);
        if (!r) return { id: cand, skip: false };
        if (r.owner_id === uid) return { id: cand, skip: true };
      }
      return { id: crypto.randomUUID(), skip: false };
    };
    const loadMap = new Map();
    db.exec("BEGIN");
    try {
      for (const L of d.loads) {
        if (!L || !L.data || typeof L.data !== "object") continue;
        const { id, skip } = freeId("loads", L.id);
        if (skip) { res.loads.skipped++; loadMap.set(L.id, id); continue; }
        q("INSERT INTO loads(id,owner_id,data,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, uid, JSON.stringify(L.data), L.created || t, t);
        loadMap.set(L.id, id); res.loads.added++;
      }
      for (const k of DOC_KEYS) {
        if (!d.docs || d.docs[k] == null) continue;
        const tally = { added: 0, skipped: 0 };
        const cur = getDoc(uid, k);
        const merged = k === "prefs" ? { ...(d.docs.prefs || {}), ...(cur || {}) } : mergeDoc(cur, d.docs[k], tally);
        if (JSON.stringify(merged) !== JSON.stringify(cur)) putDoc(uid, k, merged);
        if (k !== "prefs") res.lists[k] = tally;
      }
      if (kind === "backup") {
        const P = res.photos;
        for (const p of d.photos || []) {
          const lid = loadMap.get(p.load_id); if (!lid) continue;
          const { id, skip } = freeId("photos", p.id); if (skip) { P.skipped++; continue; }
          const f = newFile(p.file); if (!f) continue;
          q("INSERT INTO photos(id,load_id,owner_id,caption,file,w,h,measure,ladder_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
            .run(id, lid, uid, p.caption || "", f, p.w || null, p.h || null, p.measure ? JSON.stringify(p.measure) : null, p.ladder_id || null, p.created_at || t);
          P.added++;
        }
        for (const p of d.tripPhotos || []) {
          const { id, skip } = freeId("trip_photos", p.id); if (skip) { P.skipped++; continue; }
          const f = newFile(p.file); if (!f) continue;
          q("INSERT INTO trip_photos(id,trip_id,owner_id,caption,file,w,h,measure,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
            .run(id, String(p.trip_id || ""), uid, p.caption || "", f, p.w || null, p.h || null, p.measure ? JSON.stringify(p.measure) : null, p.created_at || t);
          P.added++;
        }
        for (const p of d.gunPhotos || []) {
          const { id, skip } = freeId("gun_photos", p.id); if (skip) { P.skipped++; continue; }
          const f = newFile(p.file); if (!f) continue;
          q("INSERT INTO gun_photos(id,rifle_id,owner_id,file,w,h,created_at) VALUES(?,?,?,?,?,?,?)").run(id, String(p.rifle_id || ""), uid, f, p.w || null, p.h || null, p.created_at || t);
          P.added++;
        }
        // vault documents only fit the vault they were locked with: restore them if this account has no vault yet (it takes
        // the backup's) or has that same one; a different vault here means a different passphrase, so they're skipped
        if (d.vault && d.vault.key && Array.isArray(d.vault.docs)) {
          const V = (res.vault = { added: 0, skipped: 0, different: false });
          const cur = q("SELECT data FROM vault_keys WHERE owner_id=?").get(uid), inc = JSON.stringify(d.vault.key);
          if (!cur) q("INSERT INTO vault_keys(owner_id,data,updated_at) VALUES(?,?,?)").run(uid, inc, t);
          if (cur && cur.data !== inc) { V.different = true; V.skipped = d.vault.docs.length; }
          else for (const v of d.vault.docs) {
            const { id, skip } = freeId("vault_docs", v.id); if (skip) { V.skipped++; continue; }
            const data = files && files.has("vault/" + path.basename(v.file || "")) ? files.get("vault/" + path.basename(v.file))() : null; if (!data) continue;
            const f = crypto.randomUUID() + ".rbv"; fs.writeFileSync(path.join(PHOTO_DIR, f), data); written.push(f);
            q("INSERT INTO vault_docs(id,owner_id,item_id,meta,file,size,created_at) VALUES(?,?,?,?,?,?,?)").run(id, uid, String(v.item_id || ""), JSON.stringify(v.meta || {}), f, data.length, v.created_at || t);
            V.added++;
          }
        }
        for (const v of d.files || []) {
          const { id, skip } = freeId("gear_files", v.id); if (skip) { P.skipped++; continue; }
          const data = files && files.has("files/" + path.basename(v.file || "")) ? files.get("files/" + path.basename(v.file))() : null; if (!data) continue;
          const f = crypto.randomUUID() + ".rbf"; fs.writeFileSync(path.join(PHOTO_DIR, f), data); written.push(f);
          q("INSERT INTO gear_files(id,owner_id,item_id,name,type,file,size,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, uid, String(v.item_id || ""), String(v.name || "file").slice(0, 160), String(v.type || "application/octet-stream").slice(0, 100), f, data.length, v.created_at || t);
          P.added++;
        }
        for (const p of d.boxPhotos || []) {
          const { id, skip } = freeId("box_photos", p.id); if (skip) { P.skipped++; continue; }
          const f = newFile(p.file); if (!f) continue;
          q("INSERT INTO box_photos(id,cat_item,ammo_id,owner_id,file,w,h,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, p.cat_item || null, p.ammo_id || null, uid, f, p.w || null, p.h || null, p.created_at || t);
          P.added++;
        }
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      for (const f of written) { try { fs.unlinkSync(path.join(PHOTO_DIR, f)); } catch {} }
      throw e;
    }
    return res;
  }

  return { backupZip, dataSheetRows, importInto, DATA_SHEET };
};
module.exports.unzip = unzip;
module.exports.readDataSheet = readDataSheet;
module.exports.readSheets = readSheets;

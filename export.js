"use strict";
/*
 * Copyright (C) 2026 Sean O'Neill
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Range Book is free software under the GNU Affero General Public License, version 3 or later. See the LICENSE file.
 *
 * Data export for Range Book: an Excel workbook (.xlsx) and a PDF report.
 * Both are written by hand here so the app needs no third-party packages.
 */
const zlib = require("node:zlib");

/* ======================= shared helpers ======================= */
function stats(g, L) {
  const sh = (g.shots || []).map(Number).filter((x) => isFinite(x) && x > 0).map(Math.round);
  if (!sh.length) return null;
  const n = sh.length, avg = sh.reduce((a, b) => a + b, 0) / n, avgT = Math.trunc(avg);
  const sd = Math.trunc(Math.sqrt(sh.reduce((a, b) => a + (b - avg) * (b - avg), 0) / n) * 10) / 10;
  const es = Math.max(...sh) - Math.min(...sh);
  const w = (L ? numv(L.bulletGrains) : numv(g.weight)) || null;
  const me = w ? Math.trunc((w * avgT * avgT) / 450436) : null;
  return { n, shots: sh, avgT, sd, es, me, w };
}
const gName = (g, i) => (g.label ? g.label : g.charge != null ? g.charge + " gr" : "Group " + (i + 1));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (d) => { const p = String(d || "").split("-"); return p.length === 3 ? `${MONTHS[+p[1] - 1]} ${+p[2]}, ${p[0]}` : d || ""; };
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const comp = (c) => (c ? [c.type, c.mfr ? `(${c.mfr})` : ""].filter(Boolean).join(" ") : "");
function sortLoads(loads) {
  return loads.slice().sort((a, b) => {
    const ca = (a.data.cartridge || "").toLowerCase(), cb = (b.data.cartridge || "").toLowerCase();
    if (ca !== cb) return ca < cb ? -1 : 1;
    return (a.data.order || 0) - (b.data.order || 0);
  });
}

/* ======================= ZIP (for .xlsx) ======================= */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const comp = zlib.deflateRawSync(raw), crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/* ======================= XLSX ======================= */
const xmlEsc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function colName(i) { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
// styles: 0 normal, 1 header, 2 date, 3 one decimal, 4 three decimals, 5 wrapped text, 6 title
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0"/><numFmt numFmtId="165" formatCode="0.000"/></numFmts>
<fonts count="3"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="13"/><name val="Arial"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0E5A61"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
function excelDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return null;
  return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
}
// A cell is a string, a number, null, or {v, s} with an explicit style; {date:"YYYY-MM-DD"} for dates.
function sheetXml(sheet) {
  const rows = sheet.rows, ncols = sheet.cols.length;
  let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`;
  x += `<sheetViews><sheetView workbookViewId="0"${sheet.selected ? ' tabSelected="1"' : ""}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`;
  x += `<sheetFormatPr defaultRowHeight="13"/><cols>`;
  sheet.cols.forEach((c, i) => { x += `<col min="${i + 1}" max="${i + 1}" width="${c.w}" customWidth="1"/>`; });
  x += `</cols><sheetData>`;
  const all = [sheet.cols.map((c) => ({ v: c.h, s: 1 })), ...rows];
  all.forEach((row, r) => {
    x += `<row r="${r + 1}"${r === 0 ? ' ht="28" customHeight="1"' : ""}>`;
    row.forEach((cell, c) => {
      if (cell == null || cell === "") return;
      const ref = colName(c) + (r + 1);
      let v = cell, s = r === 0 ? 1 : (sheet.cols[c].s || 0);
      if (typeof cell === "object") {
        if ("date" in cell) { const n = excelDate(cell.date); if (n == null) { v = cell.date || ""; s = 0; } else { v = n; s = 2; } }
        else { v = cell.v; if (cell.s != null) s = cell.s; }
      }
      if (v == null || v === "") return;
      if (typeof v === "number" && isFinite(v)) x += `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
      else x += `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    });
    x += `</row>`;
  });
  x += `</sheetData>`;
  if (all.length > 1) x += `<autoFilter ref="A1:${colName(ncols - 1)}${all.length}"/>`;
  x += `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  return x;
}
function buildXlsx(sheets) {
  const files = [];
  files.push({ name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` });
  files.push({ name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` });
  files.push({ name: "docProps/core.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Range Book export</dc:title><dc:creator>Range Book</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created></cp:coreProperties>` });
  files.push({ name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`).join("")}</sheets><definedNames>${sheets.map((s, i) => s.rows.length && !s.hidden ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEsc(s.name)}'!$A$1:$${colName(s.cols.length - 1)}$${s.rows.length + 1}</definedName>` : "").join("")}</definedNames></workbook>` });
  files.push({ name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: "xl/styles.xml", data: STYLES });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
  return zip(files);
}

const MOA_IN = 1.0472;
const TG_COLORS = ["#00c8e0", "#e0b800", "#e04fc0", "#4caf00", "#ff8a00", "#8e63e6", "#00a8a8", "#e53935"];
function normMeasure(m) {
  if (!m) return null;
  if (Array.isArray(m.groups)) return m;
  return { a: m.a, b: m.b, scaleIn: m.scaleIn, dia: m.dia, distance: m.distance, groups: m.shots && m.shots.length ? [{ groupId: m.groupId, aim: m.aim, shots: m.shots, n: m.n, size: m.size, moa: m.moa, mr: m.mr, dx: m.dx, dy: m.dy }] : [] };
}
function tgName(t, k, L) { const gs = (L && L.groups) || []; const i = gs.findIndex((g) => g.id === t.groupId); return i >= 0 ? gName(gs[i], i) : "Group " + (k + 1); }
const numv = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
// units: the account's choice (More → Account → Units). Data is stored imperial; exports convert it the same way the app does. Grains stay grains.
let METRIC = false;
const UK = { yd: ["yd", "m", 0.9144], fps: ["fps", "m/s", 0.3048], in: ["in", "cm", 2.54], dim: ["in", "mm", 25.4], ftlb: ["ft-lb", "J", 1.3558179], F: ["°F", "°C", null], mph: ["mph", "km/h", 1.609344], ft: ["ft", "m", 0.3048], lb: ["lb", "kg", 0.45359237] };
function useUnits(d) { METRIC = !!(d && d.prefs && d.prefs.units === "metric"); }
const ul = (k) => (METRIC ? UK[k][1] : UK[k][0]);
// a value in the account's units, rounded to dec places (dec null = not rounded)
const cv = (k, v, dec) => { v = numv(v); if (v == null) return null; if (METRIC) v = k === "F" ? ((v - 32) * 5) / 9 : v * UK[k][2]; if (dec == null) return v; const p = 10 ** dec; return Math.round(v * p) / p; };
// the same with its unit, as text ("91 m")
const cs = (k, v, dec) => { const x = cv(k, v, dec); return x == null ? "" : x + (k === "F" ? "" : " ") + ul(k); };
// the ladder test each group belongs to ("Ladder 1", "Ladder 2", …); older loads without ladders are split by tested date, as the app does
function ladderNames(L) {
  const gs = L.groups || [], out = new Map();
  if (Array.isArray(L.ladders)) {
    const idx = new Map(L.ladders.map((l, k) => [l.id, k]));
    const last = L.ladders.length;
    gs.forEach((g) => out.set(g, "Ladder " + ((idx.has(g.ladderId) ? idx.get(g.ladderId) : Math.max(0, last - 1)) + 1)));
    return out;
  }
  const byDate = new Map(), runOf = new Map(), before = []; let last = null, first = null;
  gs.forEach((g) => { const d = g.date || ""; let run = d ? byDate.get(d) : last; if (d && !run) { run = { d }; byDate.set(d, run); } if (!run) { before.push(g); return; } if (!first) first = run; runOf.set(g, run); last = run; });
  const order = [...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  gs.forEach((g) => { const run = runOf.get(g) || first; out.set(g, "Ladder " + (run ? order.indexOf(run) + 1 : 1)); });
  return out;
}
function groupMoa(g) { const sz = numv(g.groupSize), dd = numv(g.distance); return sz > 0 && dd > 0 ? sz / ((dd / 100) * MOA_IN) : null; }
function groupMr(g) { const r = numv(g.meanRadius), dd = numv(g.distance); return r > 0 && dd > 0 ? r / ((dd / 100) * MOA_IN) : null; }
function poaCells(g) { const x = numv(g.poaX), y = numv(g.poaY); return x == null || y == null ? [null, null] : [{ v: cv("in", x, METRIC ? 2 : 3), s: 4 }, { v: cv("in", y, METRIC ? 2 : 3), s: 4 }]; }
const PRESS = { flat: "flat primer", crater: "cratered primer", eject: "ejector mark", bolt: "heavy bolt lift", sticky: "sticky extraction", pocket: "loose primer pocket" };
function pressText(g) { const p = g.press || {}, out = Object.keys(PRESS).filter((k) => p[k]).map((k) => PRESS[k]); if (numv(g.headExp) > 0) out.push("case head +" + (METRIC ? (g.headExp * 25.4).toFixed(3) + " mm" : (+g.headExp).toFixed(4) + " in")); return out.join(", "); }
function maxFlag(g, L) { const mx = numv(L.maxCharge); if (!(mx > 0) || g.charge == null) return ""; return g.charge > mx ? "OVER MAX" : g.charge === mx ? "At max" : ""; }
function rifleName(L, d) { const rows = d.rifles && Array.isArray(d.rifles.rows) ? d.rifles.rows : []; const r = L.rifleId && rows.find((x) => x.id === L.rifleId); return (r && r.name) || L.rifleName || ""; }
function calcRifle(c, d) { return rifleName({ rifleId: c.rifleId, rifleName: c.rifleName }, d); }
function compRows(d) {
  const C = d.components || {}, rows = [];
  const used = (key, id) => d.loads.filter((l) => l.data[key] === id).length;
  (C.bullets || []).forEach((c) => rows.push(["Bullet", c.mfr || "", [c.calname, c.name].filter(Boolean).join(" "), numv(c.caliber) != null ? { v: cv("dim", c.caliber, METRIC ? 2 : 4), s: 4 } : null, numv(c.weight), c.bc != null ? { v: numv(c.bc), s: 4 } : null, c.bc != null ? (c.bcm === "G7" ? "G7" : "G1") : "", cv("dim", c.length, METRIC ? 1 : 3), "", used("bulletId", c.id), c.notes || "", numv(c.onHand), numv(c.lowAt)]));
  (C.powders || []).forEach((c) => rows.push(["Powder", c.mfr || "", c.name || "", null, null, null, "", null, c.kind || "", used("powderId", c.id), c.notes || "", numv(c.onHand) != null ? cs("lb", c.onHand, 3) : null, numv(c.lowAt) != null ? cs("lb", c.lowAt, 3) : null]));
  (C.primers || []).forEach((c) => rows.push(["Primer", c.mfr || "", c.name || "", null, null, null, "", null, c.size || "", used("primerId", c.id), c.notes || "", numv(c.onHand), numv(c.lowAt)]));
  (C.brass || []).forEach((c) => {
    const n = (numv(c.firedBase) || 0) + d.loads.reduce((a, l) => a + (l.data.batches || []).filter((b) => b.lotId === c.id).length, 0);
    rows.push(["Brass lot", c.mfr || "", c.name || "", null, null, null, "", null, [c.cartridge, "loaded " + n + "x", c.annealed ? "annealed " + c.annealed : "", c.trimmed ? "trimmed " + c.trimmed : ""].filter(Boolean).join(", "), null, c.notes || "", numv(c.onHand), numv(c.lowAt)]);
  });
  return rows;
}
// range trips (Trajectory tab): one row per trip, with the groups measured on its photos
function tripRows(d) {
  const trips = d.trips && Array.isArray(d.trips.trips) ? d.trips.trips.slice() : [];
  const calc = d.calc && Array.isArray(d.calc.loads) ? d.calc.loads : [];
  const nameById = Object.fromEntries(calc.map((c) => [c.id, c.name || "Untitled load"]));
  trips.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return trips.map((t) => {
    const ph = (d.tripPhotos || []).filter((p) => p.trip_id === t.id);
    const gs = [];
    ph.forEach((p) => { const M = normMeasure(p.measure); if (M) M.groups.forEach((g) => { if (g.size != null) gs.push(g); }); });
    const best = gs.length ? gs.reduce((a, b) => (b.size < a.size ? b : a)) : null;
    return { t, load: nameById[t.trajId] || "(deleted load)", photos: ph.length, groups: gs, best };
  });
}
// factory ammo (Guns and Ammo tab): rounds fired come from range trips on calculator loads that use it
function ammoRows(d) {
  const rows = d.ammo && Array.isArray(d.ammo.rows) ? d.ammo.rows : [];
  const calc = d.calc && Array.isArray(d.calc.loads) ? d.calc.loads : [];
  const trips = d.trips && Array.isArray(d.trips.trips) ? d.trips.trips : [];
  return rows.map((a) => {
    const tids = new Set(calc.filter((c) => c.ammoId === a.id).map((c) => c.id));
    const fired = trips.filter((t) => tids.has(t.trajId)).reduce((s, t) => s + (numv(t.rounds) || 0), 0);
    const bought = numv(a.bought);
    const rl = a.kind === "reload";
    return [rl ? "Reloaded" : "Factory", a.mfr || "", a.name || "", a.cartridge || "", a.bullet || "", numv(a.weight), a.bc != null ? { v: numv(a.bc), s: 4 } : null, a.bc != null ? (a.bcm === "G7" ? "G7" : "G1") : "", cv("fps", a.boxVel, 0), cv("fps", a.measVel, 0), bought, fired || null, bought != null ? bought - fired : null, numv(a.price), numv(a.perBox), a.lot || "", rl ? a.powder || "" : "", rl ? numv(a.charge) : null, rl ? a.primer || "" : "", rl ? a.brass || "" : "", a.notes || ""];
  });
}
function exportXlsx(d) {
  useUnits(d);
  const loads = sortLoads(d.loads);
  const groupRows = [], shotRows = [], loadRows = [];
  for (const { data: L, sharedWith } of loads) {
    const title = L.title || "Untitled load", lname = ladderNames(L);
    (L.groups || []).forEach((g, i) => {
      const s = stats(g, L);
      groupRows.push([title, L.cartridge || "", lname.get(g) || "Ladder 1", g.date ? { date: g.date } : null, g.loaded ? { date: g.loaded } : null, cv("F", g.temp, 1), g.charge ?? null, g.label || "", s ? s.n : 0, s ? cv("fps", s.avgT, 0) : null, s ? { v: cv("fps", s.sd, 1), s: 3 } : null, s ? cv("fps", s.es, 0) : null, s ? cv("ftlb", s.me, 0) : null, numv(L.bulletGrains), cv("yd", g.distance, METRIC ? 0 : null), numv(g.groupSize) != null ? { v: cv("in", g.groupSize, METRIC ? 2 : 4), s: 4 } : null, groupMoa(g) != null ? { v: Math.round(groupMoa(g) * 100) / 100, s: 3 } : null, numv(g.meanRadius) != null ? { v: cv("in", g.meanRadius, METRIC ? 2 : 3), s: 4 } : null, groupMr(g) != null ? { v: Math.round(groupMr(g) * 100) / 100, s: 3 } : null, ...poaCells(g), maxFlag(g, L), pressText(g)]);
      if (s) s.shots.forEach((v, j) => shotRows.push([title, (lname.get(g) || "Ladder 1") + " · " + gName(g, i), { date: g.date }, g.charge ?? null, j + 1, cv("fps", v, METRIC ? 1 : 0)]));
    });
    loadRows.push([title, L.cartridge || "", L.bullet?.type || "", L.bullet?.mfr || "", L.bulletGrains ?? null, L.bc != null ? { v: L.bc, s: 4 } : null, L.bc != null ? (L.bcm === "G7" ? "G7" : "G1") : "", L.primer?.type || "", L.primer?.mfr || "",
      L.powder?.type || "", L.powder?.mfr || "", L.case?.type || "", L.case?.mfr || "", L.caseLength != null ? { v: cv("dim", L.caseLength, METRIC ? 2 : 4), s: 4 } : null,
      L.coal != null ? { v: cv("dim", L.coal, METRIC ? 2 : 4), s: 4 } : null, numv(L.maxCharge), rifleName(L, d), new Set(ladderNames(L).values()).size, (L.groups || []).length, sharedWith.join(", "), L.notes || ""]);
  }
  const calc = (d.calc && Array.isArray(d.calc.loads) ? d.calc.loads : []).map((c) => [c.name || "", c.w ?? null, cv("fps", c.mv, METRIC ? 1 : null), c.bc != null ? { v: c.bc, s: 4 } : null, c.bc != null ? (c.bcm === "G7" ? "G7" : "G1") : "", c.cal != null ? { v: cv("dim", c.cal, METRIC ? 2 : 4), s: 4 } : null, cv("in", c.sh, METRIC ? 2 : null), ...[0, 1, 2, 3].map((i) => (c.z && c.z[i] != null ? cv("yd", c.z[i], 0) : null)), c.lr ? "Yes" : "No", calcRifle(c, d)]);
  const brass = (d.brass && Array.isArray(d.brass.rows) ? d.brass.rows : []).map((r) => [r.mfr || "", r.headstamp || "", r.rating || ""]);
  const titleById = Object.fromEntries(d.loads.map((l) => [l.id, l.data.title || "Untitled load"]));
  const rifleRows = (d.rifles && Array.isArray(d.rifles.rows) ? d.rifles.rows : []).map((r) => [r.name || "", r.serial || "", numv(r.barrel) != null ? cv("dim", r.barrel, METRIC ? 0 : null) : r.barrel || "", numv(r.twist) != null ? cv("dim", r.twist, METRIC ? 0 : null) : r.twist || "", cv("in", r.sightHeight, METRIC ? 2 : null), d.loads.filter((l) => l.data.rifleId && l.data.rifleId === r.id).length, r.notes || ""]);
  const loadById = Object.fromEntries(d.loads.map((l) => [l.id, l.data]));
  const photos = [];
  d.photos.forEach((p) => {
    const PL = loadById[p.load_id], lads = (PL && PL.ladders) || [], lk = lads.findIndex((l) => l.id === p.ladder_id);
    const base = [titleById[p.load_id] || "", lk >= 0 ? "Ladder " + (lk + 1) : ((lads.length === 1 || (PL && !Array.isArray(PL.ladders) && new Set(ladderNames(PL).values()).size <= 1)) ? "Ladder 1" : ""), p.caption || "", { date: localDay(new Date(p.created_at)) }];
    const M = normMeasure(p.measure), gs = M ? M.groups.filter((t) => t.size != null) : [];
    if (!gs.length) { photos.push([...base, null, null, null, null, null, null]); return; }
    gs.forEach((t) => photos.push([...base, tgName(t, M.groups.indexOf(t), loadById[p.load_id]), t.n, { v: cv("in", t.size, 4), s: 4 }, t.moa != null ? { v: t.moa, s: 4 } : null, cv("yd", M.distance, METRIC ? 0 : null), t.mr != null ? { v: cv("in", t.mr, 4), s: 4 } : null]));
  });
  const noteRows = (d.notes && Array.isArray(d.notes.rows) ? d.notes.rows : []).slice().sort((a, b) => (b.updated || 0) - (a.updated || 0)).map((n) => [(n.title || "").trim() || String(n.body || "").trim().split("\n")[0].slice(0, 80), n.updated ? { date: localDay(new Date(n.updated)) } : null, n.pinned ? "Yes" : "", n.body || ""]);
  return buildXlsx([
    { name: "Ladder Tests", selected: true, rows: groupRows, cols: [{ h: "Load", w: 26 }, { h: "Cartridge", w: 22 }, { h: "Ladder", w: 10 }, { h: "Tested", w: 12 }, { h: "Loaded", w: 12 }, { h: "Temp (" + ul("F") + ")", w: 9 }, { h: "Charge (gr)", w: 11 }, { h: "Label", w: 18 }, { h: "Shots", w: 7 }, { h: "Avg " + (METRIC ? "m/s" : "FPS"), w: 9 }, { h: "SD", w: 7 }, { h: "ES", w: 7 }, { h: "Energy (" + ul("ftlb") + ")", w: 12 }, { h: "Bullet (gr)", w: 10 }, { h: "Distance (" + ul("yd") + ")", w: 12 }, { h: "Group (" + ul("in") + ")", w: 10 }, { h: "Group (MOA)", w: 11 }, { h: "Mean radius (" + ul("in") + ")", w: 14 }, { h: "Mean radius (MOA)", w: 14 }, { h: "Center right of aim (" + ul("in") + ")", w: 16 }, { h: "Center above aim (" + ul("in") + ")", w: 16 }, { h: "Max charge", w: 11 }, { h: "Pressure signs", w: 30 }] },
    { name: "Shots", rows: shotRows, cols: [{ h: "Load", w: 26 }, { h: "Group", w: 26 }, { h: "Date", w: 12 }, { h: "Charge (gr)", w: 11 }, { h: "Shot #", w: 8 }, { h: METRIC ? "m/s" : "FPS", w: 8 }] },
    { name: "Loads", rows: loadRows, cols: [{ h: "Load", w: 26 }, { h: "Cartridge", w: 22 }, { h: "Bullet", w: 20 }, { h: "Bullet maker", w: 16 }, { h: "Bullet (gr)", w: 10 }, { h: "BC", w: 8 }, { h: "BC type", w: 8 }, { h: "Primer", w: 16 }, { h: "Primer maker", w: 16 }, { h: "Powder", w: 12 }, { h: "Powder maker", w: 14 }, { h: "Brass", w: 12 }, { h: "Brass maker", w: 14 }, { h: "Case length (" + ul("dim") + ")", w: 14 }, { h: "COAL (" + ul("dim") + ")", w: 10 }, { h: "Max charge (gr)", w: 14 }, { h: "Gun", w: 22 }, { h: "Ladders", w: 8 }, { h: "Groups", w: 8 }, { h: "Shared with", w: 18 }, { h: "Notes", w: 70, s: 5 }] },
    { name: "Guns", rows: rifleRows, cols: [{ h: "Gun", w: 28 }, { h: "Serial number", w: 18 }, { h: "Barrel (" + ul("dim") + ")", w: 18 }, { h: "Twist (" + ul("dim") + ")", w: 10 }, { h: "Sight height (" + ul("in") + ")", w: 15 }, { h: "Loads", w: 7 }, { h: "Notes", w: 60, s: 5 }] },
    { name: "Components", rows: compRows(d), cols: [{ h: "Kind", w: 9 }, { h: "Manufacturer", w: 18 }, { h: "Name", w: 24 }, { h: "Actual diameter (" + (METRIC ? "mm" : "cal") + ")", w: 18 }, { h: "Weight (gr)", w: 11 }, { h: "BC", w: 8 }, { h: "BC type", w: 8 }, { h: "Length (" + ul("dim") + ")", w: 11 }, { h: "Size / kind", w: 16 }, { h: "Used by", w: 8 }, { h: "Notes", w: 50, s: 5 }, { h: "On hand", w: 10 }, { h: "Warn below", w: 11 }] },
    ...(noteRows.length ? [{ name: "Reloading notes", rows: noteRows, cols: [{ h: "Title", w: 30 }, { h: "Last changed", w: 13 }, { h: "Pinned", w: 8 }, { h: "Note", w: 90, s: 5 }] }] : []),
    { name: "Brass", rows: brass, cols: [{ h: "Manufacturer", w: 32 }, { h: "Headstamp", w: 16 }, { h: "Rating", w: 14 }] },
    { name: "Calculator loads", rows: calc, cols: [{ h: "Name", w: 30 }, { h: "Bullet (gr)", w: 10 }, { h: "Velocity (" + ul("fps") + ")", w: 13 }, { h: "BC", w: 8 }, { h: "BC type", w: 8 }, { h: "Diameter (" + ul("dim") + ")", w: 12 }, { h: "Sight height (" + ul("in") + ")", w: 14 }, ...[1, 2, 3, 4].map((n) => ({ h: "Zero " + n + " (" + ul("yd") + ")", w: 10 })), { h: "Long range", w: 10 }, { h: "Gun", w: 22 }] },
    { name: "Ammunition", rows: ammoRows(d), cols: [{ h: "Type", w: 10 }, { h: "Manufacturer", w: 16 }, { h: "Product line / name", w: 22 }, { h: "Cartridge", w: 18 }, { h: "Bullet", w: 20 }, { h: "Weight (gr)", w: 11 }, { h: "BC", w: 8 }, { h: "BC type", w: 8 }, { h: "Box velocity (" + ul("fps") + ")", w: 14 }, { h: "Measured velocity (" + ul("fps") + ")", w: 18 }, { h: "Rounds bought / loaded", w: 14 }, { h: "Fired on trips", w: 13 }, { h: "On hand", w: 9 }, { h: "Price per box", w: 12 }, { h: "Rounds per box", w: 13 }, { h: "Lot", w: 12 }, { h: "Powder", w: 18 }, { h: "Charge (gr)", w: 11 }, { h: "Primer", w: 14 }, { h: "Brass", w: 16 }, { h: "Notes", w: 50, s: 5 }] },
    { name: "Range trips", rows: tripRows(d).map(({ t, load, photos, groups, best }) => [t.date ? { date: t.date } : null, load, t.place || "", cv("yd", t.distance, METRIC ? 0 : null), numv(t.rounds), cv("F", t.temp, 1), t.wind || "", cv("fps", t.avgVel, 0), cv("fps", t.sd, 1), (t.strings || []).reduce((a, x) => a + (x.shots || []).filter((v) => Number(v) > 0).length, 0) || null, (() => { const all = (t.strings || []).flatMap((x) => x.shots || []).map(Number).filter((v) => v > 0); return all.length > 1 ? cv("fps", Math.max(...all) - Math.min(...all), 0) : null; })(), groups.length, best ? { v: cv("in", best.size, 4), s: 4 } : null, best && best.moa != null ? { v: best.moa, s: 4 } : null, photos, t.notes || ""]),
      cols: [{ h: "Date", w: 12 }, { h: "Load", w: 26 }, { h: "Place", w: 22 }, { h: "Distance (" + ul("yd") + ")", w: 12 }, { h: "Rounds", w: 8 }, { h: "Temp (" + ul("F") + ")", w: 9 }, { h: "Wind", w: 16 }, { h: "Avg " + (METRIC ? "m/s" : "FPS"), w: 9 }, { h: "SD", w: 7 }, { h: "Chrono shots", w: 12 }, { h: "ES", w: 7 }, { h: "Groups measured", w: 14 }, { h: "Best group (" + ul("in") + ")", w: 14 }, { h: "Best group (MOA)", w: 15 }, { h: "Photos", w: 8 }, { h: "Notes", w: 60, s: 5 }] },
    { name: "Photos", rows: photos, cols: [{ h: "Load", w: 26 }, { h: "Ladder", w: 10 }, { h: "Caption", w: 60 }, { h: "Added", w: 12 }, { h: "Measured group", w: 18 }, { h: "Shots measured", w: 14 }, { h: "Group (" + ul("in") + ")", w: 10 }, { h: "Group (MOA)", w: 11 }, { h: "Distance (" + ul("yd") + ")", w: 12 }, { h: "Mean radius (" + ul("in") + ")", w: 14 }] },
    // the account's data for Import (Account → Import); hidden so it stays out of the way
    ...(d.dataRows && d.dataRows.length ? [{ name: "RangeBook data", hidden: true, rows: d.dataRows, cols: [{ h: "Range Book data for Import. Please don't edit this sheet.", w: 60 }] }] : []),
  ]);
}

/* ======================= PDF ======================= */
// Helvetica / Helvetica-Bold advance widths for WinAnsi codes 32–126 (1/1000 em).
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const EXTRA = { 0xb7: [278, 278], 0x97: [1000, 1000], 0x96: [556, 556], 0xb0: [400, 400], 0xd7: [584, 584], 0x92: [222, 278], 0x91: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0xb1: [584, 584], 0xbd: [834, 834] };
const MAP = { "·": 0xb7, "—": 0x97, "–": 0x96, "°": 0xb0, "×": 0xd7, "’": 0x92, "‘": 0x91, "“": 0x93, "”": 0x94, "±": 0xb1, "½": 0xbd };
function toWin(str) {
  const out = [];
  for (const ch of String(str ?? "").replace(/[\r\t]/g, " ")) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) out.push(c);
    else if (MAP[ch]) out.push(MAP[ch]);
    else if (ch === "≈") out.push(126);
    else if (ch === "Δ") out.push(100);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else out.push(63);
  }
  return out;
}
function textWidth(str, size, bold) {
  let w = 0;
  for (const c of toWin(str)) w += c >= 32 && c <= 126 ? (bold ? W_BOLD : W_REG)[c - 32] : (EXTRA[c] ? EXTRA[c][bold ? 1 : 0] : 556);
  return (w * size) / 1000;
}
function pdfStr(str) {
  let s = "(";
  for (const c of toWin(str)) {
    if (c === 40 || c === 41 || c === 92) s += "\\" + String.fromCharCode(c);
    else if (c > 126) s += "\\" + c.toString(8).padStart(3, "0");
    else s += String.fromCharCode(c);
  }
  return s + ")";
}
function wrap(str, size, bold, maxW) {
  const lines = [];
  for (const para of String(str || "").split("\n")) {
    const words = para.split(/ +/);
    let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (textWidth(t, size, bold) <= maxW || !line) line = t; else { lines.push(line); line = w; }
      while (textWidth(line, size, bold) > maxW && line.length > 1) { // break very long words
        let k = line.length; while (k > 1 && textWidth(line.slice(0, k), size, bold) > maxW) k--;
        lines.push(line.slice(0, k)); line = line.slice(k);
      }
    }
    lines.push(line);
  }
  return lines;
}
function jpegInfo(buf) {
  if (!buf || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf))
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), comps: buf[i + 9] };
    i += 2 + len;
  }
  return null;
}

class Pdf {
  constructor() { this.pages = []; this.images = []; this.W = 612; this.H = 792; this.M = 50; this.addPage(); }
  addPage() { this.cur = []; this.pages.push(this.cur); this.y = this.M; }
  ensure(h) { if (this.y + h > this.H - this.M - 20) this.addPage(); }
  color(hex, stroke) { const n = parseInt(hex.slice(1), 16); return `${((n >> 16) & 255) / 255} ${((n >> 8) & 255) / 255} ${(n & 255) / 255} ${stroke ? "RG" : "rg"}`; }
  text(x, y, str, { size = 10, bold = false, color = "#1b201c", align = "left", page } = {}) {
    let tx = x; if (align === "right") tx = x - textWidth(str, size, bold); else if (align === "center") tx = x - textWidth(str, size, bold) / 2;
    (page || this.cur).push(`BT ${this.color(color)} /${bold ? "F2" : "F1"} ${size} Tf ${tx.toFixed(2)} ${(this.H - y).toFixed(2)} Td ${pdfStr(str)} Tj ET`);
  }
  line(x1, y1, x2, y2, color = "#d3d8d0", w = 0.75) { this.cur.push(`${this.color(color, true)} ${w} w ${x1} ${this.H - y1} m ${x2} ${this.H - y2} l S`); }
  circlePath(x, y, r) { const k = 0.5523 * r, Y = this.H - y, f = (v) => v.toFixed(2); return `${f(x + r)} ${f(Y)} m ${f(x + r)} ${f(Y + k)} ${f(x + k)} ${f(Y + r)} ${f(x)} ${f(Y + r)} c ${f(x - k)} ${f(Y + r)} ${f(x - r)} ${f(Y + k)} ${f(x - r)} ${f(Y)} c ${f(x - r)} ${f(Y - k)} ${f(x - k)} ${f(Y - r)} ${f(x)} ${f(Y - r)} c ${f(x + k)} ${f(Y - r)} ${f(x + r)} ${f(Y - k)} ${f(x + r)} ${f(Y)} c`; }
  circle(x, y, r, color, w = 1) { this.cur.push(`${this.color(color, true)} ${w} w ${this.circlePath(x, y, r)} S`); }
  disc(x, y, r, fill) { this.cur.push(`${this.color(fill)} ${this.circlePath(x, y, r)} f`); }
  rect(x, y, w, h, fill) { this.cur.push(`${this.color(fill)} ${x} ${this.H - y - h} ${w} ${h} re f`); }
  image(buf, x, y, w, h) {
    const info = jpegInfo(buf); if (!info) return false;
    const name = "Im" + (this.images.length + 1);
    this.images.push({ name, buf, info });
    this.cur.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(this.H - y - h).toFixed(2)} cm /${name} Do Q`);
    return true;
  }
  para(str, { size = 10, bold = false, color, indent = 0, gap = 1.35 } = {}) {
    const maxW = this.W - 2 * this.M - indent;
    for (const ln of wrap(str, size, bold, maxW)) { this.ensure(size * gap); this.y += size * gap; this.text(this.M + indent, this.y, ln, { size, bold, color }); }
  }
  table(cols, rows, { size = 9 } = {}) {
    const rowH = size * 1.9, x0 = this.M, full = this.W - 2 * this.M;
    const head = () => {
      this.ensure(rowH * 2);
      this.rect(x0, this.y + 4, full, rowH, "#0e5a61");
      let x = x0;
      cols.forEach((c) => { const tx = c.align === "right" ? x + c.w - 6 : x + 6; this.text(tx, this.y + 4 + rowH * 0.66, c.h, { size, bold: true, color: "#ffffff", align: c.align === "right" ? "right" : "left" }); x += c.w; });
      this.y += rowH + 4;
    };
    head();
    rows.forEach((r, ri) => {
      if (this.y + rowH > this.H - this.M - 20) { this.addPage(); head(); }
      if (ri % 2) this.rect(x0, this.y, full, rowH, "#f3f5f1");
      let x = x0;
      cols.forEach((c, ci) => {
        let v = r[ci] == null ? "" : String(r[ci]);
        while (v.length > 1 && textWidth(v, size, false) > c.w - 10) v = v.slice(0, -2) + "…";
        const tx = c.align === "right" ? x + c.w - 6 : x + 6;
        this.text(tx, this.y + rowH * 0.66, v, { size, align: c.align === "right" ? "right" : "left", color: r.color && ci === 0 ? r.color : undefined });
        x += c.w;
      });
      this.y += rowH;
    });
    this.y += 6;
  }
  build(footer) {
    const objs = []; // index = object number - 1
    const add = (b) => { objs.push(b); return objs.length; };
    const catalogId = add(null), pagesId = add(null);
    const f1 = add(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
    const f2 = add(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"));
    const imgIds = {};
    for (const im of this.images) {
      const cs = im.info.comps === 1 ? "/DeviceGray" : im.info.comps === 4 ? "/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]" : "/DeviceRGB";
      imgIds[im.name] = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${im.info.w} /Height ${im.info.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.buf.length} >>\nstream\n`), im.buf, Buffer.from("\nendstream")]));
    }
    const xobj = Object.keys(imgIds).length ? `/XObject << ${Object.entries(imgIds).map(([n, id]) => `/${n} ${id} 0 R`).join(" ")} >>` : "";
    const pageIds = [];
    this.pages.forEach((ops, i) => {
      if (footer) footer(this, ops, i + 1, this.pages.length);
      const content = zlib.deflateSync(Buffer.from(ops.join("\n"), "latin1"));
      const cid = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, Buffer.from("\nendstream")]));
      pageIds.push(add(Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> ${xobj} >> /Contents ${cid} 0 R >>`)));
    });
    objs[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
    objs[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    const info = add(Buffer.from(`<< /Title ${pdfStr(this.title || "Range Book export")} /Producer (Range Book) >>`));
    const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let pos = parts[0].length; const offsets = [];
    objs.forEach((b, i) => { offsets.push(pos); const head = Buffer.from(`${i + 1} 0 obj\n`), tail = Buffer.from("\nendobj\n"); parts.push(head, b, tail); pos += head.length + b.length + tail.length; });
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((o) => { xref += String(o).padStart(10, "0") + " 00000 n \n"; });
    parts.push(Buffer.from(xref + `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
    return Buffer.concat(parts);
  }
}

// target photos with their measured marks and group lines (shared by the full export and the trip report)
function pdfPhotos(pdf, ph, L, readPhoto, ACC, MUTED, fit) {
  const content = pdf.W - 2 * pdf.M;
    if (ph.length) {
      const sized = ph.map((p) => {
        const buf = readPhoto(p.file), info = buf && jpegInfo(buf);
        if (!info) return { p };
        const maxH = pdf.H - 2 * pdf.M - (fit ? 70 + 26 * Math.max(1, (normMeasure(p.measure) || { groups: [] }).groups.filter((g) => g.size != null).length) + (p.caption ? 30 : 0) : 90);
        let w = content, h = (info.h / info.w) * w;
        if (h > maxH) { h = maxH; w = (info.w / info.h) * h; }
        return { p, buf, w, h };
      });
      pdf.y += 18;
      // trip report: shrink the first photo to fit the rest of the page when there's a fair amount of room
      const cap0 = sized[0].p ? 26 * Math.max(1, (normMeasure(sized[0].p.measure) || { groups: [] }).groups.filter((g) => g.size != null).length) + (sized[0].p.caption ? 30 : 0) : 40;
      const room = pdf.H - pdf.M - 20 - pdf.y - 60 - cap0;
      if (fit && sized[0].buf && sized[0].h > room && room >= 230) { const k = room / sized[0].h; sized[0].w *= k; sized[0].h = room; }
      const first = sized[0].h || 20;
      if (pdf.y + 30 + first + 30 > pdf.H - pdf.M - 20) pdf.addPage();
      pdf.text(pdf.M, pdf.y + 4, "Targets", { size: 12, bold: true, color: ACC }); pdf.y += 12;
      for (const { p, buf, w, h } of sized) {
        if (!buf) { pdf.para(`(Photo "${p.caption || "untitled"}" couldn't be added to the PDF.)`, { size: 9, color: MUTED }); continue; }
        pdf.ensure(h + 30);
        const ix = pdf.M + (content - w) / 2, iy = pdf.y + 4;
        pdf.image(buf, ix, iy, w, h);
        const M = normMeasure(p.measure);
        if (M && M.groups.length) {
          const info = jpegInfo(buf), NW = info.w, NH = info.h;
          let ppi = null; if (M.a && M.b && M.scaleIn > 0) ppi = Math.hypot((M.a[0] - M.b[0]) * NW, (M.a[1] - M.b[1]) * NH) / M.scaleIn;
          const r = Math.max(2.5, ppi ? (M.dia / 2) * ppi * (w / NW) : 4);
          M.groups.forEach((t, k) => {
            const c = TG_COLORS[k % TG_COLORS.length];
            for (const q of t.shots || []) { pdf.circle(ix + q[0] * w, iy + q[1] * h, r, "#000000", 2.2); pdf.circle(ix + q[0] * w, iy + q[1] * h, r, c, 1.1); }
            if (t.aim) { const ax = ix + t.aim[0] * w, ay = iy + t.aim[1] * h; pdf.circle(ax, ay, r * 1.3, c, 1.1); pdf.line(ax - r * 2.2, ay, ax + r * 2.2, ay, c, 1.1); pdf.line(ax, ay - r * 2.2, ax, ay + r * 2.2, c, 1.1); }
          });
        }
        pdf.y += h + 8;
        if (M) M.groups.forEach((t, k) => {
          if (t.size == null) return;
          let s2 = `${tgName(t, k, L)}: ${t.n} shots, ${cs("in", t.size, 2)} center to center` + (t.moa != null ? `, ${t.moa.toFixed(2)} MOA at ${cs("yd", M.distance, 0)}` : "") + (t.mr != null ? `, mean radius ${cs("in", t.mr, 2)}` : "");
          if (t.dx != null && t.dy != null) s2 += `; center ${cs("in", Math.abs(t.dx), 2)} ${t.dx >= 0 ? "right" : "left"}, ${cs("in", Math.abs(t.dy), 2)} ${t.dy >= 0 ? "high" : "low"} of aim`;
          pdf.ensure(16); pdf.rect(pdf.M, pdf.y + 4, 8, 8, TG_COLORS[k % TG_COLORS.length]);
          pdf.para(s2 + ".", { size: 9, bold: true, indent: 12 });
        });
        if (p.caption) { pdf.para(p.caption, { size: 9, color: MUTED }); }
        pdf.y += 10;
      }
    }
}
function exportPdf(d, readPhoto) {
  useUnits(d);
  const pdf = new Pdf();
  const name = d.user.display_name || d.user.username;
  const today = localDay();
  pdf.title = `Range Book - ${name}`;
  const ACC = "#0e5a61", MUTED = "#5b645d", COLORS = ["#1f6fb4", "#c62828", "#2e8b3a", "#d06a00", "#7b4bb7", "#0e7f86", "#8a6a00", "#b0367a"];
  const loads = sortLoads(d.loads);
  const content = pdf.W - 2 * pdf.M;

  // cover header
  pdf.text(pdf.M, pdf.y + 10, "RANGE BOOK", { size: 11, bold: true, color: ACC });
  pdf.y += 40; pdf.text(pdf.M, pdf.y, `Reloading data for ${name}`, { size: 22, bold: true });
  pdf.y += 18; pdf.text(pdf.M, pdf.y, `Exported ${fmtDate(today)} · ${loads.length} load${loads.length === 1 ? "" : "s"} · ${d.photos.length} target photo${d.photos.length === 1 ? "" : "s"}`, { size: 10, color: MUTED });
  pdf.y += 14; pdf.line(pdf.M, pdf.y, pdf.W - pdf.M, pdf.y, ACC, 1.5); pdf.y += 10;

  // contents
  if (loads.length) {
    pdf.y += 8; pdf.text(pdf.M, pdf.y, "Loads in this report", { size: 12, bold: true, color: ACC }); pdf.y += 4;
    pdf.table([{ h: "Load", w: 190 }, { h: "Cartridge", w: 150 }, { h: "Groups", w: 60, align: "right" }, { h: "Last shot", w: content - 400 }],
      loads.map(({ data: L }) => { const ds = (L.groups || []).map((g) => g.date).filter(Boolean).sort(); return [L.title || "Untitled load", L.cartridge || "", (L.groups || []).length, ds.length ? fmtDate(ds[ds.length - 1]) : ""]; }));
  }

  for (const { id, data: L, sharedWith } of loads) {
    pdf.addPage();
    pdf.text(pdf.M, pdf.y + 8, (L.cartridge || "Load").toUpperCase(), { size: 9, bold: true, color: ACC });
    pdf.y += 30; pdf.text(pdf.M, pdf.y, L.title || "Untitled load", { size: 18, bold: true });
    if (sharedWith.length) { pdf.y += 14; pdf.text(pdf.M, pdf.y, "Shared with " + sharedWith.join(", "), { size: 9, color: MUTED }); }
    pdf.y += 12; pdf.line(pdf.M, pdf.y, pdf.W - pdf.M, pdf.y); pdf.y += 6;

    // recipe: two columns of label / value
    const recipe = [["Bullet", comp(L.bullet)], ["Bullet weight", L.bulletGrains != null ? L.bulletGrains + " gr" : ""], ["Ballistic coefficient", L.bc != null ? String(L.bc) + " (" + (L.bcm === "G7" ? "G7" : "G1") + ")" : ""], ["Gun", rifleName(L, d)], ["Max charge", numv(L.maxCharge) != null ? numv(L.maxCharge) + " gr" : ""], ["Primer", comp(L.primer)], ["Powder", comp(L.powder)],
      ["Brass", comp(L.case)], ["Case length", L.caseLength != null ? cs("dim", L.caseLength, METRIC ? 2 : 3) : ""], ["COAL", L.coal != null ? cs("dim", L.coal, METRIC ? 2 : 3) : ""]].filter((r) => r[1]);
    const colW = content / 2;
    for (let i = 0; i < recipe.length; i += 2) {
      pdf.ensure(28); pdf.y += 14;
      [recipe[i], recipe[i + 1]].forEach((r, k) => {
        if (!r) return;
        const x = pdf.M + k * colW;
        pdf.text(x, pdf.y, r[0].toUpperCase(), { size: 7.5, bold: true, color: MUTED });
        let v = r[1]; while (v.length > 1 && textWidth(v, 10, false) > colW - 12) v = v.slice(0, -2) + "…";
        pdf.text(x, pdf.y + 12, v, { size: 10 });
      });
      pdf.y += 14;
    }
    if (L.notes) { pdf.y += 10; pdf.ensure(30); pdf.text(pdf.M, pdf.y + 4, "NOTES", { size: 7.5, bold: true, color: MUTED }); pdf.y += 2; pdf.para(L.notes, { size: 9.5 }); }

    // results
    const groups = L.groups || [];
    if (groups.length) {
      pdf.y += 16; pdf.ensure(60); pdf.text(pdf.M, pdf.y, "Results", { size: 12, bold: true, color: ACC }); pdf.y += 2;
      const anyOver = groups.some((g) => maxFlag(g, L) === "OVER MAX");
      const lname = ladderNames(L), manyL = new Set(lname.values()).size > 1, gLabel = (g, i) => (manyL ? lname.get(g) + " · " : "") + gName(g, i);
      const rows = groups.map((g, i) => { const s = stats(g, L), m = groupMoa(g), f = maxFlag(g, L); const r = [gLabel(g, i) + (f === "OVER MAX" ? " (over max)" : "") + (pressText(g) ? " (!)" : ""), fmtDate(g.date), s ? s.n : 0, s ? cv("fps", s.avgT, 0) : "", s ? cv("fps", s.sd).toFixed(1) : "", s ? cv("fps", s.es, 0) : "", s && s.me != null ? cv("ftlb", s.me, 0).toLocaleString("en-US") : "", m != null ? m.toFixed(2) : "", groupMr(g) != null ? groupMr(g).toFixed(2) : ""]; r.color = f === "OVER MAX" ? "#c62828" : COLORS[i % COLORS.length]; return r; });
      pdf.table([{ h: "Group", w: 130 }, { h: "Date", w: 72 }, { h: "Shots", w: 36, align: "right" }, { h: "Avg " + ul("fps"), w: 48, align: "right" }, { h: "SD", w: 36, align: "right" }, { h: "ES", w: 36, align: "right" }, { h: "Energy", w: 48, align: "right" }, { h: "Group MOA", w: 56, align: "right" }, { h: "Mean rad.", w: content - 462, align: "right" }], rows);
      pdf.text(pdf.M, pdf.y + 2, "SD is the population standard deviation. Energy (" + ul("ftlb") + ") uses the recipe's bullet weight. Mean rad. is the mean radius in MOA, from a measured target photo." + (anyOver ? " Red groups are over the max charge." : ""), { size: 7.5, color: MUTED }); pdf.y += 8;
      { const ps = groups.map((g, i) => [gLabel(g, i), pressText(g)]).filter(([, t]) => t); if (ps.length) { pdf.para("(!) Pressure signs noted: " + ps.map(([n, t]) => n + ": " + t).join("; ") + ".", { size: 7.5, color: "#b45309" }); pdf.y += 4; } }
      const withShots = groups.map((g, i) => ({ g, i, s: stats(g, L) })).filter((o) => o.s);
      if (withShots.length) {
        pdf.y += 12; pdf.ensure(40); pdf.text(pdf.M, pdf.y, "Shot velocities (" + ul("fps") + ")", { size: 12, bold: true, color: ACC });
        for (const { g, i, s } of withShots) {
          pdf.y += 6; pdf.ensure(28);
          pdf.y += 12; pdf.text(pdf.M, pdf.y, gLabel(g, i), { size: 9.5, bold: true, color: COLORS[i % COLORS.length] });
          pdf.para(s.shots.map((v, j) => `${j + 1}: ${cv("fps", v, 0)}`).join(" · "), { size: 9, indent: 10, gap: 1.4 });
        }
      }
    }
    // photos
    pdfPhotos(pdf, d.photos.filter((p) => p.load_id === id), L, readPhoto, ACC, MUTED);
  }

  // brass + calculator loads
  const brass = d.brass && Array.isArray(d.brass.rows) ? d.brass.rows : [];
  const calc = d.calc && Array.isArray(d.calc.loads) ? d.calc.loads : [];
  const rifles = d.rifles && Array.isArray(d.rifles.rows) ? d.rifles.rows : [];
  const cr = compRows(d);
  const tr = tripRows(d);
  const nts = d.notes && Array.isArray(d.notes.rows) ? d.notes.rows.filter((n) => (n.title || "").trim() || (n.body || "").trim()) : [];
  if (brass.length || calc.length || rifles.length || cr.length || tr.length || nts.length) pdf.addPage();
  if (nts.length) {
    pdf.y += 10; pdf.text(pdf.M, pdf.y, "Reloading notes", { size: 16, bold: true }); pdf.y += 4;
    nts.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0)).forEach((n) => {
      pdf.y += 12; pdf.ensure(40); pdf.y += 10;
      pdf.text(pdf.M, pdf.y, (n.title || "").trim() || String(n.body || "").trim().split("\n")[0].slice(0, 80) || "Untitled note", { size: 11, bold: true, color: ACC });
      if (n.updated) pdf.text(pdf.W - pdf.M, pdf.y, fmtDate(localDay(new Date(n.updated))), { size: 8, color: MUTED, align: "right" });
      String(n.body || "").split("\n").forEach((ln) => { if (ln.trim()) pdf.para(ln, { size: 9.5 }); else pdf.y += 6; });
    });
    pdf.y += 8;
  }
  if (tr.length) {
    pdf.y += 10; pdf.text(pdf.M, pdf.y, "Range trips", { size: 16, bold: true }); pdf.y += 6;
    pdf.table([{ h: "Date", w: 62 }, { h: "Load", w: 130 }, { h: "Place", w: 95 }, { h: METRIC ? "m" : "Yd", w: 34, align: "right" }, { h: "Rounds", w: 42, align: "right" }, { h: "Best group", w: 80 }, { h: "Notes", w: content - 443 }],
      tr.map(({ t, load, best }) => [t.date ? fmtDate(t.date) : "", load, t.place || "", numv(t.distance) != null ? cv("yd", t.distance, 0) : "", t.rounds ?? "", best ? cs("in", best.size, 2) + (best.moa != null ? " (" + best.moa.toFixed(2) + " MOA)" : "") : "", [t.temp != null && t.temp !== "" ? cs("F", t.temp, 0) : "", t.wind || "", t.avgVel ? cs("fps", t.avgVel, 0) + (t.sd ? " SD " + cv("fps", t.sd, 1) : "") : "", (t.notes || "").replace(/\s+/g, " ")].filter(Boolean).join(" · ")]));
    pdf.y += 8;
  }
  if (cr.length) {
    pdf.y += 10; pdf.text(pdf.M, pdf.y, "Components", { size: 16, bold: true }); pdf.y += 6;
    pdf.table([{ h: "Kind", w: 50 }, { h: "Component", w: 190 }, { h: "Details", w: content - 300 }, { h: "Loads", w: 60, align: "right" }],
      cr.map((r) => [r[0], [r[1], r[2]].filter(Boolean).join(" ") + (r[4] ? " " + r[4] + " gr" : ""), [r[3] && r[3].v ? (METRIC ? r[3].v + " mm" : String(r[3].v).replace(/^0\./, ".") + " cal") : "", r[5] && r[5].v != null ? "BC " + r[5].v + " " + r[6] : "", r[7] ? r[7] + " " + ul("dim") + " long" : "", r[8], r[11] != null ? r[11] + " on hand" : ""].filter(Boolean).join(" · "), r[9] ?? ""]));
    pdf.y += 8;
  }
  if (rifles.length) {
    pdf.y += 10; pdf.text(pdf.M, pdf.y, "Guns", { size: 16, bold: true }); pdf.y += 6;
    pdf.table([{ h: "Gun", w: 140 }, { h: "Serial number", w: 95 }, { h: "Barrel", w: 60 }, { h: "Twist", w: 45 }, { h: "Sight ht", w: 45, align: "right" }, { h: "Notes", w: content - 385 }], rifles.map((r) => [r.name, r.serial || "", numv(r.barrel) != null ? cs("dim", r.barrel, 0) : r.barrel, twistTxt(numv(r.twist) != null && METRIC ? cs("dim", r.twist, 0) : r.twist), numv(r.sightHeight) != null ? cs("in", r.sightHeight, METRIC ? 1 : 2) : "", (r.notes || "").replace(/\s+/g, " ")]));
    pdf.y += 8;
  }
  if (brass.length) {
    pdf.y += 10; pdf.ensure(60); pdf.text(pdf.M, pdf.y, "Brass notes", { size: 16, bold: true }); pdf.y += 6;
    pdf.table([{ h: "Manufacturer", w: 250 }, { h: "Headstamp", w: 130 }, { h: "Rating", w: content - 380 }], brass.map((r) => [r.mfr, r.headstamp, r.rating]));
  }
  if (calc.length) {
    pdf.y += 14; pdf.ensure(60); pdf.text(pdf.M, pdf.y, "Trajectory calculator loads", { size: 16, bold: true }); pdf.y += 6;
    pdf.table([{ h: "Name", w: 170 }, { h: "Bullet gr", w: 52, align: "right" }, { h: "Velocity", w: 55, align: "right" }, { h: "BC", w: 50, align: "right" }, { h: "Sight ht", w: 50, align: "right" }, { h: "Zeros (" + ul("yd") + ")", w: content - 377 }],
      calc.map((c) => [c.name + (calcRifle(c, d) ? " (" + calcRifle(c, d) + ")" : ""), c.w, cs("fps", c.mv, 0), c.bc != null ? c.bc + (c.bcm === "G7" ? " G7" : "") : "", numv(c.sh) != null ? cs("in", c.sh, METRIC ? 1 : 2) : "", (c.z || []).filter((x) => x != null).map((z) => cv("yd", z, 0)).join(", ") + (c.lr ? "  (long range)" : "")]));
  }

  return pdf.build((p, ops, n, total) => {
    p.cur = ops;
    p.line(p.M, p.H - 34, p.W - p.M, p.H - 34);
    p.text(p.M, p.H - 22, `Range Book · ${name} · exported ${fmtDate(today)}`, { size: 8, color: MUTED, page: ops });
    p.text(p.W - p.M, p.H - 22, `Page ${n} of ${total}`, { size: 8, color: MUTED, align: "right", page: ops });
  });
}

/* ---------- printable Range Book targets (vector PDF, Letter or 11 x 17, inches → points) ---------- */
const targetFmt = (T, L) => (T.formats && T.formats[L.fmt || "letter"]) || { page: T.page || [8.5, 11], fid: T.fid, fidSize: T.fidSize, grid: T.grid };
function targetPdf(T, layoutId, fill, du) {
  du = du === "m" ? "m" : "yd";
  const L = T.layouts.find((x) => x.id === layoutId);
  if (!L) return null;
  const F = targetFmt(T, L), [PW, PH] = F.page, SH = F.short != null ? F.short : PW > 9 ? "11 x 17" : "";
  const pdf = new Pdf(), I = 72, X = (v) => v * I;
  // a target taped together from two Letter pages: each page is printed sideways and shows its own strip of the sheet
  const parts = F.pages || null;
  pdf.W = PW * I; pdf.H = parts ? 8.5 * I : PH * I;
  pdf.title = "Range Book target - " + L.name + (SH ? " (" + SH + ")" : "");
  const GRID = "#8fa2b5", INK = "#111111";
  const sheet = () => {
  // 1-inch squares; every aim point sits in the middle of one
  const [gx0, gy0, gx1, gy1] = F.grid;
  for (let x = gx0; x <= gx1 + 1e-9; x += 1) pdf.line(X(x), X(gy0), X(x), X(gy1), GRID, 0.75);
  for (let y = gy0; y <= gy1 + 1e-9; y += 1) pdf.line(X(gx0), X(y), X(gx1), X(y), GRID, 0.75);
  // corner squares the app looks for (top-left one is hollow so it knows which way is up)
  const fs = F.fidSize;
  F.fid.forEach(([cx, cy], i) => {
    pdf.rect(X(cx - fs / 2), X(cy - fs / 2), X(fs), X(fs), INK);
    if (i === 0) pdf.rect(X(cx - fs / 5), X(cy - fs / 5), X((fs * 2) / 5), X((fs * 2) / 5), "#ffffff");
  });
  // header, between the top squares
  // the side marks that tell the app this is a two-page target
  if (F.marked && T.mark) T.mark.uv.forEach(([u, v]) => { const mx = F.fid[0][0] + u * (F.fid[1][0] - F.fid[0][0]), my = F.fid[0][1] + v * (F.fid[3][1] - F.fid[0][1]), ms = T.mark.size; pdf.rect(X(mx - ms / 2), X(my - ms / 2), X(ms), X(ms), INK); });
  const hx = Math.max(1.6, F.fid[0][0] + fs / 2 + 0.3);
  pdf.text(X(hx), X(0.6), "RANGE BOOK", { size: 13, bold: true, color: INK });
  pdf.text(X(PW - hx), X(0.6), L.name + (SH ? " · " + SH : ""), { size: 10, color: INK, align: "right" });
  if (fill) {
    // filled in from a range trip: the values in bold after each label
    const FS = PW > 9 ? 9.5 : 8.5;
    const room = X(PW - 2 * hx), parts = [["Load", fill.load], ["Date", fill.date], ["Distance", fill.dist ? fill.dist + " " + du : ""], ["Gun", fill.gun]].filter((q) => q[1]);
    let x = X(hx);
    for (const [k, v0] of parts) {
      let v = String(v0);
      const lw = textWidth(k + " ", FS, false);
      const cap = k === "Load" ? room * 0.36 : k === "Gun" ? room * 0.24 : room;
      while (v.length > 3 && (textWidth(v, FS, true) > cap || x + lw + textWidth(v, FS, true) > X(hx) + room)) v = v.slice(0, -4) + "...";
      if (x + lw + textWidth(v, FS, true) > X(hx) + room) break;
      pdf.text(x, X(0.98), k, { size: FS, color: "#444444" });
      pdf.text(x + lw, X(0.98), v, { size: FS, bold: true, color: INK });
      x += lw + textWidth(v, FS, true) + 12;
    }
  } else pdf.text(X(hx), X(0.98), "Load ____________________   Date _________   Distance _____ " + du + (PW > 9 ? "   Gun ______________________" : ""), { size: 9.5, color: INK });
  // optional scoring rings around a single big aim point
  (L.rings || []).forEach((r) => L.aims.forEach((a) => pdf.circle(X(a.x), X(a.y), X(r), "#8a9aa8", 0.6)));
  // aim points: a round bullseye ring with a crosshair, so they never look like the square corner marks
  L.aims.forEach((a, k) => {
    const cx = X(a.x), cy = X(a.y), arm = X(0.95), gap = X(0.14);
    pdf.disc(cx, cy, X(0.5), "#f2a3a3");
    pdf.circle(cx, cy, X(0.5), INK, 1.1);
    pdf.circle(cx, cy, X(0.25), INK, 0.5);
    pdf.line(cx - arm, cy, cx - gap, cy, INK, 0.5); pdf.line(cx + gap, cy, cx + arm, cy, INK, 0.5);
    pdf.line(cx, cy - arm, cx, cy - gap, INK, 0.5); pdf.line(cx, cy + gap, cx, cy + arm, INK, 0.5);
    pdf.disc(cx, cy, X(0.06), INK);
    const lx = X(a.cell[0] + 0.12), ly = X(a.cell[1] + 0.3);
    pdf.text(lx, ly, String(k + 1), { size: 14, bold: true, color: INK });
    if (L.aims.length > 1) pdf.text(lx + 16 + (k >= 9 ? 8 : 0), ly - 1, "_______ gr", { size: 8.5, color: "#444444" });
  });
  (L.rings || []).forEach((r) => L.aims.forEach((a) => pdf.text(X(a.x + r) + 2, X(a.y) - 3, r + '"', { size: 7.5, color: "#5b6b78" })));
  // footer, between the bottom squares: how to use + a 1 inch check
  const fy = parts ? F.fid[3][1] + 0.35 : PH - 0.45;
  pdf.text(X(hx), X(fy - 0.25), parts ? "Print both pages at Actual size (100%) on Letter paper. Photograph the whole target with all 4 squares showing." : "Print at Actual size (100%)" + (PW > 9 ? " on 11 x 17 (Tabloid / Ledger) paper" : "") + ". Photograph the whole page with all 4 squares showing.", { size: 7.5, color: INK });
  pdf.line(X(hx), X(fy), X(hx + 1), X(fy), INK, 0.8); pdf.line(X(hx), X(fy - 0.07), X(hx), X(fy + 0.07), INK, 0.8); pdf.line(X(hx + 1), X(fy - 0.07), X(hx + 1), X(fy + 0.07), INK, 0.8);
  pdf.text(X(hx + 1.1), X(fy + 0.03), "this line should measure exactly 1 inch", { size: 7.5, color: "#444444" });
  };
  if (!parts) { sheet(); return pdf.build(null); }
  const PG = 8.5 * I;
  parts.forEach((pt, i) => {
    if (i) pdf.addPage();
    const top = pt.show != null ? pt.show : pt.from, bot = Math.min(pt.to, pt.from + 8.5);
    // only this page's strip of the sheet, moved up to the top of the page
    pdf.cur.push(`q 0 ${(PG - X(bot - pt.from)).toFixed(2)} ${pdf.W} ${X(bot - top).toFixed(2)} re W n 1 0 0 1 0 ${X(pt.from).toFixed(2)} cm`);
    sheet();
    pdf.cur.push("Q");
    const Y = (v) => X(v - pt.from);
    if (i === 0) {
      // the cut line along the bottom of page 1
      for (let x = 0.3; x < PW - 0.3; x += 0.3) pdf.line(X(x), Y(pt.to), X(Math.min(x + 0.17, PW - 0.3)), Y(pt.to), INK, 0.9);
      pdf.text(X(PW / 2), Y(pt.to) + 11, "PAGE 1 OF 2 - CUT ALONG THE DASHED LINE, THEN LAY THIS PAGE OVER THE GRAY STRIP AT THE TOP OF PAGE 2", { size: 7, bold: true, color: "#444444", align: "center" });
    } else {
      // the strip page 1 covers: line up its cut edge with the line, and its grid lines with these ticks
      pdf.rect(0, 0, pdf.W, Y(top), "#e6e9ec");
      pdf.text(X(PW / 2), Y(top) - 14, "PAGE 2 OF 2 - TAPE PAGE 1 OVER THIS STRIP: ITS CUT EDGE ON THE LINE, ITS GRID LINES ON THESE TICKS", { size: 7, bold: true, color: "#444444", align: "center" });
      const [gx0, , gx1] = F.grid;
      for (let x = gx0; x <= gx1 + 1e-9; x += 1) pdf.line(X(x), Y(top) - 9, X(x), Y(top), INK, 0.9);
      pdf.line(X(0.3), Y(top), X(PW - 0.3), Y(top), INK, 1.1);
    }
  });
  return pdf.build(null);
}


/* ---------- one range trip as a printable report ---------- */
function tripReportPdf(d, t, photos, readPhoto) {
  useUnits(d);
  const pdf = new Pdf(), ACC = "#0e5a61", MUTED = "#5b645d", content = pdf.W - 2 * pdf.M;
  const calc = d.calc && Array.isArray(d.calc.loads) ? d.calc.loads : [];
  const T = calc.find((c) => c.id === t.trajId) || {};
  const rifle = calcRifle(T, d);
  const head = (t.date ? fmtDate(t.date) : "Range trip") + (t.place ? " · " + t.place : "");
  pdf.title = "Range trip - " + head;
  pdf.text(pdf.M, pdf.y + 10, "RANGE BOOK · RANGE TRIP", { size: 9, bold: true, color: ACC });
  pdf.y += 36; pdf.text(pdf.M, pdf.y, head, { size: 20, bold: true });
  pdf.y += 16; pdf.text(pdf.M, pdf.y, [T.name || "", T.cart || "", rifle].filter(Boolean).join(" · "), { size: 10, color: MUTED });
  pdf.y += 12; pdf.line(pdf.M, pdf.y, pdf.W - pdf.M, pdf.y, ACC, 1.5); pdf.y += 4;
  const v = (x, u) => (x == null || x === "" ? "" : String(x) + (u || ""));
  const facts = [["Load", T.name || ""], ["Gun", rifle], ["Bullet", [T.w ? T.w + " gr" : "", T.bc ? "BC " + T.bc + (T.bcm === "G7" ? " G7" : " G1") : ""].filter(Boolean).join(", ")], ["Distance", numv(t.distance) != null ? cs("yd", t.distance, 0) : ""],
    ["Rounds fired", v(t.rounds)], ["Temperature", numv(t.temp) != null ? cs("F", t.temp, 0) : ""], ["Wind", t.wind || ""], ["Average velocity", t.avgVel ? cs("fps", t.avgVel, 0) + (t.sd != null && t.sd !== "" ? ", SD " + cv("fps", t.sd, 1) : "") : ""],
    ["Calculator velocity", T.mv ? cs("fps", T.mv, 0) : ""],
    ["Cold-bore shot", t.cold && (t.cold.x || t.cold.y) ? [t.cold.x ? cs("in", Math.abs(t.cold.x), 2) + (t.cold.x > 0 ? " right" : " left") : "", t.cold.y ? cs("in", Math.abs(t.cold.y), 2) + (t.cold.y > 0 ? " high" : " low") : ""].filter(Boolean).join(", ") + (t.cold.bore ? " (" + t.cold.bore + " barrel)" : "") : ""]].filter((r) => r[1]);
  const colW = content / 2;
  for (let i = 0; i < facts.length; i += 2) {
    pdf.ensure(28); pdf.y += 14;
    [facts[i], facts[i + 1]].forEach((r, k) => {
      if (!r) return;
      const x = pdf.M + k * colW;
      pdf.text(x, pdf.y, r[0].toUpperCase(), { size: 7.5, bold: true, color: MUTED });
      let val = r[1]; while (val.length > 1 && textWidth(val, 10.5, false) > colW - 12) val = val.slice(0, -2) + "…";
      pdf.text(x, pdf.y + 12, val, { size: 10.5 });
    });
    pdf.y += 14;
  }
  if (t.notes) { pdf.y += 12; pdf.ensure(30); pdf.text(pdf.M, pdf.y + 4, "NOTES", { size: 7.5, bold: true, color: MUTED }); pdf.y += 2; pdf.para(t.notes, { size: 10 }); }
  const S = (t.strings || []).map((x, i) => ({ x, i, s: stats({ shots: x.shots }, { bulletGrains: T.w }) })).filter((o) => o.s);
  if (S.length) {
    pdf.y += 24; pdf.ensure(60); pdf.text(pdf.M, pdf.y, "Chronograph", { size: 12, bold: true, color: ACC }); pdf.y += 2;
    pdf.table([{ h: "String", w: 170 }, { h: "Date", w: 80 }, { h: "Shots", w: 45, align: "right" }, { h: "Avg " + ul("fps"), w: 55, align: "right" }, { h: "SD", w: 45, align: "right" }, { h: "ES", w: 45, align: "right" }, { h: "Energy", w: content - 440, align: "right" }],
      S.map(({ x, i, s }) => [x.name || "String " + (i + 1), x.date ? fmtDate(x.date) : "", s.n, cv("fps", s.avgT, 0), cv("fps", s.sd).toFixed(1), cv("fps", s.es, 0), s.me != null ? cs("ftlb", s.me, 0) : ""]));
    for (const { x, i, s } of S) { pdf.y += 4; pdf.ensure(24); pdf.y += 10; pdf.text(pdf.M, pdf.y, x.name || "String " + (i + 1), { size: 9, bold: true }); pdf.para(s.shots.map((q, j) => `${j + 1}: ${cv("fps", q, 0)}`).join(" · "), { size: 9, indent: 10, gap: 1.4 }); }
  }
  if (photos.length) pdfPhotos(pdf, photos, null, readPhoto, ACC, MUTED, true);
  else { pdf.y += 16; pdf.para("No target photos on this trip.", { size: 9, color: MUTED }); }
  return pdf.build((p, ops, n, total) => {
    p.cur = ops;
    p.line(p.M, p.H - 34, p.W - p.M, p.H - 34);
    p.text(p.M, p.H - 22, `Range Book · range trip · ${head}`, { size: 8, color: MUTED, page: ops });
    p.text(p.W - p.M, p.H - 22, `Page ${n} of ${total}`, { size: 8, color: MUTED, align: "right", page: ops });
  });
}

/* ---------- guns only (Guns & Ammo → Guns: insurance list, round counts, photos) ---------- */
function gunRounds(r, d) {
  const calc = d.calc && Array.isArray(d.calc.loads) ? d.calc.loads : [];
  const trips = d.trips && Array.isArray(d.trips.trips) ? d.trips.trips : [];
  const tids = new Set(calc.filter((c) => c.rifleId === r.id).map((c) => c.id));
  const from = r.barrelSince || "", cl = r.cleaned || "";
  let trip = 0, dev = 0, since = 0;
  trips.forEach((t) => { if (!tids.has(t.trajId)) return; const dt = t.date || ""; if (from && dt && dt < from) return; const n = numv(t.rounds) || 0; trip += n; if (cl && dt > cl) since += n; });
  d.loads.forEach(({ data: L }) => { if (L.rifleId !== r.id) return; (L.groups || []).forEach((g) => { const dt = g.date || ""; if (from && dt && dt < from) return; const n = (g.shots || []).filter((x) => Number(x) > 0).length; dev += n; if (cl && dt > cl) since += n; }); });
  const base = numv(r.roundsBase) || 0, total = base + trip + dev, life = numv(r.barrelLife);
  return { base, trip, dev, total, life, pct: life > 0 ? Math.round((total / life) * 100) : null, since: cl ? since : null };
}
const gunList = (d) => (d.rifles && Array.isArray(d.rifles.rows) ? d.rifles.rows : []).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true }));
const twistTxt = (t) => (t == null || t === "" ? "" : /^\s*1\s*:/.test(String(t)) ? String(t) : "1:" + t);
function gunsXlsx(d) {
  useUnits(d);
  const calc = d.calc && Array.isArray(d.calc.loads) ? d.calc.loads : [];
  const rows = gunList(d).map((r) => {
    const rc = gunRounds(r, d), uses = d.loads.filter((l) => l.data.rifleId === r.id).length + calc.filter((c) => c.rifleId === r.id).length;
    return [r.name || "", r.serial || "", numv(r.barrel) != null ? cv("dim", r.barrel, METRIC ? 0 : null) : r.barrel || "", twistTxt(numv(r.twist) != null && METRIC ? cv("dim", r.twist, 0) : r.twist), cv("in", r.sightHeight, METRIC ? 2 : null), rc.total || null, rc.life, rc.pct, r.barrelSince ? { date: r.barrelSince } : null, r.cleaned ? { date: r.cleaned } : null, numv(r.cleanEvery), rc.since, uses || null, (d.gunPhotos || []).filter((p) => p.rifle_id === r.id).length || null, r.notes || ""];
  });
  return buildXlsx([{ name: "Guns", selected: true, rows, cols: [{ h: "Gun", w: 28 }, { h: "Serial number", w: 18 }, { h: "Barrel (" + ul("dim") + ")", w: 11 }, { h: "Twist" + (METRIC ? " (mm)" : ""), w: 9 }, { h: "Sight height (" + ul("in") + ")", w: 15 }, { h: "Round count", w: 12 }, { h: "Barrel life", w: 11 }, { h: "Barrel life used (%)", w: 17 }, { h: "Barrel fitted", w: 13 }, { h: "Last cleaned", w: 13 }, { h: "Clean every", w: 11 }, { h: "Rounds since cleaning", w: 18 }, { h: "Loads using it", w: 13 }, { h: "Photos", w: 8 }, { h: "Notes", w: 60, s: 5 }] }]);
}
function gunsPdf(d, readPhoto) {
  useUnits(d);
  const pdf = new Pdf(), ACC = "#0e5a61", MUTED = "#5b645d", content = pdf.W - 2 * pdf.M;
  const name = d.user.display_name || d.user.username, today = localDay(), guns = gunList(d), photos = d.gunPhotos || [];
  pdf.title = `Guns - ${name}`;
  pdf.text(pdf.M, pdf.y + 10, "RANGE BOOK", { size: 11, bold: true, color: ACC });
  pdf.y += 40; pdf.text(pdf.M, pdf.y, `Guns of ${name}`, { size: 22, bold: true });
  pdf.y += 18; pdf.text(pdf.M, pdf.y, `Exported ${fmtDate(today)} · ${guns.length} gun${guns.length === 1 ? "" : "s"} · ${photos.length} photo${photos.length === 1 ? "" : "s"}`, { size: 10, color: MUTED });
  pdf.y += 14; pdf.line(pdf.M, pdf.y, pdf.W - pdf.M, pdf.y, ACC, 1.5); pdf.y += 10;
  if (!guns.length) { pdf.y += 10; pdf.para("No guns yet.", { size: 10, color: MUTED }); }
  else {
    pdf.table([{ h: "Gun", w: 170 }, { h: "Serial number", w: 110 }, { h: "Barrel", w: 55 }, { h: "Twist", w: 50 }, { h: "Rounds", w: 55, align: "right" }, { h: "Photos", w: content - 440, align: "right" }],
      guns.map((r) => [r.name || "Unnamed gun", r.serial || "", numv(r.barrel) != null ? cs("dim", r.barrel, 0) : r.barrel ? r.barrel + " in" : "", twistTxt(numv(r.twist) != null && METRIC ? cs("dim", r.twist, 0) : r.twist), gunRounds(r, d).total || "", photos.filter((p) => p.rifle_id === r.id).length || ""]));
  }
  for (const r of guns) {
    pdf.addPage();
    const rc = gunRounds(r, d);
    pdf.text(pdf.M, pdf.y + 8, "GUN", { size: 9, bold: true, color: ACC });
    pdf.y += 30; pdf.text(pdf.M, pdf.y, r.name || "Unnamed gun", { size: 18, bold: true });
    pdf.y += 12; pdf.line(pdf.M, pdf.y, pdf.W - pdf.M, pdf.y); pdf.y += 6;
    const facts = [["Serial number", r.serial || ""], ["Barrel", numv(r.barrel) != null ? cs("dim", r.barrel, 0) : r.barrel ? r.barrel + " in" : ""], ["Twist", twistTxt(numv(r.twist) != null && METRIC ? cs("dim", r.twist, 0) : r.twist)], ["Sight height", numv(r.sightHeight) != null ? cs("in", r.sightHeight, METRIC ? 1 : 2) : ""],
      ["Round count", rc.total ? rc.total.toLocaleString("en-US") + (rc.base ? ` (${rc.base.toLocaleString("en-US")} before Range Book)` : "") : ""], ["Barrel life", rc.life ? rc.life.toLocaleString("en-US") + " rounds" + (rc.pct != null ? `, ${rc.pct}% used` : "") : ""],
      ["Barrel fitted", r.barrelSince ? fmtDate(r.barrelSince) : ""], ["Last cleaned", r.cleaned ? fmtDate(r.cleaned) + (rc.since != null ? ` (${rc.since} rounds since)` : "") : ""], ["Clean every", numv(r.cleanEvery) ? numv(r.cleanEvery) + " rounds" : ""]].filter((x) => x[1]);
    const colW = content / 2;
    for (let i = 0; i < facts.length; i += 2) {
      pdf.ensure(28); pdf.y += 14;
      [facts[i], facts[i + 1]].forEach((x, k) => {
        if (!x) return; const px = pdf.M + k * colW;
        pdf.text(px, pdf.y, x[0].toUpperCase(), { size: 7.5, bold: true, color: MUTED });
        let v = x[1]; while (v.length > 1 && textWidth(v, 10.5, false) > colW - 12) v = v.slice(0, -2) + "…";
        pdf.text(px, pdf.y + 12, v, { size: 10.5 });
      });
      pdf.y += 14;
    }
    if (r.notes) { pdf.y += 12; pdf.ensure(30); pdf.text(pdf.M, pdf.y + 4, "NOTES", { size: 7.5, bold: true, color: MUTED }); pdf.y += 2; pdf.para(r.notes, { size: 9.5 }); }
    // photos, two across
    const ph = photos.filter((p) => p.rifle_id === r.id).map((p) => { const buf = readPhoto(p.file), info = buf && jpegInfo(buf); return info ? { buf, info } : null; }).filter(Boolean);
    if (ph.length) {
      pdf.y += 22; pdf.ensure(60); pdf.text(pdf.M, pdf.y, "Photos", { size: 12, bold: true, color: ACC }); pdf.y += 8;
      const gap = 12, cw = (content - gap) / 2, maxH = 230;
      for (let i = 0; i < ph.length; i += 2) {
        const pair = ph.slice(i, i + 2).map((o) => { let w = cw, h = (o.info.h / o.info.w) * w; if (h > maxH) { h = maxH; w = (o.info.w / o.info.h) * h; } return { ...o, w, h }; });
        const rowH = Math.max(...pair.map((o) => o.h));
        pdf.ensure(rowH + 12);
        pair.forEach((o, k) => pdf.image(o.buf, pdf.M + k * (cw + gap) + (cw - o.w) / 2, pdf.y, o.w, o.h));
        pdf.y += rowH + gap;
      }
    }
  }
  return pdf.build((p, ops, n, total) => {
    p.cur = ops;
    p.line(p.M, p.H - 34, p.W - p.M, p.H - 34);
    p.text(p.M, p.H - 22, `Range Book · guns of ${name} · exported ${fmtDate(today)}`, { size: 8, color: MUTED, page: ops });
    p.text(p.W - p.M, p.H - 22, `Page ${n} of ${total}`, { size: 8, color: MUTED, align: "right", page: ops });
  });
}

module.exports = { exportXlsx, exportPdf, targetPdf, tripReportPdf, gunsXlsx, gunsPdf, zip };

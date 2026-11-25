"use strict";
/* Sharing a Shooting profile or a range trip with other people on this server (2.52).
   The owner picks Everyone or some people; what they see is built here, on the server, from the owner's own data, and only
   from the fields listed below. Nothing else leaves the account: no serial numbers, no gun or optic photos, no notes (unless
   the owner ticks them for a trip), no prices, no other gear, and never where the weather was taken. */

const PROFILE_KEYS = ["name", "cart", "w", "mv", "bc", "bcm", "cal", "calUnit", "blen", "tip", "twist", "sh", "z", "zpb", "adj", "lr", "temp", "alt",
  "wind", "wclock", "wbr", "step", "stepM", "angle", "mvtemp", "tsens", "pbr", "eff", "ret", "dope", "sg"];
const GUN_KEYS = ["mfr", "model", "type", "action", "cartridge", "barrel", "twist", "sightHeight", "threaded"];
const OPTIC_KEYS = ["mfr", "model", "kind", "fp", "unit", "click", "magMin", "magMax", "obj", "reticle", "turret", "dot", "ring", "magnifier", "sfpTrue"];
const AMMO_KEYS = ["mfr", "name", "bullet", "weight", "cartridge", "bc", "bcm", "boxVel"];
const WX_KEYS = ["tempF", "wind", "dir", "gust", "rh", "hpa", "dAlt", "at", "src"];
const TRIP_KEYS = ["date", "distance", "rounds", "temp", "wind", "windMph", "wclock", "windNote", "avgVel", "sd"];

const plain = (v) => v != null && (typeof v === "number" || typeof v === "boolean" || typeof v === "string");
// copy only the listed keys, and only plain values (or small plain objects/arrays for the profile's own settings)
function pick(o, keys, deep) {
  const out = {};
  if (!o || typeof o !== "object") return out;
  for (const k of keys) {
    const v = o[k];
    if (plain(v)) out[k] = v;
    else if (deep && v && typeof v === "object") { try { const s = JSON.stringify(v); if (s.length < 4000) out[k] = JSON.parse(s); } catch { /* skip */ } }
  }
  return out;
}
const join = (a, sep) => a.filter((x) => x != null && String(x).trim() !== "").join(sep == null ? " " : sep);
const rows = (d, k) => (d && Array.isArray(d[k]) ? d[k] : []);

// the gun as others see it: maker, model and specs (a barrel part's specs when the profile uses one); never its nickname or serial
function gunOf(rifles, rifleId, partId) {
  const g = rifleId ? rows(rifles, "rows").find((r) => r.id === rifleId) : null;
  if (!g) return null;
  const o = pick(g, GUN_KEYS);
  const p = partId ? rows(rifles, "parts").find((x) => x.id === partId && x.gunId === g.id) : null;
  let scopeId = g.scopeId || null;
  if (p) { for (const k of ["cartridge", "barrel", "twist", "sightHeight"]) if (plain(p[k]) && p[k] !== "") o[k] = p[k]; if (p.scopeId) scopeId = p.scopeId; }
  o.label = join([o.mfr, o.model]) || (o.type ? o.type.charAt(0).toUpperCase() + o.type.slice(1) : "") || "Gun";
  return { gun: o, scopeId };
}
function opticOf(rifles, scopeId) {
  const x = scopeId ? rows(rifles, "scopes").find((s) => s.id === scopeId) : null;
  if (!x) return null;
  const o = pick(x, OPTIC_KEYS);
  o.label = join([o.mfr, o.model]) || "Optic";
  return o;
}
function ammoOf(ammoDoc, ammoId) {
  const a = ammoId ? rows(ammoDoc, "rows").find((x) => x.id === ammoId) : null;
  if (!a) return null;
  const reload = a.kind === "reload";
  const o = pick(a, AMMO_KEYS);
  o.reload = reload;
  o.label = join([o.mfr, o.name || o.bullet, o.weight ? o.weight + " gr" : ""]) || (reload ? "Reloaded ammo" : "Ammo");
  return o;
}
function canOf(rifles, canId) {
  const c = canId ? rows(rifles, "cans").find((x) => x.id === canId) : null;
  return c ? { label: join([c.mfr, c.model]) || "Suppressor" } : null;
}

// a Shooting profile: the calculator's inputs, and the gun, optic and ammo as plain facts
function profileView(L, docs) {
  if (!L) return null;
  const inputs = pick(L, PROFILE_KEYS, true);
  const g = gunOf(docs.rifles, L.rifleId, L.partId);
  return {
    name: String(L.name || "Untitled profile"), cart: String(L.cart || ""), inputs,
    gun: g ? g.gun : (L.rifleName ? { label: String(L.rifleName) } : null),
    optic: g ? opticOf(docs.rifles, g.scopeId) : null,
    ammo: ammoOf(docs.ammo, L.ammoId),
  };
}

// a range trip: date, conditions (not where they came from), shots, groups and target photos; the range and notes only if ticked
function tripView(t, docs, opts, photos) {
  if (!t) return null;
  const o = pick(t, TRIP_KEYS);
  if (t.wx && typeof t.wx === "object") { o.wx = pick(t.wx, WX_KEYS); if (opts.range && plain(t.wx.range)) o.wx.range = t.wx.range; }
  if (opts.range && plain(t.place)) o.place = t.place;
  if (opts.notes && plain(t.notes)) o.notes = t.notes;
  if (t.cold && typeof t.cold === "object") o.cold = pick(t.cold, ["x", "y", "d"]);
  o.strings = rows(t, "strings").map((s) => ({ name: plain(s.name) ? s.name : "", date: plain(s.date) ? s.date : "", shots: Array.isArray(s.shots) ? s.shots.map((v) => (typeof v === "number" ? v : null)) : [] }));
  if (t.sum && typeof t.sum === "object") { try { const s = JSON.stringify({ g: t.sum.g || [], best: t.sum.best || null }); if (s.length < 200000) o.sum = JSON.parse(s); } catch { /* skip */ } }
  const calc = rows(docs.calc, "loads"), L = calc.find((c) => c.id === t.trajId) || null;
  const prof = profileView(L, docs);
  // the trip's own barrel and suppressor, when it has them
  if (prof && L && t.partId && t.partId !== L.partId) { const g = gunOf(docs.rifles, L.rifleId, t.partId); if (g) { prof.gun = g.gun; prof.optic = opticOf(docs.rifles, g.scopeId) || prof.optic; } }
  o.profile = prof;
  o.can = canOf(docs.rifles, t.canId);
  o.photos = photos;
  return o;
}

module.exports = { profileView, tripView, PROFILE_KEYS };

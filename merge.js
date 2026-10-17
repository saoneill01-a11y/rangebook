/* Copyright (C) 2026 Sean O'Neill. SPDX-License-Identifier: AGPL-3.0-or-later. See the LICENSE file. */
/* Merging saves from more than one phone or computer.

   Each kind of data (Shooting loads, guns, ammo, a reloading recipe...) is saved as one whole document.
   When a device saves, it also sends the version it started from ("base": what it last saved, and
   "seen": what it last loaded). The server compares three versions, piece by piece:
     - pieces this device didn't change keep whatever the server has now (another device's edits stay);
     - pieces only this device changed take this device's value;
     - pieces both changed keep the newest edit (by the time each edit was made).
   Lists of things with an id (loads, guns, trips, shots...) are matched by id, so adding, editing or
   deleting one item doesn't touch the others. Other lists and plain values are compared as a whole.

   The same path scheme is copied in public/index.html (rbDiffPaths) for the offline queue; keep them in step. */
"use strict";

const SEP = "\u001f";
const plain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

function eq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    // treat numbers that JSON makes identical as equal (e.g. NaN never appears in saved data)
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!eq(a[k], b[k])) return false;
  return true;
}

// a list whose every entry is an object with its own, unique id
function idList(x) {
  if (!Array.isArray(x)) return false;
  const seen = new Set();
  for (const o of x) {
    if (!plain(o) || o.id === undefined || o.id === null || o.id === "") return false;
    const k = String(o.id);
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}
const byId = (x) => { const m = new Map(); if (Array.isArray(x)) for (const o of x) m.set(String(o.id), o); return m; };

// every place two versions differ: changed values, and items added or removed from id lists
function diffPaths(a, b, p = "", out = []) {
  if (eq(a, b)) return out;
  if (plain(a) && plain(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], p + SEP + k, out);
    return out;
  }
  if (idList(a) && idList(b) && (a.length || b.length)) {
    const A = byId(a), B = byId(b);
    for (const k of new Set([...A.keys(), ...B.keys()])) diffPaths(A.get(k), B.get(k), p + SEP + "#" + k, out);
    return out;
  }
  out.push(p);
  return out;
}

// the latest time recorded at this path, inside it, or on anything that contains it
function timeAt(times, p, dflt) {
  let m = -1;
  if (times) for (const k in times) {
    if (k === p || k.startsWith(p + SEP) || p.startsWith(k + SEP)) { const v = Number(times[k]); if (v > m) m = v; }
  }
  return m < 0 ? dflt : m;
}

/* opts: base, seen (optional; pass hasSeen), mine, theirs, tMine(path), tTheirs(path) */
function merge3(opts) {
  const { hasSeen, tMine, tTheirs } = opts;
  function go(b, s, m, t, p) {
    if (eq(m, t)) return m;
    if (eq(m, b) || (hasSeen && eq(m, s))) return t; // this device didn't change it
    if (eq(t, b)) return m; // only this device changed it
    // both changed it
    if (plain(m) && plain(t)) {
      const out = {};
      for (const k of new Set([...Object.keys(m), ...Object.keys(t)])) {
        const v = go(plain(b) ? b[k] : undefined, plain(s) ? s[k] : undefined, m[k], t[k], p + SEP + k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    if (idList(m) && idList(t)) {
      const B = idList(b) ? byId(b) : new Map(), S = idList(s) ? byId(s) : new Map(), M = byId(m), T = byId(t);
      const res = new Map();
      for (const k of new Set([...M.keys(), ...T.keys()])) {
        const v = go(B.get(k), S.get(k), M.get(k), T.get(k), p + SEP + "#" + k);
        if (v !== undefined) res.set(k, v);
      }
      // keep this device's order, and put items only the server has after the one they followed there
      const order = [...M.keys()].filter((k) => res.has(k));
      const tk = [...T.keys()];
      tk.forEach((k, i) => {
        if (!res.has(k) || order.includes(k)) return;
        let at = 0;
        for (let j = i - 1; j >= 0; j--) { const q = order.indexOf(tk[j]); if (q >= 0) { at = q + 1; break; } }
        order.splice(at, 0, k);
      });
      return order.map((k) => res.get(k));
    }
    // the same value changed on both: the newest edit wins (this device on a tie)
    return tMine(p) >= tTheirs(p) ? m : t;
  }
  return go(opts.base, opts.seen, opts.mine, opts.theirs, "");
}

module.exports = { SEP, eq, idList, diffPaths, timeAt, merge3 };

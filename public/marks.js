/* Copyright (C) 2026 Sean O'Neill. SPDX-License-Identifier: AGPL-3.0-or-later. See the LICENSE file. */
/* Range Book marked targets (2.47.45): the drawings of a measured target that go in the range report and the
   Download with marks picture. Shared by the page (drawn as SVG, saved as a JPEG) and the server (drawn into the PDF),
   so both look the same. Each layout returns {W, H, items}: plain shapes (rect, circle, line, text, the photo, the icon)
   in its own units, which a renderer scales to fit.
   report(o): the photo in the middle, a bubble for each group beside it (left-hand groups on the left), with a line to
     its group: shots, size and MOA, mean radius, how far its center is from the aim point, and each shot's velocity in
     firing order, two columns, colored slower (blue) to faster (red) against that group's average.
   photo(o): the page filling the picture, each group's size on a line between its two farthest holes (like measuring by
     hand), a small bubble by each group, and each hole's number and velocity beside it.
   mapMeasure: the marks of a Live target photo put onto another photo of the same printed page, through the page's
     corner squares (the Live target photo's page position M.H and the other photo's T.Hinv). */
(function (root, make) { if (typeof module === "object" && module.exports) module.exports = make(); else root.RBMarks = make(); })(this, function () {
  const COLORS = ["#00b8d4", "#e6b800", "#e040b0", "#55c400", "#ff8a00", "#9b6dff", "#00a8a8", "#e53935"];
  const TEAL = "#0f5a5e";
  const applyH = (h, x, y) => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };

  // M: the Live target photo's measurement (w × h pixels); T: the other photo's own page position {H, Hinv} (w2 × h2)
  function mapMeasure(M, w, h, T, w2, h2) {
    if (!M || !Array.isArray(M.H) || !T || !Array.isArray(T.Hinv)) return null;
    const mp = (q) => { if (!q) return q; const pg = applyH(M.H, q[0] * w, q[1] * h), p = applyH(T.Hinv, pg[0], pg[1]); return [+(p[0] / w2).toFixed(5), +(p[1] / h2).toFixed(5)]; };
    return Object.assign({}, M, { a: mp(M.a), b: mp(M.b), H: T.H, mapped: true,
      groups: (M.groups || []).map((g) => Object.assign({}, g, { shots: (g.shots || []).map(mp), aim: g.aim ? mp(g.aim) : g.aim, box: null })) });
  }

  // slower → faster against the group's average: blue, grey, red (the same scale as Shot groups in the app)
  function heat(v, avg, es) {
    if (!(v > 0) || !(avg > 0)) return "#666666";
    const t = Math.max(-1, Math.min(1, (v - avg) / Math.max(8, (es || 0) / 2))), A = [52, 98, 200], M = [128, 128, 128], B = [205, 52, 42];
    const f = t < 0 ? A.map((a, i) => Math.round(M[i] + (a - M[i]) * -t)) : B.map((b, i) => Math.round(M[i] + (b - M[i]) * t));
    return "#" + f.map((x) => x.toString(16).padStart(2, "0")).join("");
  }

  /* o.groups: [{name, color, shots:[[x,y] in image px], vel:[number|null] in firing order, velTxt:[string], aim:[x,y]|null,
     n, rows:[[label, value]] (Group, Mean radius, From zero), sizeTxt ("3.13\""), title ("1 · 5 shots · 3.13 in"),
     short ("MR 1.04 · 0.49 R, 0.22 high"), sumTxt ("avg 1022 · SD 14.5 · ES 35 fps")}]
     o.w, o.h: the photo's pixels; o.holeR: a bullet hole's radius in pixels; o.head: {title, sub}; o.tw(text, size, bold) */
  function geo(g) {
    const S = g.shots || [], n = S.length;
    const c = n ? [S.reduce((a, q) => a + q[0], 0) / n, S.reduce((a, q) => a + q[1], 0) / n] : g.aim || [0, 0];
    let far = [S[0], S[0]], d = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const e = Math.hypot(S[i][0] - S[j][0], S[i][1] - S[j][1]); if (e > d) { d = e; far = [S[i], S[j]]; } }
    const mid = n ? [(far[0][0] + far[1][0]) / 2, (far[0][1] + far[1][1]) / 2] : c;
    const R = n ? Math.max(d / 2, ...S.map((q) => Math.hypot(q[0] - mid[0], q[1] - mid[1]))) : 0;
    const V = (g.vel || []).filter((v) => v > 0), avg = V.length ? V.reduce((a, b) => a + b, 0) / V.length : null, es = V.length ? Math.max(...V) - Math.min(...V) : 0;
    return { c, far, d, mid, R, avg, es };
  }
  const header = (it, cx, y, w, H0, head) => {
    const x = cx - w / 2, r = H0 / 2;
    it.push({ k: "rect", x, y, w, h: H0, r, fill: "#ffffff", stroke: TEAL, sw: H0 * 0.034 });
    it.push({ k: "icon", cx: x + r, cy: y + r, r: r * 0.78 });
    it.push({ k: "text", x: x + H0 + 6, y: y + H0 * 0.48, s: head.title || "Range Book", size: H0 * 0.35, bold: true, fill: TEAL });
    if (head.sub) it.push({ k: "text", x: x + H0 + 7, y: y + H0 * 0.78, s: head.sub, size: H0 * 0.185, fill: "#444444" });
  };
  const headW = (head, H0, tw) => Math.max(tw(head.title || "Range Book", H0 * 0.35, true), tw(head.sub || "", H0 * 0.185, false)) + H0 + 40;
  const ring = (it, x, y, r, c, w) => { it.push({ k: "circle", cx: x, cy: y, r, stroke: "#000000", sw: w * 2, op: 0.55 }); it.push({ k: "circle", cx: x, cy: y, r, stroke: c, sw: w }); };
  const badge = (it, x, y, r, n, fill, dark) => { it.push({ k: "circle", cx: x, cy: y, r, fill, stroke: "#000000", sw: r * 0.14 }); it.push({ k: "text", x, y: y + r * 0.42, s: String(n), size: r * 1.2, bold: true, fill: dark ? "#111111" : "#ffffff", anchor: "middle" }); };
  const arrowLine = (it, x1, y1, x2, y2, c, w, a0, a1, dash) => it.push({ k: "line", x1, y1, x2, y2, stroke: c, sw: w, dash, a0, a1 });

  // ---------- report: bubbles beside the photo ----------
  function report(o) {
    const tw = o.tw, PH = 1200, s = PH / o.h, PW = o.w * s, CW = 350, X0 = 16 + CW + 16, top = 150, it = [];
    const W = 2 * X0 + PW, T = (p) => [X0 + p[0] * s, top + p[1] * s];
    const G = o.groups.map((g, k) => Object.assign({ k }, g, geo(g)));
    it.push({ k: "rect", x: 0, y: 0, w: W, h: 1e5, fill: "#f3f1ec", bg: true });
    it.push({ k: "img", x: X0, y: top, w: PW, h: PH });
    const hr = Math.max(8, (o.holeR || 4) * s);
    // the marks on the photo
    G.forEach((g) => {
      if (!g.shots.length) return;
      const [mx, my] = T(g.mid), R = g.R * s + hr + 6;
      it.push({ k: "circle", cx: mx, cy: my, r: R, stroke: "#000000", sw: 5, dash: [10, 7], op: 0.35 });
      it.push({ k: "circle", cx: mx, cy: my, r: R, stroke: g.color, sw: 2.5, dash: [10, 7] });
      g.ringR = R;
    });
    G.forEach((g) => {
      const [cx, cy] = T(g.c);
      if (g.aim) { const [ax, ay] = T(g.aim); if (Math.hypot(cx - ax, cy - ay) > 6) arrowLine(it, ax, ay, cx, cy, "#111111", 2, false, true, [4, 3]); }
      g.shots.forEach((q, j) => { const [x, y] = T(q); ring(it, x, y, hr, g.color, 2.6); });
      if (g.shots.length) it.push({ k: "circle", cx, cy, r: 5, fill: g.color, stroke: "#000000", sw: 1.5 });
      g.shots.forEach((q, j) => { const [x, y] = T(q), v = g.vel[j]; badge(it, x + hr + 3, y - hr - 3, 10, j + 1, v > 0 ? heat(v, g.avg, g.es) : g.color, !(v > 0)); });
    });
    // the bubbles: left-hand groups on the left, each as near its group's height as it can be without overlapping
    const bh = (g) => { const nv = g.vel.filter((v) => v > 0).length; return 38 + 14 + 26 * g.rows.length + 8 + (nv ? 26 + Math.ceil(g.vel.length / 2) * 27 + 34 : 6); };
    let H = top + PH + 70;
    [0, 1].forEach((side) => {
      const col = G.filter((g) => (T(g.c)[0] < X0 + PW / 2 ? 0 : 1) === side).sort((a, b) => a.c[1] - b.c[1]);
      let end = top - 30; col.forEach((g) => { g.bh = bh(g); g.by = Math.max(end + 12, T(g.c)[1] - g.bh / 2); end = g.by + g.bh; });
      let lim = Math.max(H - 60, end); for (let i = col.length - 1; i >= 0; i--) { const g = col[i]; if (g.by + g.bh > lim) g.by = lim - g.bh; lim = g.by - 12; }
      const over = col.length ? Math.max(0, top - 30 - col[0].by) : 0; col.forEach((g) => { g.by += over; g.bx = side ? W - 16 - CW : 16; g.side = side; });
      if (col.length) H = Math.max(H, col[col.length - 1].by + col[col.length - 1].bh + 70);
    });
    G.forEach((g) => {
      const bx = g.bx, by = g.by, bw = CW, h = g.bh, c = g.color, [cx, cy] = T(g.c), ex = g.side ? bx : bx + bw, ey = by + 19 + 13 * 2;
      const gx = g.shots.length ? (g.side ? cx + g.ringR : cx - g.ringR) : cx;
      it.push({ k: "line", x1: ex, y1: ey, x2: gx, y2: cy, stroke: "#000000", sw: 5, op: 0.45 });
      it.push({ k: "line", x1: ex, y1: ey, x2: gx, y2: cy, stroke: c, sw: 2.5 });
      it.push({ k: "rect", x: bx, y: by, w: bw, h, r: 16, fill: "#ffffff", stroke: c, sw: 3 });
      it.push({ k: "rect", x: bx, y: by, w: bw, h: 38, r: 16, fill: c, top: true });
      it.push({ k: "text", x: bx + 16, y: by + 26, s: g.name, size: 19, bold: true, fill: "#111111" });
      it.push({ k: "text", x: bx + bw - 16, y: by + 26, s: g.n + " shot" + (g.n === 1 ? "" : "s"), size: 16, bold: true, fill: "#111111", anchor: "end" });
      let y = by + 64;
      g.rows.forEach(([l, v]) => {
        let sz = 17; while (sz > 11 && tw(l, 15, false) + tw(v, sz, true) > bw - 44) sz -= 0.5;
        it.push({ k: "text", x: bx + 16, y, s: l, size: 15, fill: "#555555" });
        it.push({ k: "text", x: bx + bw - 16, y, s: v, size: sz, bold: true, fill: "#111111", anchor: "end" }); y += 26;
      });
      if (g.vel.some((v) => v > 0)) {
        it.push({ k: "line", x1: bx + 14, y1: y - 10, x2: bx + bw - 14, y2: y - 10, stroke: "#e6e6e6", sw: 1.5 });
        it.push({ k: "text", x: bx + 16, y: y + 10, s: o.velHead || "Shot · fps", size: 13, fill: "#777777" });
        const rows = Math.ceil(g.vel.length / 2);
        g.vel.forEach((v, j) => {
          const cl = j < rows ? 0 : 1, r = j < rows ? j : j - rows, x = bx + 28 + cl * (bw / 2), yy = y + 36 + r * 27, hc = heat(v, g.avg, g.es);
          badge(it, x, yy - 5, 10.5, j + 1, v > 0 ? hc : "#bbbbbb", !(v > 0));
          it.push({ k: "text", x: x + 18, y: yy + 1, s: g.velTxt[j] || "–", size: 17, bold: true, fill: v > 0 ? hc : "#999999" });
          if (v > 0 && g.avg) { const dv = Math.round(v - g.avg); it.push({ k: "text", x: x + 18 + tw(g.velTxt[j], 17, true) + 8, y: yy + 1, s: (dv >= 0 ? "+" : "–") + Math.abs(dv), size: 13, fill: "#999999" }); }
        });
        if (g.sumTxt) it.push({ k: "text", x: bx + 16, y: by + h - 14, s: g.sumTxt, size: 14, fill: "#666666" });
      }
    });
    const hw = Math.min(W - 40, headW(o.head, 104, tw)); header(it, W / 2, 24, hw, 104, o.head);
    if (G.some((g) => g.vel.some((v) => v > 0))) legend(it, W / 2 - 125, H - 54, o);
    it[0].h = H;
    return { W, H, items: it };
  }
  function legend(it, x, y, o) {
    it.push({ k: "rect", x, y, w: 250, h: 34, r: 17, fill: "#ffffff", stroke: "#cccccc", sw: 1 });
    it.push({ k: "text", x: x + 16, y: y + 22, s: o.slower || "Slower", size: 14, fill: "#333333" });
    for (let i = 0; i < 20; i++) { const t = i / 19, v = 100 + (t - 0.5) * 2 * 16; it.push({ k: "rect", x: x + 72 + i * 5, y: y + 12, w: 5.4, h: 10, fill: heat(v, 100, 32) }); }
    it.push({ k: "text", x: x + 180, y: y + 22, s: o.faster || "Faster", size: 14, fill: "#333333" });
  }

  // ---------- the photo on its own: measured like by hand ----------
  function photo(o) {
    const tw = o.tw, cr = o.crop || [0, 0, o.w, o.h], cw = cr[2] - cr[0], ch = cr[3] - cr[1], DW = 980, s = DW / cw, top = 150, it = [];
    const W = DW, H = top + ch * s, T = (p) => [(p[0] - cr[0]) * s, top + (p[1] - cr[1]) * s];
    const G = o.groups.map((g, k) => Object.assign({ k }, g, geo(g)));
    const hr = Math.max(9, (o.holeR || 4) * s), taken = [], hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const inside = (b) => b.x >= 4 && b.y >= top + 4 && b.x + b.w <= W - 4 && b.y + b.h <= H - 4;
    it.push({ k: "rect", x: 0, y: 0, w: W, h: H, fill: "#2b2b2b", bg: true });
    it.push({ k: "img", x: 0, y: top, w: W, h: ch * s, crop: cr });
    G.forEach((g) => { g.shots.forEach((q) => { const [x, y] = T(q); taken.push({ x: x - hr - 3, y: y - hr - 3, w: 2 * hr + 6, h: 2 * hr + 6 }); }); if (g.aim) { const [x, y] = T(g.aim); taken.push({ x: x - 16, y: y - 16, w: 32, h: 32 }); } });
    // a bubble by each group: under it if there's room, else above its aim point, else beside it
    G.forEach((g) => {
      if (!g.shots.length && !g.aim) return;
      const pts = g.shots.concat(g.aim ? [g.aim] : []).map(T), x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
      const bw = Math.max(tw(g.title, 17, true), tw(g.short, 14, false)) + 26, bh = 62, mx = (x0 + x1) / 2;
      const cand = [[mx - bw / 2, y1 + hr + 12], [mx - bw / 2, y0 - hr - 12 - bh], [x1 + hr + 14, (y0 + y1) / 2 - bh / 2], [x0 - hr - 14 - bw, (y0 + y1) / 2 - bh / 2], [mx - bw / 2, y1 + hr + 60], [mx - bw / 2, y0 - hr - 60 - bh]];
      let b = null; for (const [x, y] of cand) { const o2 = { x: Math.max(6, Math.min(W - bw - 6, x)), y, w: bw, h: bh }; if (inside(o2) && !taken.some((t) => hit(o2, t))) { b = o2; break; } }
      if (!b) b = { x: Math.max(6, Math.min(W - bw - 6, cand[0][0])), y: Math.min(H - bh - 6, cand[0][1]), w: bw, h: bh };
      taken.push(b); g.bub = b;
    });
    G.forEach((g) => {
      const c = g.color;
      if (g.shots.length > 1) {
        const [p1, p2] = g.far.map(T);
        it.push({ k: "line", x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], stroke: "#000000", sw: 5, op: 0.5 });
        arrowLine(it, p1[0], p1[1], p2[0], p2[1], c, 2.5, true, true);
      }
      const [cx, cy] = T(g.c);
      if (g.aim && g.shots.length) { const [ax, ay] = T(g.aim); if (Math.hypot(cx - ax, cy - ay) > 6) arrowLine(it, ax, ay, cx, cy, "#111111", 2, false, true, [4, 3]); }
      g.shots.forEach((q) => { const [x, y] = T(q); ring(it, x, y, hr, c, 2.6); });
      if (g.shots.length) it.push({ k: "circle", cx, cy, r: 5, fill: c, stroke: "#000000", sw: 1.5 });
      if (g.shots.length > 1) {
        const [p1, p2] = g.far.map(T), mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2, L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1, nx = -(p2[1] - p1[1]) / L, ny = (p2[0] - p1[0]) / L;
        const pw = tw(g.sizeTxt, 15, true) + 18; let sb = null;
        for (const d of [0, 18, -18, 30, -30, 44, -44]) { const o2 = { x: mx + nx * d - pw / 2, y: my + ny * d - 11, w: pw, h: 22 }; if (!taken.some((t) => hit(o2, t))) { sb = o2; break; } }
        if (!sb) sb = { x: mx - pw / 2, y: my - 11, w: pw, h: 22 }; taken.push(sb);
        it.push({ k: "rect", x: sb.x, y: sb.y, w: pw, h: 22, r: 11, fill: c, stroke: "#000000", sw: 1.5 });
        it.push({ k: "text", x: sb.x + pw / 2, y: sb.y + 16, s: g.sizeTxt, size: 15, bold: true, fill: "#111111", anchor: "middle" });
      }
    });
    // each hole's number and velocity, in a small tag as close to it as there's room
    G.forEach((g) => g.shots.forEach((q, j) => {
      const [x, y] = T(q), v = g.vel[j], txt = v > 0 ? g.velTxt[j] : "", w = txt ? tw(txt, 13, true) + 30 : 22, h = 21; let best = null;
      for (const r of [hr + 4, hr + 10, hr + 18, hr + 28, hr + 42]) { for (const [dx, dy] of [[1, -1], [1, 1], [-1, -1], [-1, 1], [1, 0], [-1, 0], [0, -1], [0, 1]]) {
        const bx = dx > 0 ? x + r * 0.8 : dx < 0 ? x - r * 0.8 - w : x - w / 2, by = dy > 0 ? y + r * 0.8 : dy < 0 ? y - r * 0.8 - h : y - h / 2, o2 = { x: bx, y: by, w, h };
        if (inside(o2) && !taken.some((t) => hit(o2, t))) { best = o2; break; } } if (best) break; }
      if (!best) best = { x: x + hr + 2, y: y - hr - h, w, h }; taken.push(best);
      const lx = Math.max(best.x, Math.min(x, best.x + w)), ly = Math.max(best.y, Math.min(y, best.y + h));
      if (Math.hypot(lx - x, ly - y) > hr + 6) it.push({ k: "line", x1: x, y1: y, x2: lx, y2: ly, stroke: "#222222", sw: 1.3, op: 0.7 });
      it.push({ k: "rect", x: best.x, y: best.y, w, h, r: 10.5, fill: "#151515", op: 0.85 });
      badge(it, best.x + 10.5, best.y + 10.5, 8, j + 1, g.color, true);
      if (txt) { const hc = heat(v, g.avg, g.es); it.push({ k: "text", x: best.x + 22, y: best.y + 15.5, s: txt, size: 13, bold: true, fill: hc === "#808080" ? "#dddddd" : lighten(hc) }); }
    }));
    G.forEach((g) => { const b = g.bub; if (!b) return;
      it.push({ k: "rect", x: b.x, y: b.y, w: b.w, h: b.h, r: 12, fill: "#ffffff", stroke: g.color, sw: 3, op: 0.94 });
      it.push({ k: "text", x: b.x + 12, y: b.y + 25, s: g.title, size: 17, bold: true, fill: "#111111" });
      it.push({ k: "text", x: b.x + 12, y: b.y + 48, s: g.short, size: 14, fill: "#333333" }); });
    const hw = Math.min(W - 24, headW(o.head, 104, tw)); header(it, W / 2, 22, hw, 104, o.head);
    return { W, H, items: it };
  }
  // the velocity colors on a dark tag: the blue lifted so it reads
  function lighten(hex) { const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; if (b > r) return "#" + [r + 60, g + 60, Math.min(255, b + 40)].map((x) => Math.min(255, x).toString(16).padStart(2, "0")).join(""); return hex; }

  // ---------- drawn as SVG (the page) ----------
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // overlay: leave out the background, the photo and the icon (the page draws those itself, then this on top)
  function toSvg(L, img, icon, overlay) {
    const f = (v) => Math.round(v * 100) / 100;
    let h = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${f(L.W)}" height="${f(L.H)}" viewBox="0 0 ${f(L.W)} ${f(L.H)}" font-family="Helvetica, Arial, sans-serif">`;
    h += `<defs><marker id="rbar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker><clipPath id="rbic"><circle cx="0" cy="0" r="1"/></clipPath></defs>`;
    let n = 0;
    for (const t of L.items) {
      if (overlay && (t.bg || t.k === "img" || t.k === "icon")) continue;
      const op = t.op != null ? ` opacity="${t.op}"` : "", st = t.stroke ? ` stroke="${t.stroke}" stroke-width="${f(t.sw || 1)}"${t.dash ? ` stroke-dasharray="${t.dash.join(" ")}"` : ""}` : "";
      if (t.k === "rect") {
        if (t.top) h += `<path d="M${f(t.x)} ${f(t.y + t.h)}V${f(t.y + t.r)}A${t.r} ${t.r} 0 0 1 ${f(t.x + t.r)} ${f(t.y)}H${f(t.x + t.w - t.r)}A${t.r} ${t.r} 0 0 1 ${f(t.x + t.w)} ${f(t.y + t.r)}V${f(t.y + t.h)}Z" fill="${t.fill}"/>`;
        else h += `<rect x="${f(t.x)}" y="${f(t.y)}" width="${f(t.w)}" height="${f(t.h)}"${t.r ? ` rx="${t.r}"` : ""} fill="${t.fill || "none"}"${st}${op}/>`;
      } else if (t.k === "circle") h += `<circle cx="${f(t.cx)}" cy="${f(t.cy)}" r="${f(t.r)}" fill="${t.fill || "none"}"${st}${op}/>`;
      else if (t.k === "line") h += `<line x1="${f(t.x1)}" y1="${f(t.y1)}" x2="${f(t.x2)}" y2="${f(t.y2)}"${st}${op}${t.a0 ? ' marker-start="url(#rbar)"' : ""}${t.a1 ? ' marker-end="url(#rbar)"' : ""}/>`;
      else if (t.k === "text") h += `<text x="${f(t.x)}" y="${f(t.y)}" font-size="${f(t.size)}"${t.bold ? ' font-weight="700"' : ""} fill="${t.fill}"${t.anchor ? ` text-anchor="${t.anchor}"` : ""}>${esc(t.s)}</text>`;
      else if (t.k === "img" && img) {
        if (t.crop) { const [x0, y0, x1, y1] = t.crop; h += `<svg x="${f(t.x)}" y="${f(t.y)}" width="${f(t.w)}" height="${f(t.h)}" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}" preserveAspectRatio="none"><image href="${esc(img.url)}" xlink:href="${esc(img.url)}" x="0" y="0" width="${img.w}" height="${img.h}"/></svg>`; }
        else h += `<image href="${esc(img.url)}" xlink:href="${esc(img.url)}" x="${f(t.x)}" y="${f(t.y)}" width="${f(t.w)}" height="${f(t.h)}" preserveAspectRatio="none"/>`;
      } else if (t.k === "icon" && icon) { n++; h += `<clipPath id="rbi${n}"><circle cx="${f(t.cx)}" cy="${f(t.cy)}" r="${f(t.r)}"/></clipPath><image href="${esc(icon)}" xlink:href="${esc(icon)}" x="${f(t.cx - t.r)}" y="${f(t.cy - t.r)}" width="${f(2 * t.r)}" height="${f(2 * t.r)}" clip-path="url(#rbi${n})"/>`; }
    }
    return h + "</svg>";
  }
  /* the groups of a measurement (M on a w × h photo), ready for report() and photo(). f: how to write numbers
     {len(v, dec) "3.13 in", lenN(v, dec) "3.13", lenMark "\"" or " cm", fps(v) "1034", fpsU "fps", name(t, k) "Aim 1"} */
  function prep(M, w, h, f) {
    if (!M || !Array.isArray(M.groups)) return null;
    let ppi = null; if (M.a && M.b && M.scaleIn > 0) ppi = Math.hypot((M.a[0] - M.b[0]) * w, (M.a[1] - M.b[1]) * h) / M.scaleIn;
    const holeR = ppi ? (M.dia || 0.308) / 2 * ppi : w / 160;
    const groups = [];
    M.groups.forEach((t, k) => {
      const S = (t.shots || []).map((q) => [q[0] * w, q[1] * h]);
      if (!S.length) return;
      const vel = S.map((_, j) => (Array.isArray(t.vel) && Number(t.vel[j]) > 0 ? Number(t.vel[j]) : null)), V = vel.filter((v) => v > 0);
      const n = S.length, num = t.ai != null ? t.ai + 1 : k + 1, sz = t.size != null ? Number(t.size) : null;
      const lr = t.dx == null ? "" : Math.abs(t.dx) < 0.005 ? "centered" : f.len(Math.abs(t.dx), 2) + " " + (t.dx > 0 ? "right" : "left");
      const ud = t.dy == null ? "" : Math.abs(t.dy) < 0.005 ? "centered" : f.len(Math.abs(t.dy), 2) + " " + (t.dy > 0 ? "high" : "low");
      const lrS = t.dx == null ? "" : Math.abs(t.dx) < 0.005 ? "0" : f.lenN(Math.abs(t.dx), 2) + (t.dx > 0 ? " R" : " L"), udS = t.dy == null ? "" : Math.abs(t.dy) < 0.005 ? "0" : f.lenN(Math.abs(t.dy), 2) + (t.dy > 0 ? " high" : " low");
      let sum = "";
      if (V.length) { const avg = V.reduce((a, b) => a + b, 0) / V.length, sd = V.length > 1 ? Math.sqrt(V.reduce((a, b) => a + (b - avg) ** 2, 0) / (V.length - 1)) : null;
        sum = "avg " + f.fps(avg) + (sd != null ? " · SD " + f.fpsSd(sd) + " · ES " + f.fps(Math.max(...V) - Math.min(...V)) : "") + " " + f.fpsU; }
      groups.push({ name: f.name(t, k), color: COLORS[k % COLORS.length], shots: S, vel, velTxt: vel.map((v) => (v > 0 ? f.fps(v) : "–")),
        aim: t.aim ? [t.aim[0] * w, t.aim[1] * h] : null, n,
        rows: [["Group", sz != null ? f.len(sz, 2) + (t.moa != null ? " · " + Number(t.moa).toFixed(2) + " MOA" : "") : "–"], ["Mean radius", t.mr != null ? f.len(Number(t.mr), 2) : "–"], ["From zero", lr ? lr + ", " + ud : "–"]],
        sizeTxt: sz != null ? f.lenN(sz, 2) + f.lenMark : "", title: num + " · " + n + " shot" + (n === 1 ? "" : "s") + (sz != null ? " · " + f.len(sz, 2) : ""),
        short: (t.mr != null ? "MR " + f.lenN(Number(t.mr), 2) : "") + (lrS ? " · " + lrS + ", " + udS : ""), sumTxt: sum });
    });
    return { w, h, holeR, groups };
  }
  // the page's corners on a photo with a page position (px → page H), padded a little, for photo()'s crop
  function pageCrop(M, w, h, fid) {
    if (!M || !Array.isArray(M.H) || !fid) return null;
    const inv = inv3(M.H); if (!inv) return null;
    const P = fid.map((q) => applyH(inv, q[0], q[1])), x0 = Math.min(...P.map((p) => p[0])), x1 = Math.max(...P.map((p) => p[0])), y0 = Math.min(...P.map((p) => p[1])), y1 = Math.max(...P.map((p) => p[1]));
    const m = Math.max(x1 - x0, y1 - y0) * 0.11;
    return [Math.max(0, x0 - m), Math.max(0, y0 - m), Math.min(w, x1 + m), Math.min(h, y1 + m)];
  }
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, D = a * A + b * B + c * C;
    if (!D) return null; return [A / D, -(b * i - c * h) / D, (b * f - c * e) / D, B / D, (a * i - c * g) / D, -(a * f - c * d) / D, C / D, -(a * h - b * g) / D, (a * e - b * d) / D];
  }
  // the Range Book banner on its own (the top of the range report's first page) (2.47.47)
  function banner(o) { const it = [], w = headW(o.head, 104, o.tw) + 8; header(it, w / 2, 4, w, 104, o.head); return { W: w, H: 112, items: it }; }
  return { COLORS, applyH, inv3, mapMeasure, heat, prep, pageCrop, report, photo, banner, toSvg };
});

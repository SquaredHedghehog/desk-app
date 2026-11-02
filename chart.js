/* Hand-drawn canvas charts. No chart library. devicePixelRatio aware. */
(function () {
  const C = { green: "#00d35a", red: "#ff453a", blue: "#0a84ff", orange: "#ff9f0a", ter: "rgba(235,235,245,0.3)",
              sec: "rgba(235,235,245,0.6)", sep: "rgba(84,84,88,0.55)", card2: "#2c2c2e" };
  const reduced = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setup(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  /* Home LIVE line: points [[ts,value]], start value dashed, marks [{ts,kind,text}] above the line. */
  function line(cv, data, prog) {
    const { ctx, w, h } = setup(cv);
    const pts = (data && data.points) || [];
    const padT = 58, padB = 14, padX = 16;
    const start = data && data.start;
    if (pts.length < 2) {
      const y = h / 2;
      ctx.setLineDash([4, 5]); ctx.strokeStyle = C.ter; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(w - padX, y); ctx.stroke(); ctx.setLineDash([]);
      return;
    }
    let lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1]));
    if (start != null) { lo = Math.min(lo, start); hi = Math.max(hi, start); }
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    const X = t => padX + (w - 2 * padX) * ((t - t0) / Math.max(1, t1 - t0));
    const Y = v => padT + (h - padT - padB) * (1 - (v - lo) / (hi - lo));
    // the newest point slides in (prog 0..1)
    const p = prog == null ? 1 : prog;
    const draw = pts.slice(0, -1).map(q => [X(q[0]), Y(q[1])]);
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    draw.push([X(a[0]) + (X(b[0]) - X(a[0])) * p, Y(a[1]) + (Y(b[1]) - Y(a[1])) * p]);
    if (start != null) {
      ctx.setLineDash([4, 5]); ctx.strokeStyle = C.ter; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padX, Y(start)); ctx.lineTo(w - padX, Y(start)); ctx.stroke(); ctx.setLineDash([]);
    }
    const g = ctx.createLinearGradient(0, padT, 0, h);
    g.addColorStop(0, "rgba(0,211,90,0.28)"); g.addColorStop(1, "rgba(0,211,90,0)");
    ctx.beginPath(); ctx.moveTo(draw[0][0], h); draw.forEach(q => ctx.lineTo(q[0], q[1]));
    ctx.lineTo(draw[draw.length - 1][0], h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); draw.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]));
    ctx.strokeStyle = C.green; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
    const last = draw[draw.length - 1];
    ctx.fillStyle = C.green; ctx.beginPath(); ctx.arc(last[0], last[1], 4, 0, 7); ctx.fill();
    // marks: never overlap, a later mark moves up a row
    ctx.font = "600 11px -apple-system, 'SF Pro Text', Inter, sans-serif";
    const placed = [];
    (data.marks || []).filter(m => m.ts >= t0 && m.ts <= t1 + 60).forEach(m => {
      const col = m.kind === "bought" ? C.blue : (m.kind === "gain" ? C.green : C.red);
      const tw = ctx.measureText(m.text).width + 14;
      let x = Math.min(Math.max(padX, X(m.ts) - tw / 2), w - padX - tw);
      let row = 0;
      while (placed.some(o => o.row === row && x < o.x + o.w + 4 && o.x < x + tw + 4)) row++;
      placed.push({ x, w: tw, row });
      const y = 6 + (2 - Math.min(row, 2)) * 0 + row * 0;  // rows stack upward from the line top area
      const yy = Math.max(4, Math.min(Y(valueAt(pts, m.ts)) - 30 - row * 24, h - 30));
      ctx.globalAlpha = m._alpha == null ? 1 : m._alpha;
      ctx.fillStyle = col; roundRect(ctx, x, yy, tw, 20, 10); ctx.fill();
      ctx.fillStyle = m.kind === "bought" ? "#fff" : "#000"; ctx.textBaseline = "middle"; ctx.fillText(m.text, x + 7, yy + 10.5);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(m.ts), yy + 20); ctx.lineTo(X(m.ts), Y(valueAt(pts, m.ts))); ctx.stroke();
    });
  }
  function valueAt(pts, ts) {
    let best = pts[0];
    for (const p of pts) { if (p[0] <= ts) best = p; else break; }
    return best[1];
  }

  /* Coin candles: [[t,o,h,l,c,vol]], exit line (orange dashed "Risk trailing stop"), entry line. */
  function candles(cv, cs, opts) {
    const { ctx, w, h } = setup(cv);
    opts = opts || {};
    const volH = 46, padT = 14, padR = 8, padL = 8;
    if (!cs || !cs.length) {
      ctx.fillStyle = C.sec; ctx.font = "15px -apple-system, Inter, sans-serif"; ctx.textAlign = "center";
      ctx.fillText("Waiting for the first price", w / 2, h / 2); ctx.textAlign = "left"; return;
    }
    let lo = Math.min(...cs.map(c => c[3])), hi = Math.max(...cs.map(c => c[2]));
    [opts.exitLine, opts.entry].forEach(v => { if (v) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    const span = hi - lo || hi * 0.01 || 1; lo -= span * 0.06; hi += span * 0.06;
    const ph = h - volH - padT - 8;
    const Y = v => padT + ph * (1 - (v - lo) / (hi - lo));
    const n = Math.max(cs.length, 30), slot = (w - padL - padR) / n, bw = Math.max(2, slot * 0.62);
    const vmax = Math.max(1e-9, ...cs.map(c => c[5] || 0));
    cs.forEach((c, i) => {
      const x = padL + slot * (i + (n - cs.length)) + slot / 2;
      const up = c[4] >= c[1]; const col = up ? C.green : C.red;
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, Y(c[2])); ctx.lineTo(x, Y(c[3])); ctx.stroke();
      const y1 = Y(Math.max(c[1], c[4])), y2 = Y(Math.min(c[1], c[4]));
      ctx.fillStyle = col; ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
      const vh = (c[5] || 0) / vmax * (volH - 6);
      ctx.globalAlpha = 0.45; ctx.fillRect(x - bw / 2, h - vh, bw, vh); ctx.globalAlpha = 1;
    });
    ctx.font = "600 11px -apple-system, Inter, sans-serif"; ctx.textBaseline = "bottom";
    if (opts.entry) {
      ctx.setLineDash([2, 4]); ctx.strokeStyle = C.ter; ctx.beginPath(); ctx.moveTo(0, Y(opts.entry)); ctx.lineTo(w, Y(opts.entry)); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = C.sec; ctx.fillText("Entry", 6, Y(opts.entry) - 3);
    }
    if (opts.exitLine) {
      ctx.setLineDash([6, 5]); ctx.strokeStyle = C.orange; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, Y(opts.exitLine)); ctx.lineTo(w, Y(opts.exitLine)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = C.orange; ctx.textAlign = "right"; ctx.fillText("Risk trailing stop", w - 6, Y(opts.exitLine) - 3); ctx.textAlign = "left";
    }
  }

  /* Analyst score ring 0-100, green from min (70). */
  function ring(cv, score, min) {
    const { ctx, w, h } = setup(cv);
    const r = Math.min(w, h) / 2 - 9, cx = w / 2, cy = h / 2;
    ctx.lineWidth = 12; ctx.lineCap = "round";
    ctx.strokeStyle = C.card2; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    if (score != null) {
      ctx.strokeStyle = score >= (min || 70) ? C.green : "#ffd60a";
      ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.001, score / 100)); ctx.stroke();
    }
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "600 40px -apple-system, 'SF Pro Display', Inter, sans-serif";
    ctx.fillText(score == null ? "–" : String(score), cx, cy);
  }

  window.Charts = { line, candles, ring, reduced };
})();

/* Desk iPhone app. Plain JS. Polls the plan B JSON files every 15s (no SSE on this hosting). */
(function () {
  "use strict";
  const DATA_BASE = "https://yefnihhdjrtqhhqhdzqy.supabase.co/storage/v1/object/public/desk/d/";
  const POLL_MS = 15000, STALE_S = 90;
  const AGENTS = ["scanner", "auditor", "analyst", "executor", "risk", "copier"];
  const COLORS = { scanner: "#64d2ff", auditor: "#0a84ff", analyst: "#ffd60a", executor: "#00d35a", risk: "#ff6b9a", copier: "#bf5af2" };
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduced = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- secret data path: opened once as {URL}#d={DATA_PATH}, then kept in localStorage ----
  (function takePath() {
    const m = location.hash.match(/[#&]d=([A-Za-z0-9_\-]{32,})/);
    if (m) { localStorage.setItem("desk.d", m[1]); } // keep #d= in the URL so Add to Home Screen saves it
  })();
  const DP = localStorage.getItem("desk.d");

  const S = { state: null, chart: {}, activity: null, agents: {}, account: null, settings: null, coin: {}, audit: {}, index: null,
              lastOk: null, failing: false, nextRetry: 0, range: localStorage.getItem("desk.range") || "LIVE", loaded: {} };

  async function get(path) {
    if (!DP) throw new Error("no path");
    const r = await fetch(DATA_BASE + DP + "/" + path + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  // ---- formatting ----
  const money = v => v == null ? "–" : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const big = v => { if (v == null) return "n/a"; v = +v; return v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "K" : "$" + v.toFixed(0); };
  const pct = (v, d = 2) => v == null ? "–" : (v >= 0 ? "+" : "") + Number(v).toFixed(d) + "%";
  const priceFmt = v => { if (v == null) return "–"; v = +v; if (v >= 1) return "$" + v.toFixed(4); const s = v.toPrecision(4); return "$" + (+s).toFixed(Math.min(12, Math.max(4, -Math.floor(Math.log10(v)) + 3))); };
  const hm = ts => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "–";
  const hms = ts => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "never";
  const ago = ts => { if (!ts) return ""; const m = Math.max(0, (Date.now() / 1000 - ts) / 60); return m < 60 ? Math.round(m) + "m old" : (m / 60).toFixed(0) + "h old"; };
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

  // ---- navbar ----
  function navbar(kind, title) {
    const nb = $("#navbar");
    if (kind === "home") {
      const unread = S.state && (S.state.pushCount || 0) > (+localStorage.getItem("desk.seen") || 0);
      nb.innerHTML = `<button class="iconbtn" data-go="account" aria-label="Account"><span class="avatar">${esc(((S.account && S.account.fomoHandle) || "M")[0].toUpperCase())}</span></button>
        <button class="nav-title" data-go="account">Grok Bot <span class="chev">›</span></button>
        <button class="iconbtn" data-go="search" aria-label="Search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg></button>
        <button class="iconbtn" id="bell" aria-label="Pushes"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/></svg>${unread ? '<i class="dot"></i>' : ""}</button>`;
    } else if (kind === "search") {
      nb.innerHTML = `<div class="search"><input id="q" placeholder="Name, symbol or mint" autocomplete="off" autofocus></div><button class="iconbtn" data-go="home" style="width:auto;padding:0 8px;color:var(--sec)">Cancel</button>`;
    } else {
      nb.innerHTML = `<div class="nav-title" style="font-size:28px;font-weight:700">${esc(title)}</div>`;
    }
  }

  // ---- error banner: "Desk offline · retrying in {n}s · last update {time}" ----
  function banner() {
    const el = $("#offline");
    const stale = S.state && (Date.now() / 1000 - S.state.ts > STALE_S);
    if (!DP) { el.hidden = false; el.textContent = "No desk link · open the app once from your private link"; return; }
    if (S.failing || stale) {
      const n = Math.max(0, Math.ceil((S.nextRetry - Date.now()) / 1000));
      el.hidden = false;
      el.textContent = `Desk offline · retrying in ${n}s · last update ${S.state ? hms(S.state.ts) : "never"}`;
    } else el.hidden = true;
  }

  // ---- odometer: each changed digit rolls 600ms ease-out, 30ms stagger right to left ----
  function odometer(el, text) {
    if (reduced() || !el.dataset.v || el.dataset.v.length !== text.length) {
      el.innerHTML = [...text].map(ch => /\d/.test(ch)
        ? `<span class="odo-d"><span class="odo-col" style="transform:translateY(-${+ch * 1.05}em)">${[...Array(10).keys()].map(d => `<span>${d}</span>`).join("")}</span></span>`
        : `<span>${esc(ch)}</span>`).join("");
      el.dataset.v = text; return;
    }
    const old = el.dataset.v; const cols = el.children;
    const n = text.length;
    for (let i = 0; i < n; i++) {
      if (old[i] !== text[i] && /\d/.test(text[i]) && cols[i].firstChild && cols[i].firstChild.style) {
        const c = cols[i].firstChild; c.style.transitionDelay = ((n - 1 - i) * 30) + "ms";
        c.style.transform = `translateY(-${+text[i] * 1.05}em)`;
      } else if (old[i] !== text[i]) { el.dataset.v = ""; odometer(el, text); return; }
    }
    el.dataset.v = text;
  }

  // ---- skeletons (loading state, final layout) ----
  const sk = (h, mt = 12, w = "100%", r = 12) => `<div class="sk" style="height:${h}px;margin-top:${mt}px;width:${w};border-radius:${r}px"></div>`;
  const skHome = () => sk(70, 14, "70%") + sk(22, 8, "45%") + sk(230, 18) + sk(44, 10) + `<h2>Agents</h2>` +
    `<div class="carousel"><div class="acard sk" style="border-radius:${42 * (innerWidth - 32) / 504}px"></div></div><h2>Activity</h2>` + sk(60, 0) + sk(60, 1) + sk(60, 1);
  const skList = n => [...Array(n)].map((_, i) => sk(i % 3 ? 60 : 140, 12, "100%", 20)).join("");

  // ---- agent cards (Home carousel) ----
  function agentCard(name, d, st) {
    const w = Math.min(innerWidth, 600) - 32, radius = 42 * w / 504;
    const col = COLORS[name];
    let body = "";
    if (name === "scanner") {
      const feed = (d.feed || []).slice(0, 5);
      body = `<div class="big num">${d.pools} pools</div><div class="sub">${d.connected ? "PumpPortal live" : "reconnecting…"} · ${d.waiting} waiting</div>` +
        (feed.length ? `<div class="feed">${feed.map(f => f.verdict === "pass"
          ? `<div class="r passed"><span class="n">${esc(f.name)} · liq ${big(f.liq)}</span><span class="why">→ auditor</span></div>`
          : `<div class="r killed"><span class="n">${esc(f.name)}</span><span class="why">${esc(f.reason)}</span></div>`).join("")}</div>`
          : `<div class="empty" style="padding:30px 0 0">Listening for graduations</div>`);
    } else if (name === "auditor") {
      const layers = d.running ? d.runningLayers : (d.last ? d.last.layers : []);
      const strips = [...Array(8)].map((_, i) => { const v = layers && layers[i]; return `<div class="strip ${v === true ? "ok" : v === false ? "no" : (d.running && i === (layers || []).length ? "run" : "")}"></div>`; }).join("");
      const status = d.running ? "taking apart..." : d.last ? (d.last.passed ? "8/8 → Executor" : esc(d.last.reason)) : "No coin taken apart yet";
      body = `<div class="big num">${d.takenApart} taken apart</div><div class="strips">${strips}</div>
        <div class="sub" style="margin-top:14px;color:${d.last && !d.running ? (d.last.passed ? "var(--green)" : "var(--red)") : "var(--sec)"}">${d.lastName && !d.running ? esc(d.lastName) + " · " : ""}${status}</div>
        <div class="sub" style="margin-top:auto">${d.rejected} rejected</div>`;
    } else if (name === "analyst") {
      const sc = d.last ? d.last.score : null;
      body = `<div class="big" style="font-size:28px">${d.scoring ? "Scoring" : "Scoring"}</div>
        <canvas class="ring" data-ring="${sc == null ? "" : sc}" data-min="${d.minScore}"></canvas>
        <div class="sub" style="text-align:center">${d.last ? esc(d.last.name) + " · " + (d.last.passed ? "passed" : esc(d.last.reason || "rejected")) : "Nothing scored yet"}${d.mode === "rules" ? " · rules" : ""}</div>`;
    } else if (name === "executor") {
      const l = d.last;
      const fresh = l && l.ts && (Date.now() / 1000 - l.ts) < 60;
      body = `<div class="big num">${d.trades} trades</div>
        <div class="sub">${l && l.size ? money(l.size) + " · " + (+l.pct).toFixed(2) + "% of stack" : (st.stackPct + "% of stack")}</div>
        ${l && l.size ? `<div class="bar"><i data-fill="${l.status === "bought" ? (fresh ? "anim" : "full") : "wait"}" data-ts="${l.ts}"></i></div>
        <div class="sub exlabel" style="margin-top:8px">${l.status === "bought" ? (fresh && !reduced() ? "Executing... 0%" : "✓ Filled") : l.status === "sent" ? "Executing... waiting for your tap" : esc(l.reason || l.status)}</div>` : `<div class="sub" style="margin-top:16px">No trade yet</div>`}
        ${l ? `<div class="sub" style="margin-top:auto">${esc(l.name)}</div>` : ""}`;
    } else if (name === "risk") {
      body = `<div class="big" style="font-size:34px">${d.guarding ? "Guarding" : (d.lastExit || "Idle")}</div>
        <div class="sub">${d.guarding ? d.guarding + " open" : (d.lastExitName ? esc(d.lastExitName) : "No position yet")}${d.guarding && d.lastExit ? " · last: " + d.lastExit : ""}</div>
        <div class="pills"><span class="tp red">stop -${d.stopPct}%</span><span class="tp green">trail ${d.trailPct}%</span></div>`;
    } else if (name === "copier") {
      const l = d.last, f = d.following || [];
      body = `<div class="big num">${d.copies} copies</div>
        <div class="sub">${f.length ? "Following " + esc(f.slice(0, 3).join(", ")) + (f.length > 3 ? " +" + (f.length - 3) : "") : "Following nobody · /follow"}</div>
        <div class="sub" style="margin-top:8px">${d.open} open · ${d.active ? "copying" : "outside " + esc(d.startTime) + "–" + esc(d.lockTime)}${d.lagS != null ? " · lag " + d.lagS + "s" : ""}</div>
        ${l ? `<div class="sub" style="margin-top:auto">${esc(l.name || "")} · ${esc(l.side || "")}${l.reason ? " · " + esc(l.reason) : ""}</div>` : ""}
        <div class="pills"><span class="tp green">TP ${d.tpX}×</span><span class="tp">+${d.delayS}s</span><span class="tp red">lock ${esc(d.lockTime)}</span></div>`;
    }
    return `<div class="acard" data-agent="${name}" style="border-radius:${radius}px"><div class="who"><i style="background:${col}"></i>${cap(name)}${st.paused && st.paused[name] ? ' <span class="ter">· paused</span>' : ""}</div>${body}</div>`;
  }

  function afterCards(root) {
    root.querySelectorAll("canvas[data-ring]").forEach(c => Charts.ring(c, c.dataset.ring === "" ? null : +c.dataset.ring, +c.dataset.min));
    root.querySelectorAll(".bar>i").forEach(i => {
      const lbl = i.closest(".acard").querySelector(".exlabel");
      if (i.dataset.fill === "full") { i.style.transition = "none"; i.style.width = "100%"; }
      else if (i.dataset.fill === "anim") {
        if (reduced()) { i.style.width = "100%"; if (lbl) lbl.textContent = "✓ Filled"; return; }
        const t0 = performance.now();
        requestAnimationFrame(() => { i.style.width = "100%"; });
        const tick = () => { const p = Math.min(100, Math.round((performance.now() - t0) / 12)); if (lbl) lbl.textContent = p < 100 ? `Executing... ${p}%` : "✓ Filled"; if (p < 100) requestAnimationFrame(tick); };
        tick();
      } else { i.style.width = "35%"; }
    });
  }

  function activityRows(rows, empty) {
    if (!rows || !rows.length) return `<div class="list"><div class="empty">${empty}</div></div>`;
    return `<div class="list">${rows.map(r => {
      const ic = { bought: ["B", "#0a84ff"], sold: ["S", "#00d35a"], stopped: ["S", "#ff453a"], rejected: ["R", "#3a3a3c"] }[r.kind] || ["·", "#3a3a3c"];
      const vcol = r.kind === "sold" ? (String(r.value).startsWith("-") ? "red" : "green") : r.kind === "stopped" ? "red" : r.kind === "rejected" ? "ter" : "";
      return `<button class="row" style="width:100%;text-align:left" data-go="${r.opens}/${esc(r.mint)}">
        <span class="ic" style="background:${ic[1]}">${ic[0]}</span>
        <span class="tt"><div class="t1">${esc(r.title)}</div><div class="t2">${esc(r.subtitle)} · ${hm(r.ts)}</div></span>
        <span class="v ${vcol}">${esc(r.value)}</span></button>`;
    }).join("")}</div>`;
  }

  // ---- views ----
  let lastChartLen = 0;
  function viewHome() {
    navbar("home");
    const st = S.state;
    if (!st) { $("#view").innerHTML = skHome(); return; }
    const ch = S.chart[S.range];
    const empty = !ch || !(ch.marks || []).length;
    const running = AGENTS.filter(a => !(st.paused || {})[a]).length;
    let el = $("#view .home");
    if (!el) {
      $("#view").innerHTML = `<div class="home">
        <div class="balance-row"><div class="balance num" id="bal"></div>${st.mode === "PAPER" ? '<span class="paper">PAPER</span>' : ""}</div>
        <div class="subline"><span id="today"></span><span class="pill mult" id="mult"></span></div>
        <div class="chart-wrap"><canvas class="chart" id="line"></canvas><div class="chart-empty" id="chempty" hidden>Waiting for the first trade</div></div>
        <div class="ranges">${["LIVE", "1H", "4H", "1D", "1W", "ALL"].map(r => `<button data-range="${r}">${r}</button>`).join("")}</div>
        <h2>Agents <span class="muted" id="running"></span></h2><div class="carousel" id="cards"></div>
        <h2>Activity <button class="link" data-go="activity">See all</button></h2><div id="act5"></div></div>`;
      el = $("#view .home");
    }
    odometer($("#bal"), money(st.balance));
    $("#today").innerHTML = `<span class="${st.todayPct >= 0 ? "green" : "red"}">${pct(st.todayPct)}</span> <span class="muted">today</span>`;
    $("#mult").textContent = (st.multiplier || 1).toFixed(2) + "×";
    $("#running").textContent = "· " + running + " running";
    document.querySelectorAll("[data-range]").forEach(b => b.classList.toggle("on", b.dataset.range === S.range));
    const cards = $("#cards"); const sl = cards.scrollLeft;
    cards.innerHTML = AGENTS.map(a => agentCard(a, st.agents[a], st)).join(""); cards.scrollLeft = sl; afterCards(cards);
    $("#act5").innerHTML = activityRows(S.activity ? S.activity.rows.slice(0, 5) : null, "Nothing yet tonight");
    $("#chempty").hidden = !empty;
    const cv = $("#line");
    // empty state: dashed start line only + "Waiting for the first trade"
    const data = empty ? { points: [], start: st.nightStartBalance, marks: [] } : ch;
    const grew = data.points.length > lastChartLen && lastChartLen > 0; lastChartLen = data.points.length;
    if (grew && !reduced()) {
      const t0 = performance.now();
      const f = () => { const p = Math.min(1, (performance.now() - t0) / 250); Charts.line(cv, data, p); if (p < 1) requestAnimationFrame(f); }; f();
    } else Charts.line(cv, data, 1);
  }

  function viewAgents() {
    navbar("title", "Agents");
    const st = S.state;
    if (!st || AGENTS.some(a => !S.agents[a])) { $("#view").innerHTML = skList(5); return; }
    $("#view").innerHTML = AGENTS.map(a => {
      const d = S.agents[a];
      const decs = (d.decisions || []);
      return `<div class="fcard" id="agent-${a}"><div class="fhead"><span class="sdot ${d.paused ? "off" : ""}"></span><span class="nm">${cap(a)}</span>
        <span class="muted small">${d.today} today</span>
        <span class="switch-wrap" title="Plan B: send '${d.paused ? "resume" : "pause"} ${cap(a)}' to the bot"><span class="switch ${d.paused ? "" : "on"} ${d.pauseLocked ? "locked" : ""}"></span></span></div>
        <div class="note" style="padding:6px 0 4px">${d.paused ? "Paused" : "Running"}${d.pauseLocked ? " · locked while a position is open" : ""} · via Telegram: “${d.paused ? "resume" : "pause"} ${cap(a)}”</div>
        ${decs.length ? decs.map(x => `<div class="dec"><span class="muted">${hm(x.ts)}</span>
          ${x.coinUrl ? `<a href="${esc(x.coinUrl)}" target="_blank" rel="noopener">${esc(x.name || x.mint)}</a>` : `<span>${esc(x.name)}</span>`}
          <span class="vd ${/kill|reject|stop|skip|missed/.test(x.verdict) ? "no" : "ok"}">${esc(x.reason || x.verdict)}</span></div>`).join("")
          : `<div class="empty" style="padding:18px 0">${a === "scanner" ? "Listening for graduations" : a === "auditor" ? "No coin taken apart yet" : a === "copier" ? "No copied trade yet · /follow handle" : "Nothing yet tonight"}</div>`}
        <div class="btnrow"><span></span><button class="chip" data-go="account" data-sec="${a === "copier" ? "copy" : a}">Settings ›</button></div></div>`;
    }).join("");
  }

  function viewActivity() {
    navbar("title", "Activity");
    if (!S.activity) { $("#view").innerHTML = skList(6); return; }
    $("#view").innerHTML = activityRows(S.activity.rows, "Nothing yet tonight") +
      (S.activity.pages > 1 ? `<div class="note" style="text-align:center">Showing the newest 30</div>` : "");
  }

  function viewAccount() {
    navbar("title", "Account");
    const a = S.account, s = S.settings;
    if (!a || !s) { $("#view").innerHTML = sk(44, 14) + sk(120, 14) + sk(300, 14); return; }
    const group = g => `<h2 id="set-${g}">${cap(g)}</h2><div class="list">${s.groups[g].map(x => {
      const isNum = x.type === "float" || x.type === "int";
      return `<div class="setrow"><div class="top"><span>${esc(x.label.replace(/_/g, " "))}</span>
        ${isNum ? `<input type="number" value="${esc(x.value)}" disabled>` : `<input type="text" value="${esc(x.value)}" disabled>`}</div>
        ${isNum && x.min != null ? `<input type="range" min="${x.min}" max="${x.max}" step="any" value="${esc(x.value)}" disabled>` : ""}
        <div class="cmd">${esc(x.command)}</div></div>`;
    }).join("")}</div>`;
    $("#view").innerHTML = `
      <div class="list" style="margin-top:12px">
        <div class="setrow"><div class="top"><span>Mode</span><div class="seg" style="width:170px"><span class="${a.mode === "PAPER" ? "on" : ""}">PAPER</span><span class="${a.mode === "LIVE" ? "on" : ""}">LIVE</span></div></div>
          <div class="cmd">${a.liveAllowed ? "send “live”, then type LIVE" : "LIVE unlocks after 1 full PAPER night"}</div></div>
        <div class="setrow"><div class="top"><span>Stack</span><input type="text" value="${money(a.stack)}" disabled></div><div class="cmd">LIVE stack: “stack 1240”</div></div>
      </div>
      <h2>FOMO</h2><div class="list">
        <a class="row" href="${esc(a.profileUrl)}" target="_blank" rel="noopener"><span class="ic" style="background:#2c2c2e">@</span><span class="tt"><div class="t1">Your FOMO profile</div><div class="t2">@${esc(a.fomoHandle)}</div></span><span class="ter">›</span></a>
        <button class="row" id="invite" style="width:100%;text-align:left"><span class="ic" style="background:#2c2c2e">+</span><span class="tt"><div class="t1">Invite a friend</div><div class="t2">Share your FOMO invite link</div></span><span class="ter">›</span></button>
      </div>
      <h2>Notifications</h2><div class="list">
        <div class="row"><span class="tt"><div class="t1">Telegram</div><div class="t2">${esc(a.telegram.bot)}</div></span><span class="v ${a.telegram.connected ? "green" : "red"}">${a.telegram.connected ? "Connected" : "Not connected"}</span></div>
        <div class="row"><span class="tt"><div class="t1">Send test push</div><div class="t2">Ask the bot: “status”</div></span><span class="v ter">via Telegram</span></div>
        <div class="row"><span class="tt"><div class="t1">Web push</div><div class="t2">${esc(a.webPush)}</div></span><span class="v ter">Not available</span></div>
      </div>
      <div class="note">${esc(s.howToChange)} Settings here are read-only on this hosting.</div>
      ${Object.keys(s.groups).map(group).join("")}`;
    $("#invite").onclick = async () => {
      try { if (navigator.share) { await navigator.share({ title: "FOMO", url: a.signupUrl }); return; } } catch (e) { return; }
      try { await navigator.clipboard.writeText(a.signupUrl); } catch (e) { /* ignore */ }
      toast("Link copied");
    };
    const sec = sessionStorage.getItem("desk.sec");
    if (sec) { sessionStorage.removeItem("desk.sec"); const t = document.getElementById("set-" + sec); if (t) t.scrollIntoView(); }
  }

  function toast(t) { const d = document.createElement("div"); d.className = "toast"; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 1800); }

  function viewSearch() {
    navbar("search");
    const run = () => {
      const q = ($("#q") && $("#q").value || "").trim().toLowerCase();
      const coins = (S.index && S.index.coins) || [];
      const hits = coins.filter(c => !q || (c.name || "").toLowerCase().includes(q) || (c.symbol || "").toLowerCase().includes(q) || c.mint.toLowerCase() === q);
      $("#view").innerHTML = hits.length ? `<div class="list" style="margin-top:12px">${hits.map(c => `<button class="row" style="width:100%;text-align:left" data-go="coin/${esc(c.mint)}"><span class="tt"><div class="t1">${esc(c.name)}</div><div class="t2">${esc(c.symbol || "")} · ${esc(c.mint.slice(0, 4))}…${esc(c.mint.slice(-4))}</div></span><span class="ter">›</span></button>`).join("")}</div>`
        : `<div class="empty">${S.index ? "No coin from tonight matches" : "Loading…"}</div>`;
    };
    $("#q").oninput = run; run();
  }

  // ---- overlay: coin ----
  function viewCoin(mint) {
    const o = $("#overlay"); o.hidden = false;
    const c = S.coin[mint];
    const head = (t, extra) => `<div class="ohead"><button class="iconbtn" data-back aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button><div class="ttl">${t}</div>${extra || ""}</div>`;
    if (c === undefined) { o.innerHTML = head("") + `<div class="obody">${sk(28, 8, "60%")}${sk(60, 10, "70%")}${sk(260, 14)}${sk(130, 14)}</div>`; return; }
    if (c === null) { o.innerHTML = head("Coin") + `<div class="obody"><div class="empty">This coin isn't on the desk tonight.</div></div>`; return; }
    const pos = c.position, open = pos && pos.status === "open";
    const ex = c.exits;
    o.innerHTML = head(`${esc(c.name)}`, (c.mode === "PAPER" ? '<span class="paper" style="margin-right:12px">PAPER</span>' : "")) + `<div class="obody">
      <div class="muted" style="display:flex;align-items:center;gap:8px">${esc(c.symbol || "")} · Solana · ${ago(c.migratedAt)} ${c.shield ? `<span class="shield ${c.shield === "8/8" ? "" : "bad"}">⛨ ${c.shield}</span>` : ""}</div>
      <div class="price num">${priceFmt(c.price)}</div>
      ${c.sinceEntryPct != null ? `<div class="${c.sinceEntryPct >= 0 ? "green" : "red"}" style="font-weight:600;font-size:17px">${c.sinceEntryPct >= 0 ? "▲" : "▼"} ${Math.abs(c.sinceEntryPct).toFixed(2)}% since entry</div>` : ""}
      <canvas class="candles" id="cnd"></canvas>
      <div class="stats"><div><div class="k">Market cap</div><div class="vv">${big(c.stats.marketCap)}</div></div><div><div class="k">Liquidity</div><div class="vv">${big(c.stats.liquidity)}</div></div>
        <div><div class="k">24h volume</div><div class="vv">${big(c.stats.volume24h)}</div></div><div><div class="k">Holders</div><div class="vv">${c.stats.holders == null ? "n/a" : c.stats.holders.toLocaleString()}</div></div></div>
      ${pos ? `<div class="ecard"><div style="font-weight:600">Your position · ${money(pos.sizeUsd)} in · ${pos.source === "copy" ? "Copier · " + esc(pos.copyOf && pos.copyOf.length > 30 ? pos.copyOf.slice(0, 4) + "…" : "@" + pos.copyOf) : "Executor"}</div>
        <div class="muted small" style="margin-top:3px">entry ${priceFmt(pos.entryPrice)} · ${hm(pos.openedAt)}${pos.status !== "open" ? " · " + esc(pos.exitReason) + " " + (pos.pnlUsd >= 0 ? "+" : "-") + money(Math.abs(pos.pnlUsd)).replace("$", "$") : ""}</div></div>` : ""}
      ${open && ex && ex.tpLine ? `<div class="ecard">
        <div class="l"><span class="muted">Take profit</span><span class="green num">${priceFmt(ex.tpLine)}</span></div>
        ${ex.stopLine ? `<div class="l"><span class="muted">Stop line</span><span class="red num">${priceFmt(ex.stopLine)}</span></div>` : ""}
        <div class="l"><span class="muted">Sells when they sell · locks</span><span class="num">${esc(ex.lockTime)}</span></div></div>` : ""}
      ${open && ex && !ex.tpLine ? `<div class="ecard">
        <div class="l"><span class="muted">Stop line (-${pos.stopPct}%)</span><span class="red num">${priceFmt(ex.stopLine)}</span></div>
        <div class="l"><span class="muted">Trail line</span><span class="green num">${ex.trailActive ? priceFmt(ex.trailLine) : "from " + priceFmt(ex.trailStartAt)}</span></div>
        <div class="l"><span class="muted">Timeout in</span><span class="num">${Math.max(0, Math.round((ex.timeoutAt - Date.now() / 1000) / 60))}m</span></div></div>` : ""}
      </div><a class="cta ${open ? "sell" : ""}" href="${esc(c.coinUrl)}" target="_blank" rel="noopener">${open ? "Sell on FOMO" : "Buy on FOMO"}</a>`;
    Charts.candles($("#cnd"), c.candles, { exitLine: open && ex ? ex.exitLine : null, entry: open ? pos.entryPrice : null });
  }

  // ---- overlay: auditor screen ----
  const animated = {};
  function viewAudit(mint) {
    const o = $("#overlay"); o.hidden = false;
    const a = mint ? S.audit[mint] : null;
    const head = `<div class="ohead"><button class="iconbtn" data-back aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button><div class="ttl">Auditor${a ? " · " + esc(a.name) : ""}</div></div>`;
    if (mint && a === undefined) { o.innerHTML = head + `<div class="obody"><div class="sk" style="height:300px;width:240px;margin:12px auto 0;border-radius:40px"></div>${sk(48, 14)}${sk(380, 1)}</div>`; return; }
    if (!a) { o.innerHTML = head + `<div class="obody"><div class="empty" style="padding-top:120px">No coin taken apart yet</div></div>`; return; }
    const L = a.layers;
    const discs = [...Array(8)].map((_, i) => `<div class="disc" id="disc${i}" style="top:${i * 34}px;z-index:${8 - i}">${i + 1}</div>`).join("");
    const verdict = a.complete ? (a.passed
      ? `<div class="v1 green">Cleared · 8/8 parts</div><div class="v2">${a.sentToExecutorUsd ? "Sent to Executor · " + money(a.sentToExecutorUsd) : "Sent to Executor"}</div>`
      : `<div class="v1 red">Rejected · ${esc(a.reason)}</div><div class="v2">Grok Bot won't buy ${esc(a.name)}</div>`) : `<div class="v1 muted">taking apart...</div>`;
    o.innerHTML = head + `<div class="obody"><div class="discs">${discs}<div class="beam" id="beam" style="top:-6px"></div></div>
      <div class="verdict" id="verdict" style="visibility:hidden">${verdict}</div>
      <div class="list" style="margin-top:18px">${[...Array(8)].map((_, i) => { const l = L[i]; return `<div class="lrow"><span class="mark nc" id="mk${i}">${i + 1}</span><span class="lk">${esc(l ? l.name : ["Mint authority", "Freeze authority", "Dev wallet", "Top 10 holders", "Liquidity", "Pool age", "Bundled wallets", "Delegations"][i])}</span><span class="lv" id="lv${i}"></span></div>`; }).join("")}</div>
      <div class="list" style="margin-top:14px"><div class="setrow"><div class="top"><span>Take apart before buying</span><span class="switch ${a.enabled ? "on" : ""} locked"></span></div><div class="cmd">plan B: “set auditor off” (asks twice)</div></div></div>
      </div><a class="cta" href="${esc(a.coinUrl)}" target="_blank" rel="noopener">Open on FOMO</a>`;
    const paint = i => {
      const l = L[i]; if (!l) return;
      const d = $("#disc" + i), mk = $("#mk" + i);
      const cls = l.pass === true ? "ok" : l.pass === false ? "no" : "nc";
      d.className = "disc " + cls; d.textContent = l.pass === true ? "✓" : l.pass === false ? "✕" : i + 1;
      mk.className = "mark " + cls; mk.textContent = l.pass === true ? "✓" : l.pass === false ? "✕" : "–";
      $("#lv" + i).innerHTML = `<span class="${l.pass === false ? "red" : l.pass === null ? "ter" : ""}">${esc(l.value)}</span>`;
    };
    const key = mint + ":" + L.length + ":" + a.complete;
    if (reduced() || animated[key]) { L.forEach((_, i) => paint(i)); $("#beam").style.display = "none"; $("#verdict").style.visibility = "visible"; return; }
    animated[key] = true;
    // beam: 350ms per layer top to bottom, then 150ms to green or red; waits on a layer the server hasn't sent
    let i = 0;
    const step = () => {
      const beam = $("#beam"); if (!beam) return;
      if (i >= 8 || !L[i]) { if (i >= 8 || a.complete) { beam.style.display = "none"; $("#verdict").style.visibility = "visible"; } return; }
      beam.style.top = (i * 34 + 20) + "px";
      setTimeout(() => { setTimeout(() => { paint(i); i++; step(); }, 150); }, 350);
    };
    step();
  }

  // ---- router ----
  function route() {
    let h = (location.hash || "#home").slice(1); if (h.startsWith("d=")) h = "home";
    const [name, arg] = h.split("/");
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === name));
    if (name === "coin" || name === "audit") {
      document.body.style.overflow = "hidden";
      if (name === "coin") { if (!(arg in S.coin)) loadCoin(arg); viewCoin(arg); }
      else {
        let m = arg;
        if (!m && S.state && S.state.agents.auditor.last) m = S.state.agents.auditor.last.mint;
        if (m && !(m in S.audit)) loadAudit(m);
        viewAudit(m);
      }
      return;
    }
    document.body.style.overflow = ""; $("#overlay").hidden = true; $("#overlay").innerHTML = "";
    if (name !== "home") { $("#view").innerHTML = ""; lastChartLen = 0; }
    ({ home: viewHome, agents: viewAgents, activity: viewActivity, account: viewAccount, search: viewSearch }[name] || viewHome)();
    banner();
  }
  function rerender() {
    let name = (location.hash || "#home").slice(1).split("/")[0]; if (name.startsWith("d=")) name = "home";
    if (name === "search") return;
    if (name === "home" || !name) viewHome(); else route();
    banner();
  }

  async function loadCoin(m) { try { S.coin[m] = await get("coin/" + m + ".json"); } catch (e) { S.coin[m] = S.coin[m] || (e.message.startsWith("HTTP 4") ? null : undefined); } if (location.hash === "#coin/" + m) viewCoin(m); }
  async function loadAudit(m) { try { S.audit[m] = await get("audit/" + m + ".json"); } catch (e) { S.audit[m] = S.audit[m] || (e.message.startsWith("HTTP 4") ? null : undefined); } if (location.hash.startsWith("#audit")) viewAudit(m); }

  // ---- polling (instead of SSE) ----
  async function poll() {
    if (!DP) { banner(); return; }
    try {
      const st = await get("state.json");
      S.state = st; S.failing = false; S.lastOk = Date.now();
      const name = (location.hash || "#home").slice(1).split("/")[0], arg = (location.hash.split("/")[1]);
      const jobs = [get("chart/" + S.range + ".json").then(x => S.chart[S.range] = x), get("activity.json").then(x => S.activity = x)];
      if (name === "agents") AGENTS.forEach(a => jobs.push(get("agents/" + a + ".json").then(x => S.agents[a] = x)));
      if (name === "account" || !S.account) jobs.push(get("account.json").then(x => S.account = x), get("settings.json").then(x => S.settings = x));
      if (name === "search" || !S.index) jobs.push(get("index.json").then(x => S.index = x).catch(() => {}));
      if (name === "coin" && arg) jobs.push(get("coin/" + arg + ".json").then(x => S.coin[arg] = x).catch(() => {}));
      if (name === "audit" && arg) jobs.push(get("audit/" + arg + ".json").then(x => S.audit[arg] = x).catch(() => {}));
      await Promise.all(jobs);
    } catch (e) {
      S.failing = true;
    }
    S.nextRetry = Date.now() + POLL_MS;
    rerender();
  }

  // ---- events ----
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-go],[data-tab],[data-range],[data-back],#bell,.acard");
    if (!b) return;
    if (b.dataset.back !== undefined) { history.length > 1 ? history.back() : (location.hash = "#home"); return; }
    if (b.id === "bell") { localStorage.setItem("desk.seen", (S.state && S.state.pushCount) || 0); location.hash = "#activity"; return; }
    if (b.dataset.range) { S.range = b.dataset.range; localStorage.setItem("desk.range", S.range); lastChartLen = 0;
      get("chart/" + S.range + ".json").then(x => { S.chart[S.range] = x; viewHome(); }).catch(() => {}); viewHome(); return; }
    if (b.dataset.tab) { location.hash = "#" + b.dataset.tab; return; }
    if (b.classList.contains("acard")) { location.hash = b.dataset.agent === "auditor" ? "#audit" : "#agents"; return; }
    if (b.dataset.sec) sessionStorage.setItem("desk.sec", b.dataset.sec);
    if (b.dataset.go) { if (b.dataset.go.endsWith("/")) return; location.hash = "#" + b.dataset.go; }
  });
  addEventListener("hashchange", () => { route(); if (DP) poll(); });
  addEventListener("resize", () => rerender());
  setInterval(banner, 1000);
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  route(); poll(); setInterval(poll, POLL_MS);
})();

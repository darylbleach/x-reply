// X Reply Autopilot – Queue mode, Background Autopilot Scanner, and Job Executor
(() => {
  const X = window.__xra;
  if (!X || window.__xraQueueLoaded) return;
  window.__xraQueueLoaded = true;
  const { SEL, sleep, norm, send } = X;
  const S = () => X.getSettings();

  /* =====================================================================
     1. JOB EXECUTOR – runs when the scheduler opened this tab for a job
     ===================================================================== */
  let jobHandled = false;
  async function maybeRunJob() {
    if (jobHandled || window.__xraIsJobTab) return;
    const isStatus = /\/status\/\d+/.test(location.pathname);
    const isCompose = /\/compose\/post/.test(location.pathname);
    if (!isStatus && !isCompose) return;
    let res;
    try { res = await send({ type: "JOB_FOR_URL", payload: { url: location.href } }); } catch (_) { return; }
    const job = res?.job;
    if (!job) return;
    jobHandled = true;
    window.__xraIsJobTab = true;
    const banner = document.createElement("div");
    banner.className = "xra-jobbanner";
    banner.textContent = "X Reply Autopilot is posting a scheduled " + (job.kind === "post" ? "post" : "reply") + "…";
    document.body.appendChild(banner);
    const report = async (ok, error) => {
      banner.textContent = ok ? "Posted ✓ – this tab will close" : "Couldn't post: " + error;
      banner.classList.add(ok ? "ok" : "err");
      try { await send({ type: "JOB_RESULT", payload: { id: job.id, ok, error } }); } catch (_) {}
    };
    try {
      // Wait for the composer; if on a status page and the inline composer is collapsed, click reply
      let editor = null;
      for (let i = 0; i < 60 && !editor; i++) {
        editor = document.querySelector(SEL.editor);
        if (!editor && isStatus && i === 16) {
          const replyIcon = document.querySelector('article[data-testid="tweet"] [data-testid="reply"]');
          if (replyIcon) { try { replyIcon.click(); } catch (_) {} }
        }
        if (!editor) await sleep(500);
      }
      if (!editor) throw new Error("reply box never appeared (post deleted, restricted, or not logged in)");
      // Human-like reading pause before typing
      await sleep(1200 + Math.floor(Math.random() * 1400));
      const ok = await X.insertIntoEditor(editor, job.text);
      if (!ok) throw new Error("couldn't insert the text");
      // Human-like review pause proportional to reply length
      await sleep(600 + Math.min(1800, job.text.length * 10) + Math.floor(Math.random() * 600));
      const clicked = await X.postNow(editor);
      if (!clicked) throw new Error("Reply button not found or disabled");
      // Confirm: editor empties / disappears, or a toast appears
      let confirmed = false;
      for (let i = 0; i < 30 && !confirmed; i++) {
        await sleep(400);
        const e = document.querySelector(SEL.editor);
        const toast = document.querySelector('[data-testid="toast"]');
        if (!e || !X.editorText(e) || (toast && /sent|posted/i.test(toast.textContent))) confirmed = true;
      }
      if (!confirmed) throw new Error("no confirmation from X after pressing Reply");
      await report(true);
    } catch (e) {
      await report(false, e.message);
    }
  }
  setTimeout(maybeRunJob, 1500);
  setTimeout(maybeRunJob, 5500);

  /* =====================================================================
     2. BACKGROUND AUTOPILOT SCANNER – runs when opened by background.js
     ===================================================================== */
  let autopilotHandled = false;

  function collectFeedCandidates(seenIds) {
    const s = S();
    const mine = (s.handle || "").toLowerCase();
    const maxAge = (s.queueMaxAgeHours || 24) * 3600 * 1000;
    const minChars = s.queueMinChars ?? 20;
    const found = [];
    document.querySelectorAll(SEL.article).forEach((a) => {
      if (X.isRepost(a)) return;
      if (a.querySelector('[data-testid="placementTracking"]')) return; // ad
      const au = X.articleAuthor(a);
      if (!au.handle || (mine && au.handle.toLowerCase() === mine)) return;
      const id = X.articleStatusId(a);
      if (!id || seenIds.has(id)) return;
      const text = X.articleText(a);
      if (text.length < minChars) return;
      const t = a.querySelector("time")?.getAttribute("datetime");
      const ts = t ? Date.parse(t) : Date.now();
      if (Date.now() - ts > maxAge) return;
      seenIds.add(id);
      found.push({
        id,
        handle: au.handle,
        author: `@${au.handle}`,
        name: au.name,
        postText: text,
        url: `https://x.com/${au.handle}/status/${id}`,
        ts
      });
    });
    return found;
  }

  async function maybeRunAutopilotScan() {
    if (autopilotHandled || jobHandled || window.__xraIsJobTab) return;
    let res;
    try { res = await send({ type: "AUTOPILOT_FOR_TAB", payload: { url: location.href } }); } catch (_) { return; }
    const task = res?.task;
    if (!task) return;
    autopilotHandled = true;
    window.__xraIsJobTab = true;

    const banner = document.createElement("div");
    banner.className = "xra-jobbanner";
    banner.textContent = "🤖 X Reply Autopilot Autopilot: waiting for feed to load…";
    document.body.appendChild(banner);

    try {
      for (let i = 0; i < 40 && !document.querySelector(SEL.article); i++) await sleep(500);
      if (!document.querySelector(SEL.article)) {
        throw new Error("No posts found on feed page (check login or URL)");
      }
      await sleep(1000);

      const seenIds = new Set();
      const allFound = [];
      const scrolls = Math.max(1, Math.min(10, task.scrolls || 3));
      for (let sc = 0; sc < scrolls; sc++) {
        banner.textContent = `🤖 X Reply Autopilot Autopilot: scanning feed (pass ${sc + 1}/${scrolls})…`;
        const batch = collectFeedCandidates(seenIds);
        allFound.push(...batch);
        if (sc < scrolls - 1) {
          window.scrollBy({ top: window.innerHeight * 1.4, behavior: "instant" });
          await sleep(1500);
        }
      }

      let fresh = allFound;
      try {
        const fRes = await send({ type: "FILTER_NEW", payload: { ids: allFound.map((f) => f.id) } });
        if (fRes?.ok) {
          const allowed = new Set(fRes.ids);
          fresh = allFound.filter((f) => allowed.has(f.id));
        }
      } catch (_) {}

      const targets = fresh.slice(0, task.maxDrafts || 5);
      const approvedItems = [];

      if (targets.length > 0) {
        let idx = 0;
        let doneCount = 0;
        const worker = async () => {
          while (idx < targets.length) {
            const postItem = targets[idx++];
            try {
              banner.textContent = `🤖 X Reply Autopilot Autopilot: drafting replies (${doneCount + 1}/${targets.length})…`;
              const r = await send({
                type: "GENERATE",
                payload: {
                  post: { author: `${postItem.author} (${postItem.name || ""})`, text: postItem.postText },
                  thread: [],
                  draft: "",
                  count: 1,
                  tweak: ""
                }
              });
              const replyText = (r?.suggestions?.[0] || "").trim();
              if (r?.ok && replyText) {
                approvedItems.push({
                  kind: "reply",
                  url: postItem.url,
                  statusId: postItem.id,
                  author: postItem.author,
                  postText: postItem.postText,
                  text: replyText
                });
              }
            } catch (_) {}
            doneCount++;
          }
        };
        await Promise.all([worker(), worker()]);
      }

      if (approvedItems.length > 0) {
        await send({
          type: "QUEUE_ADD",
          payload: { items: approvedItems, spreadMinutes: S().queueSpread || 60, auto: true }
        });
      }

      banner.textContent = `🤖 Autopilot complete: scheduled ${approvedItems.length} repl${approvedItems.length === 1 ? "y" : "ies"} ✓ – closing tab`;
      banner.classList.add("ok");
      await send({
        type: "AUTOPILOT_COMPLETE",
        payload: { id: task.id, ok: true, found: fresh.length, scheduled: approvedItems.length, sourceUrl: location.href }
      });
    } catch (e) {
      banner.textContent = "🤖 Autopilot scan error: " + e.message;
      banner.classList.add("err");
      try {
        await send({ type: "AUTOPILOT_COMPLETE", payload: { id: task.id, ok: false, error: e.message, sourceUrl: location.href } });
      } catch (_) {}
    }
  }
  setTimeout(maybeRunAutopilotScan, 1400);
  setTimeout(maybeRunAutopilotScan, 5000);

  /* =====================================================================
     3. QUEUE & AUTOPILOT DRAWER
     ===================================================================== */
  const SPREADS = [
    [15, "next 15 min"], [30, "next 30 min"], [60, "next hour"], [120, "next 2 hours"], [240, "next 4 hours"], [480, "next 8 hours"]
  ];
  let drawer = null, fab = null, open = false;
  let drafts = []; // { id, author, handle, postText, url, ts, text, state: "drafting"|"ready"|"approved"|"skipped"|"empty"|"error", error }
  let activeTab = "review";
  let listTimer = null;

  function onFeedPage() {
    if (window.__xraIsJobTab) return false;
    const p = location.pathname;
    if (/\/status\/\d+/.test(p) || /\/compose\//.test(p) || /^\/(settings|messages|i\/(?!lists))/.test(p)) return false;
    const h = S().handle;
    const m = p.match(/^\/([A-Za-z0-9_]{1,15})(?:\/(with_replies|highlights|media|likes))?\/?$/);
    if (m && h && m[1].toLowerCase() === h.toLowerCase()) return false; // own profile → Learn button lives there
    return true;
  }

  function themeVars(el) {
    const bg = getComputedStyle(document.body).backgroundColor || "rgb(0,0,0)";
    const m = bg.match(/\d+/g) || [0, 0, 0];
    const dark = (+m[0] + +m[1] + +m[2]) / 3 < 128;
    el.style.setProperty("--xra-bg", bg);
    el.style.setProperty("--xra-card", dark ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.035)");
    el.style.setProperty("--xra-line", dark ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.12)");
    el.style.setProperty("--xra-muted", dark ? "rgba(255,255,255,.6)" : "rgba(0,0,0,.55)");
    el.style.setProperty("--xra-fg", dark ? "#e7e9ea" : "#0f1419");
  }

  function ensureFab() {
    if (!onFeedPage()) { if (fab) { fab.remove(); fab = null; } return; }
    if (fab && document.body.contains(fab)) return;
    fab = document.createElement("button");
    fab.type = "button";
    fab.className = "xra-learn xra-fab";
    fab.textContent = "🤖 Autopilot & Queue";
    fab.onclick = toggleDrawer;
    document.body.appendChild(fab);
    refreshFabCount();
  }
  async function refreshFabCount() {
    try {
      const r = await send({ type: "QUEUE_LIST" });
      const n = (r?.jobs || []).filter((j) => j.status === "scheduled" || j.status === "posting").length;
      const autoOn = r?.autopilotEnabled;
      const prefix = autoOn ? "🤖 Autopilot ON" : "📋 Queue replies";
      if (fab) fab.textContent = n ? `${prefix} · ${n} scheduled` : prefix;
      if (open && drawer) renderAutopilotBar(r);
    } catch (_) {}
  }

  function toggleDrawer() {
    if (!drawer) buildDrawer();
    open = !open;
    drawer.classList.toggle("open", open);
    if (open) { themeVars(drawer); refreshFabCount(); showTab(activeTab); }
    else clearInterval(listTimer);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildDrawer() {
    drawer = el("div", "xra-drawer");
    drawer.innerHTML = `
      <div class="xra-dhead">
        <div class="xra-dtitle">Reply queue</div>
        <div class="xra-dtabs">
          <button type="button" data-t="review" class="on">Review</button>
          <button type="button" data-t="scheduled">Scheduled</button>
          <button type="button" data-t="compose">Compose</button>
        </div>
        <button type="button" class="xra-dclose" title="Close">✕</button>
      </div>
      <div class="xra-dautopilot"></div>
      <div class="xra-dbody"></div>
      <div class="xra-dfoot"></div>`;
    drawer.querySelector(".xra-dclose").onclick = toggleDrawer;
    drawer.querySelectorAll(".xra-dtabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.t)));
    document.body.appendChild(drawer);
    drawer.addEventListener("keydown", onKey);
  }

  function renderAutopilotBar(queueData) {
    if (!drawer) return;
    const bar = drawer.querySelector(".xra-dautopilot");
    if (!bar) return;
    const s = S();
    const autoOn = queueData ? queueData.autopilotEnabled : !!s.autopilotEnabled;
    const daily = queueData?.dailyStats || s.dailyStats || { totalToday: 0, cap: s.autopilotDailyCap || 25 };
    const state = queueData?.autopilotState || s.autopilotState || {};

    bar.innerHTML = "";
    const row = el("div", "xra-ap-row");
    const toggleBtn = el("button", "xra-chip " + (autoOn ? "xra-ap-on" : ""), autoOn ? "🤖 Autopilot: ON" : "🤖 Autopilot: OFF");
    toggleBtn.title = "Toggle background Autopilot scanning & scheduling";
    toggleBtn.onclick = async () => {
      toggleBtn.disabled = true;
      await send({ type: "AUTOPILOT_TOGGLE", payload: { enabled: !autoOn } });
      await refreshFabCount();
    };

    const quota = el("span", "xra-ap-meta", `Today: ${daily.totalToday}/${daily.cap}`);
    const runNowBtn = el("button", "xra-chip", "⚡ Background scan");
    runNowBtn.title = "Open feed in background, scan, draft & schedule automatically";
    runNowBtn.onclick = async () => {
      runNowBtn.disabled = true;
      runNowBtn.textContent = "Scanning…";
      await send({ type: "AUTOPILOT_RUN_NOW" });
      setTimeout(() => refreshFabCount(), 1200);
    };
    row.append(toggleBtn, quota, runNowBtn);
    bar.appendChild(row);

    if (state.lastResult) {
      const sub = el("div", "xra-ap-sub", state.lastResult);
      bar.appendChild(sub);
    }
  }

  function showTab(t) {
    activeTab = t;
    drawer.querySelectorAll(".xra-dtabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
    clearInterval(listTimer);
    if (t === "review") renderReview();
    if (t === "scheduled") { renderScheduled(); listTimer = setInterval(renderScheduled, 5000); }
    if (t === "compose") renderCompose();
  }

  /* ---------------- Review tab ---------------- */
  function renderReview() {
    const body = drawer.querySelector(".xra-dbody");
    const foot = drawer.querySelector(".xra-dfoot");
    body.innerHTML = "";
    const top = el("div", "xra-dtop");
    const btnRow = el("div", "xra-drow");
    const autoScanBtn = el("button", "xra-btn", "⚡ Auto-Scan & Schedule");
    autoScanBtn.title = "Scroll this page, draft replies, auto-approve all, and schedule immediately";
    autoScanBtn.onclick = () => scanPage({ autoSchedule: true });
    const scan = el("button", "xra-btn xra-ghost", drafts.length ? "Scan for review" : "Scan this page");
    scan.onclick = () => scanPage({ autoSchedule: false });
    btnRow.append(autoScanBtn, scan);

    const info = el("div", "xra-dinfo", `Drafts one reply per post (up to ${S().queueBatch}). Auto-Scan & Schedule runs hands-free, or use Scan to review first.`);
    top.append(btnRow, info);
    body.appendChild(top);

    const list = el("div", "xra-dlist");
    body.appendChild(list);
    drafts.filter((d) => d.state !== "skipped").forEach((d) => list.appendChild(renderDraft(d)));
    if (!drafts.length) list.appendChild(el("div", "xra-dempty", "Press ⚡ Auto-Scan & Schedule for 1-click automation on this page, or let Background Autopilot run on its own."));

    foot.innerHTML = "";
    const approved = drafts.filter((d) => d.state === "approved");
    const sel = el("select", "xra-select");
    SPREADS.forEach(([v, l]) => { const o = el("option", "", `Spread over the ${l}`); o.value = v; sel.appendChild(o); });
    sel.value = String(S().queueSpread || 60);
    const go = el("button", "xra-btn", approved.length ? `Schedule ${approved.length} approved` : "Approve some replies first");
    go.disabled = !approved.length;
    go.onclick = async () => {
      go.disabled = true; go.textContent = "Scheduling…";
      const items = approved.map((d) => ({ kind: "reply", url: d.url, statusId: d.id, author: d.author, postText: d.postText, text: d.text }));
      try {
        await send({ type: "QUEUE_ADD", payload: { items, spreadMinutes: parseInt(sel.value, 10) } });
        drafts = drafts.filter((d) => d.state !== "approved");
        refreshFabCount();
        showTab("scheduled");
      } catch (e) { go.textContent = "Error: " + e.message; go.disabled = false; }
    };
    foot.append(sel, go);
  }

  function renderDraft(d) {
    const card = el("div", "xra-dcard xra-" + d.state);
    card.tabIndex = 0;
    card.dataset.id = d.id;
    const head = el("div", "xra-dchead");
    const who = el("a", "xra-dwho", d.author || "@" + d.handle);
    who.href = d.url; who.target = "_blank"; who.rel = "noopener";
    head.append(who, el("span", "xra-dage", ago(d.ts)));
    const post = el("div", "xra-dpost", d.postText.length > 220 ? d.postText.slice(0, 220) + "…" : d.postText);
    card.append(head, post);

    if (d.state === "drafting") card.appendChild(el("div", "xra-dstate", "Drafting…"));
    else if (d.state === "empty") card.appendChild(el("div", "xra-dstate", "Nothing worth saying here – skipped."));
    else if (d.state === "error") card.appendChild(el("div", "xra-dstate xra-err", "Error: " + d.error));
    else {
      const ta = el("textarea", "xra-dta");
      ta.value = d.text;
      ta.rows = 3;
      ta.oninput = () => { d.text = ta.value; len.textContent = ta.value.length; };
      card.appendChild(ta);
      const row = el("div", "xra-drow");
      const approve = el("button", "xra-btn xra-small", d.state === "approved" ? "✓ Approved" : "Approve");
      approve.onclick = () => { d.state = d.state === "approved" ? "ready" : "approved"; renderReview(); };
      const skip = el("button", "xra-btn xra-small xra-ghost", "Skip");
      skip.onclick = () => { d.state = "skipped"; renderReview(); };
      const redo = el("button", "xra-btn xra-small xra-ghost", "↻");
      redo.title = "Regenerate";
      redo.onclick = () => draftOne(d, true);
      const len = el("span", "xra-len", String(d.text.length));
      row.append(approve, skip, redo, len);
      card.appendChild(row);
    }
    return card;
  }

  function onKey(e) {
    if (activeTab !== "review") return;
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
    const card = e.target.closest?.(".xra-dcard");
    if (!card) return;
    const d = drafts.find((x) => x.id === card.dataset.id);
    if (!d || d.state === "drafting") return;
    const k = e.key.toLowerCase();
    const next = card.nextElementSibling;
    if (k === "a") { d.state = "approved"; renderReview(); focusCard(next?.dataset.id); e.preventDefault(); }
    if (k === "s") { d.state = "skipped"; renderReview(); focusCard(next?.dataset.id); e.preventDefault(); }
    if (k === "r") { draftOne(d, true); e.preventDefault(); }
  }
  function focusCard(id) {
    const c = id && drawer.querySelector(`.xra-dcard[data-id="${id}"]`);
    (c || drawer.querySelector(".xra-dcard"))?.focus();
  }

  function ago(ts) {
    if (!ts) return "";
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 60) return m + "m";
    const h = Math.round(m / 60);
    return h < 48 ? h + "h" : Math.round(h / 24) + "d";
  }

  async function scanPage({ autoSchedule = false } = {}) {
    const s = S();
    const seen = new Set(drafts.map((d) => d.id));
    const found = [];

    if (autoSchedule) {
      const info = drawer.querySelector(".xra-dinfo");
      const scrolls = Math.max(1, Math.min(6, s.autopilotScrolls || 3));
      for (let sc = 0; sc < scrolls; sc++) {
        if (info) info.textContent = `Auto-scrolling feed (${sc + 1}/${scrolls})…`;
        found.push(...collectFeedCandidates(seen));
        if (sc < scrolls - 1) {
          window.scrollBy({ top: window.innerHeight * 1.35, behavior: "instant" });
          await sleep(1200);
        }
      }
    } else {
      found.push(...collectFeedCandidates(seen));
    }

    let fresh = found;
    try {
      const r = await send({ type: "FILTER_NEW", payload: { ids: found.map((f) => f.id) } });
      if (r?.ok) { const ok = new Set(r.ids); fresh = found.filter((f) => ok.has(f.id)); }
    } catch (_) {}
    const room = Math.max(0, (s.queueBatch || 10) - drafts.filter((d) => d.state !== "skipped").length);
    const batch = fresh.slice(0, room).map((f) => ({ ...f, text: "", state: "drafting" }));
    drafts = [...drafts, ...batch];
    renderReview();
    if (!batch.length) {
      const info = drawer.querySelector(".xra-dinfo");
      if (info) info.textContent = room ? "No new posts on screen – scroll down a bit and scan again." : `Batch is full (${s.queueBatch}). Approve or skip some first.`;
      return;
    }
    // draft with concurrency 2
    let i = 0;
    const autoApprove = autoSchedule || !!s.autopilotAutoApprove;
    const worker = async () => { while (i < batch.length) { const d = batch[i++]; await draftOne(d, false, autoApprove); } };
    await Promise.all([worker(), worker()]);

    if (autoSchedule) {
      const readyToSchedule = drafts.filter((d) => d.state === "approved" && d.text);
      if (readyToSchedule.length > 0) {
        const items = readyToSchedule.map((d) => ({
          kind: "reply",
          url: d.url,
          statusId: d.id,
          author: d.author,
          postText: d.postText,
          text: d.text
        }));
        await send({ type: "QUEUE_ADD", payload: { items, spreadMinutes: s.queueSpread || 60, auto: true } });
        drafts = drafts.filter((d) => d.state !== "approved");
        refreshFabCount();
        showTab("scheduled");
      }
    }
  }

  async function draftOne(d, isRedo, autoApprove = false) {
    d.state = "drafting"; d.error = "";
    renderReview();
    try {
      const r = await send({
        type: "GENERATE",
        payload: { post: { author: `${d.author} (${d.name || ""})`, text: d.postText }, thread: [], draft: "", count: 1, tweak: isRedo ? "Take a different angle from the obvious one." : "" }
      });
      if (!r?.ok) throw new Error(r?.error || "unknown error");
      const text = (r.suggestions[0] || "").trim();
      if (!text) { d.state = "empty"; }
      else { d.text = text; d.state = autoApprove ? "approved" : "ready"; }
    } catch (e) { d.state = "error"; d.error = e.message; }
    renderReview();
  }

  /* ---------------- Scheduled tab ---------------- */
  async function renderScheduled() {
    if (!drawer || activeTab !== "scheduled") return;
    const body = drawer.querySelector(".xra-dbody");
    const foot = drawer.querySelector(".xra-dfoot");
    let r;
    try { r = await send({ type: "QUEUE_LIST" }); } catch (e) { body.textContent = e.message; return; }
    renderAutopilotBar(r);
    const jobs = r.jobs || [];
    const scroll = body.scrollTop;
    body.innerHTML = "";
    const list = el("div", "xra-dlist");
    body.appendChild(list);
    if (!jobs.length) list.appendChild(el("div", "xra-dempty", "Nothing scheduled yet. Background Autopilot will populate this automatically, or use Review / Compose."));
    const order = { posting: 0, scheduled: 1, failed: 2, done: 3, cancelled: 4 };
    jobs.sort((a, b) => (order[a.status] - order[b.status]) || (a.dueAt - b.dueAt)).forEach((j) => {
      const card = el("div", "xra-dcard xra-job xra-s-" + j.status);
      const head = el("div", "xra-dchead");
      const who = el("a", "xra-dwho", (j.auto ? "🤖 " : "") + (j.kind === "post" ? "Your post" : j.author));
      who.href = j.url; who.target = "_blank"; who.rel = "noopener";
      const when = el("span", "xra-dage", statusLabel(j, r.now));
      head.append(who, when);
      card.appendChild(head);
      if (j.kind === "reply" && j.postText) card.appendChild(el("div", "xra-dpost", j.postText.length > 140 ? j.postText.slice(0, 140) + "…" : j.postText));
      card.appendChild(el("div", "xra-dtext", j.text));
      if (j.error) card.appendChild(el("div", "xra-dstate xra-err", j.error));
      const row = el("div", "xra-drow");
      if (j.status === "scheduled" || j.status === "failed") {
        const now = el("button", "xra-btn xra-small", j.status === "failed" ? "Retry now" : "Post now");
        now.onclick = async () => { await send({ type: "QUEUE_POST_NOW", payload: { id: j.id } }); renderScheduled(); refreshFabCount(); };
        const cancel = el("button", "xra-btn xra-small xra-ghost", "Cancel");
        cancel.onclick = async () => { await send({ type: "QUEUE_CANCEL", payload: { id: j.id } }); renderScheduled(); refreshFabCount(); };
        row.append(now, cancel);
      }
      card.appendChild(row);
      list.appendChild(card);
    });
    body.scrollTop = scroll;
    foot.innerHTML = "";
    const n = jobs.filter((j) => j.status === "scheduled").length;
    foot.appendChild(el("div", "xra-dinfo", n ? `${n} scheduled. Keep this browser open – each one opens briefly in a background tab, posts, and closes.` : "Keep the browser open for scheduled & Autopilot replies."));
    const clear = el("button", "xra-btn xra-small xra-ghost", "Clear finished");
    clear.onclick = async () => { await send({ type: "QUEUE_CLEAR_DONE" }); renderScheduled(); };
    foot.appendChild(clear);
  }
  function statusLabel(j, now) {
    if (j.status === "scheduled") {
      const d = Math.max(0, j.dueAt - now);
      const m = Math.round(d / 60000);
      if (m < 1) return "any moment";
      if (m < 90) return `in ${m} min`;
      const dt = new Date(j.dueAt);
      return "at " + dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + (dt.toDateString() !== new Date().toDateString() ? " " + dt.toLocaleDateString([], { weekday: "short" }) : "");
    }
    if (j.status === "posting") return "posting now…";
    if (j.status === "done") return "posted ✓";
    if (j.status === "failed") return "failed";
    return j.status;
  }

  /* ---------------- Compose tab ---------------- */
  function renderCompose() {
    const body = drawer.querySelector(".xra-dbody");
    const foot = drawer.querySelector(".xra-dfoot");
    body.innerHTML = ""; foot.innerHTML = "";
    const wrap = el("div", "xra-dtop");
    wrap.appendChild(el("div", "xra-dinfo", "Write a post of your own and let it go out at a natural-looking time."));
    const ta = el("textarea", "xra-dta"); ta.rows = 6; ta.placeholder = "What's happening?";
    const len = el("div", "xra-len", "0");
    ta.oninput = () => { len.textContent = ta.value.length; len.classList.toggle("xra-over", ta.value.length > 280); };
    const whenSel = el("select", "xra-select");
    [["r60", "Random time in the next hour"], ["r240", "Random time in the next 4 hours"], ["today", "Random time later today (until 9pm)"], ["tomorrow", "Random time tomorrow (9am–9pm)"], ["pick", "Pick a date and time…"]]
      .forEach(([v, l]) => { const o = el("option", "", l); o.value = v; whenSel.appendChild(o); });
    const dt = el("input", "xra-select"); dt.type = "datetime-local"; dt.hidden = true;
    whenSel.onchange = () => (dt.hidden = whenSel.value !== "pick");
    const btn = el("button", "xra-btn", "Schedule post");
    btn.onclick = async () => {
      const text = ta.value.trim();
      if (!text) return;
      let dueAt;
      const now = new Date();
      const rnd = (a, b) => a + Math.random() * (b - a);
      if (whenSel.value === "r60") dueAt = Date.now() + rnd(60_000, 3_600_000);
      else if (whenSel.value === "r240") dueAt = Date.now() + rnd(60_000, 4 * 3_600_000);
      else if (whenSel.value === "today") { const end = new Date(now); end.setHours(21, 0, 0, 0); dueAt = end > now ? rnd(Date.now() + 60_000, end.getTime()) : Date.now() + rnd(60_000, 1_800_000); }
      else if (whenSel.value === "tomorrow") { const a = new Date(now); a.setDate(a.getDate() + 1); a.setHours(9, 0, 0, 0); const b = new Date(a); b.setHours(21); dueAt = rnd(a.getTime(), b.getTime()); }
      else { dueAt = Date.parse(dt.value); if (isNaN(dueAt) || dueAt < Date.now()) { btn.textContent = "Pick a time in the future"; return; } }
      btn.disabled = true;
      try {
        await send({ type: "QUEUE_ADD", payload: { items: [{ kind: "post", url: "https://x.com/compose/post", text, dueAt }] } });
        ta.value = ""; len.textContent = "0"; refreshFabCount(); showTab("scheduled");
      } catch (e) { btn.textContent = "Error: " + e.message; }
      btn.disabled = false;
    };
    wrap.append(ta, len, whenSel, dt);
    body.appendChild(wrap);
    foot.appendChild(btn);
  }

  /* ---------------- wiring ---------------- */
  let t = null;
  const sched = () => { clearTimeout(t); t = setTimeout(() => { if (X.alive()) ensureFab(); }, 400); };
  new MutationObserver(sched).observe(document.documentElement, { childList: true, subtree: true });
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; sched(); if (open && !onFeedPage()) toggleDrawer(); } }, 500);
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.jobs || ch.autopilotEnabled || ch.autopilotState) refreshFabCount();
  });
  sched();
})();

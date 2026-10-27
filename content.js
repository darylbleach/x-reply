// X Reply Coach – content script for x.com / twitter.com
(() => {
  if (window.__xrcLoaded) return;
  window.__xrcLoaded = true;

  const SEL = {
    article: 'article[data-testid="tweet"]',
    tweetText: '[data-testid="tweetText"]',
    userName: '[data-testid="User-Name"]',
    editor: '[data-testid="tweetTextarea_0"]',
    toolbar: '[data-testid="toolBar"]',
    socialContext: '[data-testid="socialContext"]',
    replyBtn: '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]'
  };

  const TWEAKS = [
    { id: "shorter", label: "Shorter", text: "Make every option noticeably shorter – half the length, one line if possible." },
    { id: "funnier", label: "Funnier", text: "Lean into humour more, still in the user's register. Dry beats silly." },
    { id: "direct", label: "More direct", text: "Be blunter and more direct. Drop softeners and hedging." },
    { id: "warmer", label: "Warmer", text: "Be warmer and more supportive, without gushing or praise filler." },
    { id: "question", label: "Ask a question", text: "Every option should end with one specific question that invites a reply." },
    { id: "story", label: "Personal angle", text: "Every option should bring in a first-person experience the user's samples make plausible." }
  ];

  let settings = { handle: "", count: 3, hasKey: false, provider: "claude", oneClick: false, sampleCount: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // After the extension is reloaded/updated, this (old) copy of the script is
  // orphaned: chrome.runtime calls throw "Extension context invalidated".
  let dead = false;
  const alive = () => { try { return !dead && !!chrome.runtime?.id; } catch (_) { return false; } };
  function goDead() {
    if (dead) return;
    dead = true;
    try { observer.disconnect(); } catch (_) {}
    document.querySelectorAll(".xrc-panel .xrc-status").forEach((el) => { el.textContent = "X Reply Coach was updated – refresh this page."; el.className = "xrc-status warn"; });
    document.querySelectorAll(".xrc-panel .xrc-btn, .xrc-panel .xrc-chip").forEach((b) => (b.disabled = true));
    if (learnBtn) { learnBtn.textContent = "Extension updated – refresh the page"; learnBtn.classList.add("xrc-muted"); learnBtn.onclick = () => location.reload(); }
  }
  async function send(msg) {
    if (!alive()) { goDead(); throw new Error("X Reply Coach was updated – refresh this page."); }
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (/context invalidated|Extension context/i.test(String(e?.message))) { goDead(); throw new Error("X Reply Coach was updated – refresh this page."); }
      throw e;
    }
  }
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  async function refreshSettings() {
    try {
      const res = await send({ type: "GET_SETTINGS" });
      if (res?.ok) settings = res.settings;
    } catch (_) {}
    if (!dead) schedule();
  }
  refreshSettings();
  chrome.storage.onChanged.addListener(refreshSettings);

  /* ---------------- DOM reading ---------------- */
  function articleText(article) {
    const el = article.querySelector(SEL.tweetText);
    if (!el) return "";
    let out = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
      else if (n.nodeName === "IMG") out += n.getAttribute("alt") || "";
      else out += n.textContent;
    });
    return norm(out);
  }
  function articleAuthor(article) {
    const un = article.querySelector(SEL.userName);
    if (!un) return { name: "", handle: "" };
    const spans = Array.from(un.querySelectorAll("span"));
    const handleSpan = spans.find((s) => /^@\w+$/.test(norm(s.textContent)));
    return { handle: handleSpan ? norm(handleSpan.textContent).slice(1) : "", name: norm(spans[0]?.textContent || "") };
  }
  function articleStatusId(article) {
    const links = article.querySelectorAll('a[href*="/status/"]');
    for (const a of links) {
      const m = a.getAttribute("href").match(/\/status\/(\d+)/);
      if (m && a.querySelector("time")) return m[1];
    }
    const m = links[0]?.getAttribute("href")?.match(/\/status\/(\d+)/);
    return m ? m[1] : "";
  }
  const isRepost = (a) => { const sc = a.querySelector(SEL.socialContext); return !!sc && /repost|retweet/i.test(sc.textContent); };
  const isPinned = (a) => { const sc = a.querySelector(SEL.socialContext); return !!sc && /pinned/i.test(sc.textContent); };
  const currentStatusId = () => (location.pathname.match(/\/status\/(\d+)/) || [])[1] || "";
  function pageHandle() {
    const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/(with_replies|highlights|media|likes))?\/?$/);
    if (!m) return "";
    const reserved = ["home", "explore", "notifications", "messages", "search", "settings", "i", "compose", "login", "signup", "jobs", "communities"];
    return reserved.includes(m[1].toLowerCase()) ? "" : m[1];
  }

  function findTargetPost(editor) {
    const dialog = editor.closest('[role="dialog"]');
    let article = null, thread = [], id = "";
    if (dialog) {
      article = dialog.querySelector(SEL.article);
      id = article ? articleStatusId(article) : "";
    } else {
      id = currentStatusId();
      const articles = Array.from(document.querySelectorAll(SEL.article));
      article = articles.find((a) => articleStatusId(a) === id) || articles[0];
      if (article) {
        const idx = articles.indexOf(article);
        thread = articles.slice(Math.max(0, idx - 6), idx)
          .map((a) => ({ author: "@" + (articleAuthor(a).handle || "unknown"), text: articleText(a) }))
          .filter((t) => t.text);
      }
    }
    if (!article) return null;
    const au = articleAuthor(article);
    return { id, post: { author: au.handle ? `@${au.handle} (${au.name})` : au.name, text: articleText(article) }, thread };
  }

  /* ---------------- Editor insert ---------------- */
  const editorText = (editor) => norm(editor.textContent);
  function clearEditor(editor) {
    try {
      editor.focus();
      if (!editorText(editor)) return;
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch (_) {}
  }
  function pasteInto(editor, text) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }
  // X's composer is Draft.js: a synthetic paste is handled exactly once,
  // execCommand("insertText") can be applied twice. Paste first, verify, fall back.
  async function insertIntoEditor(editor, text) {
    clearEditor(editor);
    editor.focus();
    try { pasteInto(editor, text); } catch (_) {}
    await sleep(150);
    const want = norm(text);
    let now = editorText(editor);
    if (now === want) return true;
    if (now.includes(want)) {
      clearEditor(editor); await sleep(50);
      try { pasteInto(editor, text); } catch (_) {}
      await sleep(150);
      if (editorText(editor) === want) return true;
    }
    if (!editorText(editor)) {
      try { editor.focus(); document.execCommand("insertText", false, text); } catch (_) {}
      await sleep(100);
    }
    return editorText(editor).includes(want);
  }

  function findReplyButton(editor) {
    let host = editor;
    for (let i = 0; i < 14 && host; i++) {
      const b = host.querySelector && host.querySelector(SEL.replyBtn);
      if (b) return b;
      host = host.parentElement;
    }
    const scope = editor.closest('[role="dialog"]') || document;
    return scope.querySelector(SEL.replyBtn);
  }
  async function postNow(editor) {
    for (let i = 0; i < 20; i++) {
      const btn = findReplyButton(editor);
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") { btn.click(); return true; }
      await sleep(100);
    }
    return false;
  }

  /* ---------------- Suggestion panel ---------------- */
  const cache = new Map(); // key -> suggestions (per page load)

  function buildPanel(editor) {
    const panel = document.createElement("div");
    panel.className = "xrc-panel";
    panel.innerHTML = `
      <div class="xrc-bar">
        <button type="button" class="xrc-btn xrc-primary">✨ Suggest replies</button>
        <span class="xrc-status"></span>
        <button type="button" class="xrc-btn xrc-ghost xrc-icon xrc-settings" title="X Reply Coach settings">⚙</button>
      </div>
      <div class="xrc-list"></div>
      <div class="xrc-tweaks" hidden>
        <span class="xrc-tweak-label">Adjust:</span>
        ${TWEAKS.map((t) => `<button type="button" class="xrc-chip" data-tweak="${t.id}">${t.label}</button>`).join("")}
        <button type="button" class="xrc-chip xrc-chip-ghost" data-tweak="">↻ Again</button>
      </div>`;
    const btn = panel.querySelector(".xrc-primary");
    const status = panel.querySelector(".xrc-status");
    const list = panel.querySelector(".xrc-list");
    const tweaks = panel.querySelector(".xrc-tweaks");
    panel.querySelector(".xrc-settings").addEventListener("click", () => send({ type: "OPEN_OPTIONS" }).catch(() => {}));

    const setStatus = (t, cls) => { status.textContent = t; status.className = "xrc-status" + (cls ? " " + cls : ""); };

    function renderList(suggestions) {
      list.innerHTML = "";
      suggestions.forEach((text) => {
        const item = document.createElement("div");
        item.className = "xrc-item";
        const p = document.createElement("div");
        p.className = "xrc-text";
        p.textContent = text;
        const actions = document.createElement("div");
        actions.className = "xrc-actions";

        const primary = document.createElement("button");
        primary.type = "button";
        primary.className = "xrc-btn xrc-small";
        primary.textContent = settings.oneClick ? "Use & post" : "Use";
        primary.addEventListener("click", async () => {
          primary.disabled = true;
          const ok = await insertIntoEditor(editor, text);
          if (!ok) {
            await navigator.clipboard.writeText(text);
            setStatus("Couldn't insert – copied to clipboard instead.", "warn");
            primary.disabled = false;
            return;
          }
          if (settings.oneClick) {
            setStatus("Posting…");
            const posted = await postNow(editor);
            if (posted) {
              setStatus("Posted ✓", "ok");
              item.classList.add("xrc-used");
              list.querySelectorAll(".xrc-btn").forEach((b) => (b.disabled = true));
            } else {
              setStatus("Inserted – couldn't find the Reply button, press it yourself.", "warn");
              primary.disabled = false;
            }
          } else {
            setStatus("Inserted – edit if you like, then press Reply.", "ok");
            item.classList.add("xrc-used");
            primary.disabled = false;
          }
        });
        actions.appendChild(primary);

        if (settings.oneClick) {
          const edit = document.createElement("button");
          edit.type = "button";
          edit.className = "xrc-btn xrc-small xrc-ghost";
          edit.textContent = "Edit";
          edit.title = "Insert without posting";
          edit.addEventListener("click", async () => {
            if (await insertIntoEditor(editor, text)) setStatus("Inserted – edit, then press Reply.", "ok");
          });
          actions.appendChild(edit);
        }

        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "xrc-btn xrc-small xrc-ghost";
        copy.textContent = "Copy";
        copy.addEventListener("click", async () => {
          await navigator.clipboard.writeText(text);
          copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1500);
        });
        actions.appendChild(copy);

        const len = document.createElement("span");
        len.className = "xrc-len" + (text.length > 280 ? " xrc-over" : "");
        len.textContent = `${text.length}`;
        actions.appendChild(len);

        item.append(p, actions);
        list.appendChild(item);
      });
      tweaks.hidden = !suggestions.length;
    }

    async function run(tweakId) {
      const target = findTargetPost(editor);
      if (!target || !target.post.text) { setStatus("Couldn't read the post.", "warn"); return; }
      const tweak = TWEAKS.find((t) => t.id === tweakId)?.text || "";
      const cacheKey = target.id + "|" + (tweakId || "") + "|" + editorText(editor);
      if (!tweakId && cache.has(cacheKey)) { renderList(cache.get(cacheKey)); setStatus(""); return; }

      btn.disabled = true;
      tweaks.querySelectorAll("button").forEach((b) => (b.disabled = true));
      setStatus(tweakId ? "Adjusting…" : "Thinking…", "busy");
      list.classList.add("xrc-loading");
      try {
        const res = await send({ type: "GENERATE", payload: { ...target, draft: editorText(editor), tweak } });
        if (!res?.ok) throw new Error(res?.error || "Unknown error");
        cache.set(cacheKey, res.suggestions);
        renderList(res.suggestions);
        setStatus(settings.sampleCount ? "" : "Tip: no voice learned yet – open your profile and press Learn my voice.", "warn");
      } catch (e) {
        setStatus("Error: " + e.message, "warn");
      } finally {
        btn.disabled = false;
        tweaks.querySelectorAll("button").forEach((b) => (b.disabled = false));
        list.classList.remove("xrc-loading");
      }
    }
    btn.addEventListener("click", () => run(""));
    tweaks.querySelectorAll("[data-tweak]").forEach((b) => b.addEventListener("click", () => run(b.dataset.tweak)));
    return panel;
  }

  function injectPanels() {
    document.querySelectorAll(SEL.editor).forEach((editor) => {
      let host = editor;
      for (let i = 0; i < 12 && host; i++) {
        if (host.querySelector && host.querySelector(SEL.toolbar)) break;
        host = host.parentElement;
      }
      if (!host || !host.querySelector || host.dataset.xrc) return;
      host.dataset.xrc = "1";
      host.appendChild(buildPanel(editor));
    });
  }

  /* ---------------- Voice learner ---------------- */
  let learnBtn = null;
  let learning = false;

  function ensureLearnButton() {
    const ph = pageHandle();
    if (learning) return;
    if (!ph) { if (learnBtn) { learnBtn.remove(); learnBtn = null; } return; }
    const mine = settings.handle && ph.toLowerCase() === settings.handle.toLowerCase();
    if (settings.handle && !mine) { if (learnBtn) { learnBtn.remove(); learnBtn = null; } return; }
    if (!learnBtn || !document.body.contains(learnBtn)) {
      learnBtn = document.createElement("button");
      learnBtn.type = "button";
      learnBtn.className = "xrc-learn";
      document.body.appendChild(learnBtn);
    }
    learnBtn.onclick = null;
    if (mine) {
      learnBtn.textContent = settings.sampleCount ? `🎙 Learn my voice (${settings.sampleCount} learned)` : "🎙 Learn my voice";
      learnBtn.classList.remove("xrc-muted");
      learnBtn.onclick = learnVoice;
    } else {
      learnBtn.textContent = `Use @${ph} as my handle`;
      learnBtn.classList.add("xrc-muted");
      learnBtn.onclick = async () => { try { await chrome.storage.local.set({ handle: ph }); } catch (_) { goDead(); } };
    }
  }

  function cutoffTs() {
    const lb = settings.lookback || "all";
    if (lb === "all") return 0;
    if (lb === "date") { const t = Date.parse(settings.lookbackDate || ""); return isNaN(t) ? 0 : t; }
    const months = parseInt(lb, 10);
    if (!months) return 0;
    const d = new Date(); d.setMonth(d.getMonth() - months);
    return d.getTime();
  }

  function collectOwnSamples(seen) {
    const out = [];
    const cutoff = cutoffTs();
    const onReplies = /\/with_replies/.test(location.pathname);
    let mineOnScreen = 0, mineTooOld = 0;
    document.querySelectorAll(SEL.article).forEach((a) => {
      if (isRepost(a)) return;
      const au = articleAuthor(a);
      if (!au.handle || au.handle.toLowerCase() !== settings.handle.toLowerCase()) return;
      const t = a.querySelector("time")?.getAttribute("datetime");
      const ts = t ? Date.parse(t) : Date.now();
      if (!isPinned(a)) {
        mineOnScreen++;
        if (cutoff && ts < cutoff) { mineTooOld++; return; }
      } else if (cutoff && ts < cutoff) return;
      const text = articleText(a);
      if (!text || text.length < 8 || seen.has(text)) return;
      seen.add(text);
      const replying = /replying to/i.test(a.textContent);
      out.push({ text, kind: replying || onReplies ? "reply" : "post", ts });
    });
    return { samples: out, reachedCutoff: cutoff > 0 && mineOnScreen > 0 && mineTooOld === mineOnScreen };
  }

  async function switchToTab(suffix) {
    const h = settings.handle.toLowerCase();
    const link = Array.from(document.querySelectorAll('a[role="tab"], a[href*="' + suffix + '"]'))
      .find((a) => (a.getAttribute("href") || "").toLowerCase() === `/${h}${suffix}`);
    if (!link) return false;
    link.click();
    for (let i = 0; i < 20; i++) { await sleep(300); if (location.pathname.toLowerCase().endsWith(suffix)) break; }
    await sleep(1500);
    window.scrollTo({ top: 0 });
    return true;
  }

  async function scrapePhase(label, seen, maxScrolls) {
    let total = 0, stale = 0;
    for (let i = 0; i < maxScrolls && stale < 5 && learning && alive(); i++) {
      const { samples: batch, reachedCutoff } = collectOwnSamples(seen);
      if (batch.length) {
        const res = await send({ type: "SAVE_SAMPLES", payload: { samples: batch } });
        total += batch.length;
        learnBtn.textContent = `${label}: ${total} new (${res?.total ?? "?"} total) – click to stop`;
        stale = 0;
      } else stale++;
      if (reachedCutoff) { learnBtn.textContent = `${label}: reached your cut-off (${total} new)`; await sleep(800); break; }
      window.scrollBy({ top: window.innerHeight * 1.5, behavior: "instant" });
      await sleep(1300);
    }
    return total;
  }

  async function learnVoice() {
    if (learning) { learning = false; return; }
    learning = true;
    learnBtn.textContent = "Collecting… (click to stop)";
    const seen = new Set();
    let posts = 0, replies = 0;
    try {
      if (/\/with_replies/i.test(location.pathname)) {
        replies = await scrapePhase("Replies", seen, 60);
      } else {
        posts = await scrapePhase("Posts", seen, 40);
        if (learning) {
          learnBtn.textContent = "Switching to Replies…";
          if (await switchToTab("/with_replies")) replies = await scrapePhase("Replies", seen, 60);
        }
      }
    } finally {
      learning = false;
      learnBtn.textContent = `✅ Learned ${posts} posts + ${replies} replies. Click to learn more`;
      window.scrollTo({ top: 0 });
      setTimeout(() => { if (learnBtn && !learning) ensureLearnButton(); }, 6000);
    }
  }

  /* ---------------- SPA observation ---------------- */
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { injectPanels(); ensureLearnButton(); }, 250);
  }
  const observer = new MutationObserver(() => { if (alive()) schedule(); else goDead(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  let lastPath = location.pathname;
  setInterval(() => { if (!alive()) return goDead(); if (location.pathname !== lastPath) { lastPath = location.pathname; schedule(); } }, 500);
  schedule();
})();

/* X Reply Coach – settings page */
const DEFAULT_MODELS = { claude: "claude-sonnet-5-5", openai: "gpt-6-luna", gemini: "gemini-3.8-flash", grok: "grok-4.7" };
const FALLBACK_MODELS = {
  claude: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  openai: ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
  gemini: ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  grok: ["grok-4.7", "grok-4.7-latest", "grok-4.20"]
};
const OLD_MODEL = /^(claude-(opus|sonnet)-4|claude-3|gpt-[45]|o[34]|gemini-2\.0|grok-[34]($|-))/;
const PROVIDERS = ["claude", "openai", "gemini", "grok"];
const COMMON_CHIPS = [
  "British spelling and phrasing", "Short – one or two sentences", "No hashtags", "No emoji", "Never start with 'Great post' or 'Love this'",
  "Don't open with the other person's name", "Ask one question at most", "Sound like a mate, not a brand", "No exclamation marks",
  "Lowercase, relaxed punctuation", "Never use 'folks', 'game-changer' or 'delve'", "Be specific – no generic encouragement",
  "Only mention my products if directly relevant", "Dry humour is fine, no puns", "Skip the final full stop"
];

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
let dirty = false;
let samplesCache = [];

/* ---------- small UI helpers ---------- */
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), 2600);
}
function markDirty() {
  dirty = true;
  $("#status").textContent = "Unsaved changes";
  $("#status").className = "dirty";
}
function markClean() {
  dirty = false;
  $("#status").textContent = "All changes saved";
  $("#status").className = "";
}
function showTab(name) {
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((s) => s.classList.toggle("active", s.dataset.tab === name));
  try { localStorage.setItem("xrc-tab", name); } catch (_) {}
}
function selectedProvider() {
  return $$('input[name=provider]').find((r) => r.checked)?.value || "claude";
}

/* ---------- provider cards / models ---------- */
function refreshProviderUI() {
  const chosen = selectedProvider();
  $$(".pcard").forEach((c) => c.classList.toggle("active", c.dataset.p === chosen));
  for (const p of PROVIDERS) {
    const has = !!$(`input[data-key="${p}"]`).value.trim();
    const st = $(`.pstate[data-state="${p}"]`);
    st.textContent = has ? "key added" : "no key";
    st.className = "pstate " + (has ? "ok" : "missing");
  }
  updateReadiness();
}
function fillSelect(provider, models, selected) {
  const sel = $(`select[data-model="${provider}"]`);
  const want = selected || sel.value || DEFAULT_MODELS[provider];
  const list = models.map((m) => (typeof m === "string" ? { id: m, label: m } : m));
  if (want && !list.some((m) => m.id === want)) list.unshift({ id: want, label: want + " (saved)" });
  sel.innerHTML = "";
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m.id; o.textContent = m.label; sel.appendChild(o);
  }
  sel.value = want;
}
function setHint(provider, text, isErr) {
  const h = $(`.modelhint[data-hint="${provider}"]`);
  h.textContent = text; h.className = "modelhint" + (isErr ? " err" : "");
}
async function refreshModels(provider, { quiet } = {}) {
  const key = $(`input[data-key="${provider}"]`).value.trim();
  const sel = $(`select[data-model="${provider}"]`);
  const btn = $(`button[data-refresh="${provider}"]`);
  if (!key) { if (!quiet) setHint(provider, "Enter an API key to load the live model list."); return; }
  btn.disabled = true; setHint(provider, "Loading models…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "LIST_MODELS", payload: { provider, key } });
    if (!res?.ok) throw new Error(res?.error || "unknown error");
    const cached = await chrome.storage.local.get("modelCache");
    const modelCache = { ...(cached.modelCache || {}), [provider]: { models: res.models, at: Date.now() } };
    await chrome.storage.local.set({ modelCache });
    fillSelect(provider, res.models, sel.value);
    setHint(provider, `${res.models.length} models loaded from provider.`);
  } catch (e) {
    let msg = "Couldn't load models: " + e.message;
    if (provider === "gemini" && /blocked/i.test(e.message)) msg = "Your Google key blocks listing models (API restrictions on the key). Generation still works – pick from the built-in list, or allow 'Generative Language API' on the key and press ↻.";
    setHint(provider, msg, true);
  } finally { btn.disabled = false; }
}

/* ---------- readiness ---------- */
function updateReadiness() {
  const p = selectedProvider();
  const hasKey = !!$(`input[data-key="${p}"]`).value.trim();
  const hasHandle = !!$("#handle").value.trim();
  const n = samplesCache.length;
  $("#badge-provider").textContent = hasKey ? "ready" : "needs key";
  $("#badge-provider").className = "nav-badge " + (hasKey ? "ok" : "todo");
  $("#badge-voice").textContent = n ? `${n}` : hasHandle ? "learn" : "set up";
  $("#badge-voice").className = "nav-badge " + (n ? "ok" : "todo");
  const r = $("#readiness");
  if (hasKey && hasHandle && n) { r.textContent = "✓ Ready – open a post on X and press Suggest replies."; r.className = "readiness ready"; }
  else if (!hasKey) { r.textContent = "Step 1: add an API key for your chosen provider."; r.className = "readiness"; }
  else if (!hasHandle) { r.textContent = "Step 2: enter your X handle under Your voice."; r.className = "readiness"; }
  else { r.textContent = "Step 3: open your X profile and press Learn my voice."; r.className = "readiness"; }
}

/* ---------- samples + stats ---------- */
function renderSamples(samples) {
  samplesCache = samples || [];
  const replies = samplesCache.filter((s) => s.kind === "reply").length;
  $("#st-total").textContent = samplesCache.length;
  $("#st-replies").textContent = replies;
  $("#st-posts").textContent = samplesCache.length - replies;
  const ts = samplesCache.map((s) => s.ts).filter(Boolean);
  if (ts.length) {
    const f = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
    $("#st-range").textContent = `${f(Math.min(...ts))} – ${f(Math.max(...ts))}`;
  } else $("#st-range").textContent = "–";
  const prev = $("#samplePreview");
  prev.innerHTML = "";
  if (!samplesCache.length) prev.textContent = "Nothing learned yet.";
  samplesCache.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 200).forEach((s) => {
    const d = document.createElement("div"); d.className = "smp";
    const k = document.createElement("span"); k.className = "k"; k.textContent = s.kind;
    d.append(k, document.createTextNode(s.text));
    prev.appendChild(d);
  });
  renderLocalChips();
  updateReadiness();
}

/* ---------- local voice analysis → chips ---------- */
const STOP = new Set("the a an and or but if so to of in on at for with from by as is are was were be been being it its this that these those i you he she we they me him her us them my your his our their not no yes do does did done have has had will would can could should just like get got go going really very also about into out up down over than then there here what which who when where why how all any some more most much many one two it's i'm i've don't that's you're we're they're can't isn't im ive dont".split(" "));
function analyseLocal(samples) {
  const n = samples.length;
  if (n < 8) return [];
  const texts = samples.map((s) => s.text);
  const pct = (f) => texts.filter(f).length / n;
  const words = texts.map((t) => t.split(/\s+/).filter(Boolean).length);
  const avgWords = words.reduce((a, b) => a + b, 0) / n;
  const median = words.slice().sort((a, b) => a - b)[Math.floor(n / 2)];
  const out = [];
  const add = (rule, why) => out.push({ rule, why });

  if (median <= 12) add("Keep it short – one punchy line", `median ${median} words`);
  else if (median <= 25) add("One or two sentences, no essays", `median ${median} words`);
  else add("Happy to write a fuller reply when it earns it", `median ${median} words`);

  const emojiRe = /\p{Extended_Pictographic}/u;
  const emojiRate = pct((t) => emojiRe.test(t));
  if (emojiRate < 0.05) add("No emoji", `${Math.round(emojiRate * 100)}% of samples use one`);
  else if (emojiRate < 0.3) add("Occasional emoji, never more than one", `${Math.round(emojiRate * 100)}% use one`);
  else add("Emoji are part of the voice", `${Math.round(emojiRate * 100)}% use one`);

  const hashRate = pct((t) => /(^|\s)#\w/.test(t));
  if (hashRate < 0.05) add("No hashtags", `${Math.round(hashRate * 100)}% use one`);

  const brit = pct((t) => /\b(colour|favourite|realis|organis|centre|honour|whilst|mum|cheers|brilliant|mate|bloke|quid|proper|reckon|fortnight|knackered|keen|bit of a|sort of|fancy|rubbish|lovely|ta\b)/i.test(t));
  if (brit > 0.08) add("British spelling and phrasing", `${Math.round(brit * 100)}% show it`);

  const qRate = pct((t) => /\?/.test(t));
  if (qRate > 0.3) add("Often ask a question back", `${Math.round(qRate * 100)}% contain one`);
  else if (qRate < 0.1) add("Rarely ask questions – make statements", `${Math.round(qRate * 100)}% contain one`);

  const exRate = pct((t) => /!/.test(t));
  if (exRate < 0.08) add("No exclamation marks", `${Math.round(exRate * 100)}% use one`);
  else if (exRate > 0.4) add("Exclamation marks are fine", `${Math.round(exRate * 100)}% use one`);

  const lowerStart = pct((t) => /^[a-z]/.test(t));
  if (lowerStart > 0.5) add("Start in lowercase, relaxed punctuation", `${Math.round(lowerStart * 100)}% start lowercase`);

  const noStop = pct((t) => !/[.!?…]["')]?$/.test(t.trim()));
  if (noStop > 0.55) add("Skip the final full stop", `${Math.round(noStop * 100)}% end without one`);

  const dash = pct((t) => /\s[–—-]\s|—/.test(t));
  if (dash > 0.15) add("Use a dash – for asides", `${Math.round(dash * 100)}% use one`);

  const ellipsis = pct((t) => /\.\.\.|…/.test(t));
  if (ellipsis > 0.15) add("Trailing ellipsis… is in character", `${Math.round(ellipsis * 100)}% use one`);

  const multiline = pct((t) => /\n/.test(t));
  if (multiline > 0.3) add("Line breaks between thoughts", `${Math.round(multiline * 100)}% are multi-line`);

  const linkRate = pct((t) => /https?:\/\/|\w+\.(com|app|uk|io|co)\b/i.test(t));
  if (linkRate > 0.2) add("Dropping a link is normal for me", `${Math.round(linkRate * 100)}% include one`);
  else add("Don't drop links into replies", `${Math.round(linkRate * 100)}% include one`);

  const firstPerson = pct((t) => /\b(I|I've|I'm|my|me)\b/.test(t));
  if (firstPerson > 0.5) add("Speak from personal experience ('I…')", `${Math.round(firstPerson * 100)}% first person`);

  const thanks = pct((t) => /\b(thanks|thank you|cheers|appreciate)\b/i.test(t));
  if (thanks > 0.15) add("Say thanks/cheers when someone's been helpful", `${Math.round(thanks * 100)}% do`);

  // signature words
  const freq = new Map();
  texts.forEach((t) => {
    const seen = new Set();
    t.toLowerCase().replace(/https?:\/\/\S+/g, "").match(/[a-z']{3,}/g)?.forEach((w) => {
      if (STOP.has(w) || seen.has(w)) return;
      seen.add(w); freq.set(w, (freq.get(w) || 0) + 1);
    });
  });
  const sig = [...freq.entries()].filter(([, c]) => c / n >= 0.05 && c >= 4).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
  if (sig.length >= 3) add(`Words I actually use: ${sig.join(", ")}`, "frequent across samples");

  // openers
  const op = new Map();
  texts.forEach((t) => { const w = (t.match(/^[A-Za-z']+/) || [""])[0].toLowerCase(); if (w && !STOP.has(w)) op.set(w, (op.get(w) || 0) + 1); });
  const topOp = [...op.entries()].filter(([, c]) => c / n >= 0.06).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => `"${w}"`);
  if (topOp.length) add(`Common openers: ${topOp.join(", ")}`, "how replies tend to start");

  return out;
}

function notesHas(rule) {
  return $("#styleNotes").value.split("\n").some((l) => l.trim().toLowerCase() === rule.trim().toLowerCase());
}
function toggleRule(rule) {
  const ta = $("#styleNotes");
  const lines = ta.value.split("\n");
  const idx = lines.findIndex((l) => l.trim().toLowerCase() === rule.trim().toLowerCase());
  if (idx >= 0) lines.splice(idx, 1);
  else lines.push(rule);
  ta.value = lines.filter((l, i, a) => l.trim() || (i === a.length - 1 && false)).join("\n").replace(/^\n+/, "");
  markDirty();
  syncChipStates();
}
function syncChipStates() {
  $$(".chip").forEach((c) => c.classList.toggle("on", notesHas(c.dataset.rule)));
}
function renderChips(container, items) {
  container.innerHTML = "";
  if (!items.length) { container.innerHTML = '<span class="muted">Learn some samples first and suggestions will appear here.</span>'; return; }
  items.forEach(({ rule, why }) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.dataset.rule = rule;
    b.textContent = rule;
    if (why) { const w = document.createElement("span"); w.className = "why"; w.textContent = why; b.appendChild(w); }
    b.addEventListener("click", () => toggleRule(rule));
    container.appendChild(b);
  });
  syncChipStates();
}
let aiChips = [];
function renderLocalChips() {
  const local = analyseLocal(samplesCache);
  const merged = [...aiChips, ...local.filter((l) => !aiChips.some((a) => a.rule.toLowerCase() === l.rule.toLowerCase()))];
  renderChips($("#chips"), merged);
}
async function analyseWithAI() {
  if (samplesCache.length < 5) return toast("Learn at least a few samples first", true);
  await chrome.storage.local.set(collect());
  const btn = $("#analyse"); btn.disabled = true; btn.textContent = "Analysing…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "ANALYZE_VOICE" });
    if (!res?.ok) throw new Error(res?.error || "unknown error");
    aiChips = res.traits.map((t) => ({ rule: t.rule, why: t.why ? "AI: " + t.why : "AI" }));
    await chrome.storage.local.set({ aiTraits: aiChips });
    renderLocalChips();
    toast(`${aiChips.length} suggestions from ${res.provider}`);
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = "✨ Analyse with AI"; }
}

/* ---------- segmented controls ---------- */
function seg(id, value) {
  const el = $(id);
  el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === String(value)));
}
function segValue(id, fallback) {
  return $(id).querySelector("button.on")?.dataset.v || String(fallback);
}

/* ---------- load / collect / save ---------- */
async function load() {
  const s = await chrome.storage.local.get(null);
  $("#ver").textContent = chrome.runtime.getManifest().version;
  const provider = s.provider || "claude";
  $$('input[name=provider]').forEach((r) => (r.checked = r.value === provider));
  for (const p of PROVIDERS) {
    $(`input[data-key="${p}"]`).value = s.keys?.[p] || "";
    const cache = s.modelCache?.[p];
    let saved = s.models?.[p] || DEFAULT_MODELS[p];
    if (OLD_MODEL.test(saved) && !cache?.models?.some((m) => m.id === saved)) saved = DEFAULT_MODELS[p];
    fillSelect(p, cache?.models?.length ? cache.models : FALLBACK_MODELS[p], saved);
    setHint(p, cache?.models?.length ? `${cache.models.length} models (loaded ${new Date(cache.at).toLocaleDateString()}).` : "Built-in list – add a key for the live list.");
  }
  $("#handle").value = s.handle || "";
  $("#lookback").value = s.lookback || "all";
  $("#lookbackDate").value = s.lookbackDate || "";
  $("#lookbackDate").hidden = $("#lookback").value !== "date";
  $("#manualSamples").value = s.manualSamples || "";
  $("#styleNotes").value = s.styleNotes || "";
  seg("#countSeg", s.count || 3);
  seg("#lenSeg", s.maxChars || 240);
  const angles = s.angles || ["add", "agree", "question", "witty"];
  $$("#angles input").forEach((c) => (c.checked = angles.includes(c.value)));
  $("#noProducts").checked = s.noProducts ?? true;
  $("#noEmoji").checked = !!s.noEmoji;
  $("#noHashtags").checked = s.noHashtags ?? true;
  $("#useDraft").checked = s.useDraft ?? true;
  $("#oneClick").checked = !!s.oneClick;
  aiChips = s.aiTraits || [];
  renderChips($("#chipsCommon"), COMMON_CHIPS.map((rule) => ({ rule })));
  renderSamples(s.scrapedSamples || []);
  refreshProviderUI();
  markClean();
  for (const p of PROVIDERS) if (s.keys?.[p] && !s.modelCache?.[p]) refreshModels(p, { quiet: true });
  let tab = "provider";
  try { tab = localStorage.getItem("xrc-tab") || tab; } catch (_) {}
  showTab(tab);
}
function collect() {
  const keys = {}, models = {};
  for (const p of PROVIDERS) {
    keys[p] = $(`input[data-key="${p}"]`).value.trim();
    models[p] = $(`select[data-model="${p}"]`).value || DEFAULT_MODELS[p];
  }
  return {
    provider: selectedProvider(), keys, models,
    handle: $("#handle").value.trim().replace(/^@/, ""),
    lookback: $("#lookback").value, lookbackDate: $("#lookbackDate").value,
    manualSamples: $("#manualSamples").value, styleNotes: $("#styleNotes").value,
    count: parseInt(segValue("#countSeg", 3), 10), maxChars: parseInt(segValue("#lenSeg", 240), 10),
    angles: $$("#angles input:checked").map((c) => c.value),
    noProducts: $("#noProducts").checked, noEmoji: $("#noEmoji").checked, noHashtags: $("#noHashtags").checked,
    useDraft: $("#useDraft").checked, oneClick: $("#oneClick").checked
  };
}
async function save() {
  await chrome.storage.local.set(collect());
  markClean(); toast("Saved");
  refreshProviderUI();
}
async function test() {
  await chrome.storage.local.set(collect()); markClean();
  const out = $("#testResult"); out.hidden = false; out.className = "test-result"; out.textContent = "Testing…";
  $("#test").disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "GENERATE", payload: { post: { author: "@example", text: "Just launched my little side project after 6 months of evenings and weekends. Terrified and excited." }, thread: [], draft: "" } });
    if (res?.ok) { out.className = "test-result ok"; out.textContent = "Works. Sample replies:\n\n" + res.suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n"); }
    else { out.className = "test-result err"; out.textContent = "Failed: " + (res?.error || "unknown error"); }
  } catch (e) { out.className = "test-result err"; out.textContent = "Failed: " + e.message; }
  finally { $("#test").disabled = false; }
}

/* ---------- wire up ---------- */
document.addEventListener("DOMContentLoaded", () => {
  load();
  $$(".nav-item").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#save").addEventListener("click", save);
  $("#test").addEventListener("click", test);
  $("#analyse").addEventListener("click", analyseWithAI);
  $("#openProfile").addEventListener("click", async () => {
    const h = $("#handle").value.trim().replace(/^@/, "");
    if (!h) return toast("Enter your handle first", true);
    if (dirty) await save();
    chrome.tabs.create({ url: `https://x.com/${h}` });
  });
  $("#clearSamples").addEventListener("click", async () => {
    if (!confirm("Remove all learned samples?")) return;
    await chrome.storage.local.set({ scrapedSamples: [], aiTraits: [] });
    aiChips = []; renderSamples([]); toast("Samples cleared");
  });
  $$('input[name=provider]').forEach((r) => r.addEventListener("change", () => { refreshProviderUI(); markDirty(); }));
  $$("button[data-refresh]").forEach((b) => b.addEventListener("click", () => refreshModels(b.dataset.refresh)));
  $$("input[data-key]").forEach((i) => {
    let t;
    i.addEventListener("input", () => { markDirty(); refreshProviderUI(); clearTimeout(t); t = setTimeout(() => refreshModels(i.dataset.key, { quiet: true }), 800); });
  });
  $$(".toggle").forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault();
    const input = b.parentElement.querySelector("input");
    const show = input.type === "password"; input.type = show ? "text" : "password"; b.textContent = show ? "hide" : "show";
  }));
  $("#lookback").addEventListener("change", () => ($("#lookbackDate").hidden = $("#lookback").value !== "date"));
  $$("#countSeg button, #lenSeg button").forEach((b) => b.addEventListener("click", () => { seg("#" + b.parentElement.id, b.dataset.v); markDirty(); }));
  $$("input, select, textarea").forEach((el) => el.addEventListener("input", markDirty));
  $("#styleNotes").addEventListener("input", syncChipStates);
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.scrapedSamples) renderSamples(changes.scrapedSamples.newValue || []);
  });
  window.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } });
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
});

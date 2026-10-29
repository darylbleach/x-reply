// X Reply Autopilot – background service worker
// All AI provider calls, background scheduling, Autopilot feed scanning,
// and automated voice learning happen here.

const DEFAULTS = {
  provider: "claude",
  models: { claude: "claude-sonnet-5-5", openai: "gpt-6-luna", gemini: "gemini-3.8-flash", grok: "grok-4.7" },
  keys: { claude: "", openai: "", gemini: "", grok: "" },
  count: 3,
  maxChars: 240,
  styleNotes: "",
  manualSamples: "",
  scrapedSamples: [],
  aiTraits: [],
  handle: "",
  lookback: "all",
  lookbackDate: "",
  angles: ["add", "agree", "question", "witty"],
  noProducts: true,
  noEmoji: false,
  noHashtags: true,
  useDraft: true,
  oneClick: false,
  autoSuggest: true,
  // queue mode
  queueBatch: 10,
  queueSpread: 60,       // minutes to spread approved replies over
  queueMinChars: 20,     // skip posts shorter than this
  queueMaxAgeHours: 24,  // skip posts older than this
  queueCloseTabs: true,
  queueGapSeconds: 90,   // minimum gap between two posts
  jobs: [],
  repliedIds: [],
  // full automation / autopilot
  autopilotEnabled: true,
  autopilotIntervalMinutes: 60,
  autopilotPerRun: 5,
  autopilotScrolls: 3,
  autopilotSources: "https://x.com/home",
  autopilotSourceIndex: 0,
  autopilotDailyCap: 25,
  autopilotMinGapSeconds: 120,
  autopilotRespectHours: true,
  autopilotStartHour: 8,
  autopilotEndHour: 22,
  autopilotAutoApprove: true,
  autoDetectHandle: true,
  autoLearnEnabled: true,
  autoLearnIntervalDays: 7,
  autoAnalyzeVoice: true,
  autoApplyTraits: true,
  lastLearnedAt: 0,
  lastAutopilotAt: 0,
  autopilotState: {
    status: "idle",
    lastRunAt: 0,
    lastResult: "Ready – waiting for first scan"
  }
};

const PROVIDER_NAMES = { claude: "Claude", openai: "ChatGPT (OpenAI)", gemini: "Google Gemini", grok: "Grok (xAI)" };

async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  return {
    ...DEFAULTS,
    ...stored,
    models: { ...DEFAULTS.models, ...(stored.models || {}) },
    keys: { ...DEFAULTS.keys, ...(stored.keys || {}) },
    autopilotState: { ...DEFAULTS.autopilotState, ...(stored.autopilotState || {}) }
  };
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
  syncAutomationAlarms();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    GENERATE: () => generate(msg.payload).then((suggestions) => ({ ok: true, suggestions })),
    ANALYZE_VOICE: () => analyzeVoice().then((r) => ({ ok: true, ...r })),
    LIST_MODELS: () => listModels(msg.payload).then((models) => ({ ok: true, models })),
    SAVE_SAMPLES: () => saveSamples(msg.payload).then((total) => ({ ok: true, total })),
    GET_SETTINGS: () =>
      getSettings().then((s) => {
        const dailyStats = getDailyStats(s.jobs || [], s);
        const { keys, scrapedSamples, aiTraits, modelCache, jobs, repliedIds, autoLearnJob, autopilotScanJob, ...safe } = s;
        safe.repliedCount = repliedIds.length;
        safe.hasKey = !!keys[s.provider];
        safe.sampleCount = scrapedSamples.length;
        safe.dailyStats = dailyStats;
        return { ok: true, settings: safe };
      }),
    OPEN_OPTIONS: async () => { chrome.runtime.openOptionsPage(); return { ok: true }; },
    QUEUE_ADD: () => queueAdd(msg.payload).then((jobs) => ({ ok: true, jobs })),
    QUEUE_LIST: () => queueList().then((r) => ({ ok: true, ...r })),
    QUEUE_CANCEL: () => queueCancel(msg.payload.id).then((jobs) => ({ ok: true, jobs })),
    QUEUE_POST_NOW: () => queuePostNow(msg.payload.id).then((jobs) => ({ ok: true, jobs })),
    QUEUE_CLEAR_DONE: () => queueClearDone().then((jobs) => ({ ok: true, jobs })),
    JOB_FOR_URL: () => jobForUrl(msg.payload.url, _sender?.tab?.id).then((job) => ({ ok: true, job })),
    JOB_RESULT: () => jobResult(msg.payload).then(() => ({ ok: true })),
    MARK_REPLIED: () => markReplied(msg.payload.ids).then(() => ({ ok: true })),
    FILTER_NEW: () => filterNew(msg.payload.ids).then((ids) => ({ ok: true, ids })),
    // Automation / Autopilot handlers
    AUTOPILOT_RUN_NOW: () => startAutopilotScan({ force: true }).then((r) => ({ ok: true, ...r })),
    AUTOPILOT_TOGGLE: () => toggleAutopilot(msg.payload?.enabled).then((r) => ({ ok: true, ...r })),
    AUTOPILOT_FOR_TAB: () => autopilotForTab(_sender?.tab?.id, msg.payload?.url).then((task) => ({ ok: true, task })),
    AUTOPILOT_COMPLETE: () => autopilotComplete(msg.payload).then(() => ({ ok: true })),
    AUTOLEARN_RUN_NOW: () => startAutoLearn({ force: true }).then((r) => ({ ok: true, ...r })),
    AUTOLEARN_FOR_TAB: () => autoLearnForTab(_sender?.tab?.id, msg.payload?.handle).then((task) => ({ ok: true, task })),
    AUTOLEARN_COMPLETE: () => autoLearnComplete(msg.payload).then((r) => ({ ok: true, ...r }))
  };
  const h = handlers[msg?.type];
  if (!h) return false;
  h().then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

async function saveSamples({ samples, replace }) {
  const s = await getSettings();
  const existing = replace ? [] : s.scrapedSamples;
  const seen = new Set(existing.map((x) => x.text));
  for (const smp of samples) {
    if (smp.text && !seen.has(smp.text)) { existing.push(smp); seen.add(smp.text); }
  }
  const trimmed = existing.sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-600);
  await chrome.storage.local.set({ scrapedSamples: trimmed });
  return trimmed.length;
}

/* ============================ Prompting ============================ */

function pickSamples(s, budget) {
  const manual = s.manualSamples.split(/\n\s*\n|\n---\n/).map((t) => t.trim()).filter(Boolean).map((text) => ({ text, kind: "sample", ts: Date.now() }));
  const replies = s.scrapedSamples.filter((x) => x.kind === "reply").sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const posts = s.scrapedSamples.filter((x) => x.kind !== "reply").sort((a, b) => (b.ts || 0) - (a.ts || 0));
  // Interleave: manual first, then mostly replies with some posts for range.
  const chosen = [];
  let used = 0;
  const take = (arr, max) => {
    let n = 0;
    for (const x of arr) {
      if (n >= max) break;
      if (used + x.text.length > budget) break;
      chosen.push(x); used += x.text.length; n++;
    }
  };
  take(manual, 40);
  take(replies, 70);
  take(posts, 30);
  take(replies.slice(70), 60);
  return chosen;
}

function voiceBlock(s) {
  const parts = [];
  const notes = s.styleNotes.trim();
  if (notes) parts.push(`STYLE RULES (written by the user – follow these over anything you infer):\n${notes}`);
  const chosen = pickSamples(s, 9000);
  if (chosen.length) {
    parts.push(
      `REAL EXAMPLES of what the user has written on X (${chosen.length}; replies marked [reply]). Study the rhythm, sentence length, punctuation, capitalisation, humour, warmth, how they open and close, which words they reach for and which they never use:\n` +
        chosen.map((c) => `[${c.kind}] ${c.text.replace(/\s+/g, " ")}`).join("\n")
    );
  }
  return parts.join("\n\n");
}

const ANGLE_TEXT = {
  add: "ADD VALUE – contribute something concrete: a tip, a fact, a related experience, a specific observation about what they said. The kind of reply that makes a reader curious enough to look at the user's profile.",
  agree: "AGREE & AMPLIFY – back them up and add a bit extra, without just restating their point.",
  question: "ASK – a single, specific question that shows you read the post and invites a real answer.",
  pushback: "GENTLE PUSH-BACK – a different take, offered kindly and briefly.",
  witty: "LIGHT – a dry or playful line, only in the user's register; no puns or dad jokes unless their samples have them.",
  personal: "PERSONAL – a short first-person anecdote the user's samples make plausible; never invent specifics that aren't supported."
};

function buildPrompt(s, payload) {
  const { post, thread, draft, tweak } = payload;
  const count = Math.max(1, Math.min(6, s.count));
  const angles = (s.angles && s.angles.length ? s.angles : DEFAULTS.angles).map((a) => ANGLE_TEXT[a]).filter(Boolean);

  const rules = [
    count === 1
      ? `Write exactly 1 reply, under ${s.maxChars} characters. Pick whichever angle below fits this post best; if none fits well, say nothing useful rather than forcing it – output an empty string.`
      : `Write exactly ${count} reply options. Each must be under ${s.maxChars} characters.`,
    "Sound exactly like the user. Not like an assistant, a brand account, or a LinkedIn post.",
    "Never open with praise filler ('Great post', 'Love this', 'This is so true', 'Absolutely'). Never start with the other person's name or handle.",
    "No preamble, no quotation marks around replies, no numbering inside the text, never mention being an AI.",
    "Be specific to THIS post – reference what they actually said. Generic encouragement is a failure.",
    "Don't repeat the post back to them. Don't summarise it. React to it.",
    "No corporate or AI-flavoured words: delve, leverage, game-changer, resonate, journey, unlock, elevate, folks, 'in today's world', 'at the end of the day'.",
    "Avoid em dashes unless the user's examples use them. Avoid tidy three-item lists.",
    "Replies must each take a different angle (below). Don't produce three variations of the same idea.",
    "Aim for replies that earn a reply back or a profile visit, not just a like. Anything that could read as spam, a plug or engagement bait is worse than saying nothing.",
    s.noHashtags ? "No hashtags." : "Hashtags only if the user's examples use them.",
    s.noEmoji ? "No emoji at all." : "Emoji only if, and as often as, the user's examples use them.",
    s.noProducts
      ? "Never mention or plug the user's own products, apps or websites unless the post is explicitly about that exact topic. Never self-promote."
      : "You may mention the user's products when clearly relevant, lightly, the way they do in their examples."
  ];

  const sys = `You ghost-write replies on X (Twitter) for one specific person. Your only job is to produce replies they would plausibly have typed themselves.

HARD RULES
${rules.map((r) => "- " + r).join("\n")}

ANGLES TO COVER (one per reply, in this order; if more replies than angles, vary within them)
${angles.map((a, i) => `${i + 1}. ${a}`).join("\n")}

${voiceBlock(s) || "No voice samples supplied yet; write in a relaxed, direct, British-English tone, short sentences, no emoji."}

OUTPUT: a JSON array of ${count} strings and nothing else.`;

  let user = `POST TO REPLY TO\nAuthor: ${post.author || "unknown"}\n"""\n${post.text}\n"""`;
  if (thread && thread.length) {
    user += `\n\nEARLIER IN THE THREAD (oldest first) – for context only:\n` + thread.map((t) => `- ${t.author}: ${t.text}`).join("\n");
  }
  if (s.useDraft && draft && draft.trim()) {
    user += `\n\nThe user has started typing this; every option must build on its intent and keep its wording where sensible:\n"${draft.trim()}"`;
  }
  if (tweak) user += `\n\nADJUSTMENT FOR THIS RUN: ${tweak}`;
  user += `\n\nReturn a JSON array of ${count} reply strings.`;
  return { sys, user };
}

function extractJSONArray(text) {
  if (!text) throw new Error("Empty response from model");
  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const arr = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(arr)) return arr;
    } catch (_) {}
  }
  return null;
}

function parseSuggestions(text, count, maxChars) {
  const arr = extractJSONArray(text);
  let out;
  if (arr) out = arr.map((x) => (typeof x === "string" ? x : x?.text || x?.reply || "")).map((x) => String(x).trim()).filter(Boolean);
  else {
    out = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
      .split(/\n+/)
      .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").replace(/^["“]|["”]$/g, "").trim())
      .filter((l) => l.length > 2);
  }
  if (!out.length) throw new Error("Could not parse model output");
  // Final guard: strip praise openers / quotes, enforce length
  out = out.map((t) =>
    t.replace(/^["“”']+|["“”']+$/g, "")
      .replace(/^(great|love|awesome|amazing|fantastic|brilliant)\s+(post|this|thread|take)[!.,]*\s*/i, "")
      .trim()
  );
  const hard = Math.max(40, maxChars);
  out = out.map((t) => (t.length > hard * 1.3 ? t.slice(0, hard).replace(/\s+\S*$/, "") : t));
  return out.slice(0, count);
}

/* ============================ Actions ============================ */

async function generate(payload) {
  const s = await getSettings();
  const key = s.keys[s.provider];
  if (!key) throw new Error(`No API key saved for ${PROVIDER_NAMES[s.provider]}. Open the extension settings.`);
  if (payload.count) s.count = payload.count;
  const { sys, user } = buildPrompt(s, payload);
  const text = await complete(s.provider, key, s.models[s.provider], sys, user, true);
  return parseSuggestions(text, Math.max(1, Math.min(6, s.count)), s.maxChars);
}

async function analyzeVoice() {
  const s = await getSettings();
  const key = s.keys[s.provider];
  if (!key) throw new Error(`No API key saved for ${PROVIDER_NAMES[s.provider]}.`);
  const chosen = pickSamples(s, 14000);
  if (chosen.length < 5) throw new Error("Not enough samples yet – learn your voice on X first.");
  const sys = `You are a writing-style analyst. You will be given real posts and replies one person wrote on X. Produce concise, actionable style rules a ghost-writer could follow to imitate them. Be concrete and specific to THIS person (words they use, how they open, punctuation, length, humour, warmth, what they never do). Avoid generic advice. 8 to 14 rules. Each rule under 80 characters, written as an instruction ("Open with the point, no greeting"). Also give a one-sentence summary of the voice.
Output ONLY JSON: {"summary": "...", "traits": [{"rule": "...", "why": "short evidence, under 60 chars"}]}`;
  const user = `SAMPLES (${chosen.length}; [reply] = a reply to someone else):\n` + chosen.map((c) => `[${c.kind}] ${c.text.replace(/\s+/g, " ")}`).join("\n");
  const text = await complete(s.provider, key, s.models[s.provider], sys, user, false);
  let obj = null;
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
    obj = JSON.parse(cleaned.slice(a, b + 1));
  } catch (_) {
    throw new Error("Model returned something that wasn't JSON. Try again.");
  }
  const traits = (obj.traits || []).map((t) => ({ rule: String(t.rule || "").trim(), why: String(t.why || "").trim() })).filter((t) => t.rule);
  if (!traits.length) throw new Error("No traits returned. Try again.");
  return { traits, summary: obj.summary || "", provider: PROVIDER_NAMES[s.provider] };
}

function mergeStyleRules(existingNotes, traitList, maxTotal = 14) {
  const lines = String(existingNotes || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Set(lines.map((l) => l.toLowerCase()));
  for (const t of traitList) {
    if (lines.length >= maxTotal) break;
    const rule = String(typeof t === "string" ? t : t?.rule || "").trim();
    if (!rule || seen.has(rule.toLowerCase())) continue;
    lines.push(rule);
    seen.add(rule.toLowerCase());
  }
  return lines.join("\n");
}

function quickLocalRules(samples) {
  const n = (samples || []).length;
  if (n < 8) return [];
  const texts = samples.map((s) => s.text);
  const pct = (f) => texts.filter(f).length / n;
  const words = texts.map((t) => t.split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
  const median = words[Math.floor(n / 2)];
  const rules = [];
  if (median <= 12) rules.push("Keep it short – one punchy line");
  else if (median <= 25) rules.push("One or two sentences, no essays");
  if (pct((t) => /\p{Extended_Pictographic}/u.test(t)) < 0.05) rules.push("No emoji");
  if (pct((t) => /(^|\s)#\w/.test(t)) < 0.05) rules.push("No hashtags");
  if (pct((t) => /\b(colour|favourite|realis|organis|centre|honour|whilst|mum|cheers|brilliant|mate|bloke|quid|proper|reckon|fortnight|knackered|keen|bit of a|sort of|fancy|rubbish|lovely|ta\b)/i.test(t)) > 0.08) {
    rules.push("British spelling and phrasing");
  }
  if (pct((t) => /!/.test(t)) < 0.08) rules.push("No exclamation marks");
  if (pct((t) => /^[a-z]/.test(t)) > 0.5) rules.push("Start in lowercase, relaxed punctuation");
  if (pct((t) => !/[.!?…]["')]?$/.test(t.trim())) > 0.55) rules.push("Skip the final full stop");
  return rules;
}

/* ============================ Providers ============================ */

async function readError(res) {
  let body = "";
  try { body = await res.text(); } catch (_) {}
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message || j?.error?.type || j?.message || body;
  } catch (_) {}
  return `${res.status}: ${String(msg).slice(0, 300)}`;
}

async function postJSON(url, headers, body, label) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${label} ${await readError(res)}`);
  return res.json();
}

async function complete(provider, key, model, sys, user, wantArray) {
  switch (provider) {
    case "claude": {
      const j = await postJSON(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        { model, max_tokens: 1500, system: sys, messages: [{ role: "user", content: user }] },
        "Claude"
      );
      return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    }
    case "openai":
    case "grok": {
      const url = provider === "grok" ? "https://api.x.ai/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
      const j = await postJSON(
        url,
        { authorization: `Bearer ${key}` },
        { model, messages: [{ role: "system", content: sys }, { role: "user", content: user }] },
        provider === "grok" ? "Grok" : "OpenAI"
      );
      return j.choices?.[0]?.message?.content || "";
    }
    case "gemini": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      const j = await postJSON(
        url,
        {},
        {
          systemInstruction: { parts: [{ text: sys }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: 2048, responseMimeType: "application/json" }
        },
        "Gemini"
      );
      return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n");
    }
    default:
      throw new Error("Unknown provider " + provider);
  }
}

async function listModels({ provider, key }) {
  if (!key) throw new Error("Enter an API key first");
  const get = async (url, headers) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(await readError(res));
    return res.json();
  };
  switch (provider) {
    case "claude": {
      const j = await get("https://api.anthropic.com/v1/models?limit=100", {
        "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"
      });
      return (j.data || []).map((m) => ({ id: m.id, label: m.display_name ? `${m.display_name} (${m.id})` : m.id }));
    }
    case "openai": {
      const j = await get("https://api.openai.com/v1/models", { authorization: `Bearer ${key}` });
      const skip = /embedding|whisper|tts|dall-e|audio|realtime|transcribe|moderation|image|search|similarity|edit|babbage|davinci|ada|curie|instruct|computer-use|codex|sora|research/i;
      return (j.data || []).map((m) => m.id).filter((id) => /^(gpt-|o\d|chatgpt)/.test(id) && !skip.test(id)).sort().reverse().map((id) => ({ id, label: id }));
    }
    case "grok": {
      const j = await get("https://api.x.ai/v1/models", { authorization: `Bearer ${key}` });
      return (j.data || []).map((m) => m.id).filter((id) => !/image|embed|vision-beta/i.test(id)).sort().reverse().map((id) => ({ id, label: id }));
    }
    case "gemini": {
      const j = await get(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`, {});
      return (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .filter((m) => !/embedding|aqa|imagen|veo|tts|image-generation|live|native-audio/i.test(m.name))
        .map((m) => { const id = m.name.replace(/^models\//, ""); return { id, label: m.displayName ? `${m.displayName} (${id})` : id }; })
        .sort((a, b) => b.id.localeCompare(a.id));
    }
    default:
      throw new Error("Unknown provider");
  }
}

/* ============================ Smart Pacing & Helpers ============================ */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function isHourInWindow(hour, startHour, endHour) {
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

function isWithinActiveHours(s, ts = Date.now()) {
  if (!s?.autopilotRespectHours) return true;
  const d = new Date(ts);
  return isHourInWindow(d.getHours(), Number(s.autopilotStartHour ?? 8), Number(s.autopilotEndHour ?? 22));
}

function clampToActiveHours(ts, s) {
  if (!s?.autopilotRespectHours || isWithinActiveHours(s, ts)) return ts;
  const startH = Number(s.autopilotStartHour ?? 8);
  const d = new Date(ts);
  const next = new Date(d);
  next.setMinutes(0, 0, 0);
  next.setHours(startH);
  if (next.getTime() <= ts) next.setDate(next.getDate() + 1);
  return next.getTime() + 60_000 + Math.floor(Math.random() * 14 * 60_000);
}

function getDailyStats(jobs, s) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const sod = startOfDay.getTime();
  const eod = sod + 86400_000;
  const postedToday = (jobs || []).filter((j) => j.kind !== "post" && j.status === "done" && (j.doneAt || 0) >= sod).length;
  const scheduledToday = (jobs || []).filter((j) => j.kind !== "post" && (j.status === "scheduled" || j.status === "posting") && (j.dueAt || 0) >= sod && (j.dueAt || 0) < eod).length;
  const cap = Number(s?.autopilotDailyCap || 25);
  const totalToday = postedToday + scheduledToday;
  const remainingToday = Math.max(0, cap - totalToday);
  return { postedToday, scheduledToday, totalToday, cap, remainingToday };
}

function parseAutopilotSources(raw) {
  const lines = String(raw || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const urls = lines.map((line) => {
    if (/^https?:\/\/(x|twitter)\.com\//i.test(line)) return line;
    if (/^@?[A-Za-z0-9_]{1,15}$/.test(line)) return `https://x.com/${line.replace(/^@/, "")}`;
    const q = line.replace(/^search:\s*/i, "");
    return `https://x.com/search?q=${encodeURIComponent(q)}&f=live`;
  });
  return urls.length ? urls : ["https://x.com/home"];
}

/* ============================ Queue / scheduler ============================ */
// A job: { id, kind: "reply"|"post", url, statusId, author, postText, text, dueAt,
//          status: "scheduled"|"posting"|"done"|"failed"|"cancelled", error, createdAt, doneAt, tabId, auto }

async function getJobs() {
  const { jobs = [] } = await chrome.storage.local.get("jobs");
  return jobs;
}
async function setJobs(jobs) {
  await chrome.storage.local.set({ jobs: jobs.slice(-300) });
  return jobs;
}

function spreadTimes(n, spreadMinutes, gapSeconds, existing, s) {
  const baseStart = s ? clampToActiveHours(Date.now() + 45_000, s) : Date.now() + 45_000;
  const windowMs = Math.max(2, spreadMinutes) * 60 * 1000;
  const minGapSec = Math.max(gapSeconds || 90, s?.autopilotMinGapSeconds || 90);
  const gap = minGapSec * 1000;
  const taken = existing.filter((j) => j.status === "scheduled").map((j) => j.dueAt);
  const times = [];
  let tries = 0;
  while (times.length < n && tries < 2000) {
    tries++;
    const rawT = baseStart + Math.random() * windowMs;
    const t = s ? clampToActiveHours(rawT, s) : rawT;
    if ([...taken, ...times].every((x) => Math.abs(x - t) >= gap)) times.push(t);
  }
  while (times.length < n) {
    const latest = Math.max(baseStart, ...taken, ...times);
    const nextT = latest + gap + Math.floor(Math.random() * (gap * 0.6));
    times.push(s ? clampToActiveHours(nextT, s) : nextT);
  }
  return times.sort((a, b) => a - b);
}

async function queueAdd({ items, spreadMinutes, auto }) {
  const s = await getSettings();
  const jobs = await getJobs();
  const spread = spreadMinutes ?? s.queueSpread;
  const times = spreadTimes(items.length, spread, s.queueGapSeconds, jobs, s);
  const created = items.map((it, i) => ({
    id: uid(),
    kind: it.kind || "reply",
    url: it.url,
    statusId: it.statusId || "",
    author: it.author || "",
    postText: (it.postText || "").slice(0, 280),
    text: it.text,
    dueAt: it.dueAt ? (s.autopilotRespectHours ? clampToActiveHours(it.dueAt, s) : it.dueAt) : times[i],
    status: "scheduled",
    auto: !!auto,
    createdAt: Date.now()
  }));
  const all = [...jobs, ...created];
  await setJobs(all);
  for (const j of created) chrome.alarms.create("job:" + j.id, { when: j.dueAt });
  return created;
}

async function queueList() {
  const s = await getSettings();
  const jobs = s.jobs || [];
  return {
    jobs: jobs.sort((a, b) => a.dueAt - b.dueAt),
    now: Date.now(),
    dailyStats: getDailyStats(jobs, s),
    autopilotEnabled: !!s.autopilotEnabled,
    autopilotState: s.autopilotState
  };
}

async function queueCancel(id) {
  const jobs = await getJobs();
  const j = jobs.find((x) => x.id === id);
  if (j && (j.status === "scheduled" || j.status === "failed")) { j.status = "cancelled"; chrome.alarms.clear("job:" + id); }
  return setJobs(jobs);
}

async function queuePostNow(id) {
  const jobs = await getJobs();
  const j = jobs.find((x) => x.id === id);
  if (j && (j.status === "scheduled" || j.status === "failed")) {
    j.status = "scheduled"; j.error = ""; j.dueAt = Date.now();
    await setJobs(jobs);
    chrome.alarms.clear("job:" + id);
    runJob(id, { forceNow: true });
  }
  return getJobs();
}

async function queueClearDone() {
  const jobs = (await getJobs()).filter((j) => !["done", "cancelled", "failed"].includes(j.status));
  return setJobs(jobs);
}

async function markReplied(ids) {
  const { repliedIds = [] } = await chrome.storage.local.get("repliedIds");
  const set = new Set(repliedIds);
  ids.forEach((i) => i && set.add(i));
  await chrome.storage.local.set({ repliedIds: [...set].slice(-3000) });
}

async function filterNew(ids) {
  const { repliedIds = [] } = await chrome.storage.local.get("repliedIds");
  const jobs = await getJobs();
  const busy = new Set([...repliedIds, ...jobs.filter((j) => ["scheduled", "posting", "done"].includes(j.status)).map((j) => j.statusId)]);
  return ids.filter((i) => !busy.has(i));
}

async function runJob(id, { forceNow = false } = {}) {
  const s = await getSettings();
  const jobs = await getJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j || j.status !== "scheduled") return;
  if (!forceNow && s.autopilotRespectHours && !isWithinActiveHours(s)) {
    const nextDue = clampToActiveHours(Date.now(), s);
    j.dueAt = nextDue;
    await setJobs(jobs);
    chrome.alarms.create("job:" + j.id, { when: nextDue });
    return;
  }
  j.status = "posting"; j.startedAt = Date.now();
  await setJobs(jobs);
  try {
    const tab = await chrome.tabs.create({ url: j.url, active: false });
    j.tabId = tab.id;
    await setJobs(await getJobs().then((all) => all.map((x) => (x.id === id ? j : x))));
    chrome.alarms.create("jobtimeout:" + id, { when: Date.now() + 90_000 });
  } catch (e) {
    j.status = "failed"; j.error = "Couldn't open tab: " + e.message;
    await setJobs(await getJobs().then((all) => all.map((x) => (x.id === id ? j : x))));
  }
}

async function timeoutJob(id) {
  const jobs = await getJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j || j.status !== "posting") return;
  j.status = "failed"; j.error = "Timed out – the page didn't finish posting";
  await setJobs(jobs);
  const s = await getSettings();
  if (s.queueCloseTabs && j.tabId) { try { await chrome.tabs.remove(j.tabId); } catch (_) {} }
}

async function jobForUrl(url, tabId) {
  const jobs = await getJobs();
  const m = (url || "").match(/\/status\/(\d+)/);
  const isCompose = /\/compose\/post/.test(url || "");
  const j = jobs.find((x) => x.status === "posting" && (tabId == null || x.tabId === tabId || x.tabId == null) &&
    ((m && x.kind === "reply" && x.statusId === m[1]) || (isCompose && x.kind === "post")));
  return j || null;
}

async function jobResult({ id, ok, error }) {
  const jobs = await getJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  j.status = ok ? "done" : "failed";
  j.error = ok ? "" : (error || "Unknown error");
  j.doneAt = Date.now();
  await setJobs(jobs);
  chrome.alarms.clear("jobtimeout:" + id);
  if (ok && j.statusId) await markReplied([j.statusId]);
  const s = await getSettings();
  if (s.queueCloseTabs && j.tabId) {
    setTimeout(async () => { try { await chrome.tabs.remove(j.tabId); } catch (_) {} }, ok ? 2500 : 8000);
  }
}

/* ============================ Autopilot (Background Feed Scanner) ============================ */

async function updateAutopilotState(patch) {
  const s = await getSettings();
  const next = { ...s.autopilotState, ...patch };
  await chrome.storage.local.set({ autopilotState: next });
  return next;
}

async function toggleAutopilot(enabled) {
  const s = await getSettings();
  const next = typeof enabled === "boolean" ? enabled : !s.autopilotEnabled;
  await chrome.storage.local.set({ autopilotEnabled: next });
  await syncAutomationAlarms();
  const state = await updateAutopilotState({
    status: next ? "idle" : "paused",
    lastResult: next ? "Autopilot enabled – scheduled for background scanning" : "Autopilot paused"
  });
  return { autopilotEnabled: next, autopilotState: state };
}

async function startAutopilotScan({ force = false } = {}) {
  const s = await getSettings();
  if (!s.autopilotEnabled && !force) return { started: false, reason: "Autopilot is disabled" };
  const key = s.keys[s.provider];
  if (!key) {
    const state = await updateAutopilotState({ status: "waiting", lastResult: `Add a ${PROVIDER_NAMES[s.provider]} API key in settings to start` });
    return { started: false, reason: state.lastResult, autopilotState: state };
  }
  if (!force && !isWithinActiveHours(s)) {
    const state = await updateAutopilotState({
      status: "sleeping",
      lastResult: `Outside active hours (${s.autopilotStartHour}:00–${s.autopilotEndHour}:00)`
    });
    return { started: false, reason: state.lastResult, autopilotState: state };
  }
  const daily = getDailyStats(s.jobs || [], s);
  if (!force && daily.remainingToday <= 0) {
    const state = await updateAutopilotState({
      status: "capped",
      lastResult: `Daily cap reached (${daily.totalToday}/${daily.cap} replies today)`
    });
    return { started: false, reason: state.lastResult, autopilotState: state };
  }

  const { autopilotScanJob } = await chrome.storage.local.get("autopilotScanJob");
  if (autopilotScanJob && autopilotScanJob.status === "running" && Date.now() - (autopilotScanJob.startedAt || 0) < 180_000) {
    return { started: false, reason: "A background scan is already running", autopilotState: s.autopilotState };
  }

  const sources = parseAutopilotSources(s.autopilotSources);
  const idx = (s.autopilotSourceIndex || 0) % sources.length;
  const sourceUrl = sources[idx];
  const maxDrafts = force ? Number(s.autopilotPerRun || 5) : Math.min(Number(s.autopilotPerRun || 5), daily.remainingToday);

  const scanJob = {
    id: uid(),
    url: sourceUrl,
    maxDrafts: Math.max(1, maxDrafts),
    scrolls: Math.max(1, Math.min(10, Number(s.autopilotScrolls || 3))),
    status: "running",
    startedAt: Date.now(),
    tabId: null
  };

  await chrome.storage.local.set({ autopilotScanJob: scanJob, autopilotSourceIndex: idx + 1 });
  const state = await updateAutopilotState({
    status: "scanning",
    lastRunAt: Date.now(),
    lastResult: `Scanning ${sourceUrl}…`
  });

  try {
    const tab = await chrome.tabs.create({ url: sourceUrl, active: false });
    scanJob.tabId = tab.id;
    await chrome.storage.local.set({ autopilotScanJob: scanJob });
    chrome.alarms.create("autopilot:timeout", { when: Date.now() + 180_000 });
    return { started: true, scanJob, autopilotState: state };
  } catch (e) {
    scanJob.status = "failed";
    await chrome.storage.local.set({ autopilotScanJob: scanJob });
    const errState = await updateAutopilotState({ status: "error", lastResult: "Couldn't open scan tab: " + e.message });
    return { started: false, reason: e.message, autopilotState: errState };
  }
}

async function autopilotForTab(tabId) {
  if (tabId == null) return null;
  const { autopilotScanJob } = await chrome.storage.local.get("autopilotScanJob");
  if (autopilotScanJob && autopilotScanJob.status === "running" && autopilotScanJob.tabId === tabId) {
    return autopilotScanJob;
  }
  return null;
}

async function autopilotComplete({ id, ok, found = 0, scheduled = 0, error, sourceUrl }) {
  const { autopilotScanJob } = await chrome.storage.local.get("autopilotScanJob");
  if (!autopilotScanJob || (id && autopilotScanJob.id !== id)) return;
  autopilotScanJob.status = ok ? "done" : "failed";
  await chrome.storage.local.set({ autopilotScanJob, lastAutopilotAt: Date.now() });
  chrome.alarms.clear("autopilot:timeout");

  await updateAutopilotState({
    status: ok ? "idle" : "error",
    lastRunAt: Date.now(),
    lastResult: ok
      ? (scheduled > 0 ? `Scheduled ${scheduled} repl${scheduled === 1 ? "y" : "ies"} (from ${found} new posts)` : `Scanned ${found} posts – nothing new to schedule`)
      : `Scan failed: ${error || "unknown error"}`
  });

  const s = await getSettings();
  if (s.queueCloseTabs && autopilotScanJob.tabId) {
    setTimeout(async () => { try { await chrome.tabs.remove(autopilotScanJob.tabId); } catch (_) {} }, 2200);
  }
}

async function timeoutAutopilot() {
  const { autopilotScanJob } = await chrome.storage.local.get("autopilotScanJob");
  if (!autopilotScanJob || autopilotScanJob.status !== "running") return;
  autopilotScanJob.status = "failed";
  await chrome.storage.local.set({ autopilotScanJob });
  await updateAutopilotState({ status: "error", lastResult: "Background scan timed out" });
  const s = await getSettings();
  if (s.queueCloseTabs && autopilotScanJob.tabId) {
    try { await chrome.tabs.remove(autopilotScanJob.tabId); } catch (_) {}
  }
}

/* ============================ Automated Voice Learning & Analysis ============================ */

async function startAutoLearn({ force = false } = {}) {
  const s = await getSettings();
  if (!s.autoLearnEnabled && !force) return { started: false, reason: "Auto-learn is disabled" };
  const handle = (s.handle || "").trim().replace(/^@/, "");
  if (!handle) return { started: false, reason: "No X handle set yet – open X or enter your handle in settings" };

  const { autoLearnJob } = await chrome.storage.local.get("autoLearnJob");
  if (autoLearnJob && autoLearnJob.status === "running" && Date.now() - (autoLearnJob.startedAt || 0) < 240_000) {
    return { started: false, reason: "Voice learning is already running in a background tab" };
  }

  const job = {
    id: uid(),
    handle,
    status: "running",
    startedAt: Date.now(),
    tabId: null
  };
  await chrome.storage.local.set({ autoLearnJob: job });
  await updateAutopilotState({ status: "learning", lastResult: `Learning voice from @${handle}…` });

  try {
    const tab = await chrome.tabs.create({ url: `https://x.com/${handle}`, active: false });
    job.tabId = tab.id;
    await chrome.storage.local.set({ autoLearnJob: job });
    chrome.alarms.create("autolearn:timeout", { when: Date.now() + 240_000 });
    return { started: true, job };
  } catch (e) {
    job.status = "failed";
    await chrome.storage.local.set({ autoLearnJob: job });
    return { started: false, reason: e.message };
  }
}

async function autoLearnForTab(tabId) {
  if (tabId == null) return null;
  const { autoLearnJob } = await chrome.storage.local.get("autoLearnJob");
  if (autoLearnJob && autoLearnJob.status === "running" && autoLearnJob.tabId === tabId) {
    return autoLearnJob;
  }
  return null;
}

async function autoLearnComplete({ id, posts = 0, replies = 0, error } = {}) {
  const { autoLearnJob } = await chrome.storage.local.get("autoLearnJob");
  const wasBackgroundJob = autoLearnJob && (!id || autoLearnJob.id === id);
  if (wasBackgroundJob) {
    autoLearnJob.status = error ? "failed" : "done";
    await chrome.storage.local.set({ autoLearnJob });
    chrome.alarms.clear("autolearn:timeout");
    const sClose = await getSettings();
    if (sClose.queueCloseTabs && autoLearnJob.tabId) {
      setTimeout(async () => { try { await chrome.tabs.remove(autoLearnJob.tabId); } catch (_) {} }, 2000);
    }
  }

  await chrome.storage.local.set({ lastLearnedAt: Date.now() });
  const s = await getSettings();
  let analyzedCount = 0;

  if (s.scrapedSamples.length >= 5) {
    // Apply quick local quantitative traits first if styleNotes is empty
    if (s.autoApplyTraits && !s.styleNotes.trim()) {
      const localRules = quickLocalRules(s.scrapedSamples);
      if (localRules.length) {
        s.styleNotes = mergeStyleRules(s.styleNotes, localRules);
        await chrome.storage.local.set({ styleNotes: s.styleNotes });
      }
    }
    // Automatically run AI voice analysis if enabled and API key is available
    if (s.autoAnalyzeVoice && s.keys[s.provider]) {
      try {
        await updateAutopilotState({ status: "analyzing", lastResult: "Analysing voice samples with AI…" });
        const res = await analyzeVoice();
        const aiChips = res.traits.map((t) => ({ rule: t.rule, why: t.why ? "AI: " + t.why : "AI" }));
        analyzedCount = aiChips.length;
        const updates = { aiTraits: aiChips };
        if (s.autoApplyTraits) {
          updates.styleNotes = mergeStyleRules(s.styleNotes, aiChips);
        }
        await chrome.storage.local.set(updates);
      } catch (_) {}
    }
  }

  await updateAutopilotState({
    status: "idle",
    lastResult: `Voice learned (${s.scrapedSamples.length} samples${analyzedCount ? `, ${analyzedCount} AI style rules applied` : ""})`
  });

  // If Autopilot is enabled and hasn't scanned yet, trigger first scan shortly
  const fresh = await getSettings();
  if (fresh.autopilotEnabled && fresh.keys[fresh.provider] && !fresh.lastAutopilotAt) {
    chrome.alarms.create("autopilot:scan", {
      when: Date.now() + 10_000,
      periodInMinutes: Math.max(5, Number(fresh.autopilotIntervalMinutes) || 60)
    });
  }

  return { sampleCount: s.scrapedSamples.length, analyzedCount };
}

async function timeoutAutoLearn() {
  const { autoLearnJob } = await chrome.storage.local.get("autoLearnJob");
  if (!autoLearnJob || autoLearnJob.status !== "running") return;
  autoLearnJob.status = "failed";
  await chrome.storage.local.set({ autoLearnJob });
  await updateAutopilotState({ status: "idle", lastResult: "Auto-learn voice timed out" });
  const s = await getSettings();
  if (s.queueCloseTabs && autoLearnJob.tabId) {
    try { await chrome.tabs.remove(autoLearnJob.tabId); } catch (_) {}
  }
}

async function maybePeriodicAutoLearn() {
  const s = await getSettings();
  if (!s.autoLearnEnabled || !s.handle) return;
  const intervalMs = Math.max(1, Number(s.autoLearnIntervalDays || 7)) * 86400_000;
  if (!s.scrapedSamples.length || Date.now() - (s.lastLearnedAt || 0) >= intervalMs) {
    await startAutoLearn({ force: false });
  }
}

/* ============================ Alarms & Lifecycle ============================ */

async function syncAutomationAlarms() {
  try {
    const s = await getSettings();
    const alarms = await chrome.alarms.getAll();
    const byName = new Map(alarms.map((a) => [a.name, a]));

    if (s.autopilotEnabled) {
      const period = Math.max(5, Number(s.autopilotIntervalMinutes) || 60);
      const existing = byName.get("autopilot:scan");
      if (!existing || existing.periodInMinutes !== period) {
        const firstDelayMs = !s.lastAutopilotAt && s.keys[s.provider] && s.scrapedSamples.length > 0 ? 15_000 : period * 60_000;
        chrome.alarms.create("autopilot:scan", { when: Date.now() + firstDelayMs, periodInMinutes: period });
      }
    } else {
      chrome.alarms.clear("autopilot:scan");
    }

    if (s.autoLearnEnabled) {
      if (!byName.has("autolearn:check")) {
        chrome.alarms.create("autolearn:check", { delayInMinutes: 30, periodInMinutes: 360 });
      }
      if (s.handle && s.scrapedSamples.length === 0 && !s.lastLearnedAt && !byName.has("autolearn:initial")) {
        chrome.alarms.create("autolearn:initial", { when: Date.now() + 4000 });
      }
    } else {
      chrome.alarms.clear("autolearn:check");
      chrome.alarms.clear("autolearn:initial");
    }
  } catch (_) {}
}

chrome.storage.onChanged.addListener((changes) => {
  const watched = ["autopilotEnabled", "autopilotIntervalMinutes", "autoLearnEnabled", "handle", "keys", "provider"];
  if (watched.some((k) => k in changes)) {
    syncAutomationAlarms();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("job:")) runJob(alarm.name.slice(4));
  else if (alarm.name.startsWith("jobtimeout:")) timeoutJob(alarm.name.slice(11));
  else if (alarm.name === "autopilot:scan") startAutopilotScan({ force: false });
  else if (alarm.name === "autopilot:timeout") timeoutAutopilot();
  else if (alarm.name === "autolearn:check" || alarm.name === "autolearn:initial") maybePeriodicAutoLearn();
  else if (alarm.name === "autolearn:timeout") timeoutAutoLearn();
});

// On worker start-up, restore scheduled job alarms and automation alarms
(async () => {
  try {
    const jobs = await getJobs();
    const alarms = await chrome.alarms.getAll();
    const names = new Set(alarms.map((a) => a.name));
    let changed = false;
    for (const j of jobs) {
      if (j.status === "scheduled" && !names.has("job:" + j.id)) chrome.alarms.create("job:" + j.id, { when: Math.max(Date.now() + 5000, j.dueAt) });
      if (j.status === "posting" && Date.now() - (j.startedAt || 0) > 3 * 60_000) { j.status = "failed"; j.error = "Browser was closed while posting"; changed = true; }
    }
    if (changed) await setJobs(jobs);
    await syncAutomationAlarms();
  } catch (_) {}
})();

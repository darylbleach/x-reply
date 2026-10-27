// X Reply Coach – background service worker
// All AI provider calls happen here so API keys never touch the page context.

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
  oneClick: false
};

const PROVIDER_NAMES = { claude: "Claude", openai: "ChatGPT (OpenAI)", gemini: "Google Gemini", grok: "Grok (xAI)" };

async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  return {
    ...DEFAULTS,
    ...stored,
    models: { ...DEFAULTS.models, ...(stored.models || {}) },
    keys: { ...DEFAULTS.keys, ...(stored.keys || {}) }
  };
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    GENERATE: () => generate(msg.payload).then((suggestions) => ({ ok: true, suggestions })),
    ANALYZE_VOICE: () => analyzeVoice().then((r) => ({ ok: true, ...r })),
    LIST_MODELS: () => listModels(msg.payload).then((models) => ({ ok: true, models })),
    SAVE_SAMPLES: () => saveSamples(msg.payload).then((total) => ({ ok: true, total })),
    GET_SETTINGS: () =>
      getSettings().then((s) => {
        const { keys, scrapedSamples, aiTraits, modelCache, ...safe } = s;
        safe.hasKey = !!keys[s.provider];
        safe.sampleCount = scrapedSamples.length;
        return { ok: true, settings: safe };
      }),
    OPEN_OPTIONS: async () => { chrome.runtime.openOptionsPage(); return { ok: true }; }
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
  add: "ADD VALUE – contribute something concrete: a tip, a fact, a related experience, a specific observation about what they said.",
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
    `Write exactly ${count} reply options. Each must be under ${s.maxChars} characters.`,
    "Sound exactly like the user. Not like an assistant, a brand account, or a LinkedIn post.",
    "Never open with praise filler ('Great post', 'Love this', 'This is so true', 'Absolutely'). Never start with the other person's name or handle.",
    "No preamble, no quotation marks around replies, no numbering inside the text, never mention being an AI.",
    "Be specific to THIS post – reference what they actually said. Generic encouragement is a failure.",
    "Don't repeat the post back to them. Don't summarise it. React to it.",
    "No corporate or AI-flavoured words: delve, leverage, game-changer, resonate, journey, unlock, elevate, folks, 'in today's world', 'at the end of the day'.",
    "Avoid em dashes unless the user's examples use them. Avoid tidy three-item lists.",
    "Replies must each take a different angle (below). Don't produce three variations of the same idea.",
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

// No sampling params are sent: current models from several providers reject
// `temperature`, and variety is handled in the prompt.
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

# X Reply Autopilot (v3.0 — Fully Automated)

**A Chrome / Dia extension that suggests, schedules, and posts replies on X in your own voice — on demand or on full hands-free Autopilot.**

Open a post to get instant replies written in your voice, batch-queue a feed with one click, or turn on **🤖 Autopilot** so the extension periodically opens your Home feed (or custom X lists/searches) in a background tab, learns your voice, drafts replies in your style, and schedules them within your active hours and daily limits.

Nothing runs on anyone else's server. The extension talks directly from your browser to the AI provider you choose (Claude, ChatGPT, Gemini, or Grok). No account, no subscription, no data collection.

---

## Contents

- [What it does](#what-it-does)
- [Full Automation & Autopilot](#full-automation--autopilot)
- [How it works](#how-it-works)
- [Installing](#installing)
- [Setting up](#setting-up)
- [Using it every day](#using-it-every-day)
- [Queue mode](#queue-mode)
- [Settings reference](#settings-reference)
- [Privacy and what gets sent where](#privacy-and-what-gets-sent-where)
- [Costs](#costs)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [Known limitations](#known-limitations)

---

## What it does

- **Full Background Autopilot.** Periodically opens your X Home feed (and/or custom X lists, searches, or profiles) in a background tab, scrolls to collect candidate posts, drafts replies in your voice, and automatically schedules them across your spread window.
- **Automated Voice Learning & AI Analysis.** Automatically detects your `@handle` when you visit X, scrapes your Posts and Replies in the background, runs both local and AI style analysis, and applies the discovered voice rules directly to your style notes.
- **Smart Pacing & Guardrails.** Enforces a daily reply cap, active hours window (e.g. 08:00–22:00 local time), randomized human-like gaps between replies, and natural reading/review pauses before posting.
- **Auto-suggests replies on open.** On any post page or reply pop-up, replies are generated automatically as soon as the composer appears (configurable).
- **Writes in your voice.** Reads your own timeline — posts and replies — and uses them as examples every time it writes. The result follows your sentence length, punctuation habits, humour, warmth, favourite words and the things you never say.
- **Adjusts on the fly.** Under every set of suggestions: Shorter, Funnier, More direct, Warmer, Ask a question, Personal angle, Again.
- **Inserts or posts in one click.** **Use** drops a reply into the box for you to edit and send. Optional **Use & post** mode inserts and presses Reply for you.
- **Works with four providers.** Claude (Anthropic), ChatGPT (OpenAI), Gemini (Google), Grok (xAI). Model lists are pulled live from each provider's API, so new models appear as soon as they're released.

---

## Full Automation & Autopilot

Version 3.0 adds complete end-to-end automation under the **🤖 Autopilot** tab in Settings (and via the live toggle inside the **📋 Queue replies** drawer on X):

1. **Zero-click setup (`Auto-detect handle` + `Auto-learn voice`)**
   - Visit `x.com` while logged in and the extension automatically detects your `@handle` from the navigation bar.
   - Once an API key and handle are present, the background worker automatically opens your profile in a background tab, scrolls your Posts and Replies to collect samples, runs AI voice analysis, and merges your signature style rules into **Style notes** — refreshing automatically on your chosen schedule (default: every 7 days).
2. **Background Feed Scanning (`Autopilot`)**
   - Add one or more feed URLs in Settings → **🤖 Autopilot** (defaults to `https://x.com/home`; also supports X Lists like `https://x.com/i/lists/123456`, searches like `https://x.com/search?q=...&f=live`, or specific profiles).
   - Every N minutes (default: 30 min), Autopilot rotates to the next feed URL in a background tab, scrolls the feed, filters out ads/reposts/old/short/already-replied posts, drafts replies in your voice, and either auto-approves & schedules them (`Auto-approve and schedule`) or places them in your Queue drawer for review.
3. **Smart Pacing & Guardrails**
   - **Daily reply cap**: Stops scanning and scheduling once you hit your daily maximum (e.g. 25 replies/day).
   - **Active hours window**: Only runs scans and schedules replies inside your active hours (e.g. 08:00–22:00 local time). Any job that would land outside active hours is automatically shifted to the next active window.
   - **Minimum gap & jitter**: Spaces every scheduled reply by at least your minimum gap (e.g. 120 seconds) plus random jitter, and simulates human reading/review pauses before typing and pressing Reply.

---

## How it works

The extension has three parts.

### 1. Content script (runs on x.com)

Injected into every X page. It watches the page for a reply composer (X's `tweetTextarea_0` editor) and adds the suggestion panel underneath it. When you press **Suggest replies** it reads:

- the post you're replying to (text, author),
- up to six earlier posts in the thread, for context,
- anything you've already typed in the reply box, as a draft hint,

and sends that to the background worker. When a suggestion comes back and you press **Use**, it inserts the text into X's editor using a synthetic paste event (X's editor is Draft.js, which handles a paste exactly once – other insertion methods can duplicate the text).

On your own profile page the same script shows the floating **🎙 Learn my voice** button. Pressing it scrolls your Posts tab, then switches to your Replies tab and scrolls that too, collecting the text of everything you wrote. It checks the author handle on every post so only your words are kept; reposts are skipped, and other people's posts shown above your replies are ignored. Samples are saved to extension storage with a timestamp and whether they were a post or a reply.

### 2. Background service worker

Holds the API keys and does all the network calls, so keys never touch the page. For each request it builds a prompt from:

- hard rules (length, no praise-filler openers, no AI-flavoured vocabulary, be specific to the post, one angle per option, your hashtag/emoji/product guard rails),
- the angle list you've enabled,
- your style notes,
- up to ~9,000 characters of your real samples, replies first because that's what it's writing,
- the post, thread context, draft and any adjustment you pressed.

It asks for a JSON array of replies and parses it defensively (code fences, numbered lists and stray quotes are all handled). It also strips any praise opener the model slips in and trims anything wildly over the length limit.

The same worker handles **Analyse with AI** (sends your samples, asks for 8–14 concrete style rules with evidence) and fetches live model lists from each provider.

### 3. Settings page

A four-section page (AI provider, Your voice, Suggestions, How it works) with everything below. It also runs a local, instant analysis of your samples – no API call – to produce the style chips: median length, emoji and hashtag rates, British phrasing, question and exclamation frequency, lowercase openers, final full stops, dashes, line breaks, links, first-person habit, signature words and common openers.

---

## Installing

Works in any Chromium browser: Chrome, Dia, Arc, Brave, Edge, Vivaldi.

1. Download `x-reply-autopilot.zip` (or clone this repo) and unzip it somewhere you'll keep it. The browser loads the extension from that folder, so don't delete it afterwards.
2. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Dia: `dia://extensions`
   - Others: Menu → Extensions → Manage extensions
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and choose the `x-reply-autopilot` folder (the one containing `manifest.json`).
5. The settings page opens automatically on first install. Later, click the extension's icon in the toolbar to open it.

**Updating:** replace the folder contents with the new version, press the reload arrow on the extension's card, then refresh any open X tabs. (If you skip the refresh, the X tab keeps running the old script and the panel will tell you to refresh.)

---

## Setting up

Takes about five minutes.

### Step 1 – AI provider

Pick one provider and paste its API key. Where to get one:

| Provider | Where | Key starts with |
|---|---|---|
| Claude (Anthropic) | console.anthropic.com → API keys | `sk-ant-` |
| ChatGPT (OpenAI) | platform.openai.com → API keys | `sk-` |
| Gemini (Google) | aistudio.google.com → Get API key | `AIza` |
| Grok (xAI) | console.x.ai → API keys | `xai-` |

As soon as you paste a key the **Model** dropdown fills with the live list from that provider (↻ reloads it). A cheaper, faster model is fine for this job – replies are short. Press **Run test** to see three sample replies and confirm the key works.

You can store keys for all four and switch between them any time; only the selected provider is used.

### Step 2 – Your handle

Under **Your voice**, enter your X handle (with or without the @) and choose how far back to learn: everything, the last 3/6/9/12 months, or a specific date. Recent is usually better – your voice drifts.

Press **Save**.

### Step 3 – Learn your voice

Press **Open my profile on X**. At the bottom of your profile there's a floating blue **🎙 Learn my voice** button. Press it.

It scrolls through your Posts, then clicks over to your Replies tab and scrolls through those. The button shows a running count. It stops when it reaches your cut-off date, runs out of new posts, or you press it again. A few hundred samples is plenty.

If you hadn't saved a handle yet, visiting any profile shows a grey **Use @handle as my handle** button instead – one click sets it.

### Step 4 – Style notes (optional but worth it)

Back in settings the **Style notes** section now shows chips generated from your samples, each with the evidence. Click any to add it as a rule; click again to remove it. Below that is a row of common rules, and **✨ Analyse with AI** asks your chosen model for a deeper set. The textbox is free text – add anything: "Never use 'folks'", "Only mention my app if someone asks about hospital appointments", "Dry, not silly".

Rules you write take priority over anything the model infers from samples.

---

## Using it every day

1. Open a post on X – click into it, or press the reply icon on one in your feed (that opens the pop-up, which works too).
2. Under the reply box, press **✨ Suggest replies**. Three options appear in a few seconds.
3. Pick one:
   - **Use** – inserts it into the reply box. Edit if you like, press Reply.
   - **Copy** – copies to clipboard.
   - The number on the right is the character count; it turns red over 280.
4. Not quite right? Press an adjustment under the list – **Shorter**, **Funnier**, **More direct**, **Warmer**, **Ask a question**, **Personal angle** – or **↻ Again** for a fresh set.

If you've already started typing before pressing Suggest, your draft is sent as a hint and every option builds on it.

Suggestions for a post are cached while the tab is open, so reopening the same post doesn't cost another API call; adjustments and Again always generate fresh.

### One-click posting

Settings → Suggestions → **Post immediately when I click Use**. The button becomes **Use & post**: it inserts the reply and presses X's Reply button. Each card keeps an **Edit** button that only inserts. This is off by default because there's no review step – whatever you click goes out under your name.

---

## Queue mode

For when you want to reply to a lot of posts in one sitting without sending them all in one burst.

1. On Home, a list, search results or someone's profile, press the floating **📋 Queue replies** button. A drawer opens on the right.
2. **Scan this page** drafts one reply for each post currently on screen (up to the batch size in settings). It skips ads, reposts, your own posts, very short posts, posts older than your limit, and anything you've already replied to through the queue.
3. Review each card: edit the text, **Approve**, **Skip**, or **↻** for a different angle. Keyboard: **A** approve, **S** skip, **R** redo – focus moves to the next card automatically. Scroll the feed and scan again to add more.
4. Pick a spread window (15 minutes to 8 hours) and press **Schedule N approved**. Each reply gets a random time inside that window, at least 90 seconds apart from any other.
5. The **Scheduled** tab shows what's queued with a countdown, plus **Post now** and **Cancel**. Finished and failed ones stay listed until you clear them, with the reason if something failed.

When a reply is due, the extension opens the post in a background tab, types the reply, presses Reply, waits for X's confirmation, and closes the tab. The browser needs to be open; if it was closed at the time, the job runs when the browser is next opened. If X didn't confirm within 90 seconds the job is marked failed and you can retry it.

**Compose** does the same for your own posts: write it, pick "random time in the next hour / 4 hours / later today / tomorrow" or a specific time, and it goes out then.

Nothing is ever sent that you haven't seen and approved. The scan drafts; you decide.

## Settings reference

### AI provider
- **Provider** – which one writes the replies. Only the selected one is called.
- **API key** – stored in extension storage in this browser only.
- **Model** – live list from the provider; ↻ to refresh. If a saved model disappears from the list it stays selectable, marked "(saved)".
- **Run test** – saves, then generates replies to a sample post.

### Queue mode
- **Posts per scan** – 5 to 25. Each draft is one API call.
- **Default spread window** – where approved replies' random times land.
- **Skip posts shorter than / older than** – filters for the scan.
- **Close the background tab after posting** – untick to leave failed ones open to see what happened.

### Your voice
- **X handle** – identifies your posts during learning.
- **How far back to learn** – everything, 3/6/9/12 months, or a date. Changing this doesn't delete samples already learned; use **Clear samples** first if you want a clean slate.
- **Learned samples** – count, replies vs posts, date range, and a preview of the newest 200.
- **Style notes** – rules the model must follow. Chips from local analysis, chips from AI analysis, common rules, and free text.
- **Extra samples** – paste writing from elsewhere (newsletters, LinkedIn, emails). Separate samples with a blank line. These are used ahead of learned samples.

### Suggestions
- **Number of suggestions** – 2 to 5.
- **Max length** – Punchy 140 / Normal 240 / Full 280 / Long 1000 (for Premium accounts).
- **Mix of angles** – which angles the set should cover. One angle per option, in order.
- **One-click posting** – see above.
- **Guard rails**
  - *Never mention my own products unless the post is clearly about that topic* – on by default; stops the model turning every reply into a plug.
  - *Never use emoji, even if my samples do*
  - *Never use hashtags* – on by default.
  - *Build on my draft* – on by default.

---

## Privacy and what gets sent where

- **API keys** are stored in `chrome.storage.local`, which lives in your browser profile on your machine. They're only ever sent in the request headers to the provider they belong to.
- **Voice samples** are stored the same way. They're sent to your chosen provider as part of every suggestion request (that's how it knows your voice) and when you press Analyse with AI.
- **Each suggestion** sends: the post you're replying to, up to six earlier posts in the thread, your draft, your style notes, your samples, and the adjustment if any.
- **Nothing** is sent to the author of this extension or any third party. There is no analytics, no telemetry, no server.
- **Nothing is posted** unless you press Use with one-click posting turned on, or approve it in Queue mode.
- Clearing samples in settings deletes them immediately. Removing the extension deletes everything.

---

## Costs

You pay your provider directly, per request. Each suggestion sends roughly 3–5k tokens of input (mostly your samples) and gets back under 200 tokens. On a current "fast" tier model that's a fraction of a penny per press. The model list in settings lets you pick a cheaper model without leaving the page.

---

## Troubleshooting

**The Suggest button doesn't appear.**
Refresh the X tab after installing or updating. Check the extension is enabled and that site access includes x.com (extension details → Site access). It only appears where there's a reply box: post pages and the reply pop-up, not the Home timeline.

**"X Reply Autopilot was updated – refresh this page."**
You reloaded the extension while this tab was open. Refresh the tab.

**Learn my voice button doesn't appear.**
It only shows on your own profile (`x.com/yourhandle`) once a handle is saved. If you're on your profile and see a grey "Use @… as my handle" button instead, press it.

**Gemini: "Requests to this API … ListModels are blocked."**
Your Google API key has API restrictions that block listing models; generation still works. Either pick a model from the built-in list, or in Google Cloud Console → Credentials → your key → API restrictions, allow "Generative Language API" (or choose "Don't restrict key") and press ↻.

**"temperature is deprecated for this model."**
Fixed in 1.2.1 – update.

**Use inserts the reply twice.**
Fixed in 1.5.2 – update and refresh the tab.

**Use & post inserted but didn't post.**
X's Reply button wasn't found or was still disabled. Press it yourself. If this is consistent, X has probably changed its button markup – see Known limitations.

**Suggestions sound generic / not like me.**
Learn more samples (especially replies), then add two or three blunt rules in Style notes. "Be specific – no generic encouragement" and a "Never use…" list are the most effective fixes.

---

## Project structure

```
x-reply-autopilot/
├── manifest.json     Manifest V3: permissions, content script, background worker
├── background.js     Provider calls, prompt building, voice analysis, model lists
├── content.js        X page integration: panel, insert/post, voice learner
├── queue.js          Queue mode: scan, review, schedule, compose; job executor
├── content.css       Panel, drawer and button styling on X
├── options.html      Settings page
├── options.css       Settings styling (dark + light)
├── options.js        Settings logic, local voice analysis, chips
└── icons/            16/48/128px icons
```

Permissions requested: `storage` (settings, samples, queue), `alarms` (scheduled posting) and host access to `x.com`, `twitter.com` and the four provider API domains. Nothing else.

The content script keys off X's `data-testid` attributes: `tweet`, `tweetText`, `User-Name`, `tweetTextarea_0`, `toolBar`, `socialContext`, `tweetButton`, `tweetButtonInline`. They're all in the `SEL` object at the top of `content.js`.

---

## Known limitations

- X changes its page markup from time to time. When it does, the selectors above may need updating.
- Learning reads what X renders on your profile. Very old posts may not be reachable by scrolling on large accounts; the lookback window exists partly for this reason.
- Replies in languages other than the ones in your samples will follow the post's language but may lose some of your voice.
- One-click posting relies on X's Reply button being enabled immediately after insert; on slow connections it waits up to two seconds, then asks you to press it yourself.
- Not a Firefox extension (Manifest V3 service worker and host permission handling differ). Chromium browsers only.

---

Built for personal use. Use responsibly – it's your name on the replies.

# X Reply Coach

**A Chrome / Dia extension that suggests replies to posts on X, written in your own voice.**

Open a post, press one button, get three replies that sound like you – not like an AI. Pick one, edit it if you want, send. It learns your voice from the posts and replies you have actually written, and it works with Claude, ChatGPT, Gemini or Grok using your own API key.

Nothing runs on anyone else's server. The extension talks directly from your browser to the AI provider you choose. No account, no subscription, no data collection.

---

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Installing](#installing)
- [Setting up](#setting-up)
- [Using it every day](#using-it-every-day)
- [Settings reference](#settings-reference)
- [Privacy and what gets sent where](#privacy-and-what-gets-sent-where)
- [Costs](#costs)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [Known limitations](#known-limitations)

---

## What it does

- **Suggests replies on demand.** On any post page, or in the reply pop-up, a **✨ Suggest replies** button appears under the reply box. Press it and you get several options, each taking a different angle (add something useful, agree and amplify, ask a question, gentle push-back, a lighter line, a personal note).
- **Writes in your voice.** It reads your own timeline – posts and replies – and uses them as examples every time it writes. The result follows your sentence length, punctuation habits, humour, warmth, favourite words and the things you never say.
- **Lets you tune the voice.** After learning, it analyses your samples and offers clickable style rules with evidence ("No emoji – 0% of samples use one", "Common openers: cheers, honestly"). You can also ask the AI for a deeper analysis, and write your own rules.
- **Adjusts on the fly.** Under every set of suggestions: Shorter, Funnier, More direct, Warmer, Ask a question, Personal angle, Again.
- **Inserts or posts in one click.** **Use** drops a reply into the box for you to edit and send. Optional **Use & post** mode inserts and presses Reply for you.
- **Works with four providers.** Claude (Anthropic), ChatGPT (OpenAI), Gemini (Google), Grok (xAI). Model lists are pulled live from each provider's API, so new models appear as soon as they're released.

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

1. Download `x-reply-coach.zip` (or clone this repo) and unzip it somewhere you'll keep it. The browser loads the extension from that folder, so don't delete it afterwards.
2. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Dia: `dia://extensions`
   - Others: Menu → Extensions → Manage extensions
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and choose the `x-reply-coach` folder (the one containing `manifest.json`).
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

## Settings reference

### AI provider
- **Provider** – which one writes the replies. Only the selected one is called.
- **API key** – stored in extension storage in this browser only.
- **Model** – live list from the provider; ↻ to refresh. If a saved model disappears from the list it stays selectable, marked "(saved)".
- **Run test** – saves, then generates replies to a sample post.

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
- **Nothing is posted** unless you press Use with one-click posting turned on.
- Clearing samples in settings deletes them immediately. Removing the extension deletes everything.

---

## Costs

You pay your provider directly, per request. Each suggestion sends roughly 3–5k tokens of input (mostly your samples) and gets back under 200 tokens. On a current "fast" tier model that's a fraction of a penny per press. The model list in settings lets you pick a cheaper model without leaving the page.

---

## Troubleshooting

**The Suggest button doesn't appear.**
Refresh the X tab after installing or updating. Check the extension is enabled and that site access includes x.com (extension details → Site access). It only appears where there's a reply box: post pages and the reply pop-up, not the Home timeline.

**"X Reply Coach was updated – refresh this page."**
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
x-reply-coach/
├── manifest.json     Manifest V3: permissions, content script, background worker
├── background.js     Provider calls, prompt building, voice analysis, model lists
├── content.js        X page integration: panel, insert/post, voice learner
├── content.css       Panel and button styling on X
├── options.html      Settings page
├── options.css       Settings styling (dark + light)
├── options.js        Settings logic, local voice analysis, chips
└── icons/            16/48/128px icons
```

Permissions requested: `storage` (settings and samples) and host access to `x.com`, `twitter.com` and the four provider API domains. Nothing else.

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

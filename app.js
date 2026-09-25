import Anthropic from './vendor/anthropic.mjs';

// Web search is limited to these outlets. Subdomains are included automatically.
const TRUSTED_SITES = [
  'myjoyonline.com',
  'graphic.com.gh',
  'citinewsroom.com',
  '3news.com',
  'starrfm.com.gh',
  'theghanareport.com',
  'gna.org.gh',
  'ghanaweb.com',
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'bbc.co.uk',
  'aljazeera.com',
  'dw.com',
  'npr.org',
  'theguardian.com',
  'france24.com',
  'cnn.com',
  'africanews.com',
  'cbc.ca',
  'abc.net.au',
  'news.un.org',
];

const LANGUAGE_NAMES = {
  'en-US': 'English', 'en-GB': 'British English', 'fr-FR': 'French', 'es-ES': 'Spanish',
  'pt-PT': 'Portuguese', 'de-DE': 'German', 'ar-SA': 'Arabic', 'sw-KE': 'Swahili',
};

const STORE_KEY = 'dadnews.settings';
const DEFAULTS = { apiKey: '', model: 'claude-sonnet-5', lang: 'en-US', rate: 1, monthlyLimit: 15 };
// Older turns are dropped so follow-up questions stay cheap.
const MAX_HISTORY_MESSAGES = 6;

// USD per million tokens, plus $10 per 1,000 web searches.
const PRICES = {
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
};
const PRICE_PER_SEARCH = 0.01;
const SPEND_KEY = 'dadnews.spend';

const $ = (id) => document.getElementById(id);
const els = {
  talk: $('talk'), status: $('status'), heard: $('heard'),
  setupLink: $('settings-link'), setup: $('setup'), key: $('key'), model: $('model'),
  lang: $('lang'), rate: $('rate'), save: $('save'), test: $('test'), close: $('close'), setupMsg: $('setup-msg'), limit: $('limit'), spent: $('spent'),
};

// ---------- settings ----------

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function storeSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

let settings = loadSettings();

// ---------- speaking ----------

const synth = window.speechSynthesis;
let voice = null;
let pendingUtterances = 0;
let quietWaiters = [];

function pickVoice() {
  const voices = synth.getVoices();
  const lang = settings.lang.toLowerCase();
  const exact = voices.filter((v) => v.lang.toLowerCase().replace('_', '-') === lang);
  const candidates = exact.length ? exact : voices.filter((v) => v.lang.toLowerCase().startsWith(lang.split('-')[0]));
  const score = (v) => (/premium|enhanced|natural|neural|google/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
  voice = candidates.sort((a, b) => score(b) - score(a))[0] || null;
}
pickVoice();
synth.addEventListener?.('voiceschanged', pickVoice);

function cleanForSpeech(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#>`|]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function releaseQuietWaiters() {
  const waiters = quietWaiters;
  quietWaiters = [];
  waiters.forEach((resolve) => resolve());
}

// Speaks one sentence per utterance: long utterances get cut off on some phones.
function say(text) {
  const clean = cleanForSpeech(text);
  if (!clean) return;
  for (const sentence of clean.match(/[^.!?…]+[.!?…]*["')\]]?\s*/g) || [clean]) {
    const u = new SpeechSynthesisUtterance(sentence.trim());
    if (voice) u.voice = voice;
    u.lang = settings.lang;
    u.rate = settings.rate;
    const done = () => {
      pendingUtterances = Math.max(0, pendingUtterances - 1);
      if (!pendingUtterances) releaseQuietWaiters();
    };
    u.onend = done;
    u.onerror = done;
    pendingUtterances++;
    synth.speak(u);
  }
}

function whenQuiet() {
  return pendingUtterances ? new Promise((resolve) => quietWaiters.push(resolve)) : Promise.resolve();
}

function hush() {
  synth.cancel();
  pendingUtterances = 0;
  releaseQuietWaiters();
}

// Buffers streamed text and speaks each finished sentence right away.
function makeSentenceChunker() {
  let buffer = '';
  return {
    push(delta) {
      buffer += delta;
      const boundary = /[.!?…]["')\]]?\s+|\n+/g;
      let cut = -1;
      let m;
      while ((m = boundary.exec(buffer))) cut = m.index + m[0].length;
      if (cut > 0) {
        say(buffer.slice(0, cut));
        buffer = buffer.slice(cut);
      }
    },
    flush() {
      say(buffer);
      buffer = '';
    },
  };
}

// ---------- sound cues ----------

let audioCtx = null;

function beep(freq = 880, ms = 120, volume = 0.15) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const t = audioCtx.currentTime;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000);
  } catch {
    // Sound cues are optional.
  }
}

let tickTimer = null;
function startTicks() {
  stopTicks();
  tickTimer = setInterval(() => beep(520, 60, 0.05), 2500);
}
function stopTicks() {
  clearInterval(tickTimer);
  tickTimer = null;
}

// Phones only allow speech after a tap, so prime it on the first one.
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  synth.speak(new SpeechSynthesisUtterance(''));
  beep(1, 1, 0.0001);
}

// ---------- listening ----------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let micBroken = !Recognition;

function listen() {
  return new Promise((resolve, reject) => {
    const r = new Recognition();
    recognizer = r;
    r.lang = settings.lang;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;

    let finalText = '';
    let interimText = '';
    let silenceTimer = null;
    const hardStop = setTimeout(() => r.stop(), 15000);
    const finish = () => {
      clearTimeout(hardStop);
      clearTimeout(silenceTimer);
      recognizer = null;
      resolve((finalText || interimText).trim());
    };

    r.onresult = (e) => {
      interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      els.heard.textContent = (finalText + interimText).trim();
      // Some phones never end on their own, so stop after a pause in speech.
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => r.stop(), 2000);
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      clearTimeout(hardStop);
      clearTimeout(silenceTimer);
      recognizer = null;
      reject(e.error);
    };
    r.onend = finish;
    r.start();
  });
}

// ---------- state ----------

const STATUS_TEXT = {
  idle: 'Tap anywhere and speak',
  listening: 'Listening…',
  thinking: 'Checking the news…',
  speaking: 'Reading. Tap to interrupt.',
};

let state = 'idle';
function setState(next) {
  state = next;
  document.body.dataset.state = next;
  els.status.textContent = STATUS_TEXT[next];
}

// ---------- Claude ----------

let history = [];
let lastAnswer = '';
let currentStream = null;
let runId = 0;

// ---------- scheduled briefing (made by GitHub Actions, free to replay) ----------

let briefing = null;
let briefingFetchedAt = 0;

// Reads straight from the repo so a new briefing shows up without waiting for GitHub Pages to rebuild.
function briefingUrls() {
  const urls = [];
  const host = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (host) {
    const repo = location.pathname.split('/').filter(Boolean)[0] || location.hostname;
    urls.push(`https://raw.githubusercontent.com/${host[1]}/${repo}/main/briefings/latest.json`);
  }
  urls.push('briefings/latest.json');
  return urls;
}

async function loadBriefing() {
  if (briefing && Date.now() - briefingFetchedAt < 10 * 60_000) return briefing;
  for (const url of briefingUrls()) {
    try {
      const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.text) {
        briefing = data;
        briefingFetchedAt = Date.now();
        return briefing;
      }
    } catch {
      // Try the next location.
    }
  }
  return briefing;
}

function hoursOld(b) {
  return (Date.now() - new Date(b.createdAt).getTime()) / 3600_000;
}

async function playBriefing() {
  const myRun = runId;
  setState('thinking');
  const b = await loadBriefing();
  if (myRun !== runId) return;
  if (!b || hoursOld(b) > 12) {
    // No recent scheduled briefing, so search live instead.
    askClaude('Give me the top political headlines for Ghana and the world.');
    return;
  }
  lastAnswer = b.text;
  speakThenIdle(b.text);
}

// ---------- monthly spending cap for live questions ----------

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function loadSpend() {
  try {
    const s = JSON.parse(localStorage.getItem(SPEND_KEY) || '{}');
    return s.month === currentMonth() ? s : { month: currentMonth(), usd: 0 };
  } catch {
    return { month: currentMonth(), usd: 0 };
  }
}

function recordSpend(model, usage) {
  const p = PRICES[model] || PRICES['claude-sonnet-5'];
  const usd = (
    (usage.input_tokens || 0) * p.input +
    (usage.output_tokens || 0) * p.output +
    (usage.cache_creation_input_tokens || 0) * p.cacheWrite +
    (usage.cache_read_input_tokens || 0) * p.cacheRead
  ) / 1_000_000 + (usage.server_tool_use?.web_search_requests || 0) * PRICE_PER_SEARCH;
  const spend = loadSpend();
  spend.usd = Math.round((spend.usd + usd) * 10000) / 10000;
  try {
    localStorage.setItem(SPEND_KEY, JSON.stringify(spend));
  } catch {
    // The Anthropic Console spend limit still applies.
  }
}

function overMonthlyLimit() {
  return loadSpend().usd >= Number(settings.monthlyLimit || DEFAULTS.monthlyLimit);
}

function systemPrompt() {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const language = LANGUAGE_NAMES[settings.lang] || 'English';
  return `You are the personal news reader for a blind man in Ghana who follows politics closely: Ghanaian politics most of all, then world politics. Everything you write is read aloud by a text-to-speech voice, so write for the ear. Today is ${today}.

How to find news:
- Use web search to find current reporting before answering. Only report what the sources say. If you cannot find something recent, say so plainly rather than guessing.
- Name sources naturally, for example "Reuters reports that..." Never read out web addresses.

How to speak:
- Plain spoken sentences only. No headings, bullet points, numbered lists, symbols, markdown, or emoji.
- Write numbers and abbreviations the way a newsreader would say them.
- Speak in ${language}.

What to give him:
- For headlines or "what's the news": political news only. First three or four trending Ghanaian political stories, then two world political stories. Introduce each one as "Story one", "Story two", and so on, with two or three sentences each. End by reminding him he can ask for more on any story by its number.
- When a question could mean Ghana or elsewhere, assume Ghana.
- Say party names the way Ghanaians do, for example "the N D C" and "the N P P".
- For a follow-up or a specific topic: about 150 to 250 words unless he asks for more detail.
- If his request is unclear, give your best guess at what he meant rather than asking him to repeat it.
- Keep web searches to the minimum needed, usually one.${briefing ? `

The most recent scheduled briefing he heard is below. When he says "story two" or similar, he means the stories in it.

<briefing>
${briefing.text}
</briefing>` : ''}`;
}

function buildParams() {
  const isOpus = settings.model === 'claude-opus-5';
  return {
    model: settings.model,
    max_tokens: 3000,
    system: systemPrompt(),
    messages: history,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2, allowed_domains: TRUSTED_SITES }],
    output_config: { effort: 'low' },
    cache_control: { type: 'ephemeral' },
    // If a request is declined, Anthropic retries it on a fallback model instead.
    ...(isOpus ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
  };
}

function trimHistory() {
  while (history.length > MAX_HISTORY_MESSAGES) history.splice(0, 2);
  while (history.length && history[0].role !== 'user') history.shift();
}

function errorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "The news reader's key is not working. Please ask the family to check the setup.";
  }
  if (err instanceof Anthropic.BadRequestError && /credit|billing/i.test(err.message)) {
    return 'The news account has run out of credit. Please ask the family to add more.';
  }
  if (err instanceof Anthropic.RateLimitError) return 'The news service is busy. Please try again in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return "I can't reach the internet right now. Please check the Wi-Fi and try again.";
  if (err instanceof Anthropic.InternalServerError) return 'The news service is having a problem. Please try again in a few minutes.';
  return 'Sorry, something went wrong. Please try again.';
}

async function askClaude(text) {
  const myRun = ++runId;
  const myMessages = new Set();
  const rollback = () => { history = history.filter((m) => !myMessages.has(m)); };

  if (overMonthlyLimit()) {
    speakThenIdle("This month's budget for questions is used up. The scheduled news will keep playing, and you can still say headlines.");
    return;
  }

  setState('thinking');
  say('One moment.');
  startTicks();

  await loadBriefing();
  if (myRun !== runId) return;
  trimHistory();
  const userMessage = { role: 'user', content: text };
  history.push(userMessage);
  myMessages.add(userMessage);

  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const chunker = makeSentenceChunker();
  let answer = '';

  try {
    // A long search can pause the turn; sending it back lets the server continue.
    for (let hop = 0; hop < 4; hop++) {
      const stream = client.beta.messages.stream(buildParams());
      currentStream = stream;
      stream.on('text', (delta) => {
        if (myRun !== runId) return;
        if (state === 'thinking') {
          stopTicks();
          setState('speaking');
        }
        answer += delta;
        chunker.push(delta);
      });
      const message = await stream.finalMessage();
      recordSpend(settings.model, message.usage);
      if (myRun !== runId) return;

      if (message.stop_reason === 'refusal') {
        rollback();
        answer = "Sorry, I can't help with that one. Try asking another way.";
        say(answer);
        break;
      }

      const last = history[history.length - 1];
      if (last.role === 'assistant' && myMessages.has(last)) {
        last.content = [...last.content, ...message.content];
      } else {
        const assistantMessage = { role: 'assistant', content: message.content };
        history.push(assistantMessage);
        myMessages.add(assistantMessage);
      }
      if (message.stop_reason !== 'pause_turn') break;
    }

    chunker.flush();
    stopTicks();
    lastAnswer = answer;
    if (!answer.trim()) say("Sorry, I couldn't find anything on that. Try asking another way.");
    await whenQuiet();
    if (myRun === runId) {
      setState('idle');
      beep(660, 90, 0.08);
    }
  } catch (err) {
    rollback();
    if (myRun !== runId) return; // Interrupted by a new tap.
    console.error(err);
    stopTicks();
    hush();
    say(errorMessage(err));
    setState('idle');
  } finally {
    if (myRun === runId) currentStream = null;
  }
}

// ---------- commands handled on the phone (no API cost) ----------

function localCommand(text) {
  if (!settings.lang.startsWith('en')) return null;
  const t = text.toLowerCase().replace(/[‘’]/g, "'").replace(/[.!?,]/g, '').trim();
  if (t.length > 40) return null;

  if (/^(stop|quiet|be quiet|pause|enough|that's enough|thank you|thanks)$/.test(t)) {
    return () => say('Okay.');
  }
  if (
    /^((give|read|tell) me )?(the |today's |the latest )?(headlines|news|news headlines|latest news|top stories)( please| today)?$/.test(t) ||
    /^what's (the news|new|happening)( today)?$/.test(t)
  ) {
    return playBriefing;
  }
  if (/^(repeat|repeat that|again|say that again|say it again|what did you say)$/.test(t)) {
    return () => (lastAnswer ? speakThenIdle(lastAnswer) : say("There's nothing to repeat yet."));
  }
  if (/\b(slower|slow down)\b/.test(t)) {
    return () => changeRate(-0.1, "Okay, I'll speak more slowly.");
  }
  if (/\b(faster|speed up)\b/.test(t)) {
    return () => changeRate(0.1, "Okay, I'll speak faster.");
  }
  if (/^(start over|new conversation|clear|forget that)$/.test(t)) {
    return () => { history = []; lastAnswer = ''; say('Okay, starting fresh.'); };
  }
  if (/^(help|what can i say|what can you do)$/.test(t)) {
    return () => speakThenIdle(
      'Tap anywhere and speak. You can say: give me the headlines. What is happening in Parliament. ' +
      'Tell me more about story two. Repeat that. Slower. Or faster. Tap again at any time to interrupt me.',
    );
  }
  return null;
}

function changeRate(delta, confirmation) {
  settings.rate = Math.min(1.5, Math.max(0.5, Math.round((settings.rate + delta) * 100) / 100));
  storeSettings();
  say(confirmation);
}

async function speakThenIdle(text) {
  setState('speaking');
  say(text);
  const myRun = runId;
  await whenQuiet();
  if (myRun === runId) setState('idle');
}

// ---------- tap handling ----------

function cancelAll() {
  runId++;
  currentStream?.abort();
  currentStream = null;
  stopTicks();
  hush();
}

async function onTap() {
  unlockAudio();

  if (!settings.apiKey) {
    say("The news reader isn't set up yet. Please ask a family member to add the key.");
    openSetup();
    return;
  }
  if (state === 'listening') {
    recognizer?.stop();
    return;
  }
  cancelAll();

  if (micBroken) {
    // Without a microphone, a tap reads the headlines.
    els.heard.textContent = '';
    playBriefing();
    return;
  }

  els.heard.textContent = '';
  setState('listening');
  beep(880);
  let text;
  try {
    text = await listen();
  } catch (error) {
    setState('idle');
    if (error === 'not-allowed' || error === 'service-not-allowed' || error === 'audio-capture') {
      micBroken = true;
      say("I can't use the microphone, so for now each tap will read the headlines. Please ask the family to allow microphone access.");
    } else {
      say("Sorry, I didn't catch that. Please tap and try again.");
    }
    return;
  }
  if (state !== 'listening') return;
  if (!text) {
    setState('idle');
    say("I didn't hear anything. Tap and try again.");
    return;
  }
  els.heard.textContent = `"${text}"`;
  const command = localCommand(text);
  if (command) {
    setState('idle');
    command();
    return;
  }
  askClaude(text);
}

els.talk.addEventListener('click', onTap);

// ---------- setup screen ----------

function openSetup() {
  els.key.value = settings.apiKey;
  els.model.value = settings.model;
  els.lang.value = settings.lang;
  els.rate.value = settings.rate;
  els.limit.value = settings.monthlyLimit;
  els.spent.textContent = `Spent on questions this month so far: about $${loadSpend().usd.toFixed(2)}.`;
  els.setupMsg.textContent = '';
  els.setup.hidden = false;
}

function closeSetup() {
  els.setup.hidden = true;
  els.talk.focus();
}

els.setupLink.addEventListener('click', openSetup);
els.close.addEventListener('click', closeSetup);

els.test.addEventListener('click', () => {
  unlockAudio();
  settings.lang = els.lang.value;
  settings.rate = Number(els.rate.value);
  pickVoice();
  hush();
  say('Hello. This is how the news will sound.');
});

els.save.addEventListener('click', async () => {
  const key = els.key.value.trim();
  if (!key.startsWith('sk-ant-')) {
    els.setupMsg.textContent = 'That does not look like a Claude API key. It should start with sk-ant-';
    return;
  }
  settings = { ...settings, apiKey: key, model: els.model.value, lang: els.lang.value, rate: Number(els.rate.value),
    monthlyLimit: Math.max(1, Number(els.limit.value) || DEFAULTS.monthlyLimit) };
  pickVoice();
  if (!storeSettings()) {
    els.setupMsg.textContent = 'Could not save on this phone. Is private browsing turned on?';
    return;
  }
  els.setupMsg.textContent = 'Checking the key…';
  try {
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    await client.models.retrieve(settings.model);
    els.setupMsg.textContent = 'Saved. The key works.';
  } catch (err) {
    console.error(err);
    els.setupMsg.textContent = err instanceof Anthropic.AuthenticationError
      ? 'Saved, but that key was rejected. Please copy it again.'
      : 'Saved, but the key could not be checked (no internet?).';
  }
});

// ---------- start ----------

setState('idle');
loadBriefing();
if (!settings.apiKey) openSetup();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

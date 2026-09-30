const LANGUAGE_NAMES = {
  'en-US': 'English', 'en-GB': 'British English', 'fr-FR': 'French', 'es-ES': 'Spanish',
  'pt-PT': 'Portuguese', 'de-DE': 'German', 'ar-SA': 'Arabic', 'sw-KE': 'Swahili',
};

const STORE_KEY = 'dadnews.settings';
const DEFAULTS = { apiKey: '', lang: 'en-US', rate: 1 };
// Older turns are dropped so follow-up questions stay small.
const MAX_HISTORY_MESSAGES = 6;

// Free-tier models, tried in order. Each has its own daily quota, so when one is used up
// or busy the next is tried. One question is one request, so together they cover far
// more than a day's questions.
const QUESTION_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const COUNT_KEY = 'dadnews.questions';

const $ = (id) => document.getElementById(id);
const els = {
  talk: $('talk'), status: $('status'), heard: $('heard'),
  setupLink: $('settings-link'), setup: $('setup'), key: $('key'),
  lang: $('lang'), rate: $('rate'), save: $('save'), test: $('test'), close: $('close'), setupMsg: $('setup-msg'), used: $('used'),
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

// ---------- Gemini ----------

let history = [];
let lastAnswer = '';
let currentStream = null;
let runId = 0;

// ---------- scheduled briefing (made by GitHub Actions, free to replay) ----------

let briefing = null;
let briefingFetchedAt = 0;

// The latest news items from trusted outlets, saved hourly by GitHub Actions.
// Questions are answered from these, because the free Gemini tier has no Google Search.
let news = null;

// Reads straight from the repo so new files show up without waiting for GitHub Pages to rebuild.
function repoUrls(file) {
  const urls = [];
  const host = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (host) {
    const repo = location.pathname.split('/').filter(Boolean)[0] || location.hostname;
    urls.push(`https://raw.githubusercontent.com/${host[1]}/${repo}/main/briefings/${file}`);
  }
  urls.push(`briefings/${file}`);
  return urls;
}

async function fetchRepoJson(file, isValid) {
  for (const url of repoUrls(file)) {
    try {
      const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) continue;
      const data = await res.json();
      if (isValid(data)) return data;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

async function loadBriefing() {
  if (briefing && Date.now() - briefingFetchedAt < 10 * 60_000) return briefing;
  const [newBriefing, newNews] = await Promise.all([
    fetchRepoJson('latest.json', (d) => d?.text),
    fetchRepoJson('news.json', (d) => Array.isArray(d?.items)),
  ]);
  briefing = newBriefing || briefing;
  news = newNews || news;
  if (newBriefing) briefingFetchedAt = Date.now();
  return briefing;
}

function newsList() {
  const hoursAgo = (iso) => (iso ? ` (${Math.max(0, Math.round((Date.now() - new Date(iso)) / 3600_000))} hours ago)` : '');
  const listFor = (region) => news.items
    .filter((item) => item.region === region)
    .map((item) => `- [${item.source}] ${item.title}${hoursAgo(item.published)}. ${item.summary}`)
    .join('\n') || '(none available)';
  return `GHANA NEWS:\n${listFor('Ghana')}\n\nWORLD NEWS:\n${listFor('World')}`;
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
    // No recent scheduled briefing, so make one from the latest news items.
    askGemini('Give me the top political headlines for Ghana and the world.');
    return;
  }
  lastAnswer = b.text;
  speakThenIdle(b.text);
}

// ---------- free daily quota ----------

// Google resets free quotas at midnight Pacific time.
function quotaDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function quotaResetTime() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, Number(x.value)]));
  const msLeft = ((24 - p.hour) * 3600 - p.minute * 60 - p.second) * 1000;
  return new Date(Date.now() + msLeft).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function questionsToday() {
  try {
    const c = JSON.parse(localStorage.getItem(COUNT_KEY) || '{}');
    return c.day === quotaDay() ? c.count : 0;
  } catch {
    return 0;
  }
}

function countQuestion() {
  try {
    localStorage.setItem(COUNT_KEY, JSON.stringify({ day: quotaDay(), count: questionsToday() + 1 }));
  } catch {
    // Only used for the count shown in Setup.
  }
}

class GeminiError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

function systemPrompt() {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const language = LANGUAGE_NAMES[settings.lang] || 'English';
  return `You are the personal news reader for a blind man in Ghana who follows politics closely: Ghanaian politics most of all, then world politics. Everything you write is read aloud by a text-to-speech voice, so write for the ear. Today is ${today}.

Where the news comes from:
- Use only the news items from trusted outlets below and the briefing. Do not add facts that are not in them, and do not rely on your own memory for current events.
- If the items don't cover what he asked about, say so plainly, for example "The outlets I follow haven't reported on that today", then mention the closest related story if there is one.
- Name sources naturally, for example "The B B C reports that..." Never read out web addresses.

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
- For background questions, like who someone is or what a law does, you may explain briefly from general knowledge, but say that it's background and not today's news.${news ? `

The latest news items (updated ${new Date(news.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}):

<news>
${newsList()}
</news>` : `

The news items could not be loaded, so tell him you can't reach the latest news right now and he should try again in a few minutes.`}${briefing ? `

The most recent scheduled briefing he heard is below. When he says "story two" or similar, he means the stories in it.

<briefing>
${briefing.text}
</briefing>` : ''}`;
}

function buildRequest() {
  return {
    systemInstruction: { parts: [{ text: systemPrompt() }] },
    contents: history,
    // Little thinking, so he hears the answer sooner.
    generationConfig: { maxOutputTokens: 3000, temperature: 0.4, thinkingConfig: { thinkingLevel: 'low' } },
  };
}

function trimHistory() {
  while (history.length > MAX_HISTORY_MESSAGES) history.splice(0, 2);
  while (history.length && history[0].role !== 'user') history.shift();
}

// Streams one answer, passing each piece of text to onText. Resolves with the finish reason.
async function streamAnswer(model, signal, onText) {
  const res = await fetch(`${API}/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.apiKey },
    body: JSON.stringify(buildRequest()),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const reason = data.error?.details?.find((d) => d.reason)?.reason || data.error?.status || '';
    throw new GeminiError(res.status, reason, data.error?.message || res.statusText);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let finishReason = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop();
    for (const event of events) {
      const line = event.split(/\r?\n/).find((l) => l.startsWith('data:'));
      if (!line) continue;
      const chunk = JSON.parse(line.slice(5));
      if (chunk.promptFeedback?.blockReason) return 'BLOCKED';
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts || []) {
        if (part.text && !part.thought) onText(part.text);
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
    }
  }
  return finishReason;
}

function errorMessage(err) {
  if (err instanceof GeminiError) {
    if (err.status === 429) {
      return `The free news service has used up its questions for now. Please try again in a minute. If it keeps saying this, it resets at ${quotaResetTime()}. The headlines still work.`;
    }
    if (err.reason === 'API_KEY_INVALID' || err.status === 401 || err.status === 403) {
      return "The news reader's key is not working. Please ask the family to check the setup.";
    }
    if (err.status >= 500) return 'The news service is having a problem. Please try again in a few minutes.';
  }
  if (err instanceof TypeError) return "I can't reach the internet right now. Please check the Wi-Fi and try again.";
  return 'Sorry, something went wrong. Please try again.';
}

async function askGemini(text) {
  const myRun = ++runId;
  const myMessages = new Set();
  const rollback = () => { history = history.filter((m) => !myMessages.has(m)); };

  setState('thinking');
  say('One moment.');
  startTicks();

  await loadBriefing();
  if (myRun !== runId) return;
  trimHistory();
  const userMessage = { role: 'user', parts: [{ text }] };
  history.push(userMessage);
  myMessages.add(userMessage);

  const chunker = makeSentenceChunker();
  let answer = '';
  const onText = (delta) => {
    if (myRun !== runId) return;
    if (state === 'thinking') {
      stopTicks();
      setState('speaking');
    }
    answer += delta;
    chunker.push(delta);
  };

  try {
    let finishReason = '';
    for (const [i, model] of QUESTION_MODELS.entries()) {
      const controller = new AbortController();
      currentStream = controller;
      try {
        finishReason = await streamAnswer(model, controller.signal, onText);
        break;
      } catch (err) {
        // Busy, out of quota or retired: try the next model, unless this one already started speaking
        // or the key itself is wrong.
        const keyProblem = err.reason === 'API_KEY_INVALID' || err.status === 401 || err.status === 403;
        const canRetry = err instanceof GeminiError && !keyProblem && !answer;
        if (!canRetry || i === QUESTION_MODELS.length - 1) throw err;
      }
    }
    countQuestion();
    if (myRun !== runId) return;

    if (finishReason === 'BLOCKED' || (finishReason === 'SAFETY' && !answer)) {
      rollback();
      answer = "Sorry, I can't help with that one. Try asking another way.";
      say(answer);
    } else if (answer) {
      const reply = { role: 'model', parts: [{ text: answer }] };
      history.push(reply);
      myMessages.add(reply);
    } else {
      rollback();
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
  askGemini(text);
}

els.talk.addEventListener('click', onTap);

// ---------- setup screen ----------

function openSetup() {
  els.key.value = settings.apiKey;
  els.lang.value = settings.lang;
  els.rate.value = settings.rate;
  els.used.textContent = `Questions asked today: ${questionsToday()}. The free limit resets at ${quotaResetTime()}.`;
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
  if (!/^(AIza|AQ\.)\S{20,}$/.test(key)) {
    els.setupMsg.textContent = 'That does not look like a Gemini API key. It should start with AIza or AQ.';
    return;
  }
  settings = { ...settings, apiKey: key, lang: els.lang.value, rate: Number(els.rate.value) };
  pickVoice();
  if (!storeSettings()) {
    els.setupMsg.textContent = 'Could not save on this phone. Is private browsing turned on?';
    return;
  }
  els.setupMsg.textContent = 'Checking the key…';
  try {
    const res = await fetch(`${API}/${QUESTION_MODELS[0]}`, { headers: { 'x-goog-api-key': key } });
    if (res.ok) els.setupMsg.textContent = 'Saved. The key works.';
    else if (res.status === 400 || res.status === 403) els.setupMsg.textContent = 'Saved, but that key was rejected. Please copy it again.';
    else els.setupMsg.textContent = `Saved, but the key could not be checked (error ${res.status}).`;
  } catch (err) {
    console.error(err);
    els.setupMsg.textContent = 'Saved, but the key could not be checked (no internet?).';
  }
});

// ---------- start ----------

setState('idle');
loadBriefing();
if (!settings.apiKey) openSetup();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Builds a spoken news briefing from trusted RSS feeds and saves it to
// briefings/latest.txt (read aloud by the phone) and briefings/latest.json (used by the app).
// Runs hourly on GitHub Actions but only calls Gemini shortly before a time in schedule.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

// Ghanaian outlets come first; a story several of them cover is treated as trending.
const FEEDS = [
  ['Ghana', 'MyJoyOnline', 'https://www.myjoyonline.com/news/politics/feed/'],
  ['Ghana', 'Graphic Online', 'https://www.graphic.com.gh/news/politics.feed?type=rss'],
  ['Ghana', 'Starr FM', 'https://starrfm.com.gh/category/politics/feed/'],
  ['Ghana', '3News', 'https://3news.com/feed/'],
  ['Ghana', 'The Ghana Report', 'https://www.theghanareport.com/category/politics/feed/'],
  ['World', 'BBC News', 'https://feeds.bbci.co.uk/news/world/rss.xml'],
  ['World', 'BBC News Africa', 'https://feeds.bbci.co.uk/news/world/africa/rss.xml'],
  ['World', 'Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml'],
  ['World', 'The Guardian', 'https://www.theguardian.com/world/rss'],
  ['World', 'DW', 'https://rss.dw.com/xml/rss-en-world'],
  ['World', 'France 24', 'https://www.france24.com/en/rss'],
  ['World', 'Africanews', 'https://www.africanews.com/feed/rss'],
];

// Free-tier models, best first. Each model has its own daily quota, so if one is used up,
// busy or retired, the next is tried. A briefing is one request of about 10,000 tokens,
// and 5 a day is far below the free daily limits.
const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const ITEMS_PER_FEED = { Ghana: 15, World: 8 };
const MAX_AGE_HOURS = 18;
// A briefing is made when a reading time is up to 75 minutes ahead (or up to 30 minutes late).
const LOOKAHEAD_MINUTES = 75;
const LATE_MINUTES = 30;

const OUT_DIR = new URL('../briefings/', import.meta.url);
const SCHEDULE_FILE = new URL('../schedule.json', import.meta.url);

// ---------- feeds ----------

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function cleanText(raw) {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(unwrapped).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? cleanText(m[1]) : '';
}

function parseFeed(xml, region, source) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) || [];
  return blocks.map((block) => ({
    region,
    source,
    title: tagText(block, 'title'),
    summary: (tagText(block, 'description') || tagText(block, 'summary')).slice(0, 500),
    published: new Date(tagText(block, 'pubDate') || tagText(block, 'dc:date') || tagText(block, 'updated') || tagText(block, 'published')),
  })).filter((item) => item.title);
}

async function fetchFeed([region, source, url]) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (DadNews briefing)' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cutoff = Date.now() - MAX_AGE_HOURS * 3600_000;
    return parseFeed(await res.text(), region, source)
      .filter((item) => isNaN(item.published) || item.published.getTime() >= cutoff)
      .slice(0, ITEMS_PER_FEED[region]);
  } catch (err) {
    console.warn(`Skipping ${source}: ${err.message}`);
    return [];
  }
}

// ---------- schedule ----------

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function findDueSlot(schedule, now, lastSlot) {
  const here = localParts(now, schedule.timezone);
  for (const time of schedule.times) {
    const [h, m] = time.split(':').map(Number);
    let diff = h * 60 + m - here.minutes;
    if (diff < -LATE_MINUTES) diff += 24 * 60;
    if (diff > LOOKAHEAD_MINUTES) continue;
    const playAt = new Date(now.getTime() + diff * 60_000);
    const slot = `${localParts(playAt, schedule.timezone).date} ${time}`;
    if (slot !== lastSlot) return { slot, playAt };
  }
  return null;
}

// ---------- files ----------

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch {
    return fallback;
  }
}


// ---------- main ----------

const schedule = await readJson(SCHEDULE_FILE, null);
if (!schedule?.timezone || !Array.isArray(schedule.times)) throw new Error('schedule.json needs "timezone" and "times".');

const now = new Date();
const force = process.env.FORCE === 'true';
const dryRun = process.env.DRY_RUN === '1';
const latest = await readJson(new URL('latest.json', OUT_DIR), {});
const due = force
  ? { slot: `manual ${now.toISOString()}`, playAt: now }
  : findDueSlot(schedule, now, latest.slot);

// Every hour, save the latest items so the app can answer questions from them.
// (The free Gemini tier doesn't include Google Search.)
const items = (await Promise.all(FEEDS.map(fetchFeed))).flat();
if (items.length >= 5 && !dryRun) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(new URL('news.json', OUT_DIR), JSON.stringify({
    updatedAt: now.toISOString(),
    items: items.map((item) => ({ ...item, published: isNaN(item.published) ? null : item.published.toISOString() })),
  }, null, 1) + '\n');
}

if (!due) {
  console.log(`Saved ${items.length} news items. No reading time coming up.`);
  process.exit(0);
}
if (items.length < 5) throw new Error(`Only ${items.length} news items could be fetched.`);

const ghanaCount = items.filter((i) => i.region === 'Ghana').length;
if (ghanaCount === 0) console.warn('No Ghanaian feeds could be read this time; the briefing will say so.');

const hoursAgo = (d) => (isNaN(d) ? '' : ` (${Math.max(0, Math.round((now - d) / 3600_000))} hours ago)`);
const listFor = (region) => items
  .filter((item) => item.region === region)
  .map((item) => `- [${item.source}] ${item.title}${hoursAgo(item.published)}. ${item.summary}`)
  .join('\n') || '(none available)';
const itemList = `GHANA NEWS:\n${listFor('Ghana')}\n\nWORLD NEWS:\n${listFor('World')}`;

const playAtWords = due.playAt.toLocaleString('en-US', {
  timeZone: schedule.timezone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const language = schedule.language || 'English';

const system = `You write a spoken political news briefing for a blind man in Ghana who follows politics closely. A text-to-speech voice will read it aloud to him on ${playAtWords}.

What to include:
- Politics only: government, parliament, political parties, elections, the presidency, courts and corruption cases involving public figures, public policy, diplomacy, and conflicts. Skip sport, entertainment, lifestyle, and ordinary crime.
- First, three or four Ghanaian political stories. Pick the ones trending most: a story that several Ghanaian outlets are reporting is being talked about widely, so it comes first. Merge the outlets' reports of the same story into one.
- Then two world political stories, the most significant of the day. Prefer stories about Africa or that affect Ghana when they are equally important.
- If there are fewer than three Ghanaian political stories, say so briefly and use what there is.

How to write:
- Use only the news items provided. Do not add facts that are not in them.
- Write in ${language}. Plain spoken sentences only: no headings, lists, symbols, markdown, or web addresses. Write numbers and abbreviations the way a Ghanaian newsreader would say them, for example "the N D C" and "the N P P".
- Start with one short greeting that suits the time of day and mentions the day. Introduce the Ghana stories with a phrase like "First, the news from home", and the world stories with "Now, around the world".
- Number the stories straight through, "Story one", "Story two", and so on, with two or three sentences each, naming the source naturally.
- End with one sentence telling him he can open Dad News and ask for more about any story by its number.`;

console.log(`Slot ${due.slot}: ${items.length} items from ${new Set(items.map((i) => i.source)).size} feeds, about ${Math.round((system.length + itemList.length) / 4)} input tokens.`);
if (dryRun) {
  console.log(itemList.slice(0, 1500));
  process.exit(0);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('The GEMINI_API_KEY secret is missing.');

// Returns the briefing text, or null when this model is unavailable or out of free quota.
async function generate(model) {
  const res = await fetch(`${API}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: `Here are the latest news items:\n\n${itemList}\n\nWrite the briefing.` }] }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.4, thinkingConfig: { thinkingLevel: 'low' } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error?.message || res.statusText;
    if (res.status === 401 || res.status === 403 || /api key/i.test(message)) throw new Error('The GEMINI_API_KEY secret is wrong.');
    console.warn(`${model} unavailable (${res.status}): ${message.split('\n')[0]}`);
    return null;
  }
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request (${data.promptFeedback.blockReason}); keeping the previous briefing.`);
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error(`Empty briefing from ${model} (finish reason: ${candidate?.finishReason}).`);
  if (candidate.finishReason === 'MAX_TOKENS') console.warn('The briefing hit the length limit and may be cut short.');
  return text;
}

let text = null;
let usedModel = null;
for (const model of MODELS) {
  text = await generate(model);
  if (text) {
    usedModel = model;
    break;
  }
}
if (!text) throw new Error('Every free Gemini model is out of quota right now; keeping the previous briefing.');

const month = localParts(now, schedule.timezone).date.slice(0, 7);
let usage = await readJson(new URL('usage.json', OUT_DIR), {});
if (usage.month !== month) usage = { month, briefings: 0 };
usage.briefings += 1;
usage.lastModel = usedModel;

await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL('latest.txt', OUT_DIR), text + '\n');
await writeFile(new URL('latest.json', OUT_DIR), JSON.stringify({
  slot: due.slot,
  createdAt: now.toISOString(),
  playAt: due.playAt.toISOString(),
  timezone: schedule.timezone,
  language,
  model: usedModel,
  text,
}, null, 2) + '\n');
await writeFile(new URL('usage.json', OUT_DIR), JSON.stringify(usage, null, 2) + '\n');

console.log(`Briefing saved using ${usedModel}; ${usage.briefings} briefings this month.`);

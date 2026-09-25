// Builds a spoken news briefing from trusted RSS feeds and saves it to
// briefings/latest.txt (read aloud by the phone) and briefings/latest.json (used by the app).
// Runs hourly on GitHub Actions but only calls Claude shortly before a time in schedule.json.
import Anthropic from '@anthropic-ai/sdk';
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

const MODEL = 'claude-sonnet-5';
// USD per million tokens for Claude Sonnet 5.
const PRICE = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
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
    summary: (tagText(block, 'description') || tagText(block, 'summary')).slice(0, 300),
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

function costOf(usage) {
  return (
    (usage.input_tokens || 0) * PRICE.input +
    (usage.output_tokens || 0) * PRICE.output +
    (usage.cache_creation_input_tokens || 0) * PRICE.cacheWrite +
    (usage.cache_read_input_tokens || 0) * PRICE.cacheRead
  ) / 1_000_000;
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

if (!due) {
  console.log('No reading time coming up. Nothing to do.');
  process.exit(0);
}

const month = localParts(now, schedule.timezone).date.slice(0, 7);
let usage = await readJson(new URL('usage.json', OUT_DIR), {});
if (usage.month !== month) usage = { month, costUSD: 0, briefings: 0 };
if (usage.costUSD >= schedule.monthlyBudgetUSD) {
  console.log(`Monthly budget of $${schedule.monthlyBudgetUSD} reached ($${usage.costUSD.toFixed(2)} spent). Skipping.`);
  process.exit(0);
}

const items = (await Promise.all(FEEDS.map(fetchFeed))).flat();
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

const client = new Anthropic();
let response;
try {
  response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: `Here are the latest news items:\n\n${itemList}\n\nWrite the briefing.` }],
  });
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) {
    console.error('The ANTHROPIC_API_KEY secret is missing or wrong.');
  } else if (err instanceof Anthropic.APIError) {
    console.error(`Claude API error ${err.status}: ${err.message}`);
  }
  throw err;
}

if (response.stop_reason === 'refusal') throw new Error('Claude declined to write this briefing; keeping the previous one.');
const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
if (!text) throw new Error(`Empty briefing (stop reason: ${response.stop_reason}).`);

const cost = costOf(response.usage);
usage.costUSD = Math.round((usage.costUSD + cost) * 10000) / 10000;
usage.briefings += 1;

await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL('latest.txt', OUT_DIR), text + '\n');
await writeFile(new URL('latest.json', OUT_DIR), JSON.stringify({
  slot: due.slot,
  createdAt: now.toISOString(),
  playAt: due.playAt.toISOString(),
  timezone: schedule.timezone,
  language,
  text,
}, null, 2) + '\n');
await writeFile(new URL('usage.json', OUT_DIR), JSON.stringify(usage, null, 2) + '\n');

console.log(`Briefing saved. Cost $${cost.toFixed(4)}; this month $${usage.costUSD.toFixed(2)} over ${usage.briefings} briefings.`);

# Dad News

A voice news reader for Dad, with two parts:

1. **Scheduled briefings (automatic).** Five times a day, GitHub prepares a spoken **political** news briefing: three or four trending Ghanaian stories (from MyJoyOnline, Graphic Online, Starr FM, 3News and The Ghana Report), then two world stories (from BBC, Al Jazeera, The Guardian, DW, France 24 and Africanews). A Ghana story reported by several outlets counts as trending and goes first. At each time you choose, his iPhone reads it aloud by itself. He doesn't have to do anything.
2. **The Dad News app (on demand).** He taps anywhere on the screen and speaks:
   - "Headlines" plays the latest briefing again. This is free.
   - "Tell me more about story two" or "What's the news from Kenya?" asks Claude, which searches trusted sites. This is a paid question.
   - "Repeat that", "Slower", "Faster", "Start over" and "Help" work too, and are free.

## Monthly cost (Claude Sonnet 5)

| Part | Usage | Cost |
|---|---|---|
| Scheduled briefings | 5 a day, about 3 cents each | about $4–5 a month |
| Questions in the app | about 5 cents each | capped at $15 a month by default (about 10 a day) |
| GitHub, hosting | | free |
| **Total** | | **about $20 a month at most** |

There are three safety limits:
- `monthlyBudgetUSD` in `schedule.json` caps the briefings.
- The **Monthly limit for questions** in the app's Setup screen caps questions.
- The spend limit in the Anthropic Console caps everything.

## Step 1: Get a Claude API key

1. Go to https://console.anthropic.com and sign up.
2. Open **Settings → Billing** and add a card. Buy $10–20 of credit.
3. Open **Settings → Limits** and set a monthly spend limit of **$25**.
4. Open **API keys → Create key**, name it "Dad News", and copy it. It starts with `sk-ant-`.

Never paste the key into a file in this repository. It goes only in the two places below: a GitHub secret and the app's Setup screen.

## Step 2: Put it on GitHub

1. Create a **public** repository, for example `dad-news`. GitHub Pages on a free account needs a public repository. The key is not in it.
2. Upload everything in this folder except `node_modules`, including the hidden `.github` folder. The easiest way is GitHub Desktop, or `git push`, because the web uploader skips hidden folders.
3. **Settings → Secrets and variables → Actions → New repository secret.** Name: `ANTHROPIC_API_KEY`. Value: your key.
4. **Settings → Pages** → Deploy from a branch → `main` / `(root)` → Save.
5. Edit `schedule.json` (you can use the pencil icon on GitHub):
   - `timezone`: already set to `"Africa/Accra"` (Ghana).
   - `times`: the five reading times in 24-hour format.
   - `language`: the language the briefing is written in.
6. Test it: **Actions → News briefing → Run workflow**. After about a minute, `briefings/latest.txt` appears with the first briefing.

From then on it runs by itself. Each briefing is ready 30–60 minutes before its reading time. If a run fails, GitHub emails you, and the phone reads the previous briefing.

## Step 3: Set up Dad's iPhone

**The app**
1. Open `https://YOUR-USERNAME.github.io/dad-news/` in **Safari** → Share → **Add to Home Screen**.
2. Open Dad News **from the home screen**. In Setup, paste the key and tap **Save**. It should say "The key works".
3. Tap Close, tap the screen once, and allow the microphone.

**Automatic reading at the scheduled times.** Repeat this once for each of the five times:
1. Open the **Shortcuts** app → **Automation** tab → **+** → **Time of Day**.
2. Set the time (for example 9:00 AM), choose **Daily**, and choose **Run Immediately**. Turn off "Notify When Run".
3. Tap **New Blank Automation** and add two actions:
   - **Get Contents of URL**: `https://raw.githubusercontent.com/YOUR-USERNAME/dad-news/main/briefings/latest.txt`
   - **Speak Text**: tap the arrow to set the speed and voice (choose an "Enhanced" voice).
4. Tap Done.

The times in the Shortcuts automations must match the `times` in `schedule.json`.

**"Hey Siri, Dad News"**: in Shortcuts, create a shortcut with **Open App → Dad News** and name it "Dad News".

**Tips**
- Keep the phone charging overnight and the volume up. Speak Text plays at the media volume.
- Test one automation by setting it for 2 minutes from now, with the phone locked.

## Changing things later

- Reading times, timezone, language: edit `schedule.json`, then update the Shortcuts automations to match.
- News sources: `FEEDS` in `scripts/briefing.mjs` (for briefings) and `TRUSTED_SITES` in `app.js` (for questions).
- Check real spending: the Anthropic Console → **Usage**. The briefing cost is also recorded in `briefings/usage.json`.

## Things to know

- The key in the app is stored only on Dad's phone. The key used for briefings is stored only as a GitHub secret.
- Speech recognition in iPhone home-screen web apps depends on the iOS version. If the microphone doesn't work, each tap plays the latest briefing instead. The scheduled reading doesn't use the microphone at all.
- VoiceOver users: double-tap anywhere to talk.
- Fixed phrases like "One moment" are in English.

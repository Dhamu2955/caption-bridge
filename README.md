# caption-bridge

**English subtitles for Gujarati sermons.** You hand it a video; it gives you
subtitle files that play in VLC, upload to YouTube, or project alongside the
recording. It can also caption a service live, as it happens.

Built for a mandir that plays sermons on a projector each Sunday and broadcasts
its own festival week once a year. Two jobs, one pipeline:

| Job | How often | Path |
|---|---|---|
| Sermons recorded or ripped, played back later | ~45 Sundays a year | **async** — the weekly workhorse |
| Own live festival broadcast | 7 days, once a year | **real-time** |

Transcription and translation come from [Soniox](https://soniox.com). Running
cost is roughly **$15/year**, plus a one-off ~$100–150 if you backfill an
archive.

---

## What you get

Point it at `sermon-2026-08-16.mp4` and it writes, beside the video:

```
sermon-2026-08-16.en.srt          English subtitles — the ones you project
sermon-2026-08-16.gu.srt          Gujarati subtitles — YouTube, accessibility, checking a line
sermon-2026-08-16.segments.json   the same content as data
sermon-2026-08-16.soniox.json     cached transcript, so re-runs are free and instant
```

The video itself is **never modified**. Subtitles sit alongside it as separate
files, so a correction never means re-encoding anything.

## How it works

```
video ──▶ ffmpeg ──▶ Soniox ──▶ segments ──▶ Postgres ──┬─▶ .srt files
          extracts   transcribes  grouped      the source │   regenerated any time
          the audio  + translates into cues    of truth   │
                                                          ├─▶ YouTube caption tracks
                                                          │   `publish`
                                                          └─▶ the projector
                                                              `play`, live from the DB
```

Corrections go into the database, not into the `.srt`. Re-export and the fix
appears — and re-publish and it appears on YouTube too. Hand-edit an `.srt` and
the next export silently overwrites it.

---

## Requirements

| | Needed for | Check |
|---|---|---|
| **Node 20.12+** | everything | `node -v` |
| **Soniox API key** | any captions at all | [console.soniox.com](https://console.soniox.com) |
| **ffmpeg** | the weekly job, and capturing from an audio device | `ffmpeg -version` |
| **Docker** | keeping sermons: the archive, corrections, search | `docker --version` |

On macOS: `brew install node ffmpeg` and install Docker Desktop.

Only the first two are required to caption a service live — [capturing in the
browser](#three-ways-to-get-sound-in) needs no ffmpeg, and live captions never
touch the database.

---

## Start here

```sh
npm install
npm run dev
```

It prints one address per network this machine is on, and opens the local one in
a browser:

```
open this, from here or from any machine on the network:

  http://192.168.1.42:3000
  http://127.0.0.1:3000

no token needed on this network — the homepage hands out the rest of the links
```

Type the first one on the vMix PC, a tablet or the office machine and you get
the homepage — **no token to read off a screen and type in.** Every page below
is one click from there, and every card has a **Copy link** button that gives
you the complete URL, token included, ready to paste into a vMix Browser input
on a third machine. Everything else is set up from the app: the Soniox key, the
database, the audio input, the YouTube caption URL.

**It starts before any of that exists.** A fresh clone with no `.env`, no
database and no ffmpeg still serves every page. The homepage, and the top of the
Captions tab, list what is missing and one thing to do about each, rather than
refusing to run.

**Closing the page stops nothing.** The bridge runs in the terminal, not in the
browser: close the tab, close the browser, shut the laptop you opened it from,
and a service being captioned carries on. Only `Ctrl+C` in that terminal stops
it. Add `--no-open` (`npm run dev -- --no-open`) on a machine nobody is sitting
at.

**Being on the network is what stands in for a login.** Every page carries a
`?token=` because a vMix Browser input cannot type a password — and the homepage
hands that token to any browser that asks from a private address, which is what
makes the short URL above work at all. So treat the mandir LAN as the boundary:
anyone on it can open the app, and the app can write API keys. **Never forward
this port to the internet.** On a network you do not control, turn off *Hand out
the link on this network* in Settings; every page then needs its full URL.

The token itself is written to `.env` on first run and reused after that, so a
link copied today still works next Sunday. Change `BRIDGE_TOKEN` in `.env` to
rotate it — every link already handed out then stops working.

Prefer a terminal, or setting up a machine you won't be sitting at? [Setup by
hand](#setup-by-hand) below does the same work.

---

## The app

### The homepage

`/` is a signpost, not a workplace, and it is the page most often opened from a
machine that is not the one running the bridge. It shows:

- **Where to go** — every screen the bridge serves, each with the token already
  in the link and a **Copy link** button that hands you the whole thing
  addressed to the LAN, plus what is attached: whether the caption screen is
  connected, how many sermons are in the archive
- **Open this from another machine** — the short address for each network this
  machine is on, so nobody has to run `ipconfig` under pressure
- **Still to set up** — anything preflight is unhappy about
- **Recent services** — the last eight, as a way into the Sermons tab

It is deliberately read-only. Starting and stopping captions lives on the
Captions tab, next to the level meter that tells you whether it worked.

### The tabs

One tab per job. Whether captions are going out is shown in the bar, from
whichever tab you are on.

| Tab | |
|---|---|
| **Captions** | What is still to set up, the sound input, start and stop, the level meter, the caption screen's URL for vMix, and what has gone out |
| **Glossary** | The vocabulary: what the bridge already knows, and what you have taught it |
| **Sermons** | Every service, its subtitles, corrections, and re-export |
| **Settings** | Credentials, subtitle shape, live timing, names and terms |

`/overlay` is the caption screen — one URL, the one you point vMix at. A stale
`?output=venue` on the end is ignored rather than refused, so every Browser
input and bookmark already saved around the mandir keeps working.

### Three ways to get sound in

| | | |
|---|---|---|
| **An audio device on this machine** | ffmpeg captures a named device | What a real service uses, and the only one that can be driven from another machine |
| **This browser** | the page captures it and streams PCM to the bridge | No ffmpeg, no device names typed exactly right |
| **A recording** | played in at the speed it was recorded | Rehearsal without a microphone |

Browser capture takes the sound from **whichever machine has the page open**, so
it cannot be used to run a service remotely: open the app on a laptop and it
captures that laptop, not the mixer plugged into the bridge. Device capture is
the one that keeps working when the page is somewhere else.

### Which input on the device

An interface or a capture card is **one device with several inputs**, and each
input is a channel of it. A Blackmagic UltraStudio presents sixteen; a Focusrite
2i2 presents two; the speaker is on one of them.

Taking all of them and mixing them down — which is what the bridge used to do,
and is still right for a virtual cable — averages the speaker with however many
silent channels sit beside them. On a two-channel interface that is 6 dB down.
On a sixteen-channel card it is **24 dB down**: a meter that barely moves, a
feed that looks connected, and a transcription of nothing. Nothing errors,
because nothing is wrong as far as ffmpeg is concerned.

So press **Test this input**. It listens for four seconds and reports the level
on every channel separately:

```
Sound on input 1 only, out of 16. Choose it above — mixing all 16
together drops the speaker 24 dB and can look like silence.

Input 1   ████████████░░░░░░░░░░░░   −27.3 dB
Input 2   ░░░░░░░░░░░░░░░░░░░░░░░░   silent
…
```

If exactly one input has sound on it, it is selected for you. Sixteen silent
channels means the device is fine and nothing is reaching it — a cable, a
muted bus, or a source that is not playing.

Browser capture only works where the browser allows it: **https, or localhost**.
Opening the bridge from another machine by IP is neither, so the dropdown says
so rather than failing silently. The machine running the bridge can always use
it, which is usually the vMix PC.

The bridge listens on `0.0.0.0` by default, which is what lets the vMix machine
and a tablet reach it at all. To go back to this machine alone, set **Listen on**
to `127.0.0.1` in Settings and restart.

---

## Setup by hand

The same four things the app does for you, from a terminal. Skip this if you
used the app.

### 1. Secrets

```sh
cp .env.example .env
```

Open `.env` and fill in what you need — it explains each line. The short
version: `SONIOX_API_KEY` for any captions at all, `DATABASE_URL` (already
filled in) to keep them, `YOUTUBE_INGESTION_URL` for live YouTube captions.

`.env` is gitignored and never committed. **Never put a key in `config.json`**
— that file *is* committed.

### 2. The database

```sh
docker compose up -d
```

Postgres 16 with pgvector, on **port 5433**. That's deliberate — 5432 is the
default and often already taken by another project. It listens on localhost
only; nothing on your network can reach it.

### 3. The tables

```sh
npx prisma migrate deploy
```

### 4. Check it works

```sh
npm test
```

394 tests, no API calls, nothing spent. If they pass, you're set up correctly.

---

## Running commands

Everything runs from the **repo root** (the tool reads `config.json` from the
current directory):

```sh
npx tsx src/cli.ts <command>
npx tsx src/cli.ts --help
```

If that gets tiresome, add a shell alias:

```sh
alias sc="cd ~/projects/mandir/caption-bridge && npx tsx src/cli.ts"
```

The examples below use `npx tsx src/cli.ts` throughout.

---

## The weekly job

**Trim the video to just the sermon first.** Timestamps come out relative to
whatever file you hand over, so a trimmed file needs no offset arithmetic
anywhere. If you have a three-hour stream recording:

```sh
ffmpeg -i ./full-stream.mp4 -ss 00:12:30 -to 01:22:00 -c copy ./sermon-2026-08-16.mp4
```

Then:

```sh
npx tsx src/cli.ts ingest ./sermon-2026-08-16.mp4 \
  --speaker "Swami Ji" --date 2026-08-16
```

A 90-minute sermon takes a few minutes: extracting audio, uploading, waiting
for Soniox, writing the files. It prints how many subtitles it made and the
shortest one, then the filenames.

To check the result, open the `.mp4` in VLC — it picks up the `.srt` beside it
automatically.

| Option | |
|---|---|
| `--speaker <name>` | required |
| `--date <YYYY-MM-DD>` | required |
| `--title <text>` | optional service title |
| `--force` | transcribe again instead of using the cache (costs money) |
| `--no-db` | write files only, don't touch the database |
| `--replace-edited` | overwrite subtitles even if someone has corrected them |
| `--config <path>` | use a different config file |

Re-running without `--force` is **free and instant** — it reuses the cached
transcript and produces byte-identical files.

---

## Fixing a bad translation

The database is the source of truth. Correct it there, then re-export.

```sh
# 1. find the service
npx tsx src/cli.ts list

# 2. read the subtitles around the problem
npx tsx src/cli.ts show ./sermon-2026-08-16.mp4 --from 40 --limit 5

# 3. fix subtitle number 42
npx tsx src/cli.ts edit ./sermon-2026-08-16.mp4 --cue 42 --text "The corrected line."

# 4. regenerate the .srt files
npx tsx src/cli.ts export ./sermon-2026-08-16.mp4
```

`--cue` is the number shown in the SRT file and in VLC, counting from 1.

Every edit records **who changed it, when, and what it said before**. Nothing
is lost. And re-ingesting a sermon that has corrections is **refused**:

```
error: 1 hand-corrected segment would be discarded. Pass --replace-edited if that is what you want.
```

That refusal is deliberate — without it, a routine weekly re-run would quietly
destroy someone's work.

---

## Putting captions on YouTube

For sermons on **your own channel**. YouTube's auto-captions handle Gujarati
religious vocabulary badly and cannot be corrected; these can.

Upload the video in YouTube Studio as usual, then hand `publish` its id once:

```sh
npx tsx src/cli.ts publish ./sermon-2026-08-16.mp4 --youtube-id dQw4w9WgXcQ
```

Both tracks go up — English and Gujarati. The id is remembered, so after a
correction it is just:

```sh
npx tsx src/cli.ts edit ./sermon-2026-08-16.mp4 --cue 42 --text "The corrected line."
npx tsx src/cli.ts publish ./sermon-2026-08-16.mp4
```

That **updates** the existing track rather than adding a second one, and
publishing again with nothing changed does nothing at all — no request, no
quota. The text comes from the database, not from the `.srt` on disk.

| Option | |
|---|---|
| `--youtube-id <id>` | the video on your channel. Needed once |
| `--all` | publish every service that has an id, paced to the daily quota |
| `--budget <units>` | quota to spend in one run (default 90% of the day's) |
| `--dry-run` | show what would be uploaded; make no API calls |
| `--force` | upload again even if nothing changed |
| `--auth` | mint a refresh token, once, in a browser |

### One-time setup

1. At [console.cloud.google.com](https://console.cloud.google.com), make a
   project, enable **YouTube Data API v3**, and create an **OAuth client** of
   type *Desktop app*.
2. **Set the OAuth consent screen to "Production", not "Testing".** In Testing,
   Google expires refresh tokens after **seven days** — exactly the length of
   festival week. Verification is not needed for personal use; an unverified
   production app just shows a warning on the one consent screen you ever see.
3. Put the client id and secret in `.env`, then:

```sh
npx tsx src/cli.ts publish --auth
```

Approve in the browser and paste the printed refresh token into `.env`.

### The quota, and why a backlog takes a few days

The API gives 10,000 units a day. A caption insert is 400 and an update 450, so
one video with both languages costs **800 to publish, 900 to correct** — about a
dozen videos a day.

- **A year of sermons (~45 videos)** is roughly a four-day run. `publish --all`
  stops cleanly when the budget is gone and resumes the next day by itself; it
  keeps no state file, because the database already records what is on YouTube.
- **A whole festival week (7 videos)** fits inside a single day's quota.

> **Sermons ripped from other mandirs' streams cannot be published.** Captions
> can only be attached to videos on a channel you own, and YouTube removed
> community captions in 2020. Those sermons are served by `play` on the
> projector instead.

---

## Captions on the projector

vMix does **not** pick up an `.srt` sitting beside the video the way VLC does,
so something has to drive the captions during playback:

```sh
npx tsx src/cli.ts play ./sermon-2026-08-16.mp4 --input <vmix-input-guid>
```

It prints an overlay URL — point a vMix Browser input at it. Captions follow the
playhead, so **pause, seek and restart all just work**, and the text comes from
the database, so a correction made last night is on screen this morning with no
re-export.

| Option | |
|---|---|
| `--input <guid>` | the vMix input playing the file. A GUID, never a number |
| `--caption-input <guid>` | drive a vMix GT title instead of the overlay |
| `--vmix-url <url>` | vMix web controller (default `http://127.0.0.1:8088`) |
| `--lines both` | Gujarati above English |

If the bridge is not available on a given Sunday, add the sermon to vMix as a
**VLC input** with `--sub-file=./sermon-2026-08-16.en.srt`. VLC burns the
subtitles into the frames, so they cannot be styled or keyed — but it needs
nothing running.

---

## Finding something across sermons

```sh
npx tsx src/cli.ts index                       # index everything ingested so far
npx tsx src/cli.ts search "what does devotion require" --limit 5
```

Results print a link like `sermon.mp4#t=1727` that jumps the video to that
moment.

Search works by meaning, not keywords, and both languages are indexed — so an
English question can find a Gujarati passage and vice versa. The model runs
**on your machine**: no API key, nothing sent anywhere. It downloads once
(~120 MB) the first time you run `index`.

> Search quality can't really be judged until ~20 sermons are ingested. One
> service is not enough to tell whether the passage size is right.

---

## Backfilling an archive

**Do this first, before any bulk run:**

```sh
npx tsx src/cli.ts backfill ./archive --speaker "Swami Ji" --only worst --limit 3
```

Push your three *worst-sounding* old recordings through and read the output.
Old room-mic recordings may be unusable, which would mean the backfill only
covers whatever era has a clean desk feed. That's much better to discover for a
dollar than after committing to the whole archive.

Then the real run:

```sh
npx tsx src/cli.ts backfill ./archive --speaker "Swami Ji"
npx tsx src/cli.ts backfill ./archive --speaker "Swami Ji" --retry-failed
```

Dates are read from filenames (`sermon-2026-08-16.mp4`); `--date` is the
fallback for files without one. Progress is saved after **every** file, so an
interrupted run picks up where it stopped and one bad file never kills the
batch.

| Option | |
|---|---|
| `--limit <n>` | stop after n files |
| `--only <text>` | only files whose name contains this |
| `--retry-failed` | try files that failed previously |
| `--redo` | re-ingest files already done |

---

## Live captions

> **Not yet tested against real vMix hardware.** Read
> [docs/vmix-routing.md](docs/vmix-routing.md) before a live service — it has
> the audio routing, the two-delay arrangement, and a six-step validation
> checklist. The first three steps need no Windows machine.

**Most of this is now done from [the app](#the-app)** — `npm run dev`, then the
Captions tab. The `live` command below does the same thing from a terminal and
is what the app calls underneath; it is still the right choice for a machine you
will not be sitting at.

```sh
npx tsx src/cli.ts devices     # prints the command to list your audio devices

npx tsx src/cli.ts live --device "CABLE Output (VB-Audio Virtual Cable)" \
  --record ./service.jsonl
```

It prints the overlay URL with a token on it. That is the one you point a vMix
Browser input at.

**`/overlay`** — the caption block that goes on screen. Transparent background
so vMix can key it. English only by default; add `?lines=both` for bilingual.

### Subtitles from a live service

On by default (`live.liveSrt`). A live service writes an `.srt` into the
recordings folder as it runs, holding exactly what went out — so the recording
can be captioned afterwards without transcribing the same words a second time.
Timestamps run from when capture started.

### The service, in a Google Doc

Off by default (`live.googleDoc`). Turned on, every finalised line is written to
a **new Google Doc each time you press Start**, as the service runs:

```
11:42:34  (0:12:34)
આ દર્શન-શ્રવણનો મહિમા છે.
This is the glory of seeing and hearing.

11:42:41  (0:12:41)
ભક્તિ એ માર્ગ છે.
Devotion is the path.
```

Both timestamps, because they answer different questions: the clock places a
passage against the service somebody sat through, the offset finds it in the
recording — the same number the `.srt` uses. The link appears on the Captions
tab as soon as the doc exists, which is before anyone has spoken.

**Setting it up**, once:

1. [console.cloud.google.com](https://console.cloud.google.com) → a project (the
   YouTube one is fine) → **APIs & Services → Library** → enable **both**:
   - **Google Drive API** — creates the document
   - **Google Docs API** — writes into it

   Enabling only Drive gets you a document that exists and stays empty. It is
   the first thing that goes wrong; the Captions tab names the missing one and
   links straight to it.
2. **Credentials → Create credentials → OAuth client ID → Desktop app.** Copy
   the id and secret into `.env` as `GOOGLE_DOCS_CLIENT_ID` and
   `GOOGLE_DOCS_CLIENT_SECRET`.
3. **OAuth consent screen → Production.** In Testing, Google expires the refresh
   token after seven days — exactly the length of festival week.
4. `npx tsx src/cli.ts doc --auth`, approve in the browser, paste the printed
   `GOOGLE_DOCS_REFRESH_TOKEN` into `.env`.
5. Settings → **Write the service to a Google Doc**.

**About the folder.** By default the app asks only for access to files it
creates itself, and the docs land in My Drive. That is the least permission that
works, and it is enough — move or share them afterwards like any other file.

Putting them straight into a folder you picked needs access to your whole
Drive, because Google's narrow permission cannot reach a folder the app did not
create. If you want that: set `googleDocs.fullDriveAccess` to `true` in
`config.json`, run `doc --auth` **again** (scopes are fixed when the token is
minted), then paste the folder's id into Settings — the last part of its address
in Drive. Get it wrong and the Captions tab tells you which of the two to fix.

**A separate credential from YouTube's, deliberately.** The client id and secret
may be the same strings pasted twice; the refresh token cannot be, because the
scopes differ.

**It cannot take a service down.** Lines are batched every five seconds, so an
idle stretch costs nothing. A hiccup retries with the words still buffered. A
permanent failure stops the doc for the rest of the service and says so on the
Captions tab — the captions, the screen and the `.srt` carry on.

### How long a sentence takes to appear

A caption cannot exist until the sentence it covers has finished being spoken
and Soniox has translated it. There is no queue and no delay between a line
existing and it being on screen, so that is the whole of the latency.

**Soniox decides where a sentence ends, and it should be left to.** Two settings
can interfere, and both default to what the working prototype uses:

| | Default | |
|---|---|---|
| `live.maxEndpointDelayMs` | 2000 | A **ceiling** on how long Soniox may wait before calling a clause finished — a backstop for a speaker who never pauses. Not a target. Lower it and you force a cut mid-thought |
| `live.endpointSensitivity` | **not set** | −1 patient to 1 eager. Absent from `config.json` and from the settings form on purpose. Setting it overrides Soniox's own judgement, and eager values are how captions start arriving three words at a time |

If sentences are forming too fast, check those two first — in that order. The
symptom of both is the same: fragments where clauses should be.

`live.maxBufferMs` (8000) is our own backstop, not a chunker: it forces a flush
if Soniox has not called an endpoint in eight seconds. With the ceiling above at
two seconds it should never fire.

**Nothing waits for the endpoint.** A caption goes out the moment its English
arrives — typically a couple of hundred milliseconds after the clause finishes.
Waiting for Soniox's endpoint marker used to add another 1.5–2 seconds for
nothing: the words were already there, and the marker only said what we could
already see. Speech whose English has *not* arrived is held rather than shown,
because the segment builder otherwise falls back to the source and puts raw
Gujarati on the English screen.

**Caption length is Soniox's translation granularity** — whatever English it
hands over in one go becomes one caption. That is short, and deliberately so:
waiting for more is waiting, and waiting is lag.

**The screen keeps the previous line.** A new caption arrives underneath the
last one, which dims and stays. Two consecutive captions from a real service:

```
From 6 to 11—at 11 o'clock, brothers, Bapa to everyone     ← dimmed
brothers, gives sheero, chickpeas, and lentils.            ← current
```

They read as the sentence they are, instead of one flashing past and being
replaced by the other. This is not roll-up: both lines are complete, neither is
ever edited, and nothing changes under the reader — a new line arrives, the old
one moves up. `?history=0` on the overlay URL goes back to one at a time.

### The one place to tune it

**Settings → This service → "How long to wait before captioning"**
(`live.maxEndpointDelayMs`, 2000). It is the only wait in the pipeline. Soniox
holds a run of speech until it decides the clause has ended, translates it, and
the caption goes straight to the screen — so this number *is* how far behind the
speaker the captions sit.

| Set it to | You get |
|---|---|
| 800–1000 | Captions mid-sentence, a second sooner. Fragments, often mid-thought |
| **2000** | What the working prototype runs on air. Clause-sized, ~1–2s behind |
| 3000–4000 | Fuller sentences, that much further behind |

There is no client-side buffer any more. Anything Soniox has translated is on
screen within a frame of arriving, so nothing else can be shortened.

**To go finer than this you would need provisional tokens**, and those are
revised as the speaker continues — the text would re-order itself on screen.
That is the one thing this pipeline will not do; see
[INVARIANT 4](SPEC.md).

`live.endpointSensitivity` is a second, finer control on the same decision:
−1 patient to 1 eager, absent by default, and `config.json`-only because eager
values are the fastest way to fragment a service. Add it by hand if you want to
experiment.

**One flush is one caption.** However long the run, a flush produces exactly
one line — the same thing the prototype does when it posts an event's whole
finalised text as a single caption. It used to split a long run into several
readable cues, which is right for an `.srt` file and wrong on a screen: with no
scheduler pacing them, all of them were delivered in the same millisecond and
only the last was ever seen. A run-on speaker now gives you one long caption
rather than four flashed ones.

---

## Configuration

`config.json` holds everything tunable. No credentials — those come from `.env`.

### Subtitle shape

| Setting | Default | |
|---|---|---|
| `pauseMs` | 4000 | silence that ends a subtitle |
| `maxChars` | 138 | most characters in one subtitle |
| `maxSegmentMs` | 20000 | longest a subtitle stays up |
| `minDisplayMs` | 1500 | shortest — briefer ones are merged, never flashed |
| `maxLineChars` | 46 | characters per line |
| `maxLines` | 3 | lines per subtitle |

Two things worth knowing:

**Keep `maxChars` ≈ `maxLines × maxLineChars`.** `maxLines` is a hard cap, so
when a subtitle holds more text than the lines can fit, the last line runs long
rather than dropping words. Setting `maxChars: 170` against a 2 × 48 budget
produced 98-character lines.

**If subtitles feel choppy, raise `pauseMs`.** If separate sentences run
together, lower it.

### Names and terms

**A Swaminarayan glossary ships with the bridge** — 202 translation terms, 86
transcription terms, and a block of instructions setting the register (a sermon,
not a podcast; grace and blessings, never a literal reading that lands somewhere
awkward on a public broadcast). It is used on both the live and the weekly path.

Ported with thanks from the **Aashirwad Captions** bridge (`realtime-transcription`)
run by the American mandirs, which has been captioning the same sampradaya for
longer than this has. It lives in `src/soniox/vocabulary.ts`.

**Curate it on the Glossary tab**, which is where this is actually done: search
either language, see which terms are built in and which you added, change one
without retyping the rest. A built-in term is never deleted — it is overridden,
and the row says what it replaced so the change is legible. Restore puts it back.

Everything you add lands in `soniox.contextTerms` and `soniox.translationTerms`
in `config.json` and wins over the built-in list. Set `soniox.builtInGlossary` to
`false` to run on your own terms alone.

Changes take effect **the next time captions are started** — Soniox has no
mid-session context API.

**A glossary is a soft bias, not a rule.** Soniox paraphrases through it often
enough that a second pass exists — `src/soniox/normalize.ts` — which corrects
the English afterwards: Jai → Jay, lineage titles kept as names rather than
translated into "the life-breath of our life", દ્વિભુજ as two-armed rather than
bipedal. Add to it only where the wrong output is unambiguous; anything that
merely reads awkwardly belongs in the context block instead.

---

## Troubleshooting

**`SONIOX_API_KEY is not set`**
`.env` is missing or the key line is empty. Paste the key into **Settings → Keys
and passwords** in the app, or `cp .env.example .env` and put it there.

**`DATABASE_URL is not set`**
Same two places. `.env.example` already contains the
`postgresql://...5433/...` line, so copying the file is usually enough.

**Someone is speaking and no caption appears for a few seconds**
Expected. A caption cannot exist until the sentence it covers has finished being
spoken, and then Soniox has to translate it — measured on a real sermon, the
median line is ready 7 seconds after its first word. Lowering **Cut a line
after** (`maxBufferMs`) is the only real lever, and it buys speed by splitting
sentences.

**Captions stopped and nothing says why**
Look at **Sound coming in** on the Captions tab. After 12 seconds without speech
it says how long it has been quiet; after 30 it turns red and the log repeats a
warning every minute. A long pause and a pulled cable look identical on a level meter nobody is watching, which is why
the duration is stated rather than left to be inferred.

**The Google Doc stopped part-way through a service**
Look at the Captions tab: it says so, with the reason. A revoked token, a
deleted doc or a folder the credential cannot reach all stop it for the rest of
the service by design, rather than retrying a wall for ninety minutes. The
`.srt` in `recordings/` has everything either way.

**The device is in the list, captions start, and nothing is transcribed**
Press **Test this input** on the Captions tab. The usual answer is a capture
card or an interface presenting several inputs as channels of one device, with
the speaker on one of them — see [Which input on the
device](#which-input-on-the-device). If every channel reads silent, the device
is fine and nothing is arriving at it.

**`ffmpeg not found on PATH`**
`brew install ffmpeg` on macOS.

**`Bind for 0.0.0.0:5433 failed: port is already allocated`**
Something else is using that port. Change it in `docker-compose.yml` *and* the
`DATABASE_URL` in `.env` — they must match.

**`failed to connect to the docker API`**
Docker Desktop isn't running. Start it and wait for the whale icon to settle.

**`no service found for "..."`**
Pass the same video path you used at ingest, or a service id from
`npx tsx src/cli.ts list`.

**Ingest produced 0 subtitles**
There was no speech in the audio, or the wrong audio track was picked up. Check
the file plays with sound.

**Database tests are skipping**
Postgres isn't running. `docker compose up -d`. They skip rather than fail on
purpose, so the rest of the suite still runs.

**`publish` says the refresh token is invalid**
The OAuth consent screen is in "Testing", where Google expires refresh tokens
after seven days. Set it to "Production" and run `publish --auth` again.

**`publish` says no YouTube video is recorded**
Pass `--youtube-id <id>` once; it's remembered after that. If the sermon was
ripped from another mandir's channel there is no id to pass — captions can only
go on videos you own.

**YouTube captions ran out of quota**
Expected on a backlog run: the daily allowance covers about a dozen videos.
Re-run the same command tomorrow; it picks up where it stopped.

**`play` shows no captions**
Check the `--input` GUID matches the input actually playing the file — vMix
input *numbers* shift when inputs are reordered, which is why this takes a GUID.
`http://127.0.0.1:8088/api/` in a browser shows the state XML with the keys in it.

---

## Project layout

```
src/
  cli.ts                 command-line entry point
  config.ts              reads config.json, resolves credentials from the environment
  audio/                 ffmpeg audio extraction
  soniox/                async API client, and the vocabulary:
    vocabulary.ts          the Swaminarayan glossary and register instructions
    context.ts             merges built-in and local terms; used by both paths
    normalize.ts           corrects the English the glossary did not manage to
  google/                shared OAuth, and the Docs/Drive client
  youtube/               Data API client for caption tracks
  segments/build.ts      tokens → subtitles. The core; shared by every phase
  srt/format.ts          subtitles → .srt text
  db/                    Postgres access
  search/                chunking, embeddings, vector search
  live/                  real-time bridge: capture, websocket, line building,
                         and the four sinks (screen, YouTube, .srt, Google Doc)
  settings/              reads and writes .env and config.json, atomically
  web/                   HTTP routes the app pages call, and the URL token
  util/                  logging, network addresses, opening a browser
  commands/              one file per CLI command
public/
  home.html              the homepage: where to go, and how to get here
  app.html               the app — one tab per job
  overlay.html           on-air caption block — the one screen
  capture-worklet.js     browser audio capture, on the audio thread
prisma/schema.prisma     database schema
docs/                    architecture and vMix routing
test/                    428 tests
```

`src/segments/build.ts` is the piece to understand first — everything else
feeds it or consumes what it produces.

## Development

```sh
npm test           # database tests skip themselves if Postgres isn't running
npm run test:watch
npm run typecheck
```

Run tests before committing. No bundler — TypeScript runs directly via `tsx`.

---

## Design notes

Two things about Soniox's output that are invisible on small test inputs, both
found by running a real 69-minute sermon. `src/segments/build.ts` depends on
them and `test/fixtures/tokens.sermon.json` reproduces them.

**Tokens are sub-word pieces, and a leading space is the only word delimiter.**
`["અ","ક્ષ","ર"]` is the single word `અક્ષર`; `["The"," l","ord"]` is
`The lord`. Never insert a separator when joining them, and never split a
subtitle at a token whose successor lacks a leading space — that cuts a word in
half. Soniox also emits a bare `" "` as its own token: it looks empty but it is
a word boundary, and discarding it fuses two words together.

**Translated tokens carry `start_ms: 0` and `end_ms: 0`.** The fields exist but
are meaningless. Reading them at face value would drag every subtitle to
`00:00:00`. Timing always comes from the spoken tokens; the translation
inherits it.

### Where this differs from SPEC.md

**Three lines per subtitle, not two (§4).** At two lines, only 62% of subtitles
ended on a full stop, so single sentences were routinely split across three
captions. Three lines takes that to 83%, and the subtitle count on a real
sermon dropped 776 → 594. Reading speed is unchanged, because longer subtitles
also stay on screen longer. Set `maxLines: 2` to revert.

**`editedBy` says `soniox` on untouched subtitles, not `local` (§4).** The
point of §4 is that no correction ever needs backfilling, which a non-null
column achieves — but stamping `local` on 594 machine-generated lines would
claim a person wrote them. `editedAt IS NULL` is the precise test for "never
touched by a human".

**There is no reviewer, and no delay (§4, §7–§10).** The spec is built around a
review window: captions held back so a human can correct a line before it airs,
with a per-output scheduler to hold them. Both are gone. A line goes to the
screen and to YouTube the moment Soniox has finalised and translated it, and a
caption already sent cannot be changed by anything.

What that costs: nothing can be corrected before air, and a *delayed* stream can
no longer be captioned in sync — the YouTube timestamp is now always the instant
of the POST, which is self-correcting only because nothing is held back.

INVARIANT 4 itself is stronger than it was, not weaker. Pop-on everywhere, no
exceptions, and four independent mechanisms now enforce it: the builder discards
non-final tokens, `include_nonfinal` is false on the wire, there is no surface
that renders provisional text, and with the reviewer gone there is no code path
that can revise a line at all.

**Subtitle boundaries don't use endpoint detection (§4).** That feature only
exists in Soniox's real-time API; an async transcript is a flat stream with no
markers. Boundaries come from sentence punctuation, the pause threshold,
speaker changes, and the size caps instead.

---

## Further reading

- **[SPEC.md](SPEC.md)** — the full specification, including the invariants
  that are expensive to reverse. Read this before changing how subtitles are
  timed or displayed.
- **[docs/vmix-routing.md](docs/vmix-routing.md)** — getting audio into the
  bridge and captions back to air, and what still needs confirming on the vMix
  machine.
- **[docs/architecture.mermaid](docs/architecture.mermaid)** — the live path as
  a diagram.

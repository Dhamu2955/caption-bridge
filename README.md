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

That's it. It prints a URL — open it, and everything else is set up from the
app: the Soniox key, the database, the audio input, the YouTube caption URL.

**It starts before any of that exists.** A fresh clone with no `.env`, no
database and no ffmpeg still serves every page. The top of the Captions tab
lists what is missing and one thing to do about each, rather than refusing to
run.

Prefer a terminal, or setting up a machine you won't be sitting at? [Setup by
hand](#setup-by-hand) below does the same work.

---

## The app

One tab per job. Whether captions are going out is shown in the bar, from
whichever tab you are on.

| Tab | |
|---|---|
| **Captions** | What is still to set up, the sound input, start and stop, the level meter, the overlay URLs for vMix, and what has gone out |
| **Reviewer** | The reviewer queue, for correcting lines from the vMix machine rather than a tablet |
| **Glossary** | The vocabulary: what the bridge already knows, and what you have taught it |
| **Sermons** | Every service, its subtitles, corrections, and re-export |
| **Settings** | Credentials, subtitle shape, live timing, names and terms |

`/control`, `/operator` and `/overlay` still work at their own URLs and are
unchanged, so a tablet or a saved vMix Browser input is unaffected.

### Three ways to get sound in

| | | |
|---|---|---|
| **An audio device on this machine** | ffmpeg captures a named device | What a real service uses |
| **This browser** | the page captures it and streams PCM to the bridge | No ffmpeg, no device names typed exactly right |
| **A recording** | played in at the speed it was recorded | Rehearsal without a microphone |

Browser capture only works where the browser allows it: **https, or localhost**.
Opening the bridge from another machine by IP is neither, so the dropdown says
so rather than failing silently. The machine running the bridge can always use
it, which is usually the vMix PC.

To reach it from the vMix machine and a tablet, set **Listen on** to `0.0.0.0`
in Settings and restart. Note what that means: anyone on the mandir network can
then open the app, and the app can write API keys. Only do it on a network you
trust — there are no user accounts yet.

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
  --outputs venue,stream --record ./service.jsonl
```

It prints a setup URL, a reviewer URL and one overlay URL per output, each with
a token. Point vMix Browser inputs at the overlay URLs; open the reviewer page
on a tablet.

**`/control`** — the setup page, for whoever is running the switcher. Pick the
audio input from a dropdown instead of typing a device name exactly, start and
stop, and watch a level meter that shows whether the cable is actually carrying
sound. Inputs that look like a virtual cable are floated to the top and marked,
because tapping the main mix instead of the speaker's own bus is the single
biggest accuracy loss available.

**`/operator`** — the reviewer page. A queue of the lines still waiting to go
out, soonest first, Gujarati above English at reading size. Each has a bar that
drains to show the time left, a "Don't show this", and a "Fix wording" for the
occasional line worth correcting rather than dropping. Plus a clearly separated
"Turn captions off".

The queue **stays at the top**, where the line about to go out is. Scroll away
to read ahead and it holds your place instead of dragging you along, with a
**Next line out** button in the header to get back. Sound is a deliberate press
— browsers refuse to autoplay audio, and a tablet in the room would feed its own
speaker back into the microphone being captioned.

When the bridge is being fed a **recording** rather than a microphone, the page
also shows the video, with the caption on it. Tap the Gujarati of any queued
line and the picture jumps to the moment it was spoken, so a doubtful
translation is judged against what was actually said; "Back to live" returns to
following the playhead. The mapping needs no calibration — audio position 0 is
the session's start instant and the file plays at its own speed, so a line at
`audioStartMs` is at `audioStartMs` in the file.

There is no equivalent for a live service yet: that needs a video feed off the
vMix machine. See [docs/vmix-routing.md](docs/vmix-routing.md).

The page also carries the **silent-feed badge**. After twelve seconds without
speech it says how long it has been quiet, and after thirty it turns red. That
is the failure worth catching mid-service: captions do not error when the sound
stops reaching them, they simply stop, and a long pause looks identical to a
pulled cable on a level meter nobody is watching.

### Captions on the YouTube stream

```sh
npx tsx src/cli.ts live --device "…" --outputs venue,stream \
  --youtube-captions "<ingestion url from YouTube>" --stream-offset 180000
```

Enable closed captions with the **POST to URL** method in the stream's settings
and YouTube gives you the ingestion URL. Every reviewed line is posted there as
a real closed caption — toggleable by the viewer, and never burned into the
picture, which is why this path needs no second composite in vMix.

You can leave the flag off and put the URL in `YOUTUBE_INGESTION_URL` instead,
or paste it into **Settings → Keys and passwords** in the app. It carries a
`cid` identifying your stream, so treat it like a password.

This is the *only* thing live YouTube captions need. The `YOUTUBE_CLIENT_ID`
/ `_SECRET` / `_REFRESH_TOKEN` trio is a separate job — attaching caption tracks
to recordings after the event — and is not involved here.

`--stream-offset` is the delay between your encoder and YouTube receiving the
video; it is what puts each caption on the right words. **Confirm it on a
private test stream before a festival.**

### The two delays

There are two, and they add up — they are never collapsed into one.

| | | What it buys |
|---|---|---|
| **A** `live.delayAssemblyMs` | 15s | Time for Soniox to hear a whole sentence and translate it. Below this, captions are scheduled for an instant already past and get dropped |
| **B** `live.delayReviewMs` | 3min | Time for a human to read the Gujarati, judge the English, and type a correction |

Every destination waits **A**. Only the reviewed one — the broadcast — waits
**A + B** as well:

```
speech ──▶ A ──▶ venue, overflow, reviewer's monitor
              └▶ B ──▶ the stream, YouTube captions
```

That gap is the whole point: a reviewer's correction lands while the line is
still inside **B**, so it changes what goes out rather than trying to un-say it.

**Why A is 15 seconds.** Measured across all 594 cues of a real sermon: the
median caption is ready 7s after its first word, 90% within 12s, the worst at
21s. A caption cannot exist until the sentence it covers has finished being
spoken, so this is a floor set by speech, not by the software. Set it lower and
lines go missing; the symptom is someone talking with nothing on screen.

**Why B is minutes.** At the original 25 seconds a reviewer could realistically
only drop a line. The cost is that the stream runs that far behind the room, and
that a delay this long can no longer live in vMix's Video Delay, which buffers
uncompressed frames in RAM: it has to move after the encoder, to OBS's stream
delay or a disk relay. See [docs/vmix-routing.md](docs/vmix-routing.md).
Tunable up to ten minutes.

The venue screens are unaffected — they stay `delayAssemblyMs` behind the
speaker (15 seconds by default), because a congregation in the room cannot
watch captions three minutes late.

**The reviewer is told how long they have.** The queue header states the window
in words, and a line that goes to air while it is being corrected says so rather
than the editor simply closing. A reviewer never holds a line back — INVARIANT
10 — so the deadline arriving mid-correction is normal, and only confusing when
it is silent.

### The half of the delay that is Soniox's

Nothing can be translated until Soniox decides a clause has finished, so two of
its settings sit underneath **A**:

| | Default | |
|---|---|---|
| `live.endpointSensitivity` | −0.25 | −1 patient, 1 eager. Slightly patient reads better: it gives the translator enough audio to resolve short words and clause boundaries rather than committing to a fragment |
| `live.maxEndpointDelayMs` | 2500 | Hard ceiling on that wait, so a speaker who does not pause cannot hold a segment open indefinitely |

Both come from the American mandirs' bridge, arrived at by running real satsang
through it. Their note is worth keeping: more patient settings read better but
"added noticeable lag".

**`/overlay?output=venue`** — the caption block that goes on screen.
Transparent background so vMix can key it. English only by default; add
`&lines=both` for bilingual.

See it without running anything live:

```
http://127.0.0.1:3000/operator?demo=1
```

**The reviewer is advisory.** Captions never wait for them, closing the page
stalls nothing, and a "don't show this" that arrives after a line has already
gone out is rejected rather than applied retroactively.

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

**Someone is speaking and no caption appears**
`live.delayAssemblyMs` is too low. A caption cannot exist until the sentence it
covers has finished being spoken, so anything under about 12 seconds routinely
schedules lines for an instant already past, and they are dropped. See
[The two delays](#the-two-delays).

**Captions stopped and nothing says why**
Look at **Sound coming in** on the Captions tab. After 12 seconds without speech
it says how long it has been quiet; after 30 it turns red and the log repeats a
warning every minute. The reviewer gets the same badge. A long pause and a
pulled cable look identical on a level meter nobody is watching, which is why
the duration is stated rather than left to be inferred.

**The first line or two of a service never reaches the venue screens**
Expected, and only affects the unreviewed outputs. Soniox's first result arrives
around 19s in, by which point a line covering the opening seconds is already
past its `delayAssemblyMs` deadline. The stream and YouTube outputs wait `A + B`
so they carry it. Start captions a few seconds before the speaker does and there
is nothing to lose.

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
  youtube/               Data API client and the one-off OAuth flow
  segments/build.ts      tokens → subtitles. The core; shared by every phase
  srt/format.ts          subtitles → .srt text
  db/                    Postgres access
  search/                chunking, embeddings, vector search
  live/                  real-time bridge: capture, websocket, queue, adapters
  settings/              reads and writes .env and config.json, atomically
  web/                   HTTP routes the app pages call
  commands/              one file per CLI command
public/
  app.html               the app — one tab per job
  operator.html          reviewer page: video, queue, transcript
  control.html           the older standalone setup page
  overlay.html           on-air caption block
  capture-worklet.js     browser audio capture, on the audio thread
prisma/schema.prisma     database schema
docs/                    architecture and vMix routing
test/                    394 tests
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

### A reviewer's decisions used not to reach YouTube

Fixed, and worth recording because it changes what the live path actually did.

The closed-caption output is registered under its own name (`youtube`) while
carrying the `stream` output's schedule. Reviewer drops and edits were scoped to
`'stream'` alone, and `CaptionQueue` skips any output whose name does not match —
so **"Don't show this" removed a line from the overlay but still posted it to
YouTube**, and "Fix wording" corrected the overlay while YouTube received the
machine translation. The comment claiming otherwise was written before the
output was given a separate name.

`drop` and `editLine` now take a list of output names rather than one.
`test/live.youtube.test.ts` covers it: register both outputs, drop a line,
assert no POST happens.

Two smaller things fixed alongside it. A failed POST used to consume a sequence
number, leaving a gap in a series the endpoint counts on — the number is now
only spent by a request YouTube accepted. And the ingestion URL is checked when
it is set rather than at the first caption, so a truncated paste is caught
before a service instead of during one.

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

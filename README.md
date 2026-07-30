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
video ──▶ ffmpeg ──▶ Soniox ──▶ segments ──▶ Postgres ──▶ .srt files
          extracts   transcribes  grouped      the source    regenerated
          the audio  + translates into cues    of truth      any time
```

Corrections go into the database, not into the `.srt`. Re-export and the fix
appears. Hand-edit an `.srt` and the next export silently overwrites it.

---

## Requirements

| | | Check |
|---|---|---|
| **Node 20.12+** | runs the tool | `node -v` |
| **ffmpeg** | extracts audio | `ffmpeg -version` |
| **Docker** | runs Postgres | `docker --version` |
| **Soniox API key** | transcription | [console.soniox.com](https://console.soniox.com) |

On macOS: `brew install node ffmpeg` and install Docker Desktop.

---

## Setup

Five steps, from a fresh clone.

### 1. Install dependencies

```sh
npm install
```

### 2. Add your API key

```sh
cp .env.example .env
```

Open `.env` and paste your key after `SONIOX_API_KEY=`.

`.env` is gitignored and never committed. **Never put the key in
`config.json`** — that file *is* committed.

### 3. Start the database

```sh
docker compose up -d
```

Postgres 16 with pgvector, on **port 5433**. That's deliberate — 5432 is the
default and often already taken by another project. It listens on localhost
only; nothing on your network can reach it.

### 4. Create the tables

```sh
npx prisma migrate deploy
```

### 5. Check it works

```sh
npm test
```

158 tests, no API calls, nothing spent. If they pass, you're set up correctly.

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

```sh
npx tsx src/cli.ts devices     # prints the command to list your audio devices

npx tsx src/cli.ts live --device "CABLE Output (VB-Audio Virtual Cable)" \
  --outputs venue,stream --record ./service.jsonl
```

It prints one reviewer URL and one overlay URL per output, each with a token.
Point vMix Browser inputs at the overlay URLs; open the reviewer page on a
tablet.

**`/operator`** — the reviewer page. Gujarati above English at reading size,
one button ("Don't show this"), a bar that drains to show the time left, and a
clearly separated "Turn captions off".

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

`soniox.contextTerms` and `soniox.translationTerms` are where deity names,
proper nouns and scriptural terms go, so they come back the same every week:

```json
"contextTerms": ["Swaminarayan", "Vachanamrut", "satsang"],
"translationTerms": [{ "source": "સેવા", "target": "seva" }]
```

Both are empty by default. Filling them in as you spot problems is the main
reason to run this weekly — see [SPEC.md](SPEC.md) §5.

---

## Troubleshooting

**`SONIOX_API_KEY is not set`**
`.env` is missing or the key line is empty. `cp .env.example .env` and paste
your key.

**`DATABASE_URL is not set`**
Same file. It should already contain the `postgresql://...5433/...` line from
`.env.example`.

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

---

## Project layout

```
src/
  cli.ts              command-line entry point
  config.ts           reads config.json, resolves credentials from the environment
  audio/              ffmpeg audio extraction
  soniox/             async API client
  segments/build.ts   tokens → subtitles. The core; shared by every phase
  srt/format.ts       subtitles → .srt text
  db/                 Postgres access
  search/             chunking, embeddings, vector search
  live/               real-time bridge: capture, websocket, queue, adapters
  commands/           one file per CLI command
public/
  operator.html       reviewer page
  overlay.html        on-air caption block
prisma/schema.prisma  database schema
docs/                 architecture and vMix routing
test/                 158 tests
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

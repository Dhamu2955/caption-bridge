# caption-bridge

Translated subtitles for live and recorded video — Soniox speech translation, SRT export, vMix and OBS output.

See [SPEC.md](SPEC.md) for the full build specification.

**Built:** phase 1 (async ingest), phase 2 (Postgres persistence), phase 3
(search), phase 4 (backfill), and phase 5's bridge core — capture, real-time
client, line builder, caption queue, stub and vMix adapters.

**Not built:** the phase 5 UI. `operator.html` and the `/overlay` page do not
exist. The adapters that would feed them do.

See [docs/vmix-routing.md](docs/vmix-routing.md) for how audio reaches the
bridge and captions get back to air.

## Setup

```sh
npm install
cp .env.example .env           # then paste your key from console.soniox.com
docker compose up -d           # Postgres 16 + pgvector on 127.0.0.1:5433
npx prisma migrate deploy
```

Credentials are read from the environment, never from `config.json`. `.env` is
gitignored and loaded automatically; a shell `export SONIOX_API_KEY=...` takes
precedence over it.

Needs Node 20.12+, `ffmpeg` on PATH (`brew install ffmpeg`), and Docker.

The database binds to **port 5433**, not the usual 5432, so it cannot collide
with another Postgres already running on the machine. It listens on the
loopback interface only (§9).

## Usage

```sh
npx tsx src/cli.ts ingest ./sermon-2026-08-16.mp4 \
  --speaker "Swami Ji" --date 2026-08-16
```

Trim the video to the sermon *before* running this (INVARIANT 1) — timestamps
come out relative to the file you hand it, so a trimmed input needs no offset.

Writes three files beside the video, plus a cached copy of the raw Soniox
response so re-runs are free and byte-identical:

```
sermon-2026-08-16.en.srt          projected
sermon-2026-08-16.gu.srt          source track — YouTube, accessibility, checking a line
sermon-2026-08-16.segments.json   shaped for the phase-2 Postgres import
sermon-2026-08-16.soniox.json     raw transcript cache; delete or --force to re-transcribe
```

| Flag | |
|---|---|
| `--speaker <name>` | required |
| `--date <YYYY-MM-DD>` | required |
| `--title <text>` | optional service title |
| `--force` | re-transcribe even if a cached transcript exists |
| `--no-db` | write files only, skip the database |
| `--replace-edited` | overwrite segments even if they carry human corrections |
| `--config <path>` | defaults to `config.json` |

### Search

```sh
sermon-captions index                  # all services, or pass one
sermon-captions search "what does devotion require" --limit 5
```

Embeddings run locally (`Xenova/multilingual-e5-small`, 384 dims) — no API key,
nothing leaves the machine. The model downloads on first use. Both languages
are indexed per chunk, so a Gujarati query can hit English text and vice versa.
Hits print a `video.mp4#t=<seconds>` deep link.

**§3 says to ingest ~20 sermons before tuning retrieval**, and that still
stands: chunk size, overlap and cross-language behaviour cannot be judged
against one service.

### Backfill

```sh
# §4: push the three WORST recordings through first — it can rescope the project
sermon-captions backfill ./archive --speaker "Swami Ji" --only worst --limit 3

sermon-captions backfill ./archive --speaker "Swami Ji"
sermon-captions backfill ./archive --speaker "Swami Ji" --retry-failed
```

Dates are read from filenames (`sermon-2026-08-16.mp4`); `--date` is the
fallback. State is written to `.backfill-state.json` after every file, so an
interrupted run resumes and a failure never stops the batch.

### Corrections

Segments in Postgres are the source of truth (INVARIANT 2). Fix a line there
and re-export — **never hand-edit an SRT**, the next export overwrites it (§8).

```sh
sermon-captions list                                  # services and their ids
sermon-captions show   ./sermon.mp4 --from 40 --limit 5
sermon-captions edit   ./sermon.mp4 --cue 42 --text "Corrected line."
sermon-captions export ./sermon.mp4                   # SELECT → format
```

`edit` takes the **cue number from the SRT** (1-based). It records `editedBy`,
`editedAt` and the text it replaced. Re-ingesting a service that carries
corrections is refused unless you pass `--replace-edited`, so a routine re-run
cannot silently destroy a reviewer's work.

## Tuning

Everything that shapes cue boundaries lives in `config.json` under `ingest`, so
tuning against real sermons is a config edit rather than a code change.

| Setting | Default | |
|---|---|---|
| `pauseMs` | 4000 | silence that ends a cue — lower it if cues run together across a real break |
| `maxChars` | 138 | cap on translated characters per cue |
| `maxSegmentMs` | 20000 | hard cap on cue duration |
| `minDisplayMs` | 1500 | INVARIANT 4 — shorter cues are merged, never shown |
| `maxLineChars` | 46 | wrap width |
| `maxLines` | 3 | lines per cue |

**Keep `maxChars` ≈ `maxLines × maxLineChars`.** `maxLines` is a hard cap, so
when a cue holds more text than the line budget fits, the last line overruns
`maxLineChars` rather than dropping words. Setting `maxChars` to 170 against a
2×48 budget produced 98-character lines.

`soniox.contextTerms` and `soniox.translationTerms` are where deity names,
proper nouns and scriptural terms go so they come back the same every week.
`translationTerms` takes `{ "source": "...", "target": "..." }` pairs.

## Tests

```sh
npm test          # database tests skip themselves if Postgres is not running
npm run typecheck
```

## Two things about the Soniox token stream

Both were found by running a real 69-minute sermon through the tool, and both
are invisible on small or synthetic inputs. `src/segments/build.ts` depends on
them; `test/fixtures/tokens.sermon.json` reproduces the real shape.

**Tokens are sub-word pieces, and a leading space is the only word delimiter.**
`["અ","ક્ષ","ર"]` is the single word `અક્ષર`; `["The"," l","ord"]` is
`The lord`. Never insert a separator when joining, and never split a cue at a
token whose successor lacks a leading space — that cuts a word in half. Soniox
also emits a bare `" "` as a standalone token: it looks empty but it is a word
boundary, and discarding it fuses two words together.

**Translated tokens carry `start_ms: 0` and `end_ms: 0`.** The fields are
present but meaningless — SPEC §4 says translated tokens have "no timestamps",
which is true in spirit but not literally. Reading them at face value would
drag every cue to `00:00:00`. Timing comes from the spoken run, always.

## Three deviations from SPEC.md

**§4 says two lines maximum per SRT cue; the default is now three.** Chosen
deliberately after reviewing a real sermon: at two lines, 62% of cues ended on
a full stop, so single sentences were routinely split across three captions.
Three lines takes that to 83% with the cue count dropping 776 → 594. Reading
rate is unchanged (p50 15.1 chars/sec) because longer cues also stay up
longer — the cost is screen area, not legibility. `maxLines: 2` restores the
original behaviour, and pop-on, immutability and the 1500ms floor are all
untouched. Revisit this before phase 5: a venue overlay has less room than a
projected SRT.

**§4 says `editedBy` is "hardcoded to `local`"; untouched segments say
`soniox` instead.** The intent of §4 is that no correction ever needs
backfilling, and a non-null `editedBy` on every row achieves that — but
stamping `local` on 594 machine-generated segments would claim a person wrote
them. So the column is non-null from day one and records provenance: `soniox`
as transcribed, `local` once a human edits it, a real identity when auth
arrives (§9). `editedAt IS NULL` is the precise test for "never touched".

**§4 says to break segments on endpoint detection.** That feature does
not exist in the Soniox async API — `enable_endpoint_detection` and the `<end>`
token are real-time session parameters, and an async transcript is a flat token
stream with no segment markers. Cue boundaries here come from sentence-final
punctuation, a configurable pause threshold (`ingest.pauseMs`), speaker changes
from diarization, and the size caps. Phase 5 will use real endpoint detection
and should share `src/segments/build.ts` rather than fork it.

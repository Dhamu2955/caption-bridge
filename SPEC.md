# Sermon Captions — Build Specification

Gujarati→English subtitles for mandir sermons, using Soniox speech translation.

Read this fully before writing code. Sections marked **INVARIANT** are decisions that are expensive to reverse — raise it before changing one.

**Scope for now: localhost only.** No HTTPS, no auth, no containers, no deployment. See §9.

---

## 1. Usage reality (this drives the phase order)

| Workload | Frequency | Hours/year | Pipeline |
|---|---|---|---|
| Sermons ripped from other mandirs' YouTube streams, played back on a projector | ~45 Sundays | ~68 | **async** |
| Own live festival broadcast | 7 days × 2 hours, once a year | 14 | **real-time** |

The async path is the weekly workhorse. The live path runs 14 hours a year.

Build the async tool first. It is smaller, produces nearly all the value, and a year of running it will tune the translation terms and prove Soniox's Gujarati quality before any of the hard real-time work begins.

Total API cost is roughly **$15/year**, plus a one-off ~$100–150 to backfill the archive. Cost is not a design constraint anywhere in this project.

---

## 2. Guiding principles

### INVARIANT 1 — Trim first, transcribe second

Cut the video down to the sermon **before** transcribing. Timestamps then come out relative to the trimmed file, so there is no offset to track and nothing to align.

```
3hr stream recording ─┐
                      ├─→ trim to sermon.mp4 → extract audio → Soniox async → segments → SRT
YouTube rip ──────────┘
```

Both sources converge immediately. One ingest pipeline, not two.

If someone insists on transcribing an untrimmed file, store `trimStartMs` on the service record and subtract at export — but design the happy path as trim-first.

### INVARIANT 2 — Three artifacts, one direction of flow

```
video (.mp4)     never modified, never re-encoded
   ↓
segments (DB)    source of truth, editable, attributed
   ↓
subtitles (.srt) generated artifact, disposable, regenerate anytime
```

Corrections go in the **database**. A hand-edited SRT is lost on the next export.

### INVARIANT 3 — Never burn subtitles into video

External SRT alongside the file. vMix loads it at playback. Burn-in is a one-way door and makes corrections impossible without re-encoding.

```
sermon-2026-08-16.mp4
sermon-2026-08-16.en.srt   ← projected
sermon-2026-08-16.gu.srt   ← generated anyway: YouTube, accessibility, checking a suspect line
```

### INVARIANT 4 — Pop-on captions, never roll-up

**This came from watching a real deployment fail.** Another mandir ran live translation rendering partial results, and the text visibly rewrote itself mid-sentence. It was disorienting enough to be worse than no captions.

The cause is structural, not cosmetic. **Gujarati is verb-final; English is not.** Until the verb arrives at the end of a Gujarati clause, the English translation genuinely cannot be known — so when it lands, the model does not tweak a word, it restructures the entire sentence. No amount of fading or dimming hides that.

Broadcast captioning has two conventions: *roll-up* (words appear as spoken) and *pop-on* (a complete block appears at once). Roll-up is only honest when word order is preserved between languages. **This pipeline is pop-on, everywhere.**

Three rules, enforced in code:

1. `includeNonFinal: false` on **every** output, venue screens included. Non-final tokens are used for operator preview only, never for display
2. **A displayed line is immutable.** A late revision creates a new line; it never edits one already on screen
3. **Minimum display time ~1500ms.** Queue fast clauses rather than flashing them

Cost is ~2–4s of latency at the venue rather than ~1.5s. Nobody notices when they can hear the speaker. Rewriting text, they notice immediately.

---

## 3. Stack

- Node 20+, TypeScript, ESM
- ffmpeg as a child process (trimming, audio extraction)
- PostgreSQL + Prisma; pgvector from phase 2
- Vitest
- Phase 5 only: `ws`, Express

No bundler. Run with `tsx`. Postgres via Docker or Homebrew — local only for now.

---

## 4. Phases

### Phase 1 — Async ingest + SRT export

**The weekly tool.** A CLI that takes a video file and produces subtitles. No web surface, no database yet — write JSON to disk.

```
sermon-captions ingest ./sermon.mp4 --speaker "..." --date 2026-08-16
```

Steps:
1. ffmpeg extract audio → 16kHz mono WAV
2. Submit to the Soniox **async** endpoint with `one_way` translation, `target_language: "en"`, `language_hints: ["gu","en"]`, diarization and language ID on
3. Poll until complete
4. Parse tokens into segments
5. Write `<basename>.en.srt`, `<basename>.gu.srt` and `<basename>.segments.json` beside the video

**Token parsing (shared with every later phase):**

Tokens arrive tagged with `translation_status`:
- `"original"` / `"none"` → source language, **carries `start_ms`/`end_ms`**
- `"translation"` → target language, **no timestamps**

Accumulate separately — they are not 1-to-1 and do not align. Segment timing comes from the spoken tokens; the translation inherits it.

**Segment boundaries:** break on endpoint detection, or when the translation exceeds ~120 characters, whichever comes first. Two lines maximum per SRT cue. Enforce the 1500ms minimum duration from INVARIANT 4 here too — merge cues that would flash.

**Acceptance:**
- `ingest sermon.mp4` produces a valid SRT that plays in sync in VLC
- Re-running is idempotent — same input, byte-identical SRT
- Handles a 90-minute file without loading it all into memory
- No cue shorter than 1500ms

**Do not** substitute local Whisper. A split corpus with two quality regimes makes later search behave inconsistently across the archive.

### Phase 2 — Persistence

Move segments into Postgres so they become editable.

```
service   id, date, speaker, title, source (rip|live), videoPath, durationMs, trimStartMs
segment   serviceId, index, original, translation, startMs, endMs, speaker,
          editedBy, editedAt, previousTranslation
```

- SRT export becomes `SELECT` → format. Regenerating after a correction is one command
- **`editedBy` is required from day one**, hardcoded to `"local"` until auth exists. Adding it later means backfilling nulls across every correction already made and losing all attribution
- Retain `previousTranslation` on edit — corrections are the whole reason the DB is the source of truth

### Phase 3 — Search

- Chunk **above** segment level: 1–3 minute passages with overlap, keeping the first segment's `startMs` as the seek target. Individual segments are too granular to retrieve against
- Embed **both** languages per chunk, so a Gujarati query can hit an English-indexed passage
- Deep links: search hit → `video.mp4#t=<startMs/1000>`

**Order note:** ingest ~20 sermons before tuning retrieval. Chunk size, overlap and cross-language embedding cannot be evaluated against three services' worth of text.

### Phase 4 — Backfill

Same ingest tool, pointed at the archive. Batch runner with resume-on-failure.

**Before any bulk run:** push the three *worst-quality* old recordings through and read the output. Old room-mic recordings may be unusable, which would scope the backfill to whatever era has a clean desk feed. Find that out early — it changes the project.

### Phase 5 — Live bridge (build before next festival week)

Real-time captions for the one week a year you broadcast. A separate service sharing the token-parsing and segment model, nothing else.

A partial skeleton exists — treat it as the intended shape:

```
src/live/types.ts                 CaptionLine, OutputConfig, OutputAdapter
src/live/pipeline/queue.ts        CaptionQueue — multi-output scheduler (the core)
src/live/pipeline/lineBuilder.ts
src/live/soniox/client.ts         WebSocket client, reconnect, JSONL recorder
operator.html                     reviewer UI — see §7
```

#### Live invariants

**INVARIANT 5 — Audio is tapped pre-delay.** The delay must sit between the audio tap and the caption compositing point. Delaying the whole program output achieves nothing, since captions get delayed equally and the relative offset is unchanged.

```
Mic ──┬─→ vMix Bus B ──→ virtual audio device ──→ bridge   (LIVE)
      └─→ program video ──→ Video Delay 30s ──→ compositing ──→ stream
```

**INVARIANT 6 — Route only the speaker's mic, never Master.** Tapping Master feeds Soniox music, VT audio and congregation noise. A dedicated bus is the largest accuracy win available and costs nothing.

**INVARIANT 7 — Delay is per-output, not global.** One session, many subscribers:

| Output | Delay to air | Non-final | Reviewed | Composites |
|---|---|---|---|---|
| `stream` | A + B ≈ 29000ms | no | yes | **two** |
| `reviewer` | A ≈ 4000ms | no | n/a | one |
| `venue` | A ≈ 4000ms | no | no | one |
| `overflow` | A ≈ 4000ms | no | no | one |
| `stub` | 0ms | no | no | none |

Every output is `includeNonFinal: false` per INVARIANT 4. Non-final tokens exist only to give the reviewer an early textual preview, never to display.

Cost scales with **sessions**, not outputs. Needing a second Soniox connection to feed another screen is a design error.

**INVARIANT 8 — The reviewed path has two delay stages, not one.**

The public stream's delay is two separate delays doing two different jobs. Collapsing them into a single 30s figure breaks review entirely.

- **Delay A — assembly (~4s).** Pop-on means a caption cannot be shown until its clause is final, which lands ~2–4s behind the audio. Video must be held by A so the caption sits on the right words. This is the floor for captions existing at all
- **Delay B — review (~25s).** Time on top of A for the reviewer to read the Gujarati/English pairing and act

```
live audio ──→ Soniox ──→ captions ──┐
                                     │
video ──→ [delay A] ──→ COMPOSITE 1 ──→ reviewer feed
                                     │
              caption + video held separately through [delay B]
                                     │
                             COMPOSITE 2 ──→ air
```

**Why two composites.** The reviewer must see video and caption together to judge them, so composite 1 happens at A. But a drop has to be actionable *during* window B, after that composite has already happened. If delay B buffered the composited reviewer feed, a drop would mean un-burning pixels.

So delay B holds the caption and the video **separately** and composites again at the far end, applying the reviewer's decisions at composite 2. The reviewer sits between the two stages — that is the entire point of the arrangement.

Single-stage outputs (`venue`, `overflow`) composite once at A and are never reviewed.

**Status: designed, not built or validated.** The vMix-side arrangement for two composite stages needs working through against the actual switcher before phase 5 begins — likely two Mix outputs with independent Video Delay inputs, but confirm it. Do not implement phase 5 from this section without revisiting it first.

**INVARIANT 9 — Schedule against audio timestamps.**

```
releaseAt = sessionEpoch + line.audioStartMs + output.delayMs

where for the reviewed path  output.delayMs = delayA + delayB
```

Never `arrivalTime + delay`. Arrival time accumulates jitter and drifts over a 2-hour broadcast.

**INVARIANT 10 — The scheduler owns the clock; the reviewer is advisory.**
- Operator disconnect does not stall releases
- A `drop` arriving after the release deadline is rejected, not retroactively applied
- "No operator connected" and "operator connected but idle" must produce identical output

#### Live components

- ffmpeg capture from a named device → PCM s16le 16k mono
- Soniox real-time WebSocket with reconnect and backoff; emit `gap` with outage duration
- `LineBuilder` → `CaptionQueue` → adapters (`stub`, `browser`, `vmix`)
- Overlay page: pop-on caption block, immutable once shown, 1500ms minimum
- Late release: if a line becomes due more than 2000ms after schedule, **skip it** — a desynced caption is worse than none. Emit `skipped`
- **Reviewer feed**: a composited video+caption output at delay A, delivered to the reviewer over the LAN or a tunnel. This is what they judge against — text alone loses tone and context
- A drop received during window B must remove the caption at composite 2 without touching the video
- Write every raw Soniox response to JSONL as `{ at, res }`, plus service metadata and operator actions. This is **not** the source of subtitles — those come from a clean async pass on the trimmed recording, which has whole-file context and reads better. The JSONL records what went to air, and the operator's drops form a labelled set of human-judged bad translations

#### vMix specifics

- GT title text fields need `.Text` appended to `SelectedName`
- Reference inputs by GUID, never number — numbers break when inputs are reordered
- Rate-limit `SetText` to ~5/sec; titles chug under heavier load
- Prefer the browser overlay for captions; use the HTTP API for overlay in/out and health checks
- **Verify by readback, not status code.** A mistyped `SelectedName` still returns 200. `GET http://127.0.0.1:8088/api/` with no parameters returns state XML containing actual field contents. Write this as an integration test — it catches the `.Text` requirement immediately

---

## 5. Configuration

Config file from day one, even on localhost. Deployment later becomes a different config file rather than a search-and-replace.

```json
{
  "soniox": {
    "apiKeyEnv": "SONIOX_API_KEY",
    "sourceLanguages": ["gu", "en"],
    "targetLanguage": "en",
    "contextTerms": [],
    "translationTerms": []
  },
  "paths": { "media": "./media", "recordings": "./recordings" },
  "database": { "urlEnv": "DATABASE_URL" },
  "server": { "host": "127.0.0.1", "port": 3000 },
  "live": {
    "delayAssemblyMs": 4000,
    "delayReviewMs": 25000,
    "minDisplayMs": 1500,
    "lateSkipMs": 2000
  }
}
```

`context.translation_terms` is where proper nouns, deity names and scriptural terms go so they translate consistently. Expose it in config — it will need tuning against real sermons, and phase 1 running weekly is how that tuning happens.

No credentials in `config.json`. Environment variables only; `.env` in `.gitignore`.

---

## 6. Testing

- **Unit:** token separation, timestamp inheritance, segment boundaries, minimum-duration merging, SRT formatting (timecode edge cases, cue overlap)
- **Integration:** fixture token payload → expected SRT, byte-for-byte
- **Phase 5 unit:** `CaptionQueue` release timing, drop semantics, hold/resume, late-skip, eviction, immutability of shown lines. Inject a fake clock — no `setTimeout` sleeps in tests
- **Phase 5 integration:** replay a JSONL fixture through the stub adapter, assert exact release sequence; vMix XML readback round-trip (skipped when vMix unreachable)

---

## 7. Reviewer UI

`operator.html` is a working design reference. Match its constraints, not necessarily its markup.

**The users are dharma team volunteers, not engineers.** Design accordingly:

- **One primary action: "Don't show this."** Everything else runs automatically. Auto-approve by default; nobody sustains per-line approval for 90 minutes
- **Gujarati above English at reading size.** The pairing *is* the interface — a reviewer cannot judge a translation without the source
- **Video with the caption already composited**, at delay A. Judging a line without seeing what the speaker is doing loses tone and context. `operator.html` is currently text-only and needs the video pane adding for phase 5
- **No jargon on screen.** No tokens/sec, no RTT, no socket state. Connection health is a single coloured dot with plain-English text
- **Countdown is a draining bar**, not a number to interpret
- Secondary actions: pause captions, and a clearly separated "captions off" for the panic case
- Must work on a tablet — large touch targets, responsive down to phone width

Audio monitoring for the reviewer (streaming captured PCM over the same socket) is worth adding when the live phase arrives — text alone is hard to judge without tone.

---

## 8. Anti-patterns

- **Do not** render non-final tokens to any audience-facing surface
- **Do not** edit a caption line that has already been displayed
- **Do not** burn subtitles into video
- **Do not** hand-edit SRT files — corrections go in the database
- **Do not** substitute local Whisper for any transcription
- **Do not** optimise for API cost. The whole year is ~$15. No caching, no voice-activity gating, no architectural compromise to trim usage
- **Do not** build the live bridge first. It runs 14 hours a year
- **Do not** use `localStorage`/`sessionStorage` in overlay or reviewer pages
- **Do not** add a global delay constant in phase 5 — delay is per output
- **Do not** let the reviewer UI sit in the critical path
- **Do not** rely on HTTP status codes to confirm vMix received text
- **Do not** buffer stale audio during a reconnect — drop it

---

## 9. Deferred: auth and deployment

Explicitly **out of scope** for now. Localhost, single user, no login. Recorded here so it is not designed against by accident later.

When it lands:

- **Roles:** `viewer` (read archive, search) / `operator` (+ live review) / `admin` (+ ingest, edit segments, manage users)
- **Do not roll your own password handling.** Prefer OIDC against the mandir's Google Workspace if one exists — no password storage, no reset flow, offboarding by disabling the Google account. Tailscale is a good alternative for operator-only surfaces
- **The overlay page can never require interactive login.** vMix's Browser input cannot type credentials; any redirect to a login form silently kills captions on air. Protect it by binding to localhost/LAN plus a signed token in the URL, rotated per event, never mid-service
- Never port-forward the reviewer UI — it carries live broadcast content ahead of air
- Postgres backed up off-host nightly. Videos and SRTs are regenerable; the translation corrections people made by hand are not

Two things to honour **now** so the retrofit is cheap: config-file-driven settings (§5), and `editedBy` on segment edits (§4, phase 2).

---

## 10. Development environment

vMix is Windows-only; development happens on macOS. **Phases 1–4 need no Windows at all.**

For phase 5:
- Soniox client, line builder, queue, adapters — native Node on macOS
- Caption rendering — Chrome on macOS. vMix's Browser input is Chromium, so what renders in Chrome is what goes on air
- vMix adapter — develop against the `stub` adapter, which logs every `SetText` with a timestamp
- Virtual audio: BlackHole on macOS, VB-Cable or VoiceMeeter on Windows
- Windows is needed only for final integration: confirming the GT title path and that the browser input keys correctly

Build order must never block on Windows availability.

---

## 11. Build order summary

1. **Ingest CLI + SRT export** — video in, subtitles out. Start here
2. **Postgres + editable segments + regenerable SRT**
3. **Search** — after ~20 sermons are ingested
4. **Backfill** — worst-quality samples first, then bulk
5. **Live bridge** — before next festival week

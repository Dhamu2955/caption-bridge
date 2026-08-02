# vMix routing — audio in, captions out

SPEC §4 phase 5 says the vMix arrangement for two composite stages "needs
working through against the actual switcher before phase 5 begins… likely two
Mix outputs with independent Video Delay inputs, but confirm it."

This is that working-through. **Everything marked ⚠ still needs confirming on
the actual Windows machine** — no vMix was available while writing it.

---

## 1. The shape of it

Audio does **not** pass through the bridge and back. It is *tapped*, one way.
What returns to vMix is a caption overlay, as video.

```
pulpit mic ──┬─→ vMix Bus B ──→ virtual cable ──→ ffmpeg ──→ Soniox ──→ bridge
             │                                                            │
             └─→ program video ──→ Video Delay ──→ composite ──→ air ←─────┘
                                                   (captions overlaid here)
```

Nothing the bridge does can interrupt the audio path. If the bridge dies
mid-service the audio is untouched and the only loss is captions — which is
the correct failure mode for something running in front of a congregation.

---

## 2. Audio out of vMix

**Confirmed from vMix docs:** vMix supports "up to eight independently
controllable audio outputs", being Master plus auxiliary buses **A–G**, each
configurable as an independent mix.

That is exactly what INVARIANT 6 needs — a bus carrying the speaker's mic and
nothing else. Tapping Master would feed Soniox the music, VT audio and
congregation noise, and is the single biggest accuracy loss available.

### Setup

1. Install **VB-CABLE** (or VoiceMeeter) on the vMix machine. It creates a
   paired device: `CABLE Input` (a playback device) and `CABLE Output` (a
   recording device).
2. In the vMix Audio Mixer, put **only** the pulpit mic input on **Bus B**.
   Take it off Master only if you do not also need it on air — normally the mic
   sits on both Master and Bus B.
3. `Settings → Audio Outputs` → set **Bus B** to render to `CABLE Input`.
4. The bridge captures from `CABLE Output`:

```powershell
# find the exact device name first — it must match character for character
ffmpeg -list_devices true -f dshow -i dummy

sermon-captions live --device "CABLE Output (VB-Audio Virtual Cable)"
```

On macOS during development the equivalent is BlackHole:

```sh
ffmpeg -f avfoundation -list_devices true -i ""
sermon-captions live --device ":BlackHole 2ch" --format avfoundation
```

`src/live/capture.ts` builds these argument lists and is unit-tested for both
platforms.

### The failure this catches

A virtual cable that is connected but silent looks identical to a speaker who
has stopped talking. The capture emits an RMS `level` event per chunk for
exactly this reason — §7 wants a level meter on the operator screen, and it is
what tells you the cable died rather than the sermon pausing.

---

## 3. Captions back into vMix

Two routes, and §4 is right that the browser overlay is the better one.

### Browser input (preferred)

vMix's Browser input is Chromium, so what renders in Chrome on macOS renders on
air. The bridge serves an overlay page and pushes lines over a WebSocket. **The
page itself is the UI work that stops at this session's boundary** — the
adapter side is built, the page is not.

Because the overlay is a URL, the per-output delay of INVARIANT 7 costs nothing
extra: `?output=venue` and `?output=stream` are two browser inputs fed by one
Soniox session.

The overlay must never require interactive login (§9) — a Browser input cannot
type credentials, and a redirect to a login form silently kills captions on
air. Bind to localhost plus a signed token in the URL.

### GT title via HTTP API

Implemented in `src/live/adapters/vmix.ts`, with all four §4 traps handled:

| Trap | Handling |
|---|---|
| GT text fields need `.Text` appended to `SelectedName` | `selectedName()` appends it; a test pins it |
| Reference inputs by GUID, never number | the adapter takes `inputGuid` and has no number path |
| Rate-limit `SetText` to ~5/sec | serialised queue, `minIntervalMs` default 200 |
| A mistyped `SelectedName` still returns 200 | `readBack()` parses `GET /api/` state XML; `verify()` compares |

`verify()` is the one that matters. Status codes prove nothing here.

---

## 3b. Sunday playback — captions on a recorded sermon

The weekly job is a recorded sermon on a projector, not a live broadcast, and it
needs its own answer. **vMix's Video input does not load a sidecar `.srt`** the
way VLC does — SPEC INVARIANT 3 used to imply it did, and that has been
corrected.

### `sermon-captions play` (preferred)

```sh
npx tsx src/cli.ts play ./sermon-2026-08-16.mp4 --input <vmix-input-guid>
```

Polls `GET /api/` four times a second, reads the playing input's `position`, and
pushes whichever cue spans that millisecond to the overlay page. Point a vMix
Browser input at the overlay URL it prints.

Because it is position-driven rather than clock-driven, **pause, seek and
restart need no handling** — every poll asks vMix where the file actually is.
Cues come from the database, so a correction made with `edit` on Saturday is on
screen on Sunday with no `export` in between.

`--caption-input <guid>` drives a vMix GT title instead of the browser overlay,
for a night when the Browser input misbehaves.

Do **not** use vMix Data Sources polling an endpoint for this. vMix would own
the refresh timing, which breaks INVARIANT 9's per-output scheduling and cannot
express a drop.

### VLC input (zero-code fallback)

vMix's VLC input plays through libVLC, which does understand subtitles. Add the
sermon as a **VLC input** rather than a Video input and pass:

```
--sub-file=/path/to/sermon-2026-08-16.en.srt
```

VLC renders the subtitles into the frames, so they cannot be styled to match the
live overlay or keyed separately, and the VLC input is less frame-accurate than
the native Video input. It is the "we need something this Sunday" option.

---

## 4. The two composite stages (INVARIANT 8)

This is the part §4 flagged as unresolved, and it turns out to be **simpler
than the diagram suggests**.

### The key realisation

You do not need to chain delays in vMix, and you do not need to delay a
composited feed and then un-composite it.

Because the bridge schedules each output independently against audio
timestamps (INVARIANT 9), the caption for a given moment is simply *released
later* to the stream output than to the reviewer output. So both composites are
first composites — they just happen at different times, on differently-delayed
video.

```
                    ┌─→ Video Delay A  (4s)  ─┐
camera ─────────────┤                         ├─→ Mix 1 ─→ reviewer feed
                    │   browser: reviewer  ───┘
                    │
                    ├─→ Video Delay A+B (29s) ─┐
                    │                          ├─→ Mix 2 ─→ air
                    └─→ browser: stream  ──────┘
```

**Two independent Video Delay inputs from the same camera**, at 4s and 29s. Not
a 4s delay feeding a 25s delay. Two browser overlay inputs, one per output.
Two Mix outputs.

A reviewer's drop lands in the bridge during window B. The stream output has
not released that line yet, so it is simply never sent to the `stream` overlay.
Nothing needs un-burning, because the pixels were never burned. That is exactly
what `CaptionQueue.drop()` does, and `drop-rejected` covers the case where the
decision arrives too late.

### What this needs on the vMix side

- ⚠ **Mix 2 requires vMix 4K or Pro.** vMix HD has a single mix. Check the
  licence before relying on this.
- ⚠ **Video Delay source.** The docs say a Video Delay takes "either Output or
  an Input such as a Video Camera", so pointing two delays at one camera should
  be fine. Confirm both can run at once at your resolution.
- ⚠ **Memory for a 29-second delay.** vMix's own guidance suggests delay memory
  scales with bitrate rather than raw frames (a forum answer cites ~1 MB/s for
  an 8 Mbps stream, so ~30 MB for 29 s). That seems low for uncompressed video;
  measure it before the festival rather than discovering it on the day.
- ⚠ **Audio for the delayed feeds.** The captions land on delayed video, but
  the *audio* going to air must be delayed by the same amount or lips will not
  match. Confirm whether the Video Delay input carries its own audio or whether
  Master needs a matching delay.

### What phases 4 and 5 changed about all this

Two things, and together they remove most of the arrangement above for the
public stream.

**YouTube closed captions are never burned in.** `live --youtube-captions <url>`
POSTs each released English line to YouTube's caption ingestion endpoint, synced
by timestamp. The video path carries no captions, so there is nothing to
un-burn, so there is no second composite and no second mix. A reviewer's drop
means the POST simply never happens. Mix 2 and the ⚠ licence question above
apply only if you burn captions into the picture instead.

**A minutes-long delay cannot live in vMix's Video Delay.** The review window
now defaults to three minutes (tunable to ten), because at 25 seconds a reviewer
can only drop a line — reading the Gujarati, judging the English and typing a
correction does not fit. But Video Delay buffers uncompressed frames in RAM; the
~30 MB estimate above is for 29 seconds, and ten minutes is orders of magnitude
more. Move the long delay **after the encoder**, where it is compressed:

```
mic ──→ bridge ──→ Soniox ──→ queue ── held ~3 min, drops and edits applied ──→ POST to YouTube
vMix ──→ encoder ──→ compressed buffer (~3 min) ──→ RTMP to YouTube
```

- **OBS stream delay** — built for exactly this, buffers the encoded output
- **Disk relay** — record the encoder output and start `ffmpeg -re` on the
  growing file N minutes later. Effectively unlimited, survives a long festival

`--stream-offset <ms>` must match whatever delay you choose: it is what puts the
caption on the right moment of YouTube's timeline. Calibrate it on a private
test stream — along with the ingestion wire format, which is the one part of the
live-caption path not verifiable from the code.

The venue and overflow screens are untouched by all of this. They stay on
assembly delay (~4s) with the browser overlay composited once, because a
congregation in the room cannot watch captions three minutes behind the speaker.

### Simplification worth considering

If the reviewer feed turns out to be expensive — a second mix, a second delay,
a second overlay — note that the venue and overflow outputs are unreviewed and
need only delay A. The reviewed stream path is the only thing that needs the
full arrangement. Running the first festival **unreviewed** (venue + overflow +
stream all at delay A) would be a smaller step, and the bridge supports it
today: drop the `stream` output's delay to `delayAssemblyMs` in config and
nothing else changes.

---

## 5. Order of validation

Do these in order. Each one rules out a class of failure before the next.

1. **Cable, silent.** Play anything through Bus B; confirm the control page's
   level meter moves — or `sermon-captions live --device … --output stub` shows
   a non-zero level. Proves the routing.
2. **Cable, speech.** Confirm lines appear in the stub log with sensible text.
   Proves Soniox is getting clean audio.
3. **Browser overlay in Chrome on macOS.** Proves rendering before Windows is
   involved at all.
4. **Browser input in vMix.** Proves the Chromium path.
5. **GT readback.** `verify()` against a real title. Proves the `.Text` trap.
6. **Playback captions.** `play` against a Video input: captions follow the
   file, survive a pause, and jump on a seek. Needs vMix but no festival rig,
   and it exercises the same overlay path the live phase depends on — which
   makes it the cheapest rehearsal available.
7. **YouTube captions on a private stream.** Confirm they appear, then calibrate
   `--stream-offset` until they sit on the right words. Also confirms the
   ingestion wire format, which is the one unvalidated piece.
8. **Two delays, two mixes.** Only needed if you burn captions into the picture
   for the stream; the YouTube CC path does not. The one step that genuinely
   needs the festival hardware.

Steps 1–3 need no Windows, which is the point of §10's build-order rule.

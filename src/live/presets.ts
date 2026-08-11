/**
 * Latency presets — the six settings that decide how soon a caption appears,
 * moved together instead of one at a time.
 *
 * They belong together because they fail together. Dropping the assembly delay
 * on its own does not make captions faster, it makes them disappear: the queue
 * schedules a line for `audioStart + delay`, so a shorter delay puts that
 * instant in the past, and `lateSkipMs` then throws the line away for being
 * overdue. That combination is the single most common way to end up with a
 * silent screen, and it is two settings apart in the form.
 *
 * WHAT NO PRESET CAN DO — see INVARIANT 4 in SPEC.md. There is a floor here
 * that is a fact about the languages, not about the software: Gujarati is
 * verb-final and English is not, so until the verb arrives at the end of a
 * clause the English genuinely cannot be known. Word-by-word captions in the
 * way of an auto-captioned English stream are not a setting that is switched
 * off — the translation does not exist yet to show. A mandir that tried it
 * watched the text restructure itself mid-sentence, and it was worse than no
 * captions at all. So every preset here is pop-on. What they change is how
 * long a *finished* line waits, and how big a chunk we wait for.
 */

export interface LatencyPreset {
  id: string;
  label: string;
  /** One line, shown on the button's row. */
  blurb: string;
  /** What it costs, said out loud rather than discovered on a Sunday. */
  cost: string;
  /** Dotted setting paths to values — the same shape `PUT /api/settings` takes. */
  values: Record<string, number | boolean>;
}

export const LATENCY_PRESETS: readonly LatencyPreset[] = [
  {
    id: 'accurate',
    label: 'Accurate',
    blurb:
      'What the timings were tuned to on a real sermon. Captions land under the words they ' +
      'belong to, and a line that misses its moment is dropped rather than shown late.',
    cost: 'Roughly fifteen seconds behind the speaker, most of it deliberate.',
    values: {
      'live.delayAssemblyMs': 15_000,
      'live.maxBufferMs': 8000,
      'live.minDisplayMs': 1500,
      'live.endpointSensitivity': -0.25,
      'live.maxEndpointDelayMs': 2500,
      'live.skipLateLines': true,
    },
  },
  {
    id: 'fast',
    label: 'As fast as it goes',
    blurb:
      'Every line shown the moment it exists, nothing held back and nothing dropped for ' +
      'being late. Sentences are cut sooner and Soniox is pushed to commit sooner.',
    cost:
      'Sentences get cut mid-thought more often, and pushing Soniox to decide sooner makes ' +
      'it mishear more — a compound word split at the wrong point becomes a different word. ' +
      'Captions also drift further behind if a patch runs slow, because nothing catches up.',
    values: {
      // Not zero. A line still has to reach the queue before its release
      // instant or the very first tick releases it out of order with the one
      // before; a couple of seconds costs nothing and keeps the ordering sane.
      'live.delayAssemblyMs': 2000,
      // The biggest lever on how soon a caption can exist: it cannot exist
      // until the sentence it covers has finished being spoken, so shorter
      // sentences are earlier ones.
      'live.maxBufferMs': 4000,
      'live.minDisplayMs': 1200,
      'live.endpointSensitivity': 0.3,
      'live.maxEndpointDelayMs': 1200,
      // Without this the whole preset shows nothing: at a 2s assembly delay
      // almost every line is already past its moment by the time Soniox has
      // translated it, and skipping would drop the lot.
      'live.skipLateLines': false,
    },
  },
  {
    id: 'chunks',
    label: 'Chunks, as they are said',
    blurb:
      'Cut on the clock rather than at the end of a sentence, so text keeps arriving while ' +
      'someone is still talking. The shortest usable lag this pipeline has.',
    cost:
      'Each chunk is translated without the rest of its sentence, and Gujarati puts the verb ' +
      'at the end — so fragments read stilted and some are simply wrong. Use it where having ' +
      'words continuously matters more than each one being right.',
    values: {
      'live.delayAssemblyMs': 1000,
      'live.maxBufferMs': 2000,
      // Short chunks are merged straight back together above this, which is
      // what makes lowering maxBufferMs alone look like it did nothing.
      'live.minDisplayMs': 800,
      // THE ACTUAL LEVER, and not an obvious one. Our buffer cannot cut
      // smaller than Soniox translates: the builder holds speech until its
      // translation arrives, so a 2s buffer against 4s translation runs still
      // produces 4s chunks. Forcing an endpoint this often is what makes
      // Soniox finalise and translate a short run in the first place.
      'live.endpointSensitivity': 0.6,
      'live.maxEndpointDelayMs': 800,
      'live.skipLateLines': false,
    },
  },
];

export function presetById(id: string): LatencyPreset | undefined {
  return LATENCY_PRESETS.find((preset) => preset.id === id);
}

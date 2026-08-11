import type { AppConfig } from '../config.js';
import type { OutputConfig } from './types.js';

/**
 * The output table from INVARIANT 7. Cost scales with sessions, not outputs —
 * needing a second Soniox connection to feed another screen is a design error.
 *
 * | output   | delay to air    | reviewed | composites |
 * |----------|-----------------|----------|------------|
 * | stream   | A + B ≈ 195000  | yes      | two        |
 * | reviewer | A ≈ 15000       | n/a      | one        |
 * | venue    | A ≈ 15000       | no       | one        |
 * | overflow | A ≈ 15000       | no       | one        |
 * | stub     | 0               | no       | none       |
 *
 * Every one is includeNonFinal: false (INVARIANT 4) — that is not expressed
 * here because it is not configurable.
 */

export type OutputName = 'stream' | 'reviewer' | 'venue' | 'overflow' | 'stub';

export function outputConfigs(config: AppConfig): Record<OutputName, OutputConfig> {
  const { delayAssemblyMs, delayReviewMs, minDisplayMs, lateSkipMs, skipLateLines } = config.live;
  const base = { minDisplayMs, lateSkipMs, skipLate: skipLateLines };

  return {
    // INVARIANT 8 — A and B are two different jobs. A exists so a pop-on
    // caption can sit on the right words; B exists so a human can act. They
    // are added here, never collapsed into a single constant.
    stream: { name: 'stream', delayMs: delayAssemblyMs + delayReviewMs, reviewed: true, ...base },
    reviewer: { name: 'reviewer', delayMs: delayAssemblyMs, reviewed: false, ...base },
    venue: { name: 'venue', delayMs: delayAssemblyMs, reviewed: false, ...base },
    overflow: { name: 'overflow', delayMs: delayAssemblyMs, reviewed: false, ...base },
    stub: { name: 'stub', delayMs: 0, reviewed: false, ...base },
  };
}

export function outputConfig(config: AppConfig, name: OutputName): OutputConfig {
  return outputConfigs(config)[name];
}

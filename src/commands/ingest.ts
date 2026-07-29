import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import type { AppConfig } from '../config.js';
import { resolveApiKey } from '../config.js';
import { extractAudio, withTempDir } from '../audio/extract.js';
import { SonioxAsyncClient } from '../soniox/asyncClient.js';
import type { CreateTranscriptionRequest, Transcript, Transcription } from '../soniox/types.js';
import { buildSegments } from '../segments/build.js';
import type { Segment } from '../segments/types.js';
import { toSrt } from '../srt/format.js';
import { saveService } from '../db/services.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { info, warn } from '../util/log.js';

export interface IngestArgs {
  videoPath: string;
  speaker: string;
  date: string;
  title?: string | undefined;
  /** Re-transcribe even when a cached transcript exists. */
  force: boolean;
  /** Overwrite segments even if some carry human corrections. */
  replaceEdited?: boolean;
}

export interface IngestResult {
  segments: Segment[];
  outputs: { targetSrt: string; sourceSrt: string; segmentsJson: string; cache: string };
  cached: boolean;
  durationMs: number | undefined;
  /** Set when the run was persisted. */
  serviceId?: string;
  createdService?: boolean;
}

/** Everything written next to the video, keyed off its basename. */
interface OutputPaths {
  targetSrt: string;
  sourceSrt: string;
  segmentsJson: string;
  cache: string;
}

/** Raw Soniox response, cached beside the video so re-runs are free and identical. */
interface CachedTranscript {
  request: CreateTranscriptionRequest;
  transcription: Pick<Transcription, 'id' | 'model' | 'audio_duration_ms' | 'created_at'>;
  transcript: Transcript;
}

export function outputPaths(videoPath: string, config: AppConfig): OutputPaths {
  const dir = dirname(resolve(videoPath));
  const stem = basename(videoPath, extname(videoPath));
  const source = config.soniox.sourceLanguages[0] ?? 'src';
  const target = config.soniox.targetLanguage;
  return {
    targetSrt: join(dir, `${stem}.${target}.srt`),
    sourceSrt: join(dir, `${stem}.${source}.srt`),
    segmentsJson: join(dir, `${stem}.segments.json`),
    cache: join(dir, `${stem}.soniox.json`),
  };
}

export function buildRequest(config: AppConfig, fileId: string): CreateTranscriptionRequest {
  const request: CreateTranscriptionRequest = {
    model: config.soniox.model,
    file_id: fileId,
    language_hints: config.soniox.sourceLanguages,
    enable_language_identification: true,
    enable_speaker_diarization: true,
    translation: {
      type: 'one_way',
      target_language: config.soniox.targetLanguage,
    },
  };

  const { contextTerms, translationTerms } = config.soniox;
  if (contextTerms.length > 0 || translationTerms.length > 0) {
    request.context = {};
    if (contextTerms.length > 0) request.context.terms = contextTerms;
    if (translationTerms.length > 0) request.context.translation_terms = translationTerms;
  }

  return request;
}

async function transcribe(
  videoPath: string,
  config: AppConfig,
  paths: OutputPaths,
): Promise<CachedTranscript> {
  const apiKey = resolveApiKey(config);
  const client = new SonioxAsyncClient({ apiKey, baseUrl: config.soniox.baseUrl });

  return withTempDir(async (tempDir) => {
    const wavPath = join(tempDir, `${basename(videoPath, extname(videoPath))}.wav`);

    info('extracting audio (16 kHz mono WAV)…');
    await extractAudio(videoPath, wavPath);

    info('uploading to Soniox…');
    const uploaded = await client.uploadFile(wavPath);

    let job: Transcription | undefined;
    try {
      const request = buildRequest(config, uploaded.id);
      job = await client.createTranscription(request);
      info(`transcription ${job.id} submitted; polling…`);

      let lastStatus = '';
      const completed = await client.waitForCompletion(job.id, {
        intervalMs: config.ingest.pollIntervalMs,
        timeoutMs: config.ingest.pollTimeoutMs,
        onProgress: (current, elapsedMs) => {
          if (current.status !== lastStatus) {
            lastStatus = current.status;
            info(`  ${current.status} (${Math.round(elapsedMs / 1000)}s)`);
          }
        },
      });

      const transcript = await client.getTranscript(job.id);
      info(`transcript received: ${transcript.tokens?.length ?? 0} tokens`);

      const cached: CachedTranscript = {
        request,
        transcription: {
          id: completed.id,
          model: completed.model,
          audio_duration_ms: completed.audio_duration_ms,
          created_at: completed.created_at,
        },
        transcript,
      };
      await writeFile(paths.cache, `${JSON.stringify(cached, null, 2)}\n`, 'utf8');
      return cached;
    } finally {
      // Best-effort cleanup — the audio has served its purpose and there is no
      // reason to leave a copy of a sermon sitting in the Soniox project.
      await client.deleteFile(uploaded.id).catch(() => {
        warn(`could not delete uploaded file ${uploaded.id} from Soniox`);
      });
      if (job) {
        await client.deleteTranscription(job.id).catch(() => {
          warn(`could not delete transcription ${job?.id} from Soniox`);
        });
      }
    }
  });
}

async function readCache(path: string): Promise<CachedTranscript | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CachedTranscript;
    if (!parsed?.transcript || !Array.isArray(parsed.transcript.tokens)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param prisma When supplied, segments are persisted (§4 phase 2). Omitted in
 *   unit tests and by `--no-db`, where the run stays file-only.
 */
export async function ingest(
  args: IngestArgs,
  config: AppConfig,
  prisma?: PrismaClient,
): Promise<IngestResult> {
  const videoPath = resolve(args.videoPath);
  if (!existsSync(videoPath)) throw new Error(`no such file: ${videoPath}`);

  const paths = outputPaths(videoPath, config);

  let cached: CachedTranscript | null = null;
  if (!args.force) {
    cached = await readCache(paths.cache);
    if (cached) info(`reusing cached transcript ${basename(paths.cache)} (--force to re-transcribe)`);
  }
  const usedCache = cached !== null;
  const data = cached ?? (await transcribe(videoPath, config, paths));

  const segments = buildSegments(data.transcript.tokens ?? [], {
    pauseMs: config.ingest.pauseMs,
    maxChars: config.ingest.maxChars,
    maxSegmentMs: config.ingest.maxSegmentMs,
    minDisplayMs: config.ingest.minDisplayMs,
  });

  const srtOptions = {
    maxLineChars: config.ingest.maxLineChars,
    maxLines: config.ingest.maxLines,
  };
  await writeFile(paths.targetSrt, toSrt(segments, 'translation', srtOptions), 'utf8');
  await writeFile(paths.sourceSrt, toSrt(segments, 'original', srtOptions), 'utf8');

  // Shaped to match the phase-2 `service` + `segment` tables (§4) so the move
  // into Postgres is a straight import. Deliberately carries no generated-at
  // timestamp: re-running must produce byte-identical files.
  const document = {
    video: basename(videoPath),
    speaker: args.speaker,
    date: args.date,
    source: 'rip',
    durationMs: data.transcription.audio_duration_ms ?? null,
    trimStartMs: 0,
    model: data.transcription.model ?? config.soniox.model,
    targetLanguage: config.soniox.targetLanguage,
    settings: {
      pauseMs: config.ingest.pauseMs,
      maxChars: config.ingest.maxChars,
      maxSegmentMs: config.ingest.maxSegmentMs,
      minDisplayMs: config.ingest.minDisplayMs,
      maxLineChars: config.ingest.maxLineChars,
      maxLines: config.ingest.maxLines,
    },
    segments,
  };
  await writeFile(paths.segmentsJson, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const result: IngestResult = {
    segments,
    outputs: paths,
    cached: usedCache,
    durationMs: data.transcription.audio_duration_ms,
  };

  if (prisma) {
    const saved = await saveService(
      prisma,
      {
        date: args.date,
        speaker: args.speaker,
        title: args.title,
        source: 'rip',
        videoPath,
        durationMs: data.transcription.audio_duration_ms ?? null,
        trimStartMs: 0,
      },
      segments,
      { replaceEdited: args.replaceEdited === true },
    );
    result.serviceId = saved.serviceId;
    result.createdService = saved.created;
    if (saved.discardedEdits > 0) {
      warn(`discarded ${saved.discardedEdits} hand-corrected segment(s) on re-ingest`);
    }
    info(`${saved.created ? 'created' : 'updated'} service ${saved.serviceId}`);
  }

  return result;
}

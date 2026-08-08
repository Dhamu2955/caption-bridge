import { createHash } from 'node:crypto';

import type { AppConfig } from '../config.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { loadSegments, resolveServiceRef } from '../db/services.js';
import { YoutubeClient, YoutubeError } from '../youtube/client.js';
import { QUOTA_COST } from '../youtube/types.js';
import { buildSrtTexts } from './export.js';
import { info, warn } from '../util/log.js';

/**
 * §4 phase 2 says the database is the source of truth and SRT is a regenerated
 * artifact. Publishing extends that all the way to YouTube: the bytes uploaded
 * are formatted from segments at publish time, never read back from a file
 * someone may have hand-edited.
 *
 * captions.insert only works on the channel's own videos, so `youtubeVideoId`
 * is null for every sermon ripped from another mandir's stream. Those are
 * served by `play` on the projector instead.
 */

export type PublishAction = 'inserted' | 'updated' | 'unchanged' | 'adopted';

export interface PublishTrackResult {
  language: string;
  action: PublishAction;
  trackId: string | undefined;
  quotaUnits: number;
}

export interface PublishResult {
  serviceId: string;
  youtubeVideoId: string;
  tracks: PublishTrackResult[];
  quotaUnits: number;
}

export interface PublishArgs {
  /** Video path or service id. */
  ref: string;
  /** Recorded on the service the first time; remembered after that. */
  youtubeVideoId?: string | undefined;
  /** Defaults to the target language then the first source language. */
  languages?: string[] | undefined;
  /** Upload even when the stored hash says nothing changed. */
  force?: boolean;
  /** Resolve and format everything, then print instead of calling the API. */
  dryRun?: boolean;
}

/** Human-facing track names, so the YouTube language menu reads properly. */
const TRACK_NAMES: Record<string, string> = {
  en: 'English',
  gu: 'ગુજરાતી',
};

export function trackName(language: string): string {
  return TRACK_NAMES[language] ?? language.toUpperCase();
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function defaultLanguages(config: AppConfig): string[] {
  const source = config.soniox.sourceLanguages[0];
  return source ? [config.soniox.targetLanguage, source] : [config.soniox.targetLanguage];
}

export function createYoutubeClient(
  credentials: { clientId: string; clientSecret: string; refreshToken: string },
): YoutubeClient {
  return new YoutubeClient(credentials);
}

export async function publish(
  args: PublishArgs,
  config: AppConfig,
  prisma: PrismaClient,
  client?: YoutubeClient,
): Promise<PublishResult> {
  const service = await resolveServiceRef(prisma, args.ref);

  const videoId = args.youtubeVideoId ?? service.youtubeVideoId;
  if (!videoId) {
    throw new Error(
      `no YouTube video recorded for this service — pass --youtube-id <id> once and it is remembered. ` +
        `Captions can only be attached to videos on your own channel.`,
    );
  }

  const rows = await loadSegments(prisma, service.id);
  if (rows.length === 0) {
    throw new Error('this service has no cues — run `ingest` first');
  }
  const texts = buildSrtTexts(rows, service.trimStartMs, config);

  const languages = args.languages ?? defaultLanguages(config);
  const api = client;
  if (!api && !args.dryRun) {
    throw new Error('publishing needs YouTube credentials — run `npx tsx src/cli.ts publish --auth`');
  }

  const existing = await prisma.captionUpload.findMany({ where: { serviceId: service.id } });
  const byLanguage = new Map(existing.map((row) => [row.language, row]));

  const tracks: PublishTrackResult[] = [];
  let quotaUnits = 0;
  let listed: Awaited<ReturnType<YoutubeClient['listCaptions']>> | undefined;

  for (const language of languages) {
    const srt = language === config.soniox.targetLanguage ? texts.target : texts.source;
    const hash = sha256(srt);
    const previous = byLanguage.get(language);

    if (previous && previous.contentHash === hash && !args.force) {
      info(`${language}: unchanged — nothing to upload`);
      tracks.push({ language, action: 'unchanged', trackId: previous.trackId, quotaUnits: 0 });
      continue;
    }

    if (args.dryRun) {
      const action = previous ? 'updated' : 'inserted';
      info(`${language}: would ${action === 'updated' ? 'update' : 'insert'} ${srt.length} chars (sha256 ${hash.slice(0, 12)})`);
      tracks.push({
        language,
        action,
        trackId: previous?.trackId,
        quotaUnits: previous ? QUOTA_COST.update : QUOTA_COST.insert,
      });
      quotaUnits += previous ? QUOTA_COST.update : QUOTA_COST.insert;
      continue;
    }

    if (!api) {
      throw new Error('publishing needs YouTube credentials — run `npx tsx src/cli.ts publish --auth`');
    }

    let trackId = previous?.trackId;
    let action: PublishAction = previous ? 'updated' : 'inserted';
    let spent = 0;

    // No local record: ask YouTube before inserting. A track uploaded by hand,
    // or by a run whose database was since rebuilt, must be adopted rather than
    // duplicated — viewers would otherwise get two "English" options. One list
    // covers every language, so it is charged at most once per service.
    if (!trackId) {
      if (listed === undefined) {
        listed = await api.listCaptions(videoId);
        spent += QUOTA_COST.list;
      }
      const match = listed.find(
        (track) => track.snippet?.language === language && track.snippet?.trackKind !== 'ASR',
      );
      if (match) {
        trackId = match.id;
        action = 'adopted';
        info(`${language}: adopting the track already on the video (${match.id})`);
      }
    }

    const result = trackId
      ? await api.updateCaption(trackId, srt)
      : await api.insertCaption(videoId, language, trackName(language), srt);
    spent += trackId ? QUOTA_COST.update : QUOTA_COST.insert;
    quotaUnits += spent;

    const finalTrackId = result.id ?? trackId;
    if (!finalTrackId) throw new YoutubeError(`${language}: YouTube returned no caption track id`);

    await prisma.captionUpload.upsert({
      where: { serviceId_language: { serviceId: service.id, language } },
      create: { serviceId: service.id, language, trackId: finalTrackId, contentHash: hash },
      update: { trackId: finalTrackId, contentHash: hash, uploadedAt: new Date() },
    });

    info(`${language}: ${action} (${finalTrackId})`);
    tracks.push({ language, action, trackId: finalTrackId, quotaUnits: spent });
  }

  // Remember the video id so later republishes need only the video path.
  if (!args.dryRun && service.youtubeVideoId !== videoId) {
    await prisma.service.update({
      where: { id: service.id },
      data: { youtubeVideoId: videoId },
    });
  }

  return { serviceId: service.id, youtubeVideoId: videoId, tracks, quotaUnits };
}

export interface PublishAllArgs {
  /** Stop once this many quota units are spent. Defaults to 90% of the daily allowance. */
  budget?: number | undefined;
  languages?: string[] | undefined;
  force?: boolean;
  dryRun?: boolean;
}

export interface PublishAllResult {
  published: number;
  skipped: number;
  remaining: number;
  quotaUnits: number;
  stoppedOnQuota: boolean;
}

/**
 * The backlog run.
 *
 * Unlike `backfill` this keeps no state file: CaptionUpload already records what
 * is on YouTube, so a run that stops at the quota wall resumes tomorrow by doing
 * the same query and finding less to do. The only thing that has to be tracked
 * within a run is spend.
 */
export async function publishAll(
  args: PublishAllArgs,
  config: AppConfig,
  prisma: PrismaClient,
  client?: YoutubeClient,
): Promise<PublishAllResult> {
  const budget = args.budget ?? Math.floor(config.youtube.dailyQuotaUnits * 0.9);
  const services = await prisma.service.findMany({
    where: { youtubeVideoId: { not: null } },
    orderBy: [{ date: 'desc' }],
    select: { id: true, videoPath: true, youtubeVideoId: true },
  });

  if (services.length === 0) {
    info('no services carry a YouTube video id — publish one with --youtube-id first');
    return { published: 0, skipped: 0, remaining: 0, quotaUnits: 0, stoppedOnQuota: false };
  }

  let quotaUnits = 0;
  let published = 0;
  let skipped = 0;
  let stoppedOnQuota = false;
  /** Services fully dealt with. Anything that failed stays outstanding. */
  let settled = 0;

  for (const service of services) {
    // Worst case for one service is a list plus two inserts. Stopping before
    // starting a service is what keeps a run from dying half-published.
    const worstCase = QUOTA_COST.list + QUOTA_COST.insert * 2;
    if (quotaUnits + worstCase > budget) {
      info(`stopping at ${quotaUnits} units — the rest needs tomorrow's quota`);
      stoppedOnQuota = true;
      break;
    }

    try {
      const result = await publish(
        {
          ref: service.id,
          ...(args.languages ? { languages: args.languages } : {}),
          force: args.force === true,
          dryRun: args.dryRun === true,
        },
        config,
        prisma,
        client,
      );
      quotaUnits += result.quotaUnits;
      settled++;
      if (result.tracks.every((track) => track.action === 'unchanged')) {
        skipped++;
      } else {
        published++;
        info(`[${settled}] ${service.videoPath}`);
      }
    } catch (err) {
      if (err instanceof YoutubeError && err.isQuotaExhausted) {
        warn('YouTube says the daily quota is gone — stopping cleanly, re-run tomorrow');
        stoppedOnQuota = true;
        break;
      }
      // One bad service must not end the run; the next one may be fine.
      warn(`${service.videoPath} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A service that failed — on quota or anything else — is still outstanding,
  // so only fully settled ones come off the count.
  const remaining = services.length - settled;
  info('');
  info(`${published} published, ${skipped} already current, ${remaining} remaining`);
  info(`${quotaUnits} quota units spent of ${budget}`);

  return { published, skipped, remaining, quotaUnits, stoppedOnQuota };
}

/** Subset of the YouTube Data API v3 caption resources this tool touches. */

export interface CaptionSnippet {
  videoId?: string;
  language?: string;
  name?: string;
  /** 'standard' for uploaded tracks, 'ASR' for YouTube's own auto-captions. */
  trackKind?: string;
  isDraft?: boolean;
  lastUpdated?: string;
  status?: string;
}

export interface CaptionTrack {
  id: string;
  snippet?: CaptionSnippet;
}

export interface CaptionListResponse {
  items?: CaptionTrack[];
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
}

/**
 * Quota costs, from the API's published table. The default budget is
 * 10,000 units a day, so two tracks on one video is 800 to publish and 900 to
 * correct — roughly a dozen videos a day, which is what paces a backlog run.
 */
export const QUOTA_COST = {
  list: 50,
  insert: 400,
  update: 450,
  delete: 50,
} as const;

/** Google's reason codes that mean "the day's budget is gone, come back tomorrow". */
export const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded']);

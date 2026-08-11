import type { Capability } from '../live/preflight.js';

/**
 * What can be changed from the browser, and what happens when it is.
 *
 * One list, used three ways: it validates writes, it says when a change takes
 * effect, and it generates the settings form. There is no frontend framework
 * here, so a hand-written form would drift from the validation within a week.
 */

export type AppliesTo = 'immediate' | 'next-session' | 'restart';

/**
 * Grouped by how often someone touches a setting, not by what it configures.
 *
 * A settings page is a list of decisions, and the useful question about any of
 * them is "will I change this today?". Sorting by subsystem put the six knobs
 * that were tuned once against a real sermon in front of the operator every
 * week, next to the caption URL that genuinely changes every broadcast.
 */
export type SettingGroup = 'service' | 'words' | 'setup' | 'advanced';

export interface SettingGroupInfo {
  id: SettingGroup;
  title: string;
  blurb: string;
  /** Folded away — present for whoever needs it, out of everyone else's way. */
  collapsed?: boolean;
  /**
   * Edited on a tab of its own, so the pane points there instead of showing a
   * second editor for the same thing. The paths stay in SETTINGS regardless —
   * the config writer still has to accept them.
   */
  movedTo?: { tab: string; label: string; why: string };
}

export const SETTING_GROUPS: readonly SettingGroupInfo[] = [
  {
    id: 'service',
    title: 'This service',
    blurb: 'Worth checking before each broadcast.',
  },
  {
    id: 'words',
    title: 'Names and terms',
    blurb:
      'Filling these in as you notice problems is the main reason to run this every week.',
    movedTo: {
      tab: 'glossary',
      label: 'Open the Glossary',
      why:
        'Two hundred terms in a text box was never an editor. The Glossary tab ' +
        'searches them, says which are built in and which you added, and lets ' +
        'you change one without retyping the rest.',
    },
  },
  {
    id: 'setup',
    title: 'This machine',
    blurb: 'Set once, when the bridge is installed.',
  },
  {
    id: 'advanced',
    title: 'Subtitle shape and timing',
    blurb:
      'Tuned against a real sermon and unlikely to want changing. The one exception is ' +
      '"cut a line after", which decides how soon a caption can appear.',
    collapsed: true,
  },
];

export interface SettingDescriptor {
  /** Dotted path into config.json. */
  path: string;
  label: string;
  help: string;
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'termPairs' | 'choice';
  /** `choice` only: the allowed values, in the order they should be offered. */
  choices?: readonly { value: string; label: string }[];
  group: SettingGroup;
  appliesTo: AppliesTo;
  unit?: string;
  /** Booleans only: what ticking the box means, beside the checkbox. */
  on?: string;
}

/** A credential. Lives in `.env`, never in config.json, never sent to a page. */
export interface SecretDescriptor {
  /** The env var name, taken from config.json so it stays configurable. */
  configPath: string;
  label: string;
  help: string;
  group: 'soniox' | 'database' | 'youtube' | 'google';
  /** What stops working without it. */
  blocks: Capability[];
  optional?: boolean;
}

export const SETTINGS: readonly SettingDescriptor[] = [
  {
    path: 'ingest.pauseMs',
    label: 'Pause that ends a subtitle',
    help: 'If subtitles feel choppy, raise this. If separate sentences run together, lower it.',
    type: 'number',
    unit: 'ms',
    group: 'advanced',
    appliesTo: 'next-session',
  },
  {
    path: 'ingest.maxChars',
    label: 'Most characters in one subtitle',
    help: 'Keep this close to lines × characters per line, or the last line runs long.',
    type: 'number',
    group: 'advanced',
    appliesTo: 'next-session',
  },
  {
    path: 'ingest.maxLineChars',
    label: 'Characters per line',
    type: 'number',
    help: 'Wrapping width.',
    group: 'advanced',
    appliesTo: 'next-session',
  },
  {
    path: 'ingest.maxLines',
    label: 'Lines per subtitle',
    help: 'Three fits more full sentences than two. A hard cap, not a target.',
    type: 'number',
    group: 'advanced',
    appliesTo: 'next-session',
  },
  {
    path: 'ingest.minDisplayMs',
    label: 'Shortest a subtitle stays up',
    help: 'Briefer ones are merged rather than flashed.',
    type: 'number',
    unit: 'ms',
    group: 'advanced',
    appliesTo: 'next-session',
  },
  {
    path: 'ingest.maxSegmentMs',
    label: 'Longest a subtitle stays up',
    type: 'number',
    unit: 'ms',
    help: 'Stops a stretch without punctuation becoming a forty-second caption.',
    group: 'advanced',
    appliesTo: 'next-session',
  },

  {
    path: 'live.maxBufferMs',
    label: 'Cut a line after',
    help:
      'The biggest lever on how soon a caption appears. A caption cannot exist until ' +
      'the sentence it covers has finished being spoken, so long sentences are late ones. ' +
      'Cutting sooner gets captions up faster, at the cost of splitting sentences.',
    type: 'number',
    unit: 'ms',
    group: 'advanced',
    appliesTo: 'next-session',
  },
  {
    path: 'live.maxEndpointDelayMs',
    label: 'Longest Soniox may wait to end a sentence',
    help:
      'A backstop for a speaker who never pauses, not a target. Left at 2000 Soniox decides ' +
      'where sentences end; lowering it forces a cut mid-thought and captions start arriving ' +
      'a few words at a time.',
    type: 'number',
    unit: 'ms',
    group: 'advanced',
    appliesTo: 'next-session',
  },
  {
    path: 'live.googleDoc',
    label: 'Write the service to a Google Doc',
    help:
      'A new doc each time you press Start, filled in as the service runs: the Gujarati and ' +
      'the English line by line, for somebody to read afterwards and write a summary from. ' +
      'Needs the Google credential — run `npx tsx src/cli.ts doc --auth` once. If it is not ' +
      'set up, or Google stops answering, the service carries on and the Captions tab says so.',
    type: 'boolean',
    on: 'Write a doc as it goes',
    group: 'service',
    appliesTo: 'next-session',
  },
  {
    path: 'live.googleDocFolderId',
    label: 'Drive folder for those docs',
    help:
      'Open the folder in Drive and copy the last part of the address — ' +
      'drive.google.com/drive/folders/THIS_BIT. Leave it empty to put them in My Drive.',
    type: 'string',
    group: 'service',
    appliesTo: 'next-session',
  },
  {
    path: 'live.liveSrt',
    label: 'Save subtitles from the live service',
    help:
      'Writes an .srt into the recordings folder as the service runs, holding exactly what ' +
      'went out. Put it on the recording afterwards instead of transcribing the video a ' +
      'second time and paying for the same words twice. Timestamps run from when capture ' +
      'started, so they line up with a recording that started with it.',
    type: 'boolean',
    on: 'Write an .srt as it goes',
    group: 'service',
    appliesTo: 'next-session',
  },

  {
    path: 'soniox.languageHintsStrict',
    label: 'Only listen for the languages named',
    help:
      'On, recognition is restricted to the languages named, which Soniox says gives the ' +
      'best results and is what the working prototype does. Off, they are only hints and it ' +
      'may recognise others.',
    type: 'boolean',
    on: 'Restrict to those languages',
    group: 'advanced',
    appliesTo: 'next-session',
  },
  {
    path: 'soniox.contextTerms',
    label: 'Names and terms',
    help:
      'Deity names, proper nouns and scriptural terms, so they come back the same every ' +
      'week. Filling these in as you spot problems is the main reason to run this weekly.',
    type: 'string[]',
    group: 'words',
    appliesTo: 'next-session',
  },
  {
    path: 'soniox.translationTerms',
    label: 'Fixed translations',
    help: 'Gujarati term on the left, the English you want on the right.',
    type: 'termPairs',
    group: 'words',
    appliesTo: 'next-session',
  },

  {
    path: 'server.host',
    label: 'Listen on',
    help:
      '0.0.0.0, the default, lets the tablet, the vMix PC and the office machine open the ' +
      'homepage — and so can anyone else on the mandir network, which is why every link ' +
      'carries a token. Never forward this port to the internet. 127.0.0.1 keeps it to ' +
      'this machine alone.',
    type: 'string',
    group: 'setup',
    appliesTo: 'restart',
  },
  {
    path: 'server.shareTokenOnLan',
    label: 'Hand out the link on this network',
    help:
      'On, anyone already on this network can open the homepage by typing the short address ' +
      'with no token, and every link on it is then complete and one click away. That is what ' +
      'makes it usable from the vMix PC and a tablet. Off, every page needs its token typed ' +
      'out by hand — only worth it on a network you do not control.',
    type: 'boolean',
    on: 'Hand it out, so the short address works',
    group: 'setup',
    appliesTo: 'immediate',
  },
  {
    path: 'server.port',
    label: 'Port',
    help: 'Restart needed — changing it would strand every page that is already open.',
    type: 'number',
    group: 'setup',
    appliesTo: 'restart',
  },
];

export const SECRETS: readonly SecretDescriptor[] = [
  {
    configPath: 'soniox.apiKeyEnv',
    label: 'Soniox API key',
    help: 'From console.soniox.com. Transcription and translation both use it.',
    group: 'soniox',
    blocks: ['live', 'ingest'],
  },
  {
    configPath: 'database.urlEnv',
    label: 'Database URL',
    help: 'The postgresql:// line from .env.example. Start Postgres with `docker compose up -d`.',
    group: 'database',
    blocks: ['ingest', 'archive', 'publish', 'search'],
  },
  {
    configPath: 'live.youtubeCaptionsUrlEnv',
    label: 'YouTube caption URL',
    help:
      'This is the one that puts captions on a live stream. Turn on closed captions with ' +
      'the "POST to URL" method in YouTube\'s stream settings and it hands you this URL. ' +
      'It carries a cid identifying the stream, so treat it like a password.',
    group: 'youtube',
    blocks: [],
    optional: true,
  },
  {
    configPath: 'googleDocs.clientIdEnv',
    label: 'Google Docs client id',
    help:
      'For writing the service to a Google Doc. Can be the same OAuth client as YouTube ' +
      'below — but the refresh token cannot be, because the scopes differ.',
    group: 'google',
    blocks: [],
    optional: true,
  },
  {
    configPath: 'googleDocs.clientSecretEnv',
    label: 'Google Docs client secret',
    help: 'The other half of the pair above.',
    group: 'google',
    blocks: [],
    optional: true,
  },
  {
    configPath: 'googleDocs.refreshTokenEnv',
    label: 'Google Docs refresh token',
    help: 'Minted once by `npx tsx src/cli.ts doc --auth`. Never the YouTube one.',
    group: 'google',
    blocks: [],
    optional: true,
  },
  {
    configPath: 'youtube.clientIdEnv',
    label: 'YouTube client id',
    help:
      'For adding caption tracks to recordings after the event. Live captions do not use ' +
      'this — leave it empty if that is all you do.',
    group: 'youtube',
    blocks: ['publish'],
    optional: true,
  },
  {
    configPath: 'youtube.clientSecretEnv',
    label: 'YouTube client secret',
    help: 'The other half of the OAuth pair.',
    group: 'youtube',
    blocks: ['publish'],
    optional: true,
  },
  {
    configPath: 'youtube.refreshTokenEnv',
    label: 'YouTube refresh token',
    help:
      'Minted once by `npx tsx src/cli.ts publish --auth`. Set the consent screen to ' +
      'Production, or Google ' +
      'expires it after seven days — exactly the length of festival week.',
    group: 'youtube',
    blocks: ['publish'],
    optional: true,
  },
];

const ALLOWED = new Set(SETTINGS.map((setting) => setting.path));

export function isKnownSetting(path: string): boolean {
  return ALLOWED.has(path);
}

export function describeSetting(path: string): SettingDescriptor | undefined {
  return SETTINGS.find((setting) => setting.path === path);
}

/** Paths that were written but need the process restarted to take effect. */
export function restartRequiredFor(paths: string[]): string[] {
  return paths.filter((path) => describeSetting(path)?.appliesTo === 'restart');
}

/**
 * Credentials belong in `.env`. Catching them here means a paste into the wrong
 * box is refused rather than committed to git inside config.json.
 */
export function looksLikeSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (/^sk-|^AIza|^ya29\./.test(value)) return true;
  if (/^postgres(ql)?:\/\/\S+:\S+@/.test(value)) return true;
  return value.length >= 32 && /^[A-Za-z0-9_\-+/=]+$/.test(value);
}

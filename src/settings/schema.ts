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
  group: 'soniox' | 'database' | 'youtube';
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
    path: 'live.delayReviewMs',
    label: 'Time the reviewer gets',
    help:
      'Up to ten minutes. The stream runs this far behind the room, and the delay has to ' +
      'live after the encoder — not in vMix Video Delay.',
    type: 'number',
    unit: 'ms',
    group: 'service',
    appliesTo: 'next-session',
  },
  {
    path: 'live.delayAssemblyMs',
    label: 'Time Soniox gets',
    help:
      'How long to wait for a subtitle before showing it. A subtitle cannot exist until ' +
      'the sentence has finished being spoken, so this needs to be about as long as your ' +
      'longest sentence plus two seconds — measured at twelve on a real sermon, not four. ' +
      'Too short and long lines are skipped for arriving late. The venue screens sit this ' +
      'far behind the speaker, and the reviewer sees each line the moment it is ready.',
    type: 'number',
    unit: 'ms',
    group: 'service',
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
    path: 'live.endpointSensitivity',
    label: 'How soon Soniox calls a sentence finished',
    help:
      '-1 waits longest, 1 commits soonest, 0 is the default. Waiting longer gives it ' +
      'the rest of the sentence before it decides what the words were — worth it when a ' +
      'phrase is being misheard as a similar-sounding one, at the cost of captions ' +
      'appearing later.',
    type: 'number',
    group: 'advanced',
    appliesTo: 'next-session',
  },
  {
    path: 'live.maxEndpointDelayMs',
    label: 'Longest it may wait to decide',
    help:
      'The ceiling on the setting above, so a speaker who never pauses cannot hold a ' +
      'sentence open indefinitely.',
    type: 'number',
    unit: 'ms',
    group: 'advanced',
    appliesTo: 'next-session',
  },
  {
    path: 'live.minDisplayMs',
    label: 'Shortest a caption stays up (live)',
    help:
      'Anything briefer is merged into its neighbour rather than flashed, and the queue ' +
      'leaves at least this long between two lines. Lower it to let short chunks stand on ' +
      'their own; below about 700ms they are hard to read at the back of a hall.',
    type: 'number',
    unit: 'ms',
    group: 'service',
    appliesTo: 'next-session',
  },
  {
    path: 'live.skipLateLines',
    label: 'Drop captions that miss their moment',
    help:
      'On, a line that is more than a couple of seconds late is thrown away, because a ' +
      'caption under the wrong sentence is worse than none. Off, every line goes out however ' +
      'late — nothing is ever missing, but nothing catches up either, so the words drift ' +
      'further behind the speaker and stay there. Off is for a transcript or a rehearsal, ' +
      'on is for a service.',
    type: 'boolean',
    on: 'Drop them — right for a service',
    group: 'service',
    appliesTo: 'next-session',
  },
  {
    path: 'live.rawPassthrough',
    label: 'Continuous feed on the raw screen',
    help:
      'The fastest this can go: English pushed to /overlay?output=raw the instant Soniox ' +
      'translates it, with no line building, no queue and no delay. It rewrites itself as ' +
      'the speaker talks — Gujarati puts the verb last, so a half-finished clause is often ' +
      're-ordered rather than corrected, and that is what this looks like on screen. It ' +
      'ADDS a screen: the venue, the stream, the reviewer and the YouTube captions carry on ' +
      'exactly as before. Rehearse it beside them before pointing a projector at it.',
    type: 'boolean',
    on: 'Run the continuous feed as well',
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
    path: 'live.captionTimestampMode',
    label: 'How YouTube captions are timed',
    help:
      'Where each caption is placed on the stream. "When the words were spoken" needs the ' +
      'video delayed to match the pipeline and the offset below calibrated. "When it is ' +
      'sent" places it wherever the stream has got to, which needs no offset and no video ' +
      'delay at all — but only makes sense with the delays turned down, or captions land ' +
      'as far behind as the pipeline is.',
    type: 'choice',
    choices: [
      { value: 'speech', label: 'When the words were spoken (needs the offset below)' },
      { value: 'now', label: 'When it is sent — no offset, no video delay' },
    ],
    group: 'service',
    appliesTo: 'next-session',
  },
  {
    path: 'live.streamOffsetMs',
    label: 'Encoder to YouTube delay',
    help:
      'What puts each caption on the right words in the stream. Confirm it on a private ' +
      'test stream before a festival.',
    type: 'number',
    unit: 'ms',
    group: 'service',
    appliesTo: 'next-session',
  },

  {
    path: 'soniox.languageHintsStrict',
    label: 'Only listen for the languages named',
    help:
      'Off, the languages are hints and Soniox may recognise others. On, it is restricted ' +
      'to them, which Soniox says gives the best results — but this bridge names two ' +
      'because sermons switch between Gujarati and English mid-sentence. Worth testing ' +
      'against your own speaker before a service.',
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
  {
    path: 'paths.media',
    label: 'Where sermons are kept',
    help: 'Videos to ingest are read from here.',
    type: 'string',
    group: 'setup',
    appliesTo: 'immediate',
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

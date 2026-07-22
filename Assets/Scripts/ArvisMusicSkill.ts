/** Client-side music generation intent (matches arvis.space /api/chat /music handling). */

const MUSIC_CMD_PATTERN = /^\/music\s+([\s\S]{1,700})$/i;

const NATURAL_MUSIC_PATTERN =
  /^(?:generate|create|make|compose|produce|play|write)\s+(?:me\s+)?(?:an?\s+)?(?:song|track|tune|beat|jingle|melody|music)\s+(?:about\s+|for\s+|with\s+)?([\s\S]{1,700})$/i;

const SONG_ABOUT_PATTERN =
  /^(?:make|write|compose|generate|create)\s+(?:me\s+)?(?:a\s+)?song\s+about\s+([\s\S]{1,700})$/i;

export function isMusicQuery(message: string): boolean {
  const raw = String(message || '').trim();
  if (!raw) {
    return false;
  }
  if (MUSIC_CMD_PATTERN.test(raw)) {
    return true;
  }
  if (NATURAL_MUSIC_PATTERN.test(raw)) {
    return true;
  }
  if (SONG_ABOUT_PATTERN.test(raw)) {
    return true;
  }
  if (
    /\b(generate|create|make|compose|produce|play|write|need|want|please)\b/i.test(raw) &&
    /\b(music|song|track|tune|beat|jingle|melody|soundtrack|instrumental)\b/i.test(raw)
  ) {
    return true;
  }
  return false;
}

export function extractMusicSubject(message: string): string {
  let input = String(message || '').trim();
  if (!input) {
    return '';
  }

  const cmdMatch = input.match(MUSIC_CMD_PATTERN);
  if (cmdMatch?.[1]) {
    return sanitizeMusicSubject(cmdMatch[1]);
  }

  const naturalMatch = input.match(NATURAL_MUSIC_PATTERN);
  if (naturalMatch?.[1]) {
    return sanitizeMusicSubject(naturalMatch[1]);
  }

  const songMatch = input.match(SONG_ABOUT_PATTERN);
  if (songMatch?.[1]) {
    return sanitizeMusicSubject(songMatch[1]);
  }

  input = input
    .replace(/^@\w+\s+/gi, '')
    .replace(/^(?:hey|hi|hello|yo|okay|ok)\s+(?:jarvis|claw|arvis|\w+)\s*,?\s*/i, '')
    .replace(/^(?:jarvis|claw|arvis)\s*,?\s*/i, '')
    .replace(/^(?:please\s+)?(?:can you|could you|would you|will you)\s+/i, '')
    .replace(/^please\s+/i, '')
    .trim();

  input = input
    .replace(
      /^(?:generate|create|make|compose|produce|play|write|give me|build|need|want)\s+(?:me\s+)?(?:an?\s+)?(?:song|track|tune|beat|jingle|melody|music|instrumental|soundtrack)\s+(?:about\s+|for\s+|with\s+)?/i,
      ''
    )
    .replace(/^(?:an?\s+)?(?:song|track|tune|beat|jingle|melody|music|instrumental|soundtrack)\s+(?:about\s+|for\s+|with\s+)?/i, '')
    .trim();

  return sanitizeMusicSubject(input);
}

export function normalizeMusicPrompt(message: string): string | null {
  const raw = String(message || '').trim();
  if (!raw || !isMusicQuery(raw)) {
    return null;
  }

  if (MUSIC_CMD_PATTERN.test(raw)) {
    const match = raw.match(MUSIC_CMD_PATTERN);
    const subject = sanitizeMusicSubject(match?.[1] || '');
    return subject ? `/music ${subject}` : null;
  }

  const subject = extractMusicSubject(raw);
  return subject ? `/music ${subject}` : null;
}

export function resolveAgentMusicUrl(musicUrl: string | undefined, apiBaseUrl: string): string {
  const trimmed = String(musicUrl || '').trim();
  if (!trimmed) {
    return '';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const base = String(apiBaseUrl || 'https://arvis.space').replace(/\/$/, '');
  if (trimmed.startsWith('/')) {
    return `${base}${trimmed}`;
  }
  return `${base}/${trimmed}`;
}

export function extractMusicUrlFromAgentResponse(
  response: string,
  musicUrl?: string,
  apiBaseUrl?: string
): string | undefined {
  const direct = resolveAgentMusicUrl(musicUrl, apiBaseUrl || 'https://arvis.space');
  if (direct) {
    return direct;
  }

  const text = String(response || '');
  const httpMatch = text.match(/https?:\/\/[^\s)\]]+\.(?:wav|mp3|m4a|ogg)/i);
  if (httpMatch?.[0]) {
    return httpMatch[0].trim();
  }

  const relativeMatch = text.match(/(\/(?:uploads|music)\/[^\s)\]]+\.(?:wav|mp3|m4a|ogg))/i);
  if (relativeMatch?.[1]) {
    return resolveAgentMusicUrl(relativeMatch[1], apiBaseUrl || 'https://arvis.space');
  }

  return undefined;
}

function sanitizeMusicSubject(subject: string): string {
  return String(subject || '')
    .trim()
    .replace(/[.?!]+$/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 700);
}

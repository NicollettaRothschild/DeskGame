export type ArvisWakeParseResult = {
  triggered: boolean;
  message: string;
};

const WAKE_GREETING = '(?:hey|hi|ok(?:ay)?|yo|the|okay)';
const WAKE_NAMES =
  '(?:arvis|avis|airvis|armis|ars|argos|argo|arvos|arbus|harvest|harvis|har\\s*vest|a\\s*vis|a\\s*r\\s*vis|our\\s*vis|are\\s*vis)';

const WAKE_PREFIX = new RegExp(
  `^${WAKE_GREETING}[,\\s]+${WAKE_NAMES}\\b[,\\s.]*`,
  'i'
);

// Truncated finals like "hey, a." or "hey ar" before ASR finishes the name.
const PARTIAL_WAKE = new RegExp(
  `^${WAKE_GREETING}[,\\s]+(?:a\\.?|ar\\.?|arg\\.?|ars\\.?)[,\\s.]*$`,
  'i'
);

function normalizeWakeMessage(message: string): string {
  return String(message || '')
    .replace(/^[.,!?;:\s]+|[.,!?;:\s]+$/g, '')
    .trim();
}

export function hasWakeFollowUp(message: string): boolean {
  return normalizeWakeMessage(message).length > 0;
}

export function parseArvisWakePhrase(text: string): ArvisWakeParseResult {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return { triggered: false, message: '' };
  }

  const match = normalized.match(WAKE_PREFIX) || normalized.match(PARTIAL_WAKE);
  if (!match) {
    return { triggered: false, message: normalized };
  }

  return {
    triggered: true,
    message: normalizeWakeMessage(normalized.slice(match[0].length)),
  };
}

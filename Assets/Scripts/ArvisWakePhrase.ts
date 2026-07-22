export type ArvisWakeParseResult = {
  triggered: boolean;
  message: string;
};

const WAKE_GREETING = '(?:hey|hi|ok(?:ay)?|yo|the|okay)';

/** Explicit ASR mishearings of the agent name "arvis". */
const AGENT_WAKE_ALIASES =
  'arvis|arvisu|arvissu|arvis\'?s?|arvest|arviz|arvin|arvus|avis|armis|harvis|jarvis|airvis|arvos|arbus|harvest|ars|argos|argo|obis|orbis|arbes|arbeu|arvice|arviss';

/** Spaced or split tokens ASR emits for the agent name. */
const AGENT_WAKE_COMPOUND = 'har\\s*vest|a\\s*vis|a\\s*r\\s*vis|our\\s*vis|are\\s*vis';

/** Short arv* finals ASR often stops on before adding s/t (e.g. arvi, arve, arvo). */
const AGENT_WAKE_FUZZY = 'arv[iueo][a-z]{0,2}';

const WAKE_NAME_PATTERN = `(?:${AGENT_WAKE_ALIASES}|${AGENT_WAKE_COMPOUND}|${AGENT_WAKE_FUZZY})`;

const KOREAN_WAKE_PREFIX =
  /^헤이[\s,]*(?:아르비스|아르비즈|아르빈|어비스|알비스|아르베스|하르비스|아로마|아르베)?[\s,.?!]*$/i;

const WAKE_PREFIX = new RegExp(
  `^${WAKE_GREETING}[,\\s]+arvis\\b[,\\s.]*`,
  'i'
);

// Truncated finals like "hey, a." or "hey ar" before ASR finishes the name.
const PARTIAL_WAKE = new RegExp(
  `^${WAKE_GREETING}[,\\s]+(?:a\\.?|ar\\.?|arg\\.?|ars\\.?|arv\\.?|arvi\\.?)[,\\s.]*$`,
  'i'
);

const AGENT_WAKE_ALIAS_PATTERN = new RegExp(`\\b${WAKE_NAME_PATTERN}\\b`, 'gi');
const AGENT_WAKE_ALIAS_DETECT = new RegExp(`\\b${WAKE_NAME_PATTERN}\\b`, 'i');

/** ASR often emits full-width CJK punctuation with English words (e.g. "hey，arvis？"). */
export function normalizeAsrTranscript(text: string): string {
  return String(text || '')
    .replace(/\uFF0C/g, ',')
    .replace(/\uFF01/g, '!')
    .replace(/\uFF1F/g, '?')
    .replace(/\uFF0E/g, '.')
    .replace(/\u3002/g, '.')
    .replace(/\uFF1A/g, ':')
    .replace(/\uFF1B/g, ';')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/^嘿[\s,]*/u, 'hey ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Map common ASR mishearings of the agent name to canonical "arvis" for wake matching. */
function canonicalizeAgentWakeNames(text: string): string {
  return String(text || '').replace(AGENT_WAKE_ALIAS_PATTERN, 'arvis');
}

export function isIgnorableUtterance(text: string): boolean {
  const normalized = normalizeAsrTranscript(text);
  if (!normalized) {
    return true;
  }
  return !/[a-z0-9\uac00-\ud7af\u4e00-\u9fff]{2,}/u.test(normalized);
}

export function looksLikePossibleAgentWake(text: string): boolean {
  const normalized = canonicalizeAgentWakeNames(normalizeAsrTranscript(text));
  if (!normalized || isIgnorableUtterance(normalized)) {
    return false;
  }
  return (
    /\b(hey|hi|okay|ok|yo|arvis)\b/.test(normalized) ||
    /^hey\b/.test(normalized) ||
    AGENT_WAKE_ALIAS_DETECT.test(normalizeAsrTranscript(text)) ||
    KOREAN_WAKE_PREFIX.test(String(text || '').trim())
  );
}

function normalizeWakeMessage(message: string): string {
  return normalizeAsrTranscript(message)
    .replace(/^[.,!?;:\s]+|[.,!?;:\s]+$/g, '')
    .trim();
}

export function hasWakeFollowUp(message: string): boolean {
  const normalized = normalizeWakeMessage(message);
  if (!normalized) {
    return false;
  }

  const nested = parseArvisWakePhrase(normalized);
  if (nested.triggered && !normalizeWakeMessage(nested.message)) {
    return false;
  }

  return true;
}

export function isWakeOnlyFragment(text: string): boolean {
  const normalized = canonicalizeAgentWakeNames(normalizeWakeMessage(text));
  if (!normalized) {
    return true;
  }
  if (normalized.length < 3) {
    return true;
  }
  // Bare greeting / name, or truncated wake while ASR is still catching up.
  if (
    /^(?:hey|hi|hello|ok|okay|yo|the|arvis)(?:[\s,!.?]+(?:hey|hi|hello|ok|okay|yo|the|arvis)?)*$/i.test(
      normalized
    )
  ) {
    return true;
  }
  if (
    /^(?:hey|hi|ok|okay|yo|the)[\s,]+(?:a|ar|arg|ars|arv|arvi|arvis)?\.?$/i.test(normalized)
  ) {
    return true;
  }
  const wake = parseArvisWakePhrase(normalized);
  return wake.triggered && !normalizeWakeMessage(wake.message);
}

export function looksLikeAssistantEcho(text: string): boolean {
  const normalized = normalizeAsrTranscript(text);
  if (!normalized) {
    return false;
  }

  return (
    /\bi'?m arvis\b/.test(normalized) ||
    /\bi'?m listening\b/.test(normalized) ||
    /\byour arvis assistant\b/.test(normalized) ||
    /\bthe arvis assistant\b/.test(normalized) ||
    /\bflow garden assistant\b/.test(normalized) ||
    /\bflow garden, todos\b/.test(normalized) ||
    /\bgarden, tasks, and notes\b/.test(normalized) ||
    /\bwhat do you want to do\b/.test(normalized) ||
    /\bwhat can i help with\b/.test(normalized) ||
    /\bi can'?t fetch live news\b/.test(normalized) ||
    /\bi couldn'?t reach\b/.test(normalized) ||
    /\blive news feed\b/.test(normalized) ||
    /\bnews feed just now\b/.test(normalized) ||
    /\bpair your device for live\b/.test(normalized) ||
    /\bfor live headlines\b/.test(normalized) ||
    /\btry again in a moment\b/.test(normalized) ||
    /\bstill help with your garden\b/.test(normalized) ||
    /\bheadlines, or try again\b/.test(normalized) ||
    (/\bpair your device\b/.test(normalized) && /\bheadlines\b/.test(normalized)) ||
    /\blens studio editor preview\b/.test(normalized) ||
    /\bi can help with flow garden\b/.test(normalized) ||
    /\bi can help with your garden\b/.test(normalized) ||
    /\beditor mock is active\b/.test(normalized) ||
    /\bpair on spectacles\b/.test(normalized)
  );
}

const CONVERSATIONAL_FILLER =
  /^(?:(?:okay|ok|cool|um+|uh+|hmm+|yeah|yes|so|well|like|alright|right|sure|thanks|thank you|got it|nice|great|awesome)(?:[\s,.!?]+(?:okay|ok|cool|um+|uh+|hmm+|yeah|yes|so|well|like|alright|right|sure|thanks|thank you|got it|nice|great|awesome))*)[\s,.!?]*/i;

const ASSISTANT_ECHO_PREFIX =
  /^(?:i'?m listening\.?\s*|hey — i'?m arvis\.?\s*|hey, i'?m arvis\.?\s*|i help with your garden[^.?!]*[.?!]?\s*|in preview i answer locally[^.?!]*[.?!]?\s*)+/i;

/** Strip leading "okay, cool, um…" and similar ASR filler before prompts or bubble text. */
export function stripConversationalFiller(text: string): string {
  let result = normalizeAsrTranscript(text);
  while (CONVERSATIONAL_FILLER.test(result)) {
    result = result.replace(CONVERSATIONAL_FILLER, '').trim();
  }
  return result;
}

const ASSISTANT_ECHO_SUFFIX =
  /\s*(?:[,.\s!]*(?:i'?m listening\.?|hey(?:[,—-]|\s)+i'?m arvis\.?))\s*$/i;

/** Remove TTS/assistant echo suffixes ASR picks up after the listening cue plays. */
export function stripAssistantEchoSuffix(text: string): string {
  let result = String(text || '').trim();
  while (ASSISTANT_ECHO_SUFFIX.test(result)) {
    const next = result.replace(ASSISTANT_ECHO_SUFFIX, '').trim();
    if (next === result) {
      break;
    }
    result = next;
  }
  return result;
}

/** Remove TTS/assistant echo prefixes that ASR often re-captures during open mic. */
export function stripAssistantEchoPrefix(text: string): string {
  let result = stripConversationalFiller(text);
  while (ASSISTANT_ECHO_PREFIX.test(result)) {
    const next = result.replace(ASSISTANT_ECHO_PREFIX, '').trim();
    if (next === result) {
      break;
    }
    result = next;
  }
  return stripAssistantEchoSuffix(result);
}

/** Clean live/listening transcripts before display or auto-send. */
export function sanitizeListeningTranscript(text: string): string {
  const cleaned = stripAssistantEchoPrefix(text);
  if (
    !cleaned ||
    isIgnorableUtterance(cleaned) ||
    looksLikeAssistantEcho(cleaned) ||
    isWakeOnlyFragment(cleaned)
  ) {
    return '';
  }

  const wake = parseArvisWakePhrase(cleaned);
  if (wake.triggered) {
    const prompt = stripConversationalFiller(normalizeWakeMessage(wake.message));
    return !prompt || isWakeOnlyFragment(prompt) ? '' : prompt;
  }

  // Incomplete wake in progress ("hey" / "hey a") — keep bubble on Listening…
  if (looksLikePossibleAgentWake(cleaned) && !extractAgentPrompt(cleaned)) {
    return '';
  }

  return cleaned;
}

export function extractAgentPrompt(text: string): string {
  const sanitized = stripAssistantEchoPrefix(text);
  const wake = findArvisWakeInTranscript(sanitized);
  if (wake.triggered && hasWakeFollowUp(wake.message)) {
    const prompt = stripConversationalFiller(normalizeWakeMessage(wake.message));
    return isWakeOnlyFragment(prompt) ? '' : prompt;
  }
  if (wake.triggered) {
    return '';
  }
  const prompt = stripConversationalFiller(normalizeWakeMessage(sanitized));
  return isWakeOnlyFragment(prompt) ? '' : prompt;
}

export function parseArvisWakePhrase(text: string): ArvisWakeParseResult {
  const raw = String(text || '').trim();
  const normalized = canonicalizeAgentWakeNames(normalizeAsrTranscript(raw));
  if (!normalized || isIgnorableUtterance(normalized)) {
    return { triggered: false, message: '' };
  }

  if (KOREAN_WAKE_PREFIX.test(raw)) {
    return { triggered: true, message: '' };
  }

  if (/^arvis\b[\s,.!?]*$/i.test(normalized)) {
    return { triggered: true, message: '' };
  }

  const match = normalized.match(WAKE_PREFIX) || normalized.match(PARTIAL_WAKE);
  if (match) {
    return {
      triggered: true,
      message: normalizeWakeMessage(normalized.slice(match[0].length)),
    };
  }

  const trailingWake = new RegExp(
    `^(.+?)${WAKE_GREETING}?[,\\s]+arvis\\b[,\\s.?!]*$`,
    'i'
  );
  const trailingMatch = normalized.match(trailingWake);
  if (trailingMatch && trailingMatch[1]) {
    const body = normalizeWakeMessage(trailingMatch[1]);
    if (body.length > 2 && !looksLikeAssistantEcho(body)) {
      return { triggered: true, message: body };
    }
  }

  return { triggered: false, message: '' };
}

/**
 * Find the last "hey arvis …" (or alias) even inside noisy / ambient transcripts.
 * VoiceML in editor often appends TV/mic bleed before the wake phrase.
 */
export function findArvisWakeInTranscript(text: string): ArvisWakeParseResult {
  const normalized = canonicalizeAgentWakeNames(normalizeAsrTranscript(text));
  if (!normalized) {
    return { triggered: false, message: '' };
  }

  const direct = parseArvisWakePhrase(normalized);
  if (direct.triggered) {
    return direct;
  }

  const wakeToken = new RegExp(`(?:${WAKE_GREETING})[,\\s]+arvis\\b[,\\s.]*`, 'gi');
  let lastStart = -1;
  let lastLen = 0;
  let match: RegExpExecArray | null = wakeToken.exec(normalized);
  while (match) {
    lastStart = match.index;
    lastLen = match[0].length;
    match = wakeToken.exec(normalized);
  }

  if (lastStart < 0) {
    // Bare "arvis" as its own clause near the end.
    const bare = normalized.match(/(?:^|[.!?;]\s+)(arvis)\b[,\\s.]*(.*)$/i);
    if (bare) {
      return {
        triggered: true,
        message: normalizeWakeMessage(bare[2] || ''),
      };
    }
    return { triggered: false, message: '' };
  }

  return {
    triggered: true,
    message: normalizeWakeMessage(normalized.slice(lastStart + lastLen)),
  };
}

/** Long non-wake finals are usually ambient TV / room bleed in editor VoiceML. */
export function isLikelyAmbientTranscript(text: string): boolean {
  const normalized = normalizeAsrTranscript(text);
  if (!normalized) {
    return false;
  }
  if (findArvisWakeInTranscript(normalized).triggered) {
    return false;
  }
  const words = normalized.split(/\s+/).filter((w) => w.length > 0);
  return normalized.length >= 48 || words.length >= 8;
}

/** ASR partials like "can you generate an-" should not be sent to the agent yet. */
export function looksLikeIncompleteAgentPrompt(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length < 6) {
    return true;
  }
  if (/[^\s]-$/.test(t)) {
    return true;
  }
  if (
    /\b(can you|could you|would you|will you)\s+(generate|create|make|draw|show|tell|give|get)\s+(an?|a|the|me)?$/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\b(generate|create|make|draw|show)\s+(an?|a|the|me|image|picture|photo|pic)?$/i.test(t)) {
    return true;
  }
  return false;
}

/** Hints for ASR module context vocabulary (SpeechRecognition). */
export function getAgentWakeVocabHints(): string[] {
  return [
    'arvis',
    'arvest',
    'arviz',
    'arvin',
    'avis',
    'armis',
    'harvis',
    'jarvis',
    'harvest',
    'hey arvis',
    'hey arvest',
    'hey arviz',
    'hey avis',
    'hey arvisu',
    'hey harvest',
    'hey armis',
    'hey jarvis',
    'the avis',
    'hey a',
  ];
}

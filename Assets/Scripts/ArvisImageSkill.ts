/** Client-side image generation intent (matches arvis.space /api/chat /image handling). */

const IMAGE_CMD_PATTERN = /^\/(?:concept|image|art)\s+([\s\S]{1,700})$/i;

const SPATIAL_IMAGE_CMD_PATTERN = /^\/(?:spatial-image|spatial)\s+([\s\S]{1,700})$/i;

/** ASR often returns past tense ("generated image of…") — server needs `/image subject`. */
const IMAGE_VERB =
  '(?:generat(?:e|ed|ing)|creat(?:e|ed|ing)|mak(?:e|ing|made)|draw(?:ing|n)?|render(?:ed|ing)?|design(?:ed|ing)?|produc(?:e|ed|ing)|show(?:\\s+me)?)';

const NATURAL_IMAGE_PATTERN = new RegExp(
  `^${IMAGE_VERB}\\s+(?:me\\s+)?(?:an?\\s+)?(?:image|picture|photo|illustration|drawing|sketch|concept(?:\\s+art)?)\\s+(?:of\\s+)?([\\s\\S]{1,700})$`,
  'i'
);

const NATURAL_SPATIAL_IMAGE_PATTERN =
  /^(?:generate|create|make|draw|render|design|produce|show(?:\s+me)?)\s+(?:me\s+)?(?:an?\s+)?(?:spatial(?:ized)?\s+)?(?:image|picture|photo|illustration)\s+(?:of\s+)?([\s\S]{1,700})$/i;

const LOOSE_IMAGE_INTENT_PATTERN =
  /\b(?:generat(?:e|ed|ing)|creat(?:e|ed|ing)|mak(?:e|ing|made)|draw(?:ing|n)?|render(?:ed|ing)?|design(?:ed|ing)?|produc(?:e|ed|ing))\b[\s\S]{0,48}\b(?:an?\s+)?(?:image|picture|photo|illustration|drawing|sketch|concept(?:\s+art)?)\s+of\b/i;

const CONCEPT_ART_PATTERN =
  /\b(sketch|sketches|storyboard|mockup|illustration|illustrate|doodle|concept art|concept-art|concept sketch|visual concept|drawings?)\b/i;

export function isSpatialImageQuery(message: string): boolean {
  const raw = String(message || '').trim();
  if (!raw) {
    return false;
  }
  if (SPATIAL_IMAGE_CMD_PATTERN.test(raw)) {
    return true;
  }
  if (NATURAL_SPATIAL_IMAGE_PATTERN.test(raw) && /\bspatial(?:ized|ize|izing)?\b/i.test(raw)) {
    return true;
  }
  if (
    /\b(spatial(?:ized)?\s+(?:image|picture|photo)|3d\s+(?:image|picture|photo))\b/i.test(raw)
  ) {
    return true;
  }
  if (
    /\b(show|display|place|put|hang|spawn)\b/i.test(raw) &&
    /\b(spatial|in\s+(?:the\s+)?(?:garden|world|space|room)|as\s+a\s+3d)\b/i.test(raw) &&
    /\b(image|picture|photo|illustration|art)\b/i.test(raw)
  ) {
    return true;
  }
  return false;
}

export function isImageQuery(message: string): boolean {
  const raw = String(message || '').trim();
  if (!raw) {
    return false;
  }
  if (isSpatialImageQuery(raw)) {
    return true;
  }
  if (
    /\b(3d\s+model|3d\s+mesh|3d\s+object|text[\s-]?to[\s-]?3d|snap3d|mesh generation)\b/i.test(raw)
  ) {
    return false;
  }
  if (IMAGE_CMD_PATTERN.test(raw)) {
    return true;
  }
  if (NATURAL_IMAGE_PATTERN.test(raw)) {
    return true;
  }
  if (LOOSE_IMAGE_INTENT_PATTERN.test(raw)) {
    return true;
  }
  if (/\b(?:generated|generating)\s+(?:an?\s+)?(?:image|picture|photo|illustration)\b/i.test(raw)) {
    return true;
  }
  if (/\b(slide deck|slides?|presentation|pitch deck|deck|keynote|powerpoint|pptx?)\b/i.test(raw)) {
    return false;
  }
  if (CONCEPT_ART_PATTERN.test(raw)) {
    return true;
  }
  if (
    /\b(?:create|creat(?:ed|ing)|make|making|made|generate|generat(?:ed|ing)|draw|drawing|drawn|sketch|show|produce|produced|render|rendered|design|designed|build|need|want|please)\b/i.test(
      raw
    ) &&
    /\b(sketch|sketches|concept|illustration|mockup|storyboard|visual|drawing|art|picture|image)\b/i.test(raw)
  ) {
    return true;
  }
  if (
    /\b(show me|show us|let me see|i want to see|take me to|put me in)\s+/i.test(raw) &&
    /\b(universe|cosmos|galaxy|space|ocean|forest|jungle|beach|desert|mountain|city|world|earth|planet|sunset|aurora|environment|scene|sky|stars?|nebula)\b/i.test(
      raw
    )
  ) {
    return true;
  }
  return false;
}

export function extractImageSubject(message: string): string {
  let input = String(message || '').trim();
  if (!input) {
    return '';
  }

  const spatialCmdMatch = input.match(SPATIAL_IMAGE_CMD_PATTERN);
  if (spatialCmdMatch?.[1]) {
    return sanitizeImageSubject(spatialCmdMatch[1]);
  }

  const cmdMatch = input.match(IMAGE_CMD_PATTERN);
  if (cmdMatch?.[1]) {
    return sanitizeImageSubject(cmdMatch[1]);
  }

  const spatialNaturalMatch = input.match(NATURAL_SPATIAL_IMAGE_PATTERN);
  if (spatialNaturalMatch?.[1] && isSpatialImageQuery(input)) {
    return sanitizeImageSubject(spatialNaturalMatch[1]);
  }

  const naturalMatch = input.match(NATURAL_IMAGE_PATTERN);
  if (naturalMatch?.[1]) {
    return sanitizeImageSubject(naturalMatch[1]);
  }

  input = input
    .replace(/^@\w+\s+/gi, '')
    .replace(/^(?:hey|hi|hello|yo|okay|ok)\s+(?:jarvis|claw|arvis|\w+)\s*,?\s*/i, '')
    .replace(/^(?:jarvis|claw|arvis)\s*,?\s*/i, '')
    .replace(/^(?:please\s+)?(?:can you|could you|would you|will you)\s+/i, '')
    .replace(/^please\s+/i, '')
    .trim();

  const visualizeMatch = input.match(/\bvisualiz(?:e|ing)\s+(?:the\s+)?(.+)$/i);
  if (visualizeMatch?.[1]) {
    input = visualizeMatch[1].trim();
  }

  const showMeMatch = input.match(
    /\b(?:show me|show us|let me see|i want to see|take me to|put me in|immerse me in)\s+(?:the\s+)?(.+)$/i
  );
  if (showMeMatch?.[1]) {
    input = showMeMatch[1].trim();
  }

  const ofMatch = input.match(
    /\b(?:an?\s+)?(?:image|picture|photo|illustration|sketch|sketches|drawing|render|art|concept(?:\s+art)?|visual(?:ization)?)\s+of\s+(.+)$/i
  );
  if (ofMatch?.[1]) {
    input = ofMatch[1].trim();
  } else {
    input = input
      .replace(
        /^(?:generat(?:e|ed|ing)|creat(?:e|ed|ing)|mak(?:e|ing|made)|draw(?:ing|n)?|render(?:ed|ing)?|design(?:ed|ing)?|produc(?:e|ed|ing)|show me|give me|build|need|want|visualiz(?:e|ing))\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|illustration|sketch|sketches|drawing|render|art|concept(?:\s+art)?|visual(?:ization)?)\s+(?:of\s+)?/i,
        ''
      )
      .replace(
        /^(?:an?\s+)?(?:image|picture|photo|illustration|sketch|sketches|drawing|render|art|concept(?:\s+art)?|visual(?:ization)?)\s+(?:of\s+)?/i,
        ''
      )
      .trim();
  }

  return sanitizeImageSubject(input);
}

export function normalizeImagePrompt(message: string): string | null {
  const raw = String(message || '').trim();
  if (!raw || !isImageQuery(raw)) {
    return null;
  }

  if (SPATIAL_IMAGE_CMD_PATTERN.test(raw)) {
    const match = raw.match(SPATIAL_IMAGE_CMD_PATTERN);
    const subject = sanitizeImageSubject(match?.[1] || '');
    return subject ? `/image ${subject}` : null;
  }

  if (IMAGE_CMD_PATTERN.test(raw)) {
    const match = raw.match(IMAGE_CMD_PATTERN);
    const subject = sanitizeImageSubject(match?.[1] || '');
    return subject ? `/image ${subject}` : null;
  }

  const subject = extractImageSubject(raw);
  return subject ? `/image ${subject}` : null;
}

export function getImageDisplayMode(message: string): 'flat' | 'spatial' {
  return isSpatialImageQuery(message) ? 'spatial' : 'flat';
}

export function resolveAgentImageUrl(imageUrl: string | undefined, apiBaseUrl: string): string {
  const trimmed = String(imageUrl || '').trim();
  if (!trimmed) {
    return '';
  }
  if (/^data:image\//i.test(trimmed)) {
    return trimmed;
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

export function extractImageUrlFromAgentResponse(
  response: string,
  imageUrl?: string,
  apiBaseUrl?: string
): string | undefined {
  const direct = resolveAgentImageUrl(imageUrl, apiBaseUrl || 'https://arvis.space');
  if (direct) {
    return direct;
  }

  const text = String(response || '');
  const dataUrlMatch = text.match(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/i);
  if (dataUrlMatch?.[0]) {
    return dataUrlMatch[0].replace(/\s/g, '');
  }

  const httpMatch = text.match(/https?:\/\/[^\s)\]]+/i);
  if (httpMatch?.[0]) {
    return httpMatch[0].trim();
  }

  const relativeMatch = text.match(/(\/uploads\/[^\s)\]]+\.(?:png|jpg|jpeg|gif|webp))/i);
  if (relativeMatch?.[1]) {
    return resolveAgentImageUrl(relativeMatch[1], apiBaseUrl || 'https://arvis.space');
  }

  return undefined;
}

function sanitizeImageSubject(subject: string): string {
  return String(subject || '')
    .trim()
    .replace(/[.?!]+$/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 700);
}

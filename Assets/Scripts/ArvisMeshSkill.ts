/** Client-side 3D / Snap3D generation intent (matches arvis.space /api/chat /mesh handling). */

const MESH_CMD_PATTERN = /^\/(?:mesh|3d|model)\s+([\s\S]{1,700})$/i;

const NATURAL_MESH_PATTERN =
  /^(?:generate|create|make|build|produce|design|render|show(?:\s+me)?)\s+(?:me\s+)?(?:an?\s+)?(?:3d\s+)?(?:model|mesh|object|sculpture|figurine|statue)\s+(?:of\s+)?([\s\S]{1,700})$/i;

const MESH_OF_PATTERN =
  /\b(?:3d|three[\s-]?dimensional)\s+(?:model|mesh|object|version)\s+of\s+([\s\S]{1,700})$/i;

export function isMeshQuery(message: string): boolean {
  const raw = String(message || '').trim();
  if (!raw) {
    return false;
  }
  if (MESH_CMD_PATTERN.test(raw)) {
    return true;
  }
  if (NATURAL_MESH_PATTERN.test(raw)) {
    return true;
  }
  if (MESH_OF_PATTERN.test(raw)) {
    return true;
  }
  if (
    /\b(create|make|generate|build|design|render|show|produce|need|want|please)\b/i.test(raw) &&
    /\b(3d\s+model|3d\s+mesh|3d\s+object|snap3d|text[\s-]?to[\s-]?3d|mesh generation)\b/i.test(raw)
  ) {
    return true;
  }
  return false;
}

export function extractMeshSubject(message: string): string {
  let input = String(message || '').trim();
  if (!input) {
    return '';
  }

  const cmdMatch = input.match(MESH_CMD_PATTERN);
  if (cmdMatch?.[1]) {
    return sanitizeMeshSubject(cmdMatch[1]);
  }

  const naturalMatch = input.match(NATURAL_MESH_PATTERN);
  if (naturalMatch?.[1]) {
    return sanitizeMeshSubject(naturalMatch[1]);
  }

  const ofMatch = input.match(MESH_OF_PATTERN);
  if (ofMatch?.[1]) {
    return sanitizeMeshSubject(ofMatch[1]);
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
      /^(?:generate|create|make|build|design|render|produce|show me|give me)\s+(?:me\s+)?(?:an?\s+)?(?:3d\s+)?(?:model|mesh|object|sculpture|figurine|statue)\s+(?:of\s+)?/i,
      ''
    )
    .replace(/^(?:an?\s+)?(?:3d\s+)?(?:model|mesh|object)\s+(?:of\s+)?/i, '')
    .trim();

  return sanitizeMeshSubject(input);
}

export function normalizeMeshPrompt(message: string): string | null {
  const raw = String(message || '').trim();
  if (!raw || !isMeshQuery(raw)) {
    return null;
  }

  if (MESH_CMD_PATTERN.test(raw)) {
    const match = raw.match(MESH_CMD_PATTERN);
    const subject = sanitizeMeshSubject(match?.[1] || '');
    return subject ? `/mesh ${subject}` : null;
  }

  const subject = extractMeshSubject(raw);
  return subject ? `/mesh ${subject}` : null;
}

function sanitizeMeshSubject(subject: string): string {
  return String(subject || '')
    .trim()
    .replace(/[.?!]+$/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 700);
}

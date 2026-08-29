export type ArvisEmailDraftIntent = {
  recipient: string;
  topic: string;
  subject: string;
  body: string;
  requestId: string;
};

const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseArvisEmailDraftIntent(message: string): ArvisEmailDraftIntent | null {
  const normalizedMessage = String(message || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalizedMessage) {
    return null;
  }

  const match = normalizedMessage.match(
    /^(?:please\s+)?(?:draft|write|compose)\s+(?:(?:a|an)\s+)?(?:new\s+)?(?:email|e-mail)\s+to\s+([^\s,;]+@[^\s,;]+)(?:\s+(?:about|regarding|on)\s+(.+))?$/i
  );
  if (!match) {
    return null;
  }

  const recipient = String(match[1] || '').replace(/[.!?,;:]+$/, '').trim();
  if (!EMAIL_ADDRESS_PATTERN.test(recipient)) {
    return null;
  }

  const topic = String(match[2] || 'the DeskGame bridge connection')
    .replace(/[.!?,;:]+$/, '')
    .trim();
  if (!topic) {
    return null;
  }

  return {
    recipient,
    topic,
    subject: `Regarding ${topic}`,
    body: `Hi,\n\nI wanted to reach out about ${topic}.\n\nBest,`,
    requestId: `specs-email-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
  };
}

export function isArvisEmailDraftQuery(message: string): boolean {
  return !isNull(parseArvisEmailDraftIntent(message));
}

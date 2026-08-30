export type ArvisEmailDraftIntent = {
  recipient: string;
  topic: string;
  subject: string;
  body: string;
  requestId: string;
};

const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAC_ROUTING_PATTERN =
  /\b(?:on|from|through|via|using)\s+(?:my\s+)?mac(?:book)?\b/i;

export type ArvisMacOpenAppIntent = {
  applicationName: string;
  requestId: string;
};

export function isExplicitMacRequest(message: string): boolean {
  const normalizedMessage = String(message || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalizedMessage) {
    return false;
  }
  return (
    MAC_ROUTING_PATTERN.test(normalizedMessage) ||
    /\b(?:my\s+)?mac(?:book)?\s+(?:bridge|computer|desktop)\b/i.test(normalizedMessage) ||
    /\btell\s+(?:my\s+)?mac(?:book)?\s+to\b/i.test(normalizedMessage)
  );
}

function stripMacRoutingLanguage(message: string): string {
  return String(message || '')
    .replace(
      /^(?:please\s+)?(?:on|from|through|via|using)\s+(?:my\s+)?mac(?:book)?[,:-]?\s*/i,
      ''
    )
    .replace(
      /\s+(?:on|from|through|via|using)\s+(?:my\s+)?mac(?:book)?[.!?]?\s*$/i,
      ''
    )
    .replace(/^tell\s+(?:my\s+)?mac(?:book)?\s+to\s+/i, '')
    .trim();
}

export function parseArvisEmailDraftIntent(message: string): ArvisEmailDraftIntent | null {
  const normalizedMessage = String(message || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalizedMessage) {
    return null;
  }

  const match = stripMacRoutingLanguage(normalizedMessage).match(
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

export function parseArvisMacOpenAppIntent(
  message: string
): ArvisMacOpenAppIntent | null {
  const normalizedMessage = String(message || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!isExplicitMacRequest(normalizedMessage)) {
    return null;
  }

  const prefixMatch = normalizedMessage.match(
    /^(?:please\s+)?(?:on|from|through|via|using)\s+(?:my\s+)?mac(?:book)?[,:-]?\s*(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?(.+?)[.!?]?$/i
  );
  const suffixMatch = normalizedMessage.match(
    /^(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?(.+?)\s+(?:on|from|through|via|using)\s+(?:my\s+)?mac(?:book)?[.!?]?$/i
  );
  const tellMatch = normalizedMessage.match(
    /^tell\s+(?:my\s+)?mac(?:book)?\s+to\s+(?:open|launch|start)\s+(?:the\s+)?(.+?)[.!?]?$/i
  );
  const rawApplicationName = prefixMatch?.[1] || suffixMatch?.[1] || tellMatch?.[1] || '';
  const applicationName = rawApplicationName
    .replace(/\s+(?:application|app)$/i, '')
    .trim();
  if (!applicationName || applicationName.length > 120) {
    return null;
  }

  return {
    applicationName,
    requestId: `specs-open-app-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
  };
}

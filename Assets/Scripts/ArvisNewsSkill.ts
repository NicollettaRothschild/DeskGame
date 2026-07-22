const NEWS_KEYWORD_PATTERN =
  /\b(news|headlines?|current events|breaking|top stories?)\b/i;

const NEWS_PHRASE_PATTERN =
  /\b(what(?:'s| is) (?:on )?(?:the )?news|what(?:'s| is) in the news|what(?:'s| is) going on(?: today)?|what(?:'s| is) happening(?: today)?|news today|today'?s news|any news|latest news)\b/i;

export function isNewsQuery(message: string): boolean {
  const text = String(message || '').trim();
  if (!text) {
    return false;
  }
  return NEWS_KEYWORD_PATTERN.test(text) || NEWS_PHRASE_PATTERN.test(text);
}

/** Stricter news intent for auto-forwarding — avoids TTS echo fragments that merely contain "news". */
export function isNewsIntentQuery(message: string): boolean {
  const text = String(message || '').trim();
  if (!text) {
    return false;
  }
  if (NEWS_PHRASE_PATTERN.test(text)) {
    return true;
  }
  return /^(?:what(?:'s| is)|any|latest|today'?s|tell me|give me)\b[\s\S]*\bnews\b/i.test(text);
}

export function fetchNewsHeadlinesBrief(
  internetModule: InternetModule,
  query: string,
  onDone: (summary: string | null, error?: string) => void
): void {
  if (isNull(internetModule)) {
    onDone(null, 'InternetModule not configured');
    return;
  }

  let request: RemoteServiceHttpRequest;
  try {
    request = RemoteServiceHttpRequest.create();
  } catch (e) {
    // Editor/simulated preview often cannot create HTTP requests.
    onDone(null, 'News HTTP unavailable on this platform: ' + e);
    return;
  }

  try {
    request.url = 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
    request.method = RemoteServiceHttpRequest.HttpRequestMethod.Get;

    internetModule.performHttpRequest(request, (response: RemoteServiceHttpResponse) => {
      try {
        const status = response.statusCode;
        const raw = String(response.body || '');
        if (status < 200 || status >= 300) {
          onDone(null, `News feed HTTP ${status}`);
          return;
        }

        const headlines = parseRssTitles(raw, 5);
        if (!headlines.length) {
          onDone(null, 'Could not parse headlines');
          return;
        }

        const body = headlines
          .map((headline, index) => `${index + 1}. ${headline}`)
          .join(' ');

        onDone(body);
      } catch (e) {
        onDone(null, String(e));
      }
    });
  } catch (e) {
    onDone(null, 'News request failed: ' + e);
  }
}

function parseRssTitles(xml: string, maxCount: number): string[] {
  const titles: string[] = [];
  const pattern = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi;
  let match = pattern.exec(xml);
  while (match && titles.length < maxCount + 1) {
    const title = String(match[1] || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (title && !/google news|top stories/i.test(title)) {
      titles.push(title.slice(0, 160));
    }
    match = pattern.exec(xml);
  }
  return titles.slice(0, maxCount);
}

export type ArvisCalendarIntentType =
  | 'setCalendarId'
  | 'config'
  | 'availableCalendars'
  | 'events'
  | 'createEvent';

export type ArvisCalendarIntent = {
  type: ArvisCalendarIntentType;
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  rangeLabel?: string;
  title?: string;
  startAt?: string;
  endAt?: string;
  description?: string;
};

type CalendarDateRange = {
  timeMin?: string;
  timeMax?: string;
  rangeLabel?: string;
};

type ParsedEventTiming = {
  startAt: string;
  endAt: string;
};

const CALENDAR_ID_PATTERN = /^[^\s,;!?]+$/;
const DATE_TOKEN_PATTERN =
  /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})\b/i;
const TIME_PATTERN = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i;

export function parseArvisCalendarIntent(message: string): ArvisCalendarIntent | null {
  const text = normalizeCalendarText(message);
  if (!text) {
    return null;
  }

  const setMatch = text.match(
    /^(?:please\s+)?(?:set|use|select|switch(?:\s+to)?)\s+(?:my\s+)?calendar(?:\s+id)?(?:\s+to)?\s+(.+)$/i
  );
  if (setMatch?.[1]) {
    const calendarId = cleanCalendarId(setMatch[1]);
    if (calendarId) {
      return { type: 'setCalendarId', calendarId };
    }
  }

  if (isAvailableCalendarsCommand(text)) {
    return { type: 'availableCalendars' };
  }

  if (isCalendarConfigCommand(text)) {
    return { type: 'config' };
  }

  const createIntent = parseCreateEventIntent(text);
  if (createIntent) {
    return createIntent;
  }

  if (isCalendarEventsCommand(text)) {
    return {
      type: 'events',
      ...parseCalendarDateRange(text),
    };
  }

  return null;
}

export function isArvisCalendarQuery(message: string): boolean {
  return !isNull(parseArvisCalendarIntent(message));
}

function normalizeCalendarText(message: string): string {
  return String(message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(
      /^(?:hey|hi|hello|okay|ok)\s+(?:arvis|jarvis|assistant)\s*,?\s*/i,
      ''
    )
    .trim();
}

function cleanCalendarId(value: string): string {
  const calendarId = String(value || '')
    .replace(/^(?:the\s+)?calendar\s+id\s+(?:is\s+)?/i, '')
    .replace(/[.!?,;:]+$/, '')
    .trim();
  return CALENDAR_ID_PATTERN.test(calendarId) ? calendarId : '';
}

function isAvailableCalendarsCommand(text: string): boolean {
  return (
    /^(?:show|list|display)(?:\s+me)?\s+(?:(?:my|available)\s+)?calendars$/i.test(text) ||
    /^(?:what|which)\s+(?:are\s+)?(?:my\s+)?(?:available\s+)?calendars?(?:\s+do\s+i\s+have|\s+are\s+available)?$/i.test(
      text
    )
  );
}

function isCalendarConfigCommand(text: string): boolean {
  return (
    /\bcalendar\s+(?:id|config(?:uration)?|settings?|connection)\b/i.test(text) ||
    /^(?:which|what)\s+(?:my\s+)?calendar\s+(?:am\s+i\s+using|is\s+(?:selected|active))$/i.test(
      text
    ) ||
    /^(?:show|display|tell me|check)\s+(?:my\s+)?calendar\s+(?:id|config(?:uration)?|settings?|connection)$/i.test(
      text
    )
  );
}

function parseCreateEventIntent(text: string): ArvisCalendarIntent | null {
  const createMatch = text.match(/^(?:please\s+)?(?:schedule|create|add|book)\s+(.+)$/i);
  if (!createMatch?.[1]) {
    return null;
  }

  let details = createMatch[1].trim();
  if (
    !/^(?:schedule|book)\b/i.test(text) &&
    !/\b(?:calendar|event|appointment|meeting)\b/i.test(details)
  ) {
    return null;
  }
  details = details
    .replace(
      /^(?:an?\s+)?(?:calendar\s+)?(?:event|appointment|meeting)\s+(?:called|titled|named|for)\s+/i,
      ''
    )
    .trim();
  if (!details) {
    return null;
  }

  const split = splitEventDetails(details);
  const title = cleanEventTitle(split.title);
  if (!title) {
    return null;
  }

  if (!split.timing) {
    return { type: 'createEvent', title };
  }

  const timing = parseEventTiming(split.timing);
  if (!timing) {
    return { type: 'createEvent', title };
  }

  return {
    type: 'createEvent',
    title,
    startAt: timing.startAt,
    endAt: timing.endAt,
  };
}

function splitEventDetails(details: string): { title: string; timing: string } {
  const dateMatch = DATE_TOKEN_PATTERN.exec(details);
  if (dateMatch && dateMatch.index > 0) {
    const title = details
      .slice(0, dateMatch.index)
      .replace(/\s+(?:on|for|at)\s*$/i, '')
      .trim();
    return { title, timing: details.slice(dateMatch.index).trim() };
  }

  const timeMatch = details.match(/\b(?:at\s+)\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?/i);
  if (timeMatch && timeMatch.index && timeMatch.index > 0) {
    const title = details
      .slice(0, timeMatch.index)
      .replace(/\s+(?:on|for|at)\s*$/i, '')
      .trim();
    return { title, timing: details.slice(timeMatch.index).trim() };
  }

  const explicitDateMatch = details.match(
    /\b(?:on|for)\s+\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?(?:\s+.*)?$/i
  );
  if (explicitDateMatch?.index && explicitDateMatch.index > 0) {
    return {
      title: details.slice(0, explicitDateMatch.index).trim(),
      timing: details.slice(explicitDateMatch.index).replace(/^(?:on|for)\s+/i, '').trim(),
    };
  }

  return { title: details, timing: '' };
}

function cleanEventTitle(value: string): string {
  const title = String(value || '')
    .replace(/^(?:an?\s+)?(?:calendar\s+)?(?:event|appointment|meeting)\s+/i, '')
    .replace(/^(?:an?\s+)(?=(?:calendar\s+)?(?:event|appointment|meeting)\b)/i, '')
    .replace(/^["']|["']$/g, '')
    .replace(/[.!?,;:]+$/, '')
    .trim()
    .slice(0, 180);
  return title;
}

function parseEventTiming(value: string): ParsedEventTiming | null {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  const date = new Date();
  const dateToken = text.match(DATE_TOKEN_PATTERN);
  const explicitDate = text.match(/(\d{4})-(\d{2})-(\d{2})/);

  if (explicitDate) {
    date.setFullYear(
      Number(explicitDate[1]),
      Number(explicitDate[2]) - 1,
      Number(explicitDate[3])
    );
  } else if (dateToken) {
    const token = dateToken[0].toLowerCase();
    if (token === 'tomorrow' || token === 'tonight') {
      date.setDate(date.getDate() + 1);
    } else if (token !== 'today') {
      const weekday = weekdayIndex(token);
      if (weekday >= 0) {
        const daysAhead = (weekday - date.getDay() + 7) % 7 || 7;
        date.setDate(date.getDate() + daysAhead);
      }
    }
  }

  const timeText = text
    .replace(/\d{4}-\d{2}-\d{2}/, '')
    .replace(DATE_TOKEN_PATTERN, '');
  const startMatch = timeText.match(TIME_PATTERN);
  if (startMatch) {
    const startTime = parseClockTime(startMatch[1], startMatch[2], startMatch[3]);
    if (startTime) {
      date.setHours(startTime.hours, startTime.minutes, 0, 0);

      const endMatch = text.match(
        /(?:to|until|through)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i
      );
      if (endMatch) {
        const endTime = parseClockTime(endMatch[1], endMatch[2], endMatch[3]);
        if (endTime) {
          const end = new Date(date.getTime());
          end.setHours(endTime.hours, endTime.minutes, 0, 0);
          if (end.getTime() <= date.getTime()) {
            end.setDate(end.getDate() + 1);
          }
          return { startAt: date.toISOString(), endAt: end.toISOString() };
        }
      }

      const end = new Date(date.getTime() + 60 * 60 * 1000);
      return { startAt: date.toISOString(), endAt: end.toISOString() };
    }
  }

  if (dateToken || explicitDate) {
    date.setHours(0, 0, 0, 0);
    const end = new Date(date.getTime());
    end.setDate(end.getDate() + 1);
    return { startAt: date.toISOString(), endAt: end.toISOString() };
  }

  return null;
}

function parseClockTime(
  hourValue: string,
  minuteValue: string | undefined,
  meridiemValue: string | undefined
): { hours: number; minutes: number } | null {
  let hours = Number(hourValue);
  const minutes = Number(minuteValue || 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 23 || minutes > 59) {
    return null;
  }

  const meridiem = String(meridiemValue || '').toLowerCase().replace(/\./g, '');
  if (meridiem === 'pm' && hours < 12) {
    hours += 12;
  } else if (meridiem === 'am' && hours === 12) {
    hours = 0;
  } else if (meridiem && hours > 12) {
    return null;
  }
  return { hours, minutes };
}

function isCalendarEventsCommand(text: string): boolean {
  if (
    /^(?:show|display|open|read|refresh|sync|check)(?:\s+me)?\s+(?:my\s+)?calendars?\b/i.test(
      text
    )
  ) {
    return true;
  }
  if (/^(?:show|display|list|read|get)(?:\s+me)?\s+(?:my\s+)?(?:schedule|events?|appointments?)\b/i.test(text)) {
    return true;
  }
  if (
    /^(?:what(?:'s| is)|which|do i have|are there)\b[\s\S]*\b(?:on (?:my\s+|the\s+)?calendar|in (?:my\s+|the\s+)?calendar|my schedule|calendar events?|appointments?)\b/i.test(
      text
    )
  ) {
    return true;
  }
  return /\b(?:calendar|schedule|events?|appointments?)\b[\s\S]*\b(?:today|tomorrow|this week|next week|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{4}-\d{2}-\d{2})\b/i.test(
    text
  );
}

function parseCalendarDateRange(text: string): CalendarDateRange {
  const lower = text.toLowerCase();
  const date = new Date();
  let rangeLabel = '';

  const explicitDate = lower.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (explicitDate) {
    const parts = explicitDate[0].split('-');
    date.setFullYear(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    rangeLabel = explicitDate[0];
  } else if (/\btomorrow\b/.test(lower)) {
    date.setDate(date.getDate() + 1);
    rangeLabel = 'tomorrow';
  } else if (/\btoday\b|\btonight\b/.test(lower)) {
    rangeLabel = 'today';
  } else if (/\bnext week\b/.test(lower)) {
    date.setDate(date.getDate() + 7);
    rangeLabel = 'next week';
  } else if (/\bthis week\b/.test(lower)) {
    rangeLabel = 'this week';
  } else {
    const weekdayMatch = lower.match(
      /\b(?:on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/
    );
    if (weekdayMatch?.[1]) {
      const weekday = weekdayIndex(weekdayMatch[1]);
      const daysAhead = (weekday - date.getDay() + 7) % 7 || 7;
      date.setDate(date.getDate() + daysAhead);
      rangeLabel = weekdayMatch[1];
    }
  }

  if (!rangeLabel) {
    return {};
  }

  if (rangeLabel === 'this week' || rangeLabel === 'next week') {
    const day = startOfLocalDay(date);
    if (rangeLabel === 'this week') {
      day.setDate(day.getDate() - day.getDay());
    }
    const end = new Date(day.getTime());
    end.setDate(end.getDate() + 7);
    return {
      timeMin: day.toISOString(),
      timeMax: end.toISOString(),
      rangeLabel,
    };
  }

  const start = startOfLocalDay(date);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    rangeLabel,
  };
}

function startOfLocalDay(date: Date): Date {
  const result = new Date(date.getTime());
  result.setHours(0, 0, 0, 0);
  return result;
}

function weekdayIndex(value: string): number {
  const weekdays = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];
  return weekdays.indexOf(String(value || '').toLowerCase());
}

import { isNewsQuery } from './ArvisNewsSkill';
import { extractMeshSubject, isMeshQuery } from './ArvisMeshSkill';
import { extractImageSubject, isImageQuery, isSpatialImageQuery } from './ArvisImageSkill';
import { extractMusicSubject, isMusicQuery } from './ArvisMusicSkill';

type MockTask = {
  id: string;
  text: string;
  deadline: string | null;
  source: string;
  done: boolean;
};

type MockRegistration = {
  deviceId: string;
  deviceSecret: string;
  paired: boolean;
};

type MockPairStatus = {
  paired: boolean;
  userEmail: string | null;
};

export type MockCalendarConfig = {
  calendarId: string | null;
  calendarName: string | null;
  connected: boolean;
};

export type MockCalendar = {
  id: string;
  name: string;
  description: string;
  primary: boolean;
  timeZone: string;
};

export type MockCalendarEvent = {
  id: string;
  calendarId: string;
  title: string;
  startAt: string;
  endAt: string;
  description: string;
  location: string;
  allDay: boolean;
};

export type MockCalendarEventQuery = {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
};

export type MockCalendarEventInput = {
  calendarId?: string;
  title: string;
  startAt: string;
  endAt: string;
  description?: string;
  location?: string;
};

const STORAGE_DEVICE_SECRET = 'specs_device_secret';
const STORAGE_PAIRED = 'specs_device_paired';
const STORAGE_MOCK_TASKS = 'specs_editor_mock_tasks';
const STORAGE_MOCK_EMAIL = 'specs_editor_mock_user_email';
const STORAGE_MOCK_SPACE = 'specs_editor_mock_space_panel';
const STORAGE_MOCK_CALENDAR_CONFIG = 'specs_editor_mock_calendar_config';
const STORAGE_MOCK_CALENDAR_EVENTS = 'specs_editor_mock_calendar_events';

const DEFAULT_MOCK_TASKS: MockTask[] = [
  { id: 'mock-1', text: 'Water the focus tree', deadline: null, source: 'editor', done: false },
  { id: 'mock-2', text: 'Reply to design review', deadline: null, source: 'editor', done: false },
  { id: 'mock-3', text: 'Ship berry sync prototype', deadline: null, source: 'editor', done: false },
];

const DEFAULT_MOCK_CALENDARS: MockCalendar[] = [
  {
    id: 'primary',
    name: 'Personal',
    description: 'Primary editor preview calendar',
    primary: true,
    timeZone: 'local',
  },
  {
    id: 'work',
    name: 'Work',
    description: 'Work calendar for editor preview',
    primary: false,
    timeZone: 'local',
  },
];

export class SpecsEditorMock {
  public static register(deviceId: string): MockRegistration {
    const store = global.persistentStorageSystem.store;
    let secret = String(store.getString(STORAGE_DEVICE_SECRET) || '').trim();
    if (!secret) {
      secret = 'mock-' + deviceId.toLowerCase().replace(/[^a-z0-9]/g, '');
      store.putString(STORAGE_DEVICE_SECRET, secret);
    }

    const paired = store.getBool(STORAGE_PAIRED);
    return { deviceId, deviceSecret: secret, paired };
  }

  public static fetchPairStatus(): MockPairStatus {
    const store = global.persistentStorageSystem.store;
    const paired = store.getBool(STORAGE_PAIRED);
    const email = String(store.getString(STORAGE_MOCK_EMAIL) || '').trim();
    return {
      paired,
      userEmail: paired ? (email || 'editor@test.local') : null,
    };
  }

  public static markPaired(userEmail: string = 'editor@test.local'): void {
    const store = global.persistentStorageSystem.store;
    store.putBool(STORAGE_PAIRED, true);
    store.putString(STORAGE_MOCK_EMAIL, userEmail);
    this.ensureDefaultTasks();
    this.fetchCalendarConfig();
    this.loadCalendarEvents();
  }

  public static clearPaired(): void {
    const store = global.persistentStorageSystem.store;
    store.putBool(STORAGE_PAIRED, false);
    store.putString(STORAGE_MOCK_EMAIL, '');
  }

  public static fetchTasks(): MockTask[] {
    const store = global.persistentStorageSystem.store;
    if (!store.getBool(STORAGE_PAIRED)) {
      return [];
    }

    const raw = store.getString(STORAGE_MOCK_TASKS);
    if (!raw) {
      return this.ensureDefaultTasks();
    }

    try {
      const parsed = JSON.parse(raw) as MockTask[];
      if (!Array.isArray(parsed)) {
        return this.ensureDefaultTasks();
      }
      return parsed.filter((task) => task && task.id && task.text && !task.done);
    } catch {
      return this.ensureDefaultTasks();
    }
  }

  public static createTask(text: string): string {
    const trimmed = String(text || '').trim().slice(0, 240);
    const taskId = `voice-${Date.now()}`;
    const tasks = this.fetchTasks();
    const next = [
      {
        id: taskId,
        text: trimmed,
        deadline: null,
        source: 'voice',
        done: false,
      },
      ...tasks,
    ];
    global.persistentStorageSystem.store.putString(STORAGE_MOCK_TASKS, JSON.stringify(next));
    return taskId;
  }

  public static completeTask(taskId: string): boolean {
    const tasks = this.fetchTasks();
    const next = tasks.filter((task) => task.id !== taskId);
    global.persistentStorageSystem.store.putString(STORAGE_MOCK_TASKS, JSON.stringify(next));
    return true;
  }

  public static fetchCalendarConfig(): MockCalendarConfig {
    const store = global.persistentStorageSystem.store;
    const raw = store.getString(STORAGE_MOCK_CALENDAR_CONFIG);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {
          calendarId?: unknown;
          calendarName?: unknown;
          connected?: unknown;
        };
        if (parsed && typeof parsed === 'object') {
          const calendarId = String(parsed.calendarId || '').trim();
          return {
            calendarId: calendarId || null,
            calendarName: parsed.calendarName ? String(parsed.calendarName) : null,
            connected: parsed.connected !== false,
          };
        }
      } catch {
        // fall through to the default editor calendar
      }
    }

    const config: MockCalendarConfig = {
      calendarId: 'primary',
      calendarName: 'Personal',
      connected: true,
    };
    store.putString(STORAGE_MOCK_CALENDAR_CONFIG, JSON.stringify(config));
    return config;
  }

  public static setCalendarId(calendarId: string): MockCalendarConfig {
    const normalizedId = String(calendarId || '').trim();
    const matchingCalendar = DEFAULT_MOCK_CALENDARS.find(
      (calendar) => calendar.id === normalizedId
    );
    const config: MockCalendarConfig = {
      calendarId: normalizedId || null,
      calendarName: matchingCalendar ? matchingCalendar.name : null,
      connected: true,
    };
    global.persistentStorageSystem.store.putString(
      STORAGE_MOCK_CALENDAR_CONFIG,
      JSON.stringify(config)
    );
    return config;
  }

  public static fetchAvailableCalendars(): MockCalendar[] {
    return DEFAULT_MOCK_CALENDARS.map((calendar) => ({ ...calendar }));
  }

  public static fetchCalendarEvents(
    query: MockCalendarEventQuery = {}
  ): MockCalendarEvent[] {
    const config = this.fetchCalendarConfig();
    const calendarId = String(query.calendarId || config.calendarId || '').trim();
    const timeMin = query.timeMin ? Date.parse(query.timeMin) : NaN;
    const timeMax = query.timeMax ? Date.parse(query.timeMax) : NaN;
    const events = this.loadCalendarEvents()
      .filter((event) => {
        if (calendarId && event.calendarId !== calendarId) {
          return false;
        }
        const eventTime = Date.parse(event.startAt);
        if (Number.isFinite(timeMin) && (!Number.isFinite(eventTime) || eventTime < timeMin)) {
          return false;
        }
        if (Number.isFinite(timeMax) && (!Number.isFinite(eventTime) || eventTime >= timeMax)) {
          return false;
        }
        return true;
      })
      .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));

    const maxResults = Number(query.maxResults || 10);
    return events
      .slice(0, Number.isFinite(maxResults) ? Math.max(1, Math.floor(maxResults)) : 10)
      .map((event) => ({ ...event }));
  }

  public static createCalendarEvent(input: MockCalendarEventInput): MockCalendarEvent {
    const config = this.fetchCalendarConfig();
    const calendarId = String(input.calendarId || config.calendarId || 'primary').trim();
    const title = String(input.title || '').trim();
    const startAt = String(input.startAt || '').trim();
    const explicitEndAt = String(input.endAt || '').trim();
    const startTime = Date.parse(startAt);
    const endAt =
      explicitEndAt ||
      (Number.isFinite(startTime) ? new Date(startTime + 60 * 60 * 1000).toISOString() : startAt);
    const event: MockCalendarEvent = {
      id: `mock-calendar-event-${Date.now()}`,
      calendarId,
      title,
      startAt,
      endAt,
      description: String(input.description || '').trim(),
      location: String(input.location || '').trim(),
      allDay: false,
    };
    const events = this.loadCalendarEvents();
    events.unshift(event);
    global.persistentStorageSystem.store.putString(
      STORAGE_MOCK_CALENDAR_EVENTS,
      JSON.stringify(events)
    );
    return event;
  }

  public static chatWithAgent(
    agentName: string,
    message: string,
    history: Array<{ role: string; text: string }> = []
  ): { agent: { name: string; role: string }; response: string; model: string; imageUrl?: string; musicUrl?: string } {
    const name = String(agentName || 'Arvis').trim() || 'Arvis';
    const trimmed = String(message || '').trim();
    const lower = trimmed.toLowerCase();
    const lastAssistant = [...history]
      .reverse()
      .find((entry) => entry && entry.role === 'assistant');
    const lastUser = [...history]
      .reverse()
      .find((entry) => entry && entry.role === 'user');

    let response = `Hey — I'm ${name}. I help with your garden, tasks, and notes. In preview I answer locally; on device I use your paired account.`;
    let imageUrl = '';

    const imageSubject = isImageQuery(trimmed) ? extractImageSubject(trimmed) : '';
    const spatialImage = isSpatialImageQuery(trimmed);
    const meshSubject = isMeshQuery(trimmed) ? extractMeshSubject(trimmed) : '';
    const musicSubject = isMusicQuery(trimmed) ? extractMusicSubject(trimmed) : '';

    if (/hello|hi|hey|how are you/.test(lower)) {
      response = `Hey — I'm ${name}. I can help with your garden, tasks, and notes. What can I help with?`;
    } else if (isNewsQuery(trimmed)) {
      response =
        `I couldn't reach the live news feed just now. Pair your device for live headlines, ` +
        `or try again in a moment. I can still help with your garden, tasks, or notes.`;
    } else if (meshSubject) {
      response =
        `Generating a 3D model (editor preview mock).\n` +
        `"${meshSubject.slice(0, 160)}"\n` +
        `On device with RemoteServiceGateway + pairing, Snap3D will spawn the mesh in your garden.`;
    } else if (musicSubject) {
      response =
        `Music request noted (editor preview mock).\n` +
        `"${musicSubject.slice(0, 160)}"\n` +
        `Pair at arvis.space/specs on device — Lyria + Snap Cloud will compose and play a ~30s track.`;
    } else if (imageSubject) {
      response = spatialImage
        ? `Spatial image ready (editor preview mock).\n"${imageSubject.slice(0, 160)}"\nOn device with RemoteServiceGateway + pairing, the image will depth-spatialize in your garden.`
        : `Concept art ready (editor preview mock).\n"${imageSubject.slice(0, 160)}"`;
      // 1x1 PNG placeholder. Lets SpacePanel test image rendering without HTTP.
      imageUrl =
        'data:image/png;base64,' +
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6mZJtUAAAAASUVORK5CYII=';
    } else if (/hear me|can you hear/.test(lower)) {
      response = `Yes — I got "${trimmed}". Speech is working. Ask me anything about your garden or tasks.`;
    } else if (/what(?:'s| is) going on\b/.test(lower) && !isNewsQuery(trimmed)) {
      response =
        `Want today's headlines? Say "what's in the news today." I can also help with your garden or tasks.`;
    } else if (/todo|task|berry|remember/.test(lower)) {
      response = 'Try "todo" plus your task and I will sync it as a berry when you are on device.';
    } else if (/plant|seed|water|pot|garden/.test(lower)) {
      response = 'Pinch to place pots, spawn seeds from the tray, then water to grow. Want a task for that?';
    } else if (/who are you|what are you|stephany|stephanie|ars|avis|arvis/.test(lower)) {
      response = `I'm your Flow Garden assistant. I can help with your garden, tasks, and notes.`;
    } else if (trimmed && lastUser && lastAssistant) {
      response = `About "${trimmed}" — still in editor mock. Deploy to Specs for live arvis.space agent replies.`;
    } else if (trimmed) {
      response =
        `In editor preview I answer locally — pair on Spectacles for live arvis.space chat. What can I help with?`;
    }

    return {
      agent: { name, role: 'Assistant' },
      response,
      model: 'editor/arvis-mock',
      imageUrl: imageUrl || undefined,
    };
  }

  public static fetchSpacePanel(): {
    spaceId: string;
    title: string;
    coverUrl: string;
    updatedAt: string;
    items: Array<{ type: string; id: string; title: string; body: string; imageUrl: string }>;
  } {
    const store = global.persistentStorageSystem.store;
    const raw = store.getString(STORAGE_MOCK_SPACE);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.items)) {
          return parsed;
        }
      } catch {
        // fall through
      }
    }

    const panel = {
      spaceId: 'space_editor_mock',
      title: 'Flow Garden Board',
      coverUrl: '',
      updatedAt: new Date().toISOString(),
      items: [
        {
          type: 'document',
          id: 'mock-doc-1',
          title: 'Welcome doc',
          body: 'This is your ARVIS space board in editor mock mode. Pair on Spectacles to load live notes, docs, and generated images.',
          imageUrl: '',
        },
        {
          type: 'note',
          id: 'mock-note-1',
          title: 'Note',
          body: 'Say "note" plus your text to append a sticky note when paired.',
          imageUrl: '',
        },
      ],
    };
    store.putString(STORAGE_MOCK_SPACE, JSON.stringify(panel));
    return panel;
  }

  public static appendSpaceNote(text: string): {
    spaceId: string;
    title: string;
    coverUrl: string;
    updatedAt: string;
    items: Array<{ type: string; id: string; title: string; body: string; imageUrl: string }>;
  } {
    const panel = this.fetchSpacePanel();
    const note = {
      type: 'note',
      id: `mock-note-${Date.now()}`,
      title: 'Note',
      body: String(text || '').trim().slice(0, 800),
      imageUrl: '',
    };
    panel.items = [note, ...panel.items];
    panel.updatedAt = new Date().toISOString();
    global.persistentStorageSystem.store.putString(STORAGE_MOCK_SPACE, JSON.stringify(panel));
    return panel;
  }

  private static ensureDefaultTasks(): MockTask[] {
    const copy = DEFAULT_MOCK_TASKS.map((task) => ({ ...task }));
    global.persistentStorageSystem.store.putString(STORAGE_MOCK_TASKS, JSON.stringify(copy));
    return copy;
  }

  private static loadCalendarEvents(): MockCalendarEvent[] {
    const store = global.persistentStorageSystem.store;
    const raw = store.getString(STORAGE_MOCK_CALENDAR_EVENTS);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as MockCalendarEvent[];
        if (Array.isArray(parsed)) {
          return parsed.filter(
            (event) =>
              event &&
              String(event.id || '').trim() &&
              String(event.calendarId || '').trim() &&
              String(event.title || '').trim() &&
              String(event.startAt || '').trim()
          );
        }
      } catch {
        // fall through to the default editor events
      }
    }

    const now = new Date();
    const firstStart = new Date(now.getTime() + 60 * 60 * 1000);
    firstStart.setMinutes(0, 0, 0);
    const secondStart = new Date(firstStart.getTime() + 24 * 60 * 60 * 1000);
    const defaults: MockCalendarEvent[] = [
      {
        id: 'mock-calendar-event-1',
        calendarId: 'primary',
        title: 'Flow Garden planning',
        startAt: firstStart.toISOString(),
        endAt: new Date(firstStart.getTime() + 60 * 60 * 1000).toISOString(),
        description: 'Review the garden and next steps.',
        location: '',
        allDay: false,
      },
      {
        id: 'mock-calendar-event-2',
        calendarId: 'primary',
        title: 'Design review',
        startAt: secondStart.toISOString(),
        endAt: new Date(secondStart.getTime() + 60 * 60 * 1000).toISOString(),
        description: 'Review the DeskGame experience.',
        location: '',
        allDay: false,
      },
    ];
    store.putString(STORAGE_MOCK_CALENDAR_EVENTS, JSON.stringify(defaults));
    return defaults;
  }
}

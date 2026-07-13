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

const STORAGE_DEVICE_SECRET = 'specs_device_secret';
const STORAGE_PAIRED = 'specs_device_paired';
const STORAGE_MOCK_TASKS = 'specs_editor_mock_tasks';
const STORAGE_MOCK_EMAIL = 'specs_editor_mock_user_email';
const STORAGE_MOCK_SPACE = 'specs_editor_mock_space_panel';

const DEFAULT_MOCK_TASKS: MockTask[] = [
  { id: 'mock-1', text: 'Water the focus tree', deadline: null, source: 'editor', done: false },
  { id: 'mock-2', text: 'Reply to design review', deadline: null, source: 'editor', done: false },
  { id: 'mock-3', text: 'Ship berry sync prototype', deadline: null, source: 'editor', done: false },
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

  public static chatWithAgent(
    agentName: string,
    message: string,
    history: Array<{ role: string; text: string }> = []
  ): { agent: { name: string; role: string }; response: string; model: string } {
    const name = String(agentName || 'Arvis').trim() || 'Arvis';
    const trimmed = String(message || '').trim();
    const lower = trimmed.toLowerCase();
    const lastAssistant = [...history]
      .reverse()
      .find((entry) => entry && entry.role === 'assistant');
    const lastUser = [...history]
      .reverse()
      .find((entry) => entry && entry.role === 'user');

    let response = `I'm ${name}, your ARVIS assistant on the space board. In editor preview I answer locally; on Spectacles I use arvis.space agents.`;

    if (/hello|hi|hey|how are you/.test(lower)) {
      response = `Hey! I'm ${name}, your ARVIS assistant. I can help with Flow Garden, todos, and your desk space. What do you want to do?`;
    } else if (/hear me|can you hear/.test(lower)) {
      response = `Yes — I got "${trimmed}". Speech is working. Ask me anything about your garden or tasks.`;
    } else if (/\b(news|headline|headlines|current events|today|breaking)\b/.test(lower)) {
      response =
        `I can’t fetch live news in Lens Studio editor preview (no internet / HTTP). ` +
        `On Spectacles (real device), ask again and I’ll use the arvis.space agent to summarize today’s headlines. ` +
        `For now, I *can* help with Flow Garden, tasks, or your space notes.`;
    } else if (/todo|task|berry|remember/.test(lower)) {
      response = 'Try "todo" plus your task and I will sync it as a berry when you are on device.';
    } else if (/plant|seed|water|pot|garden/.test(lower)) {
      response = 'Pinch to place pots, spawn seeds from the tray, then water to grow. Want a task for that?';
    } else if (/who are you|what are you|stephany|stephanie|ars|avis|arvis/.test(lower)) {
      response = `I'm ${name}, the ARVIS assistant for Flow Garden on arvis.space.`;
    } else if (trimmed && lastUser && lastAssistant) {
      response = `${name}: About "${trimmed}" — still in editor mock. Deploy to Specs for live arvis.space agent replies.`;
    } else if (trimmed) {
      response = `${name}: I heard "${trimmed}". Editor mock is active — pair on Spectacles for live arvis.space chat.`;
    }

    return {
      agent: { name, role: 'Assistant' },
      response,
      model: 'editor/arvis-mock',
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
}

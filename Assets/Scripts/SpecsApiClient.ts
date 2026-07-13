import { registerSpecsApi } from './FlowGardenServiceRegistry';
import { SpecsEditorMock } from './SpecsEditorMock';

export type SpecsTask = {
  id: string;
  text: string;
  deadline: string | null;
  source: string;
  done: boolean;
};

export type SpecsDeviceRegistration = {
  deviceId: string;
  deviceSecret: string;
  paired: boolean;
};

export type SpecsPairStatus = {
  paired: boolean;
  userEmail: string | null;
};

export type SpecsSpaceItem = {
  type: string;
  id: string;
  title: string;
  body: string;
  imageUrl: string;
};

export type SpecsSpacePanel = {
  spaceId: string;
  title: string;
  coverUrl: string;
  updatedAt: string;
  items: SpecsSpaceItem[];
};

type JsonRecord = Record<string, unknown>;

@component
export class SpecsApiClient extends BaseScriptComponent {
  @input
  @allowUndefined
  internetModule!: InternetModule;

  @input
  apiBaseUrl: string = 'https://arvis.space';

  @input
  requestTimeoutSec: number = 20;

  @input
  useEditorMockWhenOffline: boolean = true;

  @input
  editorStartPaired: boolean = false;

  @input('float')
  editorAutoPairDelaySec: number = 12;

  @input
  debugLogging: boolean = true;

  private networkChecked = false;
  private networkAvailable = false;
  private editorAutoPairEvent: DelayedCallbackEvent | null = null;
  private editorAutoPairScheduled = false;

  onAwake(): void {
    registerSpecsApi(this);
    this.resolveInternetModule();
  }

  private resolveInternetModule(): void {
    if (!isNull(this.internetModule)) {
      return;
    }

    try {
      this.internetModule = require('LensStudio:InternetModule') as InternetModule;
      if (this.debugLogging) {
        print('[SpecsApi] Using built-in InternetModule');
      }
    } catch (e) {
      print('[SpecsApi] InternetModule unavailable: ' + e);
    }
  }

  public isNetworkAvailable(): boolean {
    if (!this.networkChecked) {
      this.networkChecked = true;
      try {
        RemoteServiceHttpRequest.create();
        this.networkAvailable = true;
      } catch (e) {
        this.networkAvailable = false;
        if (this.debugLogging) {
          print('[SpecsApi] HTTP unavailable on this platform: ' + e);
        }
      }
    }
    return this.networkAvailable;
  }

  public isEditorMockActive(): boolean {
    return this.useEditorMockWhenOffline && !this.isNetworkAvailable();
  }

  private normalizeBaseUrl(): string {
    return this.apiBaseUrl.replace(/\/$/, '');
  }

  public registerDevice(deviceId: string, onDone: (result: SpecsDeviceRegistration | null, error?: string) => void): void {
    if (this.isEditorMockActive()) {
      const result = SpecsEditorMock.register(deviceId);
      if (this.editorStartPaired && !result.paired) {
        SpecsEditorMock.markPaired();
        result.paired = true;
      } else if (!result.paired) {
        this.scheduleEditorAutoPair();
      }
      if (this.debugLogging) {
        print(`[SpecsApi] Editor mock register ${result.deviceId} paired=${result.paired}`);
      }
      onDone(result);
      return;
    }

    this.postJson(
      '/api/specs/device/register',
      { device_id: deviceId, device_label: 'Flow Garden' },
      (data, err) => {
        if (err || !data) {
          onDone(null, err || 'register failed');
          return;
        }
        onDone({
          deviceId: String(data.device_id || deviceId),
          deviceSecret: String(data.device_secret || ''),
          paired: !!data.paired,
        });
      }
    );
  }

  public fetchPairStatus(
    deviceId: string,
    deviceSecret: string,
    onDone: (status: SpecsPairStatus | null, error?: string) => void
  ): void {
    if (this.isEditorMockActive()) {
      const status = SpecsEditorMock.fetchPairStatus();
      if (this.debugLogging) {
        print(`[SpecsApi] Editor mock pair status paired=${status.paired}`);
      }
      onDone(status);
      return;
    }

    const query =
      '?device_id=' +
      encodeURIComponent(deviceId) +
      '&device_secret=' +
      encodeURIComponent(deviceSecret);
    this.getJson('/api/specs/device/status' + query, (data, err) => {
      if (err || !data) {
        onDone(null, err || 'status failed');
        return;
      }
      onDone({
        paired: !!data.paired,
        userEmail: data.user_email ? String(data.user_email) : null,
      });
    });
  }

  public fetchTasks(
    deviceId: string,
    deviceSecret: string,
    onDone: (tasks: SpecsTask[], paired: boolean, error?: string) => void
  ): void {
    if (this.isEditorMockActive()) {
      const status = SpecsEditorMock.fetchPairStatus();
      const tasks = status.paired ? SpecsEditorMock.fetchTasks() : [];
      if (this.debugLogging) {
        print(`[SpecsApi] Editor mock tasks count=${tasks.length}`);
      }
      onDone(tasks, status.paired);
      return;
    }

    const query =
      '?device_id=' +
      encodeURIComponent(deviceId) +
      '&device_secret=' +
      encodeURIComponent(deviceSecret);
    this.getJson('/api/specs/tasks' + query, (data, err) => {
      if (err || !data) {
        onDone([], false, err || 'tasks failed');
        return;
      }
      const raw = Array.isArray(data.tasks) ? data.tasks : [];
      const tasks: SpecsTask[] = [];
      for (let i = 0; i < raw.length; i++) {
        const entry = raw[i] as JsonRecord;
        const id = String(entry.id || '').trim();
        const text = String(entry.text || '').trim();
        if (!id || !text) continue;
        tasks.push({
          id,
          text,
          deadline: entry.deadline ? String(entry.deadline) : null,
          source: String(entry.source || 'arvis'),
          done: !!entry.done,
        });
      }
      onDone(tasks, !!data.paired);
    });
  }

  public speakAgent(
    deviceId: string,
    deviceSecret: string,
    text: string,
    agentName: string,
    onDone: (result: { audioBase64: string; voiceId: string; contentType: string } | null, error?: string) => void
  ): void {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      onDone(null, 'Text is required');
      return;
    }

    if (this.isEditorMockActive()) {
      onDone(null, 'Editor mock has no remote TTS audio');
      return;
    }

    this.postJson(
      '/api/specs/agent/speak',
      {
        device_id: deviceId,
        device_secret: deviceSecret,
        text: trimmed,
        agent_name: agentName,
      },
      (data, err) => {
        if (err) {
          onDone(null, err);
          return;
        }
        const audioBase64 = String(data?.audio_base64 || '').trim();
        if (!audioBase64) {
          onDone(null, 'No audio returned');
          return;
        }
        onDone({
          audioBase64,
          voiceId: String(data?.voice_id || ''),
          contentType: String(data?.content_type || 'audio/mpeg'),
        });
      }
    );
  }

  public chatWithAgent(
    deviceId: string,
    deviceSecret: string,
    message: string,
    agentName: string,
    history: Array<{ role: string; text: string }>,
    onDone: (result: { response: string; agentName: string } | null, error?: string) => void
  ): void {
    const trimmed = String(message || '').trim();
    if (!trimmed) {
      onDone(null, 'Message is required');
      return;
    }

    const agent = String(agentName || 'Stephany').trim() || 'Stephany';

    if (this.isEditorMockActive()) {
      const mock = SpecsEditorMock.chatWithAgent(agent, trimmed, history);
      const reply = { response: mock.response, agentName: mock.agent.name };
      const delayEvent = this.createEvent('DelayedCallbackEvent');
      delayEvent.bind(() => {
        if (this.debugLogging) {
          print(`[SpecsApi] Editor mock agent ${mock.agent.name}: ${mock.response}`);
        }
        onDone(reply);
      });
      delayEvent.reset(0.4);
      return;
    }

    this.postJson(
      '/api/specs/agent/chat',
      {
        device_id: deviceId,
        device_secret: deviceSecret,
        message: trimmed,
        agent_name: agent,
        history,
      },
      (data, err) => {
        if (err) {
          onDone(null, err);
          return;
        }
        const response = String(data?.response || '').trim();
        const agentRecord = data?.agent as JsonRecord | undefined;
        const resolvedName = String(agentRecord?.name || agent).trim() || agent;
        if (!response) {
          onDone(null, 'Empty agent response');
          return;
        }
        onDone({ response, agentName: resolvedName });
      }
    );
  }

  public createTask(
    deviceId: string,
    deviceSecret: string,
    text: string,
    onDone: (taskId: string | null, error?: string) => void
  ): void {
    const trimmed = String(text || '').trim().slice(0, 240);
    if (!trimmed) {
      onDone(null, 'Task text is required');
      return;
    }

    if (this.isEditorMockActive()) {
      const taskId = SpecsEditorMock.createTask(trimmed);
      if (this.debugLogging) {
        print(`[SpecsApi] Editor mock create task ${taskId}`);
      }
      onDone(taskId);
      return;
    }

    this.postJson(
      '/api/specs/tasks/create',
      { device_id: deviceId, device_secret: deviceSecret, text: trimmed },
      (data, err) => {
        if (err) {
          onDone(null, err);
          return;
        }
        const taskId = String(data?.task_id || '').trim();
        onDone(taskId || null, taskId ? undefined : 'create failed');
      }
    );
  }

  public completeTask(
    deviceId: string,
    deviceSecret: string,
    taskId: string,
    onDone: (ok: boolean, error?: string) => void
  ): void {
    if (this.isEditorMockActive()) {
      onDone(SpecsEditorMock.completeTask(taskId));
      return;
    }

    this.postJson(
      '/api/specs/tasks/complete',
      { device_id: deviceId, device_secret: deviceSecret, task_id: taskId },
      (data, err) => {
        if (err) {
          onDone(false, err);
          return;
        }
        onDone(!!data?.ok);
      }
    );
  }

  public fetchSpacePanel(
    deviceId: string,
    deviceSecret: string,
    onDone: (panel: SpecsSpacePanel | null, error?: string) => void
  ): void {
    if (this.isEditorMockActive()) {
      const status = SpecsEditorMock.fetchPairStatus();
      if (!status.paired) {
        onDone(null, 'Device is not paired');
        return;
      }
      onDone(SpecsEditorMock.fetchSpacePanel());
      return;
    }

    const query =
      '?device_id=' +
      encodeURIComponent(deviceId) +
      '&device_secret=' +
      encodeURIComponent(deviceSecret);
    this.getJson('/api/specs/space/panel' + query, (data, err) => {
      if (err || !data || data.ok === false) {
        onDone(null, err || String(data?.error || 'space panel failed'));
        return;
      }
      if (!data.panel) {
        onDone(null, 'space panel missing');
        return;
      }
      onDone(this.parseSpacePanel(data.panel as JsonRecord), undefined);
    });
  }

  public appendSpaceNote(
    deviceId: string,
    deviceSecret: string,
    text: string,
    onDone: (panel: SpecsSpacePanel | null, error?: string) => void
  ): void {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      onDone(null, 'Note text is required');
      return;
    }

    if (this.isEditorMockActive()) {
      onDone(SpecsEditorMock.appendSpaceNote(trimmed));
      return;
    }

    this.postJson(
      '/api/specs/space/note',
      { device_id: deviceId, device_secret: deviceSecret, text: trimmed },
      (data, err) => {
        if (err || !data) {
          onDone(null, err || 'space note failed');
          return;
        }
        onDone(this.parseSpacePanel(data.panel as JsonRecord), undefined);
      }
    );
  }

  private parseSpacePanel(raw: JsonRecord | null | undefined): SpecsSpacePanel {
    const panel = raw && typeof raw === 'object' ? raw : {};
    const itemsRaw = Array.isArray(panel.items) ? panel.items : [];
    const items: SpecsSpaceItem[] = [];
    for (let i = 0; i < itemsRaw.length; i++) {
      const entry = itemsRaw[i] as JsonRecord;
      items.push({
        type: String(entry.type || 'note'),
        id: String(entry.id || `item_${i}`),
        title: String(entry.title || ''),
        body: String(entry.body || ''),
        imageUrl: String(entry.imageUrl || entry.image_url || ''),
      });
    }
    return {
      spaceId: String(panel.spaceId || panel.space_id || ''),
      title: String(panel.title || 'Flow Garden Board'),
      coverUrl: String(panel.coverUrl || panel.cover_url || ''),
      updatedAt: String(panel.updatedAt || panel.updated_at || ''),
      items,
    };
  }

  private getJson(path: string, onDone: (data: JsonRecord | null, error?: string) => void): void {
    const request = this.createRequest(onDone);
    if (!request) {
      return;
    }
    request.url = this.normalizeBaseUrl() + path;
    request.method = RemoteServiceHttpRequest.HttpRequestMethod.Get;
    this.performRequest(request, onDone);
  }

  private postJson(
    path: string,
    body: JsonRecord,
    onDone: (data: JsonRecord | null, error?: string) => void
  ): void {
    const request = this.createRequest(onDone);
    if (!request) {
      return;
    }
    request.url = this.normalizeBaseUrl() + path;
    request.method = RemoteServiceHttpRequest.HttpRequestMethod.Post;
    request.setHeader('Content-Type', 'application/json');
    request.body = JSON.stringify(body);
    this.performRequest(request, onDone);
  }

  private createRequest(
    onDone: (data: JsonRecord | null, error?: string) => void
  ): RemoteServiceHttpRequest | null {
    if (!this.isNetworkAvailable()) {
      const message = this.useEditorMockWhenOffline
        ? 'Network unavailable in editor preview'
        : 'Network unavailable';
      onDone(null, message);
      return null;
    }

    try {
      return RemoteServiceHttpRequest.create();
    } catch (e) {
      this.networkAvailable = false;
      if (this.debugLogging) {
        print('[SpecsApi] HTTP request create failed: ' + e);
      }
      onDone(null, 'Network unavailable');
      return null;
    }
  }

  private scheduleEditorAutoPair(): void {
    if (this.editorAutoPairScheduled || this.editorAutoPairDelaySec <= 0) {
      return;
    }
    this.editorAutoPairScheduled = true;
    this.editorAutoPairEvent = this.createEvent('DelayedCallbackEvent');
    this.editorAutoPairEvent.bind(() => {
      this.editorAutoPairEvent = null;
      if (!SpecsEditorMock.fetchPairStatus().paired) {
        SpecsEditorMock.markPaired();
        if (this.debugLogging) {
          print('[SpecsApi] Editor mock auto-paired locally (website pairing still requires Specs hardware)');
        }
      }
    });
    this.editorAutoPairEvent.reset(Math.max(1, this.editorAutoPairDelaySec));
  }

  private performRequest(
    request: RemoteServiceHttpRequest,
    onDone: (data: JsonRecord | null, error?: string) => void
  ): void {
    this.resolveInternetModule();
    if (isNull(this.internetModule)) {
      onDone(null, 'InternetModule not configured (enable Internet Access capability)');
      return;
    }

    this.internetModule.performHttpRequest(request, (response: RemoteServiceHttpResponse) => {
      try {
        this.handleHttpResponse(request, response, onDone);
      } catch (e) {
        onDone(null, String(e));
      }
    });
  }

  private handleHttpResponse(
    request: RemoteServiceHttpRequest,
    response: RemoteServiceHttpResponse,
    onDone: (data: JsonRecord | null, error?: string) => void
  ): void {
      const status = response.statusCode;
      const raw = String(response.body || '');
      if (this.debugLogging) {
        print(`[SpecsApi] ${status} ${request.url}`);
      }
      if (status < 200 || status >= 300) {
        let message = `HTTP ${status}`;
        try {
          const parsed = JSON.parse(raw) as JsonRecord;
          if (parsed.error) message = String(parsed.error);
        } catch {
          // keep status message
        }
        onDone(null, message);
        return;
      }

      if (!raw) {
        onDone({});
        return;
      }

      try {
        onDone(JSON.parse(raw) as JsonRecord);
      } catch {
        onDone(null, 'Invalid JSON response');
      }
  }
}

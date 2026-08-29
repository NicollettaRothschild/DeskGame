import { registerSpecsApi } from './FlowGardenServiceRegistry';
import { resolveAgentSkillsForMessage } from './ArvisAgentSkills';
import {
  extractImageUrlFromAgentResponse,
  isImageQuery,
  normalizeImagePrompt,
} from './ArvisImageSkill';
import {
  extractMusicUrlFromAgentResponse,
  isMusicQuery,
  normalizeMusicPrompt,
} from './ArvisMusicSkill';
import { isMeshQuery, normalizeMeshPrompt } from './ArvisMeshSkill';
import { isNewsQuery } from './ArvisNewsSkill';
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

export type SpecsCalendarConfig = {
  calendarId: string | null;
  calendarName: string | null;
  connected: boolean;
};

export type SpecsCalendar = {
  id: string;
  name: string;
  description: string;
  primary: boolean;
  timeZone: string;
};

export type SpecsCalendarEventQuery = {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
};

export type SpecsCalendarEvent = {
  id: string;
  calendarId: string;
  title: string;
  startAt: string;
  endAt: string;
  description: string;
  location: string;
  allDay: boolean;
};

export type SpecsCalendarEventInput = {
  calendarId?: string;
  title: string;
  startAt: string;
  endAt: string;
  description?: string;
  location?: string;
};

export type SpecsEmailDraftQueueResult = {
  commandId: string;
  requestId: string;
  status: string;
  expiresAt: string;
};

export type SpecsBridgeCommandStatus = {
  commandId: string;
  requestId: string;
  status: string;
  result: JsonRecord;
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

  /** Longer HTTP timeout for /image generation (server-side concept art can take 30–60s). */
  @input('float')
  imageRequestTimeoutSec: number = 60;

  /** Longer HTTP timeout for /music generation (Lyria + agent routing can take 60–90s). */
  @input('float')
  musicRequestTimeoutSec: number = 90;

  /** Longer HTTP timeout for /mesh agent replies (Snap3D refinement can take 30–90s). */
  @input('float')
  meshRequestTimeoutSec: number = 90;

  @input
  useEditorMockWhenOffline: boolean = true;

  @input
  editorStartPaired: boolean = false;

  /** When live arvis.space rejects chat/TTS because the device is unpaired, answer via SpecsEditorMock in preview. */
  @input
  useMockFallbackWhenUnpaired: boolean = true;

  @input('float')
  editorAutoPairDelaySec: number = 12;

  /** Sign in to arvis.space (Supabase password) and pair this device — no Google OAuth in Lens. */
  @input
  autoPairWithCredentials: boolean = true;

  @input
  autoPairEmail: string = 'test@user.com';

  @input
  autoPairPassword: string = 'test321';

  @input
  arvisSupabaseUrl: string = 'https://bigsedudegjukszrfyil.supabase.co';

  @input
  arvisSupabaseAnonKey: string =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJpZ3NlZHVkZWdqdWtzenJmeWlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDgwODAsImV4cCI6MjA4NjMyNDA4MH0.nddfPvJ_uAQ2iC0pP42JIOtxOtNxxojJIMSOt39XHMo';

  @input
  debugLogging: boolean = false;

  private networkChecked = false;
  private networkAvailable = false;
  private editorAutoPairEvent: DelayedCallbackEvent | null = null;
  private editorAutoPairScheduled = false;
  private credentialPairInFlight = false;
  private credentialPairFailed = false;
  private simulatedPlatformWarned = false;

  onAwake(): void {
    registerSpecsApi(this);
    this.resolveInternetModule();
  }

  /** Preview without Device Type Override = Spectacles blocks InternetModule.fetch/create. */
  private formatNetworkError(error: unknown): string {
    const raw = String(error || '');
    if (/simulated platform|API not available/i.test(raw)) {
      this.warnSimulatedPlatformOnce(raw);
      return (
        'Internet blocked in Preview — set Preview Device Type Override to Spectacles ' +
        '(not Desktop/Phone), then restart Preview'
      );
    }
    return raw || 'Network request failed';
  }

  private warnSimulatedPlatformOnce(detail: string): void {
    if (this.simulatedPlatformWarned) {
      return;
    }
    this.simulatedPlatformWarned = true;
    this.networkChecked = true;
    this.networkAvailable = false;
    print(
      '[SpecsApi] InternetModule blocked on simulated platform. ' +
        'Preview panel → Device Type Override → Spectacles, then restart Preview. ' +
        'Supabase plugin Import Credentials is editor-only and does not unlock Lens runtime HTTP. Detail: ' +
        detail
    );
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
    this.resolveInternetModule();
    if (isNull(this.internetModule)) {
      this.networkChecked = true;
      this.networkAvailable = false;
      return false;
    }

    // Do NOT treat InternetModule.fetch existing as proof it works — on Desktop/Phone
    // preview the method exists but invoking it throws "API not available on the
    // simulated platform". Only Device Type Override = Spectacles enables runtime HTTP.
    if (this.networkChecked) {
      return this.networkAvailable;
    }

    this.networkChecked = true;
    try {
      RemoteServiceHttpRequest.create();
      this.networkAvailable = true;
    } catch (e) {
      // Fetch may still work when create() is blocked (Spectacles preview).
      const fetchFn = (
        this.internetModule as InternetModule & {
          fetch?: (url: string, init?: unknown) => Promise<Response>;
        }
      ).fetch;
      if (typeof fetchFn === 'function') {
        // Optimistic until first invoke; formatNetworkError clears this on simulated fail.
        this.networkAvailable = true;
        if (this.debugLogging) {
          print('[SpecsApi] HTTP create() blocked; will try fetch (needs Spectacles preview)');
        }
      } else {
        this.networkAvailable = false;
        if (this.debugLogging) {
          print('[SpecsApi] HTTP unavailable on this platform: ' + e);
        }
      }
    }
    return this.networkAvailable;
  }

  public isEditorMockActive(): boolean {
    if (!this.useEditorMockWhenOffline) {
      return false;
    }
    return !this.isNetworkAvailable();
  }

  /** When true, editor mock registration auto-marks the device paired (offline preview only). */
  public shouldAutoPairInEditorMock(): boolean {
    return this.editorStartPaired;
  }

  private normalizeBaseUrl(): string {
    return this.apiBaseUrl.replace(/\/$/, '');
  }

  public registerDevice(deviceId: string, onDone: (result: SpecsDeviceRegistration | null, error?: string) => void): void {
    // With credential auto-pair, always register against arvis.space from editor preview.
    if (this.isEditorMockActive() && !this.autoPairWithCredentials) {
      const result = SpecsEditorMock.register(deviceId);
      if (this.shouldAutoPairInEditorMock() && !result.paired) {
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
          if (this.useEditorMockWhenOffline && this.isEditorMockActive()) {
            const result = SpecsEditorMock.register(deviceId);
            onDone(result);
            return;
          }
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

  public isAutoPairWithCredentialsEnabled(): boolean {
    // Credential pair talks to Supabase + arvis.space — allow it even when the
    // offline mock probe is active so editor preview can still use the live backend.
    return this.autoPairWithCredentials;
  }

  /** Prefer live arvis.space when we have a device secret or credential auto-pair. */
  private shouldPreferLiveAgent(deviceSecret?: string): boolean {
    if (String(deviceSecret || '').trim().length > 0) {
      return true;
    }
    return this.autoPairWithCredentials && !this.credentialPairFailed;
  }

  public isCredentialPairInFlight(): boolean {
    return this.credentialPairInFlight;
  }

  public tryAutoPairWithCredentials(
    deviceId: string,
    onDone: (ok: boolean, userEmail?: string | null, error?: string) => void
  ): void {
    if (!this.isAutoPairWithCredentialsEnabled()) {
      onDone(false, null, 'Auto-pair disabled');
      return;
    }
    if (this.credentialPairInFlight) {
      onDone(false, null, 'Pairing in progress');
      return;
    }
    if (this.credentialPairFailed) {
      onDone(false, null, 'Auto-pair already failed this session');
      return;
    }

    const email = String(this.autoPairEmail || '').trim();
    const password = String(this.autoPairPassword || '');
    if (!email || !password) {
      onDone(false, null, 'Auto-pair email/password not configured');
      return;
    }

    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedDeviceId) {
      onDone(false, null, 'device_id required');
      return;
    }

    this.credentialPairInFlight = true;
    if (this.debugLogging) {
      print(`[SpecsApi] Auto-pair signing in as ${email}`);
    }

    this.supabasePasswordSignIn(email, password, (session, signInError) => {
      if (!session) {
        this.credentialPairInFlight = false;
        this.credentialPairFailed = true;
        if (this.debugLogging) {
          print('[SpecsApi] Auto-pair sign-in failed: ' + (signInError || 'unknown'));
        }
        onDone(false, null, signInError || 'Supabase sign-in failed');
        return;
      }

      this.postJson(
        '/api/specs/pair',
        {
          device_id: normalizedDeviceId,
          user_id: session.userId,
          access_token: session.accessToken,
        },
        (data, err) => {
          this.credentialPairInFlight = false;
          if (err || !data?.ok) {
            this.credentialPairFailed = true;
            if (this.debugLogging) {
              print('[SpecsApi] Auto-pair /pair failed: ' + (err || 'unknown'));
            }
            onDone(false, null, err || 'Device pair failed');
            return;
          }

          const userEmail = data.user_email ? String(data.user_email) : session.email || email;
          if (this.debugLogging) {
            print(`[SpecsApi] Auto-paired ${normalizedDeviceId} as ${userEmail || email}`);
          }
          onDone(true, userEmail, undefined);
        }
      );
    });
  }

  private supabasePasswordSignIn(
    email: string,
    password: string,
    onDone: (session: { userId: string; accessToken: string; email: string | null } | null, error?: string) => void
  ): void {
    const supabaseUrl = String(this.arvisSupabaseUrl || '').replace(/\/$/, '');
    const anonKey = String(this.arvisSupabaseAnonKey || '').trim();
    if (!supabaseUrl || !anonKey) {
      onDone(null, 'Arvis Supabase credentials not configured');
      return;
    }

    this.requestJson(
      `${supabaseUrl}/auth/v1/token?grant_type=password`,
      'POST',
      { email, password },
      {
        'Content-Type': 'application/json',
        apikey: anonKey,
      },
      (data, err) => {
        if (err || !data) {
          onDone(null, err || 'Supabase sign-in failed');
          return;
        }

        const user = data.user as JsonRecord | undefined;
        const userId = String(user?.id || '').trim();
        const accessToken = String(data.access_token || '').trim();
        if (!userId || !accessToken) {
          const description = String(data.error_description || data.msg || 'Missing access_token');
          onDone(null, description);
          return;
        }

        onDone({
          userId,
          accessToken,
          email: user?.email ? String(user.email) : null,
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

  public fetchCalendarConfig(
    deviceId: string,
    deviceSecret: string,
    onDone: (config: SpecsCalendarConfig | null, error?: string) => void
  ): void {
    if (this.isEditorMockActive()) {
      onDone(SpecsEditorMock.fetchCalendarConfig() as unknown as SpecsCalendarConfig);
      return;
    }

    this.getJson(
      '/api/specs/calendar/config' + this.buildCalendarCredentialQuery(deviceId, deviceSecret),
      (data, err) => {
        if (err || !data || data.ok === false) {
          onDone(null, err || String(data?.error || 'calendar config failed'));
          return;
        }
        onDone(this.parseCalendarConfig(data));
      }
    );
  }

  public setCalendarId(
    deviceId: string,
    deviceSecret: string,
    calendarId: string,
    onDone: (config: SpecsCalendarConfig | null, error?: string) => void
  ): void {
    const normalizedCalendarId = String(calendarId || '').trim();
    if (!normalizedCalendarId) {
      onDone(null, 'Calendar ID is required');
      return;
    }

    if (this.isEditorMockActive()) {
      onDone(
        SpecsEditorMock.setCalendarId(normalizedCalendarId) as unknown as SpecsCalendarConfig
      );
      return;
    }

    this.postJson(
      '/api/specs/calendar/config',
      {
        device_id: deviceId,
        device_secret: deviceSecret,
        calendar_id: normalizedCalendarId,
      },
      (data, err) => {
        if (err || !data || data.ok === false) {
          onDone(null, err || String(data?.error || 'calendar config update failed'));
          return;
        }
        onDone(this.parseCalendarConfig(data));
      }
    );
  }

  public fetchAvailableCalendars(
    deviceId: string,
    deviceSecret: string,
    onDone: (calendars: SpecsCalendar[], error?: string) => void
  ): void {
    if (this.isEditorMockActive()) {
      onDone(SpecsEditorMock.fetchAvailableCalendars() as unknown as SpecsCalendar[]);
      return;
    }

    this.getJson(
      '/api/specs/calendar/calendars' +
        this.buildCalendarCredentialQuery(deviceId, deviceSecret),
      (data, err) => {
        if (err || !data || data.ok === false) {
          onDone([], err || String(data?.error || 'available calendars failed'));
          return;
        }
        const raw = Array.isArray(data.calendars)
          ? data.calendars
          : Array.isArray(data.items)
            ? data.items
            : [];
        onDone(raw.map((entry, index) => this.parseCalendar(entry as JsonRecord, index)));
      }
    );
  }

  public fetchCalendarEvents(
    deviceId: string,
    deviceSecret: string,
    query: SpecsCalendarEventQuery | null,
    onDone: (events: SpecsCalendarEvent[], error?: string) => void
  ): void {
    const normalizedQuery = query || {};
    if (this.isEditorMockActive()) {
      onDone(
        SpecsEditorMock.fetchCalendarEvents(normalizedQuery) as unknown as SpecsCalendarEvent[]
      );
      return;
    }

    let path =
      '/api/specs/calendar/events' +
      this.buildCalendarCredentialQuery(deviceId, deviceSecret);
    if (normalizedQuery.calendarId) {
      path += '&calendar_id=' + encodeURIComponent(normalizedQuery.calendarId);
    }
    if (normalizedQuery.timeMin) {
      path += '&time_min=' + encodeURIComponent(normalizedQuery.timeMin);
    }
    if (normalizedQuery.timeMax) {
      path += '&time_max=' + encodeURIComponent(normalizedQuery.timeMax);
    }
    if (Number.isFinite(normalizedQuery.maxResults)) {
      path += '&max_results=' + encodeURIComponent(String(normalizedQuery.maxResults));
    }

    this.getJson(path, (data, err) => {
      if (err || !data || data.ok === false) {
        onDone([], err || String(data?.error || 'calendar events failed'));
        return;
      }
      const raw = Array.isArray(data.events)
        ? data.events
        : Array.isArray(data.items)
          ? data.items
          : [];
      const fallbackCalendarId = String(normalizedQuery.calendarId || '');
      onDone(
        raw.map((entry, index) =>
          this.parseCalendarEvent(entry as JsonRecord, index, fallbackCalendarId)
        )
      );
    });
  }

  public createCalendarEvent(
    deviceId: string,
    deviceSecret: string,
    event: SpecsCalendarEventInput,
    onDone: (created: SpecsCalendarEvent | null, error?: string) => void
  ): void {
    const title = String(event?.title || '').trim().slice(0, 180);
    const startAt = String(event?.startAt || '').trim();
    const endAt = String(event?.endAt || '').trim();
    if (!title || !startAt || !endAt) {
      onDone(null, 'Calendar event requires a title, start time, and end time');
      return;
    }

    const normalizedEvent: SpecsCalendarEventInput = {
      calendarId: String(event?.calendarId || '').trim() || undefined,
      title,
      startAt,
      endAt,
      description: String(event?.description || '').trim().slice(0, 800),
      location: String(event?.location || '').trim().slice(0, 240),
    };

    if (this.isEditorMockActive()) {
      onDone(
        SpecsEditorMock.createCalendarEvent(normalizedEvent) as unknown as SpecsCalendarEvent
      );
      return;
    }

    const body: JsonRecord = {
      device_id: deviceId,
      device_secret: deviceSecret,
      title: normalizedEvent.title,
      start: normalizedEvent.startAt,
      end: normalizedEvent.endAt,
    };
    if (normalizedEvent.calendarId) {
      body.calendar_id = normalizedEvent.calendarId;
    }
    if (normalizedEvent.description) {
      body.description = normalizedEvent.description;
    }
    if (normalizedEvent.location) {
      body.location = normalizedEvent.location;
    }

    this.postJson('/api/specs/calendar/events', body, (data, err) => {
      if (err || !data || data.ok === false) {
        onDone(null, err || String(data?.error || 'calendar event creation failed'));
        return;
      }
      const rawEvent =
        data.event && typeof data.event === 'object' ? (data.event as JsonRecord) : data;
      onDone(
        this.parseCalendarEvent(
          rawEvent,
          0,
          normalizedEvent.calendarId || '',
          normalizedEvent.title,
          normalizedEvent.startAt,
          normalizedEvent.endAt
        )
      );
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
          if (this.debugLogging) {
            print('[SpecsApi] speakAgent failed: ' + err);
          }
          onDone(null, err);
          return;
        }
        const audioBase64 = String(data?.audio_base64 || '').trim();
        if (!audioBase64) {
          if (this.debugLogging) {
            print('[SpecsApi] speakAgent returned no audio');
          }
          onDone(null, 'No audio returned');
          return;
        }
        if (this.debugLogging) {
          print(
            `[SpecsApi] speakAgent ok bytes~${Math.floor((audioBase64.length * 3) / 4)} voice=${String(data?.voice_id || '')}`
          );
        }
        onDone({
          audioBase64,
          voiceId: String(data?.voice_id || ''),
          contentType: String(data?.content_type || 'audio/mpeg'),
        });
      }
    );
  }

  /**
   * Queues an unsent email draft for the paired Arvis Mac host.
   * This intentionally never uses the editor mock: a successful response must
   * represent a real bridge request that the Mac can approve or decline.
   */
  public queueEmailDraft(
    deviceId: string,
    deviceSecret: string,
    requestId: string,
    recipient: string,
    subject: string,
    body: string,
    onDone: (result: SpecsEmailDraftQueueResult | null, error?: string) => void
  ): void {
    const normalizedRecipient = String(recipient || '').trim();
    const normalizedSubject = String(subject || '').trim();
    const normalizedBody = String(body || '').trim();
    const normalizedRequestId = String(requestId || '').trim();
    if (!normalizedRequestId || !normalizedRecipient || !normalizedSubject || !normalizedBody) {
      onDone(null, 'Email draft request is incomplete');
      return;
    }

    this.postJson(
      '/api/specs/bridge/email-draft',
      {
        device_id: deviceId,
        device_secret: deviceSecret,
        request_id: normalizedRequestId,
        recipient: normalizedRecipient,
        subject: normalizedSubject,
        body: normalizedBody,
        send: false,
      },
      (data, err) => {
        if (err || !data) {
          if (this.debugLogging) {
            print('[SpecsApi] email draft bridge failed: ' + (err || 'empty response'));
          }
          onDone(null, err || 'Email draft bridge failed');
          return;
        }

        const commandId = String(data.command_id || '').trim();
        if (!commandId) {
          onDone(null, 'Email draft bridge returned no command id');
          return;
        }
        if (this.debugLogging) {
          print(
            `[SpecsApi] email draft queued command=${commandId} request=${normalizedRequestId}`
          );
        }
        onDone({
          commandId,
          requestId: String(data.request_id || normalizedRequestId),
          status: String(data.status || 'pending'),
          expiresAt: String(data.expires_at || ''),
        });
      },
      this.requestTimeoutSec
    );
  }

  public fetchBridgeCommandStatus(
    deviceId: string,
    deviceSecret: string,
    commandId: string,
    onDone: (status: SpecsBridgeCommandStatus | null, error?: string) => void
  ): void {
    const normalizedCommandId = String(commandId || '').trim();
    if (!normalizedCommandId) {
      onDone(null, 'Bridge command id is required');
      return;
    }

    this.getJsonWithHeaders(
      '/api/specs/bridge/commands/' + encodeURIComponent(normalizedCommandId),
      {
        'x-specs-device-id': String(deviceId || ''),
        'x-specs-device-secret': String(deviceSecret || ''),
      },
      (data, err) => {
        if (err || !data) {
          onDone(null, err || 'Bridge command status failed');
          return;
        }
        const command = data.command as JsonRecord | undefined;
        if (!command) {
          onDone(null, 'Bridge command status missing command');
          return;
        }
        onDone({
          commandId: String(command.id || normalizedCommandId),
          requestId: String(command.request_id || ''),
          status: String(command.status || ''),
          result: command.result && typeof command.result === 'object'
            ? (command.result as JsonRecord)
            : {},
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
    onDone: (
      result: { response: string; agentName: string; imageUrl?: string; musicUrl?: string } | null,
      error?: string
    ) => void
  ): void {
    const trimmed = String(message || '').trim();
    if (!trimmed) {
      onDone(null, 'Message is required');
      return;
    }

    const agent = String(agentName || 'Arvis').trim() || 'Arvis';
    const outboundMessage =
      normalizeMeshPrompt(trimmed) ||
      normalizeImagePrompt(trimmed) ||
      normalizeMusicPrompt(trimmed) ||
      trimmed;
    const imageRequest = isImageQuery(outboundMessage);
    const meshRequest = isMeshQuery(outboundMessage);
    const musicRequest = isMusicQuery(outboundMessage);

    // News goes through arvis.space agent chat (Supabase-paired) — do NOT scrape Google RSS
    // in-Lens. That bypass skipped the live backend and forced editor mock replies.

    if (this.isEditorMockActive() && !this.shouldPreferLiveAgent(deviceSecret)) {
      const mock = SpecsEditorMock.chatWithAgent(agent, outboundMessage, history);
      const imageUrl = extractImageUrlFromAgentResponse(
        mock.response,
        mock.imageUrl,
        this.normalizeBaseUrl()
      );
      const musicUrl = extractMusicUrlFromAgentResponse(
        mock.response,
        mock.musicUrl,
        this.normalizeBaseUrl()
      );
      const reply = { response: mock.response, agentName: mock.agent.name, imageUrl, musicUrl };
      const delayEvent = this.createEvent('DelayedCallbackEvent');
      delayEvent.bind(() => {
        if (this.debugLogging) {
          print(`[SpecsApi] Editor mock agent ${mock.agent.name}: ${mock.response}`);
          if (imageUrl) {
            print(`[SpecsApi] Editor mock image ${imageUrl.slice(0, 120)}`);
          }
          if (musicUrl) {
            print(`[SpecsApi] Editor mock music ${musicUrl.slice(0, 120)}`);
          }
        }
        onDone(reply);
      });
      delayEvent.reset(imageRequest || meshRequest || musicRequest ? 1.2 : 0.4);
      return;
    }

    if (this.debugLogging && isNewsQuery(outboundMessage)) {
      print('[SpecsApi] News query → arvis.space /api/specs/agent/chat');
    }

    const requestTimeoutSec = meshRequest
      ? this.meshRequestTimeoutSec
      : imageRequest
        ? this.imageRequestTimeoutSec
        : musicRequest
          ? this.musicRequestTimeoutSec
          : this.requestTimeoutSec;

    this.postJson(
      '/api/specs/agent/chat',
      {
        device_id: deviceId,
        device_secret: deviceSecret,
        message: outboundMessage,
        agent_name: agent,
        history,
        skills: resolveAgentSkillsForMessage(outboundMessage),
      },
      (data, err) => {
        if (err) {
          if (this.shouldUseUnpairedMockFallback(err, outboundMessage)) {
            this.replyWithUnpairedMockFallback(agent, outboundMessage, history, onDone);
            return;
          }
          onDone(null, err);
          return;
        }
        const response = String(data?.response || '').trim();
        const agentRecord = data?.agent as JsonRecord | undefined;
        const resolvedName = String(agentRecord?.name || agent).trim() || agent;
        const imageUrl = extractImageUrlFromAgentResponse(
          response,
          String(
            (data?.image_url as string) ||
              (data?.imageUrl as string) ||
              ((data?.image as JsonRecord | undefined)?.url as string) ||
              ''
          ).trim(),
          this.normalizeBaseUrl()
        );
        const musicUrl = extractMusicUrlFromAgentResponse(
          response,
          String(
            (data?.music_url as string) ||
              (data?.musicUrl as string) ||
              ((data?.music as JsonRecord | undefined)?.url as string) ||
              ''
          ).trim(),
          this.normalizeBaseUrl()
        );
        if (!response) {
          onDone(null, 'Empty agent response');
          return;
        }
        if (this.debugLogging && imageUrl) {
          print(`[SpecsApi] agent image ${imageUrl.slice(0, 160)}`);
        }
        if (this.debugLogging && musicUrl) {
          print(`[SpecsApi] agent music ${musicUrl.slice(0, 160)}`);
        }
        onDone({
          response,
          agentName: resolvedName,
          imageUrl: imageUrl || undefined,
          musicUrl: musicUrl || undefined,
        });
      },
      requestTimeoutSec
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

  private buildCalendarCredentialQuery(deviceId: string, deviceSecret: string): string {
    return (
      '?device_id=' +
      encodeURIComponent(String(deviceId || '')) +
      '&device_secret=' +
      encodeURIComponent(String(deviceSecret || ''))
    );
  }

  private parseCalendarConfig(raw: unknown): SpecsCalendarConfig {
    const record = raw && typeof raw === 'object' ? (raw as JsonRecord) : {};
    const nested =
      record.config && typeof record.config === 'object'
        ? (record.config as JsonRecord)
        : record;
    const calendarId = String(nested.calendarId || nested.calendar_id || '').trim();
    const connectedValue =
      record.connected ??
      nested.connected ??
      nested.googleConnected ??
      nested.google_connected ??
      nested.oauthConnected ??
      nested.oauth_connected;
    return {
      calendarId: calendarId || null,
      calendarName: nested.calendarName
        ? String(nested.calendarName)
        : nested.calendar_name
          ? String(nested.calendar_name)
          : null,
      connected: this.parseBoolean(connectedValue, !!calendarId),
    };
  }

  private parseCalendar(raw: JsonRecord, index: number): SpecsCalendar {
    const record = raw && typeof raw === 'object' ? raw : {};
    return {
      id: String(record.id || record.calendar_id || `calendar_${index}`).trim(),
      name: String(record.name || record.summary || record.summaryOverride || 'Calendar').trim(),
      description: String(record.description || '').trim(),
      primary: this.parseBoolean(record.primary ?? record.is_primary, false),
      timeZone: String(record.timeZone || record.time_zone || '').trim(),
    };
  }

  private parseCalendarEvent(
    raw: JsonRecord,
    index: number,
    fallbackCalendarId = '',
    fallbackTitle = '',
    fallbackStartAt = '',
    fallbackEndAt = ''
  ): SpecsCalendarEvent {
    const record = raw && typeof raw === 'object' ? raw : {};
    const start =
      record.start && typeof record.start === 'object' ? (record.start as JsonRecord) : {};
    const end =
      record.end && typeof record.end === 'object' ? (record.end as JsonRecord) : {};
    const startAt = String(
      record.startAt ||
        record.start_at ||
        record.start_time ||
        start.dateTime ||
        start.date ||
        fallbackStartAt
    ).trim();
    const endAt = String(
      record.endAt ||
        record.end_at ||
        record.end_time ||
        end.dateTime ||
        end.date ||
        fallbackEndAt
    ).trim();
    const allDay = this.parseBoolean(
      record.allDay ?? record.all_day,
      !start.dateTime && !!start.date
    );
    return {
      id: String(record.id || record.event_id || `calendar-event-${index}`).trim(),
      calendarId: String(
        record.calendarId || record.calendar_id || fallbackCalendarId
      ).trim(),
      title: String(record.title || record.summary || record.name || fallbackTitle).trim(),
      startAt,
      endAt,
      description: String(record.description || '').trim(),
      location: String(record.location || '').trim(),
      allDay,
    };
  }

  private parseBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
        return true;
      }
      if (normalized === 'false' || normalized === '0' || normalized === 'no') {
        return false;
      }
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    return fallback;
  }

  private getJson(path: string, onDone: (data: JsonRecord | null, error?: string) => void): void {
    this.requestJson(this.normalizeBaseUrl() + path, 'GET', null, null, onDone);
  }

  private getJsonWithHeaders(
    path: string,
    headers: Record<string, string>,
    onDone: (data: JsonRecord | null, error?: string) => void
  ): void {
    this.requestJson(
      this.normalizeBaseUrl() + path,
      'GET',
      null,
      headers,
      onDone
    );
  }

  private postJson(
    path: string,
    body: JsonRecord,
    onDone: (data: JsonRecord | null, error?: string) => void,
    timeoutSec?: number
  ): void {
    this.requestJson(
      this.normalizeBaseUrl() + path,
      'POST',
      body,
      { 'Content-Type': 'application/json' },
      onDone,
      timeoutSec
    );
  }

  /**
   * Prefer InternetModule.fetch (same path SnapCloud/Supabase uses in editor preview).
   * Fall back to RemoteServiceHttpRequest only when fetch is unavailable.
   */
  private requestJson(
    url: string,
    method: 'GET' | 'POST',
    body: JsonRecord | null,
    headers: Record<string, string> | null,
    onDone: (data: JsonRecord | null, error?: string) => void,
    timeoutSec?: number
  ): void {
    this.resolveInternetModule();
    if (isNull(this.internetModule)) {
      onDone(null, 'InternetModule not configured (enable Internet Access capability)');
      return;
    }

    const requestTimeoutSec = Math.max(
      1,
      Number(timeoutSec || this.requestTimeoutSec || 20)
    );
    const fetchFn = (
      this.internetModule as InternetModule & {
        fetch?: (resource: string, options?: unknown) => Promise<Response>;
      }
    ).fetch;

    if (typeof fetchFn === 'function') {
      this.requestJsonViaFetch(url, method, body, headers, onDone, requestTimeoutSec);
      return;
    }

    this.requestJsonViaRemoteService(
      url,
      method,
      body,
      headers,
      onDone,
      requestTimeoutSec
    );
  }

  private requestJsonViaFetch(
    url: string,
    method: 'GET' | 'POST',
    body: JsonRecord | null,
    headers: Record<string, string> | null,
    onDone: (data: JsonRecord | null, error?: string) => void,
    timeoutSec: number
  ): void {
    const options: Record<string, unknown> = {
      method,
      headers: headers || {},
    };
    if (method !== 'GET' && body) {
      options.body = JSON.stringify(body);
    }

    let settled = false;
    const timeoutEvent = this.createEvent('DelayedCallbackEvent');
    const finish = (data: JsonRecord | null, error?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      timeoutEvent.enabled = false;
      onDone(data, error);
    };
    timeoutEvent.bind(() => {
      finish(null, `Request timed out after ${timeoutSec.toFixed(1)} seconds`);
    });
    timeoutEvent.reset(timeoutSec);

    const run = async (): Promise<void> => {
      try {
        if (this.debugLogging) {
          print(`[SpecsApi] fetch ${method} ${url}`);
        }
        const response = await (this.internetModule as InternetModule).fetch(url, options);
        const status = response.status;
        const raw = await response.text();
        if (this.debugLogging) {
          print(`[SpecsApi] ${status} ${url}`);
        }
        if (status < 200 || status >= 300) {
          let message = `HTTP ${status}`;
          try {
            const parsed = JSON.parse(raw) as JsonRecord;
            if (parsed.error) {
              message = String(parsed.error);
            } else if (parsed.error_description) {
              message = String(parsed.error_description);
            } else if (parsed.msg) {
              message = String(parsed.msg);
            }
          } catch {
            // keep status message
          }
          finish(null, message);
          return;
        }

        this.networkChecked = true;
        this.networkAvailable = true;

        if (!raw) {
          finish({});
          return;
        }
        try {
          finish(JSON.parse(raw) as JsonRecord);
        } catch {
          finish(null, 'Invalid JSON response');
        }
      } catch (e) {
        if (this.debugLogging) {
          print('[SpecsApi] fetch failed: ' + e);
        }
        finish(null, this.formatNetworkError(e));
      }
    };

    run();
  }

  private requestJsonViaRemoteService(
    url: string,
    method: 'GET' | 'POST',
    body: JsonRecord | null,
    headers: Record<string, string> | null,
    onDone: (data: JsonRecord | null, error?: string) => void,
    timeoutSec: number
  ): void {
    let settled = false;
    const timeoutEvent = this.createEvent('DelayedCallbackEvent');
    const finish = (data: JsonRecord | null, error?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      timeoutEvent.enabled = false;
      onDone(data, error);
    };
    timeoutEvent.bind(() => {
      finish(null, `Request timed out after ${timeoutSec.toFixed(1)} seconds`);
    });
    timeoutEvent.reset(timeoutSec);

    let request: RemoteServiceHttpRequest;
    try {
      request = RemoteServiceHttpRequest.create();
    } catch (e) {
      finish(null, this.formatNetworkError(e));
      return;
    }

    request.url = url;
    request.method =
      method === 'GET'
        ? RemoteServiceHttpRequest.HttpRequestMethod.Get
        : RemoteServiceHttpRequest.HttpRequestMethod.Post;
    if (headers) {
      const keys = Object.keys(headers);
      for (let i = 0; i < keys.length; i++) {
        request.setHeader(keys[i], headers[keys[i]]);
      }
    }
    if (method !== 'GET' && body) {
      request.body = JSON.stringify(body);
    }

    try {
      this.internetModule.performHttpRequest(request, (response: RemoteServiceHttpResponse) => {
        if (settled) {
          return;
        }
        try {
          this.handleHttpResponse(request, response, finish);
        } catch (e) {
          finish(null, String(e));
        }
      });
    } catch (e) {
      finish(null, String(e));
    }
  }

  private shouldUseUnpairedMockFallback(error?: string, message?: string): boolean {
    if (!this.useMockFallbackWhenUnpaired || this.isEditorMockActive()) {
      return false;
    }
    if (this.isAutoPairWithCredentialsEnabled() && !this.credentialPairFailed) {
      return false;
    }
    if (isMusicQuery(String(message || ''))) {
      return false;
    }
    // News is handled by arvis.space agent chat — never divert to Google RSS mock.
    if (isNewsQuery(String(message || ''))) {
      return false;
    }
    if (isImageQuery(String(message || ''))) {
      return false;
    }
    const errorMessage = String(error || '').toLowerCase();
    return (
      errorMessage.includes('not paired') ||
      errorMessage.includes('device is not paired') ||
      errorMessage.includes('http 403')
    );
  }

  private replyWithUnpairedMockFallback(
    agentName: string,
    message: string,
    history: Array<{ role: string; text: string }>,
    onDone: (
      result: { response: string; agentName: string; imageUrl?: string; musicUrl?: string } | null,
      error?: string
    ) => void
  ): void {
    const mock = SpecsEditorMock.chatWithAgent(agentName, message, history);
    if (this.debugLogging) {
      print(
        `[SpecsApi] Unpaired live device — mock fallback ${mock.agent.name}: ${mock.response.slice(0, 120)}`
      );
    }
    const imageUrl = extractImageUrlFromAgentResponse(
      mock.response,
      mock.imageUrl,
      this.normalizeBaseUrl()
    );
    const musicUrl = extractMusicUrlFromAgentResponse(
      mock.response,
      mock.musicUrl,
      this.normalizeBaseUrl()
    );
    const delayEvent = this.createEvent('DelayedCallbackEvent');
    delayEvent.bind(() => {
      onDone({
        response: mock.response,
        agentName: mock.agent.name,
        imageUrl,
        musicUrl,
      });
    });
    delayEvent.reset(isImageQuery(message) || isMeshQuery(message) || isMusicQuery(message) ? 1.0 : 0.35);
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

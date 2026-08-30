import {
  getSharedArvisGhostBlob,
  getSharedFlowGardenSpacePanel,
  getSharedFlowGardenTts,
  getSharedFriendGrab,
  getSharedSpecsApi,
  getSharedSpecsDeviceRegistry,
  getSharedSpeechRecognition,
  registerArvisAgentChat,
} from './FlowGardenServiceRegistry';
import {
  extractAgentPrompt,
  findArvisWakeInTranscript,
  hasWakeFollowUp,
  looksLikeAssistantEcho,
  looksLikeIncompleteAgentPrompt,
  normalizeAsrTranscript,
  sanitizeListeningTranscript,
} from './ArvisWakePhrase';
import { isImageQuery, normalizeImagePrompt } from './ArvisImageSkill';
import { isMeshQuery, normalizeMeshPrompt } from './ArvisMeshSkill';
import { isMusicQuery, normalizeMusicPrompt } from './ArvisMusicSkill';
import {
  ArvisCalendarIntent,
  parseArvisCalendarIntent,
} from './ArvisCalendarIntent';
import {
  ArvisEmailDraftIntent,
  ArvisMacOpenAppIntent,
  isExplicitMacRequest,
  parseArvisMacOpenAppIntent,
  parseArvisEmailDraftIntent,
} from './ArvisEmailDraftIntent';
import { looksLikeWorkspaceResetCommand } from './FriendGrab';
import {
  SpecsApiClient,
  SpecsCalendar,
  SpecsCalendarConfig,
  SpecsCalendarEvent,
  SpecsCalendarEventInput,
} from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';
import { SpeechRecognition } from './SpeechRecognition';
import { FlowGardenTTS } from './FlowGardenTTS';

type AgentHistoryEntry = {
  role: 'user' | 'assistant';
  text: string;
};

type SpacePanelLike = {
  showAgentChat?: (
    transcript: string,
    response: string | null,
    agentName: string,
    phase: 'listening' | 'thinking' | 'reply' | 'error',
    imageUrl?: string | null
  ) => void;
  isAgentViewActive?: () => boolean;
  showAgentImage?: (imageUrl: string) => void;
};

type InteractableLike = ScriptComponent & {
  onInteractorTriggerStart?: { add: (cb: (event?: unknown) => void) => void };
  onTriggerStart?: { add: (cb: (event?: unknown) => void) => void };
  onInteractorTriggerEnd?: { add: (cb: (event?: unknown) => void) => void };
  onTriggerEnd?: { add: (cb: (event?: unknown) => void) => void };
};

@component
export class ArvisAgentChat extends BaseScriptComponent {
  @input
  @allowUndefined
  speechRecognition!: SpeechRecognition;

  @input
  @allowUndefined
  specsApi!: SpecsApiClient;

  @input
  @allowUndefined
  deviceRegistry!: SpecsDeviceRegistry;

  @input
  @allowUndefined
  spacePanel!: ScriptComponent;

  @input
  @allowUndefined
  agentResponseText!: Text;

  @input
  @allowUndefined
  agentResponseText3D!: Text3D;

  @input
  @allowUndefined
  statusText!: Text;

  @input
  @allowUndefined
  talkInteractable!: ScriptComponent;

  @input
  @allowUndefined
  agentTts!: FlowGardenTTS;

  @input
  enableSpeechOutput: boolean = true;

  @input
  agentName: string = 'Arvis';

  @input
  useHoldToTalk: boolean = false;

  @input
  maxHistoryTurns: number = 8;

  @input
  debugLogging: boolean = false;

  @input
  transcriptOnlyMode: boolean = false;

  private history: AgentHistoryEntry[] = [];
  private listening = false;
  private sending = false;
  private wakeAwaitingPrompt = false;
  private consumedWakeFinal = '';
  private lastListeningBoardTranscript = '';
  private activeReplyTranscript = '';
  private activeReplyText = '';
  private interactableBound = false;
  private dependenciesLogged = false;
  private lastVoiceWakeUtterance = '';
  private lastVoiceWakeAt = 0;
  private emailDraftStatusPollEvent: DelayedCallbackEvent | null = null;
  private emailDraftStatusPollCommandId = '';
  private emailDraftStatusPollAttempts = 0;
  private bridgeStatusSuccessMessage = '';

  private static readonly LISTENING_CUE = 'Listening…';
  private static readonly VOICE_WAKE_DEDUPE_SEC = 2.5;
  private static readonly VOICE_WAKE_STABLE_SEC = 0.55;
  private static readonly VOICE_POLL_INTERVAL_SEC = 0.15;
  private static readonly EMAIL_DRAFT_STATUS_MAX_POLLS = 480;

  private nextVoiceWakePollAt = 0;
  private nextListeningBoardRefreshAt = 0;

  onAwake(): void {
    registerArvisAgentChat(this);
    this.setStatus('Tap or pinch UserID to talk to ' + this.agentName);
    this.createEvent('OnStartEvent').bind(() => {
      this.resolveDependencies();
      this.bindTalkInteractable();
    });
    this.createEvent('UpdateEvent').bind(() => {
      this.pollIdleVoiceWake();
      this.refreshListeningBoard();
    });
    this.createEvent('TapEvent').bind(() => this.toggleAgentTalk());
  }

  private refreshListeningBoard(): void {
    const now = getTime();
    if (now < this.nextListeningBoardRefreshAt) {
      return;
    }
    this.nextListeningBoardRefreshAt = now + ArvisAgentChat.VOICE_POLL_INTERVAL_SEC;

    if (!this.listening || this.sending || isNull(this.speechRecognition)) {
      return;
    }

    if (this.wakeAwaitingPrompt) {
      this.trySendWakePrompt();
    }

    // trySendWakePrompt may start a send — never overwrite thinking/reply with live ASR.
    if (!this.listening || this.sending) {
      return;
    }

    if (this.transcriptOnlyMode) {
      return;
    }

    const rawLive = this.speechRecognition.getLiveTranscript();
    // While waiting for a question after wake, stay on Listening… until a real prompt exists.
    // Otherwise VoiceML interims like "hey" flicker the bubble.
    let display = '';
    if (this.wakeAwaitingPrompt) {
      const prompt = extractAgentPrompt(rawLive);
      display = prompt || ArvisAgentChat.LISTENING_CUE;
    } else {
      display = sanitizeListeningTranscript(rawLive);
    }
    if (display === this.lastListeningBoardTranscript) {
      return;
    }
    this.lastListeningBoardTranscript = display;
    this.updateBoard('listening', display, null);
  }

  private resetListeningBoardCache(): void {
    this.lastListeningBoardTranscript = '';
  }

  private pollIdleVoiceWake(): void {
    const now = getTime();
    if (now < this.nextVoiceWakePollAt) {
      return;
    }
    this.nextVoiceWakePollAt = now + ArvisAgentChat.VOICE_POLL_INTERVAL_SEC;

    if (this.listening || this.sending) {
      return;
    }

    this.resolveDependencies();
    if (isNull(this.speechRecognition)) {
      return;
    }
    if (this.speechRecognition.isAgentSessionActive()) {
      return;
    }
    if (this.speechRecognition.isSuppressingVoiceCommands()) {
      return;
    }
    if (this.speechRecognition.isPostItCaptureActive()) {
      return;
    }

    const tts = getSharedFlowGardenTts();
    if (!isNull(tts) && (tts.isBlockingVoiceCommands() || tts.isSpeaking())) {
      return;
    }
    if (this.speechRecognition.isCoolingDown()) {
      return;
    }

    const finalText = normalizeAsrTranscript(this.speechRecognition.finalTranscript || '');
    const liveText = normalizeAsrTranscript(this.speechRecognition.getLiveTranscript());
    const stableWakeText = normalizeAsrTranscript(
      this.speechRecognition.getStableUtterance(ArvisAgentChat.VOICE_WAKE_STABLE_SEC)
    );

    const wakeFromFinal = findArvisWakeInTranscript(finalText);
    const wakeFromLive = findArvisWakeInTranscript(liveText);
    const wakeFromStable = findArvisWakeInTranscript(stableWakeText);
    const wake = wakeFromFinal.triggered
      ? wakeFromFinal
      : wakeFromLive.triggered
        ? wakeFromLive
        : wakeFromStable;

    if (!wake.triggered) {
      return;
    }

    const wakeCandidate = wake.message
      ? `hey arvis ${wake.message}`
      : 'hey arvis';
    if (looksLikeAssistantEcho(wakeCandidate)) {
      return;
    }

    const finalPrompt = wakeFromFinal.triggered
      ? extractAgentPrompt(`hey arvis ${wakeFromFinal.message}`.trim())
      : '';
    const livePrompt =
      !finalPrompt && wakeFromLive.triggered
        ? extractAgentPrompt(`hey arvis ${wakeFromLive.message}`.trim())
        : '';

    // Wait for a final when the live stream still looks like a partial question.
    if (!finalPrompt && livePrompt) {
      return;
    }

    const wakeOnlyOnFinal = wakeFromFinal.triggered && !finalPrompt;
    const wakeOnlyOnLive =
      !wakeFromFinal.triggered && wakeFromLive.triggered && !livePrompt;
    const wakeOnlyOnStable =
      !wakeFromFinal.triggered &&
      !wakeFromLive.triggered &&
      wakeFromStable.triggered &&
      !extractAgentPrompt(`hey arvis ${wakeFromStable.message}`.trim());

    if (!finalPrompt && !wakeOnlyOnFinal && !wakeOnlyOnLive && !wakeOnlyOnStable) {
      return;
    }

    const dedupeKey = finalPrompt || wakeCandidate;
    if (
      normalizeAsrTranscript(dedupeKey) === normalizeAsrTranscript(this.lastVoiceWakeUtterance) &&
      getTime() - this.lastVoiceWakeAt < ArvisAgentChat.VOICE_WAKE_DEDUPE_SEC
    ) {
      return;
    }

    this.lastVoiceWakeUtterance = dedupeKey;
    this.lastVoiceWakeAt = getTime();
    this.speechRecognition.clearUtteranceState();
    this.speechRecognition.markCommandHandled();

    if (finalPrompt) {
      const prompt = this.normalizeAgentPrompt(finalPrompt);
      if (this.debugLogging) {
        print(`[ArvisAgentChat] Voice wake → ${prompt}`);
      }
      this.sendMessage(prompt);
      return;
    }

    if (this.debugLogging) {
      print(`[ArvisAgentChat] Voice wake open mic (${wakeCandidate})`);
    }
    this.beginWakeListening();
  }

  public beginWakeListening(): void {
    if (this.listening || this.sending) {
      return;
    }

    this.resolveDependencies();
    if (isNull(this.speechRecognition)) {
      this.setStatus('Speech recognition not wired');
      return;
    }

    this.listening = true;
    this.wakeAwaitingPrompt = true;
    this.resetListeningBoardCache();
    this.consumedWakeFinal = '';
    this.speechRecognition.beginAgentSession();
    this.speechRecognition.clearUtteranceState();
    this.lastListeningBoardTranscript = ArvisAgentChat.LISTENING_CUE;
    this.updateBoard('listening', ArvisAgentChat.LISTENING_CUE, null);
    this.setStatus(this.agentName + ' is listening…');
  }

  private trySendWakePrompt(): void {
    if (isNull(this.speechRecognition) || this.sending) {
      return;
    }

    const finalText = normalizeAsrTranscript(this.speechRecognition.finalTranscript || '');
    if (!finalText || finalText === normalizeAsrTranscript(this.consumedWakeFinal)) {
      return;
    }

    if (looksLikeIncompleteAgentPrompt(finalText)) {
      return;
    }

    const wake = findArvisWakeInTranscript(finalText);
    if (wake.triggered && !hasWakeFollowUp(wake.message)) {
      // Repeated "hey arvis" while already listening — ignore, keep cue.
      this.consumedWakeFinal = finalText;
      this.speechRecognition.clearUtteranceState();
      this.lastListeningBoardTranscript = ArvisAgentChat.LISTENING_CUE;
      this.updateBoard('listening', ArvisAgentChat.LISTENING_CUE, null);
      return;
    }

    // During open-mic, ignore ambient TV bleed finals.
    if (!wake.triggered && finalText.split(/\s+/).length >= 8) {
      this.consumedWakeFinal = finalText;
      this.speechRecognition.clearUtteranceState();
      return;
    }

    const question = this.normalizeAgentPrompt(
      extractAgentPrompt(finalText) || sanitizeListeningTranscript(finalText)
    );
    if (!question || looksLikeIncompleteAgentPrompt(question) || looksLikeAssistantEcho(question)) {
      return;
    }

    this.wakeAwaitingPrompt = false;
    this.listening = false;
    this.resetListeningBoardCache();
    this.speechRecognition.endAgentSessionPreserveListening();
    this.speechRecognition.clearUtteranceState();
    this.sendMessage(question);
  }

  public isBusy(): boolean {
    return this.listening || this.sending;
  }

  public isAgentBoardActive(): boolean {
    const panel = this.getSpacePanel();
    return (
      !isNull(panel) &&
      typeof panel.isAgentViewActive === 'function' &&
      panel.isAgentViewActive()
    );
  }

  public sendUtterance(message: string): void {
    if (this.listening || this.sending) {
      return;
    }

    const trimmed = String(message || '').trim();
    if (!trimmed) {
      return;
    }

    this.resolveDependencies();
    this.sendMessage(this.normalizeAgentPrompt(trimmed));
  }

  public beginAgentTalk(): void {
    if (this.listening || this.sending) {
      return;
    }

    this.resolveDependencies();
    if (isNull(this.speechRecognition)) {
      this.setStatus('Speech recognition not wired');
      return;
    }

    // Same open-mic path as "hey arvis" — clears ambient VoiceML junk first.
    this.listening = true;
    this.wakeAwaitingPrompt = true;
    this.resetListeningBoardCache();
    this.consumedWakeFinal = '';
    this.speechRecognition.clearUtteranceState();
    this.speechRecognition.beginAgentSession();
    this.lastListeningBoardTranscript = ArvisAgentChat.LISTENING_CUE;
    this.updateBoard('listening', ArvisAgentChat.LISTENING_CUE, null);
    this.setStatus(this.agentName + ' is listening…');
  }

  /**
   * Starts a hold-to-talk session owned by the companion grab interaction.
   * Unlike wake-word listening, every spoken phrase is treated as the user's
   * prompt so the user can address Arvis directly while holding Buddy.
   */
  public beginCompanionGrabTalk(): boolean {
    if (this.listening || this.sending) {
      return false;
    }

    this.resolveDependencies();
    if (isNull(this.speechRecognition)) {
      this.setStatus('Speech recognition not wired');
      return false;
    }

    this.listening = true;
    this.wakeAwaitingPrompt = false;
    this.resetListeningBoardCache();
    this.consumedWakeFinal = '';
    this.speechRecognition.clearUtteranceState();
    this.speechRecognition.beginAgentSession();
    this.lastListeningBoardTranscript = ArvisAgentChat.LISTENING_CUE;
    this.updateBoard('listening', ArvisAgentChat.LISTENING_CUE, null);
    this.setStatus(this.agentName + ' is listening — release to send');
    return true;
  }

  public endAgentTalkAndSend(): void {
    if (!this.listening || isNull(this.speechRecognition)) {
      return;
    }

    this.listening = false;
    this.wakeAwaitingPrompt = false;
    this.resetListeningBoardCache();
    const transcript = this.transcriptOnlyMode
      ? this.speechRecognition.endAgentSessionPreserveListening()
      : this.speechRecognition.endAgentSession();
    if (!transcript) {
      this.updateBoard('error', '', 'Did not catch that. Try again.');
      this.setStatus('No speech detected');
      return;
    }

    if (this.transcriptOnlyMode) {
      this.setStatus(transcript ? 'Transcript captured' : 'No speech detected');
      return;
    }

    this.sendMessage(this.normalizeAgentPrompt(transcript));
  }

  public cancelAgentTalk(): void {
    this.listening = false;
    this.wakeAwaitingPrompt = false;
    this.resetListeningBoardCache();
    if (!isNull(this.speechRecognition)) {
      this.speechRecognition.cancelAgentSession();
    }
    this.updateBoard('error', '', 'Cancelled');
    this.setStatus('');
  }

  public toggleAgentTalk(): void {
    if (this.listening) {
      this.endAgentTalkAndSend();
      return;
    }
    this.beginAgentTalk();
  }

  private resolveDependencies(): void {
    if (isNull(this.specsApi)) {
      this.specsApi = getSharedSpecsApi();
    }
    if (isNull(this.deviceRegistry)) {
      this.deviceRegistry = getSharedSpecsDeviceRegistry();
    }
    if (isNull(this.speechRecognition)) {
      this.speechRecognition = getSharedSpeechRecognition();
    }
    if (isNull(this.spacePanel)) {
      const panel = getSharedFlowGardenSpacePanel();
      this.spacePanel = panel as unknown as ScriptComponent;
    }
    if (isNull(this.agentTts)) {
      this.agentTts = getSharedFlowGardenTts();
    }

    if (this.debugLogging && !this.dependenciesLogged) {
      this.dependenciesLogged = true;
      print(
        `[ArvisAgentChat] resolved speech=${!isNull(this.speechRecognition)} panel=${!isNull(this.spacePanel)} api=${!isNull(this.specsApi)}`
      );
    }
  }

  private bindTalkInteractable(): void {
    if (this.interactableBound || isNull(this.talkInteractable)) {
      return;
    }

    const interactable = this.talkInteractable as InteractableLike;
    const triggerStart = interactable.onInteractorTriggerStart || interactable.onTriggerStart;
    const triggerEnd = interactable.onInteractorTriggerEnd || interactable.onTriggerEnd;

    if (!triggerStart) {
      if (this.debugLogging) {
        print('[ArvisAgentChat] talkInteractable has no trigger events — tap UserID to talk');
      }
      return;
    }

    if (this.useHoldToTalk) {
      triggerStart.add(() => this.beginAgentTalk());
      if (triggerEnd) {
        triggerEnd.add(() => this.endAgentTalkAndSend());
      }
    } else {
      triggerStart.add(() => this.toggleAgentTalk());
    }

    this.interactableBound = true;
    if (this.debugLogging) {
      print('[ArvisAgentChat] bound talk interactable');
    }
  }

  private canSendToAgent(): boolean {
    if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      return false;
    }
    if (this.specsApi.isEditorMockActive()) {
      return true;
    }
    if (this.deviceRegistry.getDeviceSecret().length > 0) {
      return true;
    }
    return this.deviceRegistry.isPaired();
  }

  private normalizeAgentPrompt(message: string): string {
    const trimmed = String(message || '').trim();
    if (!trimmed) {
      return '';
    }
    return (
      normalizeMeshPrompt(trimmed) ||
      normalizeImagePrompt(trimmed) ||
      normalizeMusicPrompt(trimmed) ||
      trimmed
    );
  }

  private tryHandleLocalBuddyCommand(message: string): boolean {
    if (!looksLikeWorkspaceResetCommand(message)) {
      return false;
    }
    const friend = getSharedFriendGrab();
    if (isNull(friend) || typeof friend.restartOnboardingTour !== 'function') {
      this.setStatus('Buddy reset unavailable');
      return true;
    }
    if (this.debugLogging) {
      print(`[ArvisAgentChat] Local buddy command: workspace reset`);
    }
    this.listening = false;
    this.wakeAwaitingPrompt = false;
    this.resetListeningBoardCache();
    if (!isNull(this.speechRecognition)) {
      this.speechRecognition.cancelAgentSession();
    }
    const ok = friend.restartOnboardingTour('hey-friend');
    this.setStatus(ok ? 'Restarting setup…' : 'Setup already running');
    return true;
  }

  private sendMessage(message: string): void {
    if (this.sending) {
      return;
    }

    const trimmed = String(message || '').trim();
    if (!trimmed) {
      return;
    }

    if (this.tryHandleLocalBuddyCommand(trimmed)) {
      return;
    }

    const outbound = this.normalizeAgentPrompt(trimmed);
    const calendarIntent = parseArvisCalendarIntent(outbound);
    const emailDraftIntent = parseArvisEmailDraftIntent(outbound);
    const macDirectedRequest = isExplicitMacRequest(outbound);
    const openAppIntent = parseArvisMacOpenAppIntent(outbound);
    this.resolveDependencies();
    if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      this.updateBoard('error', outbound, 'Missing Specs API wiring');
      return;
    }

    const imageRequest = isImageQuery(outbound);

    if (!this.canSendToAgent() && !imageRequest) {
      this.updateBoard('error', outbound, 'Pair at arvis.space/specs to use remote agents.');
      this.setStatus('Connecting to arvis.space…');
      return;
    }

    if (emailDraftIntent && macDirectedRequest) {
      this.queueEmailDraft(emailDraftIntent, outbound);
      return;
    }

    if (openAppIntent) {
      this.queueOpenApp(openAppIntent, outbound);
      return;
    }

    if (calendarIntent) {
      this.handleCalendarIntent(calendarIntent, outbound);
      return;
    }

    this.sending = true;
    const meshRequest = isMeshQuery(outbound);
    const musicRequest = isMusicQuery(outbound);
    const thinkingStatus = meshRequest
      ? 'Generating 3D…'
      : imageRequest
        ? 'Generating image…'
        : musicRequest
          ? 'Generating music…'
          : 'Thinking…';
    this.updateBoard(
      'thinking',
      outbound,
      imageRequest ? 'Generating your image…' : null
    );
    this.setStatus(thinkingStatus);

    const payloadHistory = this.history.map((entry) => ({
      role: entry.role,
      text: entry.text,
    }));

    try {
      this.specsApi.chatWithAgent(
        this.deviceRegistry.getDeviceId(),
        this.deviceRegistry.getDeviceSecret(),
        outbound,
        this.agentName,
        payloadHistory,
        (result, error) => {
          this.sending = false;
          if (!result) {
            this.updateBoard('error', outbound, error || 'unknown');
            this.setStatus('');
            return;
          }

          this.pushHistory('user', outbound);
          this.pushHistory('assistant', result.response);
          const label = result.agentName || this.agentName;
          this.activeReplyTranscript = outbound;
          this.activeReplyText = result.response;
          this.updateBoard('reply', outbound, result.response, label, result.imageUrl || null);
          this.setStatus('');
          if (!isNull(this.speechRecognition)) {
            this.speechRecognition.clearUtteranceState();
            this.speechRecognition.markCommandHandled();
            this.speechRecognition.suppressVoiceCommandsFor(2.5);
          }
          if (this.debugLogging) {
            print(`[ArvisAgentChat] ${label}: ${result.response}`);
            if (result.imageUrl) {
              print(`[ArvisAgentChat] image ${String(result.imageUrl).slice(0, 120)}`);
            }
          }
          this.speakAgentResponse(result.response, label);
        }
      );
    } catch (e) {
      this.sending = false;
      this.updateBoard('error', outbound, String(e));
      this.setStatus('Agent request failed');
    }
  }

  private queueEmailDraft(emailDraftIntent: ArvisEmailDraftIntent, outbound: string): void {
    if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      this.updateBoard('error', outbound, 'Missing Specs API wiring');
      return;
    }

    this.sending = true;
    this.bridgeStatusSuccessMessage = 'Arvis opened the unsent Thunderbird draft on your Mac.';
    this.updateBoard(
      'thinking',
      outbound,
      'Waiting for your approval on the Arvis Mac panel…'
    );
    this.setStatus('Waiting for email approval on your Mac…');
    try {
      this.specsApi.queueEmailDraft(
        this.deviceRegistry.getDeviceId(),
        this.deviceRegistry.getDeviceSecret(),
        emailDraftIntent.requestId,
        emailDraftIntent.recipient,
        emailDraftIntent.subject,
        emailDraftIntent.body,
        (result, error) => {
          if (!result) {
            this.sending = false;
            this.updateBoard('error', outbound, error || 'Could not reach the Arvis Mac bridge');
            this.setStatus(error || 'Arvis Mac bridge unavailable');
            return;
          }

          const waitingResponse =
            'Email draft queued. Approve it in the Arvis Mac panel.';
          this.pushHistory('user', outbound);
          this.pushHistory('assistant', waitingResponse);
          this.activeReplyTranscript = outbound;
          this.activeReplyText = waitingResponse;
          this.updateBoard('thinking', outbound, waitingResponse, this.agentName);
          this.watchEmailDraftStatus(outbound, result.commandId);
        }
      );
    } catch (e) {
      this.sending = false;
      this.updateBoard('error', outbound, String(e));
      this.setStatus('Arvis Mac bridge request failed');
    }
  }

  private queueOpenApp(openAppIntent: ArvisMacOpenAppIntent, outbound: string): void {
    if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      this.updateBoard('error', outbound, 'Missing Specs API wiring');
      return;
    }

    this.sending = true;
    this.bridgeStatusSuccessMessage = `Arvis opened ${openAppIntent.applicationName} on your Mac.`;
    this.updateBoard(
      'thinking',
      outbound,
      'Waiting for your approval on the Arvis Mac panel…'
    );
    this.setStatus('Waiting for Mac approval…');
    try {
      this.specsApi.queueOpenApp(
        this.deviceRegistry.getDeviceId(),
        this.deviceRegistry.getDeviceSecret(),
        openAppIntent.requestId,
        openAppIntent.applicationName,
        (result, error) => {
          if (!result) {
            this.sending = false;
            this.updateBoard('error', outbound, error || 'Could not reach the Arvis Mac bridge');
            this.setStatus(error || 'Arvis Mac bridge unavailable');
            return;
          }

          this.pushHistory('user', outbound);
          this.pushHistory(
            'assistant',
            'Waiting for your approval on the Arvis Mac panel.'
          );
          this.activeReplyTranscript = outbound;
          this.activeReplyText = 'Waiting for your approval on the Arvis Mac panel.';
          this.updateBoard(
            'thinking',
            outbound,
            'Waiting for your approval on the Arvis Mac panel.',
            this.agentName
          );
          this.watchEmailDraftStatus(outbound, result.commandId);
        }
      );
    } catch (e) {
      this.sending = false;
      this.updateBoard('error', outbound, String(e));
      this.setStatus('Arvis Mac bridge request failed');
    }
  }

  private handleCalendarIntent(intent: ArvisCalendarIntent, outbound: string): void {
    if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      this.finishCalendarResponse(outbound, 'Missing Specs API wiring', true);
      return;
    }

    this.sending = true;
    const thinkingText =
      intent.type === 'createEvent' ? 'Adding calendar event…' : 'Checking your calendar…';
    this.updateBoard('thinking', outbound, thinkingText);
    this.setStatus(thinkingText);

    const deviceId = this.deviceRegistry.getDeviceId();
    const deviceSecret = this.deviceRegistry.getDeviceSecret();
    if (intent.type === 'setCalendarId') {
      this.specsApi.setCalendarId(
        deviceId,
        deviceSecret,
        intent.calendarId || '',
        (config, error) => {
          if (isNull(config)) {
            this.finishCalendarResponse(outbound, this.formatCalendarError(error), true);
            return;
          }
          this.finishCalendarResponse(outbound, this.formatCalendarConfig(config));
        }
      );
      return;
    }

    if (intent.type === 'config') {
      this.specsApi.fetchCalendarConfig(deviceId, deviceSecret, (config, error) => {
        if (isNull(config)) {
          this.finishCalendarResponse(outbound, this.formatCalendarError(error), true);
          return;
        }
        this.finishCalendarResponse(outbound, this.formatCalendarConfig(config));
      });
      return;
    }

    if (intent.type === 'availableCalendars') {
      this.specsApi.fetchAvailableCalendars(deviceId, deviceSecret, (calendars, error) => {
        if (error) {
          this.finishCalendarResponse(outbound, this.formatCalendarError(error), true);
          return;
        }
        this.finishCalendarResponse(outbound, this.formatAvailableCalendars(calendars));
      });
      return;
    }

    if (intent.type === 'events') {
      this.specsApi.fetchCalendarEvents(
        deviceId,
        deviceSecret,
        {
          timeMin: intent.timeMin,
          timeMax: intent.timeMax,
          maxResults: 5,
        },
        (events, error) => {
          if (error) {
            this.finishCalendarResponse(outbound, this.formatCalendarError(error), true);
            return;
          }
          this.finishCalendarResponse(
            outbound,
            this.formatCalendarEvents(events, intent.rangeLabel)
          );
        }
      );
      return;
    }

    if (!intent.title || !intent.startAt || !intent.endAt) {
      this.finishCalendarResponse(
        outbound,
        'Tell me the event title and when it starts, for example “schedule design review tomorrow at 3 PM”.'
      );
      return;
    }

    const event: SpecsCalendarEventInput = {
      title: intent.title,
      startAt: intent.startAt,
      endAt: intent.endAt,
    };
    this.specsApi.createCalendarEvent(deviceId, deviceSecret, event, (created, error) => {
      if (isNull(created)) {
        this.finishCalendarResponse(outbound, this.formatCalendarError(error), true);
        return;
      }
      this.finishCalendarResponse(outbound, this.formatCreatedCalendarEvent(created));
    });
  }

  private finishCalendarResponse(
    transcript: string,
    response: string,
    isError = false
  ): void {
    this.sending = false;
    this.pushHistory('user', transcript);
    this.pushHistory('assistant', response);
    this.activeReplyTranscript = transcript;
    this.activeReplyText = response;
    this.updateBoard(isError ? 'error' : 'reply', transcript, response, this.agentName);
    if (isError) {
      this.setStatus(response);
    } else {
      this.setStatus('');
    }
    if (!isNull(this.speechRecognition)) {
      this.speechRecognition.clearUtteranceState();
      this.speechRecognition.markCommandHandled();
      this.speechRecognition.suppressVoiceCommandsFor(2.5);
    }
    this.speakAgentResponse(response, this.agentName);
  }

  private formatCalendarConfig(config: SpecsCalendarConfig): string {
    const guidance = this.calendarConnectionGuidance();
    if (!config.connected) {
      return `Google Calendar is not connected. ${guidance}`;
    }
    if (!config.calendarId) {
      return `Google Calendar is connected, but no Calendar ID is selected. Say “set calendar id <id>”. ${guidance}`;
    }
    const selected = config.calendarName
      ? `${config.calendarName} (${config.calendarId})`
      : config.calendarId;
    return `Using calendar ${selected}. ${guidance}`;
  }

  private formatAvailableCalendars(calendars: SpecsCalendar[]): string {
    if (!calendars.length) {
      return `No calendars are available. ${this.calendarConnectionGuidance()}`;
    }
    const entries = calendars.slice(0, 5).map((calendar) => {
      const label = calendar.name || calendar.id;
      return `${label} (${calendar.id})${calendar.primary ? ' [primary]' : ''}`;
    });
    return (
      `Available calendars: ${entries.join('; ')}. ` +
      'Say “use calendar <id>” to select one.'
    );
  }

  private formatCalendarEvents(events: SpecsCalendarEvent[], rangeLabel?: string): string {
    if (!events.length) {
      const range = rangeLabel ? ` ${rangeLabel}` : '';
      return `No calendar events found${range}.`;
    }
    const label = rangeLabel ? ` ${rangeLabel}` : '';
    const lines = events
      .slice(0, 5)
      .map(
        (event, index) =>
          `${index + 1}. ${this.formatCalendarEventDate(event)} — ${event.title || 'Untitled event'}`
      );
    return `Your${label} calendar:\n${lines.join('\n')}`;
  }

  private formatCreatedCalendarEvent(event: SpecsCalendarEvent): string {
    const title = event.title || 'calendar event';
    return `Added “${title}” to your calendar for ${this.formatCalendarEventDate(event)}.`;
  }

  private formatCalendarEventDate(event: SpecsCalendarEvent): string {
    const value = String(event.startAt || '').trim();
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) {
      return value || 'the requested time';
    }

    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    const month = months[date.getMonth()];
    if (event.allDay) {
      return `${month} ${date.getDate()} all day`;
    }

    const hours = date.getHours();
    const displayHour = hours % 12 || 12;
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const meridiem = hours >= 12 ? 'PM' : 'AM';
    return `${month} ${date.getDate()} at ${displayHour}:${minutes} ${meridiem}`;
  }

  private formatCalendarError(error?: string): string {
    const detail = String(error || 'Could not reach the calendar service').trim();
    return `${detail}. ${this.calendarConnectionGuidance()}`;
  }

  private calendarConnectionGuidance(): string {
    return 'Google OAuth connection happens in arvis.space Settings.';
  }

  private watchEmailDraftStatus(transcript: string, commandId: string): void {
    this.emailDraftStatusPollEvent = null;
    this.emailDraftStatusPollCommandId = commandId;
    this.emailDraftStatusPollAttempts = 0;
    this.pollEmailDraftStatus(transcript, commandId);
  }

  private pollEmailDraftStatus(transcript: string, commandId: string): void {
    if (
      commandId !== this.emailDraftStatusPollCommandId ||
      isNull(this.specsApi) ||
      isNull(this.deviceRegistry)
    ) {
      return;
    }

    this.emailDraftStatusPollAttempts += 1;
    if (
      this.emailDraftStatusPollAttempts > ArvisAgentChat.EMAIL_DRAFT_STATUS_MAX_POLLS
    ) {
      this.setStatus('Mac request queued — still waiting for approval');
      return;
    }

    this.specsApi.fetchBridgeCommandStatus(
      this.deviceRegistry.getDeviceId(),
      this.deviceRegistry.getDeviceSecret(),
      commandId,
      (status, error) => {
        if (commandId !== this.emailDraftStatusPollCommandId) {
          return;
        }

        if (!status) {
          if (this.debugLogging && error) {
            print(`[ArvisAgentChat] Email draft status pending: ${error}`);
          }
          this.scheduleEmailDraftStatusPoll(transcript, commandId);
          return;
        }

        const normalizedStatus = String(status.status || '').toLowerCase();
        if (
          normalizedStatus === 'pending'
          || normalizedStatus === 'claimed'
          || normalizedStatus === 'approved'
        ) {
          const statusMessage =
            normalizedStatus === 'approved'
              ? 'Approved — completing the safe Mac action…'
              : normalizedStatus === 'claimed'
                ? 'Waiting for approval in the Arvis Mac panel…'
                : 'Waiting for the Mac bridge…';
          this.updateBoard('thinking', transcript, statusMessage, this.agentName);
          this.setStatus(statusMessage);
          this.scheduleEmailDraftStatusPoll(transcript, commandId);
          return;
        }

        this.emailDraftStatusPollCommandId = '';
        this.emailDraftStatusPollEvent = null;
        this.sending = false;
        const response =
          normalizedStatus === 'opened' || normalizedStatus === 'completed'
            ? this.bridgeStatusSuccessMessage || 'The Mac action completed.'
            : normalizedStatus === 'declined'
              ? 'The Mac request was declined.'
              : normalizedStatus === 'expired'
                ? 'The Mac request expired before approval.'
                : String(status.result?.message || 'The Mac could not complete the request.');
        this.bridgeStatusSuccessMessage = '';
        this.activeReplyTranscript = transcript;
        this.activeReplyText = response;
        const succeeded =
          normalizedStatus === 'opened' || normalizedStatus === 'completed';
        this.updateBoard(
          succeeded ? 'reply' : 'error',
          transcript,
          response,
          this.agentName
        );
        this.setStatus(succeeded ? '' : response);
        this.speakAgentResponse(response, this.agentName);
      }
    );
  }

  private scheduleEmailDraftStatusPoll(transcript: string, commandId: string): void {
    if (commandId !== this.emailDraftStatusPollCommandId) {
      return;
    }
    this.emailDraftStatusPollEvent = this.createEvent('DelayedCallbackEvent');
    this.emailDraftStatusPollEvent.bind(() => {
      this.emailDraftStatusPollEvent = null;
      this.pollEmailDraftStatus(transcript, commandId);
    });
    this.emailDraftStatusPollEvent.reset(2);
  }

  private setGhostPhase(phase: 'listening' | 'thinking' | 'reply' | 'error' | 'idle'): void {
    const ghost = getSharedArvisGhostBlob();
    if (!isNull(ghost)) {
      ghost.setPhase(phase);
    }
  }

  private updateGhostSpeechBubble(
    phase: 'listening' | 'thinking' | 'reply' | 'error' | 'idle',
    transcript: string,
    response: string | null,
    agentName?: string
  ): void {
    const ghost = getSharedArvisGhostBlob();
    if (isNull(ghost)) {
      return;
    }
    ghost.showSpeechBubble(phase, transcript, response, agentName || this.agentName);
  }

  private updateBoard(
    phase: 'listening' | 'thinking' | 'reply' | 'error',
    transcript: string,
    response: string | null,
    agentName?: string,
    imageUrl?: string | null
  ): void {
    this.setGhostPhase(phase);
    this.updateGhostSpeechBubble(phase, transcript, response, agentName);

    const label = agentName || this.agentName;
    const panel = this.getSpacePanel();
    if (!isNull(panel) && typeof panel.showAgentChat === 'function') {
      panel.showAgentChat(transcript, response, label, phase, imageUrl || null);
      if (imageUrl && typeof panel.showAgentImage === 'function') {
        panel.showAgentImage(imageUrl);
      }
      return;
    }

    if (phase === 'listening') {
      this.setDisplay('Listening…');
      return;
    }
    if (phase === 'thinking') {
      this.setDisplay(`You: ${transcript}\n\n…`);
      return;
    }
    if (phase === 'error') {
      this.setDisplay(response || 'Error');
      return;
    }
    this.setDisplay(`${label}:\n${response || ''}`);
  }

  private getSpacePanel(): SpacePanelLike | null {
    if (isNull(this.spacePanel)) {
      return null;
    }
    return this.spacePanel as unknown as SpacePanelLike;
  }

  private speakAgentResponse(response: string, label: string): void {
    if (!this.enableSpeechOutput) {
      return;
    }
    if (isNull(this.agentTts)) {
      this.agentTts = getSharedFlowGardenTts();
    }
    if (isNull(this.agentTts)) {
      this.setStatus('Speech unavailable (TTS not wired)');
      return;
    }

    const spoken = String(response || '').trim();
    if (!spoken) {
      return;
    }

    this.setStatus(`${label} speaking…`);
    this.setGhostPhase('reply');
    this.updateGhostSpeechBubble(
      'reply',
      this.activeReplyTranscript || '',
      this.activeReplyText || spoken,
      label
    );
    this.agentTts.speak(spoken, (ok) => {
      // Keep the text reply visible — idle would hide the ghost bubble immediately.
      this.setGhostPhase('reply');
      this.updateGhostSpeechBubble(
        'reply',
        this.activeReplyTranscript || '',
        this.activeReplyText || spoken,
        label
      );
      this.setStatus(ok ? 'Say "hey arvis" or pinch me to talk' : 'Speech unavailable (reply still shown)');
      if (!isNull(this.speechRecognition)) {
        this.speechRecognition.clearUtteranceState();
        this.speechRecognition.markCommandHandled();
        // Extra pad after estimated TTS duration (FlowGardenTTS already suppressed during speech).
        this.speechRecognition.suppressVoiceCommandsFor(ok ? 3.5 : 2.5);
      }
      if (this.debugLogging) {
        print(`[ArvisAgentChat] TTS ${ok ? 'played' : 'failed'}`);
      }
      const idleEvent = this.createEvent('DelayedCallbackEvent');
      idleEvent.bind(() => {
        const ghost = getSharedArvisGhostBlob();
        if (!isNull(ghost)) {
          ghost.setPhaseKeepBubble('idle');
        }
      });
      idleEvent.reset(0.35);
    });
  }

  private pushHistory(role: 'user' | 'assistant', text: string): void {
    this.history.push({ role, text });
    const maxEntries = Math.max(2, this.maxHistoryTurns * 2);
    if (this.history.length > maxEntries) {
      this.history = this.history.slice(this.history.length - maxEntries);
    }
  }

  private setDisplay(message: string): void {
    const value = String(message || '');
    if (!isNull(this.agentResponseText)) {
      this.agentResponseText.text = value;
    }
    if (!isNull(this.agentResponseText3D)) {
      this.agentResponseText3D.text = value;
    }
  }

  private setStatus(message: string): void {
    if (!isNull(this.statusText)) {
      this.statusText.text = message;
    }
    if (this.debugLogging && message) {
      print(`[ArvisAgentChat] ${message}`);
    }
  }
}

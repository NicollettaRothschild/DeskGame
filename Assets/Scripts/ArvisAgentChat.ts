import {
  getSharedArvisGhostBlob,
  getSharedFlowGardenSpacePanel,
  getSharedFlowGardenTts,
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
import { SpecsApiClient } from './SpecsApiClient';
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
  debugLogging: boolean = true;

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

  private static readonly LISTENING_CUE = 'Listening…';
  private static readonly VOICE_WAKE_DEDUPE_SEC = 2.5;
  private static readonly VOICE_WAKE_STABLE_SEC = 0.55;

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
    if (this.specsApi.isAutoPairWithCredentialsEnabled()) {
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

  private sendMessage(message: string): void {
    if (this.sending) {
      return;
    }

    const trimmed = String(message || '').trim();
    if (!trimmed) {
      return;
    }

    const outbound = this.normalizeAgentPrompt(trimmed);
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

    // Auto-pair via Supabase credentials before any live agent call (news/chat/image).
    if (!this.deviceRegistry.isPaired() && this.specsApi.isAutoPairWithCredentialsEnabled()) {
      if (this.specsApi.isCredentialPairInFlight()) {
        this.setStatus('Pairing with arvis.space…');
        this.updateBoard('thinking', outbound, 'Signing in and pairing your device…');
        const retryEvent = this.createEvent('DelayedCallbackEvent');
        retryEvent.bind(() => {
          this.sendMessage(message);
        });
        retryEvent.reset(1.5);
        return;
      }
      if (this.deviceRegistry.getDeviceSecret().length > 0) {
        this.setStatus('Pairing with arvis.space…');
        this.updateBoard('thinking', outbound, 'Signing in and pairing your device…');
        this.specsApi.tryAutoPairWithCredentials(
          this.deviceRegistry.getDeviceId(),
          (ok, _userEmail, pairError) => {
            if (ok) {
              this.deviceRegistry.setPaired(true);
              this.sendMessage(message);
              return;
            }
            this.updateBoard(
              'error',
              outbound,
              pairError || 'Could not pair with arvis.space — check test@user.com credentials'
            );
            this.setStatus(pairError || 'Pairing failed');
          }
        );
        return;
      }
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

import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import {
  getSharedFlowGardenSpacePanel,
  getSharedFlowGardenTts,
  getSharedSpecsApi,
  getSharedSpecsDeviceRegistry,
  getSharedSpeechRecognition,
  registerCodingBuddy,
  unregisterCodingBuddy,
} from './FlowGardenServiceRegistry';
import { ArvisGhostBlob } from './ArvisGhostBlob';
import { SpecsApiClient } from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';
import { SpeechRecognition } from './SpeechRecognition';
import { FlowGardenTTS } from './FlowGardenTTS';
import { AgentCenterStateStore } from './AgentCenterStateStore';
import { PlantLifecycle } from './PlantLifecycle';

type InteractableLike = ScriptComponent & {
  onHoverEnter?: { add: (cb: () => void) => void };
  onHoverExit?: { add: (cb: () => void) => void };
  onInteractorHoverEnter?: { add: (cb: () => void) => void };
  onInteractorHoverExit?: { add: (cb: () => void) => void };
  onTriggerStart?: { add: (cb: () => void) => void };
  onDragStart?: { add: (cb: () => void) => void };
  onDragEnd?: { add: (cb: () => void) => void };
  onTriggerEnd?: { add: (cb: () => void) => void };
  onTriggerEndOutside?: { add: (cb: () => void) => void };
  onTriggerCanceled?: { add: (cb: () => void) => void };
  onInteractorTriggerStart?: { add: (cb: () => void) => void };
  onInteractorTriggerEnd?: { add: (cb: () => void) => void };
  onInteractorTriggerEndOutside?: { add: (cb: () => void) => void };
  onInteractorTriggerCanceled?: { add: (cb: () => void) => void };
};

/**
 * Companion avatar for a Mac-hosted coding agent.
 *
 * Holding the buddy starts a short speech capture, just like a Post-it note.
 * Releasing it submits the captured transcript to the paired Mac bridge,
 * where provider credentials stay outside the Lens. Global
 * "ask Cursor/Claude to ..." commands are also supported.
 */
@component
export class CursorBuddy extends BaseScriptComponent {
  @input
  @allowUndefined
  ghostBlob!: ArvisGhostBlob;

  @input
  @allowUndefined
  specsApi!: SpecsApiClient;

  @input
  @allowUndefined
  deviceRegistry!: SpecsDeviceRegistry;

  @input
  @allowUndefined
  speechRecognition!: SpeechRecognition;

  @input
  @allowUndefined
  agentTts!: FlowGardenTTS;

  @input
  @label('Provider ID')
  @hint('Bridge provider: cursor_sdk or claude_code.')
  providerId: string = 'cursor_sdk';

  @input
  @label('Buddy Name')
  buddyName: string = 'Cursor';

  @input
  @label('Approved Workspace ID')
  @hint('Bridge-issued allowlisted workspace ID. Never store a personal path here.')
  workspaceId: string = '';

  @input
  @label('Agent Model')
  agentModel: string = 'auto';

  @input
  enableSpeechOutput: boolean = true;

  @input
  debugLogging: boolean = false;

  private ghost: ArvisGhostBlob | null = null;
  private talkInteractionBound = false;
  private grabbing = false;
  private listening = false;
  private sending = false;
  private dependenciesLogged = false;
  private lastListeningTranscript = '';
  private capturedTalkTranscript = '';
  private talkListenerAttached = false;
  private talkPostItCaptureOwned = false;
  private pollingSessionId = '';
  private pollingAttempts = 0;
  private pollEvent: DelayedCallbackEvent | null = null;
  private talkStartPending = false;
  private talkBusyFeedbackPending = false;
  private talkCaptureEpoch = 0;
  private talkStartDueAt = 0;
  private talkUiPending = false;
  private talkUiDueAt = 0;
  private talkFinalizationPending = false;
  private talkFinalizationAttempts = 0;
  private talkFinalizationDueAt = 0;
  private talkFinalizationEpoch = 0;
  private talkReleasePending = false;
  private talkReleaseDueAt = 0;
  private lastStableTranscript = '';
  private talkHeardFinal = false;
  private micOpenLogged = false;
  private speechPrewarmEvent: DelayedCallbackEvent | null = null;
  private speechPrewarmPending = false;
  private speechReadyWaitStartedAt = -1;
  private associatedGoalPlant: PlantLifecycle | null = null;
  private destroyed = false;

  private static readonly LISTENING_CUE = 'Listening…';
  private static readonly SPEECH_PREWARM_DELAY_SEC = 1;
  private static readonly TALK_START_DELAY_SEC = 0.05;
  private static readonly SPEECH_READY_TIMEOUT_SEC = 3;
  private static readonly TALK_RELEASE_GRACE_SEC = 0.8;
  private static readonly TALK_FINALIZE_DELAY_SEC = 1.2;
  private static readonly MAX_TALK_FINALIZATION_ATTEMPTS = 10;
  private static readonly POLL_INTERVAL_SEC = 2;
  private static readonly MAX_STATUS_POLLS = 930;

  onAwake(): void {
    this.destroyed = false;
    registerCodingBuddy(this.getProviderId(), this);
    this.createEvent('OnStartEvent').bind(() => {
      this.resolveDependencies();
      this.resolveGhost();
      if (!isNull(this.ghost)) {
        this.ghost.requestNearUserRebase();
      }
      this.bindTalkInteraction();
      // Wait for hover/grab before claiming the native microphone on
      // Spectacles 2024.
      // Startup prewarm can race native session initialization on device.
    });

    this.createEvent('UpdateEvent').bind(() => {
      if (this.speechPrewarmPending) {
        this.speechPrewarmPending = false;
        this.prewarmSpeech();
      }
      if (this.talkBusyFeedbackPending) {
        this.talkBusyFeedbackPending = false;
        if (this.grabbing && this.sending) {
          this.showBubble(
            'thinking',
            '',
            `${this.getBuddyName()} is still working on the last task.`
          );
        }
      }
      if (this.talkUiPending && getTime() >= this.talkUiDueAt) {
        this.talkUiPending = false;
        this.talkUiDueAt = 0;
        if (this.listening) {
          this.setPhase('listening');
          this.showBubble('listening', CursorBuddy.LISTENING_CUE, null);
          this.setStatus(`${this.getBuddyName()} is listening — speak now`);
        }
      }
      if (
        this.talkStartPending &&
        (this.grabbing || this.talkReleasePending) &&
        getTime() >= this.talkStartDueAt
      ) {
        const epoch = this.talkCaptureEpoch;
        this.talkStartPending = false;
        if (epoch === this.talkCaptureEpoch) {
          // Start outside SIK's native trigger callback.
          print(`[CursorBuddy] ${this.getBuddyName()} deferred talk start`);
          this.beginGrabTalk();
        }
      }
      if (this.listening || this.talkFinalizationPending) {
        this.pumpPostItMicrophone();
      }
      if (
        this.talkReleasePending &&
        !this.grabbing &&
        getTime() >= this.talkReleaseDueAt
      ) {
        this.talkReleasePending = false;
        this.completeTalkRelease();
      }
      if (
        this.talkFinalizationPending &&
        getTime() >= this.talkFinalizationDueAt
      ) {
        this.finalizeTalkCapture(this.talkFinalizationEpoch);
      }
      if (!this.talkInteractionBound) {
        this.resolveGhost();
        this.bindTalkInteraction();
      }
      this.refreshListeningBubble();
    });
  }

  public cancelCurrentSession(): boolean {
    this.resolveDependencies();
    const sessionId = this.pollingSessionId;
    if (
      !this.sending ||
      !sessionId ||
      isNull(this.specsApi) ||
      isNull(this.deviceRegistry)
    ) {
      return false;
    }

    this.specsApi.cancelAgentSession(
      this.deviceRegistry.getDeviceId(),
      this.deviceRegistry.getDeviceSecret(),
      sessionId,
      (_session, error) => {
        if (this.destroyed || sessionId !== this.pollingSessionId) {
          return;
        }
        if (error) {
          this.finishError('', error);
          return;
        }
        this.sending = false;
        this.cancelStatusPolling();
        this.associatedGoalPlant = null;
        this.setPhase('error');
        this.showBubble('error', '', 'Session cancelled.');
        getSharedFlowGardenSpacePanel()?.showAgentCancelled(this.getBuddyName());
        this.setStatus(`${this.getBuddyName()} session cancelled`);
      }
    );
    return true;
  }

  public requestCodingTask(prompt: string): boolean {
    const cleaned = String(prompt || '').trim();
    if (!cleaned || this.listening || this.sending) {
      return false;
    }
    this.submitCodingTask(cleaned);
    return true;
  }

  onDestroy(): void {
    this.destroyed = true;
    this.talkCaptureEpoch++;
    this.cancelTalkStart();
    this.cancelTalkFinalization();
    if (!isNull(this.speechPrewarmEvent)) {
      this.speechPrewarmEvent.enabled = false;
      this.speechPrewarmEvent = null;
    }
    this.speechPrewarmPending = false;
    this.cancelStatusPolling();
    this.sending = false;
    this.removeTalkTranscriptListener();
    if (this.talkPostItCaptureOwned && !isNull(this.speechRecognition)) {
      try {
        this.speechRecognition.endPostItCapture();
      } catch (_error) {
        // The shared speech component may already be tearing down.
      }
      this.talkPostItCaptureOwned = false;
    }
    this.listening = false;
    this.grabbing = false;
    this.associatedGoalPlant = null;
    unregisterCodingBuddy(this.getProviderId(), this);
  }

  private resolveDependencies(): void {
    if (isNull(this.specsApi)) {
      const api = getSharedSpecsApi();
      if (api) {
        this.specsApi = api;
      }
    }
    if (isNull(this.deviceRegistry)) {
      const registry = getSharedSpecsDeviceRegistry();
      if (registry) {
        this.deviceRegistry = registry;
      }
    }
    if (isNull(this.speechRecognition)) {
      const speech = getSharedSpeechRecognition();
      if (speech) {
        this.speechRecognition = speech;
      }
    }
    if (isNull(this.agentTts)) {
      const tts = getSharedFlowGardenTts();
      if (tts) {
        this.agentTts = tts;
      }
    }

    if (this.debugLogging && !this.dependenciesLogged) {
      this.dependenciesLogged = true;
      print(
        `[CursorBuddy] resolved speech=${!isNull(this.speechRecognition)} ` +
          `api=${!isNull(this.specsApi)} registry=${!isNull(this.deviceRegistry)}`
      );
    }
  }

  private resolveGhost(): void {
    if (!isNull(this.ghostBlob)) {
      this.ghost = this.ghostBlob;
      return;
    }

    const localGhost = this.getSceneObject().getComponent(
      ArvisGhostBlob.getTypeName()
    ) as ArvisGhostBlob;
    if (!isNull(localGhost)) {
      this.ghostBlob = localGhost;
      this.ghost = localGhost;
    }
  }

  private scheduleSpeechPrewarm(): void {
    if (!isNull(this.speechPrewarmEvent)) {
      return;
    }

    const prewarm = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
    prewarm.bind(() => {
      this.speechPrewarmEvent = null;
      this.prewarmSpeech();
    });
    this.speechPrewarmEvent = prewarm;
    prewarm.reset(CursorBuddy.SPEECH_PREWARM_DELAY_SEC);
  }

  private prewarmSpeech(): void {
    this.resolveDependencies();
    if (isNull(this.speechRecognition)) {
      this.scheduleSpeechPrewarm();
      return;
    }
    this.speechRecognition.prewarmListening();
  }

  private bindTalkInteraction(): void {
    if (this.talkInteractionBound) {
      return;
    }

    const root = this.getSceneObject();
    const interactable = root.getComponent(
      Interactable.getTypeName()
    ) as unknown as InteractableLike;

    if (isNull(interactable)) {
      return;
    }

    const onTalkStart = (): void => this.onTalkStart();
    const onTalkEnd = (): void => this.onTalkEnd();
    const onHoverEnter = (): void => {
      // Defer the native microphone request out of SIK's hover callback.
      this.speechPrewarmPending = true;
    };
    if (interactable.onHoverEnter) {
      interactable.onHoverEnter.add(onHoverEnter);
    }
    if (interactable.onInteractorHoverEnter) {
      interactable.onInteractorHoverEnter.add(onHoverEnter);
    }
    // Match MainPostItSource: bind every start event. SIK manipulator often
    // fires TriggerEnd then DragStart while the pinch is still down.
    const startEvents = [
      interactable.onInteractorTriggerStart,
      interactable.onTriggerStart,
      interactable.onDragStart,
    ];
    let hasStart = false;
    for (let i = 0; i < startEvents.length; i++) {
      const startEvent = startEvents[i];
      if (startEvent) {
        startEvent.add(onTalkStart);
        hasStart = true;
      }
    }

    // Match the Post-it capture pattern: choose one start source, but accept
    // every possible end/cancel signal so a release outside the target cannot
    // leave the microphone session open.
    const endEvents = [
      interactable.onInteractorTriggerEnd,
      interactable.onInteractorTriggerEndOutside,
      interactable.onTriggerEnd,
      interactable.onTriggerEndOutside,
      interactable.onDragEnd,
      interactable.onTriggerCanceled,
      interactable.onInteractorTriggerCanceled,
    ];
    let hasEnd = false;
    for (let i = 0; i < endEvents.length; i++) {
      const event = endEvents[i];
      if (event) {
        event.add(onTalkEnd);
        hasEnd = true;
      }
    }

    if (!hasStart || !hasEnd) {
      if (this.debugLogging) {
        print(`[CursorBuddy] ${this.getBuddyName()} talk events unavailable`);
      }
      return;
    }

    this.talkInteractionBound = true;
    if (this.debugLogging) {
      print(`[CursorBuddy] ${this.getBuddyName()} talk interaction wired`);
    }
  }

  private onTalkStart(): void {
    this.talkReleasePending = false;
    if (this.talkFinalizationPending) {
      this.cancelTalkFinalization();
      this.grabbing = true;
      print(`[CursorBuddy] ${this.getBuddyName()} talk resume`);
      if (!this.listening) {
        this.scheduleTalkStart();
      }
      return;
    }
    if (this.listening) {
      this.grabbing = true;
      return;
    }
    if (this.grabbing) {
      return;
    }
    this.grabbing = true;
    print(`[CursorBuddy] ${this.getBuddyName()} talk start`);

    if (this.sending) {
      this.talkBusyFeedbackPending = true;
      return;
    }

    // Clear any stale global-voice utterance before the deferred capture
    // starts, but never disturb another active owner of the shared microphone.
    if (
      !isNull(this.speechRecognition) &&
      !this.speechRecognition.isAgentSessionActive() &&
      !this.speechRecognition.isPostItCaptureActive()
    ) {
      this.speechRecognition.clearUtteranceState();
    }
    this.scheduleTalkStart();
  }

  private onTalkEnd(): void {
    if (!this.grabbing) {
      return;
    }
    this.grabbing = false;
    this.talkBusyFeedbackPending = false;
    // SIK fires TriggerEnd when InteractableManipulation promotes a pinch to
    // a drag. Wait a beat for DragStart before treating this as a real release.
    this.talkReleasePending = true;
    this.talkReleaseDueAt = getTime() + CursorBuddy.TALK_RELEASE_GRACE_SEC;
  }

  private completeTalkRelease(): void {
    if (this.grabbing) {
      return;
    }
    print(`[CursorBuddy] ${this.getBuddyName()} talk end`);

    if (this.sending || !this.listening) {
      if (!this.listening) {
        this.talkCaptureEpoch++;
        this.cancelTalkStart();
        this.speechReadyWaitStartedAt = -1;
      }
      return;
    }

    // Keep the Post-it capture owned after release — MainPostItSource leaves
    // the mic open for several seconds so ASR can start and flush the phrase.
    this.scheduleTalkFinalization();
  }

  private scheduleTalkStart(): void {
    if (!this.grabbing || this.talkStartPending) {
      return;
    }

    // Do not create events or start ASR from inside SIK's native trigger
    // callback. UpdateEvent consumes this flag after the native interaction
    // update has had time to complete.
    this.talkCaptureEpoch++;
    this.talkStartPending = true;
    this.talkStartDueAt = getTime() + CursorBuddy.TALK_START_DELAY_SEC;
  }

  private scheduleTalkFinalization(): void {
    if (this.talkFinalizationPending || !this.listening) {
      return;
    }

    this.talkFinalizationPending = true;
    this.talkFinalizationAttempts = 0;
    this.scheduleTalkFinalizationAttempt();
  }

  private scheduleTalkFinalizationAttempt(): void {
    if (!this.talkFinalizationPending || !this.listening) {
      return;
    }

    this.talkFinalizationEpoch = this.talkCaptureEpoch;
    this.talkFinalizationDueAt =
      getTime() + CursorBuddy.TALK_FINALIZE_DELAY_SEC;
  }

  private finalizeTalkCapture(epoch: number): void {
    if (
      epoch !== this.talkCaptureEpoch ||
      !this.talkFinalizationPending ||
      !this.listening
    ) {
      return;
    }

    this.resolveDependencies();
    if (isNull(this.speechRecognition)) {
      this.talkFinalizationPending = false;
      this.listening = false;
      this.finishError('', 'Speech recognition is unavailable.');
      return;
    }

    const liveTranscript = String(
      this.speechRecognition.getLiveTranscript() ||
        this.speechRecognition.getDisplayTranscript() ||
        ''
    ).trim();
    if (liveTranscript) {
      this.capturedTalkTranscript = liveTranscript;
    }
    const transcript = String(
      this.capturedTalkTranscript || liveTranscript
    ).trim();
    if (!transcript) {
      if (this.talkFinalizationAttempts < CursorBuddy.MAX_TALK_FINALIZATION_ATTEMPTS) {
        this.talkFinalizationAttempts++;
        this.scheduleTalkFinalizationAttempt();
        return;
      }
    } else if (
      transcript !== this.lastStableTranscript ||
      (!this.talkHeardFinal &&
        this.talkFinalizationAttempts < CursorBuddy.MAX_TALK_FINALIZATION_ATTEMPTS)
    ) {
      this.lastStableTranscript = transcript;
      this.talkFinalizationAttempts++;
      this.scheduleTalkFinalizationAttempt();
      return;
    }

    this.talkFinalizationPending = false;
    this.listening = false;
    this.removeTalkTranscriptListener();
    if (this.talkPostItCaptureOwned) {
      try {
        this.speechRecognition.endPostItCapture();
      } catch (error) {
        this.talkPostItCaptureOwned = false;
        this.speechRecognition.clearUtteranceState();
        this.finishError('', `Could not stop speech recognition: ${String(error)}`);
        return;
      }
      this.talkPostItCaptureOwned = false;
    }
    this.speechRecognition.clearUtteranceState();
    this.speechRecognition.markCommandHandled();
    this.speechRecognition.suppressVoiceCommandsFor(2.5);
    if (!transcript) {
      const retryMessage =
        `I did not catch a coding task. Hold ${this.getBuddyName()} and try again.`;
      this.showBubble('error', '', retryMessage);
      this.setPhase('error');
      this.speak(retryMessage);
      return;
    }

    this.submitCodingTask(transcript);
  }

  private beginGrabTalk(): void {
    // SIK often fires TriggerEnd before this deferred start runs. Still open
    // the mic and keep the post-release capture window.
    if (!this.grabbing && !this.talkReleasePending && !this.talkFinalizationPending) {
      return;
    }
    this.resolveDependencies();
    if (!isNull(this.agentTts) && this.agentTts.isAudioPlaying()) {
      // A held buddy is an explicit request to speak. Interrupt onboarding
      // or reply audio, release the native audio channel, and retry once from
      // UpdateEvent so ASR never starts beside active TTS.
      this.agentTts.interruptForInteraction();
      this.talkStartPending = true;
      this.talkStartDueAt = getTime() + 0.15;
      return;
    }
    if (isNull(this.speechRecognition)) {
      this.grabbing = false;
      this.finishError('', 'Speech recognition is unavailable.');
      return;
    }

    this.speechReadyWaitStartedAt = -1;
    if (
      this.speechRecognition.isAgentSessionActive() ||
      this.speechRecognition.isPostItCaptureActive()
    ) {
      this.showBubble(
        'error',
        '',
        `Another voice session is active. Finish it, then hold ${this.getBuddyName()}.`
      );
      this.setPhase('error');
      this.grabbing = false;
      return;
    }
    try {
      this.cancelTalkFinalization();
      this.listening = true;
      this.capturedTalkTranscript = '';
      this.lastStableTranscript = '';
      this.talkHeardFinal = false;
      this.micOpenLogged = false;
      this.lastListeningTranscript = CursorBuddy.LISTENING_CUE;
      print(
        `[CursorBuddy] ${this.getBuddyName()} starting post-it speech capture`
      );
      this.speechRecognition.addTranscriptListener(this.onTalkTranscript);
      this.talkListenerAttached = true;
      // Same as PostItNoteTranscript: claim the capture slot here, then let
      // UpdateEvent open the microphone with requestListening().
      this.speechRecognition.beginPostItCapture(false);
      this.talkPostItCaptureOwned = true;
      this.speechRecognition.clearUtteranceState();
      this.pumpPostItMicrophone();
      print(`[CursorBuddy] ${this.getBuddyName()} speech capture started`);
      this.talkUiPending = true;
      this.talkUiDueAt = getTime() + CursorBuddy.TALK_START_DELAY_SEC;
      if (!this.grabbing) {
        this.scheduleTalkFinalization();
      }
    } catch (error) {
      this.removeTalkTranscriptListener();
      if (this.talkPostItCaptureOwned) {
        this.speechRecognition.endPostItCapture();
        this.talkPostItCaptureOwned = false;
      }
      this.talkUiPending = false;
      this.talkUiDueAt = 0;
      this.listening = false;
      this.grabbing = false;
      this.finishError('', `Could not start speech recognition: ${String(error)}`);
    }
  }

  private readonly onTalkTranscript = (
    text: string,
    isFinal: boolean
  ): void => {
    if (!this.listening && !this.talkFinalizationPending) {
      return;
    }
    const cleaned = String(text || '').trim();
    if (!cleaned) {
      return;
    }
    // Keep the raw display transcript. SpeechRecognition intentionally
    // filters long non-wake final phrases for global commands, but a held
    // coding buddy must submit the exact phrase the user spoke.
    this.capturedTalkTranscript = cleaned;
    if (isFinal) {
      this.talkHeardFinal = true;
    }
  };

  private pumpPostItMicrophone(): void {
    this.resolveDependencies();
    if (isNull(this.speechRecognition)) {
      return;
    }
    if (!this.speechRecognition.isMicrophoneListening()) {
      this.speechRecognition.pumpListening();
      return;
    }
    if (!this.micOpenLogged) {
      this.micOpenLogged = true;
      print(`[CursorBuddy] ${this.getBuddyName()} microphone open`);
    }
    const live = String(
      this.speechRecognition.getDisplayTranscript() ||
        this.speechRecognition.getLiveTranscript() ||
        ''
    ).trim();
    if (live) {
      this.capturedTalkTranscript = live;
    }
  }

  private removeTalkTranscriptListener(): void {
    if (!this.talkListenerAttached || isNull(this.speechRecognition)) {
      this.talkListenerAttached = false;
      return;
    }
    this.speechRecognition.removeTranscriptListener(this.onTalkTranscript);
    this.talkListenerAttached = false;
  }

  private refreshListeningBubble(): void {
    if (
      !this.listening ||
      this.talkUiPending ||
      isNull(this.speechRecognition)
    ) {
      return;
    }

    const display = String(
      this.capturedTalkTranscript ||
        this.speechRecognition.getDisplayTranscript() ||
        CursorBuddy.LISTENING_CUE
    ).trim();
    if (!display || display === this.lastListeningTranscript) {
      return;
    }

    this.lastListeningTranscript = display;
    this.showBubble('listening', display, null);
  }

  private submitCodingTask(prompt: string): void {
    this.resolveDependencies();
    if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      this.finishError(prompt, 'Missing Specs API or device pairing.');
      return;
    }

    this.associatedGoalPlant = PlantLifecycle.findCodingGoalForAgent(prompt);
    if (this.debugLogging) {
      print(
        `[CursorBuddy] ${this.getBuddyName()} coding goal ` +
          `${isNull(this.associatedGoalPlant) ? 'not matched' : 'associated'}`
      );
    }
    this.sending = true;
    this.showBubble('thinking', prompt, `Sending this task to ${this.getBuddyName()} on your Mac…`);
    getSharedFlowGardenSpacePanel()?.showAgentStatus(
      this.getBuddyName(),
      'starting',
      'Validating the selected repository and model.'
    );
    this.setPhase('thinking');
    this.setStatus(`Sending coding task to ${this.getBuddyName()}…`);

    this.queueAfterPair(prompt);
  }

  private queueAfterPair(prompt: string): void {
    if (!this.sending || isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      return;
    }

    const isDemo = this.specsApi.isEditorMockActive();
    const deviceSecret = this.deviceRegistry.getDeviceSecret();
    if (!isDemo && !deviceSecret) {
      this.finishError(
        prompt,
        `Pair this device at arvis.space/specs before using ${this.getBuddyName()}.`
      );
      return;
    }

    const requestId =
      `specs-${this.getProviderId()}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const selection = AgentCenterStateStore.get(this.getProviderId());
    const workspace =
      String(this.workspaceId || '').trim() ||
      selection.workspaceId ||
      (isDemo ? 'demo-workspace' : '');
    if (!workspace) {
      this.finishError(
        prompt,
        `Choose an approved repository for ${this.getBuddyName()} in Agent Center first.`
      );
      return;
    }
    const configuredModel = String(this.agentModel || '').trim();
    const model =
      configuredModel && configuredModel !== 'auto'
        ? configuredModel
        : selection.modelId || configuredModel || 'auto';
    this.specsApi.startAgentSession(
      this.deviceRegistry.getDeviceId(),
      deviceSecret,
      requestId,
      this.getProviderId(),
      workspace,
      prompt,
      model,
      (result, error) => {
        if (this.destroyed || !this.sending) {
          return;
        }
        if (!result) {
          this.finishError(prompt, error || 'Could not reach the Arvis Mac bridge.');
          return;
        }

        this.pollingSessionId = result.sessionId;
        this.pollingAttempts = 0;
        this.showBubble(
          'thinking',
          prompt,
          isDemo
            ? 'Demo/Preview simulation running — no files will change.'
            : 'Waiting for your approval on the Mac panel…'
        );
        this.setStatus(
          isDemo
            ? `${this.getBuddyName()} Demo/Preview session`
            : `Waiting for ${this.getBuddyName()} approval on your Mac…`
        );
        getSharedFlowGardenSpacePanel()?.showAgentProgress(
          this.getBuddyName(),
          isDemo
            ? 'Demo/Preview simulation — no files will change.'
            : 'Session received. Waiting for approval on the Mac bridge.',
          0,
          0
        );
        this.pollBridgeStatus(prompt);
      }
    );
  }

  private pollBridgeStatus(prompt: string): void {
    if (
      !this.sending ||
      !this.pollingSessionId ||
      isNull(this.specsApi) ||
      isNull(this.deviceRegistry)
    ) {
      return;
    }

    if (this.pollingAttempts >= CursorBuddy.MAX_STATUS_POLLS) {
      this.finishError(prompt, 'Cursor task timed out while waiting for the Mac bridge.');
      return;
    }

    this.pollingAttempts++;
    const sessionId = this.pollingSessionId;
    this.specsApi.fetchAgentSessionStatus(
      this.deviceRegistry.getDeviceId(),
      this.deviceRegistry.getDeviceSecret(),
      sessionId,
      (status, error) => {
        if (
          this.destroyed ||
          !this.sending ||
          sessionId !== this.pollingSessionId
        ) {
          return;
        }

        if (!status) {
          if (this.debugLogging) {
            print(`[CursorBuddy] status poll failed: ${error || 'unknown error'}`);
          }
          this.scheduleStatusPoll(prompt);
          return;
        }

        const normalizedStatus = String(status.status || '').trim().toLowerCase();
        if (this.isSuccessStatus(normalizedStatus)) {
          const message =
            String(status.result || '').trim() ||
            `${this.getBuddyName()} finished without a response.`;
          this.finishSuccess(prompt, message);
          return;
        }
        if (this.isFailureStatus(normalizedStatus)) {
          const message =
            String(status.result || '').trim() ||
            `${this.getBuddyName()} ended with status: ${normalizedStatus || 'failed'}.`;
          this.finishError(prompt, message);
          return;
        }

        const progress = String(status.progress || '').trim();
        if (progress) {
          this.showBubble('thinking', prompt, progress);
          getSharedFlowGardenSpacePanel()?.showAgentProgress(
            this.getBuddyName(),
            progress,
            0,
            0
          );
        } else if (normalizedStatus === 'claimed' || normalizedStatus === 'awaiting_approval') {
          this.showBubble(
            'thinking',
            prompt,
            `${this.getBuddyName()} request received — approve it in the Mac panel…`
          );
        } else if (normalizedStatus === 'approved') {
          this.showBubble(
            'thinking',
            prompt,
            'Approved. Preparing the workspace on your Mac…'
          );
        } else {
          this.showBubble(
            'thinking',
            prompt,
            'Waiting for the Mac bridge…'
          );
        }
        this.scheduleStatusPoll(prompt);
      }
    );
  }

  private scheduleStatusPoll(prompt: string): void {
    if (!this.sending) {
      return;
    }
    const previousEvent = this.pollEvent;
    if (previousEvent) {
      previousEvent.enabled = false;
      this.pollEvent = null;
    }
    const pollEvent = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
    pollEvent.bind(() => {
      this.pollEvent = null;
      this.pollBridgeStatus(prompt);
    });
    this.pollEvent = pollEvent;
    pollEvent.reset(CursorBuddy.POLL_INTERVAL_SEC);
  }

  private cancelStatusPolling(): void {
    const pollEvent = this.pollEvent;
    if (pollEvent) {
      pollEvent.enabled = false;
      this.pollEvent = null;
    }
    this.pollingSessionId = '';
    this.pollingAttempts = 0;
  }

  private cancelTalkFinalization(): void {
    this.talkFinalizationPending = false;
    this.talkFinalizationAttempts = 0;
    this.talkFinalizationDueAt = 0;
    this.talkFinalizationEpoch = 0;
  }

  private cancelTalkStart(): void {
    this.talkStartPending = false;
    this.talkStartDueAt = 0;
    this.talkReleasePending = false;
    this.talkReleaseDueAt = 0;
  }

  private isSuccessStatus(status: string): boolean {
    return status === 'completed' || status === 'opened';
  }

  private isFailureStatus(status: string): boolean {
    return (
      status === 'failed' ||
      status === 'declined' ||
      status === 'expired' ||
      status === 'cancelled' ||
      status === 'canceled'
    );
  }

  private finishSuccess(prompt: string, response: string): void {
    const completedGoal = PlantLifecycle.completeCodingGoalForAgent(
      prompt,
      this.associatedGoalPlant
    );
    this.associatedGoalPlant = null;
    this.sending = false;
    this.cancelStatusPolling();
    this.setPhase('reply');
    this.showBubble('reply', prompt, response);
    getSharedFlowGardenSpacePanel()?.showAgentFinal(
      this.getBuddyName(),
      response
    );
    this.setStatus(`${this.getBuddyName()} finished the coding request`);
    if (completedGoal !== null) {
      this.setStatus(
        `${this.getBuddyName()} completed the goal plant: ${completedGoal.getGoalText()}`
      );
    }
    this.speak(response);
  }

  private finishError(prompt: string, response: string): void {
    this.associatedGoalPlant = null;
    this.sending = false;
    this.cancelStatusPolling();
    this.setPhase('error');
    this.showBubble('error', prompt, response);
    getSharedFlowGardenSpacePanel()?.showAgentError(
      this.getBuddyName(),
      response
    );
    this.setStatus(response);
    this.speak(response);
  }

  private showBubble(
    phase: 'listening' | 'thinking' | 'reply' | 'error',
    transcript: string,
    response: string | null
  ): void {
    this.resolveGhost();
    const ghost = this.ghost;
    if (!ghost) {
      return;
    }
    ghost.showSpeechBubble(phase, transcript, response, this.getBuddyName());
  }

  private setPhase(phase: 'idle' | 'listening' | 'thinking' | 'reply' | 'error'): void {
    this.resolveGhost();
    const ghost = this.ghost;
    if (ghost) {
      ghost.setPhase(phase);
    }
  }

  private speak(text: string): void {
    const tts = this.agentTts;
    if (!this.enableSpeechOutput || !tts) {
      return;
    }
    const spoken = String(text || '').trim().slice(0, 260);
    if (spoken) {
      tts.speak(spoken);
    }
  }

  private setStatus(text: string): void {
    if (this.debugLogging && text) {
      print(`[CodingBuddy:${this.getProviderId()}] ${text}`);
    }
  }

  private getProviderId(): string {
    const normalized = String(this.providerId || '').trim().toLowerCase();
    return normalized === 'claude_code' ? 'claude_code' : 'cursor_sdk';
  }

  private getBuddyName(): string {
    const providerName = this.getProviderId() === 'claude_code' ? 'Claude' : 'Cursor';
    const configured = String(this.buddyName || '').trim();
    const normalized = configured.toLowerCase();
    if (
      !configured ||
      normalized === 'cursor' ||
      normalized === 'claude' ||
      normalized === 'claude code'
    ) {
      // Provider identity wins over stale duplicated-scene input values.
      return providerName;
    }
    return configured;
  }
}

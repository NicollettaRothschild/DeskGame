import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import { InteractableManipulation } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation';
import {
  getSharedFlowGardenSpacePanel,
  getSharedFlowGardenTts,
  getSharedSpecsApi,
  getSharedSpecsDeviceRegistry,
  getSharedSpeechRecognition,
  registerCodingBuddy,
} from './FlowGardenServiceRegistry';
import { ArvisGhostBlob } from './ArvisGhostBlob';
import { SpecsApiClient } from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';
import { SpeechRecognition } from './SpeechRecognition';
import { FlowGardenTTS } from './FlowGardenTTS';
import { AgentCenterStateStore } from './AgentCenterStateStore';

type InteractableLike = ScriptComponent & {
  targetingMode?: number;
  onDragStart?: { add: (cb: () => void) => void };
  onDragEnd?: { add: (cb: () => void) => void };
  onTriggerStart?: { add: (cb: () => void) => void };
  onTriggerEnd?: { add: (cb: () => void) => void };
  onTriggerCanceled?: { add: (cb: () => void) => void };
  onInteractorTriggerStart?: { add: (cb: () => void) => void };
  onInteractorTriggerEnd?: { add: (cb: () => void) => void };
  onInteractorTriggerCanceled?: { add: (cb: () => void) => void };
};

type InteractableManipulationLike = ScriptComponent & {
  onManipulationStart?: { add: (cb: () => void) => void };
  onManipulationEnd?: { add: (cb: () => void) => void };
};

/**
 * Cursor's companion avatar.
 *
 * Holding the blue buddy opens a dedicated microphone session. Releasing it
 * submits the transcript to the paired Mac bridge, where the request waits for
 * explicit approval before the safe preparation step. Provider credentials
 * never enter the Lens runtime.
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
  private interactable: InteractableLike | null = null;
  private manipulation: InteractableManipulationLike | null = null;
  private grabInteractionBound = false;
  private grabbing = false;
  private listening = false;
  private sending = false;
  private dependenciesLogged = false;
  private lastListeningTranscript = '';
  private pollingSessionId = '';
  private pollingAttempts = 0;
  private pollEvent: DelayedCallbackEvent | null = null;

  private static readonly LISTENING_CUE = 'Listening…';
  private static readonly POLL_INTERVAL_SEC = 2;
  private static readonly MAX_STATUS_POLLS = 930;

  onAwake(): void {
    registerCodingBuddy(this.getProviderId(), this);
    this.createEvent('OnStartEvent').bind(() => {
      this.resolveDependencies();
      this.resolveGhost();
      this.bindGrabInteraction();
    });

    this.createEvent('UpdateEvent').bind(() => {
      if (!this.grabInteractionBound) {
        this.resolveGhost();
        this.bindGrabInteraction();
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
        if (sessionId !== this.pollingSessionId) {
          return;
        }
        if (error) {
          this.finishError('', error);
          return;
        }
        this.sending = false;
        this.cancelStatusPolling();
        this.setPhase('error');
        this.showBubble('error', '', 'Session cancelled.');
        getSharedFlowGardenSpacePanel()?.showAgentCancelled(this.getBuddyName());
        this.setStatus(`${this.getBuddyName()} session cancelled`);
      }
    );
    return true;
  }

  onDestroy(): void {
    this.cancelStatusPolling();
    if (this.listening && !isNull(this.speechRecognition)) {
      this.speechRecognition.cancelAgentSession();
    }
    this.listening = false;
    this.grabbing = false;
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

  private bindGrabInteraction(): void {
    if (this.grabInteractionBound) {
      return;
    }

    const root = this.getSceneObject();
    const interactable = root.getComponent(
      Interactable.getTypeName()
    ) as unknown as InteractableLike;
    const manipulation = root.getComponent(
      InteractableManipulation.getTypeName()
    ) as unknown as InteractableManipulationLike;

    if (isNull(interactable)) {
      return;
    }

    this.interactable = interactable;
    this.manipulation = isNull(manipulation) ? null : manipulation;

    let bound = false;
    const onGrabStart = (): void => this.onGrabStart();
    const onGrabEnd = (): void => this.onGrabEnd();

    if (!isNull(manipulation) && manipulation.onManipulationStart) {
      manipulation.onManipulationStart.add(onGrabStart);
      bound = true;
      if (manipulation.onManipulationEnd) {
        manipulation.onManipulationEnd.add(onGrabEnd);
      }
    } else {
      if (interactable.onTriggerStart) {
        interactable.onTriggerStart.add(onGrabStart);
        bound = true;
      }
      if (interactable.onTriggerEnd) {
        interactable.onTriggerEnd.add(onGrabEnd);
      }
      if (interactable.onTriggerCanceled) {
        interactable.onTriggerCanceled.add(onGrabEnd);
      }
    }

    this.grabInteractionBound = bound;
    if (this.debugLogging && bound) {
      print('[CursorBuddy] grab-to-code interaction wired');
    }
  }

  private onGrabStart(): void {
    if (this.grabbing) {
      return;
    }
    this.grabbing = true;

    if (this.sending) {
      this.showBubble('thinking', '', `${this.getBuddyName()} is still working on the last task.`);
      return;
    }

    this.beginGrabTalk();
  }

  private onGrabEnd(): void {
    if (!this.grabbing) {
      return;
    }
    this.grabbing = false;

    if (!this.listening) {
      return;
    }

    this.listening = false;
    this.resolveDependencies();
    if (isNull(this.speechRecognition)) {
      this.finishError('', 'Speech recognition is unavailable.');
      return;
    }

    const transcript = String(this.speechRecognition.endAgentSession() || '').trim();
    this.speechRecognition.clearUtteranceState();
    this.speechRecognition.markCommandHandled();
    this.speechRecognition.suppressVoiceCommandsFor(2.5);
    if (!transcript) {
      this.showBubble('error', '', 'I did not catch a coding task. Hold me and try again.');
      this.setPhase('error');
      this.speak('I did not catch a coding task. Hold me and try again.');
      return;
    }

    this.submitCodingTask(transcript);
  }

  private beginGrabTalk(): void {
    this.resolveDependencies();
    if (isNull(this.speechRecognition)) {
      this.finishError('', 'Speech recognition is unavailable.');
      return;
    }

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
      return;
    }

    this.listening = true;
    this.lastListeningTranscript = CursorBuddy.LISTENING_CUE;
    this.speechRecognition.clearUtteranceState();
    this.speechRecognition.beginAgentSession();
    this.setPhase('listening');
    this.showBubble('listening', CursorBuddy.LISTENING_CUE, null);
    this.setStatus(`${this.getBuddyName()} is listening — release to send`);
  }

  private refreshListeningBubble(): void {
    if (!this.listening || isNull(this.speechRecognition)) {
      return;
    }

    const display = String(
      this.speechRecognition.getDisplayTranscript() || CursorBuddy.LISTENING_CUE
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
        if (!this.sending) {
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
        if (!this.sending || sessionId !== this.pollingSessionId) {
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
    this.sending = false;
    this.cancelStatusPolling();
    this.setPhase('reply');
    this.showBubble('reply', prompt, response);
    getSharedFlowGardenSpacePanel()?.showAgentFinal(
      this.getBuddyName(),
      response
    );
    this.setStatus(`${this.getBuddyName()} finished the coding request`);
    this.speak(response);
  }

  private finishError(prompt: string, response: string): void {
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
    const configured = String(this.buddyName || '').trim();
    if (configured) {
      return configured;
    }
    return this.getProviderId() === 'claude_code' ? 'Claude' : 'Cursor';
  }
}

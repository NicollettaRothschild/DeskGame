import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import { InteractableManipulation } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation';
import {
  getSharedFlowGardenTts,
  getSharedSpecsApi,
  getSharedSpecsDeviceRegistry,
  getSharedSpeechRecognition,
} from './FlowGardenServiceRegistry';
import { ArvisGhostBlob } from './ArvisGhostBlob';
import { SpecsApiClient } from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';
import { SpeechRecognition } from './SpeechRecognition';
import { FlowGardenTTS } from './FlowGardenTTS';

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
  @label('Cursor Workspace')
  @hint('Mac folder that Cursor SDK is allowed to edit.')
  cursorWorkspacePath: string = '/Users/allanyde/Documents/GitHub/DeskGame';

  @input
  @label('Cursor Model')
  cursorModel: string = 'auto';

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
  private pollingCommandId = '';
  private pollingAttempts = 0;
  private pollEvent: DelayedCallbackEvent | null = null;

  private static readonly AGENT_NAME = 'Cursor';
  private static readonly BRIDGE_AGENT = 'cursor_sdk';
  private static readonly LISTENING_CUE = 'Listening…';
  private static readonly POLL_INTERVAL_SEC = 2;
  private static readonly MAX_STATUS_POLLS = 930;

  onAwake(): void {
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

    // Cursor is hold-to-talk, so use pinch/ray targeting and avoid the
    // Poke + InteractableManipulation combination that SIK rejects.
    interactable.targetingMode = 3;

    let bound = false;
    const onGrabStart = (): void => this.onGrabStart();
    const onGrabEnd = (): void => this.onGrabEnd();

    if (!isNull(manipulation) && manipulation.onManipulationStart) {
      manipulation.onManipulationStart.add(onGrabStart);
      bound = true;
    }
    if (!isNull(manipulation) && manipulation.onManipulationEnd) {
      manipulation.onManipulationEnd.add(onGrabEnd);
      bound = true;
    }

    if (interactable.onDragStart) {
      interactable.onDragStart.add(onGrabStart);
      bound = true;
    }
    if (interactable.onDragEnd) {
      interactable.onDragEnd.add(onGrabEnd);
      bound = true;
    }
    if (interactable.onTriggerStart) {
      interactable.onTriggerStart.add(onGrabStart);
      bound = true;
    }
    if (interactable.onTriggerEnd) {
      interactable.onTriggerEnd.add(onGrabEnd);
      bound = true;
    }
    if (interactable.onTriggerCanceled) {
      interactable.onTriggerCanceled.add(onGrabEnd);
      bound = true;
    }
    if (interactable.onInteractorTriggerStart) {
      interactable.onInteractorTriggerStart.add(onGrabStart);
      bound = true;
    }
    if (interactable.onInteractorTriggerEnd) {
      interactable.onInteractorTriggerEnd.add(onGrabEnd);
      bound = true;
    }
    if (interactable.onInteractorTriggerCanceled) {
      interactable.onInteractorTriggerCanceled.add(onGrabEnd);
      bound = true;
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
      this.showBubble('thinking', '', 'Cursor is still working on the last task.');
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
        'Another voice session is active. Finish it, then hold Cursor.'
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
    this.setStatus('Cursor is listening — release to send');
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
    this.showBubble('thinking', prompt, 'Sending this task to Cursor on your Mac…');
    this.setPhase('thinking');
    this.setStatus('Sending coding task to Cursor SDK…');

    // The editor mock intentionally does not execute local code. This prevents
    // a successful-looking Preview interaction from claiming that files changed.
    if (this.specsApi.isEditorMockActive()) {
      this.finishError(
        prompt,
        'Preview cannot change Mac files. Set the device type to Spectacles and pair the Mac bridge.'
      );
      return;
    }

    this.queueAfterPair(prompt);
  }

  private queueAfterPair(prompt: string): void {
    if (!this.sending || isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      return;
    }

    const deviceSecret = this.deviceRegistry.getDeviceSecret();
    if (!deviceSecret) {
      this.finishError(prompt, 'Pair this device at arvis.space/specs before using Cursor.');
      return;
    }

    const requestId =
      `specs-cursor-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const workspace = String(this.cursorWorkspacePath || '').trim();
    const model = String(this.cursorModel || '').trim();
    this.specsApi.queueCodingTask(
      this.deviceRegistry.getDeviceId(),
      deviceSecret,
      requestId,
      CursorBuddy.BRIDGE_AGENT,
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

        this.pollingCommandId = result.commandId;
        this.pollingAttempts = 0;
        this.showBubble(
          'thinking',
          prompt,
          'Waiting for your approval on the Mac panel…'
        );
        this.setStatus('Waiting for Cursor approval on your Mac…');
        this.pollBridgeStatus(prompt);
      }
    );
  }

  private pollBridgeStatus(prompt: string): void {
    if (
      !this.sending ||
      !this.pollingCommandId ||
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
    const commandId = this.pollingCommandId;
    this.specsApi.fetchBridgeCommandStatus(
      this.deviceRegistry.getDeviceId(),
      this.deviceRegistry.getDeviceSecret(),
      commandId,
      (status, error) => {
        if (!this.sending || commandId !== this.pollingCommandId) {
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
          const message = this.formatBridgeResult(
            status.result,
            'The Cursor workspace is ready for manual work.'
          );
          this.finishSuccess(prompt, message);
          return;
        }
        if (this.isFailureStatus(normalizedStatus)) {
          const message = this.formatBridgeResult(
            status.result,
            `Cursor ended with status: ${normalizedStatus || 'failed'}.`
          );
          this.finishError(prompt, message);
          return;
        }

        if (normalizedStatus === 'claimed') {
          this.showBubble(
            'thinking',
            prompt,
            'Cursor request received — approve it in the Mac panel…'
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
    this.pollingCommandId = '';
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

  private formatBridgeResult(result: Record<string, unknown>, fallback: string): string {
    const message = String(result?.message || '').trim();
    if (message) {
      return message;
    }

    const output = String(result?.output || '').trim();
    if (output) {
      return output.slice(0, 220);
    }
    return fallback;
  }

  private finishSuccess(prompt: string, response: string): void {
    this.sending = false;
    this.cancelStatusPolling();
    this.setPhase('reply');
    this.showBubble('reply', prompt, response);
    this.setStatus('Cursor prepared programming work on your Mac');
    this.speak(response);
  }

  private finishError(prompt: string, response: string): void {
    this.sending = false;
    this.cancelStatusPolling();
    this.setPhase('error');
    this.showBubble('error', prompt, response);
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
    ghost.showSpeechBubble(phase, transcript, response, CursorBuddy.AGENT_NAME);
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
      print(`[CursorBuddy] ${text}`);
    }
  }
}

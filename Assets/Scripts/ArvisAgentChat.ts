import {
  getSharedFlowGardenSpacePanel,
  getSharedFlowGardenTts,
  getSharedSpecsApi,
  getSharedSpecsDeviceRegistry,
  getSharedSpeechRecognition,
  registerArvisAgentChat,
} from './FlowGardenServiceRegistry';
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
    phase: 'listening' | 'thinking' | 'reply' | 'error'
  ) => void;
  isAgentViewActive?: () => boolean;
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
  agentName: string = 'Stephany';

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
  private interactableBound = false;
  private dependenciesLogged = false;

  onAwake(): void {
    registerArvisAgentChat(this);
    this.setStatus('Tap or pinch UserID to talk to ' + this.agentName);
    this.createEvent('OnStartEvent').bind(() => {
      this.resolveDependencies();
      this.bindTalkInteractable();
    });
    this.createEvent('UpdateEvent').bind(() => this.refreshListeningBoard());
    this.createEvent('TapEvent').bind(() => this.toggleAgentTalk());
  }

  private refreshListeningBoard(): void {
    if (!this.listening || this.transcriptOnlyMode || isNull(this.speechRecognition)) {
      return;
    }

    const live = this.speechRecognition.getLiveTranscript();
    this.updateBoard('listening', live, null);
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
    this.sendMessage(trimmed);
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

    this.listening = true;
    this.speechRecognition.beginAgentSession();
    if (this.transcriptOnlyMode) {
      this.setStatus('Speak — tap again when done');
      return;
    }

    this.updateBoard('listening', '', null);
    this.setStatus('Speak to ' + this.agentName + ' (editor uses arvis mock)');
  }

  public endAgentTalkAndSend(): void {
    if (!this.listening || isNull(this.speechRecognition)) {
      return;
    }

    this.listening = false;
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

    this.sendMessage(transcript);
  }

  public cancelAgentTalk(): void {
    this.listening = false;
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

  private sendMessage(message: string): void {
    if (this.sending) {
      return;
    }

    const trimmed = String(message || '').trim();
    if (!trimmed) {
      return;
    }

    this.resolveDependencies();
    if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      this.updateBoard('error', trimmed, 'Missing Specs API wiring');
      return;
    }

    if (!this.deviceRegistry.isPaired() && !this.specsApi.isEditorMockActive()) {
      this.updateBoard('error', trimmed, 'Pair at arvis.space/specs first');
      this.setStatus('Device not paired');
      return;
    }

    this.sending = true;
    this.updateBoard('thinking', trimmed, null);
    this.setStatus('Thinking…');

    const payloadHistory = this.history.map((entry) => ({
      role: entry.role,
      text: entry.text,
    }));

    this.specsApi.chatWithAgent(
      this.deviceRegistry.getDeviceId(),
      this.deviceRegistry.getDeviceSecret(),
      trimmed,
      this.agentName,
      payloadHistory,
      (result, error) => {
        this.sending = false;
        if (!result) {
          this.updateBoard('error', trimmed, error || 'unknown');
          this.setStatus('');
          return;
        }

        this.pushHistory('user', trimmed);
        this.pushHistory('assistant', result.response);
        const label = result.agentName || this.agentName;
        this.updateBoard('reply', trimmed, result.response, label);
        this.setStatus('');
        if (this.debugLogging) {
          print(`[ArvisAgentChat] ${label}: ${result.response}`);
        }
        this.speakAgentResponse(result.response, label);
      }
    );
  }

  private updateBoard(
    phase: 'listening' | 'thinking' | 'reply' | 'error',
    transcript: string,
    response: string | null,
    agentName?: string
  ): void {
    const label = agentName || this.agentName;
    const panel = this.getSpacePanel();
    if (!isNull(panel) && typeof panel.showAgentChat === 'function') {
      panel.showAgentChat(transcript, response, label, phase);
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
    if (!this.enableSpeechOutput || isNull(this.agentTts)) {
      return;
    }

    const spoken = String(response || '').trim();
    if (!spoken) {
      return;
    }

    this.setStatus(`${label} speaking…`);
    this.agentTts.speak(spoken, (ok) => {
      this.setStatus(ok ? '' : 'Speech unavailable');
      if (this.debugLogging) {
        print(`[ArvisAgentChat] TTS ${ok ? 'played' : 'failed'}`);
      }
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

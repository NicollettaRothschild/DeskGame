import { SpecsApiClient } from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';
import { SpeechRecognition } from './SpeechRecognition';
import { FlowGardenTTS } from './FlowGardenTTS';

type AgentHistoryEntry = {
  role: 'user' | 'assistant';
  text: string;
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
  useHoldToTalk: boolean = true;

  @input
  maxHistoryTurns: number = 8;

  @input
  debugLogging: boolean = true;

  private history: AgentHistoryEntry[] = [];
  private listening = false;
  private sending = false;
  private interactableBound = false;

  onAwake(): void {
    this.setDisplay('Hold pinch on Text3D UserID to talk to ' + this.agentName);
    this.createEvent('OnStartEvent').bind(() => this.bindTalkInteractable());

    if (isNull(this.talkInteractable)) {
      this.createEvent('TapEvent').bind(() => this.toggleAgentTalk());
    }
  }

  public beginAgentTalk(): void {
    if (this.listening || this.sending) {
      return;
    }
    if (isNull(this.speechRecognition)) {
      this.setStatus('Speech recognition not wired');
      return;
    }

    this.listening = true;
    this.speechRecognition.beginAgentSession();
    this.setDisplay('Listening…');
    this.setStatus('Speak to ' + this.agentName);
  }

  public endAgentTalkAndSend(): void {
    if (!this.listening || isNull(this.speechRecognition)) {
      return;
    }

    this.listening = false;
    const transcript = this.speechRecognition.endAgentSession();
    if (!transcript) {
      this.setDisplay('Did not catch that. Try again.');
      this.setStatus('No speech detected');
      return;
    }

    this.sendMessage(transcript);
  }

  public cancelAgentTalk(): void {
    this.listening = false;
    if (!isNull(this.speechRecognition)) {
      this.speechRecognition.cancelAgentSession();
    }
    this.setDisplay('Cancelled');
    this.setStatus('');
  }

  public toggleAgentTalk(): void {
    if (this.listening) {
      this.endAgentTalkAndSend();
      return;
    }
    this.beginAgentTalk();
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
        print('[ArvisAgentChat] talkInteractable has no trigger events — use beginAgentTalk/endAgentTalkAndSend from a button');
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

    if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      this.setDisplay('Missing Specs API wiring');
      return;
    }

    if (!this.deviceRegistry.isPaired() && !this.specsApi.isEditorMockActive()) {
      this.setDisplay('Pair at arvis.space/specs first');
      this.setStatus('Device not paired');
      return;
    }

    this.sending = true;
    this.setDisplay('You: ' + trimmed + '\n\n…');
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
          this.setDisplay('Agent error: ' + (error || 'unknown'));
          this.setStatus('');
          return;
        }

        this.pushHistory('user', trimmed);
        this.pushHistory('assistant', result.response);
        const label = result.agentName || this.agentName;
        this.setDisplay(`${label}:\n${result.response}`);
        this.setStatus('');
        if (this.debugLogging) {
          print(`[ArvisAgentChat] ${label}: ${result.response}`);
        }
        this.speakAgentResponse(result.response, label);
      }
    );
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

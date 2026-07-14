import {
  getSharedFlowGardenSpacePanel,
  registerSpeechRecognition,
} from './FlowGardenServiceRegistry';

/**
 * VoiceML speech recognition — adapted from Voice Arena Lens.
 * Listens continuously and exposes the latest final transcript for other scripts.
 */

type VoiceMLListeningOptions = {
  speechRecognizer: unknown;
  languageCode: string;
  shouldReturnAsrTranscription: boolean;
  shouldReturnInterimAsrTranscription: boolean;
  addSpeechContext(phrases: string[], boost: number): void;
};

type VoiceMLListeningUpdateEventArgs = {
  transcription: string;
  isFinalTranscription: boolean;
};

type VoiceMLErrorEventArgs = {
  error: string;
  description: string;
};

type VoiceMLModuleLike = {
  startListening(options: VoiceMLListeningOptions): void;
  stopListening(): void;
  onListeningEnabled: { add(handler: () => void): void };
  onListeningDisabled: { add(handler: () => void): void };
  onListeningError: { add(handler: (args: VoiceMLErrorEventArgs) => void): void };
  onListeningUpdate: { add(handler: (args: VoiceMLListeningUpdateEventArgs) => void): void };
};

type VoiceMLNamespace = {
  ListeningOptions: {
    create(): VoiceMLListeningOptions;
  };
  SpeechRecognizer: {
    Default: unknown;
  };
};

declare const VoiceML: VoiceMLNamespace;
declare const VoiceMLModule: {
  SpeechRecognizer: {
    Default: unknown;
  };
};

const GLOBAL_SPEECH_KEY = '__flowGardenSpeechRecognizerActive';

@component
export class SpeechRecognition extends BaseScriptComponent {
  @input
  startupDisabled: boolean = true;

  @input
  languageCode: string = 'en_US';

  @input
  autoStartListening: boolean = true;

  @input
  startupListenDelaySec: number = 10;

  @input
  tapToListen: boolean = true;

  @input
  listeningWindowSec: number = 8;

  @input
  debugLogging: boolean = false;

  @input
  commandCooldownSec: number = 1.5;

  @input
  mirrorTranscriptToSpacePanel: boolean = true;

  @input
  @allowUndefined
  transcriptText!: Text3D;

  @input
  @allowUndefined
  listeningStatusText!: Text3D;

  private voiceMLModule: VoiceMLModuleLike | null = null;
  private listeningOptions: VoiceMLListeningOptions | null = null;
  private lastCommandTime = 0;
  private instanceId = Math.floor(Math.random() * 1000);

  public finalTranscript: string = '';
  public lastHeard: string = '';
  public interimTranscript: string = '';

  private agentSessionActive = false;
  private lastLoggedHeard = '';
  private isListening = false;
  private listeningWindowEvent: DelayedCallbackEvent | null = null;

  onAwake(): void {
    if (this.startupDisabled) {
      this.setListeningStatus('Voice disabled for stability');
      this.setTranscriptText('Speech unavailable in recovery mode');
      return;
    }

    const globals = global as unknown as Record<string, boolean>;
    if (globals[GLOBAL_SPEECH_KEY]) {
      print(`[SpeechRecognition] Duplicate instance detected — disabling (${this.instanceId})`);
      this.enabled = false;
      return;
    }
    globals[GLOBAL_SPEECH_KEY] = true;
    registerSpeechRecognition(this);

    try {
      this.voiceMLModule = require('LensStudio:VoiceMLModule') as VoiceMLModuleLike;
    } catch (e) {
      print('[SpeechRecognition] VoiceMLModule unavailable: ' + e);
      this.setListeningStatus('Microphone unavailable');
      return;
    }

    this.listeningOptions = VoiceML.ListeningOptions.create();
    this.listeningOptions.speechRecognizer = VoiceMLModule.SpeechRecognizer.Default;
    this.listeningOptions.languageCode = this.languageCode;
    this.listeningOptions.shouldReturnAsrTranscription = true;
    this.listeningOptions.shouldReturnInterimAsrTranscription = true;
    this.listeningOptions.addSpeechContext(
      [
        'todo',
        'add',
        'remember',
        'complete',
        'done',
        'sync',
        'refresh',
        'seed',
        'plant',
        'water',
        'pot',
        'berry',
        'grow',
        'garden',
        'arvis',
        'avis',
        'armis',
        'argos',
        'harvest',
        'hey arvis',
        'hey avis',
        'hey harvest',
        'hey armis',
        'hey argos',
        'the avis',
        'hey a',
      ],
      12
    );

    this.bindVoiceEvents();

    this.setListeningStatus(this.autoStartListening ? 'Microphone starting...' : 'Tap to speak');
    if (this.autoStartListening) {
      const startupEvent = this.createEvent('DelayedCallbackEvent');
      startupEvent.bind(() => this.requestListening());
      startupEvent.reset(Math.max(0, this.startupListenDelaySec));
    }
  }

  private setListeningStatus(text: string): void {
    if (!isNull(this.listeningStatusText)) {
      this.listeningStatusText.text = text;
    }
  }

  private setTranscriptText(text: string): void {
    if (!isNull(this.transcriptText)) {
      this.transcriptText.text = text;
    }
  }

  public requestListening(): void {
    if (!this.voiceMLModule) {
      return;
    }
    try {
      (this.voiceMLModule as unknown as { requestListeningEnabled?: () => void }).requestListeningEnabled?.();
    } catch (e) {
      if (this.debugLogging) {
        print('[SpeechRecognition] requestListeningEnabled failed: ' + e);
      }
    }
  }

  public clearFinalTranscript(): void {
    this.finalTranscript = '';
    this.interimTranscript = '';
  }

  public getLiveTranscript(): string {
    return String(
      this.interimTranscript || this.finalTranscript || this.lastHeard || ''
    ).trim();
  }

  public endAgentSessionPreserveListening(): string {
    this.agentSessionActive = false;
    this.lastPushedTranscriptKey = '';
    const text = this.getLiveTranscript();
    this.pushTranscriptToSpacePanel(false);
    return text;
  }

  public isAgentSessionActive(): boolean {
    return this.agentSessionActive;
  }

  public beginAgentSession(): void {
    this.agentSessionActive = true;
    this.lastPushedTranscriptKey = '';
    this.clearFinalTranscript();
    this.requestListening();
  }

  public endAgentSession(): string {
    this.agentSessionActive = false;
    this.lastPushedTranscriptKey = '';
    const text = String(this.finalTranscript || this.interimTranscript || this.lastHeard || '').trim();
    this.stopListeningNow();
    this.clearFinalTranscript();
    return text;
  }

  public cancelAgentSession(): void {
    this.agentSessionActive = false;
    this.lastPushedTranscriptKey = '';
    this.stopListeningNow();
    this.clearFinalTranscript();
  }

  private stopListeningNow(): void {
    if (!this.voiceMLModule) {
      return;
    }
    try {
      this.voiceMLModule.stopListening();
    } catch (e) {
      if (this.debugLogging) {
        print('[SpeechRecognition] stopListening failed: ' + e);
      }
    }
  }

  public isCoolingDown(): boolean {
    return getTime() - this.lastCommandTime < this.commandCooldownSec;
  }

  public markCommandHandled(): void {
    this.lastCommandTime = getTime();
  }

  private bindVoiceEvents(): void {
    if (!this.voiceMLModule || !this.listeningOptions) {
      return;
    }

    const module = this.voiceMLModule;
    const options = this.listeningOptions;

    module.onListeningEnabled.add(() => {
      if (this.isListening) {
        return;
      }
      this.isListening = true;
      this.setListeningStatus('Listening...');
      if (this.debugLogging) {
        print(`[SpeechRecognition] Listening started (${this.instanceId})`);
      }
      module.startListening(options);
      this.startListeningWindowTimer();
    });

    module.onListeningDisabled.add(() => {
      this.isListening = false;
      this.setListeningStatus('Microphone paused');
      if (this.debugLogging) {
        print(`[SpeechRecognition] Listening stopped (${this.instanceId})`);
      }
      module.stopListening();
    });

    module.onListeningError.add((eventErrorArgs) => {
      this.isListening = false;
      this.setListeningStatus('Microphone error');
      print(
        `[SpeechRecognition] Error: ${eventErrorArgs.error} | ${eventErrorArgs.description}`
      );
    });

    module.onListeningUpdate.add((eventArgs) => {
      const text = String(eventArgs.transcription || '').trim().toLowerCase();
      if (!text) {
        return;
      }

      this.lastHeard = text;
      this.setTranscriptText(text);
      if (!eventArgs.isFinalTranscription) {
        this.interimTranscript = text;
      }
      if (this.debugLogging && text !== this.lastLoggedHeard) {
        this.lastLoggedHeard = text;
        const suffix = eventArgs.isFinalTranscription ? ' (final)' : '';
        print(`[SpeechRecognition] Heard: ${text}${suffix}`);
      }

      if (eventArgs.isFinalTranscription) {
        this.finalTranscript = text;
      }

      this.pushTranscriptToSpacePanel(true);
    });

    this.createEvent('TapEvent').bind(() => {
      if (!this.tapToListen || this.isListening) {
        return;
      }
      this.setListeningStatus('Starting microphone...');
      if (this.debugLogging) {
        print('[SpeechRecognition] Tap — requesting microphone');
      }
      this.requestListening();
    });
  }

  private startListeningWindowTimer(): void {
    if (!isNull(this.listeningWindowEvent)) {
      this.listeningWindowEvent.enabled = false;
    }

    this.listeningWindowEvent = this.createEvent('DelayedCallbackEvent');
    this.listeningWindowEvent.bind(() => {
      this.stopListeningNow();
      this.isListening = false;
      this.setListeningStatus('Tap to speak');
    });
    this.listeningWindowEvent.reset(Math.max(1, this.listeningWindowSec));
  }

  private lastPushedTranscriptKey = '';

  private pushTranscriptToSpacePanel(isListening: boolean): void {
    if (!this.mirrorTranscriptToSpacePanel || this.agentSessionActive) {
      return;
    }

    const panel = getSharedFlowGardenSpacePanel();
    if (isNull(panel)) {
      return;
    }

    const transcript = this.getLiveTranscript();
    const key = `${isListening ? 1 : 0}|${transcript}`;
    if (key === this.lastPushedTranscriptKey) {
      return;
    }
    this.lastPushedTranscriptKey = key;
    panel.showSpeechTranscript(transcript, isListening);
  }
}

import {
  getSharedFlowGardenSpacePanel,
  registerSpeechRecognition,
} from './FlowGardenServiceRegistry';
import { getAgentWakeVocabHints } from './ArvisWakePhrase';

/**
 * Speech-to-text for Flow Garden / Arvis.
 * Prefers Specs ASR Module (works in preview + device); falls back to legacy VoiceML.
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

type AsrTranscriptionOptions = {
  silenceUntilTerminationMs: number;
  mode: unknown;
  onTranscriptionUpdateEvent: {
    add(handler: (args: { text: string; isFinal: boolean }) => void): void;
  };
  onTranscriptionErrorEvent: {
    add(handler: (code: unknown) => void): void;
  };
};

type AsrModuleLike = {
  startTranscribing(options: AsrTranscriptionOptions): void;
  stopTranscribing(): Promise<void> | void;
};

declare const VoiceML: VoiceMLNamespace;
declare const VoiceMLModule: {
  SpeechRecognizer: {
    Default: unknown;
  };
};

declare const AsrModule: {
  AsrTranscriptionOptions: {
    create(): AsrTranscriptionOptions;
  };
  AsrMode: {
    Balanced: unknown;
    HighAccuracy: unknown;
    HighSpeed: unknown;
  };
};

const GLOBAL_SPEECH_OWNER = '__flowGardenSpeechRecognizerOwner';

const SPEECH_CONTEXT = [
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
  ...getAgentWakeVocabHints(),
  'argos',
  'hey argos',
];

@component
export class SpeechRecognition extends BaseScriptComponent {
  @input
  startupDisabled: boolean = false;

  @input
  languageCode: string = 'en_US';

  @input
  autoStartListening: boolean = true;

  @input
  startupListenDelaySec: number = 2.5;

  @input
  tapToListen: boolean = true;

  /** Only used for tap-to-listen VoiceML windows — not for ASR or auto-start. */
  @input
  listeningWindowSec: number = 8;

  @input
  debugLogging: boolean = true;

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

  private backend: 'asr' | 'voiceml' | 'none' = 'none';
  private voiceMLModule: VoiceMLModuleLike | null = null;
  private listeningOptions: VoiceMLListeningOptions | null = null;
  private asrModule: AsrModuleLike | null = null;
  private asrOptions: AsrTranscriptionOptions | null = null;
  private asrActive = false;

  private lastCommandTime = 0;
  private instanceId = Math.floor(Math.random() * 1000);

  public finalTranscript: string = '';
  public lastHeard: string = '';
  public interimTranscript: string = '';

  private agentSessionActive = false;
  private lastLoggedHeard = '';
  private isListening = false;
  private listeningWindowEvent: DelayedCallbackEvent | null = null;
  private lastPushedTranscriptKey = '';
  private emptyUpdateLogCount = 0;
  private lastHeardChangeTime = 0;
  private suppressVoiceCommandsUntil = 0;

  onAwake(): void {
    if (this.startupDisabled) {
      this.setListeningStatus('Voice disabled for stability');
      this.setTranscriptText('Speech unavailable in recovery mode');
      return;
    }

    const globals = global as unknown as Record<string, unknown>;
    const activeOwner = globals[GLOBAL_SPEECH_OWNER];
    if (typeof activeOwner === 'number' && activeOwner !== this.instanceId) {
      print(`[SpeechRecognition] Duplicate instance detected — disabling (${this.instanceId})`);
      this.enabled = false;
      return;
    }
    globals[GLOBAL_SPEECH_OWNER] = this.instanceId;
    registerSpeechRecognition(this);

    this.createEvent('OnDestroyEvent').bind(() => {
      const current = (global as unknown as Record<string, unknown>)[GLOBAL_SPEECH_OWNER];
      if (current === this.instanceId) {
        delete (global as unknown as Record<string, unknown>)[GLOBAL_SPEECH_OWNER];
      }
    });

    if (this.tryInitAsr()) {
      this.backend = 'asr';
    } else if (this.tryInitVoiceMl()) {
      this.backend = 'voiceml';
    } else {
      this.backend = 'none';
      this.setListeningStatus('Microphone unavailable');
      print('[SpeechRecognition] No ASR or VoiceML backend available');
      return;
    }

    if (this.debugLogging) {
      print(`[SpeechRecognition] backend=${this.backend} (${this.instanceId})`);
    }

    this.setListeningStatus(this.autoStartListening ? 'Microphone starting...' : 'Tap to speak');
    this.createEvent('OnStartEvent').bind(() => {
      if (this.autoStartListening) {
        const startupEvent = this.createEvent('DelayedCallbackEvent');
        startupEvent.bind(() => this.ensureListening());
        startupEvent.reset(Math.max(0, this.startupListenDelaySec));
      }
    });

    this.createEvent('TapEvent').bind(() => {
      if (!this.tapToListen || this.isListening) {
        return;
      }
      this.setListeningStatus('Starting microphone...');
      if (this.debugLogging) {
        print('[SpeechRecognition] Tap — requesting microphone');
      }
      this.ensureListening(true);
    });
  }

  private tryInitAsr(): boolean {
    try {
      this.asrModule = require('LensStudio:AsrModule') as AsrModuleLike;
      this.asrOptions = AsrModule.AsrTranscriptionOptions.create();
      this.asrOptions.silenceUntilTerminationMs = 900;
      this.asrOptions.mode = AsrModule.AsrMode.Balanced;
      this.asrOptions.onTranscriptionUpdateEvent.add((args) => {
        this.applyTranscript(String(args.text || ''), args.isFinal);
      });
      this.asrOptions.onTranscriptionErrorEvent.add((code) => {
        this.isListening = false;
        this.asrActive = false;
        this.setListeningStatus('Microphone restarting...');
        print(`[SpeechRecognition] ASR error: ${String(code)} — restarting`);
        this.scheduleAsrRestart(1.5);
      });
      return true;
    } catch (e) {
      if (this.debugLogging) {
        print('[SpeechRecognition] AsrModule unavailable: ' + e);
      }
      this.asrModule = null;
      this.asrOptions = null;
      return false;
    }
  }

  private tryInitVoiceMl(): boolean {
    try {
      this.voiceMLModule = require('LensStudio:VoiceMLModule') as VoiceMLModuleLike;
    } catch (e) {
      print('[SpeechRecognition] VoiceMLModule unavailable: ' + e);
      return false;
    }

    this.listeningOptions = VoiceML.ListeningOptions.create();
    this.listeningOptions.speechRecognizer = VoiceMLModule.SpeechRecognizer.Default;
    this.listeningOptions.languageCode = this.languageCode;
    this.listeningOptions.shouldReturnAsrTranscription = true;
    this.listeningOptions.shouldReturnInterimAsrTranscription = true;
    this.listeningOptions.addSpeechContext(SPEECH_CONTEXT, 12);
    this.bindVoiceEvents();
    return true;
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
    this.ensureListening(true);
  }

  private ensureListening(forceTapWindow: boolean = false): void {
    if (this.backend === 'asr') {
      this.startAsrIfNeeded();
      return;
    }

    if (this.backend === 'voiceml') {
      if (!this.voiceMLModule) {
        return;
      }
      try {
        (
          this.voiceMLModule as unknown as { requestListeningEnabled?: () => void }
        ).requestListeningEnabled?.();
      } catch (e) {
        if (this.debugLogging) {
          print('[SpeechRecognition] requestListeningEnabled failed: ' + e);
        }
      }
      if (forceTapWindow && !this.autoStartListening && !this.agentSessionActive) {
        this.startListeningWindowTimer();
      }
    }
  }

  private scheduleAsrRestart(delaySec: number): void {
    if (!this.autoStartListening && !this.agentSessionActive) {
      this.setListeningStatus('Tap to speak');
      return;
    }

    const restartEvent = this.createEvent('DelayedCallbackEvent');
    restartEvent.bind(() => {
      if (this.backend !== 'asr') {
        return;
      }
      this.startAsrIfNeeded();
    });
    restartEvent.reset(Math.max(0.5, delaySec));
  }

  private startAsrIfNeeded(): void {
    if (!this.asrModule || !this.asrOptions || this.asrActive) {
      return;
    }

    try {
      if (this.agentSessionActive) {
        this.asrOptions.silenceUntilTerminationMs = 1400;
      } else {
        this.asrOptions.silenceUntilTerminationMs = 900;
      }
      this.asrModule.startTranscribing(this.asrOptions);
      this.asrActive = true;
      this.isListening = true;
      this.cancelListeningWindowTimer();
      this.setListeningStatus('Listening...');
      if (this.debugLogging) {
        print(`[SpeechRecognition] ASR transcribing started (${this.instanceId})`);
      }
    } catch (e) {
      this.asrActive = false;
      this.isListening = false;
      print('[SpeechRecognition] ASR startTranscribing failed: ' + e);
      this.scheduleAsrRestart(2);
    }
  }

  private stopAsrIfNeeded(): void {
    if (!this.asrModule || !this.asrActive) {
      return;
    }
    try {
      const result = this.asrModule.stopTranscribing();
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch(() => {});
      }
    } catch (e) {
      if (this.debugLogging) {
        print('[SpeechRecognition] ASR stopTranscribing failed: ' + e);
      }
    }
    this.asrActive = false;
    this.isListening = false;
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

  /** ASR often emits interim-only updates; treat stable live text as an utterance. */
  public getStableUtterance(stableSec: number = 1.0): string {
    if (this.isSuppressingVoiceCommands()) {
      return '';
    }

    const text = this.getLiveTranscript();
    if (!text) {
      return '';
    }

    if (getTime() - this.lastHeardChangeTime < Math.max(0.35, stableSec)) {
      return '';
    }

    return text;
  }

  public suppressVoiceCommandsFor(seconds: number): void {
    this.suppressVoiceCommandsUntil = getTime() + Math.max(0, seconds);
  }

  public isSuppressingVoiceCommands(): boolean {
    return getTime() < this.suppressVoiceCommandsUntil;
  }

  public clearUtteranceState(): void {
    this.finalTranscript = '';
    this.interimTranscript = '';
    this.lastHeard = '';
    this.lastLoggedHeard = '';
    this.lastPushedTranscriptKey = '';
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
    this.cancelListeningWindowTimer();
    this.ensureListening();
  }

  public endAgentSession(): string {
    this.agentSessionActive = false;
    this.lastPushedTranscriptKey = '';
    const text = this.getLiveTranscript();

    if (this.backend === 'asr') {
      this.clearFinalTranscript();
      this.ensureListening();
      return text;
    }

    this.stopListeningNow();
    this.clearFinalTranscript();
    if (this.autoStartListening) {
      this.ensureListening();
    }
    return text;
  }

  public cancelAgentSession(): void {
    this.agentSessionActive = false;
    this.lastPushedTranscriptKey = '';
    this.clearFinalTranscript();

    if (this.backend === 'asr') {
      if (!this.autoStartListening) {
        this.stopAsrIfNeeded();
      }
      return;
    }

    this.stopListeningNow();
    if (this.autoStartListening) {
      this.ensureListening();
    }
  }

  private stopListeningNow(): void {
    if (this.backend === 'asr') {
      this.stopAsrIfNeeded();
      return;
    }

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
    this.isListening = false;
  }

  public isCoolingDown(): boolean {
    return getTime() - this.lastCommandTime < this.commandCooldownSec;
  }

  public markCommandHandled(): void {
    this.lastCommandTime = getTime();
  }

  private applyTranscript(rawText: string, isFinal: boolean): void {
    const text = String(rawText || '').trim().toLowerCase();
    if (!text) {
      if (this.debugLogging && this.emptyUpdateLogCount < 3) {
        this.emptyUpdateLogCount++;
        print(
          `[SpeechRecognition] Empty ${isFinal ? 'final' : 'interim'} update (${this.backend})`
        );
      }
      return;
    }

    if (text !== this.lastHeard) {
      this.lastHeardChangeTime = getTime();
    }

    this.lastHeard = text;
    this.setTranscriptText(text);
    if (!isFinal) {
      this.interimTranscript = text;
    }
    if (this.debugLogging && text !== this.lastLoggedHeard) {
      this.lastLoggedHeard = text;
      const suffix = isFinal ? ' (final)' : '';
      print(`[SpeechRecognition] Heard: ${text}${suffix}`);
    }

    if (isFinal) {
      this.finalTranscript = text;
      this.interimTranscript = '';
    }

    this.pushTranscriptToSpacePanel(true);
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
      if (!this.autoStartListening && !this.agentSessionActive) {
        this.startListeningWindowTimer();
      }
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
      this.applyTranscript(
        String(eventArgs.transcription || ''),
        eventArgs.isFinalTranscription
      );
    });
  }

  private startListeningWindowTimer(): void {
    if (this.agentSessionActive || this.autoStartListening || this.backend === 'asr') {
      return;
    }

    this.cancelListeningWindowTimer();
    this.listeningWindowEvent = this.createEvent('DelayedCallbackEvent');
    this.listeningWindowEvent.bind(() => {
      this.stopListeningNow();
      this.setListeningStatus('Tap to speak');
    });
    this.listeningWindowEvent.reset(Math.max(1, this.listeningWindowSec));
  }

  private cancelListeningWindowTimer(): void {
    if (!isNull(this.listeningWindowEvent)) {
      this.listeningWindowEvent.enabled = false;
      this.listeningWindowEvent = null;
    }
  }

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

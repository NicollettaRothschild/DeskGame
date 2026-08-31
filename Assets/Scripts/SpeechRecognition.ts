import {
  getSharedFlowGardenSpacePanel,
  getSharedFlowGardenTts,
  registerSpeechRecognition,
  unregisterSpeechRecognition,
} from './FlowGardenServiceRegistry';
import {
  findArvisWakeInTranscript,
  getAgentWakeVocabHints,
  isLikelyAmbientTranscript,
  looksLikePossibleAgentWake,
  shouldAcceptTranscriptUpdate,
} from './ArvisWakePhrase';

/**
 * Speech-to-text for Flow Garden / Arvis.
 * Uses VoiceML in Lens Studio Preview and the ASR Module on Spectacles 2024.
 * The shared session is prewarmed before interaction so SIK callbacks never
 * have to start native transcription while a buddy is held.
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
  'plant',
  'pot',
  'grow',
  'garden',
  ...getAgentWakeVocabHints(),
  'argos',
  'hey argos',
];

@component
export class SpeechRecognition extends BaseScriptComponent {
  private static readonly INTERIM_UI_INTERVAL_SEC = 0.25;
  private static readonly INTERIM_LOG_INTERVAL_SEC = 4;
  private static readonly MAX_TRANSCRIPT_DISPLAY_CHARS = 280;
  private static readonly MAX_TRANSCRIPT_PROCESSING_CHARS = 512;

  @input
  startupDisabled: boolean = false;

  @input
  languageCode: string = 'en_US';

  @input
  autoStartListening: boolean = false;

  @input
  startupListenDelaySec: number = 2.5;

  @input
  tapToListen: boolean = false;

  /** Only used for tap-to-listen compatibility windows — not for ASR or auto-start. */
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

  private backend: 'asr' | 'voiceml' | 'none' = 'none';
  private voiceMLModule: VoiceMLModuleLike | null = null;
  private listeningOptions: VoiceMLListeningOptions | null = null;
  private asrModule: AsrModuleLike | null = null;
  private asrOptions: AsrTranscriptionOptions | null = null;
  private asrActive = false;
  private asrStopPending = false;
  private asrRestartAfterStop = false;
  private asrRestartPending = false;

  private lastCommandTime = 0;
  private instanceId = Math.floor(Math.random() * 1000);

  public finalTranscript: string = '';
  public lastHeard: string = '';
  public interimTranscript: string = '';
  /** Original-casing live text for UI surfaces (post-its, bubbles). */
  public displayTranscript: string = '';

  private agentSessionActive = false;
  private lastLoggedHeard = '';
  private lastLoggedHeardAt = -Infinity;
  private isListening = false;
  private listeningWindowEvent: DelayedCallbackEvent | null = null;
  private listeningEnsureEvent: DelayedCallbackEvent | null = null;
  private lastPushedTranscriptKey = '';
  private emptyUpdateLogCount = 0;
  private lastHeardChangeTime = 0;
  private suppressVoiceCommandsUntil = 0;
  private transcriptListeners: Array<(text: string, isFinal: boolean) => void> = [];
  private postItCaptureDepth = 0;
  private lastInterimUiUpdateAt = -Infinity;
  private lastAsrErrorLogAt = -Infinity;
  private lastVoiceMlErrorLogAt = -Infinity;
  private resumeAfterTts = false;
  private ttsActive = false;
  private listeningRequestedDuringTts = false;
  private voiceMlInitAttempted = false;
  private voiceMlEnableRequestPending = false;
  private voiceMlStopAfterEnablePending = false;
  private voiceMlStopRequestPending = false;
  private voiceMlListeningWanted = false;
  private prewarmRequested = false;
  private listeningAuthorized = false;
  private startupReady = false;
  private shuttingDown = false;
  private microphoneAllowedAt = 0;
  private ttsPauseReleasedCallbacks: Array<() => void> = [];

  onAwake(): void {
    this.shuttingDown = false;
    if (this.startupDisabled) {
      this.setListeningStatus('Voice disabled for stability');
      this.setTranscriptText('Speech unavailable in recovery mode');
      return;
    }

    const globals = global as unknown as Record<string, unknown>;
    const nextInstanceId =
      Number(globals.__flowGardenSpeechRecognizerInstanceId || 0) + 1;
    globals.__flowGardenSpeechRecognizerInstanceId = nextInstanceId;
    this.instanceId = nextInstanceId;
    const activeOwner = globals[GLOBAL_SPEECH_OWNER];
    if (typeof activeOwner === 'number' && activeOwner !== this.instanceId) {
      print(`[SpeechRecognition] Duplicate instance detected — disabling (${this.instanceId})`);
      this.enabled = false;
      return;
    }
    globals[GLOBAL_SPEECH_OWNER] = this.instanceId;
    registerSpeechRecognition(this);

    this.createEvent('OnDestroyEvent').bind(() => {
      this.shuttingDown = true;
      this.startupReady = false;
      this.resumeAfterTts = false;
      this.ttsActive = false;
      this.listeningRequestedDuringTts = false;
      this.voiceMlListeningWanted = false;
      this.prewarmRequested = false;
      this.listeningAuthorized = false;
      this.ttsPauseReleasedCallbacks = [];
      this.stopListeningNow();
      this.transcriptListeners = [];
      const current = (global as unknown as Record<string, unknown>)[GLOBAL_SPEECH_OWNER];
      if (current === this.instanceId) {
        delete (global as unknown as Record<string, unknown>)[GLOBAL_SPEECH_OWNER];
      }
      unregisterSpeechRecognition(this);
    });

    // Native backends are selected lazily after OnStart. Preview must keep the
    // historical VoiceML path because ASR is a device-only API; Spectacles
    // 2024 uses ASR.
    this.backend = 'none';

    if (this.debugLogging) {
      print(`[SpeechRecognition] backend=${this.backend} (${this.instanceId})`);
    }

    this.setListeningStatus(this.autoStartListening ? 'Microphone starting...' : 'Tap to speak');
    this.createEvent('OnStartEvent').bind(() => {
      this.startupReady = true;
      // Spectacles native ASR can terminate the Lens when startTranscribing
      // races TTS, SIK, or session bring-up. Never auto-start the mic on device.
      if (!this.isEditorRuntime()) {
        this.autoStartListening = false;
      }
      const startupDelaySec = this.isEditorRuntime()
        ? 0.35
        : Math.max(8, this.startupListenDelaySec);
      this.microphoneAllowedAt = getTime() + startupDelaySec;
      if (this.autoStartListening) {
        const startupEvent = this.createEvent('DelayedCallbackEvent');
        startupEvent.bind(() => this.ensureListening());
        startupEvent.reset(startupDelaySec);
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

  private isEditorRuntime(): boolean {
    try {
      const deviceInfo = (
        global as unknown as {
          deviceInfoSystem?: { isEditor?: () => boolean };
        }
      ).deviceInfoSystem;
      return (
        !!deviceInfo &&
        typeof deviceInfo.isEditor === 'function' &&
        !!deviceInfo.isEditor()
      );
    } catch (_error) {
      return false;
    }
  }

  private selectBackend(): boolean {
    const selectAsr = (): boolean => {
      if (!this.tryInitAsr() || !this.ensureAsrOptions()) {
        return false;
      }
      this.backend = 'asr';
      print(`[SpeechRecognition] ASR backend selected (${this.instanceId})`);
      return true;
    };

    // ASR is not available in Lens Studio Preview. Keep the VoiceML path
    // there so mouse/interactive-preview speech retains the old behavior.
    if (this.isEditorRuntime()) {
      if (this.tryInitVoiceMl()) {
        this.backend = 'voiceml';
        print(
          `[SpeechRecognition] VoiceML Preview backend selected (${this.instanceId})`
        );
        return true;
      }
      return selectAsr();
    }

    // Spectacles 2024 uses the native ASR module. VoiceML remains only as a
    // compatibility fallback for runtimes where ASR is unavailable.
    if (selectAsr()) {
      return true;
    }
    if (this.tryInitVoiceMl()) {
      this.backend = 'voiceml';
      print(
        `[SpeechRecognition] VoiceML compatibility backend selected (${this.instanceId})`
      );
      return true;
    }
    return false;
  }

  private tryInitAsr(): boolean {
    try {
      this.asrModule = require('LensStudio:AsrModule') as AsrModuleLike;
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

  /**
   * ASR session objects must be created after OnStart on Spectacles. Creating
   * AsrTranscriptionOptions during onAwake leaves a native object that can
   * terminate the Lens when startTranscribing() is called later from a grab.
   */
  private ensureAsrOptions(): boolean {
    if (!this.startupReady) {
      return false;
    }
    if (!isNull(this.asrOptions)) {
      return true;
    }
    if (isNull(this.asrModule)) {
      return false;
    }

    try {
      const options = AsrModule.AsrTranscriptionOptions.create();
      options.silenceUntilTerminationMs = 900;
      options.mode = AsrModule.AsrMode.HighAccuracy;
      options.onTranscriptionUpdateEvent.add((args) => {
        this.applyTranscript(String(args.text || ''), args.isFinal);
      });
      options.onTranscriptionErrorEvent.add((code) => {
        this.isListening = false;
        this.asrActive = false;
        this.setListeningStatus('Microphone restarting...');
        const now = getTime();
        if (now - this.lastAsrErrorLogAt >= 5) {
          this.lastAsrErrorLogAt = now;
          print(`[SpeechRecognition] ASR error: ${String(code)} — restarting`);
        }
        this.scheduleAsrRestart(1.5);
      });
      this.asrOptions = options;
      print(`[SpeechRecognition] ASR options initialized after OnStart (${this.instanceId})`);
      return true;
    } catch (e) {
      this.asrOptions = null;
      print('[SpeechRecognition] ASR options initialization failed: ' + e);
      return false;
    }
  }

  private tryInitVoiceMl(): boolean {
    if (this.voiceMlInitAttempted) {
      return !isNull(this.voiceMLModule) && !isNull(this.listeningOptions);
    }
    this.voiceMlInitAttempted = true;

    try {
      this.voiceMLModule = require('LensStudio:VoiceMLModule') as VoiceMLModuleLike;
      this.listeningOptions = VoiceML.ListeningOptions.create();
      this.listeningOptions.speechRecognizer = VoiceMLModule.SpeechRecognizer.Default;
      this.listeningOptions.languageCode = this.languageCode;
      this.listeningOptions.shouldReturnAsrTranscription = true;
      this.listeningOptions.shouldReturnInterimAsrTranscription = true;
      this.listeningOptions.addSpeechContext(SPEECH_CONTEXT, 12);
      this.bindVoiceEvents();
      if (this.debugLogging) {
        print(`[SpeechRecognition] VoiceML backend initialized on demand (${this.instanceId})`);
      }
      return true;
    } catch (e) {
      this.voiceMLModule = null;
      this.listeningOptions = null;
      print('[SpeechRecognition] VoiceML unavailable: ' + e);
      return false;
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

  private limitTranscriptForDisplay(text: string): string {
    const value = String(text || '');
    const maxChars = SpeechRecognition.MAX_TRANSCRIPT_DISPLAY_CHARS;
    if (value.length <= maxChars) {
      return value;
    }
    return `…${value.slice(-(maxChars - 1))}`;
  }

  /** Keep repeated ASR work bounded when the module appends room audio indefinitely. */
  private limitTranscriptForProcessing(text: string): string {
    const value = String(text || '');
    const maxChars = SpeechRecognition.MAX_TRANSCRIPT_PROCESSING_CHARS;
    if (value.length <= maxChars) {
      return value;
    }

    const headChars = Math.floor((maxChars - 1) / 2);
    const tailChars = maxChars - headChars - 1;
    return `${value.slice(0, headChars)}…${value.slice(-tailChars)}`;
  }

  public requestListening(): void {
    this.listeningAuthorized = true;
    this.deferEnsureListening();
  }

  /**
   * Open the microphone from UpdateEvent. Safe on Spectacles 2024.
   * Do not call this from a SIK trigger callback — use requestListening().
   */
  public pumpListening(): void {
    this.listeningAuthorized = true;
    if (!this.startupReady || this.shuttingDown) {
      this.deferEnsureListening(0.08);
      return;
    }
    this.ensureListening(true);
  }

  /**
   * Prepare the native ASR module without opening the microphone.
   * Hover/prewarm must never call startTranscribing on Spectacles.
   */
  public prewarmListening(): void {
    if (this.startupDisabled || this.shuttingDown || !this.startupReady) {
      return;
    }
    this.prepareNativeBackend();
  }

  public isMicrophoneListening(): boolean {
    return this.isListening;
  }

  public beginPostItCapture(startListening: boolean = true): void {
    if (this.shuttingDown) {
      return;
    }
    this.postItCaptureDepth += 1;
    this.listeningAuthorized = true;
    // SIK grab paths pass false so startTranscribing waits a beat after the
    // native held-target callback. UpdateEvent paths can start sooner.
    this.deferEnsureListening(startListening ? 0.08 : 0.12);
  }

  private wantsNativeListening(): boolean {
    return (
      this.listeningAuthorized ||
      this.agentSessionActive ||
      this.postItCaptureDepth > 0
    );
  }

  private prepareNativeBackend(): void {
    if (!this.startupReady || this.shuttingDown) {
      return;
    }
    if (this.backend === 'none') {
      this.selectBackend();
      return;
    }
    if (this.backend === 'asr') {
      this.ensureAsrOptions();
    }
  }

  private deferEnsureListening(delaySec: number = 0.08): void {
    if (this.shuttingDown) {
      return;
    }
    // Hold-to-talk pumps requestListening every frame until the mic is open.
    // Resetting this timer postponed startTranscribing forever on device.
    if (!isNull(this.listeningEnsureEvent)) {
      return;
    }
    print(`[SpeechRecognition] listening requested (${this.instanceId})`);
    const deferred = this.createEvent('DelayedCallbackEvent');
    deferred.bind(() => {
      this.listeningEnsureEvent = null;
      if (this.shuttingDown) {
        return;
      }
      this.ensureListening(true);
    });
    this.listeningEnsureEvent = deferred;
    deferred.reset(Math.max(0.05, delaySec));
  }

  /** True only while TTS audio is actually occupying the speech channel. */
  private isTtsAudioOccupyingMic(): boolean {
    const tts = getSharedFlowGardenTts();
    if (isNull(tts)) {
      return false;
    }
    try {
      return !!tts.isAudioPlaying();
    } catch (_error) {
      return false;
    }
  }

  private isTtsBlockingMicrophone(): boolean {
    return this.isTtsAudioOccupyingMic();
  }

  private queueMicrophoneReleasedCallback(callback?: () => void): void {
    if (!callback) {
      return;
    }
    this.ttsPauseReleasedCallbacks.push(callback);
    if (!this.asrActive && !this.asrStopPending) {
      this.flushMicrophoneReleasedCallbacks(0.12);
    }
  }

  private flushMicrophoneReleasedCallbacks(delaySec: number): void {
    if (this.ttsPauseReleasedCallbacks.length === 0) {
      return;
    }
    const callbacks = this.ttsPauseReleasedCallbacks;
    this.ttsPauseReleasedCallbacks = [];
    const delay = this.createEvent('DelayedCallbackEvent');
    delay.bind(() => {
      for (let i = 0; i < callbacks.length; i++) {
        callbacks[i]();
      }
    });
    delay.reset(Math.max(0.05, delaySec));
  }

  private ensureListening(forceTapWindow: boolean = false): void {
    // Native ASR/VoiceML objects are not safe to create from onAwake or an
    // early prefab callback on Specs. Wait for the lifecycle OnStart event.
    if (!this.startupReady || this.shuttingDown) {
      return;
    }

    // Native ASR and TTS cannot safely own the audio session at the same
    // time on Spectacles. Remember the request and let TTS release the
    // microphone before starting transcription. Do not treat a stale pause
    // flag or the post-speech wake-word suppression window as a mic lock.
    if (this.isTtsAudioOccupyingMic()) {
      this.ttsActive = true;
      this.listeningRequestedDuringTts = true;
      return;
    }
    this.ttsActive = false;

    if (!this.wantsNativeListening()) {
      this.prepareNativeBackend();
      return;
    }

    if (this.backend === 'asr') {
      this.startAsrIfNeeded();
      return;
    }

    if (this.backend === 'none') {
      if (!this.selectBackend()) {
        this.setListeningStatus('Microphone unavailable');
        return;
      }
      // Re-enter the selected backend branch without ever starting it from
      // the caller's interaction callback.
      this.ensureListening(forceTapWindow);
      return;
    }

    if (this.backend === 'voiceml') {
      if (!this.voiceMLModule) {
        return;
      }
      this.voiceMlListeningWanted = true;
      // Reuse the prewarmed session. Re-requesting native listening from a
      // held SIK interaction is unnecessary and was part of the crash path.
      // If a stop is already in flight, onListeningDisabled will restart the
      // session when this request is still wanted.
      if (
        this.isListening ||
        this.voiceMlEnableRequestPending ||
        this.voiceMlStopRequestPending
      ) {
        return;
      }
      try {
        const requestListeningEnabled = (
          this.voiceMLModule as unknown as {
            requestListeningEnabled?: () => void;
          }
        ).requestListeningEnabled;
        if (typeof requestListeningEnabled !== 'function') {
          this.voiceMlListeningWanted = false;
          this.setListeningStatus('Microphone unavailable');
          return;
        }
        this.voiceMlEnableRequestPending = true;
        requestListeningEnabled.call(this.voiceMLModule);
        print(`[SpeechRecognition] VoiceML enable requested (${this.instanceId})`);
      } catch (e) {
        this.voiceMlEnableRequestPending = false;
        this.voiceMlListeningWanted = false;
        if (this.debugLogging) {
          print('[SpeechRecognition] requestListeningEnabled failed: ' + e);
        }
      }
      if (
        forceTapWindow &&
        !this.autoStartListening &&
        !this.agentSessionActive &&
        !this.prewarmRequested
      ) {
        this.startListeningWindowTimer();
      }
    }
  }

  private scheduleAsrRestart(delaySec: number): void {
    if (this.shuttingDown || !this.wantsNativeListening()) {
      this.setListeningStatus('Tap to speak');
      return;
    }
    if (this.asrRestartPending) {
      return;
    }

    this.asrRestartPending = true;
    const restartEvent = this.createEvent('DelayedCallbackEvent');
    restartEvent.bind(() => {
      this.asrRestartPending = false;
      if (this.shuttingDown || this.backend !== 'asr') {
        return;
      }
      this.startAsrIfNeeded();
    });
    restartEvent.reset(Math.max(0.5, delaySec));
  }

  private startAsrIfNeeded(): void {
    if (
      !this.startupReady ||
      this.shuttingDown ||
      !this.asrModule ||
      !this.ensureAsrOptions()
    ) {
      return;
    }
    if (this.isTtsAudioOccupyingMic()) {
      this.ttsActive = true;
      this.listeningRequestedDuringTts = true;
      return;
    }
    this.ttsActive = false;
    if (!this.wantsNativeListening()) {
      return;
    }
    // The boot delay only exists so Spectacles does not auto-start ASR
    // during lens bring-up. Pinch, Post-it, and agent sessions skip it.
    const startupWait = this.microphoneAllowedAt - getTime();
    if (startupWait > 0 && this.autoStartListening && !this.listeningAuthorized) {
      this.scheduleAsrRestart(startupWait);
      return;
    }
    if (this.asrStopPending) {
      this.asrRestartAfterStop = true;
      return;
    }
    if (this.asrRestartPending) {
      return;
    }
    if (this.asrActive) {
      return;
    }

    const suppressionRemaining = this.suppressVoiceCommandsUntil - getTime();
    if (
      suppressionRemaining > 0 &&
      !this.agentSessionActive &&
      this.postItCaptureDepth === 0
    ) {
      this.scheduleAsrRestart(suppressionRemaining);
      return;
    }

    try {
      const options = this.asrOptions as AsrTranscriptionOptions;
      if (this.agentSessionActive) {
        options.silenceUntilTerminationMs = 1400;
      } else {
        options.silenceUntilTerminationMs = 900;
      }
      print(`[SpeechRecognition] ASR start requested (${this.instanceId})`);
      this.asrModule.startTranscribing(options);
      this.asrActive = true;
      this.isListening = true;
      this.cancelListeningWindowTimer();
      this.setListeningStatus('Listening...');
      print(`[SpeechRecognition] ASR transcribing started (${this.instanceId})`);
    } catch (e) {
      this.asrActive = false;
      this.isListening = false;
      const now = getTime();
      if (now - this.lastAsrErrorLogAt >= 5) {
        this.lastAsrErrorLogAt = now;
        print('[SpeechRecognition] ASR startTranscribing failed: ' + e);
      }
      this.scheduleAsrRestart(2);
    }
  }

  private stopAsrIfNeeded(): void {
    if (!this.asrModule || !this.asrActive) {
      this.flushMicrophoneReleasedCallbacks(0.12);
      return;
    }
    this.asrRestartAfterStop = false;

    let stopResult: Promise<void> | void = undefined;
    try {
      stopResult = this.asrModule.stopTranscribing();
    } catch (e) {
      if (this.debugLogging) {
        print('[SpeechRecognition] ASR stopTranscribing failed: ' + e);
      }
    }
    this.asrActive = false;
    this.isListening = false;

    if (!stopResult || typeof stopResult.then !== 'function') {
      this.flushMicrophoneReleasedCallbacks(0.12);
      return;
    }

    this.asrStopPending = true;
    const finishStop = (): void => {
      this.asrStopPending = false;
      this.flushMicrophoneReleasedCallbacks(0.12);
      const shouldRestart =
        !this.shuttingDown &&
        !this.ttsActive &&
        this.wantsNativeListening() &&
        (this.asrRestartAfterStop || this.agentSessionActive || this.postItCaptureDepth > 0);
      this.asrRestartAfterStop = false;
      if (shouldRestart) {
        this.startAsrIfNeeded();
      }
    };
    (stopResult as Promise<void>).then(finishStop).catch(finishStop);
  }

  public clearFinalTranscript(): void {
    this.finalTranscript = '';
    this.interimTranscript = '';
    this.lastHeard = '';
    this.displayTranscript = '';
    this.lastHeardChangeTime = getTime();
  }

  public getLiveTranscript(): string {
    return String(
      this.interimTranscript || this.finalTranscript || this.lastHeard || ''
    ).trim();
  }

  /** Original-casing transcript for display (falls back to normalized live text). */
  public getDisplayTranscript(): string {
    const display = String(this.displayTranscript || '').trim();
    if (display) {
      return display;
    }
    return this.getLiveTranscript();
  }

  public addTranscriptListener(
    listener: (text: string, isFinal: boolean) => void
  ): void {
    if (!listener) {
      return;
    }
    for (let i = 0; i < this.transcriptListeners.length; i++) {
      if (this.transcriptListeners[i] === listener) {
        return;
      }
    }
    this.transcriptListeners.push(listener);
  }

  public removeTranscriptListener(
    listener: (text: string, isFinal: boolean) => void
  ): void {
    if (!listener) {
      return;
    }
    const next: Array<(text: string, isFinal: boolean) => void> = [];
    for (let i = 0; i < this.transcriptListeners.length; i++) {
      if (this.transcriptListeners[i] !== listener) {
        next.push(this.transcriptListeners[i]);
      }
    }
    this.transcriptListeners = next;
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

  public endPostItCapture(): void {
    this.postItCaptureDepth = Math.max(0, this.postItCaptureDepth - 1);
    if (this.postItCaptureDepth === 0 && !this.agentSessionActive) {
      this.listeningAuthorized = false;
      if (this.ttsActive) {
        this.listeningRequestedDuringTts = false;
      }
      this.stopListeningNow();
      this.setListeningStatus('Tap to speak');
    }
  }

  public isPostItCaptureActive(): boolean {
    return this.postItCaptureDepth > 0;
  }

  public clearUtteranceState(): void {
    this.finalTranscript = '';
    this.interimTranscript = '';
    this.lastHeard = '';
    this.displayTranscript = '';
    this.lastLoggedHeard = '';
    this.lastLoggedHeardAt = -Infinity;
    this.lastPushedTranscriptKey = '';
    this.lastInterimUiUpdateAt = -Infinity;
    this.lastHeardChangeTime = getTime();
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

  public beginAgentSession(startListening: boolean = true): void {
    if (this.shuttingDown) {
      return;
    }
    this.agentSessionActive = true;
    this.listeningAuthorized = true;
    this.lastPushedTranscriptKey = '';
    this.clearFinalTranscript();
    this.cancelListeningWindowTimer();
    if (startListening) {
      this.deferEnsureListening();
    }
  }

  public endAgentSession(): string {
    this.agentSessionActive = false;
    this.listeningAuthorized = this.postItCaptureDepth > 0;
    this.lastPushedTranscriptKey = '';
    const text = this.getLiveTranscript();

    if (this.backend === 'asr') {
      this.clearFinalTranscript();
      if (this.wantsNativeListening()) {
        this.ensureListening();
      } else {
        this.stopAsrIfNeeded();
        this.setListeningStatus('Tap to speak');
      }
      return text;
    }

    this.stopListeningNow();
    this.clearFinalTranscript();
    if (this.wantsNativeListening()) {
      this.ensureListening();
    }
    return text;
  }

  /** Pause the microphone while native/cloud speech is playing. */
  public pauseForTts(onMicrophoneReleased?: () => void): void {
    this.ttsActive = true;
    this.listeningRequestedDuringTts = false;

    const voiceMlCaptureActive =
      this.backend === 'voiceml' &&
      (this.isListening ||
        this.voiceMlEnableRequestPending ||
        this.voiceMlListeningWanted);
    this.resumeAfterTts =
      this.resumeAfterTts ||
      this.isListening ||
      voiceMlCaptureActive ||
      this.wantsNativeListening();

    if (this.backend === 'voiceml') {
      // A pending VoiceML enable must be canceled before TTS starts. The
      // enable callback will issue the native stop once that state is valid.
      this.voiceMlListeningWanted = false;
    }
    if (
      this.resumeAfterTts ||
      this.voiceMlEnableRequestPending ||
      this.isListening ||
      this.asrActive
    ) {
      this.stopListeningNow();
    }
    this.queueMicrophoneReleasedCallback(onMicrophoneReleased);
  }

  /** Resume ASR/VoiceML after TTS has released the audio session. */
  public resumeAfterTtsPlayback(): void {
    const shouldResume = this.wantsNativeListening();
    this.resumeAfterTts = false;
    this.listeningRequestedDuringTts = false;
    this.ttsActive = false;
    if (this.isTtsBlockingMicrophone()) {
      this.ttsActive = true;
      this.listeningRequestedDuringTts = true;
      return;
    }
    if (shouldResume) {
      this.ensureListening();
    }
  }

  public cancelAgentSession(): void {
    this.agentSessionActive = false;
    this.listeningAuthorized = this.postItCaptureDepth > 0;
    this.lastPushedTranscriptKey = '';
    this.clearFinalTranscript();

    if (this.backend === 'asr') {
      if (!this.wantsNativeListening()) {
        this.stopAsrIfNeeded();
      } else {
        this.ensureListening();
      }
      return;
    }

    this.stopListeningNow();
    if (this.wantsNativeListening()) {
      this.ensureListening();
    }
  }

  private stopListeningNow(): void {
    this.voiceMlListeningWanted = false;
    if (this.backend === 'asr') {
      this.stopAsrIfNeeded();
      return;
    }

    if (!this.voiceMLModule) {
      this.isListening = false;
      return;
    }

    // VoiceML may acknowledge requestListeningEnabled after the user has
    // already released the buddy. Do not call stopListening before the native
    // session is enabled; remember the cancellation and release it from the
    // enable callback instead. Leaving that session enabled is what allows
    // TTS and VoiceML to claim the audio device at the same time.
    if (this.voiceMlEnableRequestPending) {
      this.voiceMlStopAfterEnablePending = true;
      this.isListening = false;
      return;
    }

    if (!this.isListening || this.voiceMlStopRequestPending) {
      this.isListening = false;
      return;
    }

    this.requestVoiceMlStop();
    this.isListening = false;
  }

  private requestVoiceMlStop(): void {
    if (
      !this.voiceMLModule ||
      this.voiceMlStopRequestPending
    ) {
      return;
    }

    this.voiceMlStopRequestPending = true;
    try {
      this.voiceMLModule.stopListening();
    } catch (e) {
      this.voiceMlStopRequestPending = false;
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

  private notifyTranscriptListeners(text: string, isFinal: boolean): void {
    for (let i = 0; i < this.transcriptListeners.length; i++) {
      try {
        this.transcriptListeners[i](text, isFinal);
      } catch (e) {
        if (this.debugLogging) {
          print('[SpeechRecognition] transcript listener error: ' + e);
        }
      }
    }
  }

  private applyTranscript(rawText: string, isFinal: boolean): void {
    if (this.shuttingDown) {
      return;
    }
    // Drop mic bleed from our own TTS — prevents news/reply echo loops in preview.
    // A held Post-it/coding buddy is an explicit user speech session. It must
    // still receive the utterance when the global command suppressor is
    // carrying a short tail from the previous TTS response.
    if (
      !shouldAcceptTranscriptUpdate(
        this.isSuppressingVoiceCommands(),
        this.agentSessionActive,
        this.postItCaptureDepth > 0
      )
    ) {
      return;
    }

    const displayText = this.limitTranscriptForProcessing(String(rawText || '').trim());
    const text = displayText.toLowerCase();
    if (!text) {
      if (this.debugLogging && this.emptyUpdateLogCount < 3) {
        this.emptyUpdateLogCount++;
        print(
          `[SpeechRecognition] Empty ${isFinal ? 'final' : 'interim'} update (${this.backend})`
        );
      }
      return;
    }

    const textChanged = text !== this.lastHeard;
    if (textChanged) {
      this.lastHeardChangeTime = getTime();
    }

    this.lastHeard = text;
    this.displayTranscript = displayText;
    if (!isFinal) {
      this.interimTranscript = text;
      // Surface embedded wake early from noisy interim streams.
      const interimWake = findArvisWakeInTranscript(text);
      if (interimWake.triggered && !this.agentSessionActive) {
        this.finalTranscript = interimWake.message
          ? `hey arvis ${interimWake.message}`
          : 'hey arvis';
      }
    }

    if (isFinal) {
      const wake = findArvisWakeInTranscript(text);
      if (wake.triggered) {
        this.finalTranscript = wake.message ? `hey arvis ${wake.message}` : 'hey arvis';
        this.interimTranscript = '';
      } else if (
        !this.agentSessionActive &&
        this.postItCaptureDepth === 0 &&
        isLikelyAmbientTranscript(text)
      ) {
        // Drop TV / room bleed so it cannot block the next "hey arvis".
        if (this.debugLogging) {
          print(
            `[SpeechRecognition] Ignoring ambient transcript (${text.split(/\s+/).length} words)`
          );
        }
        this.finalTranscript = '';
        this.interimTranscript = '';
      } else if (
        !this.agentSessionActive &&
        this.postItCaptureDepth === 0 &&
        !looksLikePossibleAgentWake(text) &&
        text.length > 24
      ) {
        this.finalTranscript = '';
        this.interimTranscript = '';
      } else {
        this.finalTranscript = text;
        this.interimTranscript = '';
      }
    }

    const now = getTime();
    const shouldPublish =
      isFinal ||
      (textChanged &&
        now - this.lastInterimUiUpdateAt >= SpeechRecognition.INTERIM_UI_INTERVAL_SEC);
    if (shouldPublish) {
      this.lastInterimUiUpdateAt = now;
      this.setTranscriptText(this.limitTranscriptForDisplay(displayText));
      this.notifyTranscriptListeners(displayText, isFinal);
      this.pushTranscriptToSpacePanel(true);
    }

    if (
      this.debugLogging &&
      isFinal &&
      text !== this.lastLoggedHeard &&
      now - this.lastLoggedHeardAt >= SpeechRecognition.INTERIM_LOG_INTERVAL_SEC
    ) {
      this.lastLoggedHeard = text;
      this.lastLoggedHeardAt = now;
      print(
        `[SpeechRecognition] Final transcript (${text.length} chars): ${this.limitTranscriptForDisplay(
          text
        )}`
      );
    }
  }

  private bindVoiceEvents(): void {
    if (!this.voiceMLModule || !this.listeningOptions) {
      return;
    }

    const module = this.voiceMLModule;
    const options = this.listeningOptions;

    module.onListeningEnabled.add(() => {
      if (this.shuttingDown) {
        this.voiceMlEnableRequestPending = false;
        this.requestVoiceMlStop();
        return;
      }
      this.voiceMlEnableRequestPending = false;
      const cancelBeforeStart =
        this.voiceMlStopAfterEnablePending ||
        this.shuttingDown ||
        this.ttsActive ||
        !this.voiceMlListeningWanted;
      if (cancelBeforeStart) {
        this.voiceMlStopAfterEnablePending = false;
        if (this.shuttingDown || this.ttsActive || !this.voiceMlListeningWanted) {
          this.voiceMlListeningWanted = false;
        }
        this.requestVoiceMlStop();
        return;
      }
      if (this.isListening || this.voiceMlStopRequestPending) {
        return;
      }
      this.isListening = true;
      this.setListeningStatus('Listening...');
      print(`[SpeechRecognition] VoiceML listening started (${this.instanceId})`);
      if (this.debugLogging) {
        print(`[SpeechRecognition] Listening started (${this.instanceId})`);
      }
      try {
        module.startListening(options);
      } catch (e) {
        this.isListening = false;
        this.voiceMlListeningWanted = false;
        this.requestVoiceMlStop();
        print('[SpeechRecognition] startListening failed: ' + e);
        return;
      }
      if (
        !this.autoStartListening &&
        !this.agentSessionActive &&
        this.postItCaptureDepth === 0 &&
        !this.prewarmRequested
      ) {
        this.startListeningWindowTimer();
      }
    });

    module.onListeningDisabled.add(() => {
      if (this.shuttingDown) {
        this.voiceMlEnableRequestPending = false;
        this.voiceMlStopAfterEnablePending = false;
        this.voiceMlStopRequestPending = false;
        this.isListening = false;
        return;
      }
      this.voiceMlEnableRequestPending = false;
      this.voiceMlStopAfterEnablePending = false;
      this.voiceMlStopRequestPending = false;
      this.isListening = false;
      this.setListeningStatus('Microphone paused');
      if (this.debugLogging) {
        print(`[SpeechRecognition] Listening stopped (${this.instanceId})`);
      }
      if (
        !this.shuttingDown &&
        !this.ttsActive &&
        this.voiceMlListeningWanted
      ) {
        this.ensureListening();
      }
    });

    module.onListeningError.add((eventErrorArgs) => {
      if (this.shuttingDown) {
        return;
      }
      this.voiceMlEnableRequestPending = false;
      this.voiceMlStopAfterEnablePending = false;
      this.voiceMlStopRequestPending = false;
      this.isListening = false;
      this.voiceMlListeningWanted = false;
      this.setListeningStatus('Microphone error');
      const now = getTime();
      if (now - this.lastVoiceMlErrorLogAt >= 5) {
        this.lastVoiceMlErrorLogAt = now;
        print(
          `[SpeechRecognition] Error: ${eventErrorArgs.error} | ${eventErrorArgs.description}`
        );
      }
    });

    module.onListeningUpdate.add((eventArgs) => {
      if (this.shuttingDown) {
        return;
      }
      this.applyTranscript(
        String(eventArgs.transcription || ''),
        eventArgs.isFinalTranscription
      );
    });
  }

  private startListeningWindowTimer(): void {
    if (
      this.agentSessionActive ||
      this.autoStartListening ||
      this.postItCaptureDepth > 0 ||
      this.prewarmRequested ||
      this.backend === 'asr'
    ) {
      return;
    }

    this.cancelListeningWindowTimer();
    this.listeningWindowEvent = this.createEvent('DelayedCallbackEvent');
    this.listeningWindowEvent.bind(() => {
      if (this.shuttingDown) {
        return;
      }
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

    const transcript = this.limitTranscriptForDisplay(this.getLiveTranscript());
    const key = `${isListening ? 1 : 0}|${transcript}`;
    if (key === this.lastPushedTranscriptKey) {
      return;
    }
    this.lastPushedTranscriptKey = key;
    panel.showSpeechTranscript(transcript, isListening);
  }
}

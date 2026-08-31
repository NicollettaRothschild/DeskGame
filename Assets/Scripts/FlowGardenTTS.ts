import {
  getSharedSpeechRecognition,
  registerFlowGardenTts,
  unregisterFlowGardenTts,
} from './FlowGardenServiceRegistry';
import { SpecsApiClient } from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';

/** Estimate spoken duration so we keep the mic suppressed while TTS is audible. */
export function estimateSpeechDurationSec(text: string): number {
  const words = String(text || '')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
  return Math.max(1.4, Math.min(18, words * 0.5 + 0.4));
}

/**
 * Flow Garden TTS — Lens native VoiceML TTS with optional Arvis ElevenLabs when paired.
 * Pattern adapted from Voice Arena TextToSpeechController.js.
 */
@component
export class FlowGardenTTS extends BaseScriptComponent {
  @input
  @allowUndefined
  ttsModule!: TextToSpeechModule;

  @input
  @allowUndefined
  specsApi!: SpecsApiClient;

  @input
  @allowUndefined
  deviceRegistry!: SpecsDeviceRegistry;

  @input
  voiceName: string = 'Sasha';

  @input('float')
  speed: number = 1;

  @input
  preferArvisVoiceWhenPaired: boolean = false;

  @input
  agentName: string = 'Arvis';

  @input
  debugLogging: boolean = false;

  @input('float')
  cloudTtsTimeoutSec: number = 8;

  @input('float')
  nativeVoiceTimeoutSec: number = 7;

  @input('float')
  speakingLockTimeoutSec: number = 24;

  private static readonly VOICE_COMMAND_SUPPRESS_SEC = 5;

  private audioPlayer: AudioComponent | null = null;
  private speaking = false;
  private speakingStartedAt = -9999;
  private speechRequestId = 0;
  private speakingDone: ((ok: boolean) => void) | null = null;
  private suppressVoiceCommandsUntil = 0;
  private cloudTtsDisabled = false;
  private cloudTtsFailureLogged = false;
  private destroyed = false;

  onAwake(): void {
    this.destroyed = false;
    registerFlowGardenTts(this);
    this.createEvent('OnStartEvent').bind(() => {
      this.configureAudioPlayer();
      this.ensureAudioListener();
    });
    this.createEvent('UpdateEvent').bind(() => this.recoverStaleSpeakingLock());
    print('[FlowGardenTTS] registered');
  }

  onDestroy(): void {
    this.destroyed = true;
    this.speechRequestId += 1;
    if (!isNull(this.audioPlayer)) {
      try {
        this.audioPlayer.stop(false);
      } catch (_error) {
        // The audio component may already be invalid during teardown.
      }
    }
    this.speaking = false;
    this.speakingDone = null;
    this.suppressVoiceCommandsUntil = 0;
    unregisterFlowGardenTts(this);
  }

  private recoverStaleSpeakingLock(): void {
    if (this.destroyed || !this.speaking) {
      return;
    }

    const timeoutSec = Math.max(8, Number(this.speakingLockTimeoutSec) || 24);
    if (getTime() - this.speakingStartedAt <= timeoutSec) {
      return;
    }

    print('[FlowGardenTTS] recovering stale speaking lock');
    this.speaking = false;
    this.speechRequestId += 1;
    this.suppressVoiceCommandsUntil = Math.min(
      this.suppressVoiceCommandsUntil,
      getTime() + 1
    );
    const speech = getSharedSpeechRecognition();
    if (!isNull(speech)) {
      speech.resumeAfterTtsPlayback();
    }
    const onDone = this.speakingDone;
    this.speakingDone = null;
    if (onDone) {
      onDone(false);
    }
  }

  private configureAudioPlayer(): void {
    if (this.destroyed || isNull(this.audioPlayer)) {
      return;
    }
    try {
      const configured = this.audioPlayer as AudioComponent & { playbackMode?: number };
      if (typeof configured.playbackMode !== 'undefined') {
        configured.playbackMode = Audio.PlaybackMode.LowLatency;
      }
    } catch (e) {
      if (this.debugLogging) {
        print('[FlowGardenTTS] LowLatency unavailable: ' + e);
      }
    }
  }

  private ensureAudioPlayer(): AudioComponent | null {
    if (this.destroyed) {
      return null;
    }
    if (isNull(this.audioPlayer)) {
      this.audioPlayer = this.getSceneObject().createComponent(
        'Component.AudioComponent'
      ) as AudioComponent;
      this.configureAudioPlayer();
    }
    if (!isNull(this.audioPlayer)) {
      this.audioPlayer.enabled = true;
    }
    return this.audioPlayer;
  }

  private ensureAudioListener(): void {
    if (this.destroyed) {
      return;
    }

    try {
      const rootCount = global.scene.getRootObjectsCount();
      for (let i = 0; i < rootCount; i++) {
        const cameraObject = this.findCameraObjectRecursive(
          global.scene.getRootObject(i)
        );
        if (isNull(cameraObject)) {
          continue;
        }

        const listener = cameraObject.getComponent(
          'Component.AudioListenerComponent'
        );
        if (isNull(listener) && this.debugLogging) {
          print('[FlowGardenTTS] camera has no authored AudioListenerComponent');
        }
        return;
      }
    } catch (e) {
      if (this.debugLogging) {
        print('[FlowGardenTTS] Audio Listener setup failed: ' + e);
      }
    }
  }

  private findCameraObjectRecursive(node: SceneObject): SceneObject | null {
    if (isNull(node)) {
      return null;
    }

    try {
      if (!isNull(node.getComponent('Component.Camera'))) {
        return node;
      }
    } catch (_error) {
      return null;
    }

    const childCount = node.getChildrenCount();
    for (let i = 0; i < childCount; i++) {
      const found = this.findCameraObjectRecursive(node.getChild(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  public speak(text: string, onDone?: (ok: boolean) => void): void {
    if (this.destroyed) {
      if (onDone) {
        onDone(false);
      }
      return;
    }

    const spokenText = this.cleanSpeechText(text);
    if (!spokenText) {
      if (onDone) {
        onDone(false);
      }
      return;
    }

    if (
      this.speaking &&
      getTime() - this.speakingStartedAt > Math.max(8, this.speakingLockTimeoutSec)
    ) {
      this.recoverStaleSpeakingLock();
    }

    if (this.speaking) {
      print('[FlowGardenTTS] already speaking — skipping overlap');
      if (onDone) {
        onDone(false);
      }
      return;
    }

    this.speaking = true;
    this.speakingStartedAt = getTime();
    const requestId = ++this.speechRequestId;
    this.speakingDone = onDone || null;
    this.beginVoiceCommandSuppression(spokenText);
    print('[FlowGardenTTS] Speaking: ' + spokenText.slice(0, 120));

    let finished = false;
    const finish = (ok: boolean): void => {
      if (this.destroyed || finished || requestId !== this.speechRequestId) {
        return;
      }
      finished = true;
      const delay = this.createEvent('DelayedCallbackEvent');
      delay.bind(() => {
        if (requestId !== this.speechRequestId) {
          return;
        }
        this.speaking = false;
        this.beginVoiceCommandSuppression(spokenText);
        this.speakingDone = null;
        const speech = getSharedSpeechRecognition();
        if (!ok) {
          // Keep the mic paused while callers play a fallback clip.
          if (onDone) {
            onDone(false);
          }
          const hold = this.createEvent('DelayedCallbackEvent');
          hold.bind(() => {
            if (requestId !== this.speechRequestId) {
              return;
            }
            if (!isNull(speech)) {
              speech.clearUtteranceState();
              speech.resumeAfterTtsPlayback();
            }
          });
          hold.reset(1.2);
          return;
        }
        if (!isNull(speech)) {
          speech.clearUtteranceState();
          speech.resumeAfterTtsPlayback();
        }
        if (onDone) {
          onDone(true);
        }
      });
      delay.reset(ok ? estimateSpeechDurationSec(spokenText) : 0.2);
    };

    const beginPlayback = (): void => {
      if (this.destroyed || requestId !== this.speechRequestId) {
        return;
      }
      if (
        this.preferArvisVoiceWhenPaired &&
        !this.cloudTtsDisabled &&
        !isNull(this.specsApi) &&
        !isNull(this.deviceRegistry) &&
        this.deviceRegistry.isPaired() &&
        !this.specsApi.isEditorMockActive()
      ) {
        this.speakViaArvis(spokenText, (ok) => {
          if (ok) {
            finish(true);
            return;
          }
          this.speakViaNative(
            spokenText,
            (nativeOk) => finish(!!nativeOk),
            requestId
          );
        }, requestId);
        return;
      }

      this.speakViaNative(
        spokenText,
        (nativeOk) => finish(!!nativeOk),
        requestId
      );
    };

    const speech = getSharedSpeechRecognition();
    if (!isNull(speech)) {
      speech.pauseForTts(beginPlayback);
      return;
    }
    beginPlayback();
  }

  public isSpeaking(): boolean {
    return this.speaking || getTime() < this.suppressVoiceCommandsUntil;
  }

  /** True only while audio playback is still occupying the speech channel. */
  public isAudioPlaying(): boolean {
    return this.speaking;
  }

  /**
   * Stop speech before a held buddy claims the microphone. This runs from an
   * UpdateEvent, outside native audio and interaction callbacks, so a user
   * grab can safely interrupt onboarding/reply audio instead of waiting on a
   * stale speaking lock.
   */
  public interruptForInteraction(): void {
    if (this.destroyed || !this.speaking) {
      return;
    }

    this.speechRequestId += 1;
    this.speaking = false;
    this.speakingStartedAt = -9999;
    this.speakingDone = null;
    this.suppressVoiceCommandsUntil = Math.min(
      this.suppressVoiceCommandsUntil,
      getTime() + 0.25
    );

    try {
      const player = this.audioPlayer as AudioComponent & {
        stop?: (fade: boolean) => void;
      };
      if (!isNull(player) && typeof player.stop === 'function') {
        player.stop(false);
      }
    } catch (e) {
      if (this.debugLogging) {
        print('[FlowGardenTTS] speech interruption failed: ' + e);
      }
    }

    const speech = getSharedSpeechRecognition();
    if (!isNull(speech)) {
      try {
        speech.resumeAfterTtsPlayback();
      } catch (e) {
        if (this.debugLogging) {
          print('[FlowGardenTTS] speech resume after interruption failed: ' + e);
        }
      }
    }
  }

  public isBlockingVoiceCommands(): boolean {
    return this.speaking || getTime() < this.suppressVoiceCommandsUntil;
  }

  private beginVoiceCommandSuppression(spokenText?: string): void {
    const textLen = String(spokenText || '').length;
    const seconds = Math.min(
      20,
      Math.max(FlowGardenTTS.VOICE_COMMAND_SUPPRESS_SEC, textLen * 0.06)
    );
    this.suppressVoiceCommandsUntil = Math.max(
      this.suppressVoiceCommandsUntil,
      getTime() + seconds
    );
    const speech = getSharedSpeechRecognition();
    if (!isNull(speech)) {
      speech.clearUtteranceState();
      speech.suppressVoiceCommandsFor(seconds);
    }
  }

  private speakViaArvis(
    text: string,
    onDone: (ok: boolean) => void,
    requestId: number
  ): void {
    if (this.destroyed || requestId !== this.speechRequestId) {
      return;
    }
    if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      onDone(false);
      return;
    }

    const timeout = this.createEvent('DelayedCallbackEvent');
    let settled = false;
    const settle = (ok: boolean): void => {
      if (
        this.destroyed ||
        requestId !== this.speechRequestId ||
        settled
      ) {
        return;
      }
      settled = true;
      timeout.enabled = false;
      onDone(ok);
    };
    timeout.bind(() => {
      if (this.debugLogging && !settled) {
        print('[FlowGardenTTS] Arvis TTS timed out — falling back to native');
      }
      settle(false);
    });
    timeout.reset(Math.max(3, this.cloudTtsTimeoutSec));

    try {
      this.specsApi.speakAgent(
        this.deviceRegistry.getDeviceId(),
        this.deviceRegistry.getDeviceSecret(),
        text,
        this.agentName,
        (result, error) => {
          if (
            this.destroyed ||
            requestId !== this.speechRequestId ||
            settled
          ) {
            return;
          }
          if (!result || !result.audioBase64) {
            if (this.shouldDisableCloudTts(error)) {
              this.disableCloudTts(error || 'remote credential rejected');
            }
            if (this.debugLogging) {
              print('[FlowGardenTTS] Arvis TTS failed: ' + (error || 'no audio'));
            }
            settle(false);
            return;
          }

          // The network request succeeded; allow a short second window for the
          // RemoteMediaModule to decode and create the AudioTrackAsset.
          timeout.reset(5);
          this.playBase64Audio(
            result.audioBase64,
            (played) => {
              if (
                this.destroyed ||
                requestId !== this.speechRequestId ||
                settled
              ) {
                return;
              }
              if (this.debugLogging) {
                print(
                  '[FlowGardenTTS] Arvis voice played=' +
                    played +
                    ' voice=' +
                    (result.voiceId || '')
                );
              }
              settle(played);
            },
            requestId
          );
        }
      );
    } catch (e) {
      if (this.debugLogging) {
        print('[FlowGardenTTS] Arvis TTS request threw: ' + e);
      }
      settle(false);
    }
  }

  private speakViaNative(
    text: string,
    onDone: ((ok: boolean) => void) | undefined,
    requestId: number
  ): void {
    if (this.destroyed || requestId !== this.speechRequestId) {
      return;
    }
    if (isNull(this.ttsModule)) {
      print('[FlowGardenTTS] Missing TextToSpeechModule asset');
      if (onDone) {
        onDone(false);
      }
      return;
    }

    const nativeText = String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 380);
    if (!nativeText) {
      if (onDone) {
        onDone(false);
      }
      return;
    }

    // Only retry known Specs voices. "Voice 1" is not a valid native voice
    // and caused deterministic Bad Configuration errors after transient failures.
    const voices = [this.voiceName, 'Sasha', 'Sam'].filter((name, index, all) => {
      return !!name && all.indexOf(name) === index;
    });

    let activeAttemptId = 0;
    const tryVoice = (voiceIndex: number): void => {
      if (this.destroyed || requestId !== this.speechRequestId) {
        return;
      }
      if (voiceIndex >= voices.length) {
        if (onDone) {
          onDone(false);
        }
        return;
      }

      const attemptId = ++activeAttemptId;
      let attemptSettled = false;
      const failAttempt = (reason: string): void => {
        if (
          this.destroyed ||
          requestId !== this.speechRequestId ||
          attemptSettled ||
          attemptId !== activeAttemptId
        ) {
          return;
        }
        attemptSettled = true;
        if (this.debugLogging) {
          print(
            `[FlowGardenTTS] Native voice unavailable (${voices[voiceIndex]}): ${reason}`
          );
        }
        tryVoice(voiceIndex + 1);
      };
      const timeout = this.createEvent('DelayedCallbackEvent');
      timeout.bind(() => failAttempt('timeout'));
      timeout.reset(Math.max(3, this.nativeVoiceTimeoutSec));

      try {
        const options = TextToSpeech.Options.create();
        options.voiceName = voices[voiceIndex];
        this.ttsModule.synthesize(
          nativeText,
          options,
          (audioTrack) => {
            if (
              this.destroyed ||
              requestId !== this.speechRequestId ||
              attemptSettled ||
              attemptId !== activeAttemptId
            ) {
              return;
            }
            attemptSettled = true;
            const player = this.ensureAudioPlayer();
            if (isNull(player) || isNull(audioTrack)) {
              tryVoice(voiceIndex + 1);
              return;
            }
            if (
              !this.playAudioTrack(
                player as AudioComponent,
                audioTrack as AudioTrackAsset
              )
            ) {
              tryVoice(voiceIndex + 1);
              return;
            }
            if (this.debugLogging) {
              print('[FlowGardenTTS] Native voice played voice=' + voices[voiceIndex]);
            }
            if (onDone) {
              onDone(true);
            }
          },
          (error, description) => {
            failAttempt(`${error}: ${description}`);
          }
        );
      } catch (e) {
        failAttempt('threw: ' + e);
      }
    };

    tryVoice(0);
  }

  private playBase64Audio(
    base64: string,
    onDone: (ok: boolean) => void,
    requestId: number
  ): void {
    if (this.destroyed || requestId !== this.speechRequestId) {
      return;
    }
    const internetModule = this.resolveInternetModule();
    const remoteMediaModule = this.resolveRemoteMediaModule();
    const audioPlayer = this.ensureAudioPlayer();
    if (isNull(internetModule) || isNull(remoteMediaModule) || isNull(audioPlayer)) {
      onDone(false);
      return;
    }

    try {
      const bytes = this.decodeBase64(base64);
      if (!bytes || bytes.length === 0) {
        onDone(false);
        return;
      }

      const binaryParts: string[] = [];
      for (let start = 0; start < bytes.length; start += 8192) {
        let part = '';
        const end = Math.min(bytes.length, start + 8192);
        for (let i = start; i < end; i++) {
          part += String.fromCharCode(bytes[i]);
        }
        binaryParts.push(part);
      }
      const binary = binaryParts.join('');

      const blob = (internetModule as InternetModule).makeResourceFromBlob(
        new Blob([binary], { type: 'audio/mpeg' })
      );

      remoteMediaModule.loadResourceAsAudioTrackAsset(
        blob,
        (audioTrack) => {
          if (
            this.destroyed ||
            requestId !== this.speechRequestId
          ) {
            return;
          }
          const player = this.ensureAudioPlayer();
          if (isNull(player) || isNull(audioTrack)) {
            onDone(false);
            return;
          }
          if (
            !this.playAudioTrack(
              player as AudioComponent,
              audioTrack as AudioTrackAsset
            )
          ) {
            onDone(false);
            return;
          }
          onDone(true);
        },
        (errorMessage) => {
          if (
            this.destroyed ||
            requestId !== this.speechRequestId
          ) {
            return;
          }
          if (this.debugLogging) {
            print('[FlowGardenTTS] Remote audio load failed: ' + errorMessage);
          }
          onDone(false);
        }
      );
    } catch (e) {
      if (this.destroyed || requestId !== this.speechRequestId) {
        return;
      }
      if (this.debugLogging) {
        print('[FlowGardenTTS] Base64 audio playback failed: ' + e);
      }
      onDone(false);
    }
  }

  private playAudioTrack(player: AudioComponent, audioTrack: AudioTrackAsset): boolean {
    if (this.destroyed) {
      return false;
    }
    try {
      player.audioTrack = audioTrack;
      player.play(1);
      return true;
    } catch (e) {
      if (this.debugLogging) {
        print('[FlowGardenTTS] audio playback failed: ' + e);
      }
      return false;
    }
  }

  private resolveInternetModule(): InternetModule | null {
    try {
      return require('LensStudio:InternetModule') as InternetModule;
    } catch {
      return null;
    }
  }

  private resolveRemoteMediaModule(): RemoteMediaModule | null {
    try {
      return require('LensStudio:RemoteMediaModule') as RemoteMediaModule;
    } catch {
      return null;
    }
  }

  private shouldDisableCloudTts(error?: string): boolean {
    return /api key|only valid api keys|unauthori[sz]ed|forbidden|HTTP 401|HTTP 403/i.test(
      String(error || '')
    );
  }

  private disableCloudTts(reason: string): void {
    this.cloudTtsDisabled = true;
    if (!this.cloudTtsFailureLogged) {
      this.cloudTtsFailureLogged = true;
      print('[FlowGardenTTS] Cloud TTS disabled for this session: ' + reason);
    }
  }

  private decodeBase64(base64: string): Uint8Array | null {
    const cleaned = String(base64 || '').replace(/\s/g, '');
    if (!cleaned) {
      return null;
    }

    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lookup: Record<string, number> = {};
    for (let i = 0; i < alphabet.length; i++) {
      lookup[alphabet.charAt(i)] = i;
    }

    const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0;
    const outputLength = Math.floor((cleaned.length * 3) / 4) - padding;
    const bytes = new Uint8Array(outputLength);
    let byteIndex = 0;

    for (let i = 0; i < cleaned.length; i += 4) {
      const c1 = lookup[cleaned.charAt(i)] ?? 0;
      const c2 = lookup[cleaned.charAt(i + 1)] ?? 0;
      const c3 = lookup[cleaned.charAt(i + 2)] ?? 0;
      const c4 = lookup[cleaned.charAt(i + 3)] ?? 0;

      const block = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4;
      if (byteIndex < outputLength) {
        bytes[byteIndex++] = (block >> 16) & 0xff;
      }
      if (byteIndex < outputLength) {
        bytes[byteIndex++] = (block >> 8) & 0xff;
      }
      if (byteIndex < outputLength) {
        bytes[byteIndex++] = block & 0xff;
      }
    }

    return bytes;
  }

  private cleanSpeechText(text: string): string {
    return String(text || '')
      .replace(/\[\[[^\]]+\]\]/g, ' ')
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }
}

import { getSharedSpeechRecognition, registerFlowGardenTts } from './FlowGardenServiceRegistry';
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
  preferArvisVoiceWhenPaired: boolean = true;

  @input
  agentName: string = 'Arvis';

  @input
  debugLogging: boolean = true;

  private static readonly VOICE_COMMAND_SUPPRESS_SEC = 5;

  private audioPlayer: AudioComponent | null = null;
  private speaking = false;
  private suppressVoiceCommandsUntil = 0;

  onAwake(): void {
    registerFlowGardenTts(this);
    this.audioPlayer = this.getSceneObject().createComponent('Component.AudioComponent') as AudioComponent;
    this.createEvent('OnStartEvent').bind(() => this.configureAudioPlayer());
    print('[FlowGardenTTS] registered');
  }

  private configureAudioPlayer(): void {
    if (isNull(this.audioPlayer)) {
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

  public speak(text: string, onDone?: (ok: boolean) => void): void {
    const spokenText = this.cleanSpeechText(text);
    if (!spokenText) {
      if (onDone) {
        onDone(false);
      }
      return;
    }

    if (this.speaking) {
      print('[FlowGardenTTS] already speaking — skipping overlap');
      if (onDone) {
        onDone(false);
      }
      return;
    }

    this.speaking = true;
    this.beginVoiceCommandSuppression(spokenText);
    print('[FlowGardenTTS] Speaking: ' + spokenText.slice(0, 120));

    const finish = (ok: boolean): void => {
      // Native/cloud play() returns immediately — wait out spoken duration before unblocking mic.
      const delay = this.createEvent('DelayedCallbackEvent');
      delay.bind(() => {
        this.speaking = false;
        this.beginVoiceCommandSuppression(spokenText);
        const speech = getSharedSpeechRecognition();
        if (!isNull(speech)) {
          speech.clearUtteranceState();
        }
        if (onDone) {
          onDone(ok);
        }
      });
      delay.reset(estimateSpeechDurationSec(spokenText));
    };

    if (
      this.preferArvisVoiceWhenPaired &&
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
        this.speakViaNative(spokenText, (nativeOk) => finish(!!nativeOk));
      });
      return;
    }

    this.speakViaNative(spokenText, (nativeOk) => finish(!!nativeOk));
  }

  public isSpeaking(): boolean {
    return this.speaking || getTime() < this.suppressVoiceCommandsUntil;
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

  private speakViaArvis(text: string, onDone: (ok: boolean) => void): void {
    if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      onDone(false);
      return;
    }

    this.specsApi.speakAgent(
      this.deviceRegistry.getDeviceId(),
      this.deviceRegistry.getDeviceSecret(),
      text,
      this.agentName,
      (result, error) => {
        if (!result || !result.audioBase64) {
          if (this.debugLogging) {
            print('[FlowGardenTTS] Arvis TTS failed: ' + (error || 'no audio'));
          }
          onDone(false);
          return;
        }

        this.playBase64Audio(result.audioBase64, (played) => {
          if (this.debugLogging) {
            print('[FlowGardenTTS] Arvis voice played=' + played + ' voice=' + (result.voiceId || ''));
          }
          onDone(played);
        });
      }
    );
  }

  private speakViaNative(text: string, onDone?: (ok: boolean) => void): void {
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

    const voices = [this.voiceName, 'Sasha', 'Sam', 'Voice 1'].filter((name, index, all) => {
      return !!name && all.indexOf(name) === index;
    });

    const tryVoice = (voiceIndex: number): void => {
      if (voiceIndex >= voices.length) {
        if (onDone) {
          onDone(false);
        }
        return;
      }

      try {
        const options = TextToSpeech.Options.create();
        options.voiceName = voices[voiceIndex];
        this.ttsModule.synthesize(
          nativeText,
          options,
          (audioTrack) => {
            if (isNull(this.audioPlayer)) {
              if (onDone) {
                onDone(false);
              }
              return;
            }
            this.audioPlayer.audioTrack = audioTrack;
            this.audioPlayer.play(1);
            if (this.debugLogging) {
              print('[FlowGardenTTS] Native voice played voice=' + voices[voiceIndex]);
            }
            if (onDone) {
              onDone(true);
            }
          },
          (error, description) => {
            print(
              `[FlowGardenTTS] Native TTS error ${error}: ${description} (voice=${voices[voiceIndex]})`
            );
            tryVoice(voiceIndex + 1);
          }
        );
      } catch (e) {
        print('[FlowGardenTTS] Native TTS threw: ' + e);
        tryVoice(voiceIndex + 1);
      }
    };

    tryVoice(0);
  }

  private playBase64Audio(base64: string, onDone: (ok: boolean) => void): void {
    const internetModule = this.resolveInternetModule();
    const remoteMediaModule = this.resolveRemoteMediaModule();
    if (isNull(internetModule) || isNull(remoteMediaModule) || isNull(this.audioPlayer)) {
      onDone(false);
      return;
    }

    try {
      const bytes = this.decodeBase64(base64);
      if (!bytes || bytes.length === 0) {
        onDone(false);
        return;
      }

      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }

      const blob = (internetModule as InternetModule).makeResourceFromBlob(
        new Blob([binary], { type: 'audio/mpeg' })
      );

      remoteMediaModule.loadResourceAsAudioTrackAsset(
        blob,
        (audioTrack) => {
          if (isNull(this.audioPlayer)) {
            onDone(false);
            return;
          }
          this.audioPlayer.audioTrack = audioTrack;
          this.audioPlayer.play(1);
          onDone(true);
        },
        (errorMessage) => {
          if (this.debugLogging) {
            print('[FlowGardenTTS] Remote audio load failed: ' + errorMessage);
          }
          onDone(false);
        }
      );
    } catch (e) {
      if (this.debugLogging) {
        print('[FlowGardenTTS] Base64 audio playback failed: ' + e);
      }
      onDone(false);
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

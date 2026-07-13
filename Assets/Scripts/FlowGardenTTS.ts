import { SpecsApiClient } from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';

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
  agentName: string = 'Stephany';

  @input
  debugLogging: boolean = true;

  private audioPlayer: AudioComponent | null = null;
  private speaking = false;

  onAwake(): void {
    this.audioPlayer = this.getSceneObject().createComponent('Component.AudioComponent') as AudioComponent;
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
      if (this.debugLogging) {
        print('[FlowGardenTTS] already speaking — skipping overlap');
      }
    }

    this.speaking = true;
    if (this.debugLogging) {
      print('[FlowGardenTTS] Speaking: ' + spokenText.slice(0, 120));
    }

    if (
      this.preferArvisVoiceWhenPaired &&
      !isNull(this.specsApi) &&
      !isNull(this.deviceRegistry) &&
      (this.deviceRegistry.isPaired() || this.specsApi.isEditorMockActive())
    ) {
      this.speakViaArvis(spokenText, (ok) => {
        if (ok) {
          this.speaking = false;
          if (onDone) {
            onDone(true);
          }
          return;
        }
        this.speakViaNative(spokenText, onDone);
      });
      return;
    }

    this.speakViaNative(spokenText, onDone);
  }

  public isSpeaking(): boolean {
    return this.speaking;
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
      if (this.debugLogging) {
        print('[FlowGardenTTS] Missing TextToSpeechModule asset');
      }
      this.speaking = false;
      if (onDone) {
        onDone(false);
      }
      return;
    }

    const options = TextToSpeech.Options.create();
    options.voiceName = this.voiceName;

    this.ttsModule.synthesize(
      text,
      options,
      (audioTrack) => {
        if (isNull(this.audioPlayer)) {
          this.speaking = false;
          if (onDone) {
            onDone(false);
          }
          return;
        }
        this.audioPlayer.audioTrack = audioTrack;
        this.audioPlayer.play(1);
        this.speaking = false;
        if (onDone) {
          onDone(true);
        }
      },
      (error, description) => {
        print('[FlowGardenTTS] Native TTS error ' + error + ': ' + description);
        this.speaking = false;
        if (onDone) {
          onDone(false);
        }
      }
    );
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

import { getSharedSpeechRecognition } from './FlowGardenServiceRegistry';
import { SpeechRecognition } from './SpeechRecognition';

type PublicEventLike<T> = {
  add(callback: (event: T) => void): void;
};

type InteractableLike = ScriptComponent & {
  onInteractorTriggerStart?: PublicEventLike<unknown>;
  onTriggerStart?: PublicEventLike<unknown>;
  onInteractorTriggerEnd?: PublicEventLike<unknown>;
  onInteractorTriggerEndOutside?: PublicEventLike<unknown>;
  onTriggerEnd?: PublicEventLike<unknown>;
  onTriggerEndOutside?: PublicEventLike<unknown>;
  onDragStart?: PublicEventLike<unknown>;
  onDragEnd?: PublicEventLike<unknown>;
  onTriggerCanceled?: PublicEventLike<unknown>;
};

const MAX_NOTE_CHARS = 140;
const TEXT_HALF_WIDTH = 3.6;
const TEXT_HALF_HEIGHT = 3.2;
const TEXT_SIZE = 26;
const NOTE_INK_COLOR = new vec4(0.18, 0.18, 0.2, 1);
const TEXT3D_COLOR_PASS_KEYS = [
  'frontCapStartingColor',
  'outerEdgeStartingColor',
  'InnerEdgeStartingColor',
];

/**
 * While a post-it is grabbed, live speech transcript is written onto the note.
 */
@component
export class PostItNoteTranscript extends BaseScriptComponent {
  @input
  @allowUndefined
  noteInteractable!: ScriptComponent;

  @input
  maxCharacters: number = MAX_NOTE_CHARS;

  @input
  textSize: number = TEXT_SIZE;

  @input
  @allowUndefined
  @label('Display Prefix')
  displayPrefix: string = '';

  @input
  debugLogging: boolean = false;

  private speech: SpeechRecognition | null = null;
  private text3d: Text3D | null = null;
  private textMaterial: Material | null = null;
  private textRoot: SceneObject | null = null;
  private capturing = false;
  private captureOwnerCount = 0;
  private listenerAttached = false;
  private noteText = '';
  private lastWritten = '';
  private interactableBound = false;
  private updateEvent: UpdateEvent | null = null;
  private readonly onTranscript = (text: string, _isFinal: boolean): void => {
    this.applySpokenText(text);
  };

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => {
      this.ensureTextVisual();
      this.resolveSpeech();
      this.bindNoteInteractable();
    });
    this.createEvent('OnDestroyEvent').bind(() => this.teardown());
  }

  /** Called by MainPostItSource while the spawn pull is active. */
  public beginCapture(): void {
    this.captureOwnerCount += 1;
    this.setCapturing(true);
  }

  public endCapture(): void {
    this.captureOwnerCount = Math.max(0, this.captureOwnerCount - 1);
    if (this.captureOwnerCount <= 0) {
      this.setCapturing(false);
    }
  }

  public getNoteText(): string {
    return this.noteText;
  }

  public setNoteText(value: string): void {
    const cleaned = this.truncate(String(value || '').trim());
    this.noteText = cleaned;
    this.writeText(this.formatDisplayText(cleaned));
  }

  private setCapturing(active: boolean): void {
    if (active) {
      if (!this.capturing) {
        this.capturing = true;
        this.debugLog('capture ON');
      }
      this.attachSpeechCapture();
      this.ensureUpdateLoop(true);
      return;
    }

    if (!this.capturing) {
      return;
    }

    this.capturing = false;
    this.detachSpeechCapture();
    this.ensureUpdateLoop(false);
    this.debugLog(`capture OFF text="${this.noteText.slice(0, 48)}"`);
  }

  private attachSpeechCapture(): void {
    this.resolveSpeech();
    if (isNull(this.speech)) {
      return;
    }

    if (!this.listenerAttached) {
      this.speech.addTranscriptListener(this.onTranscript);
      // The note can be grabbed from a native SIK callback. Claim the shared
      // capture slot there, but let the UpdateEvent prewarm the microphone.
      this.speech.beginPostItCapture(false);
      this.listenerAttached = true;
      this.speech.clearUtteranceState();
    }
  }

  private detachSpeechCapture(): void {
    if (!this.listenerAttached || isNull(this.speech)) {
      this.listenerAttached = false;
      return;
    }
    this.speech.removeTranscriptListener(this.onTranscript);
    this.speech.endPostItCapture();
    this.listenerAttached = false;
  }

  private applySpokenText(raw: string): void {
    if (!this.capturing) {
      return;
    }

    const cleaned = this.truncate(String(raw || '').trim());
    if (!cleaned) {
      return;
    }

    this.noteText = cleaned;
    this.writeText(this.formatDisplayText(cleaned));
  }

  private writeText(value: string): void {
    this.ensureTextVisual();
    if (isNull(this.text3d)) {
      return;
    }
    if (value === this.lastWritten) {
      return;
    }
    this.lastWritten = value;
    this.text3d.text = value;
    if (!isNull(this.textRoot)) {
      this.textRoot.enabled = value.length > 0;
    }
  }

  private truncate(text: string): string {
    const maxChars = Math.max(24, this.maxCharacters || MAX_NOTE_CHARS);
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, maxChars - 1) + '…';
  }

  private resolveSpeech(): void {
    if (!isNull(this.speech)) {
      return;
    }
    this.speech = getSharedSpeechRecognition();
  }

  private bindNoteInteractable(): void {
    if (this.interactableBound) {
      return;
    }

    const interactable = this.resolveInteractable();
    if (isNull(interactable)) {
      this.debugLog('no Interactable yet — re-grab capture unavailable');
      return;
    }

    const start =
      interactable.onInteractorTriggerStart ||
      interactable.onTriggerStart ||
      interactable.onDragStart;
    if (start) {
      start.add(() => this.beginCapture());
    }

    const endEvents = [
      interactable.onInteractorTriggerEnd,
      interactable.onInteractorTriggerEndOutside,
      interactable.onTriggerEnd,
      interactable.onTriggerEndOutside,
      interactable.onDragEnd,
      interactable.onTriggerCanceled,
    ];
    for (let i = 0; i < endEvents.length; i++) {
      const evt = endEvents[i];
      if (evt) {
        evt.add(() => this.endCapture());
      }
    }

    this.interactableBound = true;
    this.debugLog('bound note Interactable for re-grab capture');
  }

  private resolveInteractable(): InteractableLike | null {
    if (!isNull(this.noteInteractable)) {
      return this.noteInteractable as InteractableLike;
    }

    const components = this.getSceneObject().getComponents('Component.ScriptComponent');
    for (let i = 0; i < components.length; i++) {
      const component = components[i] as InteractableLike;
      if (
        component &&
        (component.onInteractorTriggerStart ||
          component.onTriggerStart ||
          component.onDragStart)
      ) {
        this.noteInteractable = component;
        return component;
      }
    }
    return null;
  }

  private ensureUpdateLoop(enabled: boolean): void {
    if (!enabled) {
      if (!isNull(this.updateEvent)) {
        this.updateEvent.enabled = false;
      }
      return;
    }

    if (isNull(this.updateEvent)) {
      this.updateEvent = this.createEvent('UpdateEvent');
      this.updateEvent.bind(() => this.onCaptureUpdate());
    }
    this.updateEvent.enabled = true;
  }

  private onCaptureUpdate(): void {
    if (!this.capturing) {
      return;
    }

    if (!this.listenerAttached) {
      this.attachSpeechCapture();
    }

    if (isNull(this.speech)) {
      return;
    }

    if (!this.speech.isMicrophoneListening()) {
      // UpdateEvent is safe to start ASR. Hover prewarm never opens the mic.
      this.speech.pumpListening();
    }

    const live = this.speech.getDisplayTranscript();
    if (live) {
      this.applySpokenText(live);
    }
  }

  private ensureTextVisual(): void {
    if (!isNull(this.text3d)) {
      return;
    }

    const note = this.getSceneObject();
    const localScale = note.getTransform().getLocalScale();
    const invX = 1 / Math.max(0.001, Math.abs(localScale.x));
    const invY = 1 / Math.max(0.001, Math.abs(localScale.y));
    const invZ = 1 / Math.max(0.001, Math.abs(localScale.z));

    const root = global.scene.createSceneObject('NoteText');
    root.enabled = false;
    root.setParent(note);
    root.layer = note.layer;
    // Sit just above the pad surface; rotate so glyphs face +Y (readable from above).
    root.getTransform().setLocalPosition(new vec3(0, 0.55, 0));
    root.getTransform().setLocalRotation(quat.fromEulerAngles(-Math.PI * 0.5, 0, 0));
    root.getTransform().setLocalScale(new vec3(invX, invZ, invY));

    const text3d = root.createComponent('Component.Text3D') as Text3D;
    text3d.enabled = true;
    text3d.text = '';
    text3d.size = Math.max(12, this.textSize || TEXT_SIZE);
    text3d.extrusionDepth = 0.08;
    text3d.lineSpacing = 1.05;
    text3d.horizontalAlignment = HorizontalAlignment.Center;
    text3d.verticalAlignment = VerticalAlignment.Center;
    text3d.horizontalOverflow = HorizontalOverflow.Wrap;
    text3d.verticalOverflow = VerticalOverflow.Overflow;
    text3d.worldSpaceRect = Rect.create(
      -TEXT_HALF_WIDTH,
      TEXT_HALF_WIDTH,
      -TEXT_HALF_HEIGHT,
      TEXT_HALF_HEIGHT
    );
    text3d.renderOrder = 12;

    try {
      const template = requireAsset('Text3D.mat') as Material;
      this.textMaterial = template.clone();
      text3d.mainMaterial = this.textMaterial;
      this.applyInkColor(NOTE_INK_COLOR);
    } catch (e) {
      this.debugLog('Text3D.mat missing — using default material');
    }

    this.textRoot = root;
    this.text3d = text3d;

    if (this.noteText) {
      this.writeText(this.formatDisplayText(this.noteText));
      root.enabled = true;
    }
  }

  private formatDisplayText(value: string): string {
    const prefix = String(this.displayPrefix || '').trim();
    return prefix ? `${prefix}: ${value}` : value;
  }

  private applyInkColor(color: vec4): void {
    if (isNull(this.textMaterial)) {
      return;
    }
    const pass = this.textMaterial.mainPass as unknown as Record<string, vec4>;
    for (let i = 0; i < TEXT3D_COLOR_PASS_KEYS.length; i++) {
      const key = TEXT3D_COLOR_PASS_KEYS[i];
      if (typeof pass[key] !== 'undefined') {
        pass[key] = color;
      }
    }
  }

  private teardown(): void {
    this.detachSpeechCapture();
    this.capturing = false;
    this.captureOwnerCount = 0;
    if (!isNull(this.updateEvent)) {
      this.updateEvent.enabled = false;
    }
  }

  private debugLog(message: string): void {
    if (!this.debugLogging) {
      return;
    }
    print(`[PostItNoteTranscript] ${this.getSceneObject().name}: ${message}`);
  }
}

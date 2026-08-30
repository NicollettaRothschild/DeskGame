import {
  GhostWaterDisplacementConfig,
  sampleGhostWaterDisplacementY,
} from './GhostWaterDisplacement';

/** Keep in sync with SPEECH_BUBBLE_MAX_CHARS in FlowGardenTTS.ts */
const DEFAULT_MAX_CHARACTERS = 88;

export type GhostSpeechPhase = 'idle' | 'listening' | 'thinking' | 'reply' | 'error';

/** Layout tuning — text rect stays inside the background with padding. */
const TEXT_HALF_WIDTH = 5.1;
const TEXT_SIZE = 30;
/** Conservative wrap estimate so worldSpaceRect is tall enough (avoids vertical clip). */
const CHARS_PER_LINE = 24;
const LINE_HEIGHT = 1.12;
const BUBBLE_PAD_X = 2.8;
const BUBBLE_PAD_Y = 3.0;
const BUBBLE_DEPTH = 0.35;
const MIN_BUBBLE_WIDTH = 12;
const MIN_BUBBLE_HEIGHT = 7.5;
const KARAOKE_MIN_BUBBLE_HEIGHT = 6.4;
const MIN_TEXT_HALF_HEIGHT = 2.05;
const MAX_TEXT_HALF_HEIGHT = 4.4;
const MAX_BUBBLE_HEIGHT = 18;
const KARAOKE_MAX_LINES = 2;
/** Center above the ghost crown — not in front of the face. */
const BUBBLE_BASE_Y = 0.98;
const BUBBLE_BASE_Z = 0.0;
/** User transcript / listening — readable on dark bubble background. */
const USER_TEXT_COLOR = new vec4(1.0, 0.88, 0.15, 1.0);
/** Arvis reply and error text. */
const AGENT_TEXT_COLOR = new vec4(1.0, 1.0, 1.0, 1.0);
/** Agent-side placeholders (e.g. "Thinking…" with no transcript yet). */
const MUTED_TEXT_COLOR = new vec4(0.62, 0.66, 0.72, 1.0);
const TEXT3D_COLOR_PASS_KEYS = [
  'frontCapStartingColor',
  'outerEdgeStartingColor',
  'InnerEdgeStartingColor',
];

/**
 * Floating speech bubble parented to ArvisGhost — shows live transcript and agent replies.
 */
export class ArvisGhostSpeechBubble {
  private readonly followRoot: SceneObject;
  private readonly host: BaseScriptComponent;
  private readonly scaleCompensation: number;
  private readonly maxCharacters: number;
  private readonly hideDelaySec: number;
  private readonly debugLogging: boolean;
  private readonly bubbleBaseY: number;
  private readonly bubbleBaseZ: number;

  private bubbleRoot: SceneObject | null = null;
  private bubbleText: Text3D | null = null;
  private bubbleTextMaterial: Material | null = null;
  private bubbleBackground: RenderMeshVisual | null = null;
  private lookAt: LookAtComponent | null = null;
  private hideEvent: DelayedCallbackEvent | null = null;
  private built = false;
  private visible = false;
  private lastKey = '';

  constructor(
    followRoot: SceneObject,
    host: BaseScriptComponent,
    options?: {
      scaleCompensation?: number;
      maxCharacters?: number;
      hideDelaySec?: number;
      debugLogging?: boolean;
      /** Local Y above followRoot — raise for taller characters. */
      bubbleBaseY?: number;
      bubbleBaseZ?: number;
    }
  ) {
    this.followRoot = followRoot;
    this.host = host;
    this.scaleCompensation = Math.max(0.1, options?.scaleCompensation ?? 8.4);
    this.maxCharacters = Math.max(40, options?.maxCharacters ?? DEFAULT_MAX_CHARACTERS);
    this.hideDelaySec = Math.max(2, options?.hideDelaySec ?? 14);
    this.debugLogging = options?.debugLogging ?? false;
    this.bubbleBaseY =
      typeof options?.bubbleBaseY === 'number' ? options.bubbleBaseY : BUBBLE_BASE_Y;
    this.bubbleBaseZ =
      typeof options?.bubbleBaseZ === 'number' ? options.bubbleBaseZ : BUBBLE_BASE_Z;
  }

  public showAgentChat(
    phase: GhostSpeechPhase,
    transcript: string,
    response: string | null,
    agentName: string
  ): void {
    if (phase === 'idle') {
      this.hide();
      return;
    }

    this.ensureBuilt();

    const userLine = String(transcript || '').trim();
    const replyLine = String(response || '').trim();
    const label = String(agentName || 'Arvis').trim() || 'Arvis';
    const key = `${phase}|${label}|${userLine}|${replyLine}`;
    if (key === this.lastKey && this.visible) {
      return;
    }
    this.lastKey = key;

    const message = this.formatMessage(phase, userLine, replyLine, label);
    if (!message) {
      this.hide();
      return;
    }

    this.applyBubbleText(message, phase, userLine);
    this.setVisible(true);
    this.cancelHide();

    if (phase === 'reply' || phase === 'error') {
      this.scheduleHide();
    }

    if (this.debugLogging) {
      print(`[ArvisGhostSpeechBubble] ${phase}: ${message.slice(0, 80)}`);
    }
  }

  public hide(): void {
    this.cancelHide();
    this.lastKey = '';
    this.setVisible(false);
  }

  /** Match ghost body wobble + water-shader displacement (same sampling as the eyes). */
  public syncToGhostBody(
    body: SceneObject,
    displacementConfig: GhostWaterDisplacementConfig,
    applyShaderDisplacement: boolean,
    ySquash: number
  ): void {
    if (!this.built || isNull(this.bubbleRoot)) {
      return;
    }

    const bodyTransform = body.getTransform();
    const worldMatrix = bodyTransform.getWorldTransform();
    const bodyWorldScale = bodyTransform.getWorldScale();
    const invWorldScaleY = 1.0 / Math.max(0.001, bodyWorldScale.y);
    const baseY = this.bubbleBaseY * Math.max(0.75, ySquash);
    const anchorLocal = new vec3(0, baseY, this.bubbleBaseZ);
    const anchorWorld = worldMatrix.multiplyPoint(anchorLocal);

    const displacementY = applyShaderDisplacement
      ? sampleGhostWaterDisplacementY(
          anchorWorld.x,
          anchorWorld.z,
          getTime(),
          displacementConfig
        )
      : 0;

    this.bubbleRoot.getTransform().setLocalPosition(
      new vec3(0, baseY + displacementY * invWorldScaleY, this.bubbleBaseZ)
    );
    this.bubbleRoot.getTransform().setLocalRotation(quat.quatIdentity());
  }

  private formatMessage(
    phase: GhostSpeechPhase,
    userLine: string,
    replyLine: string,
    label: string
  ): string {
    if (phase === 'listening') {
      if (userLine) {
        return userLine;
      }
      return 'Listening…';
    }

    if (phase === 'thinking') {
      if (label.toLowerCase() === 'cursor') {
        const statusLine = replyLine || 'Cursor is working…';
        const taskLine = userLine ? `Working on: ${userLine}` : '';
        return this.truncate([statusLine, taskLine].filter(Boolean).join('\n\n'));
      }
      if (userLine) {
        return `You: ${userLine}\n\n…`;
      }
      return 'Thinking…';
    }

    if (phase === 'error') {
      return this.truncate(replyLine || 'Something went wrong.');
    }

    if (phase === 'reply') {
      if (replyLine) {
        return this.truncate(replyLine);
      }
      return `${label} has nothing to say.`;
    }

    return '';
  }

  private truncate(text: string): string {
    const value = String(text || '').trim();
    if (value.length <= this.maxCharacters) {
      return value;
    }
    return value.slice(0, this.maxCharacters - 1) + '…';
  }

  private ensureBuilt(): void {
    if (this.built) {
      return;
    }
    this.built = true;

    const inv = 1 / this.scaleCompensation;
    const root = global.scene.createSceneObject('ArvisSpeechBubble');
    root.enabled = true;
    root.setParent(this.followRoot);
    root.layer = this.followRoot.layer;
    root.getTransform().setLocalPosition(new vec3(0, this.bubbleBaseY, this.bubbleBaseZ));
    root.getTransform().setLocalRotation(quat.quatIdentity());
    root.getTransform().setLocalScale(new vec3(inv, inv, inv));

    const backgroundObj = global.scene.createSceneObject('BubbleBackground');
    backgroundObj.enabled = true;
    backgroundObj.setParent(root);
    backgroundObj.getTransform().setLocalPosition(new vec3(0, 0, -0.04));
    backgroundObj.getTransform().setLocalRotation(quat.fromEulerAngles(0, 0, 0));
    backgroundObj.getTransform().setLocalScale(
      new vec3(MIN_BUBBLE_WIDTH, MIN_BUBBLE_HEIGHT, BUBBLE_DEPTH)
    );

    const background = backgroundObj.createComponent(
      'Component.RenderMeshVisual'
    ) as RenderMeshVisual;
    background.enabled = true;
    background.mesh = requireAsset('Meshes/StarCatchSphere.mesh') as RenderMesh;
    background.mainMaterial = this.createBubbleMaterial(0.88);
    background.renderOrder = 20;
    this.bubbleBackground = background;

    const textObj = global.scene.createSceneObject('BubbleText');
    textObj.enabled = true;
    textObj.setParent(root);
    textObj.getTransform().setLocalPosition(new vec3(0, 0, 0.08));
    textObj.getTransform().setLocalRotation(quat.quatIdentity());
    textObj.getTransform().setLocalScale(new vec3(1, 1, 1));

    const text3d = textObj.createComponent('Component.Text3D') as Text3D;
    text3d.enabled = true;
    text3d.text = '';
    text3d.size = TEXT_SIZE;
    text3d.extrusionDepth = 0.12;
    text3d.lineSpacing = 1.06;
    text3d.horizontalAlignment = HorizontalAlignment.Center;
    text3d.verticalAlignment = VerticalAlignment.Center;
    text3d.horizontalOverflow = HorizontalOverflow.Wrap;
    text3d.verticalOverflow = VerticalOverflow.Overflow;
    // LS 5.15 Text3D bounds API (Inspector Layout Rect).
    text3d.worldSpaceRect = Rect.create(
      -TEXT_HALF_WIDTH,
      TEXT_HALF_WIDTH,
      -MIN_TEXT_HALF_HEIGHT,
      MIN_TEXT_HALF_HEIGHT
    );
    try {
      const template = requireAsset('Text3D.mat') as Material;
      this.bubbleTextMaterial = template.clone();
      text3d.mainMaterial = this.bubbleTextMaterial;
    } catch (e) {
      if (this.debugLogging) {
        print('[ArvisGhostSpeechBubble] Text3D.mat missing — using default material');
      }
    }
    text3d.renderOrder = 21;
    this.bubbleText = text3d;

    const camera = this.findCameraObject();
    if (!isNull(camera)) {
      const lookAt = root.createComponent('Component.LookAtComponent') as LookAtComponent;
      lookAt.target = camera;
      lookAt.lookAtMode = LookAtComponent.LookAtMode.LookAtPoint;
      lookAt.aimVectors = LookAtComponent.AimVectors.ZAimYUp;
      lookAt.worldUpVector = LookAtComponent.WorldUpVector.SceneY;
      this.lookAt = lookAt;
    }

    this.bubbleRoot = root;
    root.enabled = false;
    this.visible = false;
  }

  private createBubbleMaterial(alpha: number): Material {
    let template: Material | null = null;
    try {
      template = requireAsset('Materials & Shaders/Mat_AIChatBlack.mat') as Material;
    } catch (e) {
      template = null;
    }

    const material = !isNull(template) ? template.clone() : null;
    if (isNull(material)) {
      return requireAsset('Text3D.mat') as Material;
    }

    const pass = material.mainPass;
    if (typeof pass.depthWrite !== 'undefined') {
      pass.depthWrite = false;
    }
    if (typeof pass.depthTest !== 'undefined') {
      pass.depthTest = true;
    }
    if (typeof pass.blendMode !== 'undefined') {
      pass.blendMode = BlendMode.Normal;
    }
    if (typeof pass.baseColor !== 'undefined') {
      pass.baseColor = new vec4(0.07, 0.09, 0.12, alpha);
    }
    return material;
  }

  private applyBubbleText(
    message: string,
    phase: GhostSpeechPhase,
    userLine: string
  ): void {
    if (!isNull(this.bubbleText)) {
      this.bubbleText.text = message;
    }
    this.applyBubbleTextColor(phase, userLine);
    this.fitBubbleLayout(message);
  }

  private applyBubbleTextColor(phase: GhostSpeechPhase, userLine: string): void {
    const color = this.resolveTextColor(phase, userLine);
    if (isNull(this.bubbleTextMaterial)) {
      return;
    }

    const pass = this.bubbleTextMaterial.mainPass;
    const passRecord = pass as unknown as Record<string, vec4>;
    for (let i = 0; i < TEXT3D_COLOR_PASS_KEYS.length; i++) {
      const key = TEXT3D_COLOR_PASS_KEYS[i];
      if (typeof passRecord[key] !== 'undefined') {
        passRecord[key] = color;
      }
    }
  }

  private resolveTextColor(phase: GhostSpeechPhase, userLine: string): vec4 {
    if (phase === 'reply' || phase === 'error') {
      return AGENT_TEXT_COLOR;
    }

    if (phase === 'thinking' && !String(userLine || '').trim()) {
      return MUTED_TEXT_COLOR;
    }

    return USER_TEXT_COLOR;
  }

  private fitBubbleLayout(message: string): void {
    const lineCount = this.estimateLineCount(message);
    const karaokeLines = lineCount <= KARAOKE_MAX_LINES;
    const textHalfHeight = Math.min(
      MAX_TEXT_HALF_HEIGHT,
      Math.max(
        MIN_TEXT_HALF_HEIGHT,
        lineCount * LINE_HEIGHT * 0.5 + (karaokeLines ? 0.95 : 0.75)
      )
    );
    const minBubbleHeight = karaokeLines ? KARAOKE_MIN_BUBBLE_HEIGHT : MIN_BUBBLE_HEIGHT;
    const bubbleWidth = Math.max(MIN_BUBBLE_WIDTH, TEXT_HALF_WIDTH * 2 + BUBBLE_PAD_X);
    const bubbleHeight = Math.min(
      MAX_BUBBLE_HEIGHT,
      Math.max(minBubbleHeight, textHalfHeight * 2 + BUBBLE_PAD_Y)
    );

    if (!isNull(this.bubbleText)) {
      this.bubbleText.worldSpaceRect = Rect.create(
        -TEXT_HALF_WIDTH,
        TEXT_HALF_WIDTH,
        -textHalfHeight,
        textHalfHeight
      );
    }

    if (!isNull(this.bubbleBackground)) {
      this.bubbleBackground
        .getSceneObject()
        .getTransform()
        .setLocalScale(new vec3(bubbleWidth, bubbleHeight, BUBBLE_DEPTH));
    }
  }

  private estimateLineCount(message: string): number {
    const segments = String(message || '').split('\n');
    let lines = 0;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i].trim();
      if (!segment) {
        lines += 1;
        continue;
      }
      lines += Math.ceil(segment.length / CHARS_PER_LINE);
    }
    return Math.max(1, lines);
  }

  private setVisible(visible: boolean): void {
    this.visible = visible;
    CompanionNameTag.setSpeechBubbleVisible(this.host, visible);
    if (!isNull(this.bubbleRoot)) {
      this.bubbleRoot.enabled = visible;
    }
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideEvent = this.host.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
    this.hideEvent.bind(() => {
      this.hideEvent = null;
      this.hide();
      this.lastKey = '';
    });
    this.hideEvent.reset(this.hideDelaySec);
  }

  private cancelHide(): void {
    if (!isNull(this.hideEvent)) {
      this.hideEvent.enabled = false;
      this.hideEvent = null;
    }
  }

  private findCameraObject(): SceneObject | null {
    const count = global.scene.getRootObjectsCount();
    for (let i = 0; i < count; i++) {
      const root = global.scene.getRootObject(i);
      const found = this.findObjectByName(root, 'Camera');
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findObjectByName(node: SceneObject, name: string): SceneObject | null {
    if (isNull(node)) {
      return null;
    }
    if (String(node.name) === name) {
      return node;
    }

    for (let i = 0; i < node.getChildrenCount(); i++) {
      const child = node.getChild(i);
      const found = this.findObjectByName(child, name);
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }
}

const NAME_TAG_TEXT_SIZE = 30;
const NAME_TAG_HALF_WIDTH = 5.2;
const NAME_TAG_HALF_HEIGHT = 1.2;
const NAME_TAG_DEPTH = 0.16;
const NAME_TAG_TEXT_COLOR = new vec4(1.0, 1.0, 1.0, 1.0);
const NAME_TAG_BACKGROUND_COLOR = new vec4(0.025, 0.035, 0.06, 0.86);
const NAME_TAG_TEXT_COLOR_KEYS = [
  'frontCapStartingColor',
  'backCapStartingColor',
  'outerEdgeStartingColor',
  'outerEdgeEndingColor',
  'InnerEdgeStartingColor',
  'InnerEdgeEndingColor',
];

export type CompanionNameTagOptions = {
  name: string;
  scaleCompensation?: number;
  heightOffset?: number;
  showWhenMultiple?: boolean;
  debugLogging?: boolean;
};

/**
 * Small camera-facing label for distinguishing multiple AI companions.
 * Labels remain hidden while only one enabled companion is present.
 */
export class CompanionNameTag {
  private static readonly instances: CompanionNameTag[] = [];

  private readonly followRoot: SceneObject;
  private readonly host: BaseScriptComponent;
  private readonly scaleCompensation: number;
  private readonly heightOffset: number;
  private readonly showWhenMultiple: boolean;
  private readonly debugLogging: boolean;
  private name: string;
  private speechBubbleVisible = false;
  private tagRoot: SceneObject | null = null;
  private tagText: Text3D | null = null;
  private tagBackground: RenderMeshVisual | null = null;
  private lookAt: LookAtComponent | null = null;
  private updateEvent: UpdateEvent | null = null;
  private disposed = false;
  private lastVisibleState: boolean | null = null;

  constructor(
    followRoot: SceneObject,
    host: BaseScriptComponent,
    options: CompanionNameTagOptions
  ) {
    this.followRoot = followRoot;
    this.host = host;
    this.scaleCompensation = Math.max(0.1, options.scaleCompensation ?? 3);
    this.heightOffset = options.heightOffset ?? 5.4;
    this.showWhenMultiple = options.showWhenMultiple ?? true;
    this.debugLogging = options.debugLogging ?? false;
    this.name = this.normalizeName(options.name);

    this.ensureBuilt();
    CompanionNameTag.instances.push(this);
    if (this.debugLogging) {
      print(`[CompanionNameTag] registered "${this.name}"`);
    }

    this.updateEvent = this.host.createEvent('UpdateEvent') as UpdateEvent;
    this.updateEvent.bind(() => {
      this.ensureLookAt();
      CompanionNameTag.refreshVisibility();
    });
    this.updateEvent.enabled = true;
    CompanionNameTag.refreshVisibility();
  }

  public setName(name: string): void {
    this.name = this.normalizeName(name);
    if (!isNull(this.tagText)) {
      this.tagText.text = this.name;
    }
    this.updateLayout();
    CompanionNameTag.refreshVisibility();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (!isNull(this.updateEvent)) {
      this.updateEvent.enabled = false;
      this.updateEvent = null;
    }
    if (!isNull(this.tagRoot)) {
      this.tagRoot.destroy();
      this.tagRoot = null;
    }

    const index = CompanionNameTag.instances.indexOf(this);
    if (index >= 0) {
      CompanionNameTag.instances.splice(index, 1);
    }
    CompanionNameTag.refreshVisibility();
  }

  private static refreshVisibility(): void {
    let activeCount = 0;
    for (let i = 0; i < CompanionNameTag.instances.length; i++) {
      if (CompanionNameTag.instances[i].isCompanionEnabled()) {
        activeCount++;
      }
    }

    for (let i = 0; i < CompanionNameTag.instances.length; i++) {
      const tag = CompanionNameTag.instances[i];
      const shouldShow = tag.showWhenMultiple ? activeCount > 1 : activeCount > 0;
      tag.setVisible(shouldShow);
    }
  }

  public static setSpeechBubbleVisible(
    host: BaseScriptComponent,
    visible: boolean
  ): void {
    for (let i = 0; i < CompanionNameTag.instances.length; i++) {
      const tag = CompanionNameTag.instances[i];
      if (tag.host === host) {
        tag.speechBubbleVisible = visible;
      }
    }
    CompanionNameTag.refreshVisibility();
  }

  private ensureBuilt(): void {
    if (this.disposed || !isNull(this.tagRoot)) {
      return;
    }

    const root = global.scene.createSceneObject('CompanionNameTag');
    root.enabled = false;
    root.setParent(this.followRoot);
    root.layer = this.followRoot.layer;
    const inverseScale = 1 / this.scaleCompensation;
    root.getTransform().setLocalPosition(new vec3(0, this.heightOffset, 0));
    root.getTransform().setLocalRotation(quat.quatIdentity());
    root.getTransform().setLocalScale(new vec3(inverseScale, inverseScale, inverseScale));
    this.tagRoot = root;

    this.createBackground(root);
    this.createText(root);
    this.ensureLookAt();
  }

  private createBackground(root: SceneObject): void {
    let material: Material | null = null;
    try {
      const template = requireAsset('Materials & Shaders/Mat_AIChatBlack.mat') as Material;
      material = template.clone();
      const pass = material.mainPass as unknown as Record<string, unknown>;
      this.trySetPassValue(pass, 'depthWrite', false);
      this.trySetPassValue(pass, 'depthTest', true);
      this.trySetPassValue(pass, 'blendMode', BlendMode.Normal);
      this.trySetPassValue(pass, 'baseColor', NAME_TAG_BACKGROUND_COLOR);
    } catch (_error) {
      material = null;
    }

    if (isNull(material)) {
      return;
    }

    try {
      const backgroundObject = global.scene.createSceneObject('CompanionNameTagBackground');
      backgroundObject.setParent(root);
      backgroundObject.layer = root.layer;
      backgroundObject.getTransform().setLocalPosition(new vec3(0, 0, -0.04));
      backgroundObject.getTransform().setLocalRotation(quat.quatIdentity());

      const background = backgroundObject.createComponent(
        'Component.RenderMeshVisual'
      ) as RenderMeshVisual;
      background.enabled = true;
      background.mesh = requireAsset('Meshes/StarCatchSphere.mesh') as RenderMesh;
      background.mainMaterial = material;
      background.renderOrder = 30;
      this.tagBackground = background;
    } catch (_error) {
      this.tagBackground = null;
    }
  }

  private createText(root: SceneObject): void {
    const textObject = global.scene.createSceneObject('CompanionNameTagText');
    textObject.setParent(root);
    textObject.layer = root.layer;
    textObject.getTransform().setLocalPosition(new vec3(0, 0, 0.08));
    textObject.getTransform().setLocalRotation(quat.quatIdentity());
    textObject.getTransform().setLocalScale(vec3.one());

    const text = textObject.createComponent('Component.Text3D') as Text3D;
    text.enabled = true;
    text.text = this.name;
    text.size = NAME_TAG_TEXT_SIZE;
    text.extrusionDepth = 0.05;
    text.horizontalAlignment = HorizontalAlignment.Center;
    text.verticalAlignment = VerticalAlignment.Center;
    text.horizontalOverflow = HorizontalOverflow.Shrink;
    text.verticalOverflow = VerticalOverflow.Overflow;
    text.worldSpaceRect = Rect.create(
      -NAME_TAG_HALF_WIDTH,
      NAME_TAG_HALF_WIDTH,
      -NAME_TAG_HALF_HEIGHT,
      NAME_TAG_HALF_HEIGHT
    );
    text.renderOrder = 31;

    try {
      const template = requireAsset('Text3D.mat') as Material;
      const material = template.clone();
      const pass = material.mainPass as unknown as Record<string, unknown>;
      for (let i = 0; i < NAME_TAG_TEXT_COLOR_KEYS.length; i++) {
        this.trySetPassValue(pass, NAME_TAG_TEXT_COLOR_KEYS[i], NAME_TAG_TEXT_COLOR);
      }
      this.trySetPassValue(pass, 'depthWrite', false);
      this.trySetPassValue(pass, 'depthTest', true);
      text.mainMaterial = material;
    } catch (_error) {
      // Text3D keeps its default material if the template is unavailable.
    }

    this.tagText = text;
    this.updateLayout();
  }

  private updateLayout(): void {
    const labelWidth = Math.max(5.2, Math.min(14.5, this.name.length * 0.82 + 2.8));
    if (!isNull(this.tagText)) {
      this.tagText.worldSpaceRect = Rect.create(
        -labelWidth * 0.5,
        labelWidth * 0.5,
        -NAME_TAG_HALF_HEIGHT,
        NAME_TAG_HALF_HEIGHT
      );
    }
    if (!isNull(this.tagBackground)) {
      this.tagBackground
        .getSceneObject()
        .getTransform()
        .setLocalScale(new vec3(labelWidth, 2.7, NAME_TAG_DEPTH));
    }
  }

  private setVisible(visible: boolean): void {
    const shouldEnable =
      visible &&
      !this.speechBubbleVisible &&
      this.isCompanionEnabled() &&
      !!this.name;
    if (this.debugLogging && this.lastVisibleState !== shouldEnable) {
      print(
        `[CompanionNameTag] "${this.name}" ${shouldEnable ? 'visible' : 'hidden'}`
      );
    }
    this.lastVisibleState = shouldEnable;
    if (!isNull(this.tagRoot)) {
      this.tagRoot.enabled = shouldEnable;
    }
  }

  private isCompanionEnabled(): boolean {
    if (this.disposed || isNull(this.followRoot) || !this.name) {
      return false;
    }
    try {
      return this.followRoot.isEnabledInHierarchy;
    } catch (_error) {
      try {
        return this.followRoot.enabled;
      } catch (_fallbackError) {
        return false;
      }
    }
  }

  private ensureLookAt(): void {
    if (this.disposed || isNull(this.tagRoot) || !isNull(this.lookAt)) {
      return;
    }

    const camera = this.findCameraObject();
    if (isNull(camera)) {
      return;
    }

    try {
      const lookAt = this.tagRoot.createComponent(
        'Component.LookAtComponent'
      ) as LookAtComponent;
      lookAt.target = camera;
      lookAt.lookAtMode = LookAtComponent.LookAtMode.LookAtPoint;
      lookAt.aimVectors = LookAtComponent.AimVectors.ZAimYUp;
      lookAt.worldUpVector = LookAtComponent.WorldUpVector.SceneY;
      this.lookAt = lookAt;
    } catch (error) {
      if (this.debugLogging) {
        print('[CompanionNameTag] camera-facing label unavailable: ' + error);
      }
    }
  }

  private findCameraObject(): SceneObject | null {
    const preferredNames = ['Camera Object', 'Device Camera', 'Camera'];
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      const found = this.findCameraRecursive(
        global.scene.getRootObject(i),
        preferredNames
      );
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findCameraRecursive(
    node: SceneObject,
    preferredNames: string[]
  ): SceneObject | null {
    if (isNull(node)) {
      return null;
    }

    const nodeName = String(node.name || '');
    if (preferredNames.indexOf(nodeName) >= 0) {
      try {
        if (!isNull(node.getComponent('Component.Camera'))) {
          return node;
        }
      } catch (_error) {
        // Continue searching if a stale scene object is encountered.
      }
    }

    for (let i = 0; i < node.getChildrenCount(); i++) {
      const found = this.findCameraRecursive(node.getChild(i), preferredNames);
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private normalizeName(name: string): string {
    const value = String(name || '').trim();
    if (!value) {
      return 'Companion';
    }
    return value.length > 28 ? value.slice(0, 27) + '…' : value;
  }

  private trySetPassValue(
    pass: Record<string, unknown>,
    key: string,
    value: unknown
  ): void {
    try {
      pass[key] = value;
    } catch (_error) {
      // Some material passes expose a restricted property set.
    }
  }
}


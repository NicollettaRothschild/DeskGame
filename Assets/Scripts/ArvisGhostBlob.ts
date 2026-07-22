import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import { InteractableManipulation } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation';
import {
  GhostWaterDisplacementConfig,
  sampleGhostWaterDisplacementY,
} from './GhostWaterDisplacement';
import {
  getSharedArvisAgentChat,
  registerArvisGhostBlob,
} from './FlowGardenServiceRegistry';
import { ArvisGhostSpeechBubble } from './ArvisGhostSpeechBubble';

export type ArvisGhostPhase = 'idle' | 'listening' | 'thinking' | 'reply' | 'error';

type InteractableLike = ScriptComponent & {
  targetingMode?: number;
  ignoreInteractionPlane?: boolean;
  keepHoverOnTrigger?: boolean;
  enableInstantDrag?: boolean;
  onDragStart?: { add: (cb: () => void) => void };
  onDragEnd?: { add: (cb: () => void) => void };
  onTriggerStart?: { add: (cb: () => void) => void };
  onTriggerEnd?: { add: (cb: () => void) => void };
  onTriggerEndOutside?: { add: (cb: () => void) => void };
  onInteractorTriggerStart?: { add: (cb: () => void) => void };
  onInteractorTriggerEnd?: { add: (cb: () => void) => void };
  onInteractorTriggerEndOutside?: { add: (cb: () => void) => void };
  onHoverEnter?: { add: (cb: () => void) => void };
  onInteractorHoverEnter?: { add: (cb: () => void) => void };
};

type InteractableManipulationLike = ScriptComponent & {
  manipulateRootSceneObject?: SceneObject;
  enableTranslation?: boolean;
  enableRotation?: boolean;
  enableScale?: boolean;
  useFilter?: boolean;
  onManipulationStart?: { add: (cb: () => void) => void };
  onManipulationEnd?: { add: (cb: () => void) => void };
};

/**
 * Soft ghost blob avatar for Arvis.
 * Clones the garden water material (scene reference) and tints it white/transparent.
 */
@component
export class ArvisGhostBlob extends BaseScriptComponent {
  @input
  @allowUndefined
  ghostVisual!: RenderMeshVisual;

  @input
  @allowUndefined
  waterMaterialTemplate!: Material;

  @input
  @allowUndefined
  eyeMaterialTemplate!: Material;

  @input
  baseScale: number = 8.4;

  @input
  eyeScale: number = 0.16;

  @input
  eyeSeparation: number = 0.28;

  @input
  eyeHeight: number = 0.12;

  @input
  eyeForwardOffset: number = 0.35;

  @input
  idlePulseSpeed: number = 0.55;

  @input
  activePulseSpeed: number = 1.35;

  @input
  thinkingPulseSpeed: number = 2.1;

  @input
  enablePinchToTalk: boolean = true;

  @input
  debugLogging: boolean = true;

  @input
  @allowUndefined
  grabSoundTrack!: AudioTrackAsset;

  @input
  @allowUndefined
  releaseSoundTrack!: AudioTrackAsset;

  @input('float')
  grabSoundVolume: number = 0.85;

  @input('float')
  releaseSoundVolume: number = 0.8;

  @input
  enableGrabSounds: boolean = true;

  @input
  enableSpeechBubble: boolean = true;

  @input('float')
  speechBubbleHideDelaySec: number = 14;

  private phase: ArvisGhostPhase = 'idle';
  private baseLocalPosition: vec3 | null = null;
  private material: Material | null = null;
  private eyeMaterial: Material | null = null;
  private motionRoot: SceneObject | null = null;
  private leftEye: SceneObject | null = null;
  private rightEye: SceneObject | null = null;
  private ghostColor = new vec4(1.0, 1.0, 1.0, 0.38);
  private phaseGhostColor = new vec4(1.0, 1.0, 1.0, 0.38);
  private usingWaterMaterial = false;
  private waterScrollSpeed = ArvisGhostBlob.DEFAULT_WATER_SCROLL_SPEED;
  private waterNoiseScale = ArvisGhostBlob.DEFAULT_WATER_NOISE_SCALE;
  private waterOffsetAmount = ArvisGhostBlob.DEFAULT_WATER_OFFSET;
  private waterTweakN11 = 0.0;
  private waterTweakN6 = ArvisGhostBlob.DEFAULT_WATER_TWEAK_N6;
  private lastEyeYSquash = 1;
  private smoothedEyeYSquash = 1;
  private lastEyePulse = 1;
  private moveInteractionWired = false;
  private moveActive = false;
  private moveBindAttempts = 0;
  private talkBindAttempts = 0;
  private talkTapDownTime = 0;
  private talkDragStarted = false;
  private grabInteractable: InteractableLike | null = null;
  private grabManipulation: InteractableManipulationLike | null = null;
  private audioPlayer: AudioComponent | null = null;
  private grabAudioPlayer: AudioComponent | null = null;
  private resolvedGrabTrack: AudioTrackAsset | null = null;
  private resolvedReleaseTrack: AudioTrackAsset | null = null;
  private speechBubble: ArvisGhostSpeechBubble | null = null;

  private static readonly EYE_SQUASH_SMOOTH_SPEED = 14.0;
  private static readonly DEFAULT_WATER_SCROLL_SPEED = 2.2;
  private static readonly DEFAULT_WATER_NOISE_SCALE = 0.055;
  private static readonly DEFAULT_WATER_OFFSET = 4.0;
  private static readonly DEFAULT_WATER_TWEAK_N6 = 2.4;
  private static readonly GRAB_GHOST_COLOR = new vec4(1.0, 0.86, 0.1, 0.58);
  private static readonly GRAB_GHOST_EMISSIVE = new vec3(1.6, 1.25, 0.2);

  private static readonly MOTION_ROOT_NAME = 'ArvisGhostMotion';
  private static readonly BODY_ROOT_NAME = 'ArvisGhostBody';
  private static readonly EYE_LEFT_NAME = 'Eye_L';
  private static readonly EYE_RIGHT_NAME = 'Eye_R';
  private static readonly LEGACY_EYES_NAME = 'ArvisEyes';

  onAwake(): void {
    registerArvisGhostBlob(this);
    this.ensureAnchorGrabComponents();
    this.createEvent('OnStartEvent').bind(() => {
      this.cleanupLegacyHierarchy();
      this.ensureAuthoredScale();
      this.ensureVisual();
      this.ensureEyes();
      this.captureDefaults();
      this.ensureArvisSounds();
      this.ensureSpeechBubble();
      this.refreshGrabCollider();
      this.setPhase('idle');
      this.wireMoveInteraction();
      print('[ArvisGhostBlob] ready');
    });
    this.createEvent('UpdateEvent').bind(() => this.tick());
    this.createEvent('LateUpdateEvent').bind(() => {
      this.applyIdleAnchorPose();
      this.syncEyesToGhostWorld();
      this.syncSpeechBubbleToGhostWorld();
    });
  }

  public setPhase(phase: ArvisGhostPhase): void {
    this.phase = phase;

    if (phase === 'listening') {
      this.phaseGhostColor = new vec4(1.0, 1.0, 1.0, 0.5);
    } else if (phase === 'thinking') {
      this.phaseGhostColor = new vec4(1.0, 1.0, 1.0, 0.58);
    } else if (phase === 'reply') {
      this.phaseGhostColor = new vec4(1.0, 1.0, 1.0, 0.62);
    } else if (phase === 'error') {
      this.phaseGhostColor = new vec4(1.0, 0.88, 0.9, 0.52);
    } else {
      this.phaseGhostColor = new vec4(1.0, 1.0, 1.0, 0.38);
    }

    this.refreshGhostColor();
    this.applyMaterialColor(1);
    if (phase === 'idle') {
      this.hideSpeechBubble();
    }
    if (this.debugLogging) {
      print(`[ArvisGhostBlob] phase=${phase}`);
    }
  }

  public showSpeechBubble(
    phase: ArvisGhostPhase,
    transcript: string,
    response: string | null,
    agentName: string = 'Arvis'
  ): void {
    if (!this.enableSpeechBubble) {
      return;
    }
    this.ensureSpeechBubble();
    if (isNull(this.speechBubble)) {
      return;
    }
    this.speechBubble.showAgentChat(phase, transcript, response, agentName);
  }

  public hideSpeechBubble(): void {
    if (!isNull(this.speechBubble)) {
      this.speechBubble.hide();
    }
  }

  private ensureSpeechBubble(): void {
    if (!this.enableSpeechBubble || !isNull(this.speechBubble)) {
      return;
    }
    const body = this.getBodyObject();
    if (isNull(body)) {
      return;
    }
    this.speechBubble = new ArvisGhostSpeechBubble(body, this, {
      scaleCompensation: this.baseScale,
      maxCharacters: 88,
      hideDelaySec: this.speechBubbleHideDelaySec,
      debugLogging: this.debugLogging,
    });
  }

  private cleanupLegacyHierarchy(): void {
    const anchor = this.sceneObject;
    this.destroyNamedChildrenDeep(anchor, [
      ArvisGhostBlob.MOTION_ROOT_NAME,
      ArvisGhostBlob.LEGACY_EYES_NAME,
      ArvisGhostBlob.EYE_LEFT_NAME,
      ArvisGhostBlob.EYE_RIGHT_NAME,
    ]);

    const anchorVisual = anchor.getComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    if (!isNull(anchorVisual)) {
      anchorVisual.enabled = true;
      this.ghostVisual = anchorVisual;
    }

    this.motionRoot = null;
    this.leftEye = null;
    this.rightEye = null;
    this.smoothedEyeYSquash = 1;
    this.lastEyePulse = 1;
  }

  private ensureVisual(): void {
    if (isNull(this.ghostVisual)) {
      this.ghostVisual = this.sceneObject.getComponent(
        'Component.RenderMeshVisual'
      ) as RenderMeshVisual;
    }
    if (isNull(this.ghostVisual)) {
      print('[ArvisGhostBlob] FAIL: no RenderMeshVisual');
      return;
    }

    this.ensureMotionRoot();
    this.ensureBodyVisual();

    if (isNull(this.ghostVisual.mesh)) {
      this.ghostVisual.mesh = requireAsset('Meshes/StarCatchSphere.mesh') as RenderMesh;
      print('[ArvisGhostBlob] assigned StarCatchSphere mesh');
    }

    const template = this.resolveWaterMaterialTemplate();
    if (isNull(template)) {
      print('[ArvisGhostBlob] FAIL: water material template missing');
      return;
    }

    this.material = template.clone();
    this.usingWaterMaterial = this.isWaterLikeMaterial(template);
    if (this.usingWaterMaterial) {
      this.configureWaterGhostMaterial(this.material);
      print('[ArvisGhostBlob] material applied from water template');
    } else {
      this.applyFallbackGhostMaterial(this.material);
      print('[ArvisGhostBlob] material applied from fallback template');
    }

    this.ghostVisual.mainMaterial = this.material;
    this.ghostVisual.renderOrder = 0;
    this.applyMaterialColor(1);
  }

  private ensureMotionRoot(): SceneObject {
    if (!isNull(this.motionRoot)) {
      return this.motionRoot;
    }

    const anchor = this.sceneObject;
    let motion = this.findNamedChild(anchor, ArvisGhostBlob.MOTION_ROOT_NAME);
    if (isNull(motion)) {
      motion = global.scene.createSceneObject(ArvisGhostBlob.MOTION_ROOT_NAME);
      motion.setParent(anchor);
    }

    this.inheritAnchorLayer(motion);

    motion.getTransform().setLocalPosition(new vec3(0, 0, 0));
    motion.getTransform().setLocalRotation(quat.quatIdentity());
    motion.getTransform().setLocalScale(new vec3(1, 1, 1));

    this.motionRoot = motion;
    return motion;
  }

  /** Scene-object scale is the size authority; baseScale input is only a bootstrap default. */
  private ensureAuthoredScale(): void {
    const anchor = this.sceneObject;
    const localScale = anchor.getTransform().getLocalScale();
    const authoredScale = Math.max(localScale.x, localScale.y, localScale.z);
    if (authoredScale < 1.01) {
      anchor.getTransform().setLocalScale(
        new vec3(this.baseScale, this.baseScale, this.baseScale)
      );
    }
  }

  private ensureBodyVisual(): void {
    const motion = this.ensureMotionRoot();
    let body = this.findNamedChild(motion, ArvisGhostBlob.BODY_ROOT_NAME);
    if (isNull(body)) {
      body = global.scene.createSceneObject(ArvisGhostBlob.BODY_ROOT_NAME);
      body.setParent(motion);
      body.getTransform().setLocalPosition(new vec3(0, 0, 0));
      body.getTransform().setLocalRotation(quat.quatIdentity());
      body.getTransform().setLocalScale(new vec3(1, 1, 1));
    }

    this.inheritAnchorLayer(body);

    let bodyVisual = body.getComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    if (isNull(bodyVisual)) {
      bodyVisual = body.createComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    }

    const anchorVisual = this.sceneObject.getComponent(
      'Component.RenderMeshVisual'
    ) as RenderMeshVisual;
    if (
      !isNull(anchorVisual) &&
      anchorVisual.getSceneObject() === this.sceneObject &&
      bodyVisual !== anchorVisual
    ) {
      if (!isNull(anchorVisual.mesh)) {
        bodyVisual.mesh = anchorVisual.mesh;
      }
      anchorVisual.enabled = false;
    }

    bodyVisual.enabled = true;
    this.ghostVisual = bodyVisual;
  }

  private ensureEyes(): void {
    const body = this.getBodyObject();
    if (isNull(body)) {
      return;
    }

    this.destroyNamedChildren(this.sceneObject, [
      ArvisGhostBlob.LEGACY_EYES_NAME,
      ArvisGhostBlob.EYE_LEFT_NAME,
      ArvisGhostBlob.EYE_RIGHT_NAME,
    ]);
    this.destroyNamedChildren(body, [
      ArvisGhostBlob.LEGACY_EYES_NAME,
      ArvisGhostBlob.EYE_LEFT_NAME,
      ArvisGhostBlob.EYE_RIGHT_NAME,
    ]);

    const halfSeparation = this.eyeSeparation * 0.5;
    this.leftEye = this.createEyeMesh(
      body,
      ArvisGhostBlob.EYE_LEFT_NAME,
      new vec3(-halfSeparation, this.eyeHeight, this.eyeForwardOffset)
    );
    this.rightEye = this.createEyeMesh(
      body,
      ArvisGhostBlob.EYE_RIGHT_NAME,
      new vec3(halfSeparation, this.eyeHeight, this.eyeForwardOffset)
    );

    if (this.debugLogging && !isNull(this.leftEye) && !isNull(this.rightEye)) {
      print('[ArvisGhostBlob] eyes attached on body');
    }
  }

  private getBodyObject(): SceneObject | null {
    if (isNull(this.ghostVisual)) {
      return null;
    }
    return this.ghostVisual.getSceneObject();
  }

  private createEyeMesh(
    parent: SceneObject,
    name: string,
    localPosition: vec3
  ): SceneObject | null {
    const eye = global.scene.createSceneObject(name);
    eye.enabled = true;
    eye.setParent(parent);
    this.inheritAnchorLayer(eye);
    eye.getTransform().setLocalPosition(localPosition);
    eye.getTransform().setLocalRotation(quat.quatIdentity());
    eye.getTransform().setLocalScale(
      new vec3(this.eyeScale, this.eyeScale, this.eyeScale)
    );

    const visual = eye.createComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    if (isNull(visual)) {
      return null;
    }

    visual.enabled = true;
    visual.mesh = requireAsset('Meshes/StarCatchSphere.mesh') as RenderMesh;
    visual.renderOrder = 10;
    visual.mainMaterial = this.resolveEyeMaterial();
    return eye;
  }

  private resolveEyeMaterial(): Material {
    if (!isNull(this.eyeMaterial)) {
      return this.eyeMaterial;
    }

    let template = this.eyeMaterialTemplate;
    if (isNull(template)) {
      template = requireAsset('Materials & Shaders/Mat_AIChatBlack.mat') as Material;
    }

    this.eyeMaterial = template.clone();
    const pass = this.eyeMaterial.mainPass;
    pass.depthWrite = true;
    if (typeof pass.depthTest !== 'undefined') {
      pass.depthTest = true;
    }
    if (typeof pass.blendMode !== 'undefined') {
      pass.blendMode = BlendMode.Normal;
    }
    if (typeof pass.baseColor !== 'undefined') {
      pass.baseColor = new vec4(0, 0, 0, 1);
    }

    return this.eyeMaterial;
  }

  private destroyNamedChildren(root: SceneObject, names: string[]): void {
    for (let i = root.getChildrenCount() - 1; i >= 0; i--) {
      const child = root.getChild(i);
      if (isNull(child)) {
        continue;
      }

      const name = String(child.name || '');
      if (names.indexOf(name) >= 0) {
        child.destroy();
      }
    }
  }

  private destroyNamedChildrenDeep(root: SceneObject, names: string[]): void {
    for (let i = root.getChildrenCount() - 1; i >= 0; i--) {
      const child = root.getChild(i);
      if (isNull(child)) {
        continue;
      }

      const name = String(child.name || '');
      if (names.indexOf(name) >= 0) {
        child.destroy();
        continue;
      }

      this.destroyNamedChildrenDeep(child, names);
    }
  }

  private findNamedChild(root: SceneObject, name: string): SceneObject | null {
    for (let i = 0; i < root.getChildrenCount(); i++) {
      const child = root.getChild(i);
      if (!isNull(child) && String(child.name || '') === name) {
        return child;
      }
    }
    return null;
  }

  private resolveWaterMaterialTemplate(): Material | null {
    if (!isNull(this.waterMaterialTemplate)) {
      return this.waterMaterialTemplate;
    }

    if (!isNull(this.ghostVisual) && !isNull(this.ghostVisual.mainMaterial)) {
      return this.ghostVisual.mainMaterial;
    }

    const waterSource = this.findSceneObjectByName('Water Source');
    if (isNull(waterSource)) {
      return null;
    }

    const visuals = this.collectRenderMeshVisuals(waterSource);
    for (let i = 0; i < visuals.length; i++) {
      const material = visuals[i].mainMaterial;
      if (!isNull(material)) {
        return material;
      }
    }

    return null;
  }

  private isWaterLikeMaterial(material: Material): boolean {
    const pass = material.mainPass as unknown as Record<string, unknown>;
    return pass['scrollSpeed'] !== undefined || pass['opacityTextureA'] !== undefined;
  }

  private configureWaterGhostMaterial(material: Material): void {
    const pass = material.mainPass;
    const passRecord = pass as unknown as Record<string, unknown>;
    const whiteTex =
      (passRecord['opacityTextureA'] as Texture | undefined) ||
      (passRecord['opacityTextureB'] as Texture | undefined) ||
      (passRecord['Tweak_N59'] as Texture | undefined);

    pass.depthWrite = false;
    pass.blendMode = BlendMode.PremultipliedAlphaAuto;

    if (!isNull(whiteTex)) {
      this.setPassTexture(pass, 'Tweak_N59', whiteTex);
      this.setPassTexture(pass, 'opacityTextureA', whiteTex);
      this.setPassTexture(pass, 'opacityTextureB', whiteTex);
    }

    this.waterScrollSpeed = ArvisGhostBlob.DEFAULT_WATER_SCROLL_SPEED;
    this.waterNoiseScale = ArvisGhostBlob.DEFAULT_WATER_NOISE_SCALE;
    this.waterOffsetAmount = ArvisGhostBlob.DEFAULT_WATER_OFFSET;
    this.waterTweakN11 = 0.0;
    this.waterTweakN6 = ArvisGhostBlob.DEFAULT_WATER_TWEAK_N6;
    this.setPassFloat(pass, 'scrollSpeed', this.waterScrollSpeed);
    this.setPassFloat(pass, 'noiseScale', this.waterNoiseScale);
    this.setPassFloat(pass, 'Tweak_N6', this.waterTweakN6);
    this.setPassFloat(pass, 'Tweak_N11', this.waterTweakN11);
    this.setPassFloat(pass, 'Tweak_N14', this.waterOffsetAmount);
    this.syncWaterMaterialStateFromPass(pass);
  }

  private syncWaterMaterialStateFromPass(pass: Pass): void {
    const passRecord = pass as unknown as Record<string, number>;
    const scrollSpeed = passRecord['scrollSpeed'];
    if (typeof scrollSpeed === 'number' && scrollSpeed > 0.0001) {
      this.waterScrollSpeed = scrollSpeed;
    }
    const noiseScale = passRecord['noiseScale'];
    if (typeof noiseScale === 'number' && noiseScale > 0.0001) {
      this.waterNoiseScale = noiseScale;
    }
    const offsetAmount = passRecord['Tweak_N14'];
    if (typeof offsetAmount === 'number') {
      this.waterOffsetAmount = offsetAmount;
    }
    const tweakN11 = passRecord['Tweak_N11'];
    if (typeof tweakN11 === 'number') {
      this.waterTweakN11 = tweakN11;
    }
    const tweakN6 = passRecord['Tweak_N6'];
    if (typeof tweakN6 === 'number' && tweakN6 > 0.0001) {
      this.waterTweakN6 = tweakN6;
    }
  }

  private getWaterDisplacementConfig(): GhostWaterDisplacementConfig {
    if (!isNull(this.material)) {
      this.syncWaterMaterialStateFromPass(this.material.mainPass);
    }

    return {
      scrollSpeed: Math.max(this.waterScrollSpeed, ArvisGhostBlob.DEFAULT_WATER_SCROLL_SPEED * 0.1),
      noiseScale: Math.max(this.waterNoiseScale, ArvisGhostBlob.DEFAULT_WATER_NOISE_SCALE),
      offsetAmount: this.waterOffsetAmount,
      tweakN11: this.waterTweakN11,
      tweakN6: Math.max(this.waterTweakN6, ArvisGhostBlob.DEFAULT_WATER_TWEAK_N6 * 0.1),
    };
  }

  private shouldApplyEyeShaderDisplacement(): boolean {
    return this.usingWaterMaterial && !isNull(this.material) && this.waterOffsetAmount !== 0;
  }

  private applyFallbackGhostMaterial(material: Material): void {
    const pass = material.mainPass;
    pass.depthWrite = false;
    if (typeof pass.blendMode !== 'undefined') {
      pass.blendMode = BlendMode.PremultipliedAlphaAuto;
    }
  }

  private captureDefaults(): void {
    this.captureCurrentAnchorPosition();
  }

  private captureCurrentAnchorPosition(): void {
    const anchor = this.sceneObject;
    const localPos = anchor.getTransform().getLocalPosition();
    this.baseLocalPosition = new vec3(localPos.x, localPos.y, localPos.z);
  }

  private wireMoveInteraction(): void {
    if (this.moveInteractionWired) {
      this.refreshGrabCollider();
      return;
    }

    this.moveBindAttempts = 0;
    this.tryWireMoveInteraction();
    this.scheduleGrabWireRetry(0.25);
    this.scheduleGrabWireRetry(0.75);
  }

  private scheduleGrabWireRetry(delaySec: number): void {
    const retryEvent = this.createEvent('DelayedCallbackEvent');
    retryEvent.bind(() => {
      if (!this.moveInteractionWired) {
        this.tryWireMoveInteraction();
      } else {
        this.refreshGrabCollider();
      }
    });
    retryEvent.reset(delaySec);
  }

  private ensureAnchorGrabComponents(): void {
    const anchor = this.sceneObject;
    this.refreshGrabCollider();

    let interactable = this.findExistingInteractable(anchor);
    if (isNull(interactable)) {
      interactable = anchor.createComponent(Interactable.getTypeName()) as InteractableLike;
    }

    let manipulation = this.findExistingManipulation(anchor);
    if (isNull(manipulation)) {
      manipulation = anchor.createComponent(
        InteractableManipulation.getTypeName()
      ) as unknown as InteractableManipulationLike;
    }

    interactable.targetingMode = 7;
    interactable.ignoreInteractionPlane = true;
    interactable.keepHoverOnTrigger = true;
    interactable.enableInstantDrag = true;

    manipulation.manipulateRootSceneObject = anchor;
    manipulation.enableTranslation = true;
    manipulation.enableRotation = false;
    manipulation.enableScale = false;
    manipulation.useFilter = false;

    this.grabInteractable = interactable;
    this.grabManipulation = manipulation;
  }

  private findExistingInteractable(root: SceneObject): InteractableLike | null {
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as InteractableLike;
      if (
        !isNull(candidate) &&
        candidate.targetingMode !== undefined &&
        (candidate.onTriggerStart !== undefined ||
          candidate.onInteractorTriggerStart !== undefined ||
          candidate.onDragStart !== undefined)
      ) {
        return candidate;
      }
    }
    return null;
  }

  private findExistingManipulation(root: SceneObject): InteractableManipulationLike | null {
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as InteractableManipulationLike;
      if (!isNull(candidate) && candidate.manipulateRootSceneObject !== undefined) {
        return candidate;
      }
    }
    return null;
  }

  private tryWireMoveInteraction(): void {
    if (this.moveInteractionWired) {
      return;
    }

    this.ensureAnchorGrabComponents();
    const interactable = this.grabInteractable;
    const manipulation = this.grabManipulation;
    if (isNull(interactable) || isNull(manipulation)) {
      this.moveBindAttempts++;
      if (this.moveBindAttempts >= 30) {
        print('[ArvisGhostBlob] could not bind grab interaction on anchor');
        return;
      }

      const retryEvent = this.createEvent('DelayedCallbackEvent');
      retryEvent.bind(() => this.tryWireMoveInteraction());
      retryEvent.reset(0.1);
      return;
    }

    this.refreshGrabCollider();
    this.bindManipulationRoot(manipulation, this.sceneObject);

    const onGrabStart = (): void => {
      this.onGhostGrabStart();
    };
    const onGrabRelease = (): void => {
      this.onGhostGrabRelease();
    };

    if (manipulation.onManipulationStart) {
      manipulation.onManipulationStart.add(onGrabStart);
    }
    if (manipulation.onManipulationEnd) {
      manipulation.onManipulationEnd.add(onGrabRelease);
    }

    if (interactable.onDragStart) {
      interactable.onDragStart.add(onGrabStart);
    }

    if (interactable.onDragEnd) {
      interactable.onDragEnd.add(onGrabRelease);
    }
    if (interactable.onTriggerEnd) {
      interactable.onTriggerEnd.add(onGrabRelease);
    }
    if (interactable.onTriggerEndOutside) {
      interactable.onTriggerEndOutside.add(onGrabRelease);
    }
    if (interactable.onInteractorTriggerEnd) {
      interactable.onInteractorTriggerEnd.add(onGrabRelease);
    }
    if (interactable.onInteractorTriggerEndOutside) {
      interactable.onInteractorTriggerEndOutside.add(onGrabRelease);
    }

    if (this.debugLogging) {
      if (interactable.onHoverEnter) {
        interactable.onHoverEnter.add(() => print('[ArvisGhostBlob] hover enter'));
      }
      if (interactable.onInteractorHoverEnter) {
        interactable.onInteractorHoverEnter.add(() => print('[ArvisGhostBlob] hover enter'));
      }
    }

    (manipulation as ScriptComponent).enabled = true;
    (interactable as ScriptComponent).enabled = true;

    this.moveInteractionWired = true;
    this.bindGhostTalkInteraction(interactable);

    if (this.debugLogging) {
      print('[ArvisGhostBlob] grab interaction wired on anchor');
    }
  }

  private bindGhostTalkInteraction(interactable: InteractableLike): void {
    if (!this.enablePinchToTalk) {
      return;
    }
    const onTalkDown = (): void => {
      this.talkTapDownTime = getTime();
      this.talkDragStarted = false;
    };
    const onTalkDrag = (): void => {
      this.talkDragStarted = true;
    };
    const onTalkUp = (): void => {
      if (this.talkDragStarted) {
        return;
      }
      const duration = getTime() - this.talkTapDownTime;
      if (duration > 0.32) {
        return;
      }
      this.toggleGhostAgentTalk();
    };

    if (interactable.onTriggerStart) {
      interactable.onTriggerStart.add(onTalkDown);
    }
    if (interactable.onInteractorTriggerStart) {
      interactable.onInteractorTriggerStart.add(onTalkDown);
    }
    if (interactable.onDragStart) {
      interactable.onDragStart.add(onTalkDrag);
    }
    if (interactable.onTriggerEnd) {
      interactable.onTriggerEnd.add(onTalkUp);
    }
    if (interactable.onInteractorTriggerEnd) {
      interactable.onInteractorTriggerEnd.add(onTalkUp);
    }
  }

  private toggleGhostAgentTalk(): void {
    const agent = getSharedArvisAgentChat();
    if (isNull(agent)) {
      return;
    }

    if (agent.isBusy()) {
      agent.endAgentTalkAndSend();
      return;
    }

    agent.beginAgentTalk();
    this.setPhase('listening');
  }

  private getGrabColliderSize(): vec3 {
    // Collider lives on the scaled anchor, so keep local size near the unit mesh bounds.
    const padding = 1.08;
    return new vec3(padding, padding, padding);
  }

  private refreshGrabCollider(): void {
    this.ensureAnchorGrabCollider(this.sceneObject);
  }

  private ensureAnchorGrabCollider(anchor: SceneObject): ColliderComponent | null {
    let collider = anchor.getComponent('Physics.ColliderComponent') as ColliderComponent;
    if (isNull(collider)) {
      collider = anchor.getComponent('Component.ColliderComponent') as ColliderComponent;
    }
    if (isNull(collider)) {
      collider = anchor.createComponent('Physics.ColliderComponent') as ColliderComponent;
    }
    if (isNull(collider)) {
      collider = anchor.createComponent('Component.ColliderComponent') as ColliderComponent;
    }

    const colliderLike = collider as unknown as {
      enabled?: boolean;
      intangible?: boolean;
      forceCompound?: boolean;
      fitVisual?: boolean;
      debugDrawEnabled?: boolean;
      shape?: { size?: vec3; radius?: number; FitVisual?: boolean };
    };

    colliderLike.enabled = true;
    colliderLike.intangible = false;
    colliderLike.forceCompound = false;
    colliderLike.fitVisual = false;
    colliderLike.debugDrawEnabled = false;

    const size = this.getGrabColliderSize();
    const shape = Shape.createBoxShape();
    shape.size = size;
    colliderLike.shape = shape;

    return collider;
  }

  private inheritAnchorLayer(target: SceneObject): void {
    target.layer = this.sceneObject.layer;
  }

  private bindManipulationRoot(
    manipulation: InteractableManipulationLike,
    anchor: SceneObject
  ): void {
    manipulation.manipulateRootSceneObject = anchor;

    const manipRecord = manipulation as unknown as Record<string, unknown>;
    const setRoot = manipRecord['setManipulateRoot'];
    if (typeof setRoot === 'function') {
      (setRoot as (this: unknown, root: Transform) => void).call(
        manipulation,
        anchor.getTransform()
      );
      return;
    }

    const component = manipulation as ScriptComponent;
    const wasEnabled = component.enabled;
    component.enabled = false;
    component.enabled = wasEnabled;
  }

  private onGhostGrabStart(): void {
    if (this.moveActive) {
      return;
    }

    this.moveActive = true;
    this.refreshGhostColor();
    this.applyMaterialColor(1);
    this.playArvisSound(this.resolvedGrabTrack, this.grabSoundVolume, 'grab');
  }

  private onGhostGrabRelease(): void {
    if (!this.moveActive) {
      return;
    }

    this.moveActive = false;
    this.refreshGhostColor();
    this.applyMaterialColor(1);
    this.captureCurrentAnchorPosition();
    this.playArvisSound(this.resolvedReleaseTrack, this.releaseSoundVolume, 'release');
  }

  private ensureArvisSounds(): void {
    if (!this.enableGrabSounds) {
      return;
    }

    this.resolvedGrabTrack = this.resolveSoundTrack(
      this.grabSoundTrack,
      'Audio/arvis_grab.wav'
    );
    this.resolvedReleaseTrack = this.resolveSoundTrack(
      this.releaseSoundTrack,
      'Audio/arvis_release.wav'
    );

    this.grabAudioPlayer = this.ensureGrabAudioPlayer();
    this.audioPlayer = this.grabAudioPlayer;

    if (this.debugLogging) {
      print(
        `[ArvisGhostBlob] sounds grab=${!isNull(this.resolvedGrabTrack)} release=${!isNull(this.resolvedReleaseTrack)}`
      );
    }
  }

  private ensureGrabAudioPlayer(): AudioComponent | null {
    const anchor = this.sceneObject;
    let player = anchor.getComponent('Component.AudioComponent') as AudioComponent;
    if (isNull(player)) {
      player = anchor.createComponent('Component.AudioComponent') as AudioComponent;
    }

    // Editor/simulated preview throws on playbackMode / spatialAudio access — device is fine.
    try {
      const configured = player as AudioComponent & {
        playbackMode?: number;
        spatialAudio?: {
          enabled?: boolean;
          distanceEffect?: { enabled?: boolean; minDistance?: number; maxDistance?: number };
        };
      };

      if (typeof configured.playbackMode !== 'undefined') {
        configured.playbackMode = Audio.PlaybackMode.LowLatency;
      }

      const spatial = configured.spatialAudio;
      if (!isNull(spatial)) {
        if (typeof spatial.enabled !== 'undefined') {
          spatial.enabled = true;
        }
        const distance = spatial.distanceEffect;
        if (!isNull(distance)) {
          if (typeof distance.enabled !== 'undefined') {
            distance.enabled = true;
          }
          if (typeof distance.minDistance !== 'undefined') {
            distance.minDistance = 5;
          }
          if (typeof distance.maxDistance !== 'undefined') {
            distance.maxDistance = 500;
          }
        }
      }
    } catch (e) {
      if (this.debugLogging) {
        print('[ArvisGhostBlob] audio extras unavailable in preview: ' + e);
      }
    }

    return player;
  }

  private resolveSoundTrack(
    assigned: AudioTrackAsset | null | undefined,
    assetPath: string
  ): AudioTrackAsset | null {
    if (!isNull(assigned)) {
      return assigned;
    }

    const candidates = [assetPath, assetPath.replace(/^Audio\//, '')];
    for (let i = 0; i < candidates.length; i++) {
      try {
        return requireAsset(candidates[i]) as AudioTrackAsset;
      } catch {
        // try next path variant
      }
    }

    if (this.debugLogging) {
      print(`[ArvisGhostBlob] missing sound asset ${assetPath}`);
    }
    return null;
  }

  private playArvisSound(
    track: AudioTrackAsset | null,
    volume: number,
    label: 'grab' | 'release'
  ): void {
    if (!this.enableGrabSounds || isNull(track)) {
      return;
    }

    if (isNull(this.grabAudioPlayer)) {
      this.grabAudioPlayer = this.ensureGrabAudioPlayer();
    }
    if (isNull(this.grabAudioPlayer)) {
      return;
    }

    const player = this.grabAudioPlayer as AudioComponent & {
      volume?: number;
      isPlaying?: () => boolean;
      stop?: (fade: boolean) => void;
    };

    if (typeof player.volume === 'number') {
      player.volume = Math.max(0, Math.min(1, volume));
    }

    player.audioTrack = track;
    if (typeof player.isPlaying === 'function' && player.isPlaying()) {
      player.stop!(false);
    }
    player.play(1);

    if (this.debugLogging) {
      print(`[ArvisGhostBlob] sfx ${label}`);
    }
  }

  private refreshGhostColor(): void {
    this.ghostColor = this.moveActive
      ? ArvisGhostBlob.GRAB_GHOST_COLOR
      : this.phaseGhostColor;
  }

  private applyMaterialColor(alphaScale: number): void {
    if (isNull(this.material)) {
      return;
    }
    const pass = this.material.mainPass;
    const alpha = Math.max(0.16, Math.min(0.72, this.ghostColor.w * alphaScale));
    const tint = this.ghostColor;
    const tintRgb = new vec3(tint.x, tint.y, tint.z);

    if (this.usingWaterMaterial) {
      this.setPassFloat(pass, 'Tweak_N171', 0.025 + alpha * 0.07);
      this.setPassFloat(pass, 'Tweak_N172', 0.012 + alpha * 0.035);
      this.setPassFloat(pass, 'Port_Input1_N016', 0.45 + alpha * 0.45);
      this.setPassFloat(pass, 'Port_Input1_N080', 0.55 + alpha * 0.35);
      this.setPassVec3(pass, 'Port_AO_N170', tintRgb);
      this.setPassVec3(
        pass,
        'Port_Emissive_N170',
        this.moveActive ? ArvisGhostBlob.GRAB_GHOST_EMISSIVE : new vec3(0, 0, 0)
      );
    }

    if (typeof pass.baseColor !== 'undefined') {
      pass.baseColor = new vec4(
        tint.x * alpha,
        tint.y * alpha,
        tint.z * alpha,
        alpha
      );
    }
  }

  private setPassFloat(pass: Pass, property: string, value: number): void {
    (pass as unknown as Record<string, number>)[property] = value;
  }

  private setPassTexture(pass: Pass, property: string, texture: Texture): void {
    (pass as unknown as Record<string, Texture>)[property] = texture;
  }

  private setPassVec3(pass: Pass, property: string, value: vec3): void {
    (pass as unknown as Record<string, vec3>)[property] = value;
  }

  private collectRenderMeshVisuals(root: SceneObject): RenderMeshVisual[] {
    const visuals: RenderMeshVisual[] = [];
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }

      const components = current.getComponents('Component.RenderMeshVisual');
      for (let i = 0; i < components.length; i++) {
        visuals.push(components[i] as RenderMeshVisual);
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return visuals;
  }

  private findSceneObjectByName(name: string): SceneObject | null {
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      const match = this.findSceneObjectByNameRecursive(global.scene.getRootObject(i), name);
      if (!isNull(match)) {
        return match;
      }
    }
    return null;
  }

  private findSceneObjectByNameRecursive(root: SceneObject, name: string): SceneObject | null {
    if (String(root.name || '') === name) {
      return root;
    }

    const count = root.getChildrenCount();
    for (let i = 0; i < count; i++) {
      const match = this.findSceneObjectByNameRecursive(root.getChild(i), name);
      if (!isNull(match)) {
        return match;
      }
    }

    return null;
  }

  private tick(): void {
    if (isNull(this.baseLocalPosition)) {
      return;
    }

    const motion = this.ensureMotionRoot();
    if (isNull(motion)) {
      return;
    }

    const time = getTime();
    const speed =
      this.phase === 'thinking'
        ? this.thinkingPulseSpeed
        : this.phase === 'idle'
          ? this.idlePulseSpeed
          : this.activePulseSpeed;

    const pulse = 1.0 + Math.sin(time * speed) * (this.phase === 'thinking' ? 0.12 : 0.08);
    const wobbleX = Math.sin(time * (speed * 1.3) + 0.4) * 0.14;
    const wobbleY = Math.cos(time * (speed * 0.9) + 1.1) * 0.2;
    const ySquash = 1.0 + wobbleY * 0.12;
    const alphaPulse = 0.85 + Math.sin(time * speed * 1.4) * 0.15;

    motion.getTransform().setLocalScale(new vec3(pulse, pulse * ySquash, pulse));
    motion.getTransform().setLocalPosition(new vec3(wobbleX, wobbleY, 0));
    motion.getTransform().setLocalRotation(quat.quatIdentity());

    this.applyMaterialColor(alphaPulse);
    this.lastEyeYSquash = ySquash;
    this.updateEyePulse(time);
  }

  private applyIdleAnchorPose(): void {
    if (isNull(this.baseLocalPosition)) {
      return;
    }

    if (!this.moveActive) {
      const anchor = this.sceneObject;
      anchor.getTransform().setLocalPosition(this.baseLocalPosition);
      anchor.getTransform().setLocalRotation(quat.quatIdentity());
    }
  }

  private updateEyePulse(time: number): void {
    if (isNull(this.leftEye) || isNull(this.rightEye)) {
      return;
    }

    const active =
      this.phase === 'listening' ||
      this.phase === 'thinking' ||
      this.phase === 'reply';
    const pulseTarget = active ? 0.92 + Math.sin(time * 5.5) * 0.08 : 1.0;
    const dt = Math.max(0.0001, getDeltaTime());
    const pulseBlend = 1.0 - Math.exp(-8.0 * dt);
    const pulse =
      this.lastEyePulse +
      (pulseTarget - this.lastEyePulse) * pulseBlend;
    this.lastEyePulse = pulse;
    const eyeScale = this.eyeScale * pulse;
    const scaleVec = new vec3(eyeScale, eyeScale, eyeScale);

    this.leftEye.getTransform().setLocalScale(scaleVec);
    this.rightEye.getTransform().setLocalScale(scaleVec);
  }

  private syncSpeechBubbleToGhostWorld(): void {
    if (!this.enableSpeechBubble || isNull(this.speechBubble)) {
      return;
    }

    const body = this.getBodyObject();
    if (isNull(body)) {
      return;
    }

    this.speechBubble.syncToGhostBody(
      body,
      this.getWaterDisplacementConfig(),
      this.shouldApplyEyeShaderDisplacement(),
      this.smoothedEyeYSquash
    );
  }

  private syncEyesToGhostWorld(): void {
    if (isNull(this.leftEye) || isNull(this.rightEye) || isNull(this.ghostVisual)) {
      return;
    }

    const body = this.ghostVisual.getSceneObject();
    if (isNull(body)) {
      return;
    }

    const dt = Math.max(0.0001, getDeltaTime());
    const squashBlend = 1.0 - Math.exp(-ArvisGhostBlob.EYE_SQUASH_SMOOTH_SPEED * dt);
    const bodyTransform = body.getTransform();
    const worldMatrix = bodyTransform.getWorldTransform();
    const bodyWorldScale = bodyTransform.getWorldScale();
    const invWorldScaleY = 1.0 / Math.max(0.001, bodyWorldScale.y);
    const halfSep = this.eyeSeparation * 0.5;
    const baseY = this.eyeHeight * this.smoothedEyeYSquash;
    const baseZ = this.eyeForwardOffset;
    const time = getTime();
    const displacementConfig = this.getWaterDisplacementConfig();
    const applyShaderDisplacement = this.shouldApplyEyeShaderDisplacement();

    this.smoothedEyeYSquash = MathUtils.lerp(
      this.smoothedEyeYSquash,
      this.lastEyeYSquash,
      squashBlend
    );

    const leftLocal = new vec3(-halfSep, baseY, baseZ);
    const rightLocal = new vec3(halfSep, baseY, baseZ);
    const leftBaseWorld = worldMatrix.multiplyPoint(leftLocal);
    const rightBaseWorld = worldMatrix.multiplyPoint(rightLocal);

    const leftDisplacementY = applyShaderDisplacement
      ? sampleGhostWaterDisplacementY(
          leftBaseWorld.x,
          leftBaseWorld.z,
          time,
          displacementConfig
        )
      : 0;
    const rightDisplacementY = applyShaderDisplacement
      ? sampleGhostWaterDisplacementY(
          rightBaseWorld.x,
          rightBaseWorld.z,
          time,
          displacementConfig
        )
      : 0;

    // Shader displacement is world-space cm; convert to local Y on the scaled body.
    this.leftEye.getTransform().setLocalPosition(
      new vec3(-halfSep, baseY + leftDisplacementY * invWorldScaleY, baseZ)
    );
    this.rightEye.getTransform().setLocalPosition(
      new vec3(halfSep, baseY + rightDisplacementY * invWorldScaleY, baseZ)
    );
    this.leftEye.getTransform().setLocalRotation(quat.quatIdentity());
    this.rightEye.getTransform().setLocalRotation(quat.quatIdentity());
  }
}

import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import { InteractableManipulation } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation';
import WorldCameraFinderProvider from 'SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider';
import {
  GhostWaterDisplacementConfig,
  sampleGhostWaterDisplacementY,
} from './GhostWaterDisplacement';
import {
  getSharedArvisAgentChat,
  registerArvisGhostBlob,
  unregisterArvisGhostBlob,
} from './FlowGardenServiceRegistry';
import {
  ArvisGhostSpeechBubble,
  CompanionNameTag,
} from './ArvisGhostSpeechBubble';
import {
  cameraHasWorldDeviceTracking,
  isEditorRuntime,
  isWorldSpaceReady,
  pickPreferredWorldCamera,
  findRootObjectByName,
  setSceneObjectVisualsEnabled,
  whenWorldSpaceReady,
} from './WorldSpaceReady';

export type ArvisGhostPhase = 'idle' | 'listening' | 'thinking' | 'reply' | 'error';

type InteractorLike = {
  activeTargetingMode?: number;
  startPoint?: vec3 | null;
  direction?: vec3 | null;
  distanceToTarget?: number | null;
  targetHitPosition?: vec3 | null;
  isActive?: () => boolean;
};

type InteractorEventLike = {
  interactor?: InteractorLike | null;
};

type InteractableEventLike = {
  add: (cb: (event?: InteractorEventLike) => void) => void;
};

type InteractableLike = ScriptComponent & {
  targetingMode?: number;
  ignoreInteractionPlane?: boolean;
  keepHoverOnTrigger?: boolean;
  enableInstantDrag?: boolean;
  onDragStart?: InteractableEventLike;
  onDragUpdate?: InteractableEventLike;
  onDragEnd?: InteractableEventLike;
  onTriggerStart?: InteractableEventLike;
  onTriggerUpdate?: InteractableEventLike;
  onTriggerEnd?: InteractableEventLike;
  onTriggerEndOutside?: InteractableEventLike;
  onTriggerCanceled?: InteractableEventLike;
  onInteractorTriggerStart?: InteractableEventLike;
  onInteractorTriggerUpdate?: InteractableEventLike;
  onInteractorTriggerEnd?: InteractableEventLike;
  onInteractorTriggerEndOutside?: InteractableEventLike;
  onInteractorTriggerCanceled?: InteractableEventLike;
  onHoverEnter?: InteractableEventLike;
  onInteractorHoverEnter?: InteractableEventLike;
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
 * Friend stays on the garden water material. Cursor (blue) and Claude (orange)
 * use a solid accent body — ocean water has no baseColor, so Spectacles 2024
 * environment lighting washes those companions to white/silver.
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
  @label('Accent Body Material')
  @hint('Solid color body for Cursor/Claude. Required on Spectacles 2024 — ocean water washes white.')
  accentBodyMaterialTemplate!: Material;

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
  @label('Register As Arvis Ghost')
  registerAsSharedArvis: boolean = true;

  @input
  @label('Use Accent Color')
  useAccentColor: boolean = false;

  @input
  @label('Accent Color')
  accentColor: vec3 = new vec3(0.2, 0.55, 1.0);

  @input
  debugLogging: boolean = false;

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

  @input
  @label('Companion Name')
  @hint('Name shown above this companion when multiple AI companions are active.')
  companionName: string = 'Arvis';

  @input
  @label('Show Name Tag With Multiple Companions')
  @hint('Display this name tag when more than one enabled companion is present.')
  showNameTagWhenMultiple: boolean = true;

  @input
  @label('Look At User')
  enableLookAt: boolean = true;

  @input('float')
  @label('Look At Distance (m)')
  lookAtDistanceMeters: number = 0.2;

  @input('float')
  @label('Look At Exit Padding (m)')
  lookAtExitPaddingMeters: number = 0.05;

  @input('float')
  @label('Look At Turn Speed')
  lookAtTurnSpeed: number = 6.0;

  @input
  @label('Always Look At User')
  @hint('Keep Arvis facing the user even when outside the proximity distance.')
  lookAtAlwaysActive: boolean = true;

  private phase: ArvisGhostPhase = 'idle';
  private baseLocalPosition: vec3 | null = null;
  private material: Material | null = null;
  private edgeMaterial: Material | null = null;
  private eyeMaterial: Material | null = null;
  private motionRoot: SceneObject | null = null;
  private edgeVisual: RenderMeshVisual | null = null;
  private retiredAnchorVisual: RenderMeshVisual | null = null;
  private leftEye: SceneObject | null = null;
  private rightEye: SceneObject | null = null;
  private ghostColor = new vec4(1.0, 1.0, 1.0, 0.38);
  private phaseGhostColor = new vec4(1.0, 1.0, 1.0, 0.38);
  private usingWaterMaterial = false;
  private usingAccentBodyMaterial = false;
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
  private grabStartPending = false;
  private grabReleasePending = false;
  private moveInteractionEpoch = 0;
  private manualMoveInteractor: InteractorLike | null = null;
  private manualMoveRayDistance = 0;
  private pendingManualRootPosition: vec3 | null = null;
  private moveBindAttempts = 0;
  private talkBindAttempts = 0;
  private talkTapDownTime = 0;
  private talkDragStarted = false;
  private talkTogglePending = false;
  private grabInteractable: InteractableLike | null = null;
  private grabManipulation: InteractableManipulationLike | null = null;
  private grabCollider: ColliderComponent | null = null;
  private audioPlayer: AudioComponent | null = null;
  private grabAudioPlayer: AudioComponent | null = null;
  private resolvedGrabTrack: AudioTrackAsset | null = null;
  private resolvedReleaseTrack: AudioTrackAsset | null = null;
  private speechBubble: ArvisGhostSpeechBubble | null = null;
  private companionNameTag: CompanionNameTag | null = null;
  private lookAt: LookAtComponent | null = null;
  private lookAtHost: SceneObject | null = null;
  private lookAtCamera: SceneObject | null = null;
  private lookAtTargetProxy: SceneObject | null = null;
  private lookAtActive = false;
  private lookAtDistanceLogTimer = 0;
  private lookAtLoggedSetup = false;
  private lastLookAtInvalidTargetLogAt = -9999;
  private nextLookAtRetryAt = 0;
  private nextCameraLookupAt = 0;
  private nearUserRebaseEvent: DelayedCallbackEvent | null = null;
  private nearUserRebaseAttempts = 0;
  private worldPlacementReady = false;
  private lastInvalidManualPositionLogAt = -9999;
  private destroyed = false;

  private static readonly EYE_SQUASH_SMOOTH_SPEED = 14.0;
  private static readonly DEFAULT_WATER_SCROLL_SPEED = 2.2;
  private static readonly DEFAULT_WATER_NOISE_SCALE = 0.055;
  private static readonly DEFAULT_WATER_OFFSET = 4.0;
  private static readonly DEFAULT_WATER_TWEAK_N6 = 2.4;
  private static readonly GRAB_GHOST_COLOR = new vec4(1.0, 0.86, 0.1, 0.58);
  private static readonly GRAB_GHOST_EMISSIVE = new vec3(1.6, 1.25, 0.2);

  private static readonly MOTION_ROOT_NAME = 'ArvisGhostMotion';
  private static readonly BODY_ROOT_NAME = 'ArvisGhostBody';
  private static readonly EDGE_ROOT_NAME = 'ArvisGhostEdge';
  private static readonly EDGE_MATERIAL_PATH = 'Materials & Shaders/Mat_FriendBody.mat';
  private static readonly ACCENT_PBR_MATERIAL_PATH = 'Materials & Shaders/Mat_MoveHandleYellow.mat';
  private static readonly EYE_LEFT_NAME = 'Eye_L';
  private static readonly EYE_RIGHT_NAME = 'Eye_R';
  private static readonly LEGACY_EYES_NAME = 'ArvisEyes';
  private static readonly NEAR_USER_REBASE_DELAY_SEC = 0.15;
  private static readonly NEAR_USER_REBASE_RETRY_SEC = 0.2;
  private static readonly MAX_NEAR_USER_REBASE_ATTEMPTS = 24;
  private static readonly NEAR_USER_DISTANCE_CM = 58;
  private static readonly NEAR_USER_SIDE_OFFSET_CM = 10;
  private static readonly NEAR_USER_HEIGHT_OFFSET_CM = -2;
  private static readonly MAX_MANUAL_GRAB_DISTANCE_CM = 180;

  onAwake(): void {
    this.destroyed = false;
    this.worldPlacementReady = isEditorRuntime();
    if (this.registerAsSharedArvis) {
      registerArvisGhostBlob(this);
    }
    this.createEvent('OnStartEvent').bind(() => {
      if (this.destroyed) {
        return;
      }
      this.cleanupLegacyHierarchy();
      this.ensureAuthoredScale();
      this.ensureVisual();
      this.ensureEyes();
      this.captureDefaults();
      this.scheduleNearUserStartupRebase();
      this.ensureArvisSounds();
      this.ensureSpeechBubble();
      this.ensureCompanionNameTag();
      this.stripNativeLookAt();
      this.refreshGrabCollider();
      this.setPhase('idle');
      this.wireMoveInteraction();
      print('[ArvisGhostBlob] ready');
    });
    this.createEvent('UpdateEvent').bind(() => {
      if (!this.destroyed) {
        this.tick();
      }
    });
    this.createEvent('LateUpdateEvent').bind(() => {
      if (this.destroyed) {
        return;
      }
      this.applyIdleAnchorPose();
      this.updateLookAt();
      this.syncEyesToGhostWorld();
      this.syncSpeechBubbleToGhostWorld();
      this.syncCompanionNameTagToGhostBody();
    });
  }

  onDestroy(): void {
    this.destroyed = true;
    this.moveInteractionEpoch++;
    this.moveActive = false;
    this.grabStartPending = false;
    this.grabReleasePending = false;
    this.talkTogglePending = false;
    this.manualMoveInteractor = null;
    this.manualMoveRayDistance = 0;
    this.pendingManualRootPosition = null;
    if (!isNull(this.nearUserRebaseEvent)) {
      this.nearUserRebaseEvent.enabled = false;
      this.nearUserRebaseEvent = null;
    }
    if (!isNull(this.companionNameTag)) {
      this.companionNameTag.dispose();
      this.companionNameTag = null;
    }
    if (!isNull(this.lookAtTargetProxy)) {
      try {
        this.lookAtTargetProxy.destroy();
      } catch (_e) {
        // The scene may already be tearing down during a hot reimport.
      }
      this.lookAtTargetProxy = null;
    }
    unregisterArvisGhostBlob(this);
  }

  public setPhase(phase: ArvisGhostPhase): void {
    this.applyPhaseVisuals(phase, true);
  }

  /** Soft idle / phase change that does not dismiss an active reply bubble. */
  public setPhaseKeepBubble(phase: ArvisGhostPhase): void {
    this.applyPhaseVisuals(phase, false);
  }

  public requestNearUserRebase(): void {
    if (!this.destroyed && !this.moveActive) {
      this.scheduleNearUserStartupRebase();
    }
  }

  private applyPhaseVisuals(phase: ArvisGhostPhase, hideBubbleOnIdle: boolean): void {
    this.phase = phase;

    if (phase === 'listening') {
      this.phaseGhostColor = this.makePhaseColor(0.5);
    } else if (phase === 'thinking') {
      this.phaseGhostColor = this.makePhaseColor(0.58);
    } else if (phase === 'reply') {
      this.phaseGhostColor = this.makePhaseColor(0.62);
    } else if (phase === 'error') {
      this.phaseGhostColor = this.useAccentColor
        ? this.makePhaseColor(0.52)
        : new vec4(1.0, 0.88, 0.9, 0.52);
    } else {
      this.phaseGhostColor = this.makePhaseColor(this.useAccentColor ? 0.52 : 0.38);
    }

    this.refreshGhostColor();
    this.applyMaterialColor(1);
    if (hideBubbleOnIdle && phase === 'idle') {
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

  private ensureCompanionNameTag(): void {
    if (!isNull(this.companionNameTag)) {
      return;
    }

    const body = this.getBodyObject();
    const followRoot = !isNull(body) ? body : this.sceneObject;
    this.companionNameTag = new CompanionNameTag(followRoot, this, {
      name: this.companionName,
      scaleCompensation: Math.max(0.1, this.baseScale),
      heightOffset: 1.35,
      showWhenMultiple: this.showNameTagWhenMultiple,
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
      this.ghostVisual = anchorVisual;
      this.retiredAnchorVisual = anchorVisual;
      anchorVisual.enabled = false;
    }

    this.motionRoot = null;
    this.edgeVisual = null;
    this.retiredAnchorVisual = null;
    this.edgeMaterial = null;
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

    const template = this.resolveBodyMaterialTemplate();
    if (isNull(template)) {
      print('[ArvisGhostBlob] FAIL: body material template missing');
      return;
    }

    this.material = template.clone();
    this.usingWaterMaterial = this.isWaterLikeMaterial(template);
    this.usingAccentBodyMaterial = this.useAccentColor && !this.usingWaterMaterial;
    if (this.usingWaterMaterial) {
      this.configureWaterGhostMaterial(this.material);
      if (this.useAccentColor) {
        print(
          '[ArvisGhostBlob] accent body missing; water will wash white on Spectacles 2024'
        );
      } else {
        print('[ArvisGhostBlob] material applied from water template');
      }
    } else if (this.usingAccentBodyMaterial) {
      this.configureAccentBodyMaterial(this.material);
      print(
        '[ArvisGhostBlob] accent body applied (' +
          String(this.companionName || 'companion') +
          ')'
      );
    } else {
      this.applyFallbackGhostMaterial(this.material);
      print('[ArvisGhostBlob] material applied from fallback template');
    }

    this.ghostVisual.mainMaterial = this.material;
    this.ghostVisual.renderOrder = 1;
    this.ensureEdgeVisual();
    this.applyMaterialColor(1);
    this.suppressRetiredAnchorVisuals();
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
      this.retiredAnchorVisual = anchorVisual;
      anchorVisual.enabled = false;
    }

    bodyVisual.enabled = true;
    this.ghostVisual = bodyVisual;
  }

  /**
   * Adds a slightly expanded inverted-hull pass using the same custom
   * material as Buddy. The water pass remains the visible body; this pass
   * contributes only the silhouette edge around it.
   */
  private ensureEdgeVisual(): void {
    if (
      this.usingAccentBodyMaterial &&
      !isNull(this.material) &&
      this.isFriendBodyLikeMaterial(this.material)
    ) {
      // FriendBody already carries the colored rim; an inverted Add hull
      // would fight the opaque accent body on Spectacles 2024.
      this.disableLegacyEdgeVisual();
      return;
    }

    if (isNull(this.ghostVisual) || isNull(this.ghostVisual.mesh)) {
      return;
    }

    const body = this.ghostVisual.getSceneObject();
    if (isNull(body)) {
      return;
    }

    let edge = this.findNamedChild(body, ArvisGhostBlob.EDGE_ROOT_NAME);
    if (isNull(edge)) {
      edge = global.scene.createSceneObject(ArvisGhostBlob.EDGE_ROOT_NAME);
      edge.setParent(body);
    }

    this.inheritAnchorLayer(edge);
    edge.getTransform().setLocalPosition(new vec3(0, 0, 0));
    edge.getTransform().setLocalRotation(quat.quatIdentity());
    edge.getTransform().setLocalScale(new vec3(1.035, 1.035, 1.035));

    let edgeVisual = edge.getComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    if (isNull(edgeVisual)) {
      edgeVisual = edge.createComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    }
    if (isNull(edgeVisual)) {
      return;
    }

    const template = this.resolveEdgeMaterialTemplate();
    if (isNull(template)) {
      edgeVisual.enabled = false;
      return;
    }

    if (isNull(this.edgeMaterial)) {
      try {
        this.edgeMaterial = template.clone();
        this.configureEdgeMaterial(this.edgeMaterial);
      } catch (_error) {
        this.edgeMaterial = null;
      }
    }
    if (isNull(this.edgeMaterial)) {
      edgeVisual.enabled = false;
      print('[ArvisGhostBlob] edge highlight material clone failed');
      return;
    }

    edgeVisual.mesh = this.ghostVisual.mesh as RenderMesh;
    edgeVisual.mainMaterial = this.edgeMaterial;
    edgeVisual.renderOrder = 0;
    edgeVisual.enabled = true;
    this.edgeVisual = edgeVisual;
    this.applyEdgeMaterialColor();
    print('[ArvisGhostBlob] Buddy-style edge highlight enabled');
  }

  private resolveEdgeMaterialTemplate(): Material | null {
    if (
      !isNull(this.accentBodyMaterialTemplate) &&
      this.isFriendBodyLikeMaterial(this.accentBodyMaterialTemplate)
    ) {
      return this.accentBodyMaterialTemplate;
    }

    try {
      return requireAsset(ArvisGhostBlob.EDGE_MATERIAL_PATH) as Material;
    } catch (_error) {
      print('[ArvisGhostBlob] Buddy edge material unavailable');
      return null;
    }
  }

  private configureEdgeMaterial(material: Material): void {
    const pass = material.mainPass;
    pass.depthTest = true;
    pass.depthWrite = true;
    pass.twoSided = false;
    pass.cullMode = CullMode.Front;
    pass.blendMode = BlendMode.Add;
  }

  private applyEdgeMaterialColor(): void {
    if (isNull(this.edgeMaterial)) {
      return;
    }

    const color = this.useAccentColor
      ? this.clampAccentColor(this.accentColor)
      : new vec3(0.988235, 1.0, 0.223529);
    const pass = this.edgeMaterial.mainPass as unknown as Record<string, unknown>;
    try {
      // Tweak_N1 is the "Rim Color" parameter in SH_Friend_Body.
      pass['Tweak_N1'] = new vec4(color.x, color.y, color.z, 1.0);
    } catch (_error) {
      // Keep the edge pass alive if a platform build omits the dynamic port.
    }
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
    const faceZ = this.getEyeFaceOffset();
    this.leftEye = this.createEyeMesh(
      body,
      ArvisGhostBlob.EYE_LEFT_NAME,
      new vec3(-halfSeparation, this.eyeHeight, faceZ)
    );
    this.rightEye = this.createEyeMesh(
      body,
      ArvisGhostBlob.EYE_RIGHT_NAME,
      new vec3(halfSeparation, this.eyeHeight, faceZ)
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
    visual.renderOrder = 12;
    visual.mainMaterial = this.resolveEyeMaterial();
    return eye;
  }

  /**
   * Water ghosts do not write depth, so in-volume pupils still show through.
   * Opaque accent bodies (Cursor/Claude) bury anything inside the sphere.
   */
  private getEyeFaceOffset(): number {
    const authored = this.eyeForwardOffset;
    if (!this.usingAccentBodyMaterial) {
      return authored;
    }
    return Math.max(authored, 0.62);
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
      // Opaque jelly occludes in-volume pupils; skip the depth test so the
      // eyes composite on the face the way they did through water.
      pass.depthTest = !this.usingAccentBodyMaterial;
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

  private resolveBodyMaterialTemplate(): Material | null {
    if (this.useAccentColor) {
      const accent = this.resolveAccentBodyMaterialTemplate();
      if (!isNull(accent)) {
        return accent;
      }
    }
    return this.resolveWaterMaterialTemplate();
  }

  private resolveAccentBodyMaterialTemplate(): Material | null {
    if (
      !isNull(this.accentBodyMaterialTemplate) &&
      !this.isWaterLikeMaterial(this.accentBodyMaterialTemplate)
    ) {
      return this.accentBodyMaterialTemplate;
    }

    const bundledPaths = [
      ArvisGhostBlob.EDGE_MATERIAL_PATH,
      ArvisGhostBlob.ACCENT_PBR_MATERIAL_PATH,
    ];
    for (let i = 0; i < bundledPaths.length; i++) {
      try {
        const loaded = requireAsset(bundledPaths[i]) as Material;
        if (!isNull(loaded) && !this.isWaterLikeMaterial(loaded)) {
          return loaded;
        }
      } catch (_error) {
        // Device bundles often omit requireAsset paths; the inspector input
        // is the reliable way to ship Mat_FriendBody with Cursor/Claude.
      }
    }

    return this.findFriendBodyMaterialInScene();
  }

  private findFriendBodyMaterialInScene(): Material | null {
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      const visuals = this.collectRenderMeshVisuals(global.scene.getRootObject(i));
      for (let j = 0; j < visuals.length; j++) {
        const material = visuals[j].mainMaterial;
        if (!isNull(material) && this.isFriendBodyLikeMaterial(material)) {
          return material;
        }
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
    // FriendBody also exposes scrollSpeed for jelly wobble — do not treat
    // that as ocean water. Ocean water is IBL/env-reflective (Port_AO_N170
    // / opacityTextureA) and washes white on Spectacles 2024.
    return (
      pass['opacityTextureA'] !== undefined || pass['Port_AO_N170'] !== undefined
    );
  }

  private isFriendBodyLikeMaterial(material: Material): boolean {
    const pass = material.mainPass as unknown as Record<string, unknown>;
    return pass['Tweak_N1'] !== undefined && !this.isWaterLikeMaterial(material);
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

  private configureAccentBodyMaterial(material: Material): void {
    const pass = material.mainPass;
    pass.depthTest = true;
    pass.depthWrite = true;
    pass.twoSided = false;
    pass.cullMode = CullMode.Back;
    if (typeof pass.blendMode !== 'undefined') {
      pass.blendMode = BlendMode.Disabled;
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

  private scheduleNearUserStartupRebase(): void {
    if (this.destroyed || !isNull(this.nearUserRebaseEvent)) {
      return;
    }

    const rebaseEvent = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
    rebaseEvent.bind(() => {
      if (this.destroyed) {
        return;
      }
      this.nearUserRebaseEvent = null;
      if (!isWorldSpaceReady()) {
        whenWorldSpaceReady(this, () => {
          if (!this.destroyed) {
            this.tryRebaseNearUser();
          }
        });
        return;
      }
      this.tryRebaseNearUser();
    });
    this.nearUserRebaseEvent = rebaseEvent;
    rebaseEvent.reset(
      isEditorRuntime() ? ArvisGhostBlob.NEAR_USER_REBASE_DELAY_SEC : 0.05
    );
  }

  private tryRebaseNearUser(): void {
    if (
      this.destroyed ||
      this.moveActive ||
      !this.isValidSceneObject(this.sceneObject)
    ) {
      return;
    }

    if (!isWorldSpaceReady()) {
      this.scheduleNearUserRebaseRetry();
      return;
    }

    const camera = this.resolveCameraObject(true);
    if (isNull(camera)) {
      this.scheduleNearUserRebaseRetry();
      return;
    }
    if (
      !isEditorRuntime() &&
      !cameraHasWorldDeviceTracking(camera) &&
      this.nearUserRebaseAttempts < 8
    ) {
      this.scheduleNearUserRebaseRetry();
      return;
    }

    try {
      const cameraTransform = camera.getTransform();
      const cameraPosition = cameraTransform.getWorldPosition();
      const cameraForward = cameraTransform.forward;
      if (isNull(cameraForward)) {
        this.scheduleNearUserRebaseRetry();
        return;
      }

      // Match SIK CameraProvider.getForwardPosition: offset along
      // transform.forward so companions spawn in front of the headset.
      let forwardX = cameraForward.x;
      let forwardZ = cameraForward.z;
      const forwardLength = Math.sqrt(
        forwardX * forwardX + forwardZ * forwardZ
      );
      if (forwardLength < 0.001) {
        this.scheduleNearUserRebaseRetry();
        return;
      }
      forwardX /= forwardLength;
      forwardZ /= forwardLength;

      const side = this.getNearUserSideOffsetCm();
      const rightX = -forwardZ;
      const rightZ = forwardX;
      const position = new vec3(
        cameraPosition.x +
          forwardX * ArvisGhostBlob.NEAR_USER_DISTANCE_CM +
          rightX * side,
        cameraPosition.y + ArvisGhostBlob.NEAR_USER_HEIGHT_OFFSET_CM,
        cameraPosition.z +
          forwardZ * ArvisGhostBlob.NEAR_USER_DISTANCE_CM +
          rightZ * side
      );
      if (!this.isFiniteVector(position)) {
        this.scheduleNearUserRebaseRetry();
        return;
      }

      this.sceneObject.getTransform().setWorldPosition(position);
      this.captureCurrentAnchorPosition();
      this.markWorldPlacementReady();
      print(
        `[ArvisGhostBlob] startup rebase ${this.companionName} ` +
          `at ${position.toString()} side=${side.toFixed(1)}cm`
      );
    } catch (_error) {
      this.lookAtCamera = null;
      this.scheduleNearUserRebaseRetry();
    }
  }

  private scheduleNearUserRebaseRetry(): void {
    this.nearUserRebaseAttempts++;
    if (
      !isNull(this.nearUserRebaseEvent) ||
      this.nearUserRebaseAttempts >= ArvisGhostBlob.MAX_NEAR_USER_REBASE_ATTEMPTS
    ) {
      if (
        this.nearUserRebaseAttempts >= ArvisGhostBlob.MAX_NEAR_USER_REBASE_ATTEMPTS
      ) {
        this.markWorldPlacementReady();
      }
      return;
    }
    const retry = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
    retry.bind(() => {
      if (this.destroyed) {
        return;
      }
      this.nearUserRebaseEvent = null;
      this.tryRebaseNearUser();
    });
    this.nearUserRebaseEvent = retry;
    retry.reset(ArvisGhostBlob.NEAR_USER_REBASE_RETRY_SEC);
  }

  private markWorldPlacementReady(): void {
    if (this.worldPlacementReady) {
      this.setCompanionVisualState(true);
      if (!isNull(this.companionNameTag)) {
        this.companionNameTag.setSuppressed(false);
      }
      return;
    }
    this.worldPlacementReady = true;
    this.captureCurrentAnchorPosition();
    this.setCompanionVisualState(true);
    if (!isNull(this.companionNameTag)) {
      this.companionNameTag.setSuppressed(false);
    }
    print(
      `[ArvisGhostBlob] world placement ready ${this.companionName} t=${getTime().toFixed(2)}`
    );
  }

  private setCompanionVisualState(visible: boolean): void {
    if (!visible) {
      setSceneObjectVisualsEnabled(this.sceneObject, false);
      this.suppressRetiredAnchorVisuals();
      return;
    }

    this.suppressRetiredAnchorVisuals();
    if (!isNull(this.ghostVisual)) {
      this.ghostVisual.enabled = true;
    }
    this.setChildMeshEnabled(this.leftEye, true);
    this.setChildMeshEnabled(this.rightEye, true);
    if (!isNull(this.edgeVisual)) {
      this.edgeVisual.enabled = !this.usingAccentBodyMaterial;
    }
  }

  /** Authored water RMV on Cursor/Claude must stay off after the body migrate. */
  private suppressRetiredAnchorVisuals(): void {
    if (!isNull(this.retiredAnchorVisual)) {
      this.retiredAnchorVisual.enabled = false;
    }
    const rootVisuals = this.sceneObject.getComponents(
      'Component.RenderMeshVisual'
    ) as RenderMeshVisual[];
    for (let i = 0; i < rootVisuals.length; i++) {
      const visual = rootVisuals[i];
      if (isNull(visual) || visual === this.ghostVisual) {
        continue;
      }
      visual.enabled = false;
    }
  }

  private disableLegacyEdgeVisual(): void {
    if (isNull(this.ghostVisual)) {
      return;
    }
    const body = this.ghostVisual.getSceneObject();
    if (isNull(body)) {
      return;
    }
    const edge = this.findNamedChild(body, ArvisGhostBlob.EDGE_ROOT_NAME);
    if (isNull(edge)) {
      this.edgeVisual = null;
      return;
    }
    const edgeVisual = edge.getComponent(
      'Component.RenderMeshVisual'
    ) as RenderMeshVisual;
    if (!isNull(edgeVisual)) {
      edgeVisual.enabled = false;
    }
    edge.enabled = false;
    this.edgeVisual = null;
  }

  private setChildMeshEnabled(root: SceneObject | null, visible: boolean): void {
    if (isNull(root)) {
      return;
    }
    const visuals = root.getComponents(
      'Component.RenderMeshVisual'
    ) as RenderMeshVisual[];
    for (let i = 0; i < visuals.length; i++) {
      if (!isNull(visuals[i])) {
        visuals[i].enabled = visible;
      }
    }
  }

  private getNearUserSideOffsetCm(): number {
    const name = String(this.companionName || '').trim().toLowerCase();
    if (name.indexOf('claude') >= 0) {
      return ArvisGhostBlob.NEAR_USER_SIDE_OFFSET_CM;
    }
    if (name.indexOf('cursor') >= 0) {
      return -ArvisGhostBlob.NEAR_USER_SIDE_OFFSET_CM;
    }
    return 0;
  }

  private isAcceptableManualWorldPosition(position: vec3): boolean {
    if (!this.isFiniteVector(position)) {
      return false;
    }
    const camera = this.resolveCameraObject();
    if (isNull(camera)) {
      return true;
    }
    const cameraPosition = camera.getTransform().getWorldPosition();
    const dx = position.x - cameraPosition.x;
    const dy = position.y - cameraPosition.y;
    const dz = position.z - cameraPosition.z;
    return (
      Math.sqrt(dx * dx + dy * dy + dz * dz) <=
      ArvisGhostBlob.MAX_MANUAL_GRAB_DISTANCE_CM
    );
  }

  private wireMoveInteraction(): void {
    if (this.moveInteractionWired) {
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
      if (!this.destroyed && !this.moveInteractionWired) {
        this.tryWireMoveInteraction();
      }
    });
    retryEvent.reset(delaySec);
  }

  private ensureAnchorGrabComponents(): boolean {
    const anchor = this.sceneObject;
    const interactable =
      this.grabInteractable || this.findExistingInteractable(anchor);
    const manipulation =
      this.grabManipulation || this.findExistingManipulation(anchor);
    const collider =
      this.grabCollider ||
      (anchor.getComponent('Physics.ColliderComponent') as ColliderComponent) ||
      (anchor.getComponent('Component.ColliderComponent') as ColliderComponent);
    if (isNull(interactable) || isNull(manipulation) || isNull(collider)) {
      return false;
    }

    this.grabCollider = collider;
    this.grabInteractable = interactable;
    this.grabManipulation = manipulation;
    return true;
  }

  private findExistingInteractable(root: SceneObject): InteractableLike | null {
    const direct = root.getComponent(Interactable.getTypeName()) as unknown as InteractableLike;
    if (!isNull(direct)) {
      return direct;
    }

    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as InteractableLike;
      if (
        !isNull(candidate) &&
        candidate.targetingMode !== undefined
      ) {
        return candidate;
      }
    }
    return null;
  }

  private findExistingManipulation(root: SceneObject): InteractableManipulationLike | null {
    const direct = root.getComponent(
      InteractableManipulation.getTypeName()
    ) as unknown as InteractableManipulationLike;
    if (!isNull(direct)) {
      return direct;
    }

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
    if (this.destroyed || this.moveInteractionWired) {
      return;
    }

    if (!this.ensureAnchorGrabComponents()) {
      this.moveBindAttempts++;
      if (this.moveBindAttempts >= 30) {
        print('[ArvisGhostBlob] authored grab components missing on anchor');
        return;
      }
      const retryEvent = this.createEvent('DelayedCallbackEvent');
      retryEvent.bind(() => this.tryWireMoveInteraction());
      retryEvent.reset(0.1);
      return;
    }
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

    if (!(manipulation as ScriptComponent).enabled) {
      // Coding buddies keep the native manipulation component disabled for
      // Spectacles 2024 stability. Move them with the same trigger/update pattern as
      // PostItNoteTranscript instead of mixing ASR with native manipulation.
      this.bindTriggerMoveInteraction(interactable);
      this.moveInteractionWired = true;
      this.bindGhostTalkInteraction(interactable);
      return;
    }

    const onGrabStart = (): void => {
      this.deferGhostGrabStart();
    };
    const onGrabRelease = (): void => {
      this.deferGhostGrabRelease();
    };

    const hasManipulationEvents = !!manipulation.onManipulationStart;
    if (hasManipulationEvents) {
      manipulation.onManipulationStart.add(onGrabStart);
      if (manipulation.onManipulationEnd) {
        manipulation.onManipulationEnd.add(onGrabRelease);
      }
    } else {
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
    }

    if (this.debugLogging) {
      if (interactable.onHoverEnter) {
        interactable.onHoverEnter.add(() => print('[ArvisGhostBlob] hover enter'));
      }
      if (interactable.onInteractorHoverEnter) {
        interactable.onInteractorHoverEnter.add(() => print('[ArvisGhostBlob] hover enter'));
      }
    }

    this.moveInteractionWired = true;
    this.bindGhostTalkInteraction(interactable);

    if (this.debugLogging) {
      print('[ArvisGhostBlob] grab interaction wired on anchor');
    }
  }

  private bindTriggerMoveInteraction(interactable: InteractableLike): void {
    const start =
      interactable.onInteractorTriggerStart ||
      interactable.onTriggerStart ||
      interactable.onDragStart;
    const update =
      interactable.onTriggerUpdate ||
      interactable.onDragUpdate ||
      interactable.onInteractorTriggerUpdate;

    if (start) {
      start.add((event?: InteractorEventLike) => {
        this.onTriggerMoveStart(event);
      });
    }
    if (update) {
      update.add((event?: InteractorEventLike) => {
        this.onTriggerMoveUpdate(event);
      });
    }

    const endEvents = [
      interactable.onInteractorTriggerEnd,
      interactable.onInteractorTriggerEndOutside,
      interactable.onTriggerEnd,
      interactable.onTriggerEndOutside,
      interactable.onDragEnd,
      interactable.onTriggerCanceled,
      interactable.onInteractorTriggerCanceled,
    ];
    for (let i = 0; i < endEvents.length; i++) {
      const event = endEvents[i];
      if (event) {
        event.add(() => this.deferGhostGrabRelease());
      }
    }

    if (this.debugLogging) {
      print(
        `[ArvisGhostBlob] trigger move wired start=${!!start} update=${!!update}`
      );
    }
  }

  private onTriggerMoveStart(event?: InteractorEventLike): void {
    if (this.moveActive) {
      return;
    }

    this.pendingManualRootPosition = null;
    const interactor = event && event.interactor ? event.interactor : null;
    this.manualMoveInteractor = interactor;
    this.manualMoveRayDistance = this.getTriggerMoveDistance(interactor);
    this.deferGhostGrabStart();
    // Let tick() perform the first transform write outside SIK's trigger
    // callback. This is important on Spectacles when the same trigger also
    // arms the shared speech capture.
  }

  private onTriggerMoveUpdate(event?: InteractorEventLike): void {
    if (!this.moveActive) {
      return;
    }
    if (event && event.interactor) {
      this.manualMoveInteractor = event.interactor;
    }
    // The per-frame update owns transform writes; do not mutate the scene
    // hierarchy from inside a SIK callback.
  }

  private updateTriggerMovePosition(): void {
    if (!this.moveActive) {
      return;
    }

    const interactor = this.manualMoveInteractor;
    if (interactor && typeof interactor.isActive === 'function') {
      try {
        if (!interactor.isActive()) {
          this.onGhostGrabRelease();
          return;
        }
      } catch (_error) {
        // SIK can invalidate an interactor one frame before its end event.
        this.onGhostGrabRelease();
        return;
      }
    }

    let position: vec3 | null = null;
    try {
      position = this.getTriggerMovePosition(
        interactor,
        this.manualMoveRayDistance
      );
    } catch (_error) {
      return;
    }
    if (
      !isNull(position) &&
      this.isAcceptableManualWorldPosition(position)
    ) {
      // Keep the authored interaction root/collider stationary while SIK is
      // tracking the pinch. Moving an active collider itself is unstable on
      // Spectacles; the visual body follows the hand and the root is
      // committed once on release.
      const motion = this.ensureMotionRoot();
      if (!isNull(motion)) {
        motion.getTransform().setWorldPosition(position);
      }
    } else if (
      !isNull(position) &&
      getTime() - this.lastInvalidManualPositionLogAt > 2
    ) {
      this.lastInvalidManualPositionLogAt = getTime();
      print('[ArvisGhostBlob] rejected distant manual grab position');
    }
  }

  private getTriggerMoveDistance(interactor: InteractorLike | null): number {
    if (
      interactor &&
      interactor.distanceToTarget !== null &&
      interactor.distanceToTarget !== undefined &&
      Number.isFinite(interactor.distanceToTarget)
    ) {
      return Math.max(0, interactor.distanceToTarget);
    }
    return 35;
  }

  private getTriggerMovePosition(
    interactor: InteractorLike | null,
    rayDistance: number
  ): vec3 | null {
    if (interactor) {
      const startPoint = interactor.startPoint || null;
      const direction = interactor.direction || null;
      const targetHitPosition = interactor.targetHitPosition || null;

      if (interactor.activeTargetingMode === 1 && startPoint) {
        return startPoint;
      }
      if (startPoint && direction) {
        return startPoint.add(direction.uniformScale(rayDistance));
      }
      if (targetHitPosition) {
        return targetHitPosition;
      }
      if (startPoint) {
        return startPoint;
      }
    }
    return this.sceneObject.getTransform().getWorldPosition();
  }

  private isFiniteVector(value: vec3): boolean {
    return (
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      Number.isFinite(value.z)
    );
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
      const duration = getTime() - this.talkTapDownTime;
      // InteractableManipulation almost always fires drag — still treat short pinches as talk.
      if (duration < 0.04 || duration > 0.55) {
        return;
      }
      if (this.talkDragStarted && duration > 0.4) {
        return;
      }
      if (this.debugLogging) {
        print(`[ArvisGhostBlob] pinch-to-talk (${duration.toFixed(2)}s)`);
      }
      // Keep all agent/session work out of SIK's native callback stack.
      this.talkTogglePending = true;
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

  private refreshGrabCollider(): void {
    this.ensureAnchorGrabCollider(this.sceneObject);
  }

  private ensureAnchorGrabCollider(anchor: SceneObject): ColliderComponent | null {
    let collider = this.grabCollider;
    if (isNull(collider) || collider.getSceneObject() !== anchor) {
      collider = anchor.getComponent('Physics.ColliderComponent') as ColliderComponent;
      if (isNull(collider)) {
        collider = anchor.getComponent('Component.ColliderComponent') as ColliderComponent;
      }
      this.grabCollider = collider;
    }
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

  private deferGhostGrabStart(): void {
    if (this.moveActive || this.grabStartPending) {
      return;
    }
    // SIK may dispatch this from its native trigger stack. Only set the
    // movement guard/flag here; tick() performs component, audio, and
    // transform mutations.
    this.moveActive = true;
    this.grabStartPending = true;
  }

  private deferGhostGrabRelease(): void {
    if (!this.moveActive && !this.grabStartPending) {
      return;
    }
    this.grabReleasePending = true;
  }

  private onGhostGrabStart(): void {
    this.moveActive = true;
    const epoch = ++this.moveInteractionEpoch;
    this.setLookAtActive(false);
    this.setLookAtEnabled(false);
    const deferredStart = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
    deferredStart.bind(() => {
      if (!this.moveActive || epoch !== this.moveInteractionEpoch) {
        return;
      }
      this.refreshGhostColor();
      this.applyMaterialColor(1);
      this.playArvisSound(this.resolvedGrabTrack, this.grabSoundVolume, 'grab');
    });
    deferredStart.reset(0.05);
  }

  private onGhostGrabRelease(): void {
    if (!this.moveActive) {
      return;
    }

    const heldWorldPosition = !isNull(this.motionRoot)
      ? this.motionRoot.getTransform().getWorldPosition()
      : null;
    this.moveActive = false;
    this.moveInteractionEpoch++;
    this.manualMoveInteractor = null;
    this.manualMoveRayDistance = 0;
    if (
      !isNull(heldWorldPosition) &&
      this.isAcceptableManualWorldPosition(heldWorldPosition)
    ) {
      // Commit on the next UpdateEvent, after SIK has finished dispatching
      // the release/cancel callback.
      this.pendingManualRootPosition = new vec3(
        heldWorldPosition.x,
        heldWorldPosition.y,
        heldWorldPosition.z
      );
    }
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
      ? this.getGrabGhostColor()
      : this.phaseGhostColor;
  }

  private makePhaseColor(alpha: number): vec4 {
    const color = this.useAccentColor
      ? this.clampAccentColor(this.accentColor)
      : new vec3(1.0, 1.0, 1.0);
    return new vec4(color.x, color.y, color.z, alpha);
  }

  private getGrabGhostColor(): vec4 {
    if (!this.useAccentColor) {
      return ArvisGhostBlob.GRAB_GHOST_COLOR;
    }
    const color = this.clampAccentColor(this.accentColor);
    return new vec4(color.x, color.y, color.z, 0.58);
  }

  private getGrabGhostEmissive(): vec3 {
    if (!this.useAccentColor) {
      return ArvisGhostBlob.GRAB_GHOST_EMISSIVE;
    }
    const color = this.clampAccentColor(this.accentColor);
    return new vec3(color.x * 1.65, color.y * 1.45, color.z * 1.65);
  }

  private clampAccentColor(color: vec3): vec3 {
    if (isNull(color)) {
      return new vec3(0.2, 0.55, 1.0);
    }
    return new vec3(
      Math.max(0, Math.min(1, color.x)),
      Math.max(0, Math.min(1, color.y)),
      Math.max(0, Math.min(1, color.z))
    );
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
      // Keep foam/fresnel low so the accent isn't drowned in white water.
      this.setPassFloat(pass, 'Tweak_N171', 0.012 + alpha * 0.03);
      this.setPassFloat(pass, 'Tweak_N172', 0.006 + alpha * 0.018);
      this.setPassFloat(pass, 'Port_Input1_N016', 0.32 + alpha * 0.22);
      this.setPassFloat(pass, 'Port_Input1_N080', 0.38 + alpha * 0.22);
      this.setPassVec3(pass, 'Port_AO_N170', tintRgb);
      this.setPassVec3(pass, 'Port_SpecularAO_N170', tintRgb);
      this.setPassVec3(pass, 'Port_Emissive_N170', this.getGhostEmissive());
    }

    if (this.usingAccentBodyMaterial) {
      const color = this.useAccentColor
        ? this.clampAccentColor(this.accentColor)
        : tintRgb;
      this.setPassVec4(pass, 'Tweak_N1', new vec4(color.x, color.y, color.z, 1.0));
      this.setPassVec4(
        pass,
        'Tweak_N15',
        new vec4(color.x * 0.22, color.y * 0.18, color.z * 0.28, 1.0)
      );
      this.setPassVec4(
        pass,
        'Tweak_N23',
        new vec4(
          Math.min(1, color.x * 0.55 + 0.08),
          Math.min(1, color.y * 0.4),
          Math.min(1, color.z * 0.85),
          1.0
        )
      );
      this.setPassVec3(pass, 'Port_Emissive_N006', this.getGhostEmissive());
    }

    if (typeof pass.baseColor !== 'undefined') {
      const bodyAlpha = this.usingAccentBodyMaterial ? 1.0 : alpha;
      pass.baseColor = new vec4(tint.x, tint.y, tint.z, bodyAlpha);
    }

    this.applyEdgeMaterialColor();
  }

  private getGhostEmissive(): vec3 {
    if (this.moveActive) {
      return this.getGrabGhostEmissive();
    }
    if (!this.useAccentColor) {
      return new vec3(0, 0, 0);
    }
    const color = this.clampAccentColor(this.accentColor);
    return new vec3(color.x * 1.25, color.y * 1.1, color.z * 1.25);
  }

  private setPassFloat(pass: Pass, property: string, value: number): void {
    try {
      (pass as unknown as Record<string, number>)[property] = value;
    } catch (_error) {
      // Specs builds omit some dynamic water ports.
    }
  }

  private setPassTexture(pass: Pass, property: string, texture: Texture): void {
    try {
      (pass as unknown as Record<string, Texture>)[property] = texture;
    } catch (_error) {
      // Texture slots can be missing on a cloned pass.
    }
  }

  private setPassVec3(pass: Pass, property: string, value: vec3): void {
    try {
      (pass as unknown as Record<string, vec3>)[property] = value;
    } catch (_error) {
      // Spectacles 2024 builds omit some dynamic water ports.
    }
  }

  private setPassVec4(pass: Pass, property: string, value: vec4): void {
    try {
      (pass as unknown as Record<string, vec4>)[property] = value;
    } catch (_error) {
      // FriendBody rim/fill ports can be missing on a cloned pass.
    }
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

    if (this.grabStartPending) {
      this.grabStartPending = false;
      this.onGhostGrabStart();
    }
    if (this.grabReleasePending) {
      this.grabReleasePending = false;
      this.onGhostGrabRelease();
    }
    if (this.talkTogglePending) {
      this.talkTogglePending = false;
      this.toggleGhostAgentTalk();
    }

    this.commitPendingManualRootPosition();
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
    if (!this.enableLookAt || this.moveActive) {
      motion.getTransform().setLocalRotation(quat.quatIdentity());
    }
    if (this.moveActive && !isNull(this.manualMoveInteractor)) {
      // Apply the hand position after the idle wobble so the visual does not
      // fight the manual drag position. The wobble remains in the body scale
      // and shader/eye sync while the interaction root stays fixed.
      this.updateTriggerMovePosition();
    } else {
      motion.getTransform().setLocalPosition(new vec3(wobbleX, wobbleY, 0));
    }

    this.applyMaterialColor(alphaPulse);
    this.lastEyeYSquash = ySquash;
    this.updateEyePulse(time);
  }

  private commitPendingManualRootPosition(): void {
    if (this.moveActive || isNull(this.pendingManualRootPosition)) {
      return;
    }

    const position = this.pendingManualRootPosition;
    this.pendingManualRootPosition = null;
    if (!this.isAcceptableManualWorldPosition(position)) {
      if (getTime() - this.lastInvalidManualPositionLogAt > 2) {
        this.lastInvalidManualPositionLogAt = getTime();
        print('[ArvisGhostBlob] rejected invalid committed grab position');
      }
      return;
    }

    this.sceneObject.getTransform().setWorldPosition(position);
    if (!isNull(this.motionRoot)) {
      this.motionRoot.getTransform().setLocalPosition(new vec3(0, 0, 0));
    }
    this.captureCurrentAnchorPosition();
  }

  private applyIdleAnchorPose(): void {
    if (isNull(this.baseLocalPosition) || !this.worldPlacementReady) {
      return;
    }

    if (!this.moveActive) {
      const anchor = this.sceneObject;
      anchor.getTransform().setLocalPosition(this.baseLocalPosition);
    }
  }

  /** Disable LookAt on the grab root only. The motion-root LookAt stays. */
  private stripNativeLookAt(): void {
    try {
      const lookAt = this.getSceneObject().getComponent(
        'Component.LookAtComponent'
      ) as LookAtComponent;
      if (!isNull(lookAt)) {
        lookAt.enabled = false;
      }
    } catch (_error) {
      // Ignore missing component during teardown.
    }
  }

  /**
   * Cursor/Claude meshes live under ArvisGhostMotion. LookAt must rotate that
   * child, never the grab root — LookAtComponent on the SIK manipulate root
   * writes the same transform as grab and crashes Spectacles 2024.
   */
  private ensureLookAt(): void {
    const now = getTime();
    if (now < this.nextLookAtRetryAt) {
      return;
    }

    const host = this.ensureMotionRoot();
    if (isNull(host) || host === this.getSceneObject()) {
      this.nextLookAtRetryAt = now + 1.0;
      return;
    }
    this.lookAtHost = host;

    const targetProxy = this.ensureLookAtTargetProxy();
    if (isNull(targetProxy)) {
      this.nextLookAtRetryAt = now + 1.0;
      return;
    }
    this.refreshLookAtTargetProxyPosition();

    let lookAt = host.getComponent('Component.LookAtComponent') as LookAtComponent;
    if (isNull(lookAt)) {
      lookAt = host.createComponent('Component.LookAtComponent') as LookAtComponent;
    }
    if (isNull(lookAt)) {
      this.nextLookAtRetryAt = now + 1.5;
      return;
    }

    try {
      lookAt.target = targetProxy as SceneObject;
    } catch (e) {
      if (now - this.lastLookAtInvalidTargetLogAt > 3.0) {
        this.lastLookAtInvalidTargetLogAt = now;
        print('[ArvisGhostBlob] look-at skipped: invalid camera target: ' + e);
      }
      this.nextLookAtRetryAt = now + 1.5;
      return;
    }

    this.nextLookAtRetryAt = 0;
    lookAt.lookAtMode = LookAtComponent.LookAtMode.LookAtPoint;
    lookAt.aimVectors = LookAtComponent.AimVectors.ZAimYUp;
    lookAt.worldUpVector = LookAtComponent.WorldUpVector.SceneY;
    lookAt.enabled = false;
    this.lookAt = lookAt;
  }

  private updateLookAt(): void {
    if (this.moveActive) {
      this.setLookAtActive(false);
      this.setLookAtEnabled(false);
      return;
    }

    if (!this.enableLookAt) {
      this.setLookAtActive(false);
      return;
    }

    if (isNull(this.lookAt) || isNull(this.lookAtTargetProxy)) {
      this.ensureLookAt();
      if (isNull(this.lookAt) || isNull(this.lookAtTargetProxy)) {
        return;
      }
    }
    const lookAt = this.lookAt as LookAtComponent;
    const targetProxy = this.lookAtTargetProxy as SceneObject;
    this.refreshLookAtTargetProxyPosition();

    try {
      lookAt.target = targetProxy;
    } catch (e) {
      const now = getTime();
      if (now - this.lastLookAtInvalidTargetLogAt > 3.0) {
        this.lastLookAtInvalidTargetLogAt = now;
        print('[ArvisGhostBlob] look-at target refresh failed: ' + e);
      }
      lookAt.enabled = false;
      this.nextLookAtRetryAt = now + 1.5;
      return;
    }
    lookAt.aimVectors = LookAtComponent.AimVectors.ZAimYUp;

    if (this.lookAtAlwaysActive && !this.moveActive) {
      this.setLookAtActive(true);
      this.setLookAtEnabled(true);
      return;
    }

    const arvisPosition = this.getSceneObject().getTransform().getWorldPosition();
    const cameraPosition = targetProxy.getTransform().getWorldPosition();
    const dx = cameraPosition.x - arvisPosition.x;
    const dz = cameraPosition.z - arvisPosition.z;
    const distanceCm = Math.sqrt(dx * dx + dz * dz);
    const enterCm = Math.max(0.05, this.lookAtDistanceMeters) * 100.0;
    const exitCm = enterCm + Math.max(0, this.lookAtExitPaddingMeters) * 100.0;

    if (!this.lookAtLoggedSetup) {
      this.lookAtLoggedSetup = true;
      print(
        `[ArvisGhostBlob] look-at setup dist=${distanceCm.toFixed(1)}cm ` +
          `threshold=${enterCm.toFixed(0)}cm host=${this.lookAtHost ? this.lookAtHost.name : '?'}`
      );
    }

    this.lookAtDistanceLogTimer += getDeltaTime();
    if (this.debugLogging && this.lookAtDistanceLogTimer >= 1.5) {
      this.lookAtDistanceLogTimer = 0;
      print(
        `[ArvisGhostBlob] look-at dist=${distanceCm.toFixed(1)}cm active=${this.lookAtActive} ` +
          `(on<=${enterCm.toFixed(0)} off>${exitCm.toFixed(0)})`
      );
    }

    if (this.lookAtActive) {
      if (distanceCm > exitCm) {
        this.setLookAtActive(false);
      } else {
        this.setLookAtEnabled(true);
      }
    } else if (distanceCm <= enterCm) {
      this.setLookAtActive(true);
    } else {
      this.setLookAtEnabled(false);
    }
  }

  private setLookAtActive(active: boolean): void {
    if (this.lookAtActive === active) {
      return;
    }
    this.lookAtActive = active;
    if (active) {
      this.setLookAtEnabled(true);
      print('[ArvisGhostBlob] look-at ON');
      return;
    }
    this.setLookAtEnabled(false);
    print('[ArvisGhostBlob] look-at OFF');
  }

  private setLookAtEnabled(enabled: boolean): void {
    if (!isNull(this.lookAt) && this.lookAt.enabled !== enabled) {
      this.lookAt.enabled = enabled;
    }
  }

  private findCameraObject(): SceneObject | null {
    const picked = pickPreferredWorldCamera([
      findRootObjectByName('Camera Object'),
      findRootObjectByName('Device Camera'),
      this.findTrackedWorldCamera(),
    ]);
    return this.isUsableCameraObject(picked) ? picked : null;
  }

  private findTrackedWorldCamera(): SceneObject | null {
    try {
      const provider = WorldCameraFinderProvider.getInstance() as unknown as {
        getComponent?: () => Camera;
        getTransform?: () => Transform;
      };
      if (provider && typeof provider.getComponent === 'function') {
        const camera = provider.getComponent();
        if (!isNull(camera) && typeof camera.getSceneObject === 'function') {
          const object = camera.getSceneObject();
          if (this.isUsableCameraObject(object)) {
            return object;
          }
        }
      }
      if (provider && typeof provider.getTransform === 'function') {
        const transform = provider.getTransform();
        if (!isNull(transform) && typeof transform.getSceneObject === 'function') {
          const object = transform.getSceneObject();
          if (this.isUsableCameraObject(object)) {
            return object;
          }
        }
      }
    } catch (_error) {
      // Fall through to named scene cameras.
    }
    return null;
  }

  private resolveCameraObject(forceSearch: boolean = false): SceneObject | null {
    const now = getTime();
    if (
      !forceSearch &&
      this.isValidSceneObject(this.lookAtCamera) &&
      (isEditorRuntime() ||
        cameraHasWorldDeviceTracking(this.lookAtCamera) ||
        now > 3.0)
    ) {
      return this.lookAtCamera;
    }
    if (!forceSearch && now < this.nextCameraLookupAt) {
      return this.isValidSceneObject(this.lookAtCamera) ? this.lookAtCamera : null;
    }

    const camera = this.findCameraObject();
    this.nextCameraLookupAt = now + (isNull(camera) ? 0.4 : 5.0);
    if (this.isValidSceneObject(camera)) {
      this.lookAtCamera = camera;
      return camera;
    }
    return null;
  }

  private ensureLookAtTargetProxy(): SceneObject | null {
    if (this.isValidSceneObject(this.lookAtTargetProxy)) {
      return this.lookAtTargetProxy;
    }

    try {
      const proxy = global.scene.createSceneObject('ArvisLookAtTarget');
      proxy.layer = this.getSceneObject().layer;
      const parent = this.getSceneObject().hasParent()
        ? this.getSceneObject().getParent()
        : null;
      if (!isNull(parent)) {
        proxy.setParent(parent as SceneObject);
      }
      proxy.getTransform().setWorldPosition(
        this.getSceneObject().getTransform().getWorldPosition()
      );
      this.lookAtTargetProxy = proxy;
      return proxy;
    } catch (_e) {
      this.lookAtTargetProxy = null;
      return null;
    }
  }

  private refreshLookAtTargetProxyPosition(): void {
    const proxy = this.ensureLookAtTargetProxy();
    if (isNull(proxy)) {
      return;
    }
    const targetProxy = proxy as SceneObject;

    this.resolveCameraObject();

    if (this.isValidSceneObject(this.lookAtCamera)) {
      const camera = this.lookAtCamera as SceneObject;
      try {
        const position = camera.getTransform().getWorldPosition();
        targetProxy.getTransform().setWorldPosition(position);
        return;
      } catch (_e) {
        this.lookAtCamera = null;
        this.nextCameraLookupAt = getTime() + 0.5;
      }
    }

    // Last-resort fallback: keep a stable point in front of Arvis.
    const selfTransform = this.getSceneObject().getTransform();
    const selfPosition = selfTransform.getWorldPosition();
    const forward = selfTransform.forward;
    targetProxy.getTransform().setWorldPosition(
      selfPosition.add(new vec3(forward.x * 40, 0, forward.z * 40))
    );
  }

  private isUsableCameraObject(node: SceneObject | null): boolean {
    if (!this.isValidSceneObject(node)) {
      return false;
    }
    try {
      const camera = (node as SceneObject).getComponent('Component.Camera') as Camera;
      return !isNull(camera);
    } catch (_e) {
      return false;
    }
  }

  private findObjectWithCameraComponent(): SceneObject | null {
    const count = global.scene.getRootObjectsCount();
    for (let i = 0; i < count; i++) {
      const root = global.scene.getRootObject(i);
      const found = this.findCameraComponentRecursive(root);
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findCameraComponentRecursive(node: SceneObject): SceneObject | null {
    if (isNull(node)) {
      return null;
    }
    const sceneObject = node as SceneObject;
    const camera = sceneObject.getComponent('Component.Camera') as Camera;
    if (!isNull(camera)) {
      return node;
    }
    for (let i = 0; i < sceneObject.getChildrenCount(); i++) {
      const found = this.findCameraComponentRecursive(sceneObject.getChild(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private isValidSceneObject(node: SceneObject | null): boolean {
    if (isNull(node)) {
      return false;
    }
    try {
      return !isNull((node as SceneObject).getTransform());
    } catch (_e) {
      return false;
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

  private syncCompanionNameTagToGhostBody(): void {
    if (isNull(this.companionNameTag)) {
      return;
    }

    const body = this.getBodyObject();
    if (isNull(body)) {
      return;
    }

    this.companionNameTag.syncToGhostBody(
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
    const baseZ = this.getEyeFaceOffset();
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

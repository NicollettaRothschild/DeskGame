import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import { InteractableManipulation } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation';
import { InteractorInputType } from 'SpectaclesInteractionKit.lspkg/Core/Interactor/Interactor';
import { SIK } from 'SpectaclesInteractionKit.lspkg/SIK';

type InteractorLike = {
  activeTargetingMode?: number;
  startPoint?: vec3 | null;
  direction?: vec3 | null;
  distanceToTarget?: number | null;
  targetHitPosition?: vec3 | null;
  isActive?: () => boolean;
  isTriggering?: boolean;
  wasTriggering?: boolean;
  planecastPoint?: vec3 | null;
  onTriggerStart?: { add: (callback: (event?: unknown) => void) => void };
  onTriggerUpdate?: { add: (callback: (event?: unknown) => void) => void };
  onTriggerEnd?: { add: (callback: (event?: unknown) => void) => void };
  onTriggerCanceled?: { add: (callback: (event?: unknown) => void) => void };
};

type InteractorEventLike = {
  interactor?: InteractorLike | null;
};

type ColorBlobTarget = {
  center: vec3;
  extent: vec3;
  rotation: quat;
  material: Material;
  mesh: RenderMesh;
  visualObject: SceneObject;
  proxyObject?: SceneObject;
};

type InteractableLike = ScriptComponent & {
  targetingMode?: number;
  ignoreInteractionPlane?: boolean;
  keepHoverOnTrigger?: boolean;
  enableInstantDrag?: boolean;
  onDragStart?: { add: (cb: (event: InteractorEventLike) => void) => void };
  onDragUpdate?: { add: (cb: (event: InteractorEventLike) => void) => void };
  onDragEnd?: { add: (cb: () => void) => void };
  onTriggerStart?: { add: (cb: (event: InteractorEventLike) => void) => void };
  onTriggerUpdate?: { add: (cb: (event: InteractorEventLike) => void) => void };
  onTriggerEnd?: { add: (cb: () => void) => void };
  onTriggerEndOutside?: { add: (cb: () => void) => void };
  onInteractorTriggerStart?: { add: (cb: (event: InteractorEventLike) => void) => void };
  onInteractorTriggerUpdate?: { add: (cb: (event: InteractorEventLike) => void) => void };
  onInteractorTriggerEnd?: { add: (cb: () => void) => void };
  onInteractorTriggerEndOutside?: { add: (cb: () => void) => void };
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
 * Makes the palette scene object pinch-grabbable and movable.
 */
@component
export class PaletteGrab extends BaseScriptComponent {
  @input
  debugLogging: boolean = false;

  /** Local-space box size. palette root is scaled ~0.01 with mesh children at ~100. */
  @input
  colliderSize: vec3 = new vec3(1000, 700, 250);

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
  @allowUndefined
  anchorController!: ScriptComponent;

  @input
  enablePalettePainting: boolean = true;

  @input('float')
  paintDotScaleCm: number = 1.1;

  @input('float')
  paintSampleStepCm: number = 1.2;

  @input('float')
  paintRayDistanceCm: number = 32;

  @input('float')
  @hint('Max paint distance from palette center (cm)')
  paintMaxDistanceFromPaletteCm: number = 120;

  @input('float')
  colorBlobProxyRadiusCm: number = 2.6;

  @input('float')
  cancelButtonRadiusCm: number = 3.2;

  @input
  @hint('Use a stable mesh for paint dots instead of color-blob meshes')
  useStablePaintDotMesh: boolean = true;

  @input
  showSelectedColorFeedback: boolean = true;

  @input('float')
  selectedColorIndicatorScale: number = 1.28;

  @input('float')
  selectedColorIndicatorLiftCm: number = 0.15;

  @input('float')
  selectedColorPulseScale: number = 1.18;

  @input('float')
  selectedColorPulseDurationSec: number = 0.18;

  @input
  @hint('Legacy fallback handle. AnchorController now supplies the standard garden MoveHandle.')
  enablePaletteMoveHandle: boolean = false;

  @input
  moveHandleLocalPosition: vec3 = new vec3(0, 9, 0);

  @input('float')
  moveHandleRadiusCm: number = 4.2;

  private grabInteractable: InteractableLike | null = null;
  private grabManipulation: InteractableManipulationLike | null = null;
  private moveHandleObject: SceneObject | null = null;
  private moveHandleInteractable: InteractableLike | null = null;
  private moveHandleManipulation: InteractableManipulationLike | null = null;
  private moveInteractionWired = false;
  private moveHandleWired = false;
  private moveBindAttempts = 0;
  private moveActive = false;
  private grabAudioPlayer: AudioComponent | null = null;
  private resolvedGrabTrack: AudioTrackAsset | null = null;
  private resolvedReleaseTrack: AudioTrackAsset | null = null;
  private paintModeActive = false;
  private selectedPaintMaterial: Material | null = null;
  private selectedPaintMesh: RenderMesh | null = null;
  private stablePaintMesh: RenderMesh | null = null;
  private activePaintInteractor: InteractorLike | null = null;
  private lastPaintPoint: vec3 | null = null;
  private paintUpdateEvent: UpdateEvent | null = null;
  private cancelButton: SceneObject | null = null;
  private cancelButtonBackgroundMaterial: Material | null = null;
  private cancelButtonTextMaterial: Material | null = null;
  private cancelButtonFollowEvent: UpdateEvent | null = null;
  private moveHandleFollowEvent: UpdateEvent | null = null;
  private strokeRoot: SceneObject | null = null;
  private paletteMoveEnabled = true;
  private paintStrokeActive = false;
  private cancelInteractionActive = false;
  private paintArmReadyAt = 0;
  private paintNeedsReleaseAfterPick = false;
  private freeSpaceInteractorsWired = false;
  private freeSpaceBindAttempts = 0;
  private freeSpaceBindRetryEvent: DelayedCallbackEvent | null = null;
  private colorBlobTargets: ColorBlobTarget[] = [];
  private lastColorPickIndex = -1;
  private lastColorPickAt = -9999;
  private selectedColorIndicator: SceneObject | null = null;
  private selectedColorIndicatorVisual: RenderMeshVisual | null = null;
  private selectedColorIndicatorMaterial: Material | null = null;
  private selectedColorIndicatorSourceMaterial: Material | null = null;
  private selectedColorPulseEvent: UpdateEvent | null = null;
  private selectedColorPulseTarget: SceneObject | null = null;
  private selectedColorPulseBaseScale: vec3 = vec3.one();
  private selectedColorPulseStartedAt = 0;

  private static readonly ANCHOR_SOURCE_NAME = 'palette';
  private static readonly COLORS_NODE_NAME = 'Colors';
  private static readonly CANCEL_BUTTON_NAME = 'PalettePaintCancel';
  private static readonly CANCEL_BUTTON_TEXT_NAME = 'CancelText';
  private static readonly STROKE_DOT_NAME = 'PalettePaintDot';
  private static readonly MOVE_HANDLE_NAME = 'PaletteMoveHandle';

  private getAnchorHandler(): {
    persistGardenSourceTransform?: (sourceName: string) => void;
    setActiveManipulatedRoot?: (root: SceneObject | null) => void;
  } | null {
    if (isNull(this.anchorController)) {
      return null;
    }
    return this.anchorController as unknown as {
      persistGardenSourceTransform?: (sourceName: string) => void;
      setActiveManipulatedRoot?: (root: SceneObject | null) => void;
    };
  }

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => {
      this.ensureGrabSounds();
      this.tryWireMoveInteraction();
      this.setupPalettePainting();
      if (this.debugLogging) {
        print('[PaletteGrab] ready');
      }
    });

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

  private setupPalettePainting(): void {
    if (!this.enablePalettePainting) {
      return;
    }
    this.resolveStablePaintMesh();
    this.createColorBlobTouchProxies();
    this.bindFreeSpacePaintInteractors();
    this.ensureCancelPaintButton();
    this.setPaintMode(false);
  }

  private bindFreeSpacePaintInteractors(): void {
    if (this.freeSpaceInteractorsWired) {
      return;
    }

    try {
      const interactors = SIK.InteractionManager.getInteractorsByType(
        InteractorInputType.All
      ) as unknown as InteractorLike[];
      let bound = false;
      for (let i = 0; i < interactors.length; i++) {
        const interactor = interactors[i];
        if (isNull(interactor)) {
          continue;
        }

        if (interactor.onTriggerStart) {
          interactor.onTriggerStart.add(() => this.onFreeSpacePaintStart(interactor));
          bound = true;
        }
        if (interactor.onTriggerUpdate) {
          interactor.onTriggerUpdate.add(() => this.onFreeSpacePaintUpdate(interactor));
          bound = true;
        }
        if (interactor.onTriggerEnd) {
          interactor.onTriggerEnd.add(() => this.onFreeSpacePaintEnd(interactor));
          bound = true;
        }
        if (interactor.onTriggerCanceled) {
          interactor.onTriggerCanceled.add(() => this.onFreeSpacePaintEnd(interactor));
          bound = true;
        }
      }

      if (bound) {
        this.freeSpaceInteractorsWired = true;
        if (this.debugLogging) {
          print(`[PaletteGrab] free-space paint interactors wired (${interactors.length})`);
        }
        return;
      }
    } catch (error) {
      if (this.debugLogging) {
        print('[PaletteGrab] free-space interactor binding deferred: ' + error);
      }
    }

    this.scheduleFreeSpaceInteractorBindRetry();
  }

  private scheduleFreeSpaceInteractorBindRetry(): void {
    if (
      this.freeSpaceInteractorsWired ||
      !isNull(this.freeSpaceBindRetryEvent) ||
      this.freeSpaceBindAttempts >= 20
    ) {
      return;
    }

    this.freeSpaceBindAttempts++;
    const retryEvent = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
    retryEvent.bind(() => {
      this.freeSpaceBindRetryEvent = null;
      this.bindFreeSpacePaintInteractors();
    });
    this.freeSpaceBindRetryEvent = retryEvent;
    retryEvent.reset(0.25);
  }

  private onFreeSpacePaintStart(interactor: InteractorLike): void {
    if (!this.paintModeActive || this.cancelInteractionActive || isNull(interactor)) {
      return;
    }

    const sameActiveStroke =
      this.paintStrokeActive && this.activePaintInteractor === interactor;
    this.activePaintInteractor = interactor;
    if (this.paintNeedsReleaseAfterPick || getTime() < this.paintArmReadyAt) {
      return;
    }
    if (sameActiveStroke) {
      return;
    }

    this.paintStrokeActive = true;
    this.lastPaintPoint = null;
    this.paintFromInteractor(interactor, true);
  }

  private onFreeSpacePaintUpdate(interactor: InteractorLike): void {
    if (!this.paintModeActive || this.cancelInteractionActive || isNull(interactor)) {
      return;
    }

    this.activePaintInteractor = interactor;
    if (this.paintNeedsReleaseAfterPick || getTime() < this.paintArmReadyAt) {
      return;
    }
    if (!this.paintStrokeActive) {
      this.paintStrokeActive = true;
      this.lastPaintPoint = null;
      this.paintFromInteractor(interactor, true);
      return;
    }
    this.paintFromInteractor(interactor, false);
  }

  private onFreeSpacePaintEnd(interactor: InteractorLike): void {
    if (!this.paintModeActive || isNull(interactor)) {
      return;
    }
    if (
      !isNull(this.activePaintInteractor) &&
      this.activePaintInteractor !== interactor
    ) {
      return;
    }

    this.paintNeedsReleaseAfterPick = false;
    this.paintStrokeActive = false;
    this.lastPaintPoint = null;
    this.activePaintInteractor = interactor;
  }

  private createColorBlobTouchProxies(): void {
    const colorsNode = this.findNamedChild(this.getSceneObject(), PaletteGrab.COLORS_NODE_NAME);
    if (isNull(colorsNode)) {
      print('[PaletteGrab] Colors node not found for paint blobs');
      return;
    }

    const visuals = colorsNode.getComponents('Component.RenderMeshVisual') as RenderMeshVisual[];
    this.colorBlobTargets = [];
    for (let i = 0; i < visuals.length; i++) {
      const visual = visuals[i];
      if (isNull(visual) || isNull(visual.mesh) || visual.mainMaterial === null) {
        continue;
      }

      const worldMin = visual.worldAabbMin();
      const worldMax = visual.worldAabbMax();
      const center = new vec3(
        (worldMin.x + worldMax.x) * 0.5,
        (worldMin.y + worldMax.y) * 0.5,
        (worldMin.z + worldMax.z) * 0.5
      );
      const extent = new vec3(
        Math.abs(worldMax.x - worldMin.x),
        Math.abs(worldMax.y - worldMin.y),
        Math.abs(worldMax.z - worldMin.z)
      );
      this.colorBlobTargets.push({
        center,
        extent,
        rotation: colorsNode.getTransform().getWorldRotation(),
        material: visual.mainMaterial as Material,
        mesh: visual.mesh as RenderMesh,
        visualObject: visual.getSceneObject(),
      });
    }

    for (let i = 0; i < this.colorBlobTargets.length; i++) {
      const target = this.colorBlobTargets[i];
      let nearestOtherDistance = Number.MAX_VALUE;
      for (let j = 0; j < this.colorBlobTargets.length; j++) {
        if (i === j) {
          continue;
        }
        nearestOtherDistance = Math.min(
          nearestOtherDistance,
          target.center.distance(this.colorBlobTargets[j].center)
        );
      }
      const visualRadius =
        Math.max(target.extent.x, Math.max(target.extent.y, target.extent.z)) * 0.42;
      const separationRadius =
        nearestOtherDistance < Number.MAX_VALUE ? nearestOtherDistance * 0.38 : visualRadius;
      const radius = Math.max(
        0.65,
        Math.min(this.colorBlobProxyRadiusCm, visualRadius, separationRadius)
      );
      const proxy = global.scene.createSceneObject(`PaletteColorBlob_${i}`);
      target.proxyObject = proxy;
      proxy.setParent(this.getSceneObject());
      proxy.getTransform().setWorldPosition(target.center);
      proxy.getTransform().setWorldRotation(quat.quatIdentity());
      proxy.getTransform().setWorldScale(vec3.one());
      proxy.layer = this.getSceneObject().layer;

      const collider = proxy.createComponent('Component.ColliderComponent') as ColliderComponent;
      const shape = Shape.createSphereShape();
      shape.radius = Math.max(0.25, radius);
      (collider as unknown as { shape?: unknown; intangible?: boolean }).shape = shape;
      (collider as unknown as { intangible?: boolean }).intangible = false;

      const interactable = proxy.createComponent(Interactable.getTypeName()) as InteractableLike;
      interactable.targetingMode = 7;
      interactable.ignoreInteractionPlane = true;
      interactable.keepHoverOnTrigger = true;
      interactable.enableInstantDrag = true;

      const onPick = (event: InteractorEventLike): void => {
        const now = getTime();
        if (this.lastColorPickIndex === i && now - this.lastColorPickAt < 0.15) {
          return;
        }
        this.lastColorPickIndex = i;
        this.lastColorPickAt = now;
        this.enterPaintMode(i, target.material, target.mesh, event?.interactor || null);
      };
      if (interactable.onTriggerStart) {
        interactable.onTriggerStart.add(onPick);
      }
      if (interactable.onInteractorTriggerStart) {
        interactable.onInteractorTriggerStart.add(onPick);
      }
      if (interactable.onDragStart) {
        interactable.onDragStart.add(onPick);
      }
    }
  }

  private isClosestColorBlob(index: number, event: InteractorEventLike): boolean {
    const interactor = event?.interactor || null;
    if (isNull(interactor)) {
      return true;
    }
    const point = interactor.targetHitPosition || interactor.startPoint || null;
    if (isNull(point)) {
      return true;
    }

    let closestIndex = -1;
    let closestDistance = Number.MAX_VALUE;
    for (let i = 0; i < this.colorBlobTargets.length; i++) {
      const distance = this.colorBlobTargets[i].center.distance(point as vec3);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = i;
      }
    }
    return closestIndex === index;
  }

  private ensureCancelPaintButton(): void {
    if (!isNull(this.cancelButton)) {
      this.ensureCancelButtonFollowLoop();
      return;
    }

    const root = this.getSceneObject();
    const button = global.scene.createSceneObject(PaletteGrab.CANCEL_BUTTON_NAME);
    const parent = root.hasParent() ? root.getParent() : root;
    button.setParent(parent);
    const buttonPosition = root
      .getTransform()
      .getWorldPosition()
      .add(root.getTransform().up.uniformScale(1.2));
    button.getTransform().setWorldPosition(buttonPosition);
    button.getTransform().setWorldRotation(root.getTransform().getWorldRotation());
    const visualRadius = Math.max(2.2, this.cancelButtonRadiusCm * 1.15);
    button.getTransform().setWorldScale(vec3.one());
    button.layer = root.layer;

    const collider = button.createComponent('Component.ColliderComponent') as ColliderComponent;
    const shape = Shape.createSphereShape();
    shape.radius = Math.max(0.25, this.cancelButtonRadiusCm);
    (collider as unknown as { shape?: unknown; intangible?: boolean }).shape = shape;
    (collider as unknown as { intangible?: boolean }).intangible = false;

    this.createCancelButtonVisual(button, buttonPosition, visualRadius);

    const interactable = button.createComponent(Interactable.getTypeName()) as InteractableLike;
    interactable.targetingMode = 7;
    interactable.ignoreInteractionPlane = true;
    interactable.keepHoverOnTrigger = true;
    interactable.enableInstantDrag = false;

    const cancel = (): void => {
      this.cancelInteractionActive = true;
      this.setPaintMode(false);
      if (!isNull(this.grabManipulation)) {
        (this.grabManipulation as ScriptComponent).enabled = false;
      }
    };
    const releaseCancel = (): void => {
      const releaseEvent = this.createEvent('DelayedCallbackEvent');
      releaseEvent.bind(() => {
        this.cancelInteractionActive = false;
        if (!isNull(this.grabManipulation) && this.paletteMoveEnabled) {
          (this.grabManipulation as ScriptComponent).enabled = true;
        }
      });
      releaseEvent.reset(0.08);
    };
    if (interactable.onTriggerStart) {
      interactable.onTriggerStart.add(cancel);
    }
    if (interactable.onInteractorTriggerStart) {
      interactable.onInteractorTriggerStart.add(cancel);
    }
    if (interactable.onDragStart) {
      interactable.onDragStart.add(cancel);
    }
    if (interactable.onDragEnd) {
      interactable.onDragEnd.add(releaseCancel);
    }
    if (interactable.onTriggerEnd) {
      interactable.onTriggerEnd.add(releaseCancel);
    }
    if (interactable.onTriggerEndOutside) {
      interactable.onTriggerEndOutside.add(releaseCancel);
    }
    if (interactable.onInteractorTriggerEnd) {
      interactable.onInteractorTriggerEnd.add(releaseCancel);
    }
    if (interactable.onInteractorTriggerEndOutside) {
      interactable.onInteractorTriggerEndOutside.add(releaseCancel);
    }

    const textNode = global.scene.createSceneObject(PaletteGrab.CANCEL_BUTTON_TEXT_NAME);
    textNode.setParent(button);
    textNode.layer = root.layer;
    // Put the X beyond the button surface, not inside its background mesh.
    // This keeps it visible before hover/press state changes.
    textNode
      .getTransform()
      .setLocalPosition(new vec3(0, visualRadius + 0.35, 0));
    textNode.getTransform().setLocalRotation(quat.quatIdentity());
    textNode.getTransform().setLocalScale(new vec3(0.13, 0.13, 0.13));

    const text = textNode.createComponent('Component.Text3D') as Text3D;
    text.enabled = true;
    text.text = 'X';
    text.size = 38;
    text.extrusionDepth = 0.05;
    text.horizontalAlignment = HorizontalAlignment.Center;
    text.verticalAlignment = VerticalAlignment.Center;
    text.renderOrder = 13;
    const textMaterial = this.createCancelButtonTextMaterial();
    if (!isNull(textMaterial)) {
      text.mainMaterial = textMaterial as Material;
    }

    this.cancelButton = button;
    this.ensureCancelButtonFollowLoop();
  }

  private createCancelButtonVisual(
    button: SceneObject,
    buttonPosition: vec3,
    visualRadius: number
  ): void {
    if (this.colorBlobTargets.length === 0) {
      print('[PaletteGrab] cancel button visual skipped: no valid color material');
      return;
    }

    const target = this.findReddestColorTarget();
    const visualNode = global.scene.createSceneObject('CancelButtonBackground');
    visualNode.setParent(button);
    visualNode.layer = button.layer;
    visualNode.getTransform().setWorldPosition(buttonPosition);
    visualNode.getTransform().setWorldRotation(target.rotation);
    visualNode.getTransform().setWorldScale(vec3.one());

    const visual = visualNode.createComponent(
      'Component.RenderMeshVisual'
    ) as RenderMeshVisual;
    visual.mesh = target.mesh;
    const backgroundMaterial = this.createCancelButtonBackgroundMaterial(
      !isNull(target.material) ? (target.material as Material) : null
    );
    if (!isNull(backgroundMaterial)) {
      visual.mainMaterial = backgroundMaterial as Material;
    } else if (!isNull(target.material)) {
      visual.mainMaterial = target.material as Material;
    }
    visual.renderOrder = 12;

    const worldMin = visual.worldAabbMin();
    const worldMax = visual.worldAabbMax();
    const meshCenter = new vec3(
      (worldMin.x + worldMax.x) * 0.5,
      (worldMin.y + worldMax.y) * 0.5,
      (worldMin.z + worldMax.z) * 0.5
    );
    const maxExtent = Math.max(
      Math.abs(worldMax.x - worldMin.x),
      Math.max(
        Math.abs(worldMax.y - worldMin.y),
        Math.abs(worldMax.z - worldMin.z)
      )
    );
    const scale = (visualRadius * 2) / Math.max(0.001, maxExtent);
    const authoredOffset = meshCenter.sub(buttonPosition);
    visualNode
      .getTransform()
      .setWorldPosition(buttonPosition.sub(authoredOffset.uniformScale(scale)));
    visualNode.getTransform().setWorldScale(new vec3(scale, scale, scale));
  }

  private createCancelButtonBackgroundMaterial(fallback: Material | null): Material | null {
    if (!isNull(this.cancelButtonBackgroundMaterial)) {
      return this.cancelButtonBackgroundMaterial as Material;
    }

    const template = this.resolveCompanionBodyMaterial();
    const material =
      this.tryCloneMaterial(template) ||
      this.tryCloneMaterial(fallback) ||
      this.tryCloneMaterial(this.resolveLegacyCancelTemplateMaterial());
    if (isNull(material)) {
      return null;
    }

    const pass = material.mainPass as unknown as Record<string, unknown>;
    const blackTint = new vec3(0.035, 0.05, 0.075);
    const alpha = 0.62;

    this.trySetPassValue(pass, 'depthWrite', false);
    this.trySetPassValue(pass, 'depthTest', true);
    this.trySetPassValue(pass, 'blendMode', BlendMode.PremultipliedAlphaAuto);
    // Match ArvisGhostBlob's live water-shader configuration, then apply a
    // dark tint instead of the companion's phase color.
    this.trySetPassValue(pass, 'Tweak_N171', 0.025 + alpha * 0.07);
    this.trySetPassValue(pass, 'Tweak_N172', 0.012 + alpha * 0.035);
    this.trySetPassValue(pass, 'Port_Input1_N016', 0.45 + alpha * 0.45);
    this.trySetPassValue(pass, 'Port_Input1_N080', 0.55 + alpha * 0.35);
    this.trySetPassValue(pass, 'Port_AO_N170', blackTint);
    this.trySetPassValue(pass, 'Port_Emissive_N170', new vec3(0, 0, 0));
    this.trySetPassValue(
      pass,
      'baseColor',
      new vec4(blackTint.x * alpha, blackTint.y * alpha, blackTint.z * alpha, alpha)
    );

    this.cancelButtonBackgroundMaterial = material;
    return material;
  }

  private trySetPassValue(
    pass: Record<string, unknown>,
    key: string,
    value: unknown
  ): void {
    try {
      (pass as Record<string, unknown>)[key] = value;
    } catch (_error) {
      // Some platforms/material passes expose a restricted property set.
    }
  }

  private tryCloneMaterial(source: Material | null): Material | null {
    if (isNull(source)) {
      return null;
    }
    try {
      return (source as Material).clone();
    } catch (_error) {
      return null;
    }
  }

  private resolveLegacyCancelTemplateMaterial(): Material | null {
    try {
      return requireAsset('Materials & Shaders/Mat_AIChatBlack.mat') as Material;
    } catch (_error) {
      return null;
    }
  }

  private resolveCompanionBodyMaterial(): Material | null {
    const friend = this.findSceneObjectInScene('friend');
    if (!isNull(friend)) {
      const stack: SceneObject[] = [friend];
      while (stack.length > 0) {
        const current = stack.pop();
        if (isNull(current)) {
          continue;
        }
        const visuals = current.getComponents(
          'Component.RenderMeshVisual'
        ) as RenderMeshVisual[];
        for (let i = 0; i < visuals.length; i++) {
          let material: Material | null = null;
          try {
            material = visuals[i].mainMaterial;
          } catch (_error) {
            material = null;
          }
          if (isNull(material)) {
            continue;
          }
          let pass: Record<string, unknown> | null = null;
          try {
            pass = material.mainPass as unknown as Record<string, unknown>;
          } catch (_error) {
            pass = null;
          }
          if (isNull(pass)) {
            continue;
          }
          if (pass['scrollSpeed'] !== undefined || pass['opacityTextureA'] !== undefined) {
            return material;
          }
        }
        for (let i = 0; i < current.getChildrenCount(); i++) {
          stack.push(current.getChild(i));
        }
      }
    }

    try {
      // This is the exact material asset used by ArvisGhostBlob.waterMaterialTemplate.
      return requireAsset(
        'Ocean Water Material.lspkg/Materials/WaterMaterial.mat'
      ) as Material;
    } catch (_error) {
      return null;
    }
  }

  private findSceneObjectInScene(name: string): SceneObject | null {
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      const found = this.findSceneObjectRecursive(global.scene.getRootObject(i), name);
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findSceneObjectRecursive(root: SceneObject, name: string): SceneObject | null {
    if (String(root.name || '') === name) {
      return root;
    }
    for (let i = 0; i < root.getChildrenCount(); i++) {
      const found = this.findSceneObjectRecursive(root.getChild(i), name);
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private createCancelButtonTextMaterial(): Material | null {
    if (!isNull(this.cancelButtonTextMaterial)) {
      return this.cancelButtonTextMaterial;
    }

    let material: Material | null = null;
    try {
      material = (requireAsset('Text3D.mat') as Material).clone();
    } catch (_error) {
      return null;
    }

    const materialPass = material.mainPass;
    if (typeof materialPass.depthWrite !== 'undefined') {
      materialPass.depthWrite = false;
    }
    if (typeof materialPass.depthTest !== 'undefined') {
      materialPass.depthTest = false;
    }

    const pass = materialPass as unknown as Record<string, vec4>;
    const red = new vec4(0.95, 0.13, 0.16, 1);
    const colorKeys = [
      'frontCapStartingColor',
      'backCapStartingColor',
      'outerEdgeStartingColor',
      'outerEdgeEndingColor',
      'InnerEdgeStartingColor',
      'InnerEdgeEndingColor',
    ];
    for (let i = 0; i < colorKeys.length; i++) {
      if (typeof pass[colorKeys[i]] !== 'undefined') {
        pass[colorKeys[i]] = red;
      }
    }
    this.cancelButtonTextMaterial = material;
    return material;
  }

  private findReddestColorTarget(): ColorBlobTarget {
    let best = this.colorBlobTargets[0];
    let bestScore = -Number.MAX_VALUE;
    for (let i = 0; i < this.colorBlobTargets.length; i++) {
      const candidate = this.colorBlobTargets[i];
      const pass = candidate.material.mainPass as unknown as {
        baseColor?: vec4;
      };
      const color = pass.baseColor;
      const score = isNull(color)
        ? -i
        : color.x * 2 - color.y - color.z;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  }

  private enterPaintMode(
    colorIndex: number,
    material: Material | null,
    mesh: RenderMesh | null,
    interactor: InteractorLike | null
  ): void {
    if (isNull(material) || isNull(mesh)) {
      return;
    }
    this.selectedPaintMaterial = material;
    this.selectedPaintMesh = mesh;
    this.setPaintMode(true);
    this.activePaintInteractor = interactor;
    this.lastPaintPoint = null;
    this.paintStrokeActive = false;
    // Color tap should only arm paint mode. User must release and pinch again to draw.
    this.paintNeedsReleaseAfterPick = true;
    this.paintArmReadyAt = getTime() + 0.12;
    this.showSelectedColor(colorIndex);
  }

  private setPaintMode(active: boolean): void {
    if (!this.enablePalettePainting) {
      return;
    }
    if (this.paintModeActive === active) {
      return;
    }

    this.paintModeActive = active;
    this.setPaletteMoveInteractionEnabled(!active);
    this.ensurePaintUpdateLoop(active);

    if (isNull(this.cancelButton)) {
      this.ensureCancelPaintButton();
    }
    if (!isNull(this.cancelButton)) {
      // Keep the center cancel affordance visible so users can discover it.
      this.cancelButton.enabled = true;
    }

    if (!active) {
      this.activePaintInteractor = null;
      this.lastPaintPoint = null;
      this.paintStrokeActive = false;
      this.paintNeedsReleaseAfterPick = false;
      this.paintArmReadyAt = 0;
      this.hideSelectedColorIndicator();
    }

    if (this.debugLogging) {
      print(`[PaletteGrab] paint mode ${active ? 'ON' : 'OFF'}`);
    }
  }

  private setPaletteMoveInteractionEnabled(enabled: boolean): void {
    if (this.paletteMoveEnabled === enabled) {
      return;
    }
    this.paletteMoveEnabled = enabled;
    if (!isNull(this.grabManipulation)) {
      (this.grabManipulation as ScriptComponent).enabled = enabled;
    }
    if (!isNull(this.grabInteractable)) {
      // Keep the palette Interactable alive while painting so its ancestor
      // events continue to cover editor MouseInteractor and free-space pinches.
      (this.grabInteractable as ScriptComponent).enabled = true;
    }
  }

  private showSelectedColor(colorIndex: number): void {
    if (!this.showSelectedColorFeedback) {
      return;
    }
    if (colorIndex < 0 || colorIndex >= this.colorBlobTargets.length) {
      return;
    }

    const target = this.colorBlobTargets[colorIndex];
    this.updateSelectedColorIndicator(target);
    this.startSelectedColorPulse(target.visualObject);
  }

  private updateSelectedColorIndicator(target: ColorBlobTarget): void {
    const indicator = this.ensureSelectedColorIndicator();
    if (isNull(indicator) || isNull(this.selectedColorIndicatorVisual)) {
      return;
    }

    const sourceObject = target.visualObject;
    const sourceTransform = sourceObject.getTransform();
    const paletteTransform = this.getSceneObject().getTransform();
    const lift = Math.max(0, this.selectedColorIndicatorLiftCm);
    const indicatorPosition = sourceTransform
      .getWorldPosition()
      .add(paletteTransform.up.uniformScale(lift));

    indicator.enabled = true;
    indicator.layer = this.getSceneObject().layer;
    indicator.getTransform().setWorldPosition(indicatorPosition);
    indicator.getTransform().setWorldRotation(sourceTransform.getWorldRotation());

    const sourceScale = sourceTransform.getWorldScale();
    const indicatorScale = Math.max(1.01, this.selectedColorIndicatorScale);
    indicator.getTransform().setWorldScale(
      new vec3(
        sourceScale.x * indicatorScale,
        sourceScale.y * indicatorScale,
        sourceScale.z * indicatorScale
      )
    );

    const visual = this.selectedColorIndicatorVisual as RenderMeshVisual;
    visual.mesh = target.mesh;
    const material = this.createSelectedColorIndicatorMaterial(target.material);
    if (!isNull(material)) {
      visual.mainMaterial = material as Material;
    } else {
      visual.mainMaterial = target.material;
    }
    visual.renderOrder = 10;
  }

  private ensureSelectedColorIndicator(): SceneObject {
    if (this.isUsableSceneObject(this.selectedColorIndicator)) {
      return this.selectedColorIndicator as SceneObject;
    }

    const indicator = global.scene.createSceneObject('PaletteSelectedColorIndicator');
    indicator.setParent(this.getSceneObject());
    indicator.enabled = false;
    indicator.layer = this.getSceneObject().layer;
    this.selectedColorIndicator = indicator;
    this.selectedColorIndicatorVisual = indicator.createComponent(
      'Component.RenderMeshVisual'
    ) as RenderMeshVisual;
    return indicator;
  }

  private hideSelectedColorIndicator(): void {
    if (!isNull(this.selectedColorIndicator)) {
      (this.selectedColorIndicator as SceneObject).enabled = false;
    }
  }

  private createSelectedColorIndicatorMaterial(source: Material): Material | null {
    if (
      !isNull(this.selectedColorIndicatorMaterial) &&
      !isNull(this.selectedColorIndicatorSourceMaterial) &&
      this.selectedColorIndicatorSourceMaterial === source
    ) {
      return this.selectedColorIndicatorMaterial as Material;
    }

    const material = this.tryCloneMaterial(source);
    if (isNull(material)) {
      return null;
    }

    const pass = (material as Material).mainPass as unknown as Record<string, unknown>;
    this.trySetPassValue(pass, 'depthWrite', false);
    this.trySetPassValue(pass, 'depthTest', true);
    this.trySetPassValue(pass, 'blendMode', BlendMode.PremultipliedAlphaAuto);
    this.trySetPassValue(pass, 'Port_Emissive_N170', new vec3(0.35, 0.35, 0.35));

    this.selectedColorIndicatorMaterial = material as Material;
    this.selectedColorIndicatorSourceMaterial = source;
    return this.selectedColorIndicatorMaterial;
  }

  private startSelectedColorPulse(target: SceneObject): void {
    if (isNull(target) || this.selectedColorPulseDurationSec <= 0) {
      return;
    }

    this.selectedColorPulseTarget = target;
    this.selectedColorPulseBaseScale = target.getTransform().getWorldScale();
    this.selectedColorPulseStartedAt = getTime();

    if (isNull(this.selectedColorPulseEvent)) {
      this.selectedColorPulseEvent = this.createEvent('UpdateEvent');
      this.selectedColorPulseEvent.bind(() => this.updateSelectedColorPulse());
    }
    this.selectedColorPulseEvent.enabled = true;
  }

  private updateSelectedColorPulse(): void {
    const target = this.selectedColorPulseTarget;
    if (isNull(target)) {
      this.stopSelectedColorPulse();
      return;
    }

    const duration = Math.max(0.001, this.selectedColorPulseDurationSec);
    const t = Math.min(1, (getTime() - this.selectedColorPulseStartedAt) / duration);
    const eased = 1 - (1 - t) * (1 - t);
    const pulse = Math.max(1, this.selectedColorPulseScale);
    const scale = pulse + (1 - pulse) * eased;
    target.getTransform().setWorldScale(
      new vec3(
        this.selectedColorPulseBaseScale.x * scale,
        this.selectedColorPulseBaseScale.y * scale,
        this.selectedColorPulseBaseScale.z * scale
      )
    );

    if (t >= 1) {
      target.getTransform().setWorldScale(this.selectedColorPulseBaseScale);
      this.stopSelectedColorPulse();
    }
  }

  private stopSelectedColorPulse(): void {
    if (!isNull(this.selectedColorPulseEvent)) {
      (this.selectedColorPulseEvent as UpdateEvent).enabled = false;
    }
    this.selectedColorPulseTarget = null;
  }

  private ensurePaintUpdateLoop(enabled: boolean): void {
    if (!enabled) {
      if (!isNull(this.paintUpdateEvent)) {
        this.paintUpdateEvent.enabled = false;
      }
      return;
    }

    if (isNull(this.paintUpdateEvent)) {
      this.paintUpdateEvent = this.createEvent('UpdateEvent');
      this.paintUpdateEvent.bind(() => {
        if (!this.paintModeActive) {
          return;
        }
        const interactor = this.activePaintInteractor;
        if (
          isNull(interactor) ||
          (typeof interactor.isActive === 'function' && !interactor.isActive())
        ) {
          return;
        }
        if (typeof interactor.isTriggering === 'boolean' && !interactor.isTriggering) {
          if (this.paintNeedsReleaseAfterPick) {
            this.paintNeedsReleaseAfterPick = false;
          }
          this.paintStrokeActive = false;
          this.lastPaintPoint = null;
          return;
        }
        if (this.paintNeedsReleaseAfterPick || getTime() < this.paintArmReadyAt) {
          return;
        }
        if (!this.paintStrokeActive) {
          return;
        }
        this.paintFromInteractor(interactor, false);
      });
    }
    this.paintUpdateEvent.enabled = true;
  }

  private paintFromInteractor(interactor: InteractorLike | null, force: boolean): void {
    if (!this.paintModeActive || isNull(interactor)) {
      return;
    }
    if (!force && !this.paintStrokeActive) {
      return;
    }
    if (!force && typeof interactor.isActive === 'function' && !interactor.isActive()) {
      return;
    }
    const point = this.resolveInteractorPoint(interactor);
    if (isNull(point)) {
      return;
    }

    if (!force && !isNull(this.lastPaintPoint)) {
      if ((this.lastPaintPoint as vec3).distance(point) < Math.max(0.2, this.paintSampleStepCm)) {
        return;
      }
    }

    this.spawnPaintDot(point);
    this.lastPaintPoint = point;
  }

  private resolveInteractorPoint(interactor: InteractorLike | null): vec3 | null {
    if (isNull(interactor)) {
      return null;
    }

    const palettePos = this.getSceneObject().getTransform().getWorldPosition();
    const paletteUp = this.getSceneObject().getTransform().up;
    const clampDistance = Math.max(12, this.paintMaxDistanceFromPaletteCm);

    // SIK's planecastPoint follows the active Interactable's world-space
    // interaction plane in both Editor MouseInteractor and HandInteractor.
    if (!isNull(interactor.planecastPoint)) {
      const planePoint = interactor.planecastPoint as vec3;
      if (planePoint.distance(palettePos) <= clampDistance) {
        return planePoint;
      }
    }

    const start = interactor.startPoint || null;
    if (!isNull(start)) {
      // Pin hand interactions to palette plane using closest-point projection.
      const pinchPoint = start as vec3;
      const toPinch = pinchPoint.sub(palettePos);
      const projected = pinchPoint.sub(paletteUp.uniformScale(toPinch.dot(paletteUp)));
      if (projected.distance(palettePos) <= clampDistance) {
        return projected;
      }
    }

    const direction = interactor.direction || null;
    if (!isNull(start) && !isNull(direction)) {
      const rayStart = start as vec3;
      const rayDir = direction as vec3;
      const denom = rayDir.dot(paletteUp);
      if (Math.abs(denom) > 0.0001) {
        const t = palettePos.sub(rayStart).dot(paletteUp) / denom;
        if (t > 0 && t < Math.max(8, this.paintRayDistanceCm * 2.5)) {
          const planeHit = rayStart.add(rayDir.uniformScale(t));
          if (planeHit.distance(palettePos) <= clampDistance) {
            return planeHit;
          }
        }
      }
    }

    // Keep the hit-position fallback for older SIK builds that do not expose
    // planecastPoint while still rejecting stale hits far from this palette.
    if (!isNull(interactor.targetHitPosition)) {
      const hit = interactor.targetHitPosition as vec3;
      if (hit.distance(palettePos) <= clampDistance) {
        const planeOffset = Math.abs(hit.sub(palettePos).dot(paletteUp));
        if (planeOffset <= 8) {
          return hit;
        }
      }
    }

    return null;
  }

  private spawnPaintDot(worldPos: vec3): void {
    if (isNull(this.selectedPaintMaterial) || isNull(this.selectedPaintMesh)) {
      return;
    }

    const meshToUse =
      this.useStablePaintDotMesh && !isNull(this.stablePaintMesh)
        ? (this.stablePaintMesh as RenderMesh)
        : (this.selectedPaintMesh as RenderMesh);
    const dot = global.scene.createSceneObject(PaletteGrab.STROKE_DOT_NAME);
    dot.setParent(this.ensureStrokeRoot());
    dot.getTransform().setWorldPosition(worldPos);
    dot.getTransform().setWorldRotation(this.getSceneObject().getTransform().getWorldRotation());
    const scale = Math.max(0.1, this.paintDotScaleCm);
    dot.getTransform().setWorldScale(new vec3(scale, scale, scale));
    dot.layer = this.getSceneObject().layer;

    const visual = dot.createComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    visual.mesh = meshToUse;
    visual.mainMaterial = this.selectedPaintMaterial as Material;
    visual.renderOrder = 11;
  }

  private ensureStrokeRoot(): SceneObject {
    if (this.isUsableSceneObject(this.strokeRoot)) {
      return this.strokeRoot as SceneObject;
    }

    const palette = this.getSceneObject();
    const parent = palette.hasParent() ? palette.getParent() : null;
    if (isNull(parent)) {
      this.strokeRoot = palette;
      return palette;
    }

    for (let i = 0; i < parent.getChildrenCount(); i++) {
      const child = parent.getChild(i);
      if (!isNull(child) && String(child.name) === 'PalettePaintStrokes') {
        this.strokeRoot = child;
        return child;
      }
    }

    const root = global.scene.createSceneObject('PalettePaintStrokes');
    root.setParent(parent);
    root.layer = palette.layer;
    root.getTransform().setLocalPosition(vec3.zero());
    root.getTransform().setLocalRotation(quat.quatIdentity());
    root.getTransform().setLocalScale(vec3.one());
    this.strokeRoot = root;
    return root;
  }

  private isUsableSceneObject(node: SceneObject | null): boolean {
    if (isNull(node)) {
      return false;
    }
    try {
      return !isNull(node.getTransform());
    } catch (_e) {
      return false;
    }
  }

  private findNamedChild(parent: SceneObject, name: string): SceneObject | null {
    if (isNull(parent)) {
      return null;
    }
    const stack: SceneObject[] = [parent];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }
      if (String(current.name) === name) {
        return current;
      }
      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
    return null;
  }

  private findFirstRenderable(root: SceneObject): RenderMeshVisual | null {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }
      const visuals = current.getComponents('Component.RenderMeshVisual') as RenderMeshVisual[];
      for (let i = 0; i < visuals.length; i++) {
        const v = visuals[i];
        if (!isNull(v) && !isNull(v.mesh) && !isNull(v.mainMaterial)) {
          return v;
        }
      }
      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
    return null;
  }

  private resolveStablePaintMesh(): void {
    try {
      // Palette color meshes are flat triangles with palette-specific scale.
      // A built-in sphere gives strokes a stable, round silhouette instead.
      this.stablePaintMesh = requireAsset('Meshes/StarCatchSphere.mesh') as RenderMesh;
      return;
    } catch (_error) {
      // Fall back to an authored renderable if the built-in mesh is unavailable.
    }

    const renderable = this.findFirstRenderable(this.getSceneObject());
    if (!isNull(renderable) && !isNull(renderable.mesh)) {
      this.stablePaintMesh = renderable.mesh as RenderMesh;
      return;
    }
    this.stablePaintMesh = null;
  }

  private ensureCancelButtonFollowLoop(): void {
    if (isNull(this.cancelButtonFollowEvent)) {
      this.cancelButtonFollowEvent = this.createEvent('UpdateEvent');
      this.cancelButtonFollowEvent.bind(() => {
        if (isNull(this.cancelButton)) {
          return;
        }
        const root = this.getSceneObject();
        const rootTransform = root.getTransform();
        const buttonTransform = (this.cancelButton as SceneObject).getTransform();
        buttonTransform.setWorldPosition(
          rootTransform.getWorldPosition().add(rootTransform.up.uniformScale(1.2))
        );
        buttonTransform.setWorldRotation(rootTransform.getWorldRotation());
        (this.cancelButton as SceneObject).layer = root.layer;
      });
    }
    this.cancelButtonFollowEvent.enabled = true;
  }

  private ensureAnchorGrabComponents(): void {
    const anchor = this.getSceneObject();
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
    manipulation.enableRotation = true;
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
        (candidate.onDragStart !== undefined ||
          candidate.onTriggerEnd !== undefined ||
          candidate.onInteractorTriggerEnd !== undefined)
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
    if (this.moveInteractionWired && (!this.enablePaletteMoveHandle || this.moveHandleWired)) {
      return;
    }

    this.ensureAnchorGrabComponents();
    this.ensurePaletteMoveHandleComponents();
    const interactable = this.grabInteractable;
    const manipulation = this.grabManipulation;
    if (isNull(interactable) || isNull(manipulation)) {
      this.moveBindAttempts++;
      if (this.moveBindAttempts >= 30) {
        print('[PaletteGrab] could not bind grab interaction');
        return;
      }

      const retryEvent = this.createEvent('DelayedCallbackEvent');
      retryEvent.bind(() => this.tryWireMoveInteraction());
      retryEvent.reset(0.1);
      return;
    }

    this.refreshGrabCollider();
    this.bindManipulationRoot(manipulation, this.getSceneObject());

    const onGrabStart = (event: InteractorEventLike): void => {
      this.onPaletteGrabStart(event, false);
      this.onPaintDragStart(event);
    };
    const onGrabUpdate = (event: InteractorEventLike): void => {
      this.onPaintDragUpdate(event);
    };
    const onGrabRelease = (): void => {
      this.onPaletteGrabRelease();
      this.onPaintDragEnd();
    };

    if (manipulation.onManipulationStart) {
      manipulation.onManipulationStart.add(() => {
        this.onPaletteGrabStart(undefined, false);
      });
    }
    if (manipulation.onManipulationEnd) {
      manipulation.onManipulationEnd.add(onGrabRelease);
    }
    if (interactable.onDragStart) {
      interactable.onDragStart.add(onGrabStart);
    }
    if (interactable.onDragUpdate) {
      interactable.onDragUpdate.add(onGrabUpdate);
    }
    if (interactable.onTriggerStart) {
      interactable.onTriggerStart.add(onGrabStart);
    }
    if (interactable.onTriggerUpdate) {
      interactable.onTriggerUpdate.add(onGrabUpdate);
    }
    if (interactable.onInteractorTriggerStart) {
      interactable.onInteractorTriggerStart.add(onGrabStart);
    }
    if (interactable.onInteractorTriggerUpdate) {
      interactable.onInteractorTriggerUpdate.add(onGrabUpdate);
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

    manipulation.enableTranslation = true;
    manipulation.enableRotation = true;
    (manipulation as ScriptComponent).enabled = true;
    (interactable as ScriptComponent).enabled = true;

    this.moveInteractionWired = true;

    const handleInteractable = this.moveHandleInteractable;
    const handleManipulation = this.moveHandleManipulation;
    if (!isNull(handleInteractable) && !isNull(handleManipulation) && !this.moveHandleWired) {
      const onHandleStart = (event: InteractorEventLike): void => {
        this.onPaletteGrabStart(event, true);
      };
      const onHandleEnd = (): void => {
        this.onPaletteGrabRelease();
      };
      if (handleManipulation.onManipulationStart) {
        handleManipulation.onManipulationStart.add(() => {
          this.onPaletteGrabStart(undefined, true);
        });
      }
      if (handleManipulation.onManipulationEnd) {
        handleManipulation.onManipulationEnd.add(onHandleEnd);
      }
      if (handleInteractable.onDragStart) {
        handleInteractable.onDragStart.add(onHandleStart);
      }
      if (handleInteractable.onTriggerStart) {
        handleInteractable.onTriggerStart.add(onHandleStart);
      }
      if (handleInteractable.onInteractorTriggerStart) {
        handleInteractable.onInteractorTriggerStart.add(onHandleStart);
      }
      if (handleInteractable.onDragEnd) {
        handleInteractable.onDragEnd.add(onHandleEnd);
      }
      if (handleInteractable.onTriggerEnd) {
        handleInteractable.onTriggerEnd.add(onHandleEnd);
      }
      if (handleInteractable.onTriggerEndOutside) {
        handleInteractable.onTriggerEndOutside.add(onHandleEnd);
      }
      if (handleInteractable.onInteractorTriggerEnd) {
        handleInteractable.onInteractorTriggerEnd.add(onHandleEnd);
      }
      if (handleInteractable.onInteractorTriggerEndOutside) {
        handleInteractable.onInteractorTriggerEndOutside.add(onHandleEnd);
      }

      (handleManipulation as ScriptComponent).enabled = true;
      (handleInteractable as ScriptComponent).enabled = true;
      this.moveHandleWired = true;
    }

    print('[PaletteGrab] grab interaction wired');
  }

  private onPaletteGrabStart(_event?: InteractorEventLike, allowWhilePainting: boolean = false): void {
    if (this.cancelInteractionActive) {
      return;
    }
    if (this.paintModeActive && !allowWhilePainting) {
      return;
    }
    if (allowWhilePainting && this.paintModeActive) {
      this.setPaintMode(false);
    }
    if (this.moveActive) {
      return;
    }
    this.moveActive = true;
    const handler = this.getAnchorHandler();
    if (!isNull(handler) && typeof handler.setActiveManipulatedRoot === 'function') {
      handler.setActiveManipulatedRoot(this.getSceneObject());
    }
    this.playGrabSound(this.resolvedGrabTrack, this.grabSoundVolume, 'grab');
    if (this.debugLogging) {
      print('[PaletteGrab] grab start');
    }
  }

  private onPaletteGrabRelease(): void {
    if (!this.moveActive) {
      return;
    }
    this.moveActive = false;
    const handler = this.getAnchorHandler();
    if (!isNull(handler)) {
      if (typeof handler.setActiveManipulatedRoot === 'function') {
        handler.setActiveManipulatedRoot(null);
      }
      if (typeof handler.persistGardenSourceTransform === 'function') {
        handler.persistGardenSourceTransform(PaletteGrab.ANCHOR_SOURCE_NAME);
      }
    }
    this.playGrabSound(this.resolvedReleaseTrack, this.releaseSoundVolume, 'release');
    if (this.debugLogging) {
      print('[PaletteGrab] grab end');
    }
  }

  private ensurePaletteMoveHandleComponents(): void {
    const root = this.getSceneObject();
    const handleSearchRoot = root.hasParent() ? root.getParent() : root;
    const disableLegacyHandle = (): void => {
      const legacyHandle = this.findNamedChild(
        handleSearchRoot,
        PaletteGrab.MOVE_HANDLE_NAME
      );
      if (!isNull(legacyHandle)) {
        legacyHandle.enabled = false;
      }
    };

    // The palette is grabbed directly; remove any dedicated handle left by an
    // older scene/runtime version.
    if (!isNull(this.anchorController)) {
      disableLegacyHandle();
      const gardenHandle = this.findNamedChild(root, 'MoveHandle');
      if (!isNull(gardenHandle)) {
        gardenHandle.enabled = false;
      }
      this.moveHandleObject = null;
      this.moveHandleInteractable = null;
      this.moveHandleManipulation = null;
      return;
    }

    const gardenHandle = this.findNamedChild(root, 'MoveHandle');
    if (!isNull(gardenHandle)) {
      disableLegacyHandle();
      this.moveHandleObject = null;
      this.moveHandleInteractable = null;
      this.moveHandleManipulation = null;
      return;
    }

    if (!this.enablePaletteMoveHandle) {
      disableLegacyHandle();
      this.moveHandleObject = null;
      this.moveHandleInteractable = null;
      this.moveHandleManipulation = null;
      return;
    }

    let handle = this.findNamedChild(root, PaletteGrab.MOVE_HANDLE_NAME);
    if (isNull(handle)) {
      handle = global.scene.createSceneObject(PaletteGrab.MOVE_HANDLE_NAME);
    }
    const parent = root.hasParent() ? root.getParent() : root;
    if (handle.getParent() !== parent) {
      handle.setParent(parent);
    }
    this.applyMoveHandlePose(handle, root);
    this.moveHandleObject = handle;

    const existingVisual = handle.getComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    if (isNull(existingVisual)) {
      const template = this.findFirstRenderable(root);
      if (!isNull(template) && !isNull(template.mesh) && !isNull(template.mainMaterial)) {
        const visual = handle.createComponent('Component.RenderMeshVisual') as RenderMeshVisual;
        visual.mesh = template.mesh as RenderMesh;
        visual.mainMaterial = template.mainMaterial as Material;
        visual.renderOrder = 12;
      }
    }

    let collider = handle.getComponent('Physics.ColliderComponent') as ColliderComponent;
    if (isNull(collider)) {
      collider = handle.getComponent('Component.ColliderComponent') as ColliderComponent;
    }
    if (isNull(collider)) {
      collider = handle.createComponent('Physics.ColliderComponent') as ColliderComponent;
    }
    if (isNull(collider)) {
      collider = handle.createComponent('Component.ColliderComponent') as ColliderComponent;
    }
    if (!isNull(collider)) {
      const shape = Shape.createSphereShape();
      shape.radius = Math.max(1.2, this.moveHandleRadiusCm);
      const colliderLike = collider as unknown as { shape?: unknown; intangible?: boolean; enabled?: boolean };
      colliderLike.shape = shape;
      colliderLike.intangible = false;
      colliderLike.enabled = true;
    }

    let interactable = this.findExistingInteractable(handle);
    if (isNull(interactable)) {
      interactable = handle.createComponent(Interactable.getTypeName()) as InteractableLike;
    }
    interactable.targetingMode = 7;
    interactable.ignoreInteractionPlane = true;
    interactable.keepHoverOnTrigger = true;
    interactable.enableInstantDrag = true;

    let manipulation = this.findExistingManipulation(handle);
    if (isNull(manipulation)) {
      manipulation = handle.createComponent(
        InteractableManipulation.getTypeName()
      ) as unknown as InteractableManipulationLike;
    }
    manipulation.manipulateRootSceneObject = root;
    manipulation.enableTranslation = true;
    manipulation.enableRotation = true;
    manipulation.enableScale = false;
    manipulation.useFilter = false;
    this.bindManipulationRoot(manipulation, root);

    this.moveHandleInteractable = interactable;
    this.moveHandleManipulation = manipulation;
    this.ensureMoveHandleFollowLoop();
  }

  private ensureMoveHandleFollowLoop(): void {
    if (isNull(this.moveHandleFollowEvent)) {
      this.moveHandleFollowEvent = this.createEvent('UpdateEvent');
      this.moveHandleFollowEvent.bind(() => {
        const handle = this.moveHandleObject;
        if (isNull(handle)) {
          return;
        }
        this.applyMoveHandlePose(handle as SceneObject, this.getSceneObject());
      });
    }
    this.moveHandleFollowEvent.enabled = true;
  }

  private applyMoveHandlePose(handle: SceneObject, root: SceneObject): void {
    const rootTransform = root.getTransform();
    const rootPos = rootTransform.getWorldPosition();
    const right = rootTransform.right;
    const up = rootTransform.up;
    const fwd = rootTransform.forward;
    const local = this.moveHandleLocalPosition;
    const worldPos = rootPos
      .add(right.uniformScale(local.x))
      .add(up.uniformScale(local.y))
      .add(fwd.uniformScale(local.z));
    handle.getTransform().setWorldPosition(worldPos);
    handle.getTransform().setWorldRotation(quat.quatIdentity());
    const handleScale = Math.max(2.2, this.moveHandleRadiusCm);
    handle.getTransform().setWorldScale(new vec3(handleScale, handleScale, handleScale));
    handle.layer = root.layer;
  }

  private onPaintDragStart(event?: InteractorEventLike): void {
    if (!this.paintModeActive) {
      return;
    }
    if (this.paintNeedsReleaseAfterPick) {
      return;
    }
    if (getTime() < this.paintArmReadyAt) {
      return;
    }
    const interactor = event?.interactor || null;
    if (this.paintStrokeActive && this.activePaintInteractor === interactor) {
      return;
    }
    this.activePaintInteractor = interactor;
    this.paintStrokeActive = true;
    this.lastPaintPoint = null;
    this.paintFromInteractor(this.activePaintInteractor, true);
  }

  private onPaintDragUpdate(event?: InteractorEventLike): void {
    if (!this.paintModeActive) {
      return;
    }
    if (!isNull(event) && !isNull(event.interactor)) {
      this.activePaintInteractor = event.interactor;
    }
    this.paintFromInteractor(this.activePaintInteractor, false);
  }

  private onPaintDragEnd(): void {
    if (!this.paintModeActive) {
      return;
    }
    if (this.paintNeedsReleaseAfterPick) {
      // First release after selecting a color unlocks the next pinch-to-paint.
      this.paintNeedsReleaseAfterPick = false;
    }
    this.paintStrokeActive = false;
    this.lastPaintPoint = null;
  }

  private ensureGrabSounds(): void {
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
  }

  private ensureGrabAudioPlayer(): AudioComponent | null {
    const anchor = this.getSceneObject();
    let player = anchor.getComponent('Component.AudioComponent') as AudioComponent;
    if (isNull(player)) {
      player = anchor.createComponent('Component.AudioComponent') as AudioComponent;
    }

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
        print('[PaletteGrab] audio extras unavailable in preview: ' + e);
      }
    }

    return player;
  }

  private resolveSoundTrack(
    assigned: AudioTrackAsset | null | undefined,
    assetPath: string
  ): AudioTrackAsset | null {
    if (!isNull(assigned) && assigned) {
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

    print(`[PaletteGrab] missing sound asset ${assetPath}`);
    return null;
  }

  private playGrabSound(
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
      print(`[PaletteGrab] sfx ${label}`);
    }
  }

  private refreshGrabCollider(): void {
    this.ensureAnchorGrabCollider(this.getSceneObject());
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
      shape?: { size?: vec3 };
    };

    colliderLike.enabled = true;
    colliderLike.intangible = false;
    colliderLike.forceCompound = false;
    colliderLike.fitVisual = false;
    colliderLike.debugDrawEnabled = false;

    const shape = Shape.createBoxShape();
    shape.size = this.colliderSize;
    colliderLike.shape = shape;

    return collider;
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
}

import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import { InteractableManipulation } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation';

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

  private grabInteractable: InteractableLike | null = null;
  private grabManipulation: InteractableManipulationLike | null = null;
  private moveInteractionWired = false;
  private moveBindAttempts = 0;
  private moveActive = false;
  private grabAudioPlayer: AudioComponent | null = null;
  private resolvedGrabTrack: AudioTrackAsset | null = null;
  private resolvedReleaseTrack: AudioTrackAsset | null = null;
  private paintModeActive = false;
  private selectedPaintMaterial: Material | null = null;
  private selectedPaintMesh: RenderMesh | null = null;
  private activePaintInteractor: InteractorLike | null = null;
  private lastPaintPoint: vec3 | null = null;
  private paintUpdateEvent: UpdateEvent | null = null;
  private cancelButton: SceneObject | null = null;
  private strokeRoot: SceneObject | null = null;
  private paletteMoveEnabled = true;

  private static readonly ANCHOR_SOURCE_NAME = 'palette';
  private static readonly COLORS_NODE_NAME = 'Colors';
  private static readonly CANCEL_BUTTON_NAME = 'PalettePaintCancel';
  private static readonly CANCEL_BUTTON_TEXT_NAME = 'CancelText';
  private static readonly STROKE_DOT_NAME = 'PalettePaintDot';

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
    this.createColorBlobTouchProxies();
    this.ensureCancelPaintButton();
    this.setPaintMode(false);
  }

  private createColorBlobTouchProxies(): void {
    const colorsNode = this.findNamedChild(this.getSceneObject(), PaletteGrab.COLORS_NODE_NAME);
    if (isNull(colorsNode)) {
      print('[PaletteGrab] Colors node not found for paint blobs');
      return;
    }

    const visuals = colorsNode.getComponents('Component.RenderMeshVisual') as RenderMeshVisual[];
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
      const radius = Math.max(
        this.colorBlobProxyRadiusCm,
        Math.max(extent.x, Math.max(extent.y, extent.z)) * 0.45
      );

      const proxy = global.scene.createSceneObject(`PaletteColorBlob_${i}`);
      proxy.setParent(this.getSceneObject());
      proxy.getTransform().setWorldPosition(center);
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
        this.enterPaintMode(visual.mainMaterial, visual.mesh, event?.interactor || null);
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

  private ensureCancelPaintButton(): void {
    if (!isNull(this.cancelButton)) {
      return;
    }

    const root = this.getSceneObject();
    const button = global.scene.createSceneObject(PaletteGrab.CANCEL_BUTTON_NAME);
    button.setParent(root);
    button.getTransform().setLocalPosition(vec3.zero());
    button.getTransform().setLocalRotation(quat.quatIdentity());
    const visualRadius = Math.max(2.2, this.cancelButtonRadiusCm * 1.15);
    button.getTransform().setLocalScale(new vec3(visualRadius, visualRadius, visualRadius));
    button.layer = root.layer;

    const collider = button.createComponent('Component.ColliderComponent') as ColliderComponent;
    const shape = Shape.createSphereShape();
    shape.radius = Math.max(0.25, this.cancelButtonRadiusCm);
    (collider as unknown as { shape?: unknown; intangible?: boolean }).shape = shape;
    (collider as unknown as { intangible?: boolean }).intangible = false;

    const buttonVisual = button.createComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    const visualTemplate = this.findFirstRenderable(root);
    if (!isNull(visualTemplate) && !isNull(visualTemplate.mesh) && !isNull(visualTemplate.mainMaterial)) {
      buttonVisual.mesh = visualTemplate.mesh as RenderMesh;
      buttonVisual.mainMaterial = visualTemplate.mainMaterial as Material;
    }
    buttonVisual.renderOrder = 12;

    const interactable = button.createComponent(Interactable.getTypeName()) as InteractableLike;
    interactable.targetingMode = 7;
    interactable.ignoreInteractionPlane = true;
    interactable.keepHoverOnTrigger = true;
    interactable.enableInstantDrag = false;

    const cancel = (): void => {
      this.setPaintMode(false);
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

    const textNode = global.scene.createSceneObject(PaletteGrab.CANCEL_BUTTON_TEXT_NAME);
    textNode.setParent(button);
    textNode.layer = root.layer;
    textNode.getTransform().setLocalPosition(new vec3(0, 0, 0));
    textNode.getTransform().setLocalRotation(quat.quatIdentity());
    textNode.getTransform().setLocalScale(vec3.one());

    const text = textNode.createComponent('Component.Text3D') as Text3D;
    text.text = 'X';
    text.size = 38;
    text.horizontalAlignment = HorizontalAlignment.Center;
    text.verticalAlignment = VerticalAlignment.Center;
    text.renderOrder = 13;

    this.cancelButton = button;
  }

  private enterPaintMode(
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
    this.ensurePaintUpdateLoop(true);
    this.paintFromInteractor(interactor, true);
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
        this.paintFromInteractor(this.activePaintInteractor, false);
      });
    }
    this.paintUpdateEvent.enabled = true;
  }

  private paintFromInteractor(interactor: InteractorLike | null, force: boolean): void {
    if (!this.paintModeActive || isNull(interactor)) {
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

    const start = interactor.startPoint || null;
    const direction = interactor.direction || null;
    if (!isNull(start) && !isNull(direction)) {
      const rayStart = start as vec3;
      const rayDir = direction as vec3;

      // Primary path: place paint on a world-space plane through the palette.
      const denom = rayDir.dot(paletteUp);
      if (Math.abs(denom) > 0.0001) {
        const t = palettePos.sub(rayStart).dot(paletteUp) / denom;
        if (t > 0) {
          const planeHit = rayStart.add(rayDir.uniformScale(t));
          if (planeHit.distance(palettePos) <= clampDistance) {
            return planeHit;
          }
        }
      }

      // Fallback path: fixed-distance point along the interactor ray.
      const distance = !isNull(interactor.distanceToTarget)
        ? Math.max(0, interactor.distanceToTarget as number)
        : Math.max(0, this.paintRayDistanceCm);
      const rayPoint = rayStart.add(rayDir.uniformScale(distance));
      const fromPalette = rayPoint.sub(palettePos);
      const mag = Math.sqrt(
        fromPalette.x * fromPalette.x +
        fromPalette.y * fromPalette.y +
        fromPalette.z * fromPalette.z
      );
      if (mag > clampDistance && mag > 0.0001) {
        return palettePos.add(fromPalette.uniformScale(clampDistance / mag));
      }
      return rayPoint;
    }

    // Only accept direct hit positions that are near the palette plane.
    if (!isNull(interactor.targetHitPosition)) {
      const hit = interactor.targetHitPosition as vec3;
      if (hit.distance(palettePos) <= clampDistance) {
        const planeOffset = Math.abs(hit.sub(palettePos).dot(paletteUp));
        if (planeOffset <= 6) {
          return hit;
        }
      }
    }

    if (!isNull(start)) {
      const point = start as vec3;
      if (point.distance(palettePos) <= clampDistance) {
        return point;
      }
    }
    return null;
  }

  private spawnPaintDot(worldPos: vec3): void {
    if (isNull(this.selectedPaintMaterial) || isNull(this.selectedPaintMesh)) {
      return;
    }

    const dot = global.scene.createSceneObject(PaletteGrab.STROKE_DOT_NAME);
    dot.setParent(this.ensureStrokeRoot());
    dot.getTransform().setWorldPosition(worldPos);
    dot.getTransform().setWorldRotation(quat.quatIdentity());
    const scale = Math.max(0.1, this.paintDotScaleCm);
    dot.getTransform().setWorldScale(new vec3(scale, scale, scale));
    dot.layer = this.getSceneObject().layer;

    const visual = dot.createComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    visual.mesh = this.selectedPaintMesh as RenderMesh;
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
    if (this.moveInteractionWired) {
      return;
    }

    this.ensureAnchorGrabComponents();
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
      this.onPaletteGrabStart(event);
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
        this.onPaletteGrabStart();
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

    (manipulation as ScriptComponent).enabled = true;
    (interactable as ScriptComponent).enabled = true;

    this.moveInteractionWired = true;
    print('[PaletteGrab] grab interaction wired');
  }

  private onPaletteGrabStart(_event?: InteractorEventLike): void {
    if (this.paintModeActive) {
      return;
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

  private onPaintDragStart(event?: InteractorEventLike): void {
    if (!this.paintModeActive) {
      return;
    }
    this.activePaintInteractor = event?.interactor || null;
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
    this.activePaintInteractor = null;
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

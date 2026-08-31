import {
  isAnyGardenSourceSpawnPullActive,
  setGardenSourceMoveHandleActive,
  setGardenSourceMoveHandleHovered,
} from './GardenSourceSpawnGuard';
import { playInteractionSound } from './InteractionSoundRegistry';

type AnchorGardenSourceHandler = {
  persistGardenSourceTransform?: (sourceName: string) => void;
  setActiveManipulatedRoot?: (root: SceneObject | null) => void;
  moveHandleMaterial?: Material;
  moveHandleGlowMaterial?: Material;
};

type GardenSourceSpawnerLike = ScriptComponent & {
  setSpawnSuppressed?: (suppressed: boolean) => void;
  abortActiveSpawnPull?: () => void;
};

type InteractableLike = ScriptComponent & {
  onDragStart?: { add: (cb: () => void) => void };
  onDragEnd?: { add: (cb: () => void) => void };
  onTriggerStart?: { add: (cb: () => void) => void };
  onTriggerEnd?: { add: (cb: () => void) => void };
  onTriggerEndOutside?: { add: (cb: () => void) => void };
  onInteractorTriggerStart?: { add: (cb: () => void) => void };
  onInteractorTriggerEnd?: { add: (cb: () => void) => void };
  onInteractorTriggerEndOutside?: { add: (cb: () => void) => void };
  onHoverEnter?: { add: (cb: () => void) => void };
  onHoverExit?: { add: (cb: () => void) => void };
  onInteractorHoverEnter?: { add: (cb: () => void) => void };
  onInteractorHoverExit?: { add: (cb: () => void) => void };
  targetingMode?: number;
  ignoreInteractionPlane?: boolean;
};

type InteractableManipulationLike = ScriptComponent & {
  manipulateRootSceneObject?: SceneObject;
  enableTranslation?: boolean;
  enableRotation?: boolean;
  enableScale?: boolean;
  setManipulateRoot?: (root: Transform) => void;
};

@component
export class GardenSourceMoveHandle extends BaseScriptComponent {
  @input
  @allowUndefined
  sourceRoot!: SceneObject;

  @input
  sourceName: string = '';

  @input
  @allowUndefined
  anchorController!: ScriptComponent;

  @input
  @allowUndefined
  handleMaterial!: Material;

  @input
  @allowUndefined
  glowMaterial!: Material;

  private moveInteractionWired = false;
  private clonedOuterGlowMaterial: Material | null = null;
  private bindAttempts = 0;
  private moveActive = false;
  private handleHovered = false;
  private containerHovered = false;
  private containerHoverWired = false;
  private handleInteractable: InteractableLike | null = null;
  private handleManipulation: InteractableManipulationLike | null = null;
  private hideVisibilityEvent: DelayedCallbackEvent | null = null;
  private glowBright = false;
  private sourceSpawner: GardenSourceSpawnerLike | null = null;

  private static readonly GLOW_IDLE_COLOR = new vec4(1, 0.86, 0.1, 0.36);
  private static readonly GLOW_IDLE_EMISSIVE = new vec3(0.72, 0.58, 0.1);
  private static readonly GLOW_HOVER_COLOR = new vec4(1, 0.86, 0.1, 0.58);
  private static readonly GLOW_HOVER_EMISSIVE = new vec3(1.6, 1.25, 0.2);
  private static readonly GLOW_LAYER_SCALE = 1.55;
  private static readonly GLOW_RENDER_ORDER = 8;
  private static readonly TRASH_HANDLE_COLLIDER_RADIUS = 12;
  private static readonly HANDLE_HIDE_DELAY_SEC = 0.35;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => {
      this.applyHandleVisual(this.getSceneObject());
    });

    this.scheduleHandleVisualRetry(0.25);
    this.scheduleHandleVisualRetry(0.5);
    this.scheduleHandleVisualRetry(1.0);
    this.scheduleHandleVisualRetry(1.5);
  }

  private scheduleHandleVisualRetry(delaySec: number): void {
    const retryVisual = this.createEvent('DelayedCallbackEvent');
    retryVisual.bind(() => {
      this.applyHandleVisual(this.getSceneObject());
    });
    retryVisual.reset(delaySec);
  }

  public wireMoveInteraction(): void {
    if (this.moveInteractionWired) {
      this.refreshManipulationRootBinding();
      return;
    }

    this.bindAttempts = 0;
    this.clonedOuterGlowMaterial = null;
    this.tryWireMoveInteraction();
  }

  /** Keep the yellow grab glow visible (used during Friend onboarding reveal). */
  public presentHandle(): void {
    this.cancelScheduledHide();
    this.containerHovered = true;
    this.applyHandleVisual(this.getSceneObject());
    this.refreshHandleVisibility(true);
  }

  public clearPresentedHandle(): void {
    this.containerHovered = false;
    this.handleHovered = false;
    this.scheduleHandleHide();
  }

  public refreshManipulationRootBinding(): void {
    const sourceRoot = this.getSourceRoot();
    if (isNull(sourceRoot)) {
      return;
    }

    const handle = this.getSceneObject();
    const manipulation = this.handleManipulation || this.findManipulationScript(handle);
    if (isNull(manipulation)) {
      return;
    }

    this.handleManipulation = manipulation;
    if (manipulation.manipulateRootSceneObject !== sourceRoot) {
      this.bindManipulationRoot(manipulation, sourceRoot);
    }
  }

  public refreshHandlePresentation(): void {
    const handle = this.getSceneObject();
    if (isNull(handle)) {
      return;
    }

    handle.enabled = true;
    this.applyHandleVisual(handle);
    this.refreshHandleVisibility(true);
  }

  private getSourceRoot(): SceneObject | null {
    if (!isNull(this.sourceRoot)) {
      return this.sourceRoot;
    }

    const parent = this.getSceneObject().getParent();
    return isNull(parent) ? null : parent;
  }

  private getSourceLabel(): string {
    if (this.sourceName) {
      return this.sourceName;
    }

    const root = this.getSourceRoot();
    return isNull(root) ? 'Garden Source' : String(root.name || 'Garden Source');
  }

  private tryWireMoveInteraction(): void {
    if (this.moveInteractionWired) {
      return;
    }

    const handle = this.getSceneObject();
    const sourceRoot = this.getSourceRoot();
    const interactable = this.findInteractableScript(handle);
    const manipulation = this.findManipulationScript(handle);
    if (isNull(sourceRoot) || isNull(interactable) || isNull(manipulation)) {
      this.bindAttempts++;
      if (this.bindAttempts >= 30) {
        print(
          `${this.getSourceLabel()} move handle could not bind. Add Interactable and InteractableManipulation to MoveHandle.`
        );
        return;
      }

      const retryEvent = this.createEvent('DelayedCallbackEvent');
      retryEvent.bind(() => this.tryWireMoveInteraction());
      retryEvent.reset(0.1);
      return;
    }

    // Source handles must be fully configured in the scene/prefab before SIK
    // registers them. Only a copied TrashBin handle needs its manipulation
    // root repaired dynamically because its source root is not known until
    // the copy is attached.
    if (manipulation.manipulateRootSceneObject !== sourceRoot) {
      this.bindManipulationRoot(manipulation, sourceRoot);
    }
    const manipulationLike = manipulation as ScriptComponent & {
      onManipulationStart?: { add: (cb: (arg: unknown) => void) => void };
      onManipulationEnd?: { add: (cb: (arg: unknown) => void) => void };
    };
    this.handleInteractable = interactable;
    this.handleManipulation = manipulation;
    // Collider before enabling Interactable — trash needs independent (non-compound) collider.
    this.configureHandleCollider(handle);

    if (manipulationLike.onManipulationStart) {
      manipulationLike.onManipulationStart.add(() => {
        this.onHandleGrabStart(sourceRoot);
      });
    }
    if (manipulationLike.onManipulationEnd) {
      manipulationLike.onManipulationEnd.add(() => {
        this.onHandleGrabRelease();
      });
    }

    const onHandleInteractionStart = (): void => {
      setGardenSourceMoveHandleHovered(sourceRoot, true);
      this.setSpawnBlocked(sourceRoot, true);
      this.abortMistakenSpawnPull();
    };
    const onGrabStart = (): void => {
      this.onHandleGrabStart(sourceRoot);
    };
    const onRelease = (): void => {
      this.onHandleGrabRelease();
    };
    const onHandleInteractionEnd = (): void => {
      if (this.moveActive) {
        return;
      }

      if (!this.containerHovered && !this.handleHovered) {
        setGardenSourceMoveHandleHovered(sourceRoot, false);
        this.setSpawnBlocked(sourceRoot, false);
      }
      this.refreshHandleVisibility();
    };

    if (interactable.onDragStart) {
      interactable.onDragStart.add(onHandleInteractionStart);
      interactable.onDragStart.add(onGrabStart);
    }
    if (interactable.onTriggerStart) {
      interactable.onTriggerStart.add(onHandleInteractionStart);
      interactable.onTriggerStart.add(onGrabStart);
    }
    if (interactable.onInteractorTriggerStart) {
      interactable.onInteractorTriggerStart.add(onHandleInteractionStart);
      interactable.onInteractorTriggerStart.add(onGrabStart);
    }

    if (interactable.onDragEnd) {
      interactable.onDragEnd.add(onHandleInteractionEnd);
      interactable.onDragEnd.add(onRelease);
    }
    if (interactable.onTriggerEnd) {
      interactable.onTriggerEnd.add(onHandleInteractionEnd);
      interactable.onTriggerEnd.add(onRelease);
    }
    if (interactable.onTriggerEndOutside) {
      interactable.onTriggerEndOutside.add(onHandleInteractionEnd);
      interactable.onTriggerEndOutside.add(onRelease);
    }
    if (interactable.onInteractorTriggerEnd) {
      interactable.onInteractorTriggerEnd.add(onHandleInteractionEnd);
      interactable.onInteractorTriggerEnd.add(onRelease);
    }
    if (interactable.onInteractorTriggerEndOutside) {
      interactable.onInteractorTriggerEndOutside.add(onHandleInteractionEnd);
      interactable.onInteractorTriggerEndOutside.add(onRelease);
    }

    this.sourceSpawner = this.findSourceSpawner(sourceRoot);
    this.wireContainerHover(sourceRoot);
    this.wireHandleHover(interactable, sourceRoot);
    this.applyHandleVisual(handle);
    this.setSpawnBlocked(sourceRoot, false);
    this.refreshHandleVisibility(true);

    this.applyHandleVisual(handle);
    this.moveInteractionWired = true;
    print(`${this.getSourceLabel()} move handle wired`);
  }

  private applyHandleVisual(handle: SceneObject): void {
    const visuals = handle.getComponents('Component.RenderMeshVisual');
    if (visuals.length === 0) {
      print(`${this.getSourceLabel()} move handle missing RenderMeshVisual`);
      return;
    }

    const primaryVisual = visuals[0] as RenderMeshVisual;
    if (!isNull(primaryVisual)) {
      this.ensureGlowLayers(handle, primaryVisual.mesh);
    }

    this.syncPrimaryHandleVisualVisibility(visuals);
    this.refreshHandleVisibility(true);
  }

  private syncPrimaryHandleVisualVisibility(visuals: Component[]): void {
    const hasGlow = !isNull(this.getGlowLayer());
    const handleMaterial = this.resolveHandleMaterial();

    for (let i = 0; i < visuals.length; i++) {
      const visual = visuals[i] as RenderMeshVisual;
      if (isNull(visual)) {
        continue;
      }

      if (hasGlow) {
        // Outer glow ring only — hide the solid inner disc mesh.
        visual.enabled = false;
        continue;
      }

      visual.enabled = !this.moveActive;
      if (!isNull(handleMaterial)) {
        visual.mainMaterial = handleMaterial;
      }
    }

    if (!hasGlow && isNull(handleMaterial) && isNull(this.resolveGlowMaterial())) {
      print(
        `${this.getSourceLabel()} move handle has no glow or material — check AnchorController wiring`
      );
    }
  }

  private getAnchorHandler(): AnchorGardenSourceHandler | null {
    if (isNull(this.anchorController)) {
      return null;
    }
    return this.anchorController as unknown as AnchorGardenSourceHandler;
  }

  private resolveGlowMaterial(): Material | null {
    if (!isNull(this.glowMaterial)) {
      return this.glowMaterial;
    }

    const anchor = this.getAnchorHandler();
    if (!isNull(anchor) && !isNull(anchor.moveHandleGlowMaterial)) {
      return anchor.moveHandleGlowMaterial;
    }

    if (!isNull(this.handleMaterial)) {
      return this.handleMaterial;
    }

    if (!isNull(anchor) && !isNull(anchor.moveHandleMaterial)) {
      return anchor.moveHandleMaterial;
    }

    const handle = this.getSceneObject();
    const visuals = handle.getComponents('Component.RenderMeshVisual');
    if (visuals.length > 0) {
      const primaryVisual = visuals[0] as RenderMeshVisual;
      if (!isNull(primaryVisual) && !isNull(primaryVisual.mainMaterial)) {
        return primaryVisual.mainMaterial;
      }
    }

    return null;
  }

  private resolveHandleMaterial(): Material | null {
    if (!isNull(this.handleMaterial)) {
      return this.handleMaterial;
    }

    const anchor = this.getAnchorHandler();
    if (!isNull(anchor) && !isNull(anchor.moveHandleMaterial)) {
      return anchor.moveHandleMaterial;
    }

    const handle = this.getSceneObject();
    const visuals = handle.getComponents('Component.RenderMeshVisual');
    if (visuals.length > 0) {
      const primaryVisual = visuals[0] as RenderMeshVisual;
      if (!isNull(primaryVisual) && !isNull(primaryVisual.mainMaterial)) {
        return primaryVisual.mainMaterial;
      }
    }

    return null;
  }

  private ensureGlowLayers(handle: SceneObject, mesh: RenderMesh): void {
    const glowSource = this.resolveGlowMaterial();
    if (isNull(mesh) || isNull(glowSource)) {
      return;
    }

    const legacyCore = this.findNamedChild(handle, 'GlowCore');
    if (!isNull(legacyCore)) {
      legacyCore.enabled = false;
    }

    this.ensureGlowLayer(
      handle,
      mesh,
      glowSource,
      'GlowHalo',
      GardenSourceMoveHandle.GLOW_LAYER_SCALE,
      GardenSourceMoveHandle.GLOW_RENDER_ORDER,
      GardenSourceMoveHandle.GLOW_IDLE_COLOR,
      GardenSourceMoveHandle.GLOW_IDLE_EMISSIVE
    );
  }

  private ensureGlowLayer(
    handle: SceneObject,
    mesh: RenderMesh,
    glowSource: Material | null,
    layerName: string,
    scale: number,
    renderOrder: number,
    baseColor: vec4,
    emissive: vec3
  ): void {
    let layer = this.findNamedChild(handle, layerName);
    if (isNull(layer)) {
      layer = global.scene.createSceneObject(layerName);
      layer.setParent(handle);
      layer.getTransform().setLocalPosition(new vec3(0, 0, 0));
      const layerVisual = layer.createComponent('Component.RenderMeshVisual') as RenderMeshVisual;
      layerVisual.mesh = mesh;
    }

    layer.getTransform().setLocalScale(new vec3(scale, scale, scale));
    layer.enabled = false;

    const layerVisual = layer.getComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    if (isNull(layerVisual)) {
      return;
    }

    layerVisual.mesh = mesh;
    layerVisual.renderOrder = renderOrder;

    const layerMaterial = this.ensureHandleOwnedGlowMaterial(layerVisual, glowSource);
    if (isNull(layerMaterial)) {
      return;
    }

    layerVisual.mainMaterial = layerMaterial;
    layerVisual.enabled = !this.moveActive;
    this.applyGlowMaterialColors(layerMaterial, baseColor, emissive);
  }

  private ensureHandleOwnedGlowMaterial(
    layerVisual: RenderMeshVisual,
    glowSource: Material | null
  ): Material | null {
    if (!isNull(this.clonedOuterGlowMaterial)) {
      return this.clonedOuterGlowMaterial;
    }

    const source = !isNull(glowSource) ? glowSource : layerVisual.mainMaterial;
    if (isNull(source)) {
      return null;
    }

    const layerMaterial = source.clone();
    if (!isNull(glowSource)) {
      layerMaterial.mainPass.baseTex = glowSource.mainPass.baseTex;
    }

    this.clonedOuterGlowMaterial = layerMaterial;
    return layerMaterial;
  }

  private applyGlowMaterialColors(
    layerMaterial: Material,
    baseColor: vec4,
    emissive: vec3
  ): void {
    layerMaterial.mainPass.baseColor = baseColor;
    const passAny = layerMaterial.mainPass as { Port_Emissive_N006?: vec3 };
    if (passAny.Port_Emissive_N006 !== undefined) {
      passAny.Port_Emissive_N006 = emissive;
    }
  }

  private isHoverTarget(): boolean {
    return this.handleHovered;
  }

  private shouldShowHandle(): boolean {
    return this.containerHovered || this.handleHovered;
  }

  private getGlowLayer(): SceneObject | null {
    return this.findNamedChild(this.getSceneObject(), 'GlowHalo');
  }

  private getGlowMaterial(): Material | null {
    const halo = this.getGlowLayer();
    if (isNull(halo)) {
      return this.clonedOuterGlowMaterial;
    }

    const layerVisual = halo.getComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    if (isNull(layerVisual) || isNull(layerVisual.mainMaterial)) {
      return this.clonedOuterGlowMaterial;
    }

    return layerVisual.mainMaterial;
  }

  private refreshHandleVisibility(_immediateHide: boolean = false): void {
    if (this.moveActive) {
      this.cancelScheduledHide();
      this.setHandleGlowHidden(true);
      return;
    }

    if (!this.shouldShowHandle()) {
      this.glowBright = false;
      this.setHandleGlowHidden(true);
      this.setHandleInteractionEnabled(false);
      return;
    }

    this.setHandleInteractionEnabled(true);

    const bright = this.isHoverTarget();
    if (bright && !this.glowBright) {
      playInteractionSound((sounds) => sounds.playHover());
    }

    this.glowBright = bright;
    this.setHandleGlowHidden(false);
    this.applyHandleGlowBrightness(bright);
  }

  private setHandleInteractionEnabled(enabled: boolean): void {
    const handle = this.getSceneObject();
    const interactable = this.handleInteractable || this.findInteractableScript(handle);
    const manipulation = this.handleManipulation || this.findManipulationScript(handle);
    const allowInteraction = enabled;

    if (allowInteraction) {
      this.refreshManipulationRootBinding();
    }

    if (!isNull(interactable)) {
      (interactable as ScriptComponent).enabled = allowInteraction;
    }
    if (!isNull(manipulation)) {
      (manipulation as ScriptComponent).enabled = allowInteraction;
    }
  }

  private isTrashHandle(): boolean {
    return this.getSourceLabel() === 'TrashBin' || this.sourceName === 'TrashBin';
  }

  private getHandleColliderRadius(): number {
    return this.isTrashHandle()
      ? GardenSourceMoveHandle.TRASH_HANDLE_COLLIDER_RADIUS
      : 8;
  }

  private configureHandleCollider(handle: SceneObject): void {
    const minRadius = this.getHandleColliderRadius();
    // Trash parent used ForceCompound — keep trash handle independent so SIK targets it.
    const useCompound = !this.isTrashHandle();
    const colliders = handle.getComponents('Component.ColliderComponent');
    for (let i = 0; i < colliders.length; i++) {
      const collider = colliders[i] as ColliderComponent;
      if (isNull(collider)) {
        continue;
      }

      const colliderLike = collider as unknown as {
        enabled?: boolean;
        intangible?: boolean;
        forceCompound?: boolean;
        shape?: { radius?: number; FitVisual?: boolean };
      };
      colliderLike.enabled = true;
      colliderLike.intangible = false;
      colliderLike.forceCompound = useCompound;

      if (!colliderLike.shape) {
        colliderLike.shape = { radius: minRadius, FitVisual: false };
      } else {
        colliderLike.shape.FitVisual = false;
        colliderLike.shape.radius = Math.max(colliderLike.shape.radius || 0, minRadius);
      }
    }
  }

  private cancelScheduledHide(): void {
    if (!isNull(this.hideVisibilityEvent)) {
      this.hideVisibilityEvent.enabled = false;
      this.hideVisibilityEvent = null;
    }
  }

  private scheduleHandleHide(): void {
    if (this.moveActive || this.containerHovered || this.handleHovered) {
      return;
    }

    this.cancelScheduledHide();
    this.hideVisibilityEvent = this.createEvent('DelayedCallbackEvent');
    this.hideVisibilityEvent.bind(() => {
      this.hideVisibilityEvent = null;
      if (!this.containerHovered && !this.handleHovered && !this.moveActive) {
        this.refreshHandleVisibility(true);
      }
    });
    this.hideVisibilityEvent.reset(GardenSourceMoveHandle.HANDLE_HIDE_DELAY_SEC);
  }

  private setHandleGlowHidden(hidden: boolean): void {
    const halo = this.getGlowLayer();
    if (isNull(halo)) {
      return;
    }

    halo.enabled = !hidden;
    const layerVisual = halo.getComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    if (!isNull(layerVisual)) {
      layerVisual.enabled = !hidden;
    }
  }

  private applyHandleGlowBrightness(bright: boolean): void {
    const layerMaterial = this.getGlowMaterial();
    if (isNull(layerMaterial)) {
      return;
    }

    if (bright) {
      this.applyGlowMaterialColors(
        layerMaterial,
        GardenSourceMoveHandle.GLOW_HOVER_COLOR,
        GardenSourceMoveHandle.GLOW_HOVER_EMISSIVE
      );
      return;
    }

    this.applyGlowMaterialColors(
      layerMaterial,
      GardenSourceMoveHandle.GLOW_IDLE_COLOR,
      GardenSourceMoveHandle.GLOW_IDLE_EMISSIVE
    );
  }

  private findNamedChild(root: SceneObject, name: string): SceneObject | null {
    const count = root.getChildrenCount();
    for (let i = 0; i < count; i++) {
      const child = root.getChild(i);
      if (!isNull(child) && child.name === name) {
        return child;
      }
    }
    return null;
  }

  private wireContainerHover(sourceRoot: SceneObject): void {
    if (this.containerHoverWired) {
      return;
    }

    const interactable = this.findContainerInteractable(sourceRoot);
    if (isNull(interactable)) {
      return;
    }

    const onHoverEnter = (): void => {
      this.cancelScheduledHide();
      this.containerHovered = true;
      this.refreshHandleVisibility();
    };
    const onHoverExit = (): void => {
      this.containerHovered = false;
      if (!this.handleHovered && !this.moveActive) {
        this.scheduleHandleHide();
        return;
      }
      this.refreshHandleVisibility();
    };

    if (interactable.onHoverEnter) {
      interactable.onHoverEnter.add(onHoverEnter);
    }
    if (interactable.onHoverExit) {
      interactable.onHoverExit.add(onHoverExit);
    }
    if (interactable.onInteractorHoverEnter) {
      interactable.onInteractorHoverEnter.add(onHoverEnter);
    }
    if (interactable.onInteractorHoverExit) {
      interactable.onInteractorHoverExit.add(onHoverExit);
    }

    this.containerHoverWired = true;
  }

  private findContainerInteractable(sourceRoot: SceneObject): InteractableLike | null {
    const scripts = sourceRoot.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as InteractableLike;
      if (
        isNull(candidate) ||
        candidate.targetingMode === undefined ||
        (candidate.onHoverEnter === undefined &&
          candidate.onInteractorHoverEnter === undefined &&
          candidate.onHoverExit === undefined &&
          candidate.onInteractorHoverExit === undefined)
      ) {
        continue;
      }

      const manipulationLike = candidate as InteractableManipulationLike;
      if (manipulationLike.manipulateRootSceneObject !== undefined) {
        continue;
      }

      if (!(candidate as ScriptComponent).enabled) {
        continue;
      }

      return candidate;
    }

    return null;
  }

  private wireHandleHover(interactable: InteractableLike, sourceRoot: SceneObject): void {
    const onHoverEnter = (): void => {
      this.cancelScheduledHide();
      this.handleHovered = true;
      setGardenSourceMoveHandleHovered(sourceRoot, true);
      this.setSpawnBlocked(sourceRoot, true);
      this.refreshHandleVisibility();
    };
    const onHoverExit = (): void => {
      this.handleHovered = false;
      if (!this.containerHovered && !this.moveActive) {
        setGardenSourceMoveHandleHovered(sourceRoot, false);
        this.setSpawnBlocked(sourceRoot, false);
        this.scheduleHandleHide();
        return;
      }
      this.refreshHandleVisibility();
    };

    if (interactable.onHoverEnter) {
      interactable.onHoverEnter.add(onHoverEnter);
    }
    if (interactable.onHoverExit) {
      interactable.onHoverExit.add(onHoverExit);
    }
    if (interactable.onInteractorHoverEnter) {
      interactable.onInteractorHoverEnter.add(onHoverEnter);
    }
    if (interactable.onInteractorHoverExit) {
      interactable.onInteractorHoverExit.add(onHoverExit);
    }
  }

  private onHandleGrabStart(sourceRoot: SceneObject): void {
    if (this.moveActive || isAnyGardenSourceSpawnPullActive()) {
      return;
    }

    this.moveActive = true;
    setGardenSourceMoveHandleActive(sourceRoot, true);
    this.setSpawnBlocked(sourceRoot, true);
    this.refreshManipulationRootBinding();
    this.refreshHandleVisibility();
    this.abortMistakenSpawnPull();
    const handler = this.getAnchorHandler();
    if (!isNull(handler) && typeof handler.setActiveManipulatedRoot === 'function') {
      handler.setActiveManipulatedRoot(sourceRoot);
    }
    playInteractionSound((sounds) => sounds.playGrabObject());
  }

  private onHandleGrabRelease(): void {
    if (!this.moveActive) {
      return;
    }

    this.moveActive = false;
    const sourceRoot = this.getSourceRoot();
    if (!isNull(sourceRoot)) {
      setGardenSourceMoveHandleActive(sourceRoot, false);
      this.setSpawnBlocked(sourceRoot, false);
    }
    this.refreshHandleVisibility();
    playInteractionSound((sounds) => sounds.playReleaseObject());
    const handler = this.getAnchorHandler();
    if (!isNull(handler) && typeof handler.persistGardenSourceTransform === 'function') {
      handler.persistGardenSourceTransform(this.getSourceLabel());
    }
    if (!isNull(handler) && typeof handler.setActiveManipulatedRoot === 'function') {
      handler.setActiveManipulatedRoot(null);
    }
  }

  private setSpawnBlocked(sourceRoot: SceneObject, blocked: boolean): void {
    const spawner = this.sourceSpawner || this.findSourceSpawner(sourceRoot);
    if (!isNull(spawner) && typeof spawner.setSpawnSuppressed === 'function') {
      spawner.setSpawnSuppressed(blocked);
    }
  }

  private abortMistakenSpawnPull(): void {
    const spawner = this.sourceSpawner;
    if (!isNull(spawner) && typeof spawner.abortActiveSpawnPull === 'function') {
      spawner.abortActiveSpawnPull();
    }
  }

  private findSourceSpawner(sourceRoot: SceneObject): GardenSourceSpawnerLike | null {
    const scripts = sourceRoot.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as GardenSourceSpawnerLike;
      if (
        !isNull(candidate) &&
        typeof candidate.setSpawnSuppressed === 'function' &&
        typeof candidate.abortActiveSpawnPull === 'function'
      ) {
        return candidate;
      }
    }

    return null;
  }

  private findInteractableScript(root: SceneObject): InteractableLike | null {
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

  private bindManipulationRoot(
    manipulation: InteractableManipulationLike,
    sourceRoot: SceneObject
  ): void {
    manipulation.manipulateRootSceneObject = sourceRoot;

    const manipRecord = manipulation as unknown as Record<string, unknown>;
    const setRoot = manipRecord['setManipulateRoot'];
    if (typeof setRoot === 'function') {
      (setRoot as (this: unknown, root: Transform) => void).call(
        manipulation,
        sourceRoot.getTransform()
      );
      return;
    }

    const component = manipulation as ScriptComponent;
    const wasEnabled = component.enabled;
    component.enabled = false;
    component.enabled = wasEnabled;
  }

  private findManipulationScript(root: SceneObject): InteractableManipulationLike | null {
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as InteractableManipulationLike;
      if (!isNull(candidate) && candidate.manipulateRootSceneObject !== undefined) {
        return candidate;
      }
    }
    return null;
  }
}

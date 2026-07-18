import {
  isMoveHandleSceneObject,
  setGardenSourceMoveHandleActive,
  setGardenSourceMoveHandleHovered,
} from './GardenSourceSpawnGuard';
import { playInteractionSound } from './InteractionSoundRegistry';

type AnchorGardenSourceHandler = {
  persistGardenSourceTransform?: (sourceName: string) => void;
  setActiveManipulatedRoot?: (root: SceneObject | null) => void;
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
  private parentHovered = false;
  private handleHovered = false;
  private handleInteractable: InteractableLike | null = null;
  private handleManipulation: InteractableManipulationLike | null = null;
  private hideVisibilityEvent: DelayedCallbackEvent | null = null;
  private glowVisible = false;
  private spawnInteractable: InteractableLike | null = null;
  private spawnInteractableWasEnabled = true;
  private spawnInteractableDisabledByHandle = false;
  private sourceSpawner: GardenSourceSpawnerLike | null = null;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => {
      this.applyHandleVisual(this.getSceneObject());
      this.tryWireMoveInteraction();
    });

    const retryVisual = this.createEvent('DelayedCallbackEvent');
    retryVisual.bind(() => {
      this.applyHandleVisual(this.getSceneObject());
    });
    retryVisual.reset(0.25);
  }

  public wireMoveInteraction(): void {
    this.moveInteractionWired = false;
    this.bindAttempts = 0;
    this.tryWireMoveInteraction();
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

    manipulation.manipulateRootSceneObject = sourceRoot;
    manipulation.enableTranslation = true;
    manipulation.enableRotation = false;
    manipulation.enableScale = false;
    this.handleInteractable = interactable;
    this.handleManipulation = manipulation;
    (manipulation as ScriptComponent).enabled = true;
    (interactable as ScriptComponent).enabled = true;

    const onHandleInteractionStart = (): void => {
      setGardenSourceMoveHandleHovered(sourceRoot, true);
      this.setSpawnBlocked(sourceRoot, true);
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

      setGardenSourceMoveHandleHovered(sourceRoot, false);
      this.setSpawnBlocked(sourceRoot, false);
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

    interactable.targetingMode = 7;
    interactable.ignoreInteractionPlane = true;

    this.spawnInteractable = this.findSourceSpawnInteractable(sourceRoot);
    this.sourceSpawner = this.findSourceSpawner(sourceRoot);
    this.wireHandleHover(interactable, sourceRoot);
    this.wireParentHover(sourceRoot);
    this.applyHandleVisual(handle);
    this.setSpawnBlocked(sourceRoot, false);
    this.refreshHandleVisibility(true);

    this.moveInteractionWired = true;
    print(`${this.getSourceLabel()} move handle wired`);
  }

  private applyHandleVisual(handle: SceneObject): void {
    const visuals = handle.getComponents('Component.RenderMeshVisual');
    if (visuals.length === 0) {
      print(`${this.getSourceLabel()} move handle missing RenderMeshVisual`);
      return;
    }

    for (let i = 0; i < visuals.length; i++) {
      const visual = visuals[i] as RenderMeshVisual;
      if (isNull(visual)) {
        continue;
      }

      // Keep mesh/collider on MoveHandle; hide the solid inner disc — outer ring only.
      visual.enabled = false;
    }

    const primaryVisual = visuals[0] as RenderMeshVisual;
    if (!isNull(primaryVisual)) {
      this.ensureGlowLayers(handle, primaryVisual.mesh);
    }

    this.refreshHandleVisibility(true);
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
      1.55,
      8,
      this.clonedOuterGlowMaterial,
      new vec4(1, 0.86, 0.1, 0.38),
      new vec3(1.4, 1.1, 0.18),
      (material) => {
        this.clonedOuterGlowMaterial = material;
      }
    );
  }

  private resolveGlowMaterial(): Material | null {
    if (!isNull(this.glowMaterial)) {
      return this.glowMaterial;
    }

    return null;
  }

  private ensureGlowLayer(
    handle: SceneObject,
    mesh: RenderMesh,
    glowSource: Material,
    layerName: string,
    scale: number,
    renderOrder: number,
    cachedMaterial: Material | null,
    baseColor: vec4,
    emissive: vec3,
    cacheMaterial: (material: Material) => void
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
    layer.enabled = this.shouldShowHandleGlow();

    const layerVisual = layer.getComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    if (isNull(layerVisual)) {
      return;
    }

    layerVisual.mesh = mesh;
    layerVisual.renderOrder = renderOrder;

    let layerMaterial = cachedMaterial;
    if (isNull(layerMaterial)) {
      layerMaterial = glowSource.clone();
      layerMaterial.mainPass.baseTex = glowSource.mainPass.baseTex;
      cacheMaterial(layerMaterial);
    }

    layerMaterial.mainPass.baseColor = baseColor;
    const passAny = layerMaterial.mainPass as { Port_Emissive_N006?: vec3 };
    if (passAny.Port_Emissive_N006 !== undefined) {
      passAny.Port_Emissive_N006 = emissive;
    }

    layerVisual.mainMaterial = layerMaterial;
    layerVisual.enabled = this.shouldShowHandleGlow();
  }

  private wireParentHover(sourceRoot: SceneObject): void {
    const parentInteractable = this.findSourceSpawnInteractable(sourceRoot);
    if (isNull(parentInteractable)) {
      return;
    }

    const onParentHoverEnter = (): void => {
      this.parentHovered = true;
      this.refreshHandleVisibility();
    };
    const onParentHoverExit = (): void => {
      this.parentHovered = false;
      this.refreshHandleVisibility();
    };

    if (parentInteractable.onHoverEnter) {
      parentInteractable.onHoverEnter.add(onParentHoverEnter);
    }
    if (parentInteractable.onHoverExit) {
      parentInteractable.onHoverExit.add(onParentHoverExit);
    }
    if (parentInteractable.onInteractorHoverEnter) {
      parentInteractable.onInteractorHoverEnter.add(onParentHoverEnter);
    }
    if (parentInteractable.onInteractorHoverExit) {
      parentInteractable.onInteractorHoverExit.add(onParentHoverExit);
    }
  }

  private shouldShowHandleGlow(): boolean {
    return (this.parentHovered || this.handleHovered) && !this.moveActive;
  }

  private refreshHandleVisibility(immediateHide: boolean = false): void {
    if (this.moveActive) {
      this.cancelScheduledHide();
      this.setHandleGlowVisible(false);
      this.setHandleInteractionEnabled(true);
      return;
    }

    if (this.shouldShowHandleGlow()) {
      this.cancelScheduledHide();
      if (!this.glowVisible) {
        playInteractionSound((sounds) => sounds.playHover());
      }
      this.setHandleGlowVisible(true);
      this.setHandleInteractionEnabled(true);
      return;
    }

    if (immediateHide) {
      this.cancelScheduledHide();
      this.setHandleGlowVisible(false);
      this.setHandleInteractionEnabled(false);
      return;
    }

    this.scheduleHide();
  }

  private scheduleHide(): void {
    this.cancelScheduledHide();
    const event = this.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
    this.hideVisibilityEvent = event;
    event.bind(() => {
      this.hideVisibilityEvent = null;
      if (this.shouldShowHandleGlow() || this.moveActive) {
        return;
      }

      this.setHandleGlowVisible(false);
      this.setHandleInteractionEnabled(false);
    });
    event.reset(0.12);
  }

  private cancelScheduledHide(): void {
    if (!isNull(this.hideVisibilityEvent)) {
      this.hideVisibilityEvent.enabled = false;
      this.hideVisibilityEvent = null;
    }
  }

  private setHandleGlowVisible(visible: boolean): void {
    const halo = this.findNamedChild(this.getSceneObject(), 'GlowHalo');
    if (isNull(halo)) {
      return;
    }

    halo.enabled = visible;
    const layerVisual = halo.getComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    if (!isNull(layerVisual)) {
      layerVisual.enabled = visible;
    }

    this.glowVisible = visible;
  }

  private setHandleInteractionEnabled(enabled: boolean): void {
    if (this.moveActive) {
      enabled = true;
    }

    if (!isNull(this.handleInteractable)) {
      (this.handleInteractable as ScriptComponent).enabled = enabled;
    }
    if (!isNull(this.handleManipulation)) {
      (this.handleManipulation as ScriptComponent).enabled = enabled;
    }
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

  private wireHandleHover(interactable: InteractableLike, sourceRoot: SceneObject): void {
    const onHoverEnter = (): void => {
      this.handleHovered = true;
      setGardenSourceMoveHandleHovered(sourceRoot, true);
      this.setSpawnBlocked(sourceRoot, true);
      this.refreshHandleVisibility();
    };
    const onHoverExit = (): void => {
      this.handleHovered = false;
      setGardenSourceMoveHandleHovered(sourceRoot, false);
      if (!this.moveActive) {
        this.setSpawnBlocked(sourceRoot, false);
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
    if (this.moveActive) {
      return;
    }

    this.moveActive = true;
    setGardenSourceMoveHandleActive(sourceRoot, true);
    this.setSpawnBlocked(sourceRoot, true);
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
  }

  private setSpawnBlocked(sourceRoot: SceneObject, blocked: boolean): void {
    const spawner = this.sourceSpawner || this.findSourceSpawner(sourceRoot);
    if (!isNull(spawner) && typeof spawner.setSpawnSuppressed === 'function') {
      spawner.setSpawnSuppressed(blocked);
    }

    const spawnInteractable =
      this.spawnInteractable || this.findSourceSpawnInteractable(sourceRoot);
    if (isNull(spawnInteractable)) {
      return;
    }

    if (blocked) {
      if ((spawnInteractable as ScriptComponent).enabled) {
        this.spawnInteractableWasEnabled = true;
        this.spawnInteractableDisabledByHandle = true;
        (spawnInteractable as ScriptComponent).enabled = false;
      }
      return;
    }

    if (this.spawnInteractableDisabledByHandle) {
      (spawnInteractable as ScriptComponent).enabled = this.spawnInteractableWasEnabled;
      this.spawnInteractableDisabledByHandle = false;
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

  private findSourceSpawnInteractable(sourceRoot: SceneObject): InteractableLike | null {
    return this.findSpawnInteractableOnObject(sourceRoot);
  }

  private findSpawnInteractableOnObject(root: SceneObject): InteractableLike | null {
    if (isMoveHandleSceneObject(root)) {
      return null;
    }

    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as InteractableLike;
      if (
        isNull(candidate) ||
        candidate.targetingMode === undefined ||
        candidate.targetingMode === 7 ||
        (candidate.onTriggerStart === undefined &&
          candidate.onInteractorTriggerStart === undefined &&
          candidate.onDragStart === undefined)
      ) {
        continue;
      }

      return candidate;
    }

    const count = root.getChildrenCount();
    for (let i = 0; i < count; i++) {
      const child = root.getChild(i);
      if (isMoveHandleSceneObject(child)) {
        continue;
      }

      const nested = this.findSpawnInteractableOnObject(child);
      if (!isNull(nested)) {
        return nested;
      }
    }

    return null;
  }

  private getAnchorHandler(): AnchorGardenSourceHandler | null {
    if (isNull(this.anchorController)) {
      return null;
    }
    return this.anchorController as unknown as AnchorGardenSourceHandler;
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

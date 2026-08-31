import { playInteractionSound } from './InteractionSoundRegistry';
import {
  shouldBlockGardenSourceSpawn,
  setGardenSourceSpawnPullActive,
} from './GardenSourceSpawnGuard';
import { scheduleDeferredDestroy } from './FlowGardenDestroyHooks';
import { PlantLifecycle } from './PlantLifecycle';
import { PlantSpawnConfig } from './PlantSpawnConfig';
import { registerPreDestroyHook } from './FlowGardenDestroyHooks';

type PublicEventLike<T> = {
  add(callback: (event: T) => void): void;
};

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
  onInteractorTriggerStart?: PublicEventLike<InteractorEventLike>;
  onTriggerStart?: PublicEventLike<InteractorEventLike>;
  onTriggerUpdate?: PublicEventLike<InteractorEventLike>;
  onDragStart?: PublicEventLike<InteractorEventLike>;
  onDragUpdate?: PublicEventLike<InteractorEventLike>;
  onDragEnd?: PublicEventLike<InteractorEventLike>;
  onInteractorTriggerEnd?: PublicEventLike<InteractorEventLike>;
  onInteractorTriggerEndOutside?: PublicEventLike<InteractorEventLike>;
  onTriggerEnd?: PublicEventLike<InteractorEventLike>;
  onTriggerEndOutside?: PublicEventLike<InteractorEventLike>;
  onTriggerCanceled?: PublicEventLike<InteractorEventLike>;
  targetingMode?: number;
  ignoreInteractionPlane?: boolean;
};

type AnchorSeedSpawner = {
  createSeedAtWorldPosition(worldPos: vec3): SceneObject | null;
  getValidatedSpawnWorldPosition?: (
    preferredWorldPos?: vec3 | null,
    index?: number
  ) => vec3;
  saveObjectPosition?: () => void;
  setActiveManipulatedRoot?: (root: SceneObject | null) => void;
  notifyTrashSpawnGrace?: (root: SceneObject, graceSeconds?: number) => void;
  syncTrackedWrapperToContent?: (content: SceneObject) => void;
  placeTrackedContentAtWorld?: (content: SceneObject, worldPos: vec3, worldRot?: quat) => void;
  destroyTrackedObject?: (candidate: SceneObject) => boolean;
};

type PullState = {
  seedObject: SceneObject;
  interactor: InteractorLike | null;
  rayDistance: number;
};

@component
export class MainSeedSource extends BaseScriptComponent {
  @input
  @allowUndefined
  seedPrefab!: ObjectPrefab;

  @input
  plantSpawnConfigs: PlantSpawnConfig[] = [];

  @input
  @allowUndefined
  anchorController!: ScriptComponent;

  @input
  @allowUndefined
  sourceInteractable!: ScriptComponent;

  @input
  @allowUndefined
  spawnParent!: SceneObject;

  @input('float')
  spawnForwardOffset: number = 0;

  @input('float')
  fallbackRayDistance: number = 35;

  @input
  followInteractorWhileHeld: boolean = true;

  @input
  allowMultipleActiveSeeds: boolean = false;

  @input
  debugLogging: boolean = false;

  private activePull: PullState | null = null;
  private updateEvent: UpdateEvent | null = null;
  private bindAttempts = 0;
  private isBound = false;
  private nextConfigIndex = 0;
  private spawnSuppressed = false;

  onAwake(): void {
    registerPreDestroyHook((root) => this.abandonActivePullIfMatches(root));
    this.createEvent('OnStartEvent').bind(() => this.tryBindInteractable());
  }

  public setSpawnSuppressed(suppressed: boolean): void {
    this.spawnSuppressed = suppressed;
  }

  public abortActiveSpawnPull(): void {
    if (isNull(this.activePull) || isNull(this.activePull.seedObject)) {
      return;
    }

    const seedObject = this.activePull.seedObject;
    setGardenSourceSpawnPullActive(this.getSceneObject(), false);
    this.activePull = null;
    if (!isNull(this.updateEvent)) {
      (this.updateEvent as UpdateEvent).enabled = false;
    }

    const anchorSpawner = this.getAnchorSeedSpawner();
    if (
      !isNull(anchorSpawner) &&
      typeof anchorSpawner.destroyTrackedObject === 'function' &&
      anchorSpawner.destroyTrackedObject(seedObject)
    ) {
      this.debugLog('aborted mistaken spawn pull for move handle.');
      return;
    }

    scheduleDeferredDestroy(this, seedObject, () => {
      this.debugLog('aborted mistaken spawn pull for move handle.');
    });
  }

  public spawnSeedAtSource(): SceneObject | null {
    return this.spawnSeed(this.getSceneObject().getTransform().getWorldPosition(), null);
  }

  public spawnSeedAtWorldPosition(worldPosition: vec3): SceneObject | null {
    return this.spawnSeed(worldPosition, null);
  }

  private bindInteractable(interactable: InteractableLike): void {
    if (this.isBound) {
      return;
    }

    const triggerStart = interactable.onInteractorTriggerStart || interactable.onTriggerStart;
    const triggerUpdate = interactable.onTriggerUpdate || interactable.onDragUpdate;
    if (!triggerStart && !interactable.onDragStart) {
      this.debugLog('sourceInteractable found, but trigger/drag events are not initialized yet.');
      return;
    }

    if (triggerStart) {
      triggerStart.add((event) => this.onTriggerStart(event, 'trigger start'));
    }
    if (interactable.onDragStart) {
      interactable.onDragStart.add((event) => this.onTriggerStart(event, 'drag start'));
    }
    if (triggerUpdate) {
      triggerUpdate.add((event) => this.onTriggerUpdate(event));
    }

    if (interactable.onInteractorTriggerEnd) {
      interactable.onInteractorTriggerEnd.add(() => this.releaseActivePull());
    }
    if (interactable.onInteractorTriggerEndOutside) {
      interactable.onInteractorTriggerEndOutside.add(() => this.releaseActivePull());
    }
    if (interactable.onTriggerEnd) {
      interactable.onTriggerEnd.add(() => this.releaseActivePull());
    }
    if (interactable.onTriggerEndOutside) {
      interactable.onTriggerEndOutside.add(() => this.releaseActivePull());
    }
    if (interactable.onDragEnd) {
      interactable.onDragEnd.add(() => this.releaseActivePull());
    }
    if (interactable.onTriggerCanceled) {
      interactable.onTriggerCanceled.add(() => this.releaseActivePull());
    }

    this.isBound = true;
    this.debugLog('bound to source Interactable.');
  }

  private onTriggerStart(event: InteractorEventLike, reason: string): void {
    const sourceRoot = this.getSceneObject();
    const interactor = event && event.interactor ? event.interactor : null;
    if (shouldBlockGardenSourceSpawn(sourceRoot, interactor, this.spawnSuppressed)) {
      this.debugLog(`ignored ${reason}: move handle interaction.`);
      return;
    }

    if (!this.allowMultipleActiveSeeds && !isNull(this.activePull)) {
      this.debugLog(`ignored ${reason}: seed already active.`);
      return;
    }

    const rayDistance = this.getRayDistance(interactor);
    const spawnPosition = this.getInteractorPosition(interactor, rayDistance);
    this.beginSpawnPull(spawnPosition, interactor, rayDistance, reason);
  }

  private beginSpawnPull(
    spawnPosition: vec3,
    interactor: InteractorLike | null,
    rayDistance: number,
    reason: string
  ): void {
    const sourceRoot = this.getSceneObject();
    if (shouldBlockGardenSourceSpawn(sourceRoot, interactor, this.spawnSuppressed)) {
      this.debugLog(`ignored ${reason}: move handle interaction.`);
      return;
    }

    if (!this.allowMultipleActiveSeeds && !isNull(this.activePull)) {
      this.debugLog(`ignored ${reason}: seed already active.`);
      return;
    }

    this.debugLog(`spawning seed from ${reason}.`);
    const seedObject = this.spawnSeed(spawnPosition, interactor);
    if (isNull(seedObject)) {
      return;
    }

    this.activePull = {
      seedObject: seedObject as SceneObject,
      interactor: interactor || null,
      rayDistance: rayDistance,
    };
    setGardenSourceSpawnPullActive(this.getSceneObject(), true);
    const anchorSpawner = this.getAnchorSeedSpawner();
    if (!isNull(anchorSpawner)) {
      const spawner = anchorSpawner as AnchorSeedSpawner;
      if (typeof spawner.setActiveManipulatedRoot === 'function') {
        spawner.setActiveManipulatedRoot(seedObject as SceneObject);
      }
      this.notifyTrashSpawnGrace(seedObject as SceneObject, 5);
    }
    playInteractionSound((sounds) => sounds.playGrabObject());
    this.ensureUpdateLoop();
    this.updatePulledSeedPosition();
  }

  private onTriggerUpdate(event: InteractorEventLike): void {
    if (isNull(this.activePull) || isNull((this.activePull as PullState).seedObject)) {
      return;
    }

    const pull = this.activePull as PullState;
    if (!isNull(event) && !isNull(event.interactor)) {
      pull.interactor = event.interactor || null;
    }

    this.updatePulledSeedPosition();
  }

  private updatePulledSeedPosition(): void {
    if (
      isNull(this.activePull) ||
      isNull((this.activePull as PullState).seedObject)
    ) {
      return;
    }

    const pull = this.activePull as PullState;
    if (!this.isSceneObjectAlive(pull.seedObject)) {
      this.abandonActivePull();
      return;
    }

    const plant = this.findPlantLifecycle(pull.seedObject);
    if (!isNull(plant) && typeof plant.getIsPlanted === 'function' && plant.getIsPlanted()) {
      // A pot just claimed this seed. Stop overriding its position while the user is still holding.
      this.releaseActivePull();
      return;
    }

    const interactor = pull.interactor;
    if (
      interactor &&
      typeof interactor.isActive === 'function' &&
      !interactor.isActive()
    ) {
      // Some SIK cancellation paths do not emit an end event. Do not leave a
      // seed permanently attached to a stale pinch in that case.
      this.releaseActivePull();
      return;
    }

    if (!this.followInteractorWhileHeld) {
      return;
    }

    const position = this.getInteractorPosition(interactor, pull.rayDistance);
    this.syncTrackedWrapper(pull.seedObject, position);
  }

  private syncTrackedWrapper(content: SceneObject, worldPos?: vec3): void {
    const anchorSpawner = this.getAnchorSeedSpawner();
    if (isNull(anchorSpawner)) {
      return;
    }

    const spawner = anchorSpawner as AnchorSeedSpawner;
    if (!isNull(worldPos) && typeof spawner.placeTrackedContentAtWorld === 'function') {
      spawner.placeTrackedContentAtWorld(content, worldPos);
      return;
    }

    if (typeof spawner.syncTrackedWrapperToContent === 'function') {
      spawner.syncTrackedWrapperToContent(content);
    }
  }

  private spawnSeed(worldPosition: vec3, interactor: InteractorLike | null): SceneObject | null {
    const anchorSpawner = this.getAnchorSeedSpawner();
    const resolvedWorldPosition =
      !isNull(anchorSpawner) &&
      typeof (anchorSpawner as AnchorSeedSpawner).getValidatedSpawnWorldPosition ===
        'function'
        ? (anchorSpawner as AnchorSeedSpawner).getValidatedSpawnWorldPosition(worldPosition)
        : worldPosition;
    const spawnPosition = this.applySpawnOffset(resolvedWorldPosition, interactor);
    let seedObject: SceneObject | null = null;

    if (!isNull(anchorSpawner)) {
      seedObject = (anchorSpawner as AnchorSeedSpawner).createSeedAtWorldPosition(spawnPosition);
    } else {
      seedObject = this.spawnSeedWithoutAnchor(spawnPosition);
      if (!isNull(seedObject)) {
        playInteractionSound((sounds) => sounds.playSpawnSeed());
      }
    }

    if (isNull(seedObject)) {
      return null;
    }

    const spawnedSeed = seedObject as SceneObject;
    spawnedSeed.name = 'Seed';
    this.debugLog(`spawned ${spawnedSeed.name}.`);
    return spawnedSeed;
  }

  private spawnSeedWithoutAnchor(worldPosition: vec3): SceneObject | null {
    if (isNull(this.seedPrefab)) {
      print('MainSeedSource needs seedPrefab assigned or an AnchorController with plantPrefab.');
      return null;
    }

    const seedObject = this.seedPrefab.instantiate(this.getSpawnParent());
    seedObject.getTransform().setWorldPosition(worldPosition);
    this.applyLocalPlantConfig(seedObject, this.getNextPlantConfig());
    return seedObject;
  }

  private getNextPlantConfig(): PlantSpawnConfig | null {
    const validConfigs: PlantSpawnConfig[] = [];
    for (let i = 0; i < this.plantSpawnConfigs.length; i++) {
      if (!isNull(this.plantSpawnConfigs[i])) {
        validConfigs.push(this.plantSpawnConfigs[i]);
      }
    }

    if (validConfigs.length === 0) {
      return null;
    }

    const config = validConfigs[this.nextConfigIndex % validConfigs.length];
    this.nextConfigIndex = (this.nextConfigIndex + 1) % validConfigs.length;
    return config;
  }

  private applyLocalPlantConfig(seedObject: SceneObject, config: PlantSpawnConfig | null): void {
    if (isNull(config) || isNull(seedObject)) {
      return;
    }

    const plant = this.findPlantLifecycle(seedObject);
    if (!isNull(plant)) {
      config.applyToPlant(plant);
    }
  }

  private findPlantLifecycle(seedObject: SceneObject): PlantLifecycle | null {
    const scripts = seedObject.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const plant = scripts[i] as unknown as PlantLifecycle;
      if (!isNull(plant) && typeof plant.water === 'function') {
        return plant;
      }
    }
    return null;
  }

  private applySpawnOffset(worldPosition: vec3, interactor: InteractorLike | null): vec3 {
    if (Math.abs(this.spawnForwardOffset) <= 0.0001) {
      return worldPosition;
    }

    let direction = this.getSceneObject().getTransform().forward;
    if (interactor && interactor.direction) {
      direction = interactor.direction;
    }
    return worldPosition.add(direction.uniformScale(this.spawnForwardOffset));
  }

  private getInteractorPosition(interactor: InteractorLike | null, rayDistance: number): vec3 {
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
    }

    return this.getSceneObject().getTransform().getWorldPosition();
  }

  private getRayDistance(interactor: InteractorLike | null): number {
    if (interactor && interactor.distanceToTarget !== null && interactor.distanceToTarget !== undefined) {
      return Math.max(0, interactor.distanceToTarget);
    }
    return Math.max(0, this.fallbackRayDistance);
  }

  private getSpawnParent(): SceneObject {
    if (!isNull(this.spawnParent)) {
      return this.spawnParent;
    }

    const parent = this.getSceneObject().getParent();
    return !isNull(parent) ? parent : this.getSceneObject();
  }

  private getAnchorSeedSpawner(): AnchorSeedSpawner | null {
    if (isNull(this.anchorController)) {
      return null;
    }

    const candidate = this.anchorController as unknown as AnchorSeedSpawner;
    if (typeof candidate.createSeedAtWorldPosition === 'function') {
      return candidate;
    }

    return null;
  }

  private getSourceInteractable(): InteractableLike | null {
    if (!isNull(this.sourceInteractable)) {
      return this.sourceInteractable as InteractableLike;
    }

    const fromRoot = this.findSpawnInteractableOnObject(this.getSceneObject());
    if (!isNull(fromRoot)) {
      return fromRoot;
    }

    const seedSack = this.findNamedChild(this.getSceneObject(), 'SeedSack');
    if (!isNull(seedSack)) {
      return this.findSpawnInteractableOnObject(seedSack);
    }

    return null;
  }

  private findSpawnInteractableOnObject(root: SceneObject): InteractableLike | null {
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as InteractableLike;
      if (
        !isNull(candidate) &&
        candidate.targetingMode !== undefined &&
        (candidate.onInteractorTriggerStart !== undefined ||
          candidate.onTriggerStart !== undefined ||
          candidate.onDragStart !== undefined)
      ) {
        return candidate;
      }
    }

    for (let i = 0; i < root.getChildrenCount(); i++) {
      const child = root.getChild(i);
      const nested = this.findSpawnInteractableOnObject(child);
      if (!isNull(nested)) {
        return nested;
      }
    }

    return null;
  }

  private findNamedChild(root: SceneObject, name: string): SceneObject | null {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }

      if (String(current.name || '') === name) {
        return current;
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
  }

  private tryBindInteractable(): void {
    if (this.isBound) {
      return;
    }

    const interactable = this.getSourceInteractable();
    if (isNull(interactable)) {
      this.debugLog('no source Interactable found yet.');
    } else {
      this.bindInteractable(interactable);
    }

    if (this.isBound) {
      return;
    }

    this.bindAttempts++;
    if (this.bindAttempts >= 30) {
      print(
        'MainSeedSource could not bind. Assign sourceInteractable to the SIK Interactable script on the seed source.'
      );
      return;
    }

    const retryEvent = this.createEvent('DelayedCallbackEvent');
    retryEvent.bind(() => this.tryBindInteractable());
    retryEvent.reset(0.1);
  }

  private ensureUpdateLoop(): void {
    if (!isNull(this.updateEvent)) {
      (this.updateEvent as UpdateEvent).enabled = true;
      return;
    }

    this.updateEvent = this.createEvent('UpdateEvent');
    this.updateEvent.bind(() => this.updatePulledSeedPosition());
    this.updateEvent.enabled = true;
  }

  private releaseActivePull(): void {
    if (isNull(this.activePull)) {
      return;
    }

    this.debugLog('released active seed pull.');
    const releasedSeed = this.activePull.seedObject;
    const plant = this.findPlantLifecycle(releasedSeed);
    const wasPlanted =
      !isNull(plant) &&
      typeof plant.getIsPlanted === 'function' &&
      plant.getIsPlanted();
    this.abandonActivePull();

    const anchorSpawner = this.getAnchorSeedSpawner();
    if (
      !isNull(anchorSpawner) &&
      typeof (anchorSpawner as AnchorSeedSpawner).setActiveManipulatedRoot === 'function'
    ) {
      // This source owns the pull; do not leave a discarded or planted seed
      // as AnchorController's "currently manipulated" object.
      (anchorSpawner as AnchorSeedSpawner).setActiveManipulatedRoot!(null);
    }

    if (wasPlanted) {
      this.debugLog(`kept ${releasedSeed.name}: seed was planted in a pot.`);
      return;
    }

    // Seeds are consumable source items, not desk objects. Give PlantPot's
    // overlap callbacks a brief chance to claim the seed, then remove it if
    // it was released anywhere else so loose seeds cannot accumulate.
    this.scheduleUnplantedSeedCleanup(releasedSeed);
  }

  private scheduleUnplantedSeedCleanup(seedObject: SceneObject): void {
    const cleanup = this.createEvent('DelayedCallbackEvent');
    cleanup.bind(() => {
      if (!this.isSceneObjectAlive(seedObject)) {
        return;
      }

      const plant = this.findPlantLifecycle(seedObject);
      if (
        !isNull(plant) &&
        typeof plant.getIsPlanted === 'function' &&
        plant.getIsPlanted()
      ) {
        this.debugLog(`kept ${seedObject.name}: seed was planted during release grace.`);
        return;
      }

      const anchorSpawner = this.getAnchorSeedSpawner();
      if (
        !isNull(anchorSpawner) &&
        typeof (anchorSpawner as AnchorSeedSpawner).destroyTrackedObject === 'function' &&
        (anchorSpawner as AnchorSeedSpawner).destroyTrackedObject!(seedObject)
      ) {
        this.debugLog(`discarded ${seedObject.name}: it was released outside a pot.`);
        return;
      }

      scheduleDeferredDestroy(this, seedObject, () => {
        this.debugLog(`discarded ${seedObject.name}: it was released outside a pot.`);
      });
    });
    cleanup.reset(0.35);
  }

  private notifyTrashSpawnGrace(root: SceneObject, graceSeconds: number): void {
    const anchorSpawner = this.getAnchorSeedSpawner();
    if (isNull(anchorSpawner)) {
      return;
    }

    const spawner = anchorSpawner as AnchorSeedSpawner;
    if (typeof spawner.notifyTrashSpawnGrace === 'function') {
      spawner.notifyTrashSpawnGrace(root, graceSeconds);
    }
  }

  private abandonActivePullIfMatches(root: SceneObject): void {
    if (isNull(this.activePull) || isNull(this.activePull.seedObject) || isNull(root)) {
      return;
    }

    const seed = this.activePull.seedObject;
    if (seed === root || this.isSameHierarchy(seed, root)) {
      this.abandonActivePull();
    }
  }

  private isSameHierarchy(a: SceneObject, b: SceneObject): boolean {
    return this.isDescendantOf(a, b) || this.isDescendantOf(b, a);
  }

  private isDescendantOf(candidate: SceneObject, ancestor: SceneObject): boolean {
    let current = candidate;
    while (!isNull(current)) {
      if (current === ancestor) {
        return true;
      }
      current = current.getParent();
    }
    return false;
  }

  private isSceneObjectAlive(sceneObject: SceneObject | null): boolean {
    if (isNull(sceneObject)) {
      return false;
    }

    try {
      sceneObject.getTransform();
      return true;
    } catch {
      return false;
    }
  }

  private abandonActivePull(): void {
    setGardenSourceSpawnPullActive(this.getSceneObject(), false);
    this.activePull = null;
    if (!isNull(this.updateEvent)) {
      (this.updateEvent as UpdateEvent).enabled = false;
    }
  }

  private debugLog(message: string): void {
    if (!this.debugLogging) {
      return;
    }

    print(`[MainSeedSource] ${this.getSceneObject().name}: ${message}`);
  }
}

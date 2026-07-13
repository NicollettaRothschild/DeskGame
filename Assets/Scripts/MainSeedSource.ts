import { playInteractionSound } from './InteractionSoundRegistry';
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
};

type AnchorSeedSpawner = {
  createSeedAtWorldPosition(worldPos: vec3): SceneObject | null;
  saveObjectPosition?: () => void;
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

  onAwake(): void {
    registerPreDestroyHook((root) => this.abandonActivePullIfMatches(root));
    this.createEvent('OnStartEvent').bind(() => this.tryBindInteractable());
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
    if (!this.allowMultipleActiveSeeds && !isNull(this.activePull)) {
      this.debugLog(`ignored ${reason}: seed already active.`);
      return;
    }

    const interactor = event && event.interactor ? event.interactor : null;
    const rayDistance = this.getRayDistance(interactor);
    const spawnPosition = this.getInteractorPosition(interactor, rayDistance);
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
    this.ensureUpdateLoop();
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
      !this.followInteractorWhileHeld ||
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
    const interactor = pull.interactor;
    if (!isNull(interactor) && interactor.isActive && !interactor.isActive()) {
      this.releaseActivePull();
      return;
    }

    const position = this.getInteractorPosition(interactor, pull.rayDistance);
    pull.seedObject.getTransform().setWorldPosition(position);
  }

  private spawnSeed(worldPosition: vec3, interactor: InteractorLike | null): SceneObject | null {
    const spawnPosition = this.applySpawnOffset(worldPosition, interactor);
    const anchorSpawner = this.getAnchorSeedSpawner();
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

  private getSourceInteractable(): InteractableLike {
    if (!isNull(this.sourceInteractable)) {
      return this.sourceInteractable as InteractableLike;
    }

    const scripts = this.getSceneObject().getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as InteractableLike;
      if (
        !isNull(candidate) &&
        (candidate.onInteractorTriggerStart !== undefined || candidate.onTriggerStart !== undefined) &&
        candidate.onTriggerUpdate !== undefined
      ) {
        return candidate;
      }
    }

    return null as unknown as InteractableLike;
  }

  private tryBindInteractable(): void {
    if (this.isBound) {
      return;
    }

    const interactable = this.getSourceInteractable();
    if (!isNull(interactable)) {
      this.bindInteractable(interactable);
    } else {
      this.debugLog('no source Interactable found yet.');
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
    if (!isNull(this.activePull)) {
      this.debugLog('released active seed pull.');
      const anchorSpawner = this.getAnchorSeedSpawner();
      if (!isNull(anchorSpawner) && typeof (anchorSpawner as AnchorSeedSpawner).saveObjectPosition === 'function') {
        (anchorSpawner as AnchorSeedSpawner).saveObjectPosition!();
      }
    }
    this.abandonActivePull();
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

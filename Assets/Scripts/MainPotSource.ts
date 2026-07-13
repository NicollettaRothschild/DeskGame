import { playInteractionSound } from './InteractionSoundRegistry';

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

type AnchorPotSpawner = {
  createPotAtWorldPosition(
    potPrefab: ObjectPrefab,
    potPrefabIndex: number,
    worldPos: vec3
  ): SceneObject | null;
  saveObjectPosition?: () => void;
  setActiveManipulatedRoot?: (root: SceneObject | null) => void;
};

type PullState = {
  potObject: SceneObject;
  interactor: InteractorLike | null;
  rayDistance: number;
};

@component
export class MainPotSource extends BaseScriptComponent {
  @input
  potPrefabs: ObjectPrefab[] = [];

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
  allowMultipleActivePots: boolean = false;

  @input
  debugLogging: boolean = false;

  private activePull: PullState | null = null;
  private updateEvent: UpdateEvent | null = null;
  private bindAttempts = 0;
  private isBound = false;
  private nextPotIndex = 0;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => this.tryBindInteractable());
  }

  public spawnPotAtSource(): SceneObject | null {
    return this.spawnPot(this.getSceneObject().getTransform().getWorldPosition(), null);
  }

  public spawnPotAtWorldPosition(worldPosition: vec3): SceneObject | null {
    return this.spawnPot(worldPosition, null);
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
    if (!this.allowMultipleActivePots && !isNull(this.activePull)) {
      this.debugLog(`ignored ${reason}: pot already active.`);
      return;
    }

    const interactor = event && event.interactor ? event.interactor : null;
    const rayDistance = this.getRayDistance(interactor);
    const spawnPosition = this.getInteractorPosition(interactor, rayDistance);
    this.debugLog(`spawning pot from ${reason}.`);
    const potObject = this.spawnPot(spawnPosition, interactor);
    if (isNull(potObject)) {
      return;
    }

    this.activePull = {
      potObject: potObject as SceneObject,
      interactor: interactor || null,
      rayDistance: rayDistance,
    };
    this.ensureUpdateLoop();
  }

  private onTriggerUpdate(event: InteractorEventLike): void {
    if (isNull(this.activePull) || isNull((this.activePull as PullState).potObject)) {
      return;
    }

    const pull = this.activePull as PullState;
    if (!isNull(event) && !isNull(event.interactor)) {
      pull.interactor = event.interactor || null;
    }

    this.updatePulledPotPosition();
  }

  private updatePulledPotPosition(): void {
    if (
      !this.followInteractorWhileHeld ||
      isNull(this.activePull) ||
      isNull((this.activePull as PullState).potObject)
    ) {
      return;
    }

    const pull = this.activePull as PullState;
    const interactor = pull.interactor;
    if (!isNull(interactor) && interactor.isActive && !interactor.isActive()) {
      this.releaseActivePull();
      return;
    }

    const position = this.getInteractorPosition(interactor, pull.rayDistance);
    pull.potObject.getTransform().setWorldPosition(position);
  }

  private spawnPot(worldPosition: vec3, interactor: InteractorLike | null): SceneObject | null {
    const prefabIndex = this.getNextPotPrefabIndex();
    if (prefabIndex < 0) {
      print('MainPotSource needs at least one pot prefab assigned.');
      return null;
    }

    const prefab = this.potPrefabs[prefabIndex];
    const spawnPosition = this.applySpawnOffset(worldPosition, interactor);
    const anchorSpawner = this.getAnchorPotSpawner();
    let potObject: SceneObject | null = null;
    if (!isNull(anchorSpawner)) {
      potObject = (anchorSpawner as AnchorPotSpawner).createPotAtWorldPosition(prefab, prefabIndex, spawnPosition);
    } else {
      potObject = prefab.instantiate(this.getSpawnParent());
      potObject.getTransform().setWorldPosition(spawnPosition);
    }

    if (isNull(potObject)) {
      return null;
    }

    const spawnedPot = potObject as SceneObject;
    spawnedPot.name = `Pot_${prefabIndex}`;
    playInteractionSound((sounds) => sounds.playSpawnPot());
    this.debugLog(`spawned ${spawnedPot.name}.`);
    return spawnedPot;
  }

  private getNextPotPrefabIndex(): number {
    const validCount = this.potPrefabs.length;
    if (validCount <= 0) {
      return -1;
    }

    for (let attempts = 0; attempts < validCount; attempts++) {
      const index = this.nextPotIndex % validCount;
      this.nextPotIndex = (this.nextPotIndex + 1) % validCount;
      if (!isNull(this.potPrefabs[index])) {
        return index;
      }
    }

    return -1;
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

  private getAnchorPotSpawner(): AnchorPotSpawner | null {
    if (isNull(this.anchorController)) {
      return null;
    }

    const candidate = this.anchorController as unknown as AnchorPotSpawner;
    if (typeof candidate.createPotAtWorldPosition === 'function') {
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
      print('MainPotSource could not bind. Assign sourceInteractable to the SIK Interactable script on the pot source.');
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
    this.updateEvent.bind(() => this.updatePulledPotPosition());
    this.updateEvent.enabled = true;
  }

  private releaseActivePull(): void {
    if (!isNull(this.activePull)) {
      this.debugLog('released active pot pull.');
      const anchorSpawner = this.getAnchorPotSpawner();
      if (!isNull(anchorSpawner)) {
        const spawner = anchorSpawner as AnchorPotSpawner;
        if (typeof spawner.setActiveManipulatedRoot === 'function') {
          spawner.setActiveManipulatedRoot(this.activePull.potObject);
        }
        if (typeof spawner.saveObjectPosition === 'function') {
          spawner.saveObjectPosition();
        }
      }
    }
    this.activePull = null;
    if (!isNull(this.updateEvent)) {
      (this.updateEvent as UpdateEvent).enabled = false;
    }
  }

  private debugLog(message: string): void {
    if (!this.debugLogging) {
      return;
    }

    print(`[MainPotSource] ${this.getSceneObject().name}: ${message}`);
  }
}

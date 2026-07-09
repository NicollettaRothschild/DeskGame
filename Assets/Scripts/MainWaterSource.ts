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

type PullState = {
  waterObject: SceneObject;
  interactor: InteractorLike | null;
  rayDistance: number;
};

@component
export class MainWaterSource extends BaseScriptComponent {
  @input
  wateringObjectPrefab!: ObjectPrefab;

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
  allowMultipleActiveWaterObjects: boolean = false;

  @input
  debugLogging: boolean = false;

  private activePull: PullState | null = null;
  private updateEvent: UpdateEvent | null = null;
  private bindAttempts = 0;
  private isBound = false;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => this.tryBindInteractable());
  }

  public spawnWaterAtSource(): SceneObject | null {
    return this.spawnWater(this.getSceneObject().getTransform().getWorldPosition(), null);
  }

  public spawnWaterAtWorldPosition(worldPosition: vec3): SceneObject | null {
    return this.spawnWater(worldPosition, null);
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
    if (!this.allowMultipleActiveWaterObjects && !isNull(this.activePull)) {
      this.debugLog(`ignored ${reason}: water already active.`);
      return;
    }

    const interactor = event && event.interactor ? event.interactor : null;
    const rayDistance = this.getRayDistance(interactor);
    const spawnPosition = this.getInteractorPosition(interactor, rayDistance);
    this.debugLog(`spawning water from ${reason}.`);
    const waterObject = this.spawnWater(spawnPosition, interactor);
    if (isNull(waterObject)) {
      return;
    }

    this.activePull = {
      waterObject: waterObject,
      interactor: interactor,
      rayDistance: rayDistance,
    };
    this.ensureUpdateLoop();
  }

  private onTriggerUpdate(event: InteractorEventLike): void {
    if (isNull(this.activePull) || isNull(this.activePull.waterObject)) {
      return;
    }

    if (!isNull(event) && !isNull(event.interactor)) {
      this.activePull.interactor = event.interactor;
    }

    this.updatePulledWaterPosition();
  }

  private updatePulledWaterPosition(): void {
    if (
      !this.followInteractorWhileHeld ||
      isNull(this.activePull) ||
      isNull(this.activePull.waterObject)
    ) {
      return;
    }

    const interactor = this.activePull.interactor;
    if (!isNull(interactor) && interactor.isActive && !interactor.isActive()) {
      this.releaseActivePull();
      return;
    }

    const position = this.getInteractorPosition(interactor, this.activePull.rayDistance);
    this.activePull.waterObject.getTransform().setWorldPosition(position);
  }

  private spawnWater(worldPosition: vec3, interactor: InteractorLike | null): SceneObject | null {
    if (isNull(this.wateringObjectPrefab)) {
      print('MainWaterSource needs wateringObjectPrefab assigned.');
      return null;
    }

    const parent = this.getSpawnParent();
    const waterObject = this.wateringObjectPrefab.instantiate(parent);
    waterObject.name = 'WateringObject';
    waterObject.getTransform().setWorldPosition(this.applySpawnOffset(worldPosition, interactor));
    this.debugLog(`spawned ${waterObject.name}.`);
    return waterObject;
  }

  private applySpawnOffset(worldPosition: vec3, interactor: InteractorLike | null): vec3 {
    if (Math.abs(this.spawnForwardOffset) <= 0.0001) {
      return worldPosition;
    }

    const direction = !isNull(interactor) && !isNull(interactor.direction)
      ? interactor.direction
      : this.getSceneObject().getTransform().forward;
    return worldPosition.add(direction.uniformScale(this.spawnForwardOffset));
  }

  private getInteractorPosition(interactor: InteractorLike | null, rayDistance: number): vec3 {
    if (!isNull(interactor)) {
      if (interactor.activeTargetingMode === 1 && !isNull(interactor.startPoint)) {
        return interactor.startPoint;
      }

      if (!isNull(interactor.startPoint) && !isNull(interactor.direction)) {
        return interactor.startPoint.add(interactor.direction.uniformScale(rayDistance));
      }

      if (!isNull(interactor.targetHitPosition)) {
        return interactor.targetHitPosition;
      }
    }

    return this.getSceneObject().getTransform().getWorldPosition();
  }

  private getRayDistance(interactor: InteractorLike | null): number {
    if (!isNull(interactor) && !isNull(interactor.distanceToTarget)) {
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
      print('MainWaterSource could not bind. Assign the sourceInteractable to the SIK Interactable script on the water source.');
      return;
    }

    const retryEvent = this.createEvent('DelayedCallbackEvent');
    retryEvent.bind(() => this.tryBindInteractable());
    retryEvent.reset(0.1);
  }

  private ensureUpdateLoop(): void {
    if (!isNull(this.updateEvent)) {
      this.updateEvent.enabled = true;
      return;
    }

    this.updateEvent = this.createEvent('UpdateEvent');
    this.updateEvent.bind(() => this.updatePulledWaterPosition());
    this.updateEvent.enabled = true;
  }

  private releaseActivePull(): void {
    if (!isNull(this.activePull)) {
      this.debugLog('released active water pull.');
    }
    this.activePull = null;
    if (!isNull(this.updateEvent)) {
      this.updateEvent.enabled = false;
    }
  }

  private debugLog(message: string): void {
    if (!this.debugLogging) {
      return;
    }

    print(`[MainWaterSource] ${this.getSceneObject().name}: ${message}`);
  }
}

import { playInteractionSound } from './InteractionSoundRegistry';
import {
  shouldBlockGardenSourceSpawn,
  setGardenSourceSpawnPullActive,
} from './GardenSourceSpawnGuard';
import { scheduleDeferredDestroy } from './FlowGardenDestroyHooks';
import { WateringObject } from './WateringObject';

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

type AnchorWaterSpawner = {
  saveObjectPosition?: () => void;
  setActiveManipulatedRoot?: (root: SceneObject | null) => void;
  notifyTrashSpawnGrace?: (root: SceneObject, graceSeconds?: number) => void;
  syncTrackedWrapperToContent?: (content: SceneObject) => void;
  placeTrackedContentAtWorld?: (content: SceneObject, worldPos: vec3, worldRot?: quat) => void;
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
  allowMultipleActiveWaterObjects: boolean = false;

  @input
  debugLogging: boolean = false;

  private activePull: PullState | null = null;
  private updateEvent: UpdateEvent | null = null;
  private bindAttempts = 0;
  private isBound = false;
  private spawnSuppressed = false;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => this.tryBindInteractable());
  }

  public setSpawnSuppressed(suppressed: boolean): void {
    this.spawnSuppressed = suppressed;
  }

  public abortActiveSpawnPull(): void {
    if (isNull(this.activePull) || isNull(this.activePull.waterObject)) {
      return;
    }

    const waterObject = this.activePull.waterObject;
    setGardenSourceSpawnPullActive(this.getSceneObject(), false);
    this.activePull = null;
    if (!isNull(this.updateEvent)) {
      (this.updateEvent as UpdateEvent).enabled = false;
    }

    scheduleDeferredDestroy(this, waterObject, () => {
      this.debugLog('aborted mistaken spawn pull for move handle.');
    });
  }

  public spawnWaterAtSource(): SceneObject | null {
    const waterObject = this.spawnWater(this.getSceneObject().getTransform().getWorldPosition(), null);
    if (!isNull(waterObject)) {
      this.beginUnusedLifetime(waterObject);
    }
    return waterObject;
  }

  public spawnWaterAtWorldPosition(worldPosition: vec3): SceneObject | null {
    const waterObject = this.spawnWater(worldPosition, null);
    if (!isNull(waterObject)) {
      this.beginUnusedLifetime(waterObject);
    }
    return waterObject;
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
    if (interactable.targetingMode !== undefined) {
      interactable.targetingMode = 7;
    }
    if (interactable.ignoreInteractionPlane !== undefined) {
      interactable.ignoreInteractionPlane = true;
    }
    this.debugLog('bound to source Interactable.');
  }

  private onTriggerStart(event: InteractorEventLike, reason: string): void {
    const sourceRoot = this.getSceneObject();
    const interactor = event && event.interactor ? event.interactor : null;
    if (shouldBlockGardenSourceSpawn(sourceRoot, interactor, this.spawnSuppressed)) {
      this.debugLog(`ignored ${reason}: move handle interaction.`);
      return;
    }

    if (!this.allowMultipleActiveWaterObjects && !isNull(this.activePull)) {
      this.debugLog(`ignored ${reason}: water already active.`);
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

    if (!this.allowMultipleActiveWaterObjects && !isNull(this.activePull)) {
      this.debugLog(`ignored ${reason}: water already active.`);
      return;
    }

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
    setGardenSourceSpawnPullActive(this.getSceneObject(), true);
    const anchorSpawner = this.getAnchorWaterSpawner();
    if (!isNull(anchorSpawner)) {
      const spawner = anchorSpawner as AnchorWaterSpawner;
      if (typeof spawner.setActiveManipulatedRoot === 'function') {
        spawner.setActiveManipulatedRoot(waterObject);
      }
      this.notifyTrashSpawnGrace(waterObject, 5);
    }
    playInteractionSound((sounds) => sounds.playGrabObject());
    this.ensureUpdateLoop();
    this.updatePulledWaterPosition();
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
    if (
      interactor &&
      typeof interactor.isActive === 'function' &&
      !interactor.isActive()
    ) {
      this.finalizeReleasedPull(this.activePull.waterObject);
      return;
    }

    const position = this.getInteractorPosition(interactor, this.activePull.rayDistance);
    this.syncTrackedWrapper(this.activePull.waterObject, position);
  }

  private syncTrackedWrapper(content: SceneObject, worldPos?: vec3): void {
    const anchorSpawner = this.getAnchorWaterSpawner();
    if (!isNull(anchorSpawner)) {
      const spawner = anchorSpawner as AnchorWaterSpawner;
      if (!isNull(worldPos) && typeof spawner.placeTrackedContentAtWorld === 'function') {
        spawner.placeTrackedContentAtWorld(content, worldPos);
        return;
      }

      if (typeof spawner.syncTrackedWrapperToContent === 'function') {
        spawner.syncTrackedWrapperToContent(content);
        return;
      }
    }

    if (!isNull(worldPos)) {
      content.getTransform().setWorldPosition(worldPos);
    }
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
    playInteractionSound((sounds) => sounds.playSpawnWater());
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

    return this.getSceneObject().getTransform().getWorldPosition();
  }

  private getRayDistance(interactor: InteractorLike | null): number {
    if (interactor && interactor.distanceToTarget !== null && interactor.distanceToTarget !== undefined) {
      return Math.max(0, interactor.distanceToTarget);
    }
    return Math.max(0, this.fallbackRayDistance);
  }

  private getAnchorWaterSpawner(): AnchorWaterSpawner | null {
    if (isNull(this.anchorController)) {
      return null;
    }

    const candidate = this.anchorController as unknown as AnchorWaterSpawner;
    if (typeof candidate.placeTrackedContentAtWorld === 'function') {
      return candidate;
    }

    return null;
  }

  private notifyTrashSpawnGrace(root: SceneObject, graceSeconds: number): void {
    const anchorSpawner = this.getAnchorWaterSpawner();
    if (isNull(anchorSpawner)) {
      return;
    }

    const spawner = anchorSpawner as AnchorWaterSpawner;
    if (typeof spawner.notifyTrashSpawnGrace === 'function') {
      spawner.notifyTrashSpawnGrace(root, graceSeconds);
    }
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

  private abandonActivePull(): void {
    setGardenSourceSpawnPullActive(this.getSceneObject(), false);
    this.activePull = null;
    if (!isNull(this.updateEvent)) {
      (this.updateEvent as UpdateEvent).enabled = false;
    }
  }

  private releaseActivePull(): void {
    if (isNull(this.activePull) || isNull(this.activePull.waterObject)) {
      return;
    }

    this.debugLog('released active water pull.');
    this.finalizeReleasedPull(this.activePull.waterObject);
  }

  private finalizeReleasedPull(releasedWater: SceneObject): void {
    this.abandonActivePull();

    const anchorSpawner = this.getAnchorWaterSpawner();
    if (!isNull(anchorSpawner)) {
      const spawner = anchorSpawner as AnchorWaterSpawner;
      const worldPos = releasedWater.getTransform().getWorldPosition();
      if (typeof spawner.placeTrackedContentAtWorld === 'function') {
        spawner.placeTrackedContentAtWorld(releasedWater, worldPos);
      } else if (typeof spawner.syncTrackedWrapperToContent === 'function') {
        spawner.syncTrackedWrapperToContent(releasedWater);
      }
      if (typeof spawner.setActiveManipulatedRoot === 'function') {
        spawner.setActiveManipulatedRoot(releasedWater);
      }
    }

    this.beginUnusedLifetime(releasedWater);
  }

  private beginUnusedLifetime(waterObject: SceneObject): void {
    const wateringObject = this.findWateringObject(waterObject);
    if (!isNull(wateringObject)) {
      wateringObject.beginUnusedLifetime();
    }
  }

  private findWateringObject(sceneObject: SceneObject): WateringObject | null {
    const scripts = sceneObject.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as WateringObject;
      if (!isNull(candidate) && typeof candidate.beginUnusedLifetime === 'function') {
        return candidate;
      }
    }
    return null;
  }

  private debugLog(message: string): void {
    if (!this.debugLogging) {
      return;
    }

    print(`[MainWaterSource] ${this.getSceneObject().name}: ${message}`);
  }
}

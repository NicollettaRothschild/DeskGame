import { playInteractionSound } from './InteractionSoundRegistry';
import {
  shouldBlockGardenSourceSpawn,
  setGardenSourceSpawnPullActive,
} from './GardenSourceSpawnGuard';
import {
  registerPreDestroyHook,
  scheduleDeferredDestroy,
} from './FlowGardenDestroyHooks';
import { PostItNoteTranscript } from './PostItNoteTranscript';

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

type AnchorPotSpawner = {
  createPotAtWorldPosition(
    potPrefab: ObjectPrefab,
    potPrefabIndex: number,
    worldPos: vec3
  ): SceneObject | null;
  saveObjectPosition?: () => void;
  setActiveManipulatedRoot?: (root: SceneObject | null) => void;
  notifyTrashSpawnGrace?: (root: SceneObject, graceSeconds?: number) => void;
  syncTrackedWrapperToContent?: (content: SceneObject) => void;
  placeTrackedContentAtWorld?: (content: SceneObject, worldPos: vec3, worldRot?: quat) => void;
  destroyTrackedObject?: (candidate: SceneObject) => boolean;
};

type PotGoalTranscriptLike = ScriptComponent & {
  beginCapture?: () => void;
  endCapture?: () => void;
  getNoteText?: () => string;
  displayPrefix?: string;
};

type PlantPotLike = ScriptComponent & {
  setPendingGoal?: (goalText: string) => void;
  getPendingGoalText?: () => string;
  getPlantedLifecycle?: () => PlantLifecycleLike | null;
};

type PlantLifecycleLike = {
  getGoalText?: () => string;
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

  @input('float')
  @hint('Keep goal transcript capture active briefly after release')
  postReleaseCaptureSec: number = 12;

  private activePull: PullState | null = null;
  private updateEvent: UpdateEvent | null = null;
  private bindAttempts = 0;
  private isBound = false;
  private nextPotIndex = 0;
  private spawnSuppressed = false;

  onAwake(): void {
    registerPreDestroyHook((root) => this.abandonActivePullIfMatches(root));
    this.createEvent('OnStartEvent').bind(() => this.tryBindInteractable());
  }

  public setSpawnSuppressed(suppressed: boolean): void {
    this.spawnSuppressed = suppressed;
  }

  public abortActiveSpawnPull(): void {
    if (isNull(this.activePull) || isNull(this.activePull.potObject)) {
      return;
    }

    const potObject = this.activePull.potObject;
    this.endPotGoalCapture(potObject);
    setGardenSourceSpawnPullActive(this.getSceneObject(), false);
    this.activePull = null;
    if (!isNull(this.updateEvent)) {
      (this.updateEvent as UpdateEvent).enabled = false;
    }

    const anchorSpawner = this.getAnchorPotSpawner();
    if (
      !isNull(anchorSpawner) &&
      typeof anchorSpawner.destroyTrackedObject === 'function' &&
      anchorSpawner.destroyTrackedObject(potObject)
    ) {
      this.debugLog('aborted mistaken spawn pull for move handle.');
      return;
    }

    scheduleDeferredDestroy(this, potObject, () => {
      this.debugLog('aborted mistaken spawn pull for move handle.');
    });
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

    if (!this.allowMultipleActivePots && !isNull(this.activePull)) {
      this.debugLog(`ignored ${reason}: pot already active.`);
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

    if (!this.allowMultipleActivePots && !isNull(this.activePull)) {
      this.debugLog(`ignored ${reason}: pot already active.`);
      return;
    }

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
    setGardenSourceSpawnPullActive(this.getSceneObject(), true);
    this.beginPotGoalCapture(potObject as SceneObject);
    const anchorSpawner = this.getAnchorPotSpawner();
    if (!isNull(anchorSpawner)) {
      const spawner = anchorSpawner as AnchorPotSpawner;
      if (typeof spawner.setActiveManipulatedRoot === 'function') {
        spawner.setActiveManipulatedRoot(potObject as SceneObject);
      }
      this.notifyTrashSpawnGrace(potObject as SceneObject, 5);
    }
    playInteractionSound((sounds) => sounds.playGrabObject());
    this.ensureUpdateLoop();
    this.updatePulledPotPosition();
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
    if (!this.isSceneObjectAlive(pull.potObject)) {
      this.endPotGoalCapture(pull.potObject);
      this.abandonActivePull();
      return;
    }

    const interactor = pull.interactor;
    if (
      interactor &&
      typeof interactor.isActive === 'function' &&
      !interactor.isActive()
    ) {
      this.releaseActivePull();
      return;
    }

    const position = this.getInteractorPosition(interactor, pull.rayDistance);
    this.syncTrackedWrapper(pull.potObject, position);
  }

  private syncTrackedWrapper(content: SceneObject, worldPos?: vec3): void {
    const anchorSpawner = this.getAnchorPotSpawner();
    if (isNull(anchorSpawner)) {
      return;
    }

    const spawner = anchorSpawner as AnchorPotSpawner;
    if (!isNull(worldPos) && typeof spawner.placeTrackedContentAtWorld === 'function') {
      spawner.placeTrackedContentAtWorld(content, worldPos);
      return;
    }

    if (typeof spawner.syncTrackedWrapperToContent === 'function') {
      spawner.syncTrackedWrapperToContent(content);
    }
  }

  private beginPotGoalCapture(potObject: SceneObject): void {
    const transcript = this.ensurePotGoalTranscript(potObject);
    if (!isNull(transcript) && typeof transcript.beginCapture === 'function') {
      transcript.beginCapture();
      this.debugLog(`goal transcript capture ON for ${potObject.name}`);
      return;
    }

    this.debugLog(`goal transcript unavailable for ${potObject.name}`);
  }

  private endPotGoalCapture(potObject: SceneObject): void {
    if (!this.isSceneObjectAlive(potObject)) {
      return;
    }

    const transcript = this.findPotGoalTranscript(potObject);
    if (!isNull(transcript) && typeof transcript.endCapture === 'function') {
      transcript.endCapture();
      this.debugLog(`goal transcript capture OFF for ${potObject.name}`);
    }
  }

  private schedulePotGoalFinalization(potObject: SceneObject): void {
    const delaySec = Math.max(0, this.postReleaseCaptureSec);
    if (delaySec <= 0.001) {
      this.finalizePotGoal(potObject);
      this.endPotGoalCapture(potObject);
      return;
    }

    const finalizeEvent = this.createEvent('DelayedCallbackEvent');
    finalizeEvent.bind(() => {
      this.endPotGoalCapture(potObject);
      this.finalizePotGoal(potObject);
    });
    finalizeEvent.reset(delaySec);
  }

  private finalizePotGoal(potObject: SceneObject): void {
    if (!this.isSceneObjectAlive(potObject)) {
      return;
    }

    const transcript = this.findPotGoalTranscript(potObject);
    if (isNull(transcript) || typeof transcript.getNoteText !== 'function') {
      return;
    }

    const goalText = String(transcript.getNoteText() || '').trim();
    if (!goalText) {
      return;
    }

    const pot = this.findPlantPot(potObject);
    if (isNull(pot) || typeof pot.setPendingGoal !== 'function') {
      this.debugLog(`could not assign goal: PlantPot missing on ${potObject.name}`);
      return;
    }

    const pendingGoal =
      typeof pot.getPendingGoalText === 'function'
        ? String(pot.getPendingGoalText() || '').trim()
        : '';
    if (pendingGoal === goalText) {
      return;
    }

    const plantedPlant =
      typeof pot.getPlantedLifecycle === 'function' ? pot.getPlantedLifecycle() : null;
    if (
      !isNull(plantedPlant) &&
      typeof plantedPlant.getGoalText === 'function' &&
      String(plantedPlant.getGoalText() || '').trim()
    ) {
      this.debugLog(`skipped goal rebind: ${potObject.name} already has a plant goal`);
      return;
    }

    pot.setPendingGoal(goalText);
    this.debugLog(`assigned goal "${goalText}" to ${potObject.name}`);
  }

  private ensurePotGoalTranscript(potObject: SceneObject): PotGoalTranscriptLike | null {
    const existing = this.findPotGoalTranscript(potObject);
    if (!isNull(existing)) {
      existing.displayPrefix = 'Goal';
      return existing;
    }

    try {
      const created = potObject.createComponent(
        PostItNoteTranscript.getTypeName()
      ) as PotGoalTranscriptLike;
      if (!isNull(created)) {
        created.displayPrefix = 'Goal';
        return created;
      }
    } catch (error) {
      this.debugLog(`could not create pot goal transcript: ${String(error)}`);
    }

    return null;
  }

  private findPotGoalTranscript(potObject: SceneObject): PotGoalTranscriptLike | null {
    if (isNull(potObject)) {
      return null;
    }

    const stack: SceneObject[] = [potObject];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as PotGoalTranscriptLike;
        if (
          !isNull(candidate) &&
          typeof candidate.beginCapture === 'function' &&
          typeof candidate.endCapture === 'function' &&
          typeof candidate.getNoteText === 'function'
        ) {
          return candidate;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
  }

  private findPlantPot(potObject: SceneObject): PlantPotLike | null {
    if (isNull(potObject)) {
      return null;
    }

    const stack: SceneObject[] = [potObject];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as PlantPotLike;
        if (!isNull(candidate) && typeof candidate.setPendingGoal === 'function') {
          return candidate;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
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

  private abandonActivePull(): void {
    setGardenSourceSpawnPullActive(this.getSceneObject(), false);
    this.activePull = null;
    if (!isNull(this.updateEvent)) {
      (this.updateEvent as UpdateEvent).enabled = false;
    }
  }

  private releaseActivePull(): void {
    if (isNull(this.activePull)) {
      return;
    }

    this.debugLog('released active pot pull.');
    const releasedPot = this.activePull.potObject;
    this.schedulePotGoalFinalization(releasedPot);
    this.abandonActivePull();

    const anchorSpawner = this.getAnchorPotSpawner();
    if (!isNull(anchorSpawner)) {
      const spawner = anchorSpawner as AnchorPotSpawner;
      const worldPos = releasedPot.getTransform().getWorldPosition();
      if (typeof spawner.placeTrackedContentAtWorld === 'function') {
        spawner.placeTrackedContentAtWorld(releasedPot, worldPos);
      } else if (typeof spawner.syncTrackedWrapperToContent === 'function') {
        spawner.syncTrackedWrapperToContent(releasedPot);
      }
      if (typeof spawner.setActiveManipulatedRoot === 'function') {
        spawner.setActiveManipulatedRoot(releasedPot);
      }
      this.notifyTrashSpawnGrace(releasedPot, 5);
      if (typeof spawner.saveObjectPosition === 'function') {
        spawner.saveObjectPosition();
      }
    }
  }

  private abandonActivePullIfMatches(root: SceneObject): void {
    if (isNull(this.activePull) || isNull(this.activePull.potObject) || isNull(root)) {
      return;
    }

    const pot = this.activePull.potObject;
    if (pot === root || this.isSameHierarchy(pot, root)) {
      this.endPotGoalCapture(pot);
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
    } catch (_error) {
      return false;
    }
  }

  private notifyTrashSpawnGrace(root: SceneObject, graceSeconds: number): void {
    const anchorSpawner = this.getAnchorPotSpawner();
    if (isNull(anchorSpawner)) {
      return;
    }

    const spawner = anchorSpawner as AnchorPotSpawner;
    if (typeof spawner.notifyTrashSpawnGrace === 'function') {
      spawner.notifyTrashSpawnGrace(root, graceSeconds);
    }
  }

  private debugLog(message: string): void {
    if (!this.debugLogging) {
      return;
    }

    print(`[MainPotSource] ${this.getSceneObject().name}: ${message}`);
  }
}

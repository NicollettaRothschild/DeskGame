import { playInteractionSound } from './InteractionSoundRegistry';
import { scheduleDeferredDestroy } from './FlowGardenDestroyHooks';

type AnchorTrashHandler = {
  getTrackedContentRoot?: (candidate: SceneObject) => SceneObject | null;
  getTrackedContentRoots?: () => SceneObject[];
  getTrackedWrapperRoots?: () => SceneObject[];
  destroyTrackedObject?: (candidate: SceneObject) => boolean;
};

type WateringObjectLike = ScriptComponent & {
  beginUnusedLifetime?: () => void;
};

type PlantLifecycleLike = ScriptComponent & {
  getIsPlanted?: () => boolean;
};

type TaskBerryLike = ScriptComponent & {
  configure?: (taskId: string, taskLabel: string) => void;
  getLabelText?: () => string;
};

@component
export class TrashBin extends BaseScriptComponent {
  @input
  @allowUndefined
  triggerCollider!: ColliderComponent;

  @input
  @allowUndefined
  anchorController!: ScriptComponent;

  @input('float')
  trashRadius: number = 14;

  @input('float')
  trashColliderRadius: number = 26;

  @input('float')
  fitVisualRadiusMultiplier: number = 3.5;

  @input
  useProximityTrash: boolean = false;

  @input('float')
  destroyOverlapCooldown: number = 0.35;

  @input
  debugLogging: boolean = true;

  private readonly protectedRootNames = [
    'TrashBin',
    'Planter',
    'Seeds',
    'Water Source',
    'AnchorController',
    'SpectaclesInteractionKit',
    'SpacePanel',
    'WidgetParent',
    'Text3D UserID',
  ];

  private recentDestroyRoots: SceneObject[] = [];
  private recentDestroyTimes: number[] = [];
  private spawnGraceRoots: SceneObject[] = [];
  private spawnGraceUntilTimes: number[] = [];

  onAwake(): void {
    const collider = this.getTriggerCollider();
    if (!isNull(collider)) {
      collider.onOverlapEnter.add((eventArgs: OverlapEnterEventArgs) => {
        this.tryDestroyFromCollider(eventArgs.overlap.collider);
      });
      collider.onOverlapStay.add((eventArgs: OverlapStayEventArgs) => {
        this.tryDestroyFromCollider(eventArgs.overlap.collider);
      });
    } else {
      print('TrashBin has no collider; using proximity-only trash detection.');
    }

    this.createEvent('UpdateEvent').bind(() => this.checkProximityTrash());
  }

  private getTriggerCollider(): ColliderComponent {
    if (!isNull(this.triggerCollider)) {
      return this.triggerCollider;
    }
    return this.getSceneObject().getComponent('Component.ColliderComponent');
  }

  public notifySpawned(root: SceneObject, graceSeconds = 2): void {
    if (isNull(root) || graceSeconds <= 0) {
      return;
    }

    const until = getTime() + graceSeconds;
    for (let i = 0; i < this.spawnGraceRoots.length; i++) {
      if (this.spawnGraceRoots[i] === root) {
        this.spawnGraceUntilTimes[i] = until;
        return;
      }
    }

    this.spawnGraceRoots.push(root);
    this.spawnGraceUntilTimes.push(until);
  }

  public tryTrashSceneObject(candidate: SceneObject): boolean {
    if (isNull(candidate) || this.isProtectedHierarchy(candidate)) {
      return false;
    }

    const destroyRoot = this.findDestroyRoot(candidate);
    if (isNull(destroyRoot)) {
      return false;
    }

    const now = getTime();
    if (this.wasRecentlyDestroyed(destroyRoot, now)) {
      return false;
    }

    this.tryDestroyRoot(destroyRoot, now, true);
    return !isNull(destroyRoot) && this.wasRecentlyDestroyed(destroyRoot, now);
  }

  public getDistanceToTrash(root: SceneObject): number {
    if (isNull(root)) {
      return Number.MAX_VALUE;
    }
    return this.getClosestDistanceToTrash(this.getTrashWorldCenter(), root);
  }

  public getTrashAcceptRadius(): number {
    return this.computeTrashAcceptRadius();
  }

  public isWorldPositionInTrash(worldPos: vec3): boolean {
    return worldPos.distance(this.getTrashWorldCenter()) <= this.computeTrashAcceptRadius();
  }

  public isSceneObjectInTrash(root: SceneObject): boolean {
    if (isNull(root)) {
      return false;
    }

    const trashCenter = this.getTrashWorldCenter();
    const trashRadius = this.computeTrashAcceptRadius();
    return this.getClosestDistanceToTrash(trashCenter, root) <= trashRadius;
  }

  private checkProximityTrash(): void {
    if (!this.useProximityTrash) {
      return;
    }

    const handler = this.getAnchorTrashHandler();
    if (
      isNull(handler) ||
      typeof handler.getTrackedContentRoots !== 'function'
    ) {
      return;
    }

    const trashPos = this.getSceneObject().getTransform().getWorldPosition();
    const wrapperRoots =
      typeof handler.getTrackedWrapperRoots === 'function'
        ? handler.getTrackedWrapperRoots()
        : [];
    const roots =
      wrapperRoots.length > 0 ? wrapperRoots : handler.getTrackedContentRoots();
    const now = getTime();
    let closestRoot: SceneObject | null = null;
    let closestDistance = this.trashRadius + 1;

    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      if (isNull(root) || !root.enabled || this.isBerryObject(root)) {
        continue;
      }

      const distance = this.getClosestDistanceToTrash(trashPos, root);
      if (distance <= this.trashRadius && distance < closestDistance) {
        closestRoot = root;
        closestDistance = distance;
      }
    }

    if (!isNull(closestRoot)) {
      this.tryDestroyRoot(closestRoot, now, false);
    }
  }

  private getTrashWorldCenter(): vec3 {
    const collider = this.getTriggerCollider();
    if (!isNull(collider)) {
      return collider.getSceneObject().getTransform().getWorldPosition();
    }
    return this.getSceneObject().getTransform().getWorldPosition();
  }

  private computeTrashAcceptRadius(): number {
    const collider = this.getTriggerCollider();
    if (isNull(collider)) {
      return Math.max(1, this.trashRadius);
    }

    const colliderObject = collider.getSceneObject();
    if (isNull(colliderObject)) {
      return Math.max(1, this.trashRadius);
    }

    const worldScale = colliderObject.getTransform().getWorldScale();
    const scale = Math.max(worldScale.x, worldScale.y, worldScale.z);
    let shapeRadius = Math.max(1, this.trashColliderRadius * scale);

    const shape = (collider as unknown as { shape?: { FitVisual?: boolean } }).shape;
    if (shape && shape.FitVisual) {
      shapeRadius *= Math.max(1, this.fitVisualRadiusMultiplier);
    }

    return Math.max(this.trashRadius, shapeRadius);
  }

  private getClosestDistanceToTrash(trashPos: vec3, root: SceneObject): number {
    let minDistance = Number.MAX_VALUE;
    const visited: SceneObject[] = [];

    this.visitObjectHierarchy(root, (sceneObject) => {
      minDistance = Math.min(minDistance, this.getObjectProbeDistance(trashPos, sceneObject));
    }, visited);

    return minDistance;
  }

  private getObjectProbeDistance(trashPos: vec3, sceneObject: SceneObject): number {
    const objectPos = sceneObject.getTransform().getWorldPosition();
    let minDistance = objectPos.distance(trashPos);

    const colliders = sceneObject.getComponents('Component.ColliderComponent');
    for (let i = 0; i < colliders.length; i++) {
      const collider = colliders[i];
      if (isNull(collider)) {
        continue;
      }

      const colliderObject = collider.getSceneObject();
      const colliderPos = colliderObject.getTransform().getWorldPosition();
      const scale = colliderObject.getTransform().getWorldScale();
      const maxScale = Math.max(scale.x, scale.y, scale.z);
      const extent = this.estimateColliderExtent(collider, maxScale);
      const centerDistance = colliderPos.distance(trashPos);
      minDistance = Math.min(minDistance, Math.max(0, centerDistance - extent));
    }

    return minDistance;
  }

  private estimateColliderExtent(collider: ColliderComponent, worldScale: number): number {
    const shape = (collider as unknown as {
      shape?: { size?: vec3; radius?: number };
    }).shape;
    if (!shape) {
      return 2 * worldScale;
    }

    if (shape.radius !== undefined && shape.radius > 0) {
      return shape.radius * worldScale;
    }

    if (shape.size) {
      const size = shape.size;
      const halfDiagonal =
        Math.sqrt(size.x * size.x + size.y * size.y + size.z * size.z) * 0.5;
      return halfDiagonal * worldScale;
    }

    return 2 * worldScale;
  }

  private visitObjectHierarchy(
    root: SceneObject,
    visitor: (sceneObject: SceneObject) => void,
    visited: SceneObject[],
    depth = 0
  ): void {
    if (isNull(root) || depth > 12) {
      return;
    }

    for (let i = 0; i < visited.length; i++) {
      if (visited[i] === root) {
        return;
      }
    }
    visited.push(root);
    visitor(root);

    for (let i = 0; i < root.getChildrenCount(); i++) {
      this.visitObjectHierarchy(root.getChild(i), visitor, visited, depth + 1);
    }
  }

  private tryDestroyFromCollider(otherCollider: ColliderComponent): void {
    if (isNull(otherCollider)) {
      return;
    }

    const otherObject = otherCollider.getSceneObject();
    if (isNull(otherObject) || this.isProtectedHierarchy(otherObject)) {
      return;
    }

    const destroyRoot = this.findDestroyRoot(otherObject);
    if (isNull(destroyRoot)) {
      return;
    }

    if (this.isAnchorTrackedDestroyRoot(destroyRoot)) {
      return;
    }

    this.tryDestroyRoot(destroyRoot, getTime(), false);
  }

  private isAnchorTrackedDestroyRoot(destroyRoot: SceneObject): boolean {
    const handler = this.getAnchorTrashHandler();
    if (isNull(handler)) {
      return false;
    }

    if (
      typeof handler.getTrackedContentRoot === 'function' &&
      !isNull(handler.getTrackedContentRoot(destroyRoot))
    ) {
      return true;
    }

    if (typeof handler.getTrackedContentRoots === 'function') {
      const roots = handler.getTrackedContentRoots();
      for (let i = 0; i < roots.length; i++) {
        if (roots[i] === destroyRoot) {
          return true;
        }
      }
    }

    return false;
  }

  private tryDestroyRoot(
    destroyRoot: SceneObject,
    now: number,
    deliberate: boolean
  ): void {
    if (isNull(destroyRoot) || this.wasRecentlyDestroyed(destroyRoot, now)) {
      return;
    }

    if (!deliberate && this.isInSpawnGrace(destroyRoot, now)) {
      return;
    }

    if (!deliberate && this.isAnchorTrackedDestroyRoot(destroyRoot)) {
      return;
    }

    if (this.isBerryObject(destroyRoot)) {
      return;
    }

    const label = destroyRoot.name;

    if (deliberate && this.destroyViaAnchor(destroyRoot)) {
      this.recordDestroyed(destroyRoot, now);
      playInteractionSound((sounds) => sounds.playPlaceObject());
      this.debugLog(`trashed tracked object ${label}`);
      return;
    }

    const trackedRoot = this.getTrackedContentRoot(destroyRoot);
    if (deliberate && !isNull(trackedRoot) && this.destroyViaAnchor(trackedRoot)) {
      this.recordDestroyed(trackedRoot, now);
      playInteractionSound((sounds) => sounds.playPlaceObject());
      this.debugLog(`trashed tracked object ${trackedRoot.name}`);
      return;
    }

    const isWater = !isNull(this.findWateringObject(destroyRoot));
    scheduleDeferredDestroy(this, destroyRoot, () => {
      this.recordDestroyed(destroyRoot, now);
      playInteractionSound((sounds) =>
        isWater ? sounds.playWaterSplash() : sounds.playPlaceObject()
      );
      this.debugLog(`trashed object ${label}`);
    });
  }

  private destroyViaAnchor(candidate: SceneObject): boolean {
    const handler = this.getAnchorTrashHandler();
    if (isNull(handler) || typeof handler.destroyTrackedObject !== 'function') {
      return false;
    }

    return handler.destroyTrackedObject(candidate);
  }

  private findDestroyRoot(sceneObject: SceneObject): SceneObject | null {
    let current = sceneObject;
    while (!isNull(current)) {
      const trackedRoot = this.getTrackedContentRoot(current);
      if (!isNull(trackedRoot)) {
        return trackedRoot;
      }

      const wateringObject = this.findWateringObject(current);
      if (!isNull(wateringObject)) {
        return wateringObject.getSceneObject();
      }

      const freePlant = this.findFreePlantLifecycle(current);
      if (!isNull(freePlant)) {
        return freePlant.getSceneObject();
      }

      const plantedPlant = this.findPlantedPlantLifecycle(current);
      if (!isNull(plantedPlant)) {
        const trackedRoot = this.getTrackedContentRoot(plantedPlant.getSceneObject());
        if (!isNull(trackedRoot)) {
          return trackedRoot;
        }
        return plantedPlant.getSceneObject();
      }

      if (this.isProtectedDestroyTarget(current)) {
        return null;
      }

      current = current.getParent();
    }

    return null;
  }

  private getTrackedContentRoot(candidate: SceneObject): SceneObject | null {
    const handler = this.getAnchorTrashHandler();
    if (isNull(handler) || typeof handler.getTrackedContentRoot !== 'function') {
      return null;
    }
    return handler.getTrackedContentRoot(candidate);
  }

  private findFreePlantLifecycle(sceneObject: SceneObject): PlantLifecycleLike | null {
    let current = sceneObject;
    while (!isNull(current)) {
      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as PlantLifecycleLike;
        if (
          !isNull(candidate) &&
          typeof candidate.getIsPlanted === 'function' &&
          !candidate.getIsPlanted()
        ) {
          return candidate;
        }
      }
      current = current.getParent();
    }
    return null;
  }

  private findWateringObject(sceneObject: SceneObject): WateringObjectLike | null {
    let current = sceneObject;
    while (!isNull(current)) {
      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as WateringObjectLike;
        if (!isNull(candidate) && typeof candidate.beginUnusedLifetime === 'function') {
          return candidate;
        }
      }
      current = current.getParent();
    }
    return null;
  }

  private getAnchorTrashHandler(): AnchorTrashHandler | null {
    if (isNull(this.anchorController)) {
      return null;
    }
    return this.anchorController as unknown as AnchorTrashHandler;
  }

  private findPlantedPlantLifecycle(sceneObject: SceneObject): PlantLifecycleLike | null {
    let current = sceneObject;
    while (!isNull(current)) {
      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as PlantLifecycleLike;
        if (
          !isNull(candidate) &&
          typeof candidate.getIsPlanted === 'function' &&
          candidate.getIsPlanted()
        ) {
          return candidate;
        }
      }
      current = current.getParent();
    }
    return null;
  }

  private isProtectedDestroyTarget(sceneObject: SceneObject): boolean {
    if (sceneObject === this.getSceneObject()) {
      return true;
    }

    for (let i = 0; i < this.protectedRootNames.length; i++) {
      if (sceneObject.name === this.protectedRootNames[i]) {
        return true;
      }
    }

    return false;
  }

  private isProtectedHierarchy(sceneObject: SceneObject): boolean {
    if (this.isBerryObject(sceneObject)) {
      return true;
    }

    if (!isNull(this.getTrackedContentRoot(sceneObject))) {
      return false;
    }

    if (!isNull(this.findFreePlantLifecycle(sceneObject))) {
      return false;
    }

    if (!isNull(this.findWateringObject(sceneObject))) {
      return false;
    }

    let current = sceneObject;
    while (!isNull(current)) {
      if (this.isProtectedDestroyTarget(current)) {
        return true;
      }
      current = current.getParent();
    }

    return false;
  }

  private isBerryObject(sceneObject: SceneObject): boolean {
    let current = sceneObject;
    while (!isNull(current)) {
      const name = String(current.name || '');
      if (name.indexOf('TaskBerry') >= 0 || name.indexOf('Berry_') === 0) {
        return true;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as TaskBerryLike;
        if (
          !isNull(candidate) &&
          typeof candidate.configure === 'function' &&
          typeof candidate.getLabelText === 'function'
        ) {
          return true;
        }
      }

      current = current.getParent();
    }

    return false;
  }

  private isInSpawnGrace(root: SceneObject, now: number): boolean {
    for (let i = this.spawnGraceRoots.length - 1; i >= 0; i--) {
      const graceRoot = this.spawnGraceRoots[i];
      if (isNull(graceRoot) || now >= this.spawnGraceUntilTimes[i]) {
        this.spawnGraceRoots.splice(i, 1);
        this.spawnGraceUntilTimes.splice(i, 1);
        continue;
      }

      if (graceRoot === root || this.isSameHierarchy(graceRoot, root)) {
        return true;
      }
    }

    return false;
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

  private wasRecentlyDestroyed(root: SceneObject, now: number): boolean {
    for (let i = 0; i < this.recentDestroyRoots.length; i++) {
      const recent = this.recentDestroyRoots[i];
      if (
        !isNull(recent) &&
        recent === root &&
        now - this.recentDestroyTimes[i] < this.destroyOverlapCooldown
      ) {
        return true;
      }
    }
    return false;
  }

  private recordDestroyed(root: SceneObject, now: number): void {
    this.recentDestroyRoots.push(root);
    this.recentDestroyTimes.push(now);

    if (this.recentDestroyRoots.length > 16) {
      this.recentDestroyRoots.shift();
      this.recentDestroyTimes.shift();
    }
  }

  private debugLog(message: string): void {
    if (!this.debugLogging) {
      return;
    }
    print(`[TrashBin] ${message}`);
  }
}

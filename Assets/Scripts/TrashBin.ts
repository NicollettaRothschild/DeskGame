import { playInteractionSound } from './InteractionSoundRegistry';

type AnchorTrashHandler = {
  getTrackedContentRoot?: (candidate: SceneObject) => SceneObject | null;
  getTrackedContentRoots?: () => SceneObject[];
  destroyTrackedObject?: (candidate: SceneObject) => boolean;
};

type WateringObjectLike = ScriptComponent & {
  beginUnusedLifetime?: () => void;
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
  trashRadius: number = 8;

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
    'PlantContainer',
    'WidgetParent',
    'SpectaclesInteractionKit',
  ];

  private recentDestroyRoots: SceneObject[] = [];
  private recentDestroyTimes: number[] = [];

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

  private checkProximityTrash(): void {
    const handler = this.getAnchorTrashHandler();
    if (
      isNull(handler) ||
      typeof handler.getTrackedContentRoots !== 'function'
    ) {
      return;
    }

    const trashPos = this.getSceneObject().getTransform().getWorldPosition();
    const roots = handler.getTrackedContentRoots();
    const now = getTime();

    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      if (isNull(root)) {
        continue;
      }

      const distance = root.getTransform().getWorldPosition().distance(trashPos);
      if (distance <= this.trashRadius) {
        this.tryDestroyRoot(root, now);
      }
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

    this.tryDestroyRoot(destroyRoot, getTime());
  }

  private tryDestroyRoot(destroyRoot: SceneObject, now: number): void {
    if (isNull(destroyRoot) || this.wasRecentlyDestroyed(destroyRoot, now)) {
      return;
    }

    const label = destroyRoot.name;

    if (this.destroyViaAnchor(destroyRoot)) {
      this.recordDestroyed(destroyRoot, now);
      playInteractionSound((sounds) => sounds.playPlaceObject());
      this.debugLog(`trashed tracked object ${label}`);
      return;
    }

    const isWater = !isNull(this.findWateringObject(destroyRoot));
    destroyRoot.destroy();
    this.recordDestroyed(destroyRoot, now);
    playInteractionSound((sounds) =>
      isWater ? sounds.playWaterSplash() : sounds.playPlaceObject()
    );
    this.debugLog(`trashed object ${label}`);
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
      if (this.isProtectedHierarchy(current)) {
        return null;
      }

      const wateringObject = this.findWateringObject(current);
      if (!isNull(wateringObject)) {
        return wateringObject.getSceneObject();
      }

      const trackedRoot = this.getTrackedContentRoot(current);
      if (!isNull(trackedRoot)) {
        return trackedRoot;
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

  private isProtectedHierarchy(sceneObject: SceneObject): boolean {
    let current = sceneObject;
    const trashRoot = this.getSceneObject();

    while (!isNull(current)) {
      if (current === trashRoot) {
        return true;
      }

      for (let i = 0; i < this.protectedRootNames.length; i++) {
        if (current.name === this.protectedRootNames[i]) {
          return true;
        }
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

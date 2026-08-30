import { playInteractionSound } from './InteractionSoundRegistry';
import { prepareSceneObjectForDestroy, scheduleDeferredDestroy } from './FlowGardenDestroyHooks';
import { playTrashDeleteSmokePuff } from './TrashDeleteSmokePuff';

export type TrashObjectStoreSnapshot = {
  floats: { [key: string]: number };
  ints: { [key: string]: number };
  bools: { [key: string]: boolean };
  strings: { [key: string]: string };
};

export type TrashStashEntry = {
  wrapper: SceneObject;
  content: SceneObject;
  objectKind: string;
  prefabIndex: number;
  storeSnapshot: TrashObjectStoreSnapshot;
};

type AnchorTrashHandler = {
  getTrackedContentRoot?: (candidate: SceneObject) => SceneObject | null;
  getTrackedContentRoots?: () => SceneObject[];
  getTrackedWrapperRoots?: () => SceneObject[];
  destroyTrackedObject?: (candidate: SceneObject) => boolean;
  stashTrackedObjectInTrash?: (candidate: SceneObject) => boolean;
  reinsertTrackedObject?: (
    entry: TrashStashEntry,
    worldPos: vec3,
    worldRot: quat
  ) => boolean;
  getTrackedSpawnParent?: () => SceneObject;
  setActiveManipulatedRoot?: (root: SceneObject | null) => void;
  persistTrashTransform?: () => void;
  shouldProtectFromReleaseTrash?: (candidate: SceneObject) => boolean;
};

type StashedItemRecord = {
  entry: TrashStashEntry;
  pullActive: boolean;
};

const STASH_CONTAINER_NAME = 'Stash';
const STASH_LOCAL_OFFSET = new vec3(0, 22, 0);
const STASH_ITEM_SCALE = 0.34;
const STASH_ITEM_SPACING = 16;
const STASH_GRID_COLUMNS = 3;

type InteractableLike = ScriptComponent & {
  onDragStart?: { add: (cb: () => void) => void };
  onDragEnd?: { add: (cb: () => void) => void };
  onTriggerStart?: { add: (cb: () => void) => void };
  onTriggerEnd?: { add: (cb: () => void) => void };
  onTriggerEndOutside?: { add: (cb: () => void) => void };
  onInteractorTriggerStart?: { add: (cb: () => void) => void };
  onInteractorTriggerEnd?: { add: (cb: () => void) => void };
  onInteractorTriggerEndOutside?: { add: (cb: () => void) => void };
  targetingMode?: number;
  ignoreInteractionPlane?: boolean;
};

type InteractableManipulationLike = ScriptComponent & {
  manipulateRootSceneObject?: SceneObject;
  enableTranslation?: boolean;
  enableRotation?: boolean;
  enableScale?: boolean;
};

type WateringObjectLike = ScriptComponent & {
  beginUnusedLifetime?: () => void;
  waterPlant?: (plant: unknown) => void;
};

type GardenSourceSpawnerLike = ScriptComponent & {
  setSpawnSuppressed?: (suppressed: boolean) => void;
  abortActiveSpawnPull?: () => void;
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
  grabCollider!: ColliderComponent;

  @input
  @allowUndefined
  anchorController!: ScriptComponent;

  @input('float')
  trashRadius: number = 12;

  @input('float')
  trashColliderRadius: number = 1;

  @input('float')
  fitVisualRadiusMultiplier: number = 1.5;

  @input
  useProximityTrash: boolean = false;

  @input('float')
  destroyOverlapCooldown: number = 0.35;

  @input
  debugLogging: boolean = true;

  @input
  enableDeleteSmokePuff: boolean = true;

  private readonly protectedRootNames = [
    'TrashBin',
    'Planter',
    'Seeds',
    'Water Source',
    'PostItNotes',
    'AnchorController',
    'SpectaclesInteractionKit',
    'SpacePanel',
    'WidgetParent',
    'Text3D UserID',
  ];

  private readonly gardenSourceContainerNames = [
    'Water Source',
    'Planter',
    'Seeds',
    'PostItNotes',
  ];

  private recentDestroyRoots: SceneObject[] = [];
  private recentDestroyTimes: number[] = [];
  private spawnGraceRoots: SceneObject[] = [];
  private spawnGraceUntilTimes: number[] = [];
  private moveInteractionWired = false;
  private bindAttempts = 0;
  private trashMoveActive = false;
  private useExternalMoveHandle = true;
  private stashRestoreAnchor: ScriptComponent | null = null;
  private stashedItems: StashedItemRecord[] = [];
  private stashPullWiredObjects: SceneObject[] = [];
  private activeStashPull: StashedItemRecord | null = null;

  onAwake(): void {
    this.clearLegacyStash();
    this.ensureGrabCollider();
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
    this.createEvent('OnStartEvent').bind(() => {
      const deferRootMove = this.createEvent('DelayedCallbackEvent');
      deferRootMove.bind(() => this.tryWireMoveInteraction());
      deferRootMove.reset(0.35);
    });
  }

  public wireMoveInteraction(): void {
    this.moveInteractionWired = false;
    this.bindAttempts = 0;
    this.ensureGrabCollider();
    this.tryWireMoveInteraction();
  }

  public setUseExternalMoveHandle(useExternal: boolean): void {
    this.useExternalMoveHandle = useExternal;
    if (useExternal) {
      // Container Interactable stays on for hover; MoveHandle owns grab + movement.
      this.setRootMoveEnabled(false);
      this.configureRootContainerInteractable(true);
      this.setGrabColliderEnabled(false);
      this.setTriggerColliderHoverTarget(true);
      this.setRootCollidersForceCompound(false);
      return;
    }

    this.setTriggerColliderHoverTarget(false);
    this.setRootCollidersForceCompound(true);
    this.setGrabColliderEnabled(true);
    this.configureRootContainerInteractable(true);
  }

  private setGrabColliderEnabled(enabled: boolean): void {
    const grab = this.getGrabCollider();
    if (isNull(grab)) {
      return;
    }

    grab.enabled = enabled;
    (grab as unknown as { intangible?: boolean }).intangible = !enabled;
  }

  private setRootCollidersForceCompound(forceCompound: boolean): void {
    const root = this.getSceneObject();
    const colliders = root.getComponents('Component.ColliderComponent');
    for (let i = 0; i < colliders.length; i++) {
      const collider = colliders[i] as ColliderComponent & { forceCompound?: boolean };
      if (isNull(collider)) {
        continue;
      }
      collider.forceCompound = forceCompound;
    }
  }

  private setRootInteractableEnabled(enabled: boolean): void {
    this.configureRootContainerInteractable(enabled);
  }

  private configureRootContainerInteractable(enabled: boolean): void {
    const root = this.getSceneObject();
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i] as ScriptComponent & {
        targetingMode?: number;
        manipulateRootSceneObject?: SceneObject;
        enableInstantDrag?: boolean;
      };
      if (isNull(script) || script.targetingMode === undefined) {
        continue;
      }
      // Skip InteractableManipulation — handled by setRootMoveEnabled.
      if (script.manipulateRootSceneObject !== undefined) {
        continue;
      }

      if (this.useExternalMoveHandle) {
        // Indirect-only hover on the bin body — direct pinch stays on stashed items.
        script.targetingMode = 2;
        if (script.enableInstantDrag !== undefined) {
          script.enableInstantDrag = false;
        }
      }
      script.enabled = enabled;
    }
  }

  private setTriggerColliderHoverTarget(forHover: boolean): void {
    const trigger = this.getTriggerCollider();
    if (isNull(trigger)) {
      return;
    }

    const triggerLike = trigger as unknown as {
      intangible?: boolean;
      forceCompound?: boolean;
    };
    triggerLike.forceCompound = false;
    // Tangible collider so SIK can target the bin body for container hover.
    triggerLike.intangible = !forHover;
  }

  public bindStashRestore(anchor: ScriptComponent): void {
    this.stashRestoreAnchor = anchor;
  }

  public acceptStashedTrackedObject(
    entry: TrashStashEntry,
    anchor?: ScriptComponent | null
  ): void {
    if (!isNull(anchor)) {
      this.stashRestoreAnchor = anchor;
    }

    if (isNull(entry.wrapper) || isNull(entry.content)) {
      return;
    }

    const stashContainer = this.ensureStashContainer();
    if (isNull(stashContainer)) {
      return;
    }

    entry.wrapper.enabled = true;
    entry.content.enabled = true;
    entry.wrapper.setParent(stashContainer);
    this.setInteractionEnabledOnHierarchy(entry.wrapper, true);
    this.setManipulationEnabledOnHierarchy(entry.wrapper, true);

    const record: StashedItemRecord = {
      entry: entry,
      pullActive: false,
    };
    this.stashedItems.push(record);
    this.layoutStashedItems();
    this.wireStashPullInteraction(record);
    print(
      `[TrashBin] stashed ${entry.wrapper.name} (${this.stashedItems.length} item(s) in bin)`
    );
  }

  public getStashedItemCount(): number {
    return this.stashedItems.length;
  }

  public containsTrashBinObject(candidate: SceneObject): boolean {
    if (isNull(candidate)) {
      return false;
    }

    const trashRoot = this.getSceneObject();
    let current = candidate;
    while (!isNull(current)) {
      if (current === trashRoot) {
        return true;
      }
      current = current.getParent();
    }
    return false;
  }

  private ensureGrabCollider(): ColliderComponent | null {
    const existing = this.getGrabCollider();
    if (!isNull(existing)) {
      this.configureGrabCollider(existing);
      return existing;
    }

    const root = this.getSceneObject();
    let grabCollider = root.getComponent('Component.ColliderComponent');
    const trigger = this.getTriggerCollider();
    if (!isNull(grabCollider) && grabCollider === trigger) {
      grabCollider = null;
    }

    if (isNull(grabCollider)) {
      const colliders = root.getComponents('Component.ColliderComponent');
      for (let i = 0; i < colliders.length; i++) {
        const candidate = colliders[i];
        if (isNull(candidate) || candidate === trigger) {
          continue;
        }
        grabCollider = candidate;
        break;
      }
    }

    if (isNull(grabCollider)) {
      grabCollider = root.createComponent('Component.ColliderComponent');
    }

    this.grabCollider = grabCollider;
    this.configureGrabCollider(grabCollider);
    this.debugLog('configured tangible grab collider on trash root');
    return grabCollider;
  }

  private configureGrabCollider(collider: ColliderComponent): void {
    if (isNull(collider)) {
      return;
    }

    const colliderLike = collider as unknown as {
      intangible?: boolean;
      forceCompound?: boolean;
      shape?: { radius?: number; FitVisual?: boolean };
    };
    // Never compound while the external MoveHandle is active — that absorbs the handle collider.
    const allowCompound = !this.useExternalMoveHandle;
    colliderLike.intangible = this.useExternalMoveHandle ? true : false;
    colliderLike.forceCompound = allowCompound;
    if (this.useExternalMoveHandle) {
      collider.enabled = false;
    }

    const trigger = this.getTriggerCollider();
    if (!isNull(trigger)) {
      const triggerLike = trigger as unknown as { forceCompound?: boolean };
      triggerLike.forceCompound = allowCompound;
    }

    if (!colliderLike.shape) {
      colliderLike.shape = { radius: 40, FitVisual: false };
    } else {
      colliderLike.shape.FitVisual = false;
      if (!colliderLike.shape.radius || colliderLike.shape.radius < 20) {
        colliderLike.shape.radius = 40;
      }
    }
  }

  private getGrabCollider(): ColliderComponent | null {
    if (!isNull(this.grabCollider)) {
      return this.grabCollider;
    }

    const trigger = this.getTriggerCollider();
    const root = this.getSceneObject();
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }

      const colliders = current.getComponents('Component.ColliderComponent');
      for (let i = 0; i < colliders.length; i++) {
        const collider = colliders[i];
        if (isNull(collider) || collider === trigger) {
          continue;
        }

        const intangible = (collider as unknown as { intangible?: boolean }).intangible;
        if (intangible === false) {
          this.grabCollider = collider;
          return collider;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
  }

  private findChildByName(root: SceneObject, name: string): SceneObject | null {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }

      if (String(current.name) === name) {
        return current;
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
  }

  private tryWireMoveInteraction(): void {
    if (this.moveInteractionWired || this.useExternalMoveHandle) {
      if (this.useExternalMoveHandle) {
        // Re-assert external-handle mode every retry.
        this.setUseExternalMoveHandle(true);
      }
      return;
    }

    const root = this.getSceneObject();
    this.ensureGrabCollider();
    const manipulation = this.findManipulationScript(root);
    const interactable = this.findInteractableScript(root);
    if (isNull(manipulation) || isNull(interactable)) {
      this.bindAttempts++;
      if (this.bindAttempts >= 30) {
        print(
          'TrashBin could not bind move interaction. Add Interactable and InteractableManipulation to the trash can.'
        );
        return;
      }

      const retryEvent = this.createEvent('DelayedCallbackEvent');
      retryEvent.bind(() => this.tryWireMoveInteraction());
      retryEvent.reset(0.1);
      return;
    }

    // Prevent SIK from processing the serialized Poke mode while this
    // manipulated target is being configured for pinch interaction.
    (manipulation as ScriptComponent).enabled = false;
    (interactable as ScriptComponent).enabled = false;
    manipulation.manipulateRootSceneObject = root;
    manipulation.enableTranslation = true;
    manipulation.enableRotation = true;
    manipulation.enableScale = false;
    // Configure targeting before enabling SIK components so the serialized
    // Poke mode is never observed alongside InteractableManipulation.
    interactable.targetingMode = 3;
    interactable.ignoreInteractionPlane = true;

    const onGrabStart = (): void => {
      this.onTrashGrabStart(root);
    };

    const onRelease = (): void => {
      this.onTrashGrabRelease();
    };

    if (interactable.onDragStart) {
      interactable.onDragStart.add(onGrabStart);
    }
    if (interactable.onTriggerStart) {
      interactable.onTriggerStart.add(onGrabStart);
    }
    if (interactable.onInteractorTriggerStart) {
      interactable.onInteractorTriggerStart.add(onGrabStart);
    }

    if (interactable.onDragEnd) {
      interactable.onDragEnd.add(onRelease);
    }
    if (interactable.onTriggerEnd) {
      interactable.onTriggerEnd.add(onRelease);
    }
    if (interactable.onTriggerEndOutside) {
      interactable.onTriggerEndOutside.add(onRelease);
    }
    if (interactable.onInteractorTriggerEnd) {
      interactable.onInteractorTriggerEnd.add(onRelease);
    }
    if (interactable.onInteractorTriggerEndOutside) {
      interactable.onInteractorTriggerEndOutside.add(onRelease);
    }

    (manipulation as ScriptComponent).enabled = true;
    (interactable as ScriptComponent).enabled = true;
    this.moveInteractionWired = true;
    const grabCollider = this.getGrabCollider();
    const grabScale = !isNull(grabCollider)
      ? grabCollider.getSceneObject().getTransform().getWorldScale()
      : root.getTransform().getWorldScale();
    const grabScaleMax = Math.max(grabScale.x, grabScale.y, grabScale.z);
    const grabShape = !isNull(grabCollider)
      ? (grabCollider as unknown as { shape?: { radius?: number } }).shape
      : undefined;
    const grabRadius = grabShape && grabShape.radius ? grabShape.radius * grabScaleMax : 0;
    print(
      `TrashBin move interaction wired (grab radius ~${grabRadius.toFixed(1)} world units)`
    );
    this.debugLog('move interaction wired');
  }

  private persistTrashAnchorTransform(): void {
    const handler = this.getAnchorTrashHandler();
    if (!isNull(handler) && typeof handler.persistTrashTransform === 'function') {
      handler.persistTrashTransform();
    }
  }

  private onTrashGrabStart(root: SceneObject): void {
    if (this.trashMoveActive) {
      return;
    }

    this.trashMoveActive = true;
    this.markTrashBeingMoved(root);
    playInteractionSound((sounds) => sounds.playGrabObject());
  }

  private onTrashGrabRelease(): void {
    if (!this.trashMoveActive) {
      return;
    }

    this.tryTrashOverlappingTracked(true);
    this.trashMoveActive = false;
    playInteractionSound((sounds) => sounds.playReleaseObject());
    this.persistTrashAnchorTransform();
  }

  private tryTrashOverlappingTracked(deliberate: boolean): void {
    const handler = this.getAnchorTrashHandler();
    if (
      isNull(handler) ||
      typeof handler.getTrackedContentRoots !== 'function'
    ) {
      return;
    }

    const now = getTime();
    const roots = handler.getTrackedContentRoots();
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      if (isNull(root) || !root.enabled || this.isBerryObject(root)) {
        continue;
      }

      if (this.isGardenSourceContainerHierarchy(root)) {
        continue;
      }

      if (!this.isTrackedRootInTrashVolume(root)) {
        continue;
      }

      const destroyRoot = this.findDestroyRoot(root) || root;
      if (isNull(destroyRoot)) {
        continue;
      }

      this.tryDestroyRoot(destroyRoot, now, deliberate);
    }
  }

  private markTrashBeingMoved(root: SceneObject): void {
    const handler = this.getAnchorTrashHandler() as {
      setActiveManipulatedRoot?: (root: SceneObject | null) => void;
    };
    if (!isNull(handler) && typeof handler.setActiveManipulatedRoot === 'function') {
      handler.setActiveManipulatedRoot(root);
    }
  }

  private findInteractableScript(root: SceneObject): InteractableLike | null {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
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

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
  }

  private findManipulationScript(root: SceneObject): InteractableManipulationLike | null {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as InteractableManipulationLike;
        if (!isNull(candidate) && candidate.manipulateRootSceneObject !== undefined) {
          return candidate;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
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

  public isInSpawnGrace(root: SceneObject): boolean {
    return this.isInSpawnGraceAt(root, getTime());
  }

  public tryTrashSceneObject(candidate: SceneObject): boolean {
    if (
      isNull(candidate) ||
      this.isProtectedHierarchy(candidate) ||
      this.isGardenSourceContainerHierarchy(candidate)
    ) {
      return false;
    }

    const destroyRoot = this.findDestroyRoot(candidate);
    if (isNull(destroyRoot)) {
      return false;
    }

    const now = getTime();
    if (
      this.wasRecentlyDestroyed(destroyRoot, now) ||
      this.isInSpawnGraceAt(destroyRoot, now)
    ) {
      return false;
    }

    if (!this.isDestroyRootInTrashForRelease(destroyRoot)) {
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

  public tryTrashTrackedOnRelease(releasedRoot?: SceneObject | null): boolean {
    if (
      isNull(releasedRoot) ||
      this.containsTrashBinObject(releasedRoot) ||
      this.isGardenSourceContainerHierarchy(releasedRoot)
    ) {
      return false;
    }

    const destroyRoot = this.findDestroyRoot(releasedRoot);
    if (isNull(destroyRoot) || !this.isAnchorTrackedDestroyRoot(destroyRoot)) {
      return false;
    }

    const trackedRoot = this.getTrackedContentRoot(destroyRoot) || destroyRoot;
    if (
      isNull(trackedRoot) ||
      !trackedRoot.enabled ||
      this.isBerryObject(trackedRoot)
    ) {
      return false;
    }

    if (this.shouldProtectFromReleaseTrash(trackedRoot)) {
      if (this.debugLogging) {
        this.debugLog(`release protected ${trackedRoot.name}`);
      }
      return false;
    }

    if (!this.isTrackedRootInTrashVolume(trackedRoot)) {
      if (this.debugLogging) {
        const distance = this.getDistanceToTrash(trackedRoot);
        this.debugLog(
          `release miss ${trackedRoot.name} dist=${distance.toFixed(1)} radius=${this.computeReleaseTrashRadius().toFixed(1)}`
        );
      }
      return false;
    }

    const now = getTime();
    this.tryDestroyRoot(destroyRoot, now, true);
    return this.wasRecentlyDestroyed(destroyRoot, now);
  }

  public tryTrashReleasedObject(releasedRoot?: SceneObject | null): boolean {
    if (this.tryTrashTrackedOnRelease(releasedRoot)) {
      return true;
    }

    if (isNull(releasedRoot) || this.containsTrashBinObject(releasedRoot)) {
      return false;
    }

    const destroyRoot = this.findDestroyRoot(releasedRoot);
    if (isNull(destroyRoot) || this.isAnchorTrackedDestroyRoot(destroyRoot)) {
      return false;
    }

    return this.tryTrashSceneObject(releasedRoot);
  }

  private isTrackedRootInTrashVolume(root: SceneObject): boolean {
    return this.isTrackedRootWithinTrashRadius(root, this.computeReleaseTrashRadius());
  }

  /** Release checks use a tighter radius so moving plants near TrashBin does not delete them. */
  private computeReleaseTrashRadius(): number {
    return Math.max(
      this.trashRadius,
      this.computeColliderTrashRadius(false)
    );
  }

  private isDestroyRootInTrashForRelease(destroyRoot: SceneObject): boolean {
    if (isNull(destroyRoot)) {
      return false;
    }

    const trashCenter = this.getTrashWorldCenter();
    const trashRadius = this.computeReleaseTrashRadius();
    return this.getClosestDistanceToTrash(trashCenter, destroyRoot) <= trashRadius;
  }

  private isTrackedRootWithinTrashRadius(root: SceneObject, trashRadius: number): boolean {
    const trashCenter = this.getTrashWorldCenter();
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

  /** Collider overlap / proximity checks — includes FitVisual padding. */
  private computeTrashAcceptRadius(): number {
    return this.computeColliderTrashRadius(true);
  }

  private computeColliderTrashRadius(includeVisualFit: boolean): number {
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
    const shape = (collider as unknown as {
      shape?: { FitVisual?: boolean; radius?: number; size?: vec3 };
    }).shape;

    let shapeRadius = Math.max(1, this.trashColliderRadius * scale);
    if (shape && shape.radius !== undefined && shape.radius > 0) {
      shapeRadius = shape.radius * scale;
    } else if (shape && shape.size) {
      const size = shape.size;
      shapeRadius =
        Math.sqrt(size.x * size.x + size.y * size.y + size.z * size.z) * 0.5 * scale;
    }

    if (includeVisualFit && shape && shape.FitVisual) {
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

    const deliberate = this.trashMoveActive;
    if (
      !deliberate &&
      this.isAnchorTrackedDestroyRoot(destroyRoot) &&
      !this.isTrashableLooseTrackedPlant(destroyRoot)
    ) {
      return;
    }

    this.tryDestroyRoot(destroyRoot, getTime(), deliberate);
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

    if (typeof handler.getTrackedWrapperRoots === 'function') {
      const wrappers = handler.getTrackedWrapperRoots();
      for (let i = 0; i < wrappers.length; i++) {
        if (wrappers[i] === destroyRoot || this.isSameHierarchy(destroyRoot, wrappers[i])) {
          return true;
        }
      }
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
    if (
      isNull(destroyRoot) ||
      this.isGardenSourceContainerHierarchy(destroyRoot) ||
      this.wasRecentlyDestroyed(destroyRoot, now)
    ) {
      return;
    }

    if (!deliberate && this.isInSpawnGraceAt(destroyRoot, now)) {
      return;
    }

    if (this.isBerryObject(destroyRoot)) {
      return;
    }

    const label = destroyRoot.name;
    const trackedRoot = this.getTrackedContentRoot(destroyRoot);
    const isTracked =
      this.isAnchorTrackedDestroyRoot(destroyRoot) || !isNull(trackedRoot);
    const isLooseTrackedPlant = this.isTrashableLooseTrackedPlant(destroyRoot);
    if (isTracked && !deliberate && !isLooseTrackedPlant) {
      return;
    }

    if (isTracked) {
      if (this.destroyViaAnchor(destroyRoot)) {
        this.playDeleteSmokePuff(destroyRoot);
        this.recordDestroyed(destroyRoot, now);
        playInteractionSound((sounds) => sounds.playPlaceObject());
        this.debugLog(`trashed tracked object ${label}`);
        return;
      }

      if (!isNull(trackedRoot) && this.destroyViaAnchor(trackedRoot)) {
        this.playDeleteSmokePuff(trackedRoot);
        this.recordDestroyed(trackedRoot, now);
        playInteractionSound((sounds) => sounds.playPlaceObject());
        this.debugLog(`trashed tracked object ${trackedRoot.name}`);
        return;
      }

      if (!isLooseTrackedPlant) {
        return;
      }
    }

    this.playDeleteSmokePuff(destroyRoot);

    const isWater = !isNull(this.findWateringObject(destroyRoot));
    scheduleDeferredDestroy(this, destroyRoot, () => {
      this.recordDestroyed(destroyRoot, now);
      playInteractionSound((sounds) =>
        isWater ? sounds.playWaterSplash() : sounds.playPlaceObject()
      );
      this.debugLog(`trashed object ${label}`);
    });
  }

  private playDeleteSmokePuff(destroyRoot: SceneObject): void {
    if (!this.enableDeleteSmokePuff || isNull(destroyRoot)) {
      return;
    }

    playTrashDeleteSmokePuff(this.getDeletePuffWorldPosition(destroyRoot), this);
  }

  private getDeletePuffWorldPosition(destroyRoot: SceneObject): vec3 {
    const objectPos = destroyRoot.getTransform().getWorldPosition();
    const trashCenter = this.getTrashWorldCenter();
    const blend = 0.35;
    return new vec3(
      objectPos.x + (trashCenter.x - objectPos.x) * blend,
      objectPos.y + (trashCenter.y - objectPos.y) * blend + 4.0,
      objectPos.z + (trashCenter.z - objectPos.z) * blend
    );
  }

  private destroyViaAnchor(candidate: SceneObject): boolean {
    const handler = this.getAnchorTrashHandler();
    if (isNull(handler)) {
      return false;
    }

    if (typeof handler.destroyTrackedObject === 'function') {
      return handler.destroyTrackedObject(candidate);
    }

    if (typeof handler.stashTrackedObjectInTrash === 'function') {
      return handler.stashTrackedObjectInTrash(candidate);
    }

    return false;
  }

  private isWaterDestroyRoot(destroyRoot: SceneObject): boolean {
    if (isNull(destroyRoot)) {
      return false;
    }

    if (!isNull(this.findWateringObject(destroyRoot))) {
      return true;
    }

    return this.isLooseWaterLikeObject(destroyRoot);
  }

  private findDestroyRoot(sceneObject: SceneObject): SceneObject | null {
    if (this.isGardenSourceContainerHierarchy(sceneObject)) {
      return null;
    }

    let current = sceneObject;
    while (!isNull(current)) {
      if (this.isGardenSourceContainerRoot(current)) {
        return null;
      }

      const trackedRoot = this.getTrackedContentRoot(current);
      if (!isNull(trackedRoot)) {
        return trackedRoot;
      }

      const wateringObject = this.findWateringObject(current);
      if (!isNull(wateringObject)) {
        return wateringObject.getSceneObject();
      }

      // Some water “droplets” are simple prefabs without a WateringObject script.
      // If they enter the trash, treat the first water-like object in the hierarchy as the root.
      if (this.isLooseWaterLikeObject(current)) {
        return current;
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

  private isLooseWaterLikeObject(sceneObject: SceneObject): boolean {
    if (
      isNull(sceneObject) ||
      this.isProtectedDestroyTarget(sceneObject) ||
      this.isGardenSourceContainerHierarchy(sceneObject)
    ) {
      return false;
    }

    const name = String(sceneObject.name || '').toLowerCase();
    if (!name) {
      return false;
    }

    // Keep this intentionally conservative: only match obvious water droplet/object names.
    if (
      name.indexOf('wateringobject') >= 0 ||
      name.indexOf('water_droplet') >= 0 ||
      name.indexOf('waterdroplet') >= 0 ||
      name.indexOf('water drop') >= 0 ||
      name.indexOf('droplet') >= 0
    ) {
      return true;
    }

    return false;
  }

  private getTrackedContentRoot(candidate: SceneObject): SceneObject | null {
    const handler = this.getAnchorTrashHandler();
    if (isNull(handler) || typeof handler.getTrackedContentRoot !== 'function') {
      return null;
    }
    return handler.getTrackedContentRoot(candidate);
  }

  private isTrashableLooseTrackedPlant(destroyRoot: SceneObject): boolean {
    if (!this.isAnchorTrackedDestroyRoot(destroyRoot)) {
      return false;
    }

    const freePlant = this.findFreePlantLifecycle(destroyRoot);
    if (isNull(freePlant)) {
      return false;
    }

    const candidate = freePlant as PlantLifecycleLike & {
      getSaveState?: () => { stage?: number; hasBeenWatered?: boolean };
    };
    if (typeof candidate.getSaveState !== 'function') {
      return true;
    }

    const state = candidate.getSaveState();
    if (state.hasBeenWatered) {
      return false;
    }

    return state.stage === 0 || state.stage === undefined;
  }

  private shouldProtectFromReleaseTrash(root: SceneObject): boolean {
    const handler = this.getAnchorTrashHandler();
    if (
      isNull(handler) ||
      typeof handler.shouldProtectFromReleaseTrash !== 'function'
    ) {
      return false;
    }
    return handler.shouldProtectFromReleaseTrash(root);
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
      if (this.isGardenSourceContainerRoot(current)) {
        return null;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as WateringObjectLike;
        if (
          !isNull(candidate) &&
          typeof candidate.beginUnusedLifetime === 'function' &&
          typeof candidate.waterPlant === 'function'
        ) {
          return candidate;
        }
      }
      current = current.getParent();
    }
    return null;
  }

  private getAnchorTrashHandler(): AnchorTrashHandler | null {
    if (!isNull(this.stashRestoreAnchor)) {
      return this.stashRestoreAnchor as unknown as AnchorTrashHandler;
    }
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

    if (this.isGardenSourceContainerHierarchy(sceneObject)) {
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

  private isGardenSourceContainerHierarchy(sceneObject: SceneObject): boolean {
    let current = sceneObject;
    while (!isNull(current)) {
      if (this.isGardenSourceContainerRoot(current)) {
        return true;
      }
      current = current.getParent();
    }

    return false;
  }

  private isGardenSourceContainerRoot(sceneObject: SceneObject): boolean {
    const name = String(sceneObject.name || '');
    for (let i = 0; i < this.gardenSourceContainerNames.length; i++) {
      if (name === this.gardenSourceContainerNames[i]) {
        return true;
      }
    }

    return this.hasGardenSourceSpawnerScript(sceneObject);
  }

  private hasGardenSourceSpawnerScript(sceneObject: SceneObject): boolean {
    const scripts = sceneObject.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as GardenSourceSpawnerLike;
      if (
        !isNull(candidate) &&
        typeof candidate.setSpawnSuppressed === 'function' &&
        typeof candidate.abortActiveSpawnPull === 'function'
      ) {
        return true;
      }
    }

    return false;
  }

  private isInSpawnGraceAt(root: SceneObject, now: number): boolean {
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

  private clearLegacyStash(): void {
    const root = this.getSceneObject();
    const stash = this.findChildByName(root, STASH_CONTAINER_NAME);
    if (isNull(stash)) {
      this.stashedItems = [];
      return;
    }

    for (let i = stash.getChildrenCount() - 1; i >= 0; i--) {
      const child = stash.getChild(i);
      if (isNull(child)) {
        continue;
      }
      prepareSceneObjectForDestroy(child);
      child.destroy();
    }

    this.stashedItems = [];
  }

  private ensureStashContainer(): SceneObject | null {
    const root = this.getSceneObject();
    let stash = this.findChildByName(root, STASH_CONTAINER_NAME);
    if (isNull(stash)) {
      stash = global.scene.createSceneObject(STASH_CONTAINER_NAME);
      stash.setParent(root);
    }

    stash.enabled = true;
    stash.getTransform().setLocalPosition(STASH_LOCAL_OFFSET);
    return stash;
  }

  private layoutStashedItems(): void {
    const stash = this.ensureStashContainer();
    if (isNull(stash)) {
      return;
    }

    for (let i = 0; i < this.stashedItems.length; i++) {
      const record = this.stashedItems[i];
      if (isNull(record.entry.wrapper)) {
        continue;
      }

      const column = i % STASH_GRID_COLUMNS;
      const row = Math.floor(i / STASH_GRID_COLUMNS);
      const offsetX = (column - (STASH_GRID_COLUMNS - 1) * 0.5) * STASH_ITEM_SPACING;
      const offsetZ = row * STASH_ITEM_SPACING;
      record.entry.wrapper.setParent(stash);
      record.entry.wrapper.getTransform().setLocalPosition(
        new vec3(offsetX, 0, offsetZ)
      );
      record.entry.wrapper.getTransform().setLocalRotation(quat.quatIdentity());
      record.entry.wrapper.getTransform().setLocalScale(
        new vec3(STASH_ITEM_SCALE, STASH_ITEM_SCALE, STASH_ITEM_SCALE)
      );
      record.entry.wrapper.enabled = true;
      record.entry.content.enabled = true;
    }
  }

  private wireStashPullInteraction(record: StashedItemRecord): void {
    if (isNull(record.entry.wrapper)) {
      return;
    }

    this.bindStashPullOnHierarchy(record.entry.wrapper, record);
    this.bindStashPullOnHierarchy(record.entry.content, record);
  }

  private bindStashPullOnHierarchy(node: SceneObject, record: StashedItemRecord): void {
    if (isNull(node)) {
      return;
    }

    if (!this.isStashPullWired(node)) {
      this.markStashPullWired(node);
      const scripts = node.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i] as InteractableLike;
        if (isNull(script) || !this.isStashPullInteractionScript(script)) {
          continue;
        }

        if (script.targetingMode !== undefined) {
          // Pulled items use InteractableManipulation, so keep them on the
          // direct/indirect pinch path rather than the unsupported Poke path.
          script.targetingMode = 3;
        }
        if (script.ignoreInteractionPlane !== undefined) {
          script.ignoreInteractionPlane = true;
        }
        script.enabled = true;

        const onGrabStart = (): void => {
          this.onStashPullStart(record);
        };
        const onRelease = (): void => {
          this.onStashPullRelease(record);
        };

        if (script.onDragStart) {
          script.onDragStart.add(onGrabStart);
        }
        if (script.onTriggerStart) {
          script.onTriggerStart.add(onGrabStart);
        }
        if (script.onInteractorTriggerStart) {
          script.onInteractorTriggerStart.add(onGrabStart);
        }

        if (script.onDragEnd) {
          script.onDragEnd.add(onRelease);
        }
        if (script.onTriggerEnd) {
          script.onTriggerEnd.add(onRelease);
        }
        if (script.onTriggerEndOutside) {
          script.onTriggerEndOutside.add(onRelease);
        }
        if (script.onInteractorTriggerEnd) {
          script.onInteractorTriggerEnd.add(onRelease);
        }
        if (script.onInteractorTriggerEndOutside) {
          script.onInteractorTriggerEndOutside.add(onRelease);
        }
      }
    }

    for (let i = 0; i < node.getChildrenCount(); i++) {
      this.bindStashPullOnHierarchy(node.getChild(i), record);
    }
  }

  private isStashPullInteractionScript(script: ScriptComponent): boolean {
    const candidate = script as unknown as Record<string, unknown>;
    if (Array.isArray(candidate.onPinchUp_Select)) {
      return false;
    }
    if (candidate.manipulateRootSceneObject !== undefined) {
      return true;
    }
    return candidate.targetingMode !== undefined && candidate.onTriggerStart !== undefined;
  }

  private isStashPullWired(node: SceneObject): boolean {
    for (let i = this.stashPullWiredObjects.length - 1; i >= 0; i--) {
      const wired = this.stashPullWiredObjects[i];
      if (isNull(wired)) {
        this.stashPullWiredObjects.splice(i, 1);
        continue;
      }
      if (wired === node) {
        return true;
      }
    }
    return false;
  }

  private markStashPullWired(node: SceneObject): void {
    if (this.isStashPullWired(node)) {
      return;
    }
    this.stashPullWiredObjects.push(node);
  }

  private onStashPullStart(record: StashedItemRecord): void {
    if (isNull(record.entry.wrapper) || record.pullActive) {
      return;
    }

    record.pullActive = true;
    this.activeStashPull = record;

    const handler = this.getAnchorTrashHandler();
    const spawnParent =
      !isNull(handler) && typeof handler.getTrackedSpawnParent === 'function'
        ? handler.getTrackedSpawnParent()
        : null;
    const wrapper = record.entry.wrapper;
    const worldPos = wrapper.getTransform().getWorldPosition();
    const worldRot = wrapper.getTransform().getWorldRotation();
    const worldScale = wrapper.getTransform().getWorldScale();

    if (!isNull(spawnParent)) {
      wrapper.setParent(spawnParent);
    }
    wrapper.getTransform().setWorldPosition(worldPos);
    wrapper.getTransform().setWorldRotation(worldRot);
    wrapper.getTransform().setWorldScale(worldScale);

    if (!isNull(handler) && typeof handler.setActiveManipulatedRoot === 'function') {
      handler.setActiveManipulatedRoot(record.entry.content);
    }

    playInteractionSound((sounds) => sounds.playGrabObject());
  }

  private onStashPullRelease(record: StashedItemRecord): void {
    if (!record.pullActive) {
      return;
    }

    record.pullActive = false;
    if (this.activeStashPull === record) {
      this.activeStashPull = null;
    }

    const wrapper = record.entry.wrapper;
    if (isNull(wrapper)) {
      return;
    }

    const worldPos = wrapper.getTransform().getWorldPosition();
    const worldRot = wrapper.getTransform().getWorldRotation();
    const outsideTrash = !this.isWorldPositionInTrash(worldPos);
    const handler = this.getAnchorTrashHandler();

    if (
      outsideTrash &&
      !isNull(handler) &&
      typeof handler.reinsertTrackedObject === 'function' &&
      handler.reinsertTrackedObject(record.entry, worldPos, worldRot)
    ) {
      this.removeStashedRecord(record);
      playInteractionSound((sounds) => sounds.playPlaceObject());
      this.debugLog(`restored ${record.entry.wrapper.name} from stash`);
      return;
    }

    this.returnRecordToStash(record);
    playInteractionSound((sounds) => sounds.playReleaseObject());
  }

  private returnRecordToStash(record: StashedItemRecord): void {
    record.pullActive = false;
    this.layoutStashedItems();
  }

  private removeStashedRecord(record: StashedItemRecord): void {
    for (let i = this.stashedItems.length - 1; i >= 0; i--) {
      if (this.stashedItems[i] === record) {
        this.stashedItems.splice(i, 1);
        break;
      }
    }
    this.layoutStashedItems();
  }

  private setRootMoveEnabled(enabled: boolean): void {
    const root = this.getSceneObject();
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i] as ScriptComponent & {
        manipulateRootSceneObject?: SceneObject;
      };
      if (isNull(script) || script.manipulateRootSceneObject === undefined) {
        continue;
      }

      script.enabled = enabled;
    }
  }

  private setInteractionEnabledOnHierarchy(root: SceneObject, enabled: boolean): void {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i] as ScriptComponent & { targetingMode?: number };
        if (isNull(script) || script.targetingMode === undefined) {
          continue;
        }
        script.enabled = enabled;
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
  }

  private setManipulationEnabledOnHierarchy(root: SceneObject, enabled: boolean): void {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i] as ScriptComponent & {
          manipulateRootSceneObject?: SceneObject;
        };
        if (isNull(script) || script.manipulateRootSceneObject === undefined) {
          continue;
        }
        script.enabled = enabled;
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
  }
}

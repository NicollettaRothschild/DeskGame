import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import { InteractableManipulation } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation';
import { BackPlate } from 'SpectaclesUIKit.lspkg/Scripts/BackPlate';

type InteractableLike = ScriptComponent & {
  targetingMode?: number;
  colliders?: ColliderComponent[];
  ignoreInteractionPlane?: boolean;
  keepHoverOnTrigger?: boolean;
  enableInstantDrag?: boolean;
  onTriggerStart?: { add: (cb: () => void) => void };
  onDragStart?: { add: (cb: () => void) => void };
  onDragEnd?: { add: (cb: () => void) => void };
  onInteractorTriggerStart?: { add: (cb: () => void) => void };
  onTriggerEnd?: { add: (cb: () => void) => void };
  onTriggerEndOutside?: { add: (cb: () => void) => void };
  onTriggerCanceled?: { add: (cb: () => void) => void };
  onInteractorTriggerEnd?: { add: (cb: () => void) => void };
  onInteractorTriggerEndOutside?: { add: (cb: () => void) => void };
  useFilteredPinch?: boolean;
};

type InteractableManipulationLike = ScriptComponent & {
  manipulateRootSceneObject?: SceneObject;
  enableTranslation?: boolean;
  enableRotation?: boolean;
  enableScale?: boolean;
  useFilter?: boolean;
  onManipulationStart?: { add: (cb: () => void) => void };
  onManipulationEnd?: { add: (cb: () => void) => void };
};

@component
export class LeaderboardGrab extends BaseScriptComponent {
  @input
  debugLogging: boolean = false;

  /** Collider bounds for easier distance pinch grabbing. */
  @input
  colliderSize: vec3 = new vec3(110, 95, 24);

  @input
  @allowUndefined
  anchorController!: ScriptComponent;

  private grabInteractable: InteractableLike | null = null;
  private grabManipulation: InteractableManipulationLike | null = null;
  private moveInteractionWired = false;
  private moveBindAttempts = 0;
  private grabWireRetryPending = false;
  private moveActive = false;

  private static readonly ANCHOR_SOURCE_NAME = 'Leaderboard';
  private static readonly MIN_COLLIDER_SIZE = new vec3(70, 70, 16);

  private getAnchorHandler(): {
    persistGardenSourceTransform?: (sourceName: string) => void;
    setActiveManipulatedRoot?: (root: SceneObject | null) => void;
  } | null {
    if (isNull(this.anchorController)) {
      return null;
    }
    return this.anchorController as unknown as {
      persistGardenSourceTransform?: (sourceName: string) => void;
      setActiveManipulatedRoot?: (root: SceneObject | null) => void;
    };
  }

  onAwake(): void {
    // GoalLeaderboardBoard adds BackPlate during its own onAwake. BackPlate
    // creates the panel's Interactable on OnStart, so wait until that native
    // UI component has initialized before selecting the interaction target.
    // Wiring immediately here creates a second Interactable on the same root
    // and leaves InteractableManipulation attached to the wrong one.
    this.createEvent('OnEnableEvent').bind(() => {
      if (!this.moveInteractionWired) {
        this.scheduleGrabWireRetry(0.1);
      }
    });
    this.scheduleGrabWireRetry(0.25);
    this.scheduleGrabWireRetry(0.75);
  }

  public requestMoveInteractionWire(): void {
    if (!this.moveInteractionWired) {
      this.scheduleGrabWireRetry(0.1);
    }
  }

  private scheduleGrabWireRetry(delaySec: number): void {
    if (this.moveInteractionWired || this.grabWireRetryPending) {
      return;
    }
    this.grabWireRetryPending = true;
    const retryEvent = this.createEvent('DelayedCallbackEvent');
    retryEvent.bind(() => {
      this.grabWireRetryPending = false;
      if (!this.moveInteractionWired) {
        this.tryWireMoveInteraction();
      } else {
        this.refreshGrabCollider();
      }
    });
    retryEvent.reset(delaySec);
  }

  private ensureAnchorGrabComponents(): void {
    const anchor = this.getSceneObject();
    this.refreshGrabCollider();

    let interactable = this.findExistingInteractable(anchor);
    if (isNull(interactable)) {
      // BackPlate creates its Interactable lazily from OnStart. Do not create
      // a competing target while that initialization is still pending.
      if (!isNull(anchor.getComponent(BackPlate.getTypeName()))) {
        this.grabInteractable = null;
        this.grabManipulation = null;
        return;
      }
      interactable = anchor.createComponent(Interactable.getTypeName()) as InteractableLike;
    }

    let manipulation = this.findExistingManipulation(anchor);
    if (isNull(manipulation)) {
      manipulation = anchor.createComponent(
        InteractableManipulation.getTypeName()
      ) as unknown as InteractableManipulationLike;
    }

    // A movable object should expose direct and distance-pinching, but not
    // poke. Poke is incompatible with InteractableManipulation and causes SIK
    // to disable part of this target at runtime.
    interactable.targetingMode = 3;
    interactable.ignoreInteractionPlane = true;
    interactable.keepHoverOnTrigger = true;
    interactable.enableInstantDrag = true;
    if (interactable.useFilteredPinch !== undefined) {
      interactable.useFilteredPinch = true;
    }

    manipulation.manipulateRootSceneObject = anchor;
    manipulation.enableTranslation = true;
    manipulation.enableRotation = true;
    manipulation.enableScale = false;
    manipulation.useFilter = false;

    this.grabInteractable = interactable;
    this.grabManipulation = manipulation;
  }

  private findExistingInteractable(root: SceneObject): InteractableLike | null {
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as InteractableLike;
      if (
        !isNull(candidate) &&
        candidate.targetingMode !== undefined &&
        (candidate.onTriggerStart !== undefined ||
          candidate.onInteractorTriggerStart !== undefined ||
          candidate.onDragStart !== undefined ||
          candidate.onTriggerEnd !== undefined ||
          candidate.onInteractorTriggerEnd !== undefined)
      ) {
        return candidate;
      }
    }
    return null;
  }

  private findExistingManipulation(root: SceneObject): InteractableManipulationLike | null {
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as InteractableManipulationLike;
      if (!isNull(candidate) && candidate.manipulateRootSceneObject !== undefined) {
        return candidate;
      }
    }
    return null;
  }

  private tryWireMoveInteraction(): void {
    if (this.moveInteractionWired) {
      return;
    }

    this.ensureAnchorGrabComponents();
    const interactable = this.grabInteractable;
    const manipulation = this.grabManipulation;
    if (isNull(interactable) || isNull(manipulation)) {
      this.moveBindAttempts += 1;
      if (this.moveBindAttempts >= 30) {
        print('[LeaderboardGrab] could not bind grab interaction');
        return;
      }
      this.scheduleGrabWireRetry(0.1);
      return;
    }

    const collider = this.refreshGrabCollider();
    this.bindManipulationRoot(manipulation, this.getSceneObject());
    const onGrabStart = (): void => {
      this.onLeaderboardGrabStart();
    };
    const onGrabRelease = (): void => {
      this.onLeaderboardGrabRelease();
    };

    if (manipulation.onManipulationStart) {
      manipulation.onManipulationStart.add(onGrabStart);
    }
    if (manipulation.onManipulationEnd) {
      manipulation.onManipulationEnd.add(onGrabRelease);
    }
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
      interactable.onDragEnd.add(onGrabRelease);
    }
    if (interactable.onTriggerEnd) {
      interactable.onTriggerEnd.add(onGrabRelease);
    }
    if (interactable.onTriggerEndOutside) {
      interactable.onTriggerEndOutside.add(onGrabRelease);
    }
    if (interactable.onTriggerCanceled) {
      interactable.onTriggerCanceled.add(onGrabRelease);
    }
    if (interactable.onInteractorTriggerEnd) {
      interactable.onInteractorTriggerEnd.add(onGrabRelease);
    }
    if (interactable.onInteractorTriggerEndOutside) {
      interactable.onInteractorTriggerEndOutside.add(onGrabRelease);
    }

    (manipulation as ScriptComponent).enabled = true;
    (interactable as ScriptComponent).enabled = true;
    this.moveInteractionWired = true;
    print(
      `[LeaderboardGrab] grab interaction wired targetMode=${interactable.targetingMode} collider=${!isNull(collider)}`
    );
  }

  private onLeaderboardGrabStart(): void {
    if (this.moveActive) {
      return;
    }
    this.moveActive = true;
    print(
      `[LeaderboardGrab] grab start at ${this.getSceneObject()
        .getTransform()
        .getWorldPosition()
        .toString()}`
    );
    const handler = this.getAnchorHandler();
    if (!isNull(handler) && typeof handler.setActiveManipulatedRoot === 'function') {
      handler.setActiveManipulatedRoot(this.getSceneObject());
    }
  }

  private onLeaderboardGrabRelease(): void {
    if (!this.moveActive) {
      return;
    }
    this.moveActive = false;
    print(
      `[LeaderboardGrab] grab release at ${this.getSceneObject()
        .getTransform()
        .getWorldPosition()
        .toString()}`
    );
    const handler = this.getAnchorHandler();
    if (!isNull(handler)) {
      if (typeof handler.setActiveManipulatedRoot === 'function') {
        handler.setActiveManipulatedRoot(null);
      }
      if (typeof handler.persistGardenSourceTransform === 'function') {
        handler.persistGardenSourceTransform(LeaderboardGrab.ANCHOR_SOURCE_NAME);
      }
    }
  }

  private refreshGrabCollider(): ColliderComponent | null {
    const anchor = this.getSceneObject();
    let collider = anchor.getComponent('Physics.ColliderComponent') as ColliderComponent;
    if (isNull(collider)) {
      collider = anchor.getComponent('Component.ColliderComponent') as ColliderComponent;
    }
    if (isNull(collider)) {
      collider = anchor.createComponent('Physics.ColliderComponent') as ColliderComponent;
    }
    if (isNull(collider)) {
      collider = anchor.createComponent('Component.ColliderComponent') as ColliderComponent;
    }
    if (isNull(collider)) {
      return null;
    }

    const colliderLike = collider as unknown as {
      enabled?: boolean;
      intangible?: boolean;
      forceCompound?: boolean;
      fitVisual?: boolean;
      debugDrawEnabled?: boolean;
      shape?: unknown;
    };
    const boxShape = Shape.createBoxShape();
    colliderLike.enabled = true;
    colliderLike.shape = boxShape;
    colliderLike.fitVisual = false;
    colliderLike.intangible = false;
    colliderLike.forceCompound = false;
    colliderLike.debugDrawEnabled = false;

    const desired = this.colliderSize;
    const min = LeaderboardGrab.MIN_COLLIDER_SIZE;
    boxShape.size = new vec3(
      Math.max(min.x, desired.x),
      Math.max(min.y, desired.y),
      Math.max(min.z, desired.z)
    );
    return collider;
  }

  private bindManipulationRoot(
    manipulation: InteractableManipulationLike,
    anchor: SceneObject
  ): void {
    manipulation.manipulateRootSceneObject = anchor;

    const manipulationRecord = manipulation as unknown as Record<string, unknown>;
    const setRoot = manipulationRecord['setManipulateRoot'];
    if (typeof setRoot === 'function') {
      (setRoot as (this: unknown, root: Transform) => void).call(
        manipulation,
        anchor.getTransform()
      );
      return;
    }

    // Re-toggle after assigning the root so SIK refreshes its cached target.
    const component = manipulation as ScriptComponent;
    const wasEnabled = component.enabled;
    component.enabled = false;
    component.enabled = wasEnabled;
  }
}

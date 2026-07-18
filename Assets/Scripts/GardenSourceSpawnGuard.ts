const moveActiveRoots: SceneObject[] = [];
const hoveredMoveHandleRoots: SceneObject[] = [];

export const GARDEN_SOURCE_MOVE_HANDLE_NAME = 'MoveHandle';

type InteractorHitLike = {
  targetHitPosition?: vec3 | null;
};

export function setGardenSourceMoveHandleActive(
  sourceRoot: SceneObject | null,
  active: boolean
): void {
  if (isNull(sourceRoot)) {
    return;
  }

  setRootFlag(moveActiveRoots, sourceRoot, active);
}

export function setGardenSourceMoveHandleHovered(
  sourceRoot: SceneObject | null,
  hovered: boolean
): void {
  if (isNull(sourceRoot)) {
    return;
  }

  setRootFlag(hoveredMoveHandleRoots, sourceRoot, hovered);
}

export function isGardenSourceSpawnBlocked(sourceRoot: SceneObject | null): boolean {
  if (isNull(sourceRoot)) {
    return false;
  }

  return hasRootFlag(moveActiveRoots, sourceRoot);
}

export function isMoveHandleSceneObject(candidate: SceneObject | null): boolean {
  if (isNull(candidate)) {
    return false;
  }

  return String(candidate.name || '') === GARDEN_SOURCE_MOVE_HANDLE_NAME;
}

export function isUnderMoveHandle(candidate: SceneObject | null): boolean {
  let current = candidate;
  while (!isNull(current)) {
    if (isMoveHandleSceneObject(current)) {
      return true;
    }
    current = current.getParent();
  }

  return false;
}

export function findMoveHandleChild(sourceRoot: SceneObject | null): SceneObject | null {
  if (isNull(sourceRoot)) {
    return null;
  }

  const count = sourceRoot.getChildrenCount();
  for (let i = 0; i < count; i++) {
    const child = sourceRoot.getChild(i);
    if (!isNull(child) && isMoveHandleSceneObject(child)) {
      return child;
    }
  }

  return null;
}

export function isInteractorNearMoveHandle(
  _sourceRoot: SceneObject | null,
  _interactor: InteractorHitLike | null
): boolean {
  return false;
}

export function scheduleGardenSourceSpawn(
  host: ScriptComponent,
  sourceRoot: SceneObject,
  isBlocked: () => boolean,
  spawn: () => void
): void {
  const deferred = host.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
  deferred.bind(() => {
    if (isBlocked() || isGardenSourceSpawnBlocked(sourceRoot)) {
      return;
    }

    spawn();
  });
  deferred.reset(0);
}

function setRootFlag(list: SceneObject[], root: SceneObject, enabled: boolean): void {
  const index = list.indexOf(root);
  if (enabled) {
    if (index < 0) {
      list.push(root);
    }
    return;
  }

  if (index >= 0) {
    list.splice(index, 1);
  }
}

function hasRootFlag(list: SceneObject[], root: SceneObject): boolean {
  for (let i = 0; i < list.length; i++) {
    if (list[i] === root) {
      return true;
    }
  }

  return false;
}

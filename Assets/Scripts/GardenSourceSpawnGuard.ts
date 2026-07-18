const moveActiveRoots: SceneObject[] = [];
const hoveredMoveHandleRoots: SceneObject[] = [];
const spawnPullActiveRoots: SceneObject[] = [];

export const GARDEN_SOURCE_MOVE_HANDLE_NAME = 'MoveHandle';
const MOVE_HANDLE_SPAWN_BLOCK_RADIUS_CM = 4;
const DEFAULT_STARTUP_SPAWN_BLOCK_SECONDS = 3;
let startupSpawnBlockedUntil = 0;

export function armGardenSourceStartupSpawnBlock(
  seconds = DEFAULT_STARTUP_SPAWN_BLOCK_SECONDS
): void {
  startupSpawnBlockedUntil = getTime() + Math.max(0, seconds);
}

type InteractorHitLike = {
  targetHitPosition?: vec3 | null;
  startPoint?: vec3 | null;
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

export function shouldBlockGardenSourceSpawn(
  sourceRoot: SceneObject | null,
  interactor: InteractorHitLike | null,
  spawnSuppressed: boolean
): boolean {
  if (getTime() < startupSpawnBlockedUntil) {
    return true;
  }

  if (spawnSuppressed) {
    return true;
  }

  if (isNull(sourceRoot)) {
    return false;
  }

  if (
    isGardenSourceSpawnBlocked(sourceRoot) ||
    isGardenSourceMoveHandleHovered(sourceRoot) ||
    isInteractorNearMoveHandle(sourceRoot, interactor)
  ) {
    return true;
  }

  return false;
}

export function isGardenSourceMoveHandleHovered(sourceRoot: SceneObject | null): boolean {
  if (isNull(sourceRoot)) {
    return false;
  }

  return hasRootFlag(hoveredMoveHandleRoots, sourceRoot);
}

export function setGardenSourceSpawnPullActive(
  sourceRoot: SceneObject | null,
  active: boolean
): void {
  if (isNull(sourceRoot)) {
    return;
  }

  setRootFlag(spawnPullActiveRoots, sourceRoot, active);
}

export function isAnyGardenSourceSpawnPullActive(): boolean {
  return spawnPullActiveRoots.length > 0;
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
  sourceRoot: SceneObject | null,
  interactor: InteractorHitLike | null
): boolean {
  if (isNull(sourceRoot)) {
    return false;
  }

  const handle = findMoveHandleChild(sourceRoot);
  if (isNull(handle)) {
    return false;
  }

  const handlePos = handle.getTransform().getWorldPosition();
  const blockRadius = getMoveHandleBlockRadiusWorld(handle);
  const hitPosition = interactor?.targetHitPosition;
  if (!isNull(hitPosition) && hitPosition.distance(handlePos) <= blockRadius) {
    return true;
  }

  return false;
}

function getMoveHandleBlockRadiusWorld(handle: SceneObject): number {
  const worldScale = handle.getTransform().getWorldScale();
  const scale = Math.max(worldScale.x, worldScale.y, worldScale.z);
  let shapeRadius = 0;

  const colliders = handle.getComponents('Component.ColliderComponent');
  for (let i = 0; i < colliders.length; i++) {
    const shape = (colliders[i] as unknown as {
      shape?: { radius?: number; FitVisual?: boolean };
    }).shape;
    if (shape?.radius && shape.radius > 0) {
      shapeRadius = Math.max(shapeRadius, shape.radius * scale);
    }
  }

  if (shapeRadius > 0) {
    return Math.min(MOVE_HANDLE_SPAWN_BLOCK_RADIUS_CM, shapeRadius);
  }

  return MOVE_HANDLE_SPAWN_BLOCK_RADIUS_CM;
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

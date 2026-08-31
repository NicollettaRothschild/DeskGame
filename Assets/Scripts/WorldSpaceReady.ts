/**
 * Spectacles 2024 world tracking is rotation-only for a short time after
 * Lens start. Camera-relative placement and LookAt during that window glue
 * companions to the headset until VIO localizes.
 *
 * Do not recurse the full scene graph here — Spectacles Interaction Kit is
 * deep enough that a recursive camera search can crash the Lens.
 */

const MIN_DEVICE_READY_SEC = 0.85;
const MAX_DEVICE_WAIT_SEC = 2.2;

let worldReadyFlag = false;
let worldReadyArmed = false;
let worldReadyPending: Array<() => void> = [];
let worldReadyHost: ScriptComponent | null = null;

export function isEditorRuntime(): boolean {
  try {
    const deviceInfo = (
      global as unknown as {
        deviceInfoSystem?: { isEditor?: () => boolean };
      }
    ).deviceInfoSystem;
    return (
      !!deviceInfo &&
      typeof deviceInfo.isEditor === 'function' &&
      !!deviceInfo.isEditor()
    );
  } catch (_error) {
    return false;
  }
}

export function cameraHasWorldDeviceTracking(
  camera: SceneObject | null
): boolean {
  if (isNull(camera)) {
    return false;
  }
  try {
    const tracking = camera.getComponent('Component.DeviceTracking') as unknown as {
      getDeviceTrackingMode?: () => unknown;
    };
    if (isNull(tracking) || typeof tracking.getDeviceTrackingMode !== 'function') {
      return false;
    }
    const modeText = String(tracking.getDeviceTrackingMode());
    return (
      modeText.indexOf('World') >= 0 || modeText === '2' || modeText === '3'
    );
  } catch (_error) {
    return false;
  }
}

/** True once Spectacles 2024 world tracking has had time to localize. */
export function isWorldSpaceReady(
  minDeviceSec: number = MIN_DEVICE_READY_SEC
): boolean {
  if (isEditorRuntime()) {
    return true;
  }
  if (getTime() >= MAX_DEVICE_WAIT_SEC) {
    return true;
  }
  return worldReadyFlag && getTime() >= minDeviceSec;
}

export function whenWorldSpaceReady(
  host: ScriptComponent,
  callback: () => void
): void {
  if (isEditorRuntime() || isWorldSpaceReady()) {
    callback();
    return;
  }
  worldReadyPending.push(callback);
  armWorldSpaceReady(host);
}

function armWorldSpaceReady(host: ScriptComponent): void {
  if (worldReadyArmed) {
    return;
  }
  worldReadyArmed = true;
  worldReadyHost = host;

  const timeout = host.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
  timeout.bind(() => {
    markWorldSpaceReady('timeout');
  });
  timeout.reset(MAX_DEVICE_WAIT_SEC);
}

function markWorldSpaceReady(reason: string): void {
  if (worldReadyFlag) {
    return;
  }
  worldReadyFlag = true;
  print(
    `[WorldSpaceReady] world space ready (${reason}) t=${getTime().toFixed(2)}`
  );
  flushWorldReadyCallbacks();
}

function flushWorldReadyCallbacks(): void {
  const host = worldReadyHost;
  const runNext = (): void => {
    if (worldReadyPending.length === 0) {
      return;
    }
    const callback = worldReadyPending.shift();
    if (callback) {
      try {
        callback();
      } catch (_error) {
        // Keep remaining companions scheduled if one callback throws.
      }
    }
    if (worldReadyPending.length === 0 || isNull(host)) {
      return;
    }
    const next = host.createEvent('DelayedCallbackEvent') as DelayedCallbackEvent;
    next.bind(runNext);
    next.reset(0.05);
  };
  runNext();
}

export function pickWorldTrackedCamera(
  candidates: Array<SceneObject | null>
): SceneObject | null {
  let namedWorld: SceneObject | null = null;
  let worldFallback: SceneObject | null = null;
  let anyFallback: SceneObject | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const camera = candidates[i];
    if (isNull(camera)) {
      continue;
    }
    if (cameraHasWorldDeviceTracking(camera)) {
      const name = String(camera.name || '');
      if (
        isNull(namedWorld) &&
        (name === 'Camera Object' || name === 'Device Camera')
      ) {
        namedWorld = camera;
      } else if (isNull(worldFallback)) {
        worldFallback = camera;
      }
    } else if (isNull(anyFallback)) {
      anyFallback = camera;
    }
  }
  if (!isNull(namedWorld)) {
    return namedWorld;
  }
  if (!isNull(worldFallback)) {
    return worldFallback;
  }
  return anyFallback;
}

/** Root objects only — never recurse into Spectacles Interaction Kit. */
export function findRootObjectByName(name: string): SceneObject | null {
  try {
    const count = global.scene.getRootObjectsCount();
    for (let i = 0; i < count; i++) {
      const root = global.scene.getRootObject(i);
      if (!isNull(root) && String(root.name || '') === name) {
        return root;
      }
    }
  } catch (_error) {
    return null;
  }
  return null;
}

export function pickPreferredWorldCamera(
  extraCandidates: Array<SceneObject | null>
): SceneObject | null {
  const cameras = extraCandidates.slice();
  cameras.push(findRootObjectByName('Camera Object'));
  cameras.push(findRootObjectByName('Device Camera'));
  return pickWorldTrackedCamera(cameras);
}

/** Horizontal look on XZ. Lens Studio cameras look down -Z. */
export function getCameraForwardXZ(
  camera: SceneObject | null
): { x: number; z: number } | null {
  if (isNull(camera)) {
    return null;
  }
  try {
    const forward = camera.getTransform().forward;
    if (isNull(forward)) {
      return { x: 0, z: -1 };
    }
    let forwardX = forward.x;
    let forwardZ = forward.z;
    const length = Math.sqrt(forwardX * forwardX + forwardZ * forwardZ);
    if (length < 0.001) {
      return { x: 0, z: -1 };
    }
    return { x: forwardX / length, z: forwardZ / length };
  } catch (_error) {
    return null;
  }
}

/**
 * World position in front of the tracked camera. Same pattern as
 * DeskGame pot/note instantiate + boss-fight `prefab.instantiate`.
 */
export function getPositionInFrontOfCamera(
  camera: SceneObject | null,
  distanceCm: number,
  heightOffsetCm: number,
  sideCm: number = 0
): vec3 | null {
  if (isNull(camera)) {
    return null;
  }
  const look = getCameraForwardXZ(camera);
  if (look === null) {
    return null;
  }
  try {
    const cameraPos = camera.getTransform().getWorldPosition();
    const rightX = -look.z;
    const rightZ = look.x;
    return new vec3(
      cameraPos.x + look.x * distanceCm + rightX * sideCm,
      cameraPos.y + heightOffsetCm,
      cameraPos.z + look.z * distanceCm + rightZ * sideCm
    );
  } catch (_error) {
    return null;
  }
}

/** Disable LookAtComponent on a spawned companion grab root only — never walk SIK. */
export function stripLookAtOnTree(root: SceneObject | null): void {
  if (isNull(root)) {
    return;
  }
  try {
    const lookAt = root.getComponent(
      'Component.LookAtComponent'
    ) as LookAtComponent;
    if (!isNull(lookAt)) {
      lookAt.enabled = false;
    }
  } catch (_error) {
    // Missing LookAt is expected.
  }
}

export function setSceneObjectVisualsEnabled(
  root: SceneObject | null,
  visible: boolean
): void {
  if (isNull(root)) {
    return;
  }
  root.enabled = true;
  const stack: SceneObject[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isNull(node)) {
      continue;
    }
    const visuals = node.getComponents(
      'Component.RenderMeshVisual'
    ) as RenderMeshVisual[];
    for (let i = 0; i < visuals.length; i++) {
      if (!isNull(visuals[i])) {
        visuals[i].enabled = visible;
      }
    }
    const texts = node.getComponents('Component.Text3D') as Text3D[];
    for (let i = 0; i < texts.length; i++) {
      if (!isNull(texts[i])) {
        texts[i].enabled = visible;
      }
    }
    for (let i = 0; i < node.getChildrenCount(); i++) {
      stack.push(node.getChild(i));
    }
  }
}

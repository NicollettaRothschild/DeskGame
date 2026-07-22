import { registerPreDestroyHook } from './FlowGardenDestroyHooks';

type WateringObjectLike = ScriptComponent & {
  beginUnusedLifetime?: () => void;
  waterPlant?: (plant: unknown) => void;
};

let splashPrefab: ObjectPrefab | null = null;
let spawnParent: SceneObject | null = null;
let effectLifetime = 1.2;
let burstIntensity = 0.55;
let maxParticles = 1000;
let debugLogging = false;
let ready = false;
let hookRegistered = false;

export function configureWaterSplashVfx(
  prefab: ObjectPrefab,
  parent: SceneObject | null = null,
  lifetime = 1.2,
  intensity = 0.55,
  particleCount = 1000,
  logging = false
): void {
  splashPrefab = prefab;
  spawnParent = parent;
  effectLifetime = Math.max(0.2, lifetime);
  burstIntensity = Math.max(0.05, Math.min(1, intensity));
  maxParticles = Math.max(1, Math.floor(particleCount));
  debugLogging = logging;
  ready = !isNull(splashPrefab);
  ensureDestroyHookRegistered();
  debugLog(`ready=${ready}`);
}

export function playWaterSplashVfx(worldPosition: vec3): void {
  if (!ready || isNull(splashPrefab)) {
    debugLog('skip: splash prefab not configured');
    return;
  }

  const parent = resolveSplashParent();
  const splashRoot = splashPrefab!.instantiate(parent);
  if (isNull(splashRoot)) {
    debugLog('skip: instantiate failed');
    return;
  }

  splashRoot.getTransform().setWorldPosition(worldPosition);
  applyBurstSettings(splashRoot);
  debugLog(`play at ${worldPosition.x.toFixed(1)}, ${worldPosition.y.toFixed(1)}, ${worldPosition.z.toFixed(1)}`);
}

export function isWaterDropletRoot(root: SceneObject): boolean {
  if (isNull(root)) {
    return false;
  }

  return containsWaterDropletMarker(root);
}

function containsWaterDropletMarker(root: SceneObject): boolean {
  const stack: SceneObject[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || isNull(current)) {
      continue;
    }

    const scripts = current.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as WateringObjectLike;
      if (
        !isNull(candidate) &&
        typeof candidate.beginUnusedLifetime === 'function' &&
        typeof candidate.waterPlant === 'function'
      ) {
        return true;
      }
    }

    const name = current.name.toLowerCase();
    if (name === 'wateringobject' || name === 'water object') {
      return true;
    }

    for (let i = 0; i < current.getChildrenCount(); i++) {
      stack.push(current.getChild(i));
    }
  }

  return false;
}

function applyBurstSettings(root: SceneObject): void {
  const stack: SceneObject[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || isNull(current)) {
      continue;
    }

    const scripts = current.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i] as unknown as {
        configureBurst?: (lifetime: number, intensity: number, maxCount: number) => void;
      };
      if (!isNull(script) && typeof script.configureBurst === 'function') {
        script.configureBurst(effectLifetime, burstIntensity, maxParticles);
      }
    }

    for (let i = 0; i < current.getChildrenCount(); i++) {
      stack.push(current.getChild(i));
    }
  }
}

function ensureDestroyHookRegistered(): void {
  if (hookRegistered) {
    return;
  }

  hookRegistered = true;
  registerPreDestroyHook((root) => {
    if (!isWaterDropletRoot(root)) {
      return;
    }
    playWaterSplashVfx(root.getTransform().getWorldPosition());
  });
}

function resolveSplashParent(): SceneObject {
  if (!isNull(spawnParent)) {
    return spawnParent;
  }

  const rootCount = global.scene.getRootObjectsCount();
  if (rootCount > 0) {
    return global.scene.getRootObject(0);
  }

  return global.scene.createSceneObject('WaterSplashRoot');
}

function debugLog(message: string): void {
  if (!debugLogging) {
    return;
  }
  print(`[WaterSplashVfx] ${message}`);
}

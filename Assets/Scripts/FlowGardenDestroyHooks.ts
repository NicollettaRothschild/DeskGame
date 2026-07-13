type DestroyHook = (root: SceneObject) => void;

const preDestroyHooks: DestroyHook[] = [];

type InteractionScriptLike = ScriptComponent & {
  manipulateRootSceneObject?: SceneObject;
  targetingMode?: unknown;
  onTriggerStart?: unknown;
  onPinchUp_Select?: unknown[];
};

export function registerPreDestroyHook(hook: DestroyHook): void {
  preDestroyHooks.push(hook);
}

export function runPreDestroyHooks(root: SceneObject): void {
  for (let i = 0; i < preDestroyHooks.length; i++) {
    try {
      preDestroyHooks[i](root);
    } catch {
      // Ignore hook failures during teardown.
    }
  }
}

function isInteractionScript(script: ScriptComponent): boolean {
  const candidate = script as unknown as InteractionScriptLike;
  if (candidate.manipulateRootSceneObject !== undefined) {
    return true;
  }
  if (candidate.targetingMode !== undefined && candidate.onTriggerStart !== undefined) {
    return true;
  }
  return Array.isArray(candidate.onPinchUp_Select);
}

export function disableInteractionOnHierarchy(root: SceneObject): void {
  if (isNull(root)) {
    return;
  }

  const stack: SceneObject[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || isNull(current)) {
      continue;
    }

    const scripts = current.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i];
      if (isNull(script) || !isInteractionScript(script)) {
        continue;
      }
      script.enabled = false;
    }

    for (let i = 0; i < current.getChildrenCount(); i++) {
      stack.push(current.getChild(i));
    }
  }
}

export function hideSceneObjectHierarchy(root: SceneObject): void {
  if (isNull(root)) {
    return;
  }

  const stack: SceneObject[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || isNull(current)) {
      continue;
    }

    current.enabled = false;
    for (let i = 0; i < current.getChildrenCount(); i++) {
      stack.push(current.getChild(i));
    }
  }
}

export function prepareSceneObjectForDestroy(root: SceneObject): void {
  if (isNull(root)) {
    return;
  }

  runPreDestroyHooks(root);
  hideSceneObjectHierarchy(root);
  disableInteractionOnHierarchy(root);
}

export function scheduleDeferredDestroy(
  host: ScriptComponent,
  root: SceneObject,
  onDestroyed: () => void,
  delaySec = 0.15
): void {
  if (isNull(root)) {
    onDestroyed();
    return;
  }

  prepareSceneObjectForDestroy(root);
  const ref = root;
  const delayed = host.createEvent('DelayedCallbackEvent');
  delayed.bind(() => {
    if (!isNull(ref)) {
      ref.destroy();
    }
    onDestroyed();
  });
  delayed.reset(delaySec);
}

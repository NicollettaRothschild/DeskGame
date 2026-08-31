const GARDEN_SOURCE_NAMES = ['Planter', 'PostItNotes', 'TrashBin'];
const MOVE_HANDLE_NAME = 'MoveHandle';
const TRASH_BIN_NAME = 'TrashBin';
// Planter corner handle ~7cm on each axis → ~10cm Euclidean from pivot; trash matches that.
const MAX_TRASH_HANDLE_DISTANCE_CM = 12;

/**
 * Verifies garden source move handles are present, wired, and visible in preview.
 */
@component
export class GardenMoveHandleE2EHarness extends BaseScriptComponent {
  @input
  runHarness: boolean = false;

  @input
  startupDelaySec: number = 1.5;

  @input
  runOnce: boolean = true;

  private ran = false;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => {
      this.scheduleAttempt(0);
    });
  }

  private scheduleAttempt(attempt: number): void {
    if (!this.runHarness) {
      return;
    }
    if (this.runOnce && this.ran) {
      return;
    }

    if (attempt === 0) {
      const delay = this.createEvent('DelayedCallbackEvent');
      delay.bind(() => this.scheduleAttempt(1));
      delay.reset(Math.max(0.5, this.startupDelaySec));
      return;
    }

    this.ran = true;
    const failures: string[] = [];

    for (let i = 0; i < GARDEN_SOURCE_NAMES.length; i++) {
      const sourceName = GARDEN_SOURCE_NAMES[i];
      const source = this.findSceneObjectByName(sourceName);
      if (isNull(source)) {
        failures.push(`${sourceName}: source missing`);
        continue;
      }

      const handle = this.findNamedChild(source, MOVE_HANDLE_NAME);
      if (isNull(handle)) {
        failures.push(`${sourceName}: MoveHandle missing`);
        continue;
      }

      if (!handle.enabled) {
        failures.push(`${sourceName}: MoveHandle disabled`);
      }

      const wired = this.hasMoveHandleScript(handle);
      if (!wired) {
        failures.push(`${sourceName}: GardenSourceMoveHandle script missing`);
      }

      if (sourceName === TRASH_BIN_NAME) {
        failures.push(...this.verifyTrashHandle(source, handle));
      }
    }

    if (failures.length === 0) {
      print('[GardenMoveHandleE2E] PASS all garden source move handles wired');
      return;
    }

    print(`[GardenMoveHandleE2E] FAIL ${failures.join('; ')}`);
  }

  private verifyTrashHandle(source: SceneObject, handle: SceneObject): string[] {
    const failures: string[] = [];
    const trashPos = source.getTransform().getWorldPosition();
    const handlePos = handle.getTransform().getWorldPosition();
    const distance = trashPos.distance(handlePos);
    if (distance > MAX_TRASH_HANDLE_DISTANCE_CM) {
      failures.push(
        `TrashBin: handle too far from bin (${distance.toFixed(2)}cm > ${MAX_TRASH_HANDLE_DISTANCE_CM}cm)`
      );
    }

    const manipulationRoot = this.getHandleManipulationRoot(handle);
    if (isNull(manipulationRoot)) {
      failures.push('TrashBin: InteractableManipulation missing');
    } else if (manipulationRoot !== source) {
      failures.push(`TrashBin: manipulation root is ${manipulationRoot.name}, expected TrashBin`);
    }

    print(
      `[GardenMoveHandleE2E] TrashBin handle dist=${distance.toFixed(2)} trash=${trashPos.toString()} handle=${handlePos.toString()}`
    );
    return failures;
  }

  private getHandleManipulationRoot(handle: SceneObject): SceneObject | null {
    const scripts = handle.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as ScriptComponent & {
        manipulateRootSceneObject?: SceneObject;
      };
      if (!isNull(candidate) && !isNull(candidate.manipulateRootSceneObject)) {
        return candidate.manipulateRootSceneObject;
      }
    }
    return null;
  }

  private hasMoveHandleScript(handle: SceneObject): boolean {
    const scripts = handle.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i] as ScriptComponent & {
        wireMoveInteraction?: () => void;
      };
      if (!isNull(script) && typeof script.wireMoveInteraction === 'function') {
        return true;
      }
    }
    return false;
  }

  private findSceneObjectByName(name: string): SceneObject | null {
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      const match = this.findSceneObjectByNameRecursive(global.scene.getRootObject(i), name);
      if (!isNull(match)) {
        return match;
      }
    }
    return null;
  }

  private findSceneObjectByNameRecursive(root: SceneObject, name: string): SceneObject | null {
    if (String(root.name || '') === name) {
      return root;
    }

    const count = root.getChildrenCount();
    for (let i = 0; i < count; i++) {
      const child = root.getChild(i);
      const match = this.findSceneObjectByNameRecursive(child, name);
      if (!isNull(match)) {
        return match;
      }
    }

    return null;
  }

  private findNamedChild(root: SceneObject, name: string): SceneObject | null {
    const count = root.getChildrenCount();
    for (let i = 0; i < count; i++) {
      const child = root.getChild(i);
      if (!isNull(child) && String(child.name || '') === name) {
        return child;
      }
    }
    return null;
  }
}

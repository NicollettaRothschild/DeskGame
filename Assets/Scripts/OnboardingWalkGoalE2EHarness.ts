import { PlantLifecycle, PlantStage } from './PlantLifecycle';

type AnchorControllerLike = {
  createGoalPlantedPotAtWorldPosition?: (goalText: string, worldPos: vec3) => SceneObject | null;
};

/**
 * End-to-end harness: place tour props, spawn a walk-20m goal plant, water it,
 * simulate walking 20 meters, assert the plant reaches Adult.
 */
@component
export class OnboardingWalkGoalE2EHarness extends BaseScriptComponent {
  @input
  runHarness: boolean = false;

  @input
  startupDelaySec: number = 2.0;

  @input
  runOnce: boolean = true;

  @input
  goalText: string = 'I want to walk 20 meters';

  @input
  walkMeters: number = 20;

  @input
  fastGrowthTimeSec: number = 1.5;

  @input
  placeTourObjects: boolean = true;

  @input
  seedSettleSec: number = 0.7;

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
    this.runE2E();
  }

  private runE2E(): void {
    print('[OnboardingWalkGoalE2E] START');
    const failures: string[] = [];

    // Avoid Friend onboarding TTS/practice fighting the harness.
    this.disableFriendOnboarding();

    const tourNames = ['Globe', 'Clock', 'palette', 'PostItNotes', 'TrashBin'];
    if (this.placeTourObjects) {
      for (let i = 0; i < tourNames.length; i++) {
        const obj = this.findSceneObjectByName(tourNames[i]);
        if (isNull(obj)) {
          failures.push(`tour object missing: ${tourNames[i]}`);
          continue;
        }
        obj.enabled = true;
        const t = obj.getTransform();
        const pos = t.getWorldPosition();
        // Place slightly apart so onboarding "placement" is exercised.
        t.setWorldPosition(new vec3(pos.x + i * 8, pos.y, pos.z - 10));
        print(`[OnboardingWalkGoalE2E] placed ${tourNames[i]}`);
      }
    }

    const parsed = PlantLifecycle.parseWalkGoalMeters(this.goalText);
    if (Math.abs(parsed - this.walkMeters) > 0.01) {
      failures.push(
        `parseWalkGoalMeters("${this.goalText}")=${parsed}, expected ${this.walkMeters}`
      );
    } else {
      print(`[OnboardingWalkGoalE2E] parsed walk goal ${parsed}m`);
    }

    const anchor = this.findAnchorController();
    if (isNull(anchor) || typeof anchor.createGoalPlantedPotAtWorldPosition !== 'function') {
      failures.push('AnchorController.createGoalPlantedPotAtWorldPosition missing');
      print(`[OnboardingWalkGoalE2E] FAIL ${failures.join('; ')}`);
      return;
    }

    const camera = this.findCameraObject();
    const spawnPos = !isNull(camera)
      ? camera.getTransform().getWorldPosition().add(new vec3(0, -20, -60))
      : new vec3(0, -20, -80);

    const pot = anchor.createGoalPlantedPotAtWorldPosition(this.goalText, spawnPos);
    if (isNull(pot)) {
      failures.push('goal planted pot spawn failed');
      print(`[OnboardingWalkGoalE2E] FAIL ${failures.join('; ')}`);
      return;
    }
    print(`[OnboardingWalkGoalE2E] spawned goal pot ${pot.name}`);

    const plant = this.findPlantLifecycleUnder(pot);
    if (isNull(plant)) {
      failures.push('PlantLifecycle missing under goal pot');
      print(`[OnboardingWalkGoalE2E] FAIL ${failures.join('; ')}`);
      return;
    }

    if (!(plant.getWalkGoalMeters() > 0)) {
      failures.push(`walk goal not armed on plant (got ${plant.getWalkGoalMeters()})`);
    }

    // Speed up growth so the pause/cap is reachable quickly in preview.
    plant.setGrowthTimeForTests(Math.max(0.4, this.fastGrowthTimeSec));

    const watered = plant.water();
    if (!watered) {
      failures.push('water() failed on goal plant');
    } else {
      print('[OnboardingWalkGoalE2E] watered goal plant');
    }

    const waitGrow = this.createEvent('DelayedCallbackEvent');
    waitGrow.bind(() => {
      this.waitUntilGrowingOrTimeout(plant, failures, 0, 12);
    });
    waitGrow.reset(Math.max(0.6, this.seedSettleSec));
  }

  private waitUntilGrowingOrTimeout(
    plant: PlantLifecycle,
    failures: string[],
    attempt: number,
    maxAttempts: number
  ): void {
    const stage = plant.getCurrentStage();
    if (
      stage === PlantStage.Growing ||
      stage === PlantStage.WateredBaby ||
      stage === PlantStage.Adult
    ) {
      this.afterGrowthPause(plant, failures);
      return;
    }
    if (attempt >= maxAttempts) {
      print(
        `[OnboardingWalkGoalE2E] growth wait timed out at stage=${stage} — continuing`
      );
      this.afterGrowthPause(plant, failures);
      return;
    }
    const retry = this.createEvent('DelayedCallbackEvent');
    retry.bind(() => this.waitUntilGrowingOrTimeout(plant, failures, attempt + 1, maxAttempts));
    retry.reset(0.2);
  }

  private afterGrowthPause(plant: PlantLifecycle, failures: string[]): void {
    const stageBefore = plant.getCurrentStage();
    if (stageBefore === PlantStage.Adult) {
      failures.push('plant reached Adult before walk completed');
    } else {
      print(`[OnboardingWalkGoalE2E] pre-walk stage=${stageBefore} (expect Growing/paused)`);
    }

    // Prefer real camera motion; fall back to inject if tracking overwrites motion.
    const camera = this.findCameraObject();
    let usedInject = false;
    if (!isNull(camera)) {
      const t = camera.getTransform();
      const start = t.getWorldPosition();
      // 20 meters = 2000 cm world units. Move in one big hop; tracker samples horizontal delta.
      t.setWorldPosition(new vec3(start.x + 2000, start.y, start.z));
      print('[OnboardingWalkGoalE2E] moved Camera Object +2000cm');
    }

    const settle = this.createEvent('DelayedCallbackEvent');
    settle.bind(() => {
      if (plant.requiresGoal() && plant.getWalkedMeters() + 0.05 < this.walkMeters) {
        usedInject = true;
        print(
          `[OnboardingWalkGoalE2E] camera walk insufficient (${plant.getWalkedMeters().toFixed(2)}m) — injecting`
        );
        plant.addWalkedMeters(this.walkMeters);
      }

      const verify = this.createEvent('DelayedCallbackEvent');
      verify.bind(() => {
        this.verifyResult(plant, failures, usedInject);
      });
      verify.reset(0.35);
    });
    settle.reset(0.25);
  }

  private verifyResult(plant: PlantLifecycle, failures: string[], usedInject: boolean): void {
    if (!plant.isGoalCompleted()) {
      failures.push(
        `goal not completed after walk (walked=${plant.getWalkedMeters().toFixed(2)} target=${plant.getWalkGoalMeters().toFixed(2)})`
      );
    }
    if (plant.getCurrentStage() !== PlantStage.Adult) {
      failures.push(`plant stage=${plant.getCurrentStage()} expected Adult=${PlantStage.Adult}`);
    }

    if (failures.length === 0) {
      print(
        `[OnboardingWalkGoalE2E] PASS walk=${this.walkMeters}m inject=${usedInject} stage=Adult goal="${plant.getGoalText()}"`
      );
      return;
    }
    print(`[OnboardingWalkGoalE2E] FAIL ${failures.join('; ')}`);
  }

  private disableFriendOnboarding(): void {
    const friend = this.findSceneObjectByName('friend');
    if (isNull(friend)) {
      return;
    }
    const scripts = friend.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as ScriptComponent & {enableOnboarding?: boolean};
      if (!isNull(candidate) && typeof candidate.enableOnboarding === 'boolean') {
        candidate.enableOnboarding = false;
        print('[OnboardingWalkGoalE2E] disabled Friend onboarding for harness');
      }
    }
  }

  private findAnchorController(): AnchorControllerLike | null {
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      const found = this.findAnchorRecursive(global.scene.getRootObject(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findAnchorRecursive(node: SceneObject): AnchorControllerLike | null {
    const scripts = node.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as ScriptComponent & AnchorControllerLike;
      if (
        !isNull(candidate) &&
        typeof candidate.createGoalPlantedPotAtWorldPosition === 'function'
      ) {
        return candidate;
      }
    }
    const count = node.getChildrenCount();
    for (let i = 0; i < count; i++) {
      const found = this.findAnchorRecursive(node.getChild(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findPlantLifecycleUnder(root: SceneObject): PlantLifecycle | null {
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as PlantLifecycle;
      if (!isNull(candidate) && typeof candidate.bindGoal === 'function' && typeof candidate.water === 'function') {
        return candidate;
      }
    }
    const count = root.getChildrenCount();
    for (let i = 0; i < count; i++) {
      const found = this.findPlantLifecycleUnder(root.getChild(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findCameraObject(): SceneObject | null {
    const preferred = ['Camera Object', 'Camera', 'Device Camera'];
    for (let i = 0; i < preferred.length; i++) {
      const found = this.findSceneObjectByName(preferred[i]);
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findSceneObjectByName(name: string): SceneObject | null {
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      const match = this.findNamedRecursive(global.scene.getRootObject(i), name);
      if (!isNull(match)) {
        return match;
      }
    }
    return null;
  }

  private findNamedRecursive(node: SceneObject, name: string): SceneObject | null {
    if (String(node.name || '') === name) {
      return node;
    }
    const count = node.getChildrenCount();
    for (let i = 0; i < count; i++) {
      const found = this.findNamedRecursive(node.getChild(i), name);
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }
}

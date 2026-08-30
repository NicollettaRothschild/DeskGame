import { playInteractionSound } from './InteractionSoundRegistry';

export enum PlantStage {
  Seed = 0,
  Baby = 1,
  WateredBaby = 2,
  Growing = 3,
  Adult = 4,
}

export type PlantLifecycleSaveState = {
  plantTypeId: string;
  stage: number;
  babyTimerRemaining: number;
  growthElapsed: number;
  walkedMeters?: number;
  hasBeenWatered: boolean;
  isPlanted: boolean;
  plantedWorldRotation?: quat | null;
  plantedModelLocalBaseY?: number;
  plantedAlignCenterX?: number;
  plantedAlignCenterZ?: number;
  plantedAlignY?: number;
  plantedGrowthOffsetX?: number;
  plantedGrowthOffsetY?: number;
  plantedGrowthOffsetZ?: number;
  /** Spoken goal this plant represents (onboarding goal seeds). */
  goalText?: string;
  requiresGoalCompletion?: boolean;
  goalCompleted?: boolean;
};

type AnchorPersistence = {
  persistPlantLifecycleState(plantContainer: SceneObject): void;
  notifyTrackedVisualHierarchyChanged?: (plantContainer: SceneObject) => void;
};

type InteractableManipulationLike = {
  manipulateRootSceneObject: SceneObject;
};

@component
export class PlantLifecycle extends BaseScriptComponent {
  @input('float')
  timeAsBaby: number = 30;

  @input('float')
  growthTime: number = 30;

  @input('float')
  scaleUpSize: number = 1;

  @input
  hasBeenWatered: boolean = false;

  @input
  plantTypeId: string = 'default';

  @input
  seedPlantPrefab!: ObjectPrefab;

  @input('float')
  seedScale: number = 0.013;

  @input
  babyPlantPrefab!: ObjectPrefab;

  @input
  adultPlantPrefab!: ObjectPrefab;

  @input
  plantTexture!: Texture;

  @input
  babyMaterialTemplate!: Material;

  @input
  debugPlantMaterials: boolean = false;

  @input
  requiresPlanting: boolean = true;

  @input
  @allowUndefined
  stageRoot!: SceneObject;

  private currentStage: PlantStage = PlantStage.Seed;
  private babyTimerRemaining = 0;
  private growthElapsed = 0;
  private growthPersistenceElapsed = 0;
  private lastPersistedGrowthElapsed = 0;
  private seedInstance: SceneObject | null = null;
  private babyInstance: SceneObject | null = null;
  private adultInstance: SceneObject | null = null;
  private clonedBabyMaterial: Material | null = null;
  private updateEvent: UpdateEvent | null = null;
  private anchorPersistence: AnchorPersistence | null = null;
  private alignNode: SceneObject | null = null;
  private growthScaleNode: SceneObject | null = null;
  private modelLocalBaseY = 0;
  private alignCenterX = 0;
  private alignCenterZ = 0;
  private isPlanted = false;
  private allowTrashManipulation = false;
  private plantedPreserveWorldScale: vec3 | null = null;
  private plantedPreserveWorldRotation: quat | null = null;
  private soilLineOffsetY = 0;
  private visualStateApplied = false;
  private seedWaterScaleOutActive = false;
  private seedWaterScaleOutElapsed = 0;
  private seedWaterScaleOutDuration = 0.45;
  private seedWaterScaleOutStartScale: vec3 | null = null;
  private static readonly DEFAULT_CONTAINER_WORLD_SCALE = 0.1;
  private static readonly GROWTH_SIZE_DIVISOR = 3;
  private static readonly GROWTH_PERSIST_INTERVAL_SECONDS = 5;
  /** Goal plants pause ~60% grown until the player finishes the goal. */
  private static readonly GOAL_GROWTH_CAP_RATIO = 0.6;
  /** Goal labels are compact world-space tags positioned below the planter. */
  private static readonly GOAL_LABEL_FALLBACK_OFFSET = new vec3(0, -32, 0);
  private static readonly GOAL_LABEL_MIN_BELOW_OFFSET_Y = 24;
  private static readonly GOAL_LABEL_MARGIN_Y = 8;
  private static readonly GOAL_LABEL_MIN_WIDTH = 8;
  private static readonly GOAL_LABEL_MAX_WIDTH = 18;
  private static readonly GOAL_LABEL_HALF_HEIGHT = 1.25;
  private static readonly GOAL_LABEL_TEXT_SIZE = 24;
  private static readonly GOAL_LABEL_DEPTH = 0.16;
  private static readonly GOAL_LABEL_BACKGROUND_COLOR = new vec4(
    0.025,
    0.09,
    0.055,
    0.9
  );
  private static readonly GOAL_LABEL_TEXT_COLOR = new vec4(1.0, 1.0, 1.0, 1.0);
  private static readonly GOAL_LABEL_COMPLETE_TEXT_COLOR = new vec4(
    0.55,
    1.0,
    0.65,
    1.0
  );
  private static readonly GOAL_LABEL_TEXT_COLOR_KEYS = [
    'frontCapStartingColor',
    'backCapStartingColor',
    'outerEdgeStartingColor',
    'outerEdgeEndingColor',
    'InnerEdgeStartingColor',
    'InnerEdgeEndingColor',
  ];
  /** Ignore sub-cm camera jitter when accumulating walk distance (world units = cm). */
  private static readonly WALK_SAMPLE_MIN_CM = 2;
  private static goalPlantRegistry: PlantLifecycle[] = [];
  private static goalCompleteListeners: Array<(plant: PlantLifecycle) => void> = [];

  private goalText = '';
  private requiresGoalCompletion = false;
  private goalCompleted = false;
  /** Parsed walk/run target in meters; 0 = not a distance goal. */
  private walkGoalMeters = 0;
  private walkedMeters = 0;
  private walkTrackingActive = false;
  /** Goal seeds are visually buried until they are watered. */
  private readonly plantedGoalSeedBurialFraction = 0.9;
  private walkLastCameraPos: vec3 | null = null;
  private walkCamera: SceneObject | null = null;
  private walkProgressLogTimer = 0;
  private goalLabelRoot: SceneObject | null = null;
  private goalLabelText3D: Text3D | null = null;
  private goalLabelBackground: RenderMeshVisual | null = null;
  private goalLabelTextMaterial: Material | null = null;
  private goalLabelLookAt: LookAtComponent | null = null;
  private goalLabelCamera: SceneObject | null = null;

  onAwake(): void {
    this.debugLog(`awake plantType=${this.plantTypeId}`);
    this.babyTimerRemaining = 0;
    this.currentStage = this.hasBeenWatered ? PlantStage.Growing : PlantStage.Seed;
    this.ensureStageRoot();
    this.createUpdateLoop();
    this.createEvent('OnStartEvent').bind(() => {
      if (!this.visualStateApplied) {
        this.initializeDefaultVisual();
      }
    });
  }

  private initializeDefaultVisual(): void {
    this.visualStateApplied = true;
    if (this.hasBeenWatered) {
      this.showAdultAtGrowthScale();
    } else {
      this.showSeed();
    }
  }

  public setAnchorPersistence(persistence: AnchorPersistence): void {
    this.anchorPersistence = persistence;
  }

  public setPlanted(planted: boolean): void {
    this.isPlanted = planted;
    if (planted) {
      if (isNull(this.plantedPreserveWorldScale)) {
        this.plantedPreserveWorldScale = this.getHierarchyWorldScale(this.getSceneObject());
      }
      if (isNull(this.plantedPreserveWorldRotation)) {
        this.plantedPreserveWorldRotation = this.getSceneObject().getTransform().getWorldRotation();
      }
      if (this.currentStage === PlantStage.Seed && !isNull(this.seedInstance)) {
        this.resetAlignmentForPot();
      } else {
        this.refreshPlantedVisual();
      }
      this.schedulePlantedSoilAlign();
    } else {
      this.plantedPreserveWorldScale = null;
      this.plantedPreserveWorldRotation = null;
    }
    this.updateInteractionForPlantedState();
    this.notifyAnchorStateChanged();
  }

  public getHierarchyWorldScale(sceneObject: SceneObject): vec3 {
    const localScale = sceneObject.getTransform().getLocalScale();
    const parent = sceneObject.getParent();
    if (isNull(parent)) {
      return localScale;
    }

    const parentWorldScale = this.getHierarchyWorldScale(parent);
    return new vec3(
      localScale.x * parentWorldScale.x,
      localScale.y * parentWorldScale.y,
      localScale.z * parentWorldScale.z
    );
  }

  public applyPlantedWorldScale(worldScale: vec3): void {
    this.plantedPreserveWorldScale = worldScale;
    this.enforcePlantedContainerScale();
  }

  public applyPlantedWorldRotation(worldRotation: quat): void {
    this.plantedPreserveWorldRotation = worldRotation;
    this.getSceneObject().getTransform().setWorldRotation(worldRotation);
    this.enforcePlantedContainerScale();
  }

  public getPlantedWorldRotation(): quat | null {
    return this.plantedPreserveWorldRotation;
  }

  public applyDefaultPlantedWorldScale(): void {
    this.applyPlantedWorldScale(
      new vec3(
        PlantLifecycle.DEFAULT_CONTAINER_WORLD_SCALE,
        PlantLifecycle.DEFAULT_CONTAINER_WORLD_SCALE,
        PlantLifecycle.DEFAULT_CONTAINER_WORLD_SCALE
      )
    );
  }

  public getIsPlanted(): boolean {
    return this.isPlanted;
  }

  public setSoilLineOffsetY(offsetY: number): void {
    this.soilLineOffsetY = offsetY;
    if (this.isPlanted) {
      this.finalizePlantedPlacement({ preserveContainerPlacement: true });
    }
  }

  public setAllowTrashManipulation(enabled: boolean): void {
    this.allowTrashManipulation = enabled;
    this.updateInteractionForPlantedState();
  }

  public configurePlant(
    plantTypeId: string,
    adultPlantPrefab: ObjectPrefab,
    plantTexture: Texture,
    timeAsBaby: number,
    growthTime: number,
    scaleUpSize: number
  ): void {
    this.plantTypeId = plantTypeId;
    this.adultPlantPrefab = adultPlantPrefab;
    this.plantTexture = plantTexture;
    this.timeAsBaby = Math.max(0, timeAsBaby);
    this.growthTime = Math.max(0, growthTime);
    this.scaleUpSize = Math.max(0.001, scaleUpSize);
    this.babyTimerRemaining = this.timeAsBaby;
    this.growthElapsed = 0;
    this.hasBeenWatered = false;
    this.currentStage = PlantStage.Seed;
    this.debugLog(
      `configurePlant type=${plantTypeId} babyTime=${this.timeAsBaby} growthTime=${this.growthTime} scale=${this.scaleUpSize} texture=${this.plantTexture ? this.plantTexture.name : 'null'}`
    );
    this.showSeed();
  }

  public applySpawnConfig(
    plantTypeId: string,
    adultPlantPrefab: ObjectPrefab,
    plantTexture: Texture,
    timeAsBaby: number,
    growthTime: number,
    scaleUpSize: number
  ): void {
    this.plantTypeId = plantTypeId;
    this.adultPlantPrefab = adultPlantPrefab;
    this.plantTexture = plantTexture;
    this.timeAsBaby = Math.max(0, timeAsBaby);
    this.growthTime = Math.max(0, growthTime);
    this.scaleUpSize = Math.max(0.001, scaleUpSize);
  }

  /**
   * Bind a spoken life-goal to this seed. Growth will pause before Adult
   * until completeGoal() (speech, or auto when a walk/run distance is met).
   */
  public bindGoal(goalText: string): void {
    const text = String(goalText || '').trim();
    if (!text) {
      return;
    }
    this.goalText = text;
    this.requiresGoalCompletion = true;
    this.goalCompleted = false;
    this.walkGoalMeters = PlantLifecycle.parseWalkGoalMeters(text);
    this.walkedMeters = 0;
    this.walkLastCameraPos = null;
    this.walkProgressLogTimer = 0;
    this.walkTrackingActive = this.walkGoalMeters > 0;
    if (this.walkTrackingActive) {
      this.ensureWalkCamera();
      if (!isNull(this.walkCamera)) {
        this.walkLastCameraPos = this.walkCamera.getTransform().getWorldPosition();
      }
      print(
        `[PlantLifecycle] ${this.getSceneObject().name}: walk goal armed target=${this.walkGoalMeters.toFixed(2)}m`
      );
    }
    PlantLifecycle.registerGoalPlant(this);
    this.refreshGoalLabel();
    this.notifyAnchorStateChanged();
    print(`[PlantLifecycle] ${this.getSceneObject().name}: bound goal "${text}"`);
  }

  public getGoalText(): string {
    return this.goalText;
  }

  public getWalkGoalMeters(): number {
    return this.walkGoalMeters;
  }

  public getWalkedMeters(): number {
    return this.walkedMeters;
  }

  /** Preview/harness helper to shorten growth without resetting stage visuals. */
  public setGrowthTimeForTests(seconds: number): void {
    this.growthTime = Math.max(0.1, seconds);
  }

  public getCurrentStage(): PlantStage {
    return this.currentStage;
  }

  public requiresGoal(): boolean {
    return this.requiresGoalCompletion && !this.goalCompleted;
  }

  public isGoalCompleted(): boolean {
    return this.goalCompleted;
  }

  public static addGoalCompleteListener(listener: (plant: PlantLifecycle) => void): void {
    if (!listener) {
      return;
    }
    for (let i = 0; i < PlantLifecycle.goalCompleteListeners.length; i++) {
      if (PlantLifecycle.goalCompleteListeners[i] === listener) {
        return;
      }
    }
    PlantLifecycle.goalCompleteListeners.push(listener);
  }

  /**
   * Parse goals like "walk 20 meters", "run 1 km", "walk twenty meters".
   * Returns meters or 0 if not a distance goal.
   */
  public static parseWalkGoalMeters(goalText: string): number {
    const raw = String(goalText || '')
      .trim()
      .toLowerCase()
      .replace(/,/g, '');
    if (!raw) {
      return 0;
    }
    if (!/\b(walk|walked|walking|run|ran|running|jog|jogged|jogging)\b/.test(raw)) {
      return 0;
    }

    const unitMatch = raw.match(
      /(\d+(?:\.\d+)?)\s*(kilometers?|kilometres?|km|meters?|metres?|m)\b/
    );
    if (unitMatch) {
      const value = parseFloat(unitMatch[1]);
      if (!(value > 0)) {
        return 0;
      }
      const unit = unitMatch[2];
      if (unit.indexOf('km') === 0 || unit.indexOf('kilo') === 0) {
        return value * 1000;
      }
      return value;
    }

    const wordMatch = raw.match(
      /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b(?:\s+\b(one|two|three|four|five|six|seven|eight|nine)\b)?\s*(kilometers?|kilometres?|km|meters?|metres?|m)\b/
    );
    if (!wordMatch) {
      return 0;
    }
    const tensMap: {[key: string]: number} = {
      a: 1,
      an: 1,
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
      eleven: 11,
      twelve: 12,
      thirteen: 13,
      fourteen: 14,
      fifteen: 15,
      sixteen: 16,
      seventeen: 17,
      eighteen: 18,
      nineteen: 19,
      twenty: 20,
      thirty: 30,
      forty: 40,
      fifty: 50,
      sixty: 60,
      seventy: 70,
      eighty: 80,
      ninety: 90,
      hundred: 100,
    };
    let value = tensMap[wordMatch[1]] || 0;
    if (wordMatch[2] && tensMap[wordMatch[2]]) {
      value += tensMap[wordMatch[2]];
    }
    if (!(value > 0)) {
      return 0;
    }
    const unit = wordMatch[3];
    if (unit.indexOf('km') === 0 || unit.indexOf('kilo') === 0) {
      return value * 1000;
    }
    return value;
  }

  /** Test/harness helper: accumulate walked meters as if the camera moved. */
  public addWalkedMeters(meters: number): void {
    if (!this.requiresGoalCompletion || this.goalCompleted || !(meters > 0)) {
      return;
    }
    if (!(this.walkGoalMeters > 0)) {
      return;
    }
    this.walkedMeters += meters;
    print(
      `[PlantLifecycle] ${this.getSceneObject().name}: walked ${this.walkedMeters.toFixed(2)}/${this.walkGoalMeters.toFixed(2)}m (injected)`
    );
    this.tryCompleteWalkGoal();
  }

  public static injectWalkedMetersForTests(meters: number): number {
    PlantLifecycle.pruneGoalPlantRegistry();
    let updated = 0;
    for (let i = 0; i < PlantLifecycle.goalPlantRegistry.length; i++) {
      const plant = PlantLifecycle.goalPlantRegistry[i];
      if (isNull(plant) || !plant.requiresGoal() || !(plant.walkGoalMeters > 0)) {
        continue;
      }
      plant.addWalkedMeters(meters);
      updated += 1;
    }
    return updated;
  }

  /** Finish the bound goal and bloom to Adult once the plant is planted. */
  public completeGoal(): boolean {
    if (!this.requiresGoalCompletion || this.goalCompleted) {
      return false;
    }
    this.goalCompleted = true;
    this.refreshGoalLabel();
    this.walkTrackingActive = false;
    print(`[PlantLifecycle] ${this.getSceneObject().name}: goal completed "${this.goalText}"`);

    if (this.currentStage === PlantStage.Growing || this.currentStage === PlantStage.WateredBaby) {
      this.finishGrowthToAdult();
    } else if (this.currentStage === PlantStage.Seed && this.isPlanted) {
      // A completed goal must still bloom a seed if watering was skipped.
      // Cancel any in-flight watering transition before replacing the seed model.
      this.seedWaterScaleOutActive = false;
      this.seedWaterScaleOutStartScale = null;
      this.startGrowth();
      this.finishGrowthToAdult();
    } else {
      this.notifyAnchorStateChanged();
    }

    for (let i = 0; i < PlantLifecycle.goalCompleteListeners.length; i++) {
      try {
        PlantLifecycle.goalCompleteListeners[i](this);
      } catch (_e) {
        // listener failure should not block completion
      }
    }
    return true;
  }

  public static tryCompleteGoalBySpeech(spokenText: string): PlantLifecycle | null {
    PlantLifecycle.pruneGoalPlantRegistry();
    const query = String(spokenText || '')
      .trim()
      .toLowerCase();
    if (!query || PlantLifecycle.goalPlantRegistry.length === 0) {
      return null;
    }

    // Require explicit completion intent to avoid accidental completes from ambient speech/TTS.
    const hasDoneWord = /\b(finished|finish|completed|complete|done|did it|i did|achieved|accomplished)\b/.test(
      query
    );
    const mentionsGoal = /\b(my )?goal\b/.test(query);
    const completionIntent =
      hasDoneWord ||
      /\b(i am|i'm|im)\s+done\b/.test(query) ||
      /\b(all set|that'?s it|thats it)\b/.test(query) ||
      (mentionsGoal && /\b(finish|finished|complete|completed|done)\b/.test(query));
    if (!completionIntent) {
      return null;
    }

    let target: PlantLifecycle | null = null;
    for (let i = 0; i < PlantLifecycle.goalPlantRegistry.length; i++) {
      const plant = PlantLifecycle.goalPlantRegistry[i];
      if (isNull(plant) || !plant.requiresGoal()) {
        continue;
      }
      const goal = plant.getGoalText().toLowerCase();
      if (goal && (query.indexOf(goal) >= 0 || this.sharesGoalTokens(query, goal))) {
        target = plant;
        break;
      }
    }
    if (isNull(target)) {
      // Fallback to a single active goal only when intent is explicit.
      let onlyActive: PlantLifecycle | null = null;
      for (let i = 0; i < PlantLifecycle.goalPlantRegistry.length; i++) {
        const plant = PlantLifecycle.goalPlantRegistry[i];
        if (isNull(plant) || !plant.requiresGoal()) {
          continue;
        }
        if (!isNull(onlyActive)) {
          onlyActive = null;
          break;
        }
        onlyActive = plant;
      }
      target = onlyActive;
    }
    if (isNull(target) || !target.completeGoal()) {
      return null;
    }
    return target;
  }

  private static sharesGoalTokens(spoken: string, goal: string): boolean {
    const stop = new Set([
      'i',
      'want',
      'to',
      'a',
      'an',
      'the',
      'my',
      'do',
      'and',
      'for',
      'of',
      'in',
      'on',
      'is',
      'it',
      'me',
    ]);
    const tokens = goal.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !stop.has(t));
    if (tokens.length === 0) {
      return false;
    }
    let hits = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (spoken.indexOf(tokens[i]) >= 0) {
        hits += 1;
      }
    }
    return hits >= Math.min(2, tokens.length);
  }

  private tryCompleteWalkGoal(): void {
    if (
      !this.requiresGoalCompletion ||
      this.goalCompleted ||
      !(this.walkGoalMeters > 0) ||
      this.walkedMeters + 0.001 < this.walkGoalMeters
    ) {
      return;
    }
    print(
      `[PlantLifecycle] ${this.getSceneObject().name}: walk goal reached ${this.walkedMeters.toFixed(2)}/${this.walkGoalMeters.toFixed(2)}m`
    );
    this.completeGoal();
  }

  private updateWalkTracking(): void {
    this.ensureWalkCamera();
    if (isNull(this.walkCamera)) {
      return;
    }
    const pos = this.walkCamera.getTransform().getWorldPosition();
    if (isNull(this.walkLastCameraPos)) {
      this.walkLastCameraPos = pos;
      return;
    }

    const last = this.walkLastCameraPos as vec3;
    const dx = pos.x - last.x;
    const dz = pos.z - last.z;
    const stepCm = Math.sqrt(dx * dx + dz * dz);
    if (stepCm >= PlantLifecycle.WALK_SAMPLE_MIN_CM) {
      // World units are centimeters.
      this.walkedMeters += stepCm / 100;
      this.walkLastCameraPos = pos;
      this.tryCompleteWalkGoal();
    }

    this.walkProgressLogTimer += getDeltaTime();
    if (this.walkProgressLogTimer >= 2.5) {
      this.walkProgressLogTimer = 0;
      print(
        `[PlantLifecycle] ${this.getSceneObject().name}: walk progress ${this.walkedMeters.toFixed(2)}/${this.walkGoalMeters.toFixed(2)}m`
      );
    }
  }

  private ensureWalkCamera(): void {
    if (!isNull(this.walkCamera)) {
      return;
    }
    const preferredNames = ['Camera Object', 'Camera', 'Device Camera'];
    for (let i = 0; i < preferredNames.length; i++) {
      const found = this.findSceneObjectByName(preferredNames[i]);
      if (!isNull(found) && !isNull(found.getComponent('Component.Camera'))) {
        this.walkCamera = found;
        return;
      }
    }
    this.walkCamera = this.findObjectWithCameraComponent();
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

  private findObjectWithCameraComponent(): SceneObject | null {
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      const found = this.findCameraComponentRecursive(global.scene.getRootObject(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findCameraComponentRecursive(node: SceneObject): SceneObject | null {
    const cam = node.getComponent('Component.Camera') as Camera;
    if (!isNull(cam)) {
      return node;
    }
    const count = node.getChildrenCount();
    for (let i = 0; i < count; i++) {
      const found = this.findCameraComponentRecursive(node.getChild(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private static registerGoalPlant(plant: PlantLifecycle): void {
    PlantLifecycle.pruneGoalPlantRegistry();
    for (let i = 0; i < PlantLifecycle.goalPlantRegistry.length; i++) {
      if (PlantLifecycle.goalPlantRegistry[i] === plant) {
        return;
      }
    }
    PlantLifecycle.goalPlantRegistry.push(plant);
  }

  private static pruneGoalPlantRegistry(): void {
    const next: PlantLifecycle[] = [];
    for (let i = 0; i < PlantLifecycle.goalPlantRegistry.length; i++) {
      const plant = PlantLifecycle.goalPlantRegistry[i];
      if (isNull(plant)) {
        continue;
      }
      try {
        const obj = plant.getSceneObject();
        if (isNull(obj)) {
          continue;
        }
        next.push(plant);
      } catch (_e) {
        // destroyed
      }
    }
    PlantLifecycle.goalPlantRegistry = next;
  }

  public water(): boolean {
    if (!this.isPlanted) {
      const pot = this.findParentPlantPot();
      if (!isNull(pot) && typeof pot.tryAttachSeed === 'function') {
        pot.tryAttachSeed(this);
      }
    }

    if (this.requiresPlanting && !this.isPlanted) {
      print(`[PlantLifecycle] ${this.getSceneObject().name}: water ignored (seed must be planted in a pot)`);
      return false;
    }

    if (this.currentStage === PlantStage.Adult || this.currentStage === PlantStage.Growing) {
      print(`[PlantLifecycle] ${this.getSceneObject().name}: water ignored (stage=${this.currentStage})`);
      return false;
    }

    this.hasBeenWatered = true;

    if (this.currentStage === PlantStage.Seed) {
      if (this.isPlanted && !isNull(this.seedInstance)) {
        this.beginSeedWaterScaleOut();
      } else {
        this.startGrowth();
      }
      playInteractionSound((sounds) => sounds.playWatering());
      const goalNote =
        this.requiresGoalCompletion && !this.goalCompleted
          ? ' (paused until goal complete)'
          : '';
      print(
        `[PlantLifecycle] ${this.getSceneObject().name}: watered seed -> growing (${this.growthTime.toFixed(1)}s to adult)${goalNote}`
      );
      return true;
    }

    if (
      this.currentStage === PlantStage.Baby ||
      this.currentStage === PlantStage.WateredBaby
    ) {
      this.startGrowth();
      playInteractionSound((sounds) => sounds.playWatering());
      print(`[PlantLifecycle] ${this.getSceneObject().name}: legacy baby stage skipped -> growing`);
      return true;
    }

    return false;
  }

  public getSaveState(): PlantLifecycleSaveState {
    const state: PlantLifecycleSaveState = {
      plantTypeId: this.plantTypeId,
      stage: this.currentStage,
      babyTimerRemaining: this.babyTimerRemaining,
      growthElapsed: this.growthElapsed,
      walkedMeters: this.walkedMeters,
      hasBeenWatered: this.hasBeenWatered,
      isPlanted: this.isPlanted,
      goalText: this.goalText,
      requiresGoalCompletion: this.requiresGoalCompletion,
      goalCompleted: this.goalCompleted,
    };

    if (
      this.isPlanted &&
      (this.currentStage === PlantStage.Seed ||
        this.currentStage === PlantStage.Adult ||
        this.currentStage === PlantStage.Growing)
    ) {
      state.plantedModelLocalBaseY = this.modelLocalBaseY;
      state.plantedAlignCenterX = this.alignCenterX;
      state.plantedAlignCenterZ = this.alignCenterZ;
      if (!isNull(this.alignNode)) {
        state.plantedAlignY = (this.alignNode as SceneObject)
          .getTransform()
          .getLocalPosition()
          .y;
      }
      if (!isNull(this.growthScaleNode)) {
        const growthOffset = (this.growthScaleNode as SceneObject)
          .getTransform()
          .getLocalPosition();
        state.plantedGrowthOffsetX = growthOffset.x;
        state.plantedGrowthOffsetY = growthOffset.y;
        state.plantedGrowthOffsetZ = growthOffset.z;
      }
    }

    return state;
  }

  public applySaveState(state: PlantLifecycleSaveState): void {
    this.visualStateApplied = true;
    this.plantTypeId = state.plantTypeId;
    this.hasBeenWatered = state.hasBeenWatered;
    this.babyTimerRemaining = Math.max(0, state.babyTimerRemaining);
    this.growthElapsed = Math.max(0, state.growthElapsed);
    this.growthPersistenceElapsed = 0;
    this.lastPersistedGrowthElapsed = this.growthElapsed;
    this.currentStage = this.normalizeStage(state.stage);
    this.isPlanted = state.isPlanted;
    this.goalText = String(state.goalText || '').trim();
    this.requiresGoalCompletion = !!state.requiresGoalCompletion && !!this.goalText;
    this.goalCompleted = !!state.goalCompleted;
    this.walkGoalMeters = this.requiresGoalCompletion
      ? PlantLifecycle.parseWalkGoalMeters(this.goalText)
      : 0;
    this.walkedMeters =
      typeof state.walkedMeters === 'number' ? Math.max(0, state.walkedMeters) : 0;
    this.walkTrackingActive =
      this.requiresGoalCompletion && !this.goalCompleted && this.walkGoalMeters > 0;
    if (this.walkTrackingActive) {
      this.ensureWalkCamera();
      if (!isNull(this.walkCamera)) {
        this.walkLastCameraPos = this.walkCamera.getTransform().getWorldPosition();
      }
      PlantLifecycle.registerGoalPlant(this);
    } else if (this.requiresGoalCompletion && !this.goalCompleted) {
      PlantLifecycle.registerGoalPlant(this);
    }
    this.refreshGoalLabel();

    if (this.currentStage === PlantStage.Seed) {
      this.showSeed();
    } else if (this.currentStage === PlantStage.Growing) {
      this.showAdultAtGrowthScale();
    } else if (this.currentStage === PlantStage.Adult) {
      this.showAdult();
    } else {
      this.showAdultAtGrowthScale();
    }

    if (this.isPlanted) {
      this.allowTrashManipulation = false;
      if (isNull(this.plantedPreserveWorldScale)) {
        this.applyDefaultPlantedWorldScale();
      }
      if (!isNull(state.plantedWorldRotation)) {
        this.plantedPreserveWorldRotation = state.plantedWorldRotation as quat;
      }
      this.finalizePlantedPlacement();
      this.updateInteractionForPlantedState();
    }
  }

  private createUpdateLoop(): void {
    this.updateEvent = this.createEvent('UpdateEvent');
    this.updateEvent.bind(() => this.onUpdate());
    this.updateEvent.enabled = true;
  }

  private onUpdate(): void {
    this.updateGoalLabelTransform();
    if (this.isPlanted && !this.allowTrashManipulation) {
      this.enforcePlantedAnchor();
    }

    if (this.walkTrackingActive && this.requiresGoalCompletion && !this.goalCompleted) {
      this.updateWalkTracking();
    }

    if (this.seedWaterScaleOutActive) {
      this.updateSeedWaterScaleOut();
      return;
    }
    if (this.currentStage === PlantStage.Adult) {
      return;
    }

    if (
      this.currentStage === PlantStage.Baby ||
      this.currentStage === PlantStage.WateredBaby
    ) {
      this.startGrowth();
      return;
    }

    if (this.currentStage === PlantStage.Growing) {
      const deltaTime = getDeltaTime();
      this.growthElapsed += deltaTime;
      this.growthPersistenceElapsed += deltaTime;

      if (this.requiresGoalCompletion && !this.goalCompleted) {
        const cap = Math.max(0.5, this.growthTime * PlantLifecycle.GOAL_GROWTH_CAP_RATIO);
        if (this.growthElapsed > cap) {
          this.growthElapsed = cap;
        }
        this.applyGrowthScale();
        this.persistGrowthProgressIfDue();
        return;
      }

      this.applyGrowthScale();

      if (this.growthTime <= 0 || this.growthElapsed >= this.growthTime) {
        this.finishGrowthToAdult();
        return;
      }
      this.persistGrowthProgressIfDue();
    }
  }

  private persistGrowthProgressIfDue(): void {
    if (
      this.growthPersistenceElapsed < PlantLifecycle.GROWTH_PERSIST_INTERVAL_SECONDS
    ) {
      return;
    }

    this.growthPersistenceElapsed = 0;
    if (this.growthElapsed <= this.lastPersistedGrowthElapsed + 0.001) {
      return;
    }

    this.lastPersistedGrowthElapsed = this.growthElapsed;
    this.notifyAnchorStateChanged();
  }

  private finishGrowthToAdult(): void {
    if (this.currentStage === PlantStage.Adult) {
      return;
    }
    this.currentStage = PlantStage.Adult;
    this.growthElapsed = Math.max(this.growthElapsed, this.growthTime);
    this.applyAdultScale();
    this.updateInteractionForPlantedState();
    this.notifyAnchorStateChanged();
    playInteractionSound((sounds) => sounds.playGrowthComplete());
    print(`[PlantLifecycle] ${this.getSceneObject().name}: growth complete -> adult`);
  }

  private beginSeedWaterScaleOut(): void {
    if (this.seedWaterScaleOutActive) {
      return;
    }
    if (isNull(this.seedInstance)) {
      this.startGrowth();
      return;
    }
    const seed = this.seedInstance as SceneObject;
    this.seedWaterScaleOutActive = true;
    this.seedWaterScaleOutElapsed = 0;
    this.seedWaterScaleOutStartScale = seed.getTransform().getLocalScale();
  }

  private updateSeedWaterScaleOut(): void {
    if (!this.seedWaterScaleOutActive) {
      return;
    }

    const seed = this.seedInstance;
    const start = this.seedWaterScaleOutStartScale;
    const duration = Math.max(0.001, this.seedWaterScaleOutDuration);

    if (isNull(seed) || isNull(start)) {
      this.seedWaterScaleOutActive = false;
      this.seedWaterScaleOutStartScale = null;
      this.startGrowth();
      return;
    }

    this.seedWaterScaleOutElapsed += getDeltaTime();
    const t = Math.min(1, this.seedWaterScaleOutElapsed / duration);
    const nextScale = new vec3(start.x * (1 - t), start.y * (1 - t), start.z * (1 - t));
    (seed as SceneObject).getTransform().setLocalScale(nextScale);

    if (t < 1) {
      return;
    }

    this.seedWaterScaleOutActive = false;
    this.seedWaterScaleOutStartScale = null;
    (seed as SceneObject).destroy();
    this.seedInstance = null;
    this.startGrowth();
  }

  private startGrowth(): void {
    this.currentStage = PlantStage.Growing;
    this.growthElapsed = 0;
    this.growthPersistenceElapsed = 0;
    this.lastPersistedGrowthElapsed = 0;
    this.showAdultAtGrowthScale();
    this.notifyAnchorStateChanged();
    playInteractionSound((sounds) => sounds.playGrowthStart());
    print(
      `[PlantLifecycle] ${this.getSceneObject().name}: started growing (${this.growthTime.toFixed(1)}s to adult)`
    );
  }

  private ensureStageRoot(): SceneObject {
    const container = this.getSceneObject();
    if (!isNull(this.stageRoot) && this.stageRoot !== container) {
      return this.stageRoot;
    }

    for (let i = 0; i < container.getChildrenCount(); i++) {
      const child = container.getChild(i);
      if (!isNull(child) && child.name === 'PlantStageRoot') {
        this.stageRoot = child;
        return child;
      }
    }

    this.stageRoot = global.scene.createSceneObject('PlantStageRoot');
    this.stageRoot.setParent(container);
    this.stageRoot.getTransform().setLocalPosition(vec3.zero());
    this.stageRoot.getTransform().setLocalRotation(quat.quatIdentity());
    this.stageRoot.getTransform().setLocalScale(vec3.one());
    return this.stageRoot;
  }

  private ensureAlignNode(): SceneObject {
    const stageRoot = this.ensureStageRoot();
    if (!isNull(this.alignNode)) {
      return this.alignNode as SceneObject;
    }

    for (let i = 0; i < stageRoot.getChildrenCount(); i++) {
      const child = stageRoot.getChild(i);
      if (!isNull(child) && child.name === 'PlantAlignNode') {
        this.alignNode = child;
        return child as SceneObject;
      }
    }

    this.alignNode = global.scene.createSceneObject('PlantAlignNode');
    this.alignNode.setParent(stageRoot);
    this.alignNode.getTransform().setLocalPosition(vec3.zero());
    this.alignNode.getTransform().setLocalRotation(quat.quatIdentity());
    this.alignNode.getTransform().setLocalScale(vec3.one());
    return this.alignNode as SceneObject;
  }

  private ensureGrowthScaleNode(): SceneObject {
    const alignNode = this.ensureAlignNode();
    if (!isNull(this.growthScaleNode)) {
      return this.growthScaleNode as SceneObject;
    }

    for (let i = 0; i < alignNode.getChildrenCount(); i++) {
      const child = alignNode.getChild(i);
      if (!isNull(child) && child.name === 'PlantGrowthScale') {
        this.growthScaleNode = child;
        return child as SceneObject;
      }
    }

    this.growthScaleNode = global.scene.createSceneObject('PlantGrowthScale');
    this.growthScaleNode.setParent(alignNode);
    this.growthScaleNode.getTransform().setLocalPosition(vec3.zero());
    this.growthScaleNode.getTransform().setLocalRotation(quat.quatIdentity());
    this.growthScaleNode.getTransform().setLocalScale(vec3.one());
    return this.growthScaleNode as SceneObject;
  }

  private showBaby(): void {
    this.destroyCurrentInstances();
    this.alignCenterX = 0;
    this.alignCenterZ = 0;

    const parent = this.ensureGrowthScaleNode();
    parent.getTransform().setLocalScale(vec3.one());

    this.babyInstance = this.babyPlantPrefab.instantiate(parent);
    this.babyInstance.name = 'BabyPlantModel';
    this.debugLog(`spawn baby root=${this.babyInstance.name} parent=${parent.name}`);
    this.prepareStageModel(this.babyInstance);
    this.applyClonedBabyMaterial(this.babyInstance);
    if (!this.isPlanted) {
      this.captureModelMetrics(this.babyInstance);
      this.refreshAlignNodePosition(1);
      this.updateInteractionForPlantedState();
      return;
    }

    this.resetAlignmentForPot();
  }

  private showSeed(): void {
    this.destroyCurrentInstances();
    this.alignCenterX = 0;
    this.alignCenterZ = 0;

    const parent = this.ensureGrowthScaleNode();
    parent.getTransform().setLocalScale(vec3.one());

    if (isNull(this.seedPlantPrefab)) {
      this.debugLog('showSeed skipped: seedPlantPrefab is null, falling back to adult growth');
      this.showAdultAtGrowthScale();
      return;
    }

    this.seedInstance = this.seedPlantPrefab.instantiate(parent);
    this.seedInstance.name = 'SeedPlantModel';
    this.debugLog(`spawn seed root=${this.seedInstance.name} parent=${parent.name}`);
    this.prepareStageModel(this.seedInstance);
    this.seedInstance.getTransform().setLocalScale(
      new vec3(this.seedScale, this.seedScale, this.seedScale)
    );
    if (!this.isPlanted) {
      this.captureModelMetrics(this.seedInstance);
      this.refreshAlignNodePosition(1);
      this.updateInteractionForPlantedState();
      return;
    }

    this.resetAlignmentForPot();
    this.updateInteractionForPlantedState();
  }

  private showAdultAtGrowthScale(): void {
    if (!this.isPlanted) {
      this.captureAlignCenterFromCurrentModel();
    }
    this.destroyCurrentInstances();

    const parent = this.ensureGrowthScaleNode();
    this.adultInstance = this.spawnAdultModel(parent);

    if (this.isPlanted) {
      this.applyPlantedModelOrientation();
    }

    this.applyGrowthScale();
    if (this.isPlanted) {
      this.finalizePlantedPlacement({ preserveContainerPlacement: true });
      this.updateInteractionForPlantedState();
      return;
    }
    if (!this.isPlanted) {
      this.updateInteractionForPlantedState();
    }
  }

  private showAdult(): void {
    this.destroyCurrentInstances();
    const parent = this.ensureGrowthScaleNode();
    this.adultInstance = this.spawnAdultModel(parent);

    if (this.isPlanted) {
      this.applyPlantedModelOrientation();
    }

    this.applyAdultScale();
    if (this.isPlanted) {
      this.finalizePlantedPlacement({ preserveContainerPlacement: true });
      this.updateInteractionForPlantedState();
      return;
    }
    if (!this.isPlanted) {
      this.updateInteractionForPlantedState();
    }
  }

  private spawnAdultModel(parent: SceneObject): SceneObject {
    const adult = this.adultPlantPrefab.instantiate(parent);
    adult.name = 'AdultPlantModel';
    this.debugLog(`spawn adult root=${adult.name} parent=${parent.name}`);
    this.prepareStageModel(adult);
    if (!this.isPlanted) {
      this.captureModelMetrics(adult);
      this.refreshAlignNodePosition(this.getCurrentGrowthScale());
    }
    return adult;
  }

  private prepareStageModel(model: SceneObject): void {
    model.getTransform().setLocalPosition(vec3.zero());
    model.getTransform().setLocalRotation(quat.quatIdentity());
    model.getTransform().setLocalScale(vec3.one());
    this.wireManipulationToContainer(model);
    this.notifyTrackedVisualHierarchyChanged();
  }

  private notifyTrackedVisualHierarchyChanged(): void {
    if (
      isNull(this.anchorPersistence) ||
      typeof this.anchorPersistence.notifyTrackedVisualHierarchyChanged !== 'function'
    ) {
      return;
    }

    this.anchorPersistence.notifyTrackedVisualHierarchyChanged(this.getSceneObject());
  }

  private captureAlignCenterFromCurrentModel(): void {
    let current: SceneObject | null = null;
    if (!isNull(this.babyInstance)) {
      current = this.babyInstance;
    } else if (!isNull(this.seedInstance)) {
      current = this.seedInstance;
    } else if (!isNull(this.adultInstance)) {
      current = this.adultInstance;
    }
    if (isNull(current)) {
      return;
    }

    const stageRoot = this.ensureStageRoot();
    const stageRootWorldToLocal = stageRoot.getTransform().getWorldTransform().inverse();
    const visuals = this.findAlignmentMeshVisuals(current as SceneObject);
    if (visuals.length === 0) {
      return;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < visuals.length; i++) {
      const localMin = stageRootWorldToLocal.multiplyPoint(visuals[i].worldAabbMin());
      const localMax = stageRootWorldToLocal.multiplyPoint(visuals[i].worldAabbMax());
      minX = Math.min(minX, localMin.x);
      maxX = Math.max(maxX, localMax.x);
      minZ = Math.min(minZ, localMin.z);
      maxZ = Math.max(maxZ, localMax.z);
    }

    this.alignCenterX = (minX + maxX) * 0.5;
    this.alignCenterZ = (minZ + maxZ) * 0.5;
  }

  private captureModelMetrics(model: SceneObject): void {
    const modelWorldToLocal = model.getTransform().getWorldTransform().inverse();
    const visuals = this.findAlignmentMeshVisuals(model);
    let minY = Infinity;

    for (let i = 0; i < visuals.length; i++) {
      const localMin = modelWorldToLocal.multiplyPoint(visuals[i].worldAabbMin());
      minY = Math.min(minY, localMin.y);
    }

    this.modelLocalBaseY = minY === Infinity ? 0 : minY;
  }

  private refreshAlignNodePosition(growthScale: number): void {
    const alignNode = this.ensureAlignNode();
    if (this.isPlanted) {
      alignNode.getTransform().setLocalPosition(vec3.zero());
      this.applyPlantedAttachAlignment();
      return;
    }

    const soilAnchorScale = this.getSoilAnchorScale(growthScale);
    alignNode.getTransform().setLocalPosition(
      new vec3(
        this.alignCenterX,
        -soilAnchorScale * this.modelLocalBaseY,
        this.alignCenterZ
      )
    );
  }

  private measureMeshFootprintInAttachSpace(): { minY: number; centerX: number; centerZ: number } {
    const container = this.getSceneObject();
    const attachParent = container.getParent();
    const attachReference = isNull(attachParent) ? this.ensureStageRoot() : attachParent;
    const attachWorldToLocal = attachReference.getTransform().getWorldTransform().inverse();
    const activeModel = this.getActiveStageModel();
    const measureRoot = isNull(activeModel) ? this.ensureStageRoot() : (activeModel as SceneObject);
    const visuals = this.findAlignmentMeshVisuals(measureRoot);
    if (visuals.length === 0) {
      return { minY: 0, centerX: 0, centerZ: 0 };
    }

    const corners: vec3[] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < visuals.length; i++) {
      this.appendWorldAabbCorners(corners, visuals[i].worldAabbMin(), visuals[i].worldAabbMax());
    }

    for (let i = 0; i < corners.length; i++) {
      const localPoint = attachWorldToLocal.multiplyPoint(corners[i]);
      minX = Math.min(minX, localPoint.x);
      maxX = Math.max(maxX, localPoint.x);
      minY = Math.min(minY, localPoint.y);
      maxY = Math.max(maxY, localPoint.y);
      minZ = Math.min(minZ, localPoint.z);
      maxZ = Math.max(maxZ, localPoint.z);
    }

    if (minY === Infinity) {
      return { minY: 0, centerX: 0, centerZ: 0 };
    }

    return {
      minY,
      centerX: (minX + maxX) * 0.5,
      centerZ: (minZ + maxZ) * 0.5,
    };
  }

  private applyPlantedAttachAlignment(): void {
    const container = this.getSceneObject();
    const attachParent = container.getParent();
    if (isNull(attachParent) || isNull(this.growthScaleNode)) {
      return;
    }

    const growthScaleNode = this.growthScaleNode as SceneObject;
    const attachTransform = attachParent.getTransform();
    const attachWorldToLocal = attachTransform.getWorldTransform().inverse();
    const pivotLocalInAttach = attachWorldToLocal.multiplyPoint(
      growthScaleNode.getTransform().getWorldPosition()
    );
    const targetLocalInAttach = new vec3(0, this.soilLineOffsetY, 0);
    const deltaLocalInAttach = new vec3(
      targetLocalInAttach.x - pivotLocalInAttach.x,
      targetLocalInAttach.y - pivotLocalInAttach.y,
      targetLocalInAttach.z - pivotLocalInAttach.z
    );

    if (
      Math.abs(deltaLocalInAttach.x) < 0.0001 &&
      Math.abs(deltaLocalInAttach.y) < 0.0001 &&
      Math.abs(deltaLocalInAttach.z) < 0.0001
    ) {
      const footprint = this.measureMeshFootprintInAttachSpace();
      this.modelLocalBaseY = footprint.minY;
      return;
    }

    const deltaWorld = this.localOffsetToWorldOffset(deltaLocalInAttach, attachParent);
    const containerTransform = container.getTransform();
    const worldPosition = containerTransform.getWorldPosition();
    containerTransform.setWorldPosition(
      new vec3(
        worldPosition.x + deltaWorld.x,
        worldPosition.y + deltaWorld.y,
        worldPosition.z + deltaWorld.z
      )
    );
    this.modelLocalBaseY = targetLocalInAttach.y;
    this.debugLog(
      `attach align pivotLocal=(${pivotLocalInAttach.x.toFixed(4)},${pivotLocalInAttach.y.toFixed(4)},${pivotLocalInAttach.z.toFixed(4)}) deltaLocal=(${deltaLocalInAttach.x.toFixed(4)},${deltaLocalInAttach.y.toFixed(4)},${deltaLocalInAttach.z.toFixed(4)})`
    );
  }

  private schedulePlantedSoilAlign(): void {
    const alignEvent = this.createEvent('DelayedCallbackEvent');
    alignEvent.bind(() => {
      if (!this.isPlanted) {
        return;
      }
      this.finalizePlantedPlacement();
    });
    alignEvent.reset(0);
  }

  private appendWorldAabbCorners(corners: vec3[], worldMin: vec3, worldMax: vec3): void {
    corners.push(
      new vec3(worldMin.x, worldMin.y, worldMin.z),
      new vec3(worldMin.x, worldMin.y, worldMax.z),
      new vec3(worldMin.x, worldMax.y, worldMin.z),
      new vec3(worldMin.x, worldMax.y, worldMax.z),
      new vec3(worldMax.x, worldMin.y, worldMin.z),
      new vec3(worldMax.x, worldMin.y, worldMax.z),
      new vec3(worldMax.x, worldMax.y, worldMin.z),
      new vec3(worldMax.x, worldMax.y, worldMax.z)
    );
  }

  private getSoilAnchorScale(growthScale: number): number {
    return growthScale;
  }

  private getAdultGrowthScale(): number {
    return this.scaleUpSize / PlantLifecycle.GROWTH_SIZE_DIVISOR;
  }

  private getCurrentGrowthScale(): number {
    const adultScale = this.getAdultGrowthScale();
    if (this.currentStage === PlantStage.Adult) {
      return adultScale;
    }

    if (this.currentStage === PlantStage.Growing) {
      const t = this.growthTime <= 0 ? 1 : Math.min(this.growthElapsed / this.growthTime, 1);
      const eased = t * t * (3 - 2 * t);
      return adultScale * Math.max(0.01, eased);
    }

    return 1;
  }

  private wireManipulationToContainer(root: SceneObject): void {
    const container = this.getSceneObject();
    const stack: SceneObject[] = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        if (isNull(script) || !this.isManipulationScript(script)) {
          continue;
        }
        script.enabled = !this.isPlanted || this.allowTrashManipulation;
        (script as unknown as InteractableManipulationLike).manipulateRootSceneObject = container;
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
  }

  private setInteractionEnabledOnHierarchy(root: SceneObject, enabled: boolean): void {
    const stack: SceneObject[] = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        if (isNull(script) || !this.isInteractionScript(script)) {
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
      if (!current || isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        if (isNull(script) || !this.isManipulationScript(script)) {
          continue;
        }
        script.enabled = enabled;
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
  }

  private disableManipulationOnHierarchy(root: SceneObject): void {
    this.setManipulationEnabledOnHierarchy(root, false);
  }

  private isManipulationScript(script: ScriptComponent): boolean {
    const candidate = script as unknown as Record<string, unknown>;
    return candidate.manipulateRootSceneObject !== undefined;
  }

  private isInteractionScript(script: ScriptComponent): boolean {
    if (this.isManipulationScript(script)) {
      return true;
    }

    const candidate = script as unknown as Record<string, unknown>;
    if (candidate.targetingMode !== undefined && candidate.onTriggerStart !== undefined) {
      return true;
    }

    return Array.isArray(candidate.onPinchUp_Select);
  }

  private notifyAnchorStateChanged(): void {
    if (isNull(this.anchorPersistence)) {
      return;
    }

    (this.anchorPersistence as AnchorPersistence).persistPlantLifecycleState(this.getSceneObject() as SceneObject);
  }

  private findParentPlantPot(): {
    tryAttachSeed?: (plant: PlantLifecycle) => boolean;
  } | null {
    let current = this.getSceneObject().getParent();
    while (!isNull(current)) {
      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as {
          tryAttachSeed?: (plant: PlantLifecycle) => boolean;
          hasPlant?: () => boolean;
        };
        if (
          !isNull(candidate) &&
          typeof candidate.tryAttachSeed === 'function' &&
          typeof candidate.hasPlant === 'function'
        ) {
          return candidate;
        }
      }
      current = current.getParent();
    }

    return null;
  }

  private refreshPlantedVisual(): void {
    if (this.currentStage === PlantStage.Seed) {
      this.showSeed();
      return;
    }

    if (this.currentStage === PlantStage.Growing) {
      this.showAdultAtGrowthScale();
      return;
    }

    if (this.currentStage === PlantStage.Adult) {
      this.showAdult();
      return;
    }

    this.showAdultAtGrowthScale();
  }

  private alignPlantedRootToParent(): void {
    if (!this.isPlanted) {
      return;
    }

    const transform = this.getSceneObject().getTransform();
    const scale = transform.getLocalScale();
    transform.setLocalPosition(vec3.zero());
    transform.setLocalScale(scale);
  }

  private enforcePlantedAnchor(): void {
    if (!this.isPlanted || this.allowTrashManipulation) {
      return;
    }

    const parent = this.getSceneObject().getParent();
    if (isNull(parent)) {
      return;
    }

    // Planted growth uses container offsets to keep the mesh foot on the pot soil line.
    // Do not snap back to attach origin once the plant reaches Adult stage.
    if (!isNull(this.growthScaleNode) && !isNull(this.getActiveStageModel())) {
      this.enforcePlantedContainerScale();
      this.enforcePlantedWorldRotation();
      this.applyPlantedAttachAlignment();
      return;
    }

    const localPos = this.getSceneObject().getTransform().getLocalPosition();
    if (localPos.distance(vec3.zero()) > 0.01) {
      this.alignPlantedRootToParent();
    }
  }

  private getActiveStageModel(): SceneObject | null {
    if (!isNull(this.seedInstance)) {
      return this.seedInstance;
    }
    if (!isNull(this.babyInstance)) {
      return this.babyInstance;
    }
    if (!isNull(this.adultInstance)) {
      return this.adultInstance;
    }
    return null;
  }

  private applyPlantedModelOrientation(): void {
    const model = this.getActiveStageModel();
    if (isNull(model)) {
      return;
    }

    const modelObject = model as SceneObject;
    const modelTransform = modelObject.getTransform();
    const modelScale = modelTransform.getLocalScale();
    modelTransform.setLocalPosition(vec3.zero());
    modelTransform.setLocalScale(modelScale);
  }

  private captureModelMetricsAtGrowthScale(model: SceneObject): void {
    this.withUnitGrowthScaleForMeasurement(() => {
      this.captureModelMetrics(model);
    });
  }

  private computePlantedGrowthNodeOffset(model: SceneObject): vec3 {
    return this.withUnitGrowthScaleForMeasurement(() => {
      if (isNull(this.growthScaleNode)) {
        return vec3.zero();
      }

      const growthScaleNode = this.growthScaleNode as SceneObject;
      const growthWorldToLocal = growthScaleNode.getTransform().getWorldTransform().inverse();
      const visuals = this.findAlignmentMeshVisuals(model);
      if (visuals.length === 0) {
        return vec3.zero();
      }

      const corners: vec3[] = [];
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;

      for (let i = 0; i < visuals.length; i++) {
        this.appendWorldAabbCorners(corners, visuals[i].worldAabbMin(), visuals[i].worldAabbMax());
      }

      for (let i = 0; i < corners.length; i++) {
        const localPoint = growthWorldToLocal.multiplyPoint(corners[i]);
        minX = Math.min(minX, localPoint.x);
        maxX = Math.max(maxX, localPoint.x);
        minY = Math.min(minY, localPoint.y);
        maxY = Math.max(maxY, localPoint.y);
        minZ = Math.min(minZ, localPoint.z);
        maxZ = Math.max(maxZ, localPoint.z);
      }

      if (minY === Infinity) {
        return vec3.zero();
      }

      let seedBurialOffset = 0;
      if (
        this.currentStage === PlantStage.Seed &&
        this.isPlanted &&
        this.requiresGoalCompletion &&
        !this.goalCompleted &&
        !this.hasBeenWatered
      ) {
        const modelHeight = Math.max(0, maxY - minY);
        seedBurialOffset =
          modelHeight * Math.max(0, Math.min(1.2, this.plantedGoalSeedBurialFraction));
      }

      return new vec3(
        -(minX + maxX) * 0.5,
        -minY - seedBurialOffset,
        -(minZ + maxZ) * 0.5
      );
    }, true);
  }

  private applyPlantedGrowthPivot(model: SceneObject): void {
    if (isNull(this.growthScaleNode)) {
      return;
    }

    const growthScaleNode = this.growthScaleNode as SceneObject;
    const growthScale = growthScaleNode.getTransform().getLocalScale();
    const pivotOffset = this.computePlantedGrowthNodeOffset(model);
    growthScaleNode.getTransform().setLocalPosition(pivotOffset);
    growthScaleNode.getTransform().setLocalScale(growthScale);
  }

  private withUnitGrowthScaleForMeasurement<T>(measure: () => T, forceUnitScale = false): T {
    if (isNull(this.growthScaleNode)) {
      return measure();
    }

    const growthScaleNode = this.growthScaleNode as SceneObject;
    const transform = growthScaleNode.getTransform();
    const savedScale = transform.getLocalScale();
    const savedPosition = transform.getLocalPosition();
    const maxAxis = Math.max(savedScale.x, savedScale.y, savedScale.z);
    const useUnitScale = forceUnitScale || maxAxis < 0.001;

    if (useUnitScale) {
      transform.setLocalScale(vec3.one());
      if (forceUnitScale) {
        transform.setLocalPosition(vec3.zero());
      } else {
        transform.setLocalPosition(new vec3(savedPosition.x, 0, savedPosition.z));
      }
    }

    const result = measure();

    if (useUnitScale) {
      transform.setLocalScale(savedScale);
      if (!forceUnitScale) {
        transform.setLocalPosition(savedPosition);
      }
    }

    return result;
  }

  private centerActiveModelInGrowthSpace(): void {
    const model = this.getActiveStageModel();
    if (isNull(model) || isNull(this.growthScaleNode)) {
      return;
    }

    if (this.isPlanted) {
      this.applyPlantedGrowthPivot(model as SceneObject);
      return;
    }

    const growthScaleNode = this.growthScaleNode as SceneObject;
    const growthWorldToLocal = growthScaleNode.getTransform().getWorldTransform().inverse();
    const visuals = this.findAlignmentMeshVisuals(model as SceneObject);
    if (visuals.length === 0) {
      return;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < visuals.length; i++) {
      const localMin = growthWorldToLocal.multiplyPoint(visuals[i].worldAabbMin());
      const localMax = growthWorldToLocal.multiplyPoint(visuals[i].worldAabbMax());
      minX = Math.min(minX, localMin.x, localMax.x);
      maxX = Math.max(maxX, localMin.x, localMax.x);
      minY = Math.min(minY, localMin.y, localMax.y);
      maxY = Math.max(maxY, localMin.y, localMax.y);
      minZ = Math.min(minZ, localMin.z, localMax.z);
      maxZ = Math.max(maxZ, localMin.z, localMax.z);
    }

    const centerX = (minX + maxX) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const growthScale = growthScaleNode.getTransform().getLocalScale();
    growthScaleNode.getTransform().setLocalPosition(
      new vec3(-centerX, -centerY, -centerZ)
    );
    growthScaleNode.getTransform().setLocalScale(growthScale);

    this.debugLog(
      `centered model bounds=(${minX.toFixed(2)},${minY.toFixed(2)},${minZ.toFixed(2)})-(${maxX.toFixed(2)},${maxY.toFixed(2)},${maxZ.toFixed(2)}) offset=(${(-centerX).toFixed(2)},${(-centerY).toFixed(2)},${(-centerZ).toFixed(2)})`
    );
  }

  private resetAlignmentForPot(): void {
    this.alignCenterX = 0;
    this.alignCenterZ = 0;
    this.modelLocalBaseY = 0;

    const stageRoot = this.ensureStageRoot();
    stageRoot.getTransform().setLocalPosition(vec3.zero());
    stageRoot.getTransform().setLocalRotation(quat.quatIdentity());

    const alignNode = this.ensureAlignNode();
    alignNode.getTransform().setLocalPosition(vec3.zero());
    alignNode.getTransform().setLocalRotation(quat.quatIdentity());

    if (!isNull(this.growthScaleNode)) {
      const growthScaleNode = this.growthScaleNode as SceneObject;
      const growthScale = growthScaleNode.getTransform().getLocalScale();
      growthScaleNode.getTransform().setLocalPosition(vec3.zero());
      growthScaleNode.getTransform().setLocalRotation(quat.quatIdentity());
      growthScaleNode.getTransform().setLocalScale(growthScale);
    }

    this.applyPlantedModelOrientation();
    if (this.currentStage === PlantStage.Seed && !isNull(this.seedInstance)) {
      (this.seedInstance as SceneObject).getTransform().setLocalScale(
        new vec3(this.seedScale, this.seedScale, this.seedScale)
      );
    }
    this.finalizePlantedPlacement();
  }

  private applyPlantedSoilAnchor(preserveContainerPlacement = false): void {
    if (!this.isPlanted) {
      return;
    }

    this.applyPlantedModelOrientation();
    this.finalizePlantedPlacement({ preserveContainerPlacement });
  }

  private finalizePlantedPlacement(options?: { preserveContainerPlacement?: boolean }): void {
    if (!this.isPlanted) {
      return;
    }

    const model = this.getActiveStageModel();
    this.alignCenterX = 0;
    this.alignCenterZ = 0;

    if (!options?.preserveContainerPlacement) {
      this.alignPlantedRootToParent();
    }
    this.enforcePlantedContainerScale();
    this.enforcePlantedWorldRotation();

    if (!isNull(model)) {
      this.applyPlantedGrowthPivot(model as SceneObject);
    }

    this.refreshAlignNodePosition(this.getCurrentGrowthScale());
  }

  private hasSavedPlantedAlignment(state: PlantLifecycleSaveState): boolean {
    return (
      state.plantedModelLocalBaseY !== undefined &&
      state.plantedAlignY !== undefined
    );
  }

  private restorePlantedAlignment(state: PlantLifecycleSaveState): void {
    this.modelLocalBaseY = state.plantedModelLocalBaseY ?? 0;
    this.alignCenterX = state.plantedAlignCenterX ?? 0;
    this.alignCenterZ = state.plantedAlignCenterZ ?? 0;

    if (!isNull(this.growthScaleNode) && state.plantedGrowthOffsetX !== undefined) {
      const growthScaleNode = this.growthScaleNode as SceneObject;
      const growthScale = growthScaleNode.getTransform().getLocalScale();
      growthScaleNode.getTransform().setLocalPosition(
        new vec3(
          state.plantedGrowthOffsetX,
          state.plantedGrowthOffsetY ?? 0,
          state.plantedGrowthOffsetZ ?? 0
        )
      );
      growthScaleNode.getTransform().setLocalScale(growthScale);
    }

    if (!isNull(this.alignNode)) {
      (this.alignNode as SceneObject).getTransform().setLocalPosition(
        new vec3(
          this.alignCenterX,
          state.plantedAlignY ?? 0,
          this.alignCenterZ
        )
      );
    }

    this.alignPlantedRootToParent();
    this.enforcePlantedWorldRotation();
  }

  private enforcePlantedWorldRotation(): void {
    if (!this.isPlanted || isNull(this.plantedPreserveWorldRotation)) {
      return;
    }

    this.getSceneObject().getTransform().setWorldRotation(this.plantedPreserveWorldRotation);
  }

  private enforcePlantedContainerScale(): void {
    if (!this.isPlanted || isNull(this.plantedPreserveWorldScale)) {
      return;
    }

    const container = this.getSceneObject();
    const parent = container.getParent();
    if (isNull(parent)) {
      return;
    }

    const parentWorldScale = this.getHierarchyWorldScale(parent);
    container.getTransform().setLocalScale(
      this.getLocalScaleForWorldScale(this.plantedPreserveWorldScale, parentWorldScale)
    );
  }

  private getLocalScaleForWorldScale(worldScale: vec3, parentWorldScale: vec3): vec3 {
    const epsilon = 0.0001;
    return new vec3(
      worldScale.x / Math.max(epsilon, parentWorldScale.x),
      worldScale.y / Math.max(epsilon, parentWorldScale.y),
      worldScale.z / Math.max(epsilon, parentWorldScale.z)
    );
  }

  private updateInteractionForPlantedState(): void {
    const root = this.getSceneObject() as SceneObject;
    if (this.isPlanted && !this.allowTrashManipulation) {
      this.setInteractionEnabledOnHierarchy(root, false);
      return;
    }

    this.enableRemoteGrabTargeting(root);
    this.wireManipulationToContainer(root);
    this.setInteractionEnabledOnHierarchy(root, true);
  }

  private enableRemoteGrabTargeting(root: SceneObject): void {
    const stack: SceneObject[] = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as {
          targetingMode?: number;
          ignoreInteractionPlane?: boolean;
          onTriggerStart?: unknown;
        };
        if (
          isNull(candidate) ||
          candidate.targetingMode === undefined ||
          candidate.onTriggerStart === undefined
        ) {
          continue;
        }

        // Movable seeds use direct/indirect pinch only. Poke is incompatible
        // with InteractableManipulation and produced a native SIK warning.
        candidate.targetingMode = 3;
        if (candidate.ignoreInteractionPlane !== undefined) {
          candidate.ignoreInteractionPlane = true;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
  }

  private applyClonedBabyMaterial(root: SceneObject): void {
    if (isNull(this.babyMaterialTemplate)) {
      this.debugLog('applyBabyMaterial skipped: babyMaterialTemplate is null');
      return;
    }

    this.debugLog(`applyBabyMaterial root=${root.name}`);
    this.clonedBabyMaterial = this.babyMaterialTemplate.clone();
    if (!isNull(this.plantTexture)) {
      this.clonedBabyMaterial.mainPass.Tweak_N0 = this.plantTexture;
      this.debugLog(`clone assigned texture=${this.plantTexture.name} to mainPass.Tweak_N0`);
    } else {
      this.debugLog('clone has no plantTexture assigned');
    }

    const visuals = this.findChildMeshVisuals(root);
    this.debugLog(`applyBabyMaterial found ${visuals.length} child render visuals`);
    for (let i = 0; i < visuals.length; i++) {
      visuals[i].mainMaterial = this.clonedBabyMaterial;
      this.debugLog(`applied cloned material to child visual ${visuals[i].getSceneObject().name}`);
    }
  }

  private applyGrowthScale(): void {
    const growthScaleNode = this.growthScaleNode;
    if (isNull(growthScaleNode)) {
      return;
    }

    const scale = this.getCurrentGrowthScale();
    (growthScaleNode as SceneObject).getTransform().setLocalScale(new vec3(scale, scale, scale));
    if (this.isPlanted) {
      this.enforcePlantedContainerScale();
      this.enforcePlantedWorldRotation();
      this.applyPlantedAttachAlignment();
      return;
    }

    this.refreshAlignNodePosition(scale);
  }

  private applyAdultScale(): void {
    const growthScaleNode = this.growthScaleNode;
    if (isNull(growthScaleNode)) {
      return;
    }

    const adultScale = this.getAdultGrowthScale();
    (growthScaleNode as SceneObject).getTransform().setLocalScale(
      new vec3(adultScale, adultScale, adultScale)
    );
    if (this.isPlanted) {
      this.enforcePlantedContainerScale();
      this.enforcePlantedWorldRotation();
      this.finalizePlantedPlacement({ preserveContainerPlacement: true });
      return;
    }

    this.refreshAlignNodePosition(adultScale);
  }

  private destroyCurrentInstances(): void {
    if (!isNull(this.seedInstance)) {
      const seedInstance = this.seedInstance as SceneObject;
      this.disableManipulationOnHierarchy(seedInstance);
      seedInstance.destroy();
      this.seedInstance = null;
    }

    if (!isNull(this.babyInstance)) {
      const babyInstance = this.babyInstance as SceneObject;
      this.disableManipulationOnHierarchy(babyInstance);
      babyInstance.destroy();
      this.babyInstance = null;
    }

    if (!isNull(this.adultInstance)) {
      const adultInstance = this.adultInstance as SceneObject;
      this.disableManipulationOnHierarchy(adultInstance);
      adultInstance.destroy();
      this.adultInstance = null;
    }
  }

  private findChildMeshVisuals(root: SceneObject): RenderMeshVisual[] {
    const results: RenderMeshVisual[] = [];
    const stack: SceneObject[] = [];

    for (let i = 0; i < root.getChildrenCount(); i++) {
      stack.push(root.getChild(i));
    }

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const visuals = current.getComponents('Component.RenderMeshVisual');
      for (let i = 0; i < visuals.length; i++) {
        results.push(visuals[i]);
        this.debugLog(`found render visual on ${current.name}`);
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return results;
  }

  private findAlignmentMeshVisuals(root: SceneObject): RenderMeshVisual[] {
    const visuals = this.findChildMeshVisuals(root);
    const filtered: RenderMeshVisual[] = [];

    for (let i = 0; i < visuals.length; i++) {
      if (this.shouldIncludeMeshVisualForAlignment(visuals[i])) {
        filtered.push(visuals[i]);
      }
    }

    return filtered;
  }

  private shouldIncludeMeshVisualForAlignment(visual: RenderMeshVisual): boolean {
    const object = visual.getSceneObject();
    if (!object || isNull(object) || !object.enabled) {
      return false;
    }

    const ownerName = object.name;
    if (ownerName.indexOf('Sphere') === 0) {
      return false;
    }

    return true;
  }

  private localOffsetToWorldOffset(localOffset: vec3, referenceObject: SceneObject): vec3 {
    const world = referenceObject.getTransform().getWorldTransform();
    const origin = world.multiplyPoint(vec3.zero());
    const offsetEnd = world.multiplyPoint(localOffset);
    return new vec3(
      offsetEnd.x - origin.x,
      offsetEnd.y - origin.y,
      offsetEnd.z - origin.z
    );
  }

  private refreshGoalLabel(): void {
    const hasGoal = this.requiresGoalCompletion && !!String(this.goalText || '').trim();
    if (!hasGoal) {
      if (!isNull(this.goalLabelRoot)) {
        this.goalLabelRoot.enabled = false;
      }
      return;
    }

    this.ensureGoalLabelVisual();
    if (isNull(this.goalLabelRoot) || isNull(this.goalLabelText3D)) {
      return;
    }

    const prefix = this.goalCompleted ? 'Goal complete:' : 'Goal:';
    this.goalLabelText3D.text = `${prefix} ${this.goalText}`;
    this.updateGoalLabelLayout();
    this.updateGoalLabelTextColor();
    this.goalLabelRoot.enabled = true;
    this.updateGoalLabelTransform();
  }

  private ensureGoalLabelVisual(): void {
    if (!isNull(this.goalLabelRoot) && !isNull(this.goalLabelText3D)) {
      return;
    }

    const host = this.getSceneObject();
    const root = global.scene.createSceneObject('GoalLabel');
    root.setParent(host);
    root.layer = host.layer;
    root.enabled = false;
    root.getTransform().setLocalPosition(PlantLifecycle.GOAL_LABEL_FALLBACK_OFFSET);
    root.getTransform().setLocalRotation(quat.quatIdentity());

    const text3d = root.createComponent('Component.Text3D') as Text3D;
    text3d.enabled = true;
    text3d.text = '';
    text3d.size = PlantLifecycle.GOAL_LABEL_TEXT_SIZE;
    text3d.extrusionDepth = 0.06;
    text3d.lineSpacing = 1.05;
    text3d.horizontalAlignment = HorizontalAlignment.Center;
    text3d.verticalAlignment = VerticalAlignment.Center;
    text3d.horizontalOverflow = HorizontalOverflow.Shrink;
    text3d.verticalOverflow = VerticalOverflow.Overflow;
    text3d.renderOrder = 31;

    try {
      const template = requireAsset('Text3D.mat') as Material;
      this.goalLabelTextMaterial = template.clone();
      text3d.mainMaterial = this.goalLabelTextMaterial;
    } catch (_error) {
      this.goalLabelTextMaterial = null;
    }

    const backgroundObject = global.scene.createSceneObject('GoalLabelBackground');
    backgroundObject.setParent(root);
    backgroundObject.layer = host.layer;
    backgroundObject.getTransform().setLocalPosition(new vec3(0, 0, -0.04));
    backgroundObject.getTransform().setLocalRotation(quat.quatIdentity());

    const background = backgroundObject.createComponent(
      'Component.RenderMeshVisual'
    ) as RenderMeshVisual;
    background.enabled = true;
    background.mesh = requireAsset('Meshes/StarCatchSphere.mesh') as RenderMesh;
    background.mainMaterial = this.createGoalLabelBackgroundMaterial();
    background.renderOrder = 30;

    this.goalLabelRoot = root;
    this.goalLabelText3D = text3d;
    this.goalLabelBackground = background;
    this.goalLabelLookAt = root.createComponent('Component.LookAtComponent') as LookAtComponent;
    if (!isNull(this.goalLabelLookAt)) {
      this.goalLabelLookAt.lookAtMode = LookAtComponent.LookAtMode.LookAtPoint;
      this.goalLabelLookAt.aimVectors = LookAtComponent.AimVectors.ZAimYUp;
      this.goalLabelLookAt.worldUpVector = LookAtComponent.WorldUpVector.SceneY;
      this.goalLabelLookAt.enabled = false;
    }
  }

  private updateGoalLabelLayout(): void {
    if (isNull(this.goalLabelText3D)) {
      return;
    }

    const text = String(this.goalLabelText3D.text || '').trim();
    const labelWidth = Math.max(
      PlantLifecycle.GOAL_LABEL_MIN_WIDTH,
      Math.min(PlantLifecycle.GOAL_LABEL_MAX_WIDTH, text.length * 0.32 + 3.8)
    );
    this.goalLabelText3D.worldSpaceRect = Rect.create(
      -labelWidth * 0.5,
      labelWidth * 0.5,
      -PlantLifecycle.GOAL_LABEL_HALF_HEIGHT,
      PlantLifecycle.GOAL_LABEL_HALF_HEIGHT
    );

    if (!isNull(this.goalLabelBackground)) {
      this.goalLabelBackground
        .getSceneObject()
        .getTransform()
        .setLocalScale(
          new vec3(
            labelWidth,
            PlantLifecycle.GOAL_LABEL_HALF_HEIGHT * 2.2,
            PlantLifecycle.GOAL_LABEL_DEPTH
          )
        );
    }
  }

  private updateGoalLabelTextColor(): void {
    if (isNull(this.goalLabelTextMaterial)) {
      return;
    }

    const pass = this.goalLabelTextMaterial.mainPass as unknown as Record<string, unknown>;
    const color = this.goalCompleted
      ? PlantLifecycle.GOAL_LABEL_COMPLETE_TEXT_COLOR
      : PlantLifecycle.GOAL_LABEL_TEXT_COLOR;
    for (let i = 0; i < PlantLifecycle.GOAL_LABEL_TEXT_COLOR_KEYS.length; i++) {
      this.trySetGoalLabelPassValue(pass, PlantLifecycle.GOAL_LABEL_TEXT_COLOR_KEYS[i], color);
    }
    this.trySetGoalLabelPassValue(pass, 'depthWrite', false);
    this.trySetGoalLabelPassValue(pass, 'depthTest', true);
  }

  private createGoalLabelBackgroundMaterial(): Material {
    let material: Material | null = null;
    try {
      const template = requireAsset('Materials & Shaders/Mat_AIChatBlack.mat') as Material;
      material = template.clone();
    } catch (_error) {
      material = null;
    }

    if (isNull(material)) {
      return requireAsset('Text3D.mat') as Material;
    }

    const pass = material.mainPass as unknown as Record<string, unknown>;
    this.trySetGoalLabelPassValue(
      pass,
      'baseColor',
      PlantLifecycle.GOAL_LABEL_BACKGROUND_COLOR
    );
    this.trySetGoalLabelPassValue(pass, 'depthWrite', false);
    this.trySetGoalLabelPassValue(pass, 'depthTest', true);
    this.trySetGoalLabelPassValue(pass, 'blendMode', BlendMode.PremultipliedAlphaAuto);
    return material;
  }

  private trySetGoalLabelPassValue(
    pass: Record<string, unknown>,
    key: string,
    value: unknown
  ): void {
    try {
      pass[key] = value;
    } catch (_error) {
      // Some material passes expose a restricted property set.
    }
  }

  private updateGoalLabelTransform(): void {
    if (isNull(this.goalLabelRoot) || !this.goalLabelRoot.enabled) {
      return;
    }

    const hostScale = this.getHierarchyWorldScale(this.getSceneObject());
    const invX = 1 / Math.max(0.001, Math.abs(hostScale.x));
    const invY = 1 / Math.max(0.001, Math.abs(hostScale.y));
    const invZ = 1 / Math.max(0.001, Math.abs(hostScale.z));
    this.goalLabelRoot.getTransform().setLocalScale(new vec3(invX, invY, invZ));
    this.goalLabelRoot
      .getTransform()
      .setLocalPosition(this.measureGoalLabelLocalPosition());

    if (isNull(this.goalLabelLookAt)) {
      return;
    }
    if (isNull(this.goalLabelCamera)) {
      this.goalLabelCamera = this.findCameraObject();
    }
    if (isNull(this.goalLabelCamera)) {
      this.goalLabelLookAt.enabled = false;
      return;
    }

    this.goalLabelLookAt.target = this.goalLabelCamera;
    this.goalLabelLookAt.enabled = true;
  }

  private measureGoalLabelLocalPosition(): vec3 {
    const fallback = PlantLifecycle.GOAL_LABEL_FALLBACK_OFFSET;
    const model = this.getActiveStageModel();
    if (isNull(model)) {
      return fallback;
    }

    const hostWorldToLocal = this.getSceneObject()
      .getTransform()
      .getWorldTransform()
      .inverse();
    const visuals = this.findChildMeshVisuals(model as SceneObject);
    if (visuals.length === 0) {
      return fallback;
    }

    const corners: vec3[] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < visuals.length; i++) {
      if (isNull(visuals[i]) || !visuals[i].enabled) {
        continue;
      }
      this.appendWorldAabbCorners(corners, visuals[i].worldAabbMin(), visuals[i].worldAabbMax());
    }

    for (let i = 0; i < corners.length; i++) {
      const localPoint = hostWorldToLocal.multiplyPoint(corners[i]);
      minX = Math.min(minX, localPoint.x);
      maxX = Math.max(maxX, localPoint.x);
      minY = Math.min(minY, localPoint.y);
      maxY = Math.max(maxY, localPoint.y);
      minZ = Math.min(minZ, localPoint.z);
      maxZ = Math.max(maxZ, localPoint.z);
    }

    if (minY === Infinity || maxY === -Infinity) {
      return fallback;
    }

    return new vec3(
      (minX + maxX) * 0.5,
      Math.min(
        -PlantLifecycle.GOAL_LABEL_MIN_BELOW_OFFSET_Y,
        minY - PlantLifecycle.GOAL_LABEL_MARGIN_Y
      ),
      (minZ + maxZ) * 0.5
    );
  }

  private findCameraObject(): SceneObject | null {
    const preferredNames = ['Camera Object', 'Camera', 'Device Camera'];
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < preferredNames.length; i++) {
      for (let r = 0; r < rootCount; r++) {
        const found = this.findObjectByName(global.scene.getRootObject(r), preferredNames[i]);
        if (!isNull(found)) {
          return found;
        }
      }
    }
    return null;
  }

  private findObjectByName(node: SceneObject, name: string): SceneObject | null {
    if (isNull(node)) {
      return null;
    }
    if (String(node.name || '') === name) {
      return node;
    }
    for (let i = 0; i < node.getChildrenCount(); i++) {
      const found = this.findObjectByName(node.getChild(i), name);
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private debugLog(message: string): void {
    if (!this.debugPlantMaterials) {
      return;
    }
    print(`[PlantLifecycle] ${this.getSceneObject().name}: ${message}`);
  }

  private normalizeStage(stage: number): PlantStage {
    const clamped = this.clampStage(stage);
    if (clamped === PlantStage.Baby || clamped === PlantStage.WateredBaby) {
      return PlantStage.Growing;
    }
    return clamped;
  }

  private clampStage(stage: number): PlantStage {
    if (stage <= PlantStage.Seed) {
      return PlantStage.Seed;
    }
    if (stage >= PlantStage.Adult) {
      return PlantStage.Adult;
    }
    return stage as PlantStage;
  }
}

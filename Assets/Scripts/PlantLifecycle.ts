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
};

type AnchorPersistence = {
  persistPlantLifecycleState(plantContainer: SceneObject): void;
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
  seedScale: number = 0.02;

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
  private visualStateApplied = false;
  private static readonly DEFAULT_CONTAINER_WORLD_SCALE = 0.1;
  private static readonly GROWTH_SIZE_DIVISOR = 3;

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
      this.enforcePlantedContainerScale();
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

  public water(): boolean {
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
      this.startGrowth();
      playInteractionSound((sounds) => sounds.playWatering());
      print(
        `[PlantLifecycle] ${this.getSceneObject().name}: watered seed -> growing (${this.growthTime.toFixed(1)}s to adult)`
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
      hasBeenWatered: this.hasBeenWatered,
      isPlanted: this.isPlanted,
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
    this.currentStage = this.normalizeStage(state.stage);
    this.isPlanted = state.isPlanted;

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
      if (isNull(this.plantedPreserveWorldScale)) {
        this.applyDefaultPlantedWorldScale();
      }
      if (!isNull(state.plantedWorldRotation)) {
        this.applyPlantedWorldRotation(state.plantedWorldRotation as quat);
      } else {
        this.enforcePlantedWorldRotation();
      }
      this.enforcePlantedContainerScale();
      if (
        this.currentStage === PlantStage.Seed ||
        this.currentStage === PlantStage.Adult ||
        this.currentStage === PlantStage.Growing
      ) {
        if (this.hasSavedPlantedAlignment(state)) {
          this.restorePlantedAlignment(state);
        } else if (this.currentStage !== PlantStage.Seed) {
          this.applyPlantedSoilAnchor();
        }
      }
      this.updateInteractionForPlantedState();
    }
  }

  private createUpdateLoop(): void {
    this.updateEvent = this.createEvent('UpdateEvent');
    this.updateEvent.bind(() => this.onUpdate());
    this.updateEvent.enabled = true;
  }

  private onUpdate(): void {
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
      this.growthElapsed += getDeltaTime();
      this.applyGrowthScale();

      if (this.growthTime <= 0 || this.growthElapsed >= this.growthTime) {
        this.currentStage = PlantStage.Adult;
        this.growthElapsed = Math.max(0, this.growthTime);
        this.applyAdultScale();
        this.updateInteractionForPlantedState();
        this.notifyAnchorStateChanged();
        playInteractionSound((sounds) => sounds.playGrowthComplete());
        print(`[PlantLifecycle] ${this.getSceneObject().name}: growth complete -> adult`);
      }
    }
  }

  private startGrowth(): void {
    this.currentStage = PlantStage.Growing;
    this.growthElapsed = 0;
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
    if (this.allowTrashManipulation) {
      this.updateInteractionForPlantedState();
    }
  }

  private showAdultAtGrowthScale(): void {
    this.captureAlignCenterFromCurrentModel();
    this.destroyCurrentInstances();

    const parent = this.ensureGrowthScaleNode();
    this.adultInstance = this.spawnAdultModel(parent);

    if (this.isPlanted && this.growthElapsed <= 0) {
      this.applyPlantedSoilAnchor(true);
    } else if (!this.isPlanted) {
      this.updateInteractionForPlantedState();
    }

    this.applyGrowthScale();
  }

  private showAdult(): void {
    this.destroyCurrentInstances();
    const parent = this.ensureGrowthScaleNode();
    this.adultInstance = this.spawnAdultModel(parent);
    this.applyAdultScale();
    if (!this.isPlanted) {
      this.updateInteractionForPlantedState();
    }
  }

  private spawnAdultModel(parent: SceneObject): SceneObject {
    const adult = this.adultPlantPrefab.instantiate(parent);
    adult.name = 'AdultPlantModel';
    this.debugLog(`spawn adult root=${adult.name} parent=${parent.name}`);
    this.prepareStageModel(adult);
    this.captureModelMetrics(adult);
    this.refreshAlignNodePosition(this.getCurrentGrowthScale());
    return adult;
  }

  private prepareStageModel(model: SceneObject): void {
    model.getTransform().setLocalPosition(vec3.zero());
    model.getTransform().setLocalRotation(quat.quatIdentity());
    model.getTransform().setLocalScale(vec3.one());
    this.wireManipulationToContainer(model);
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
    const visuals = this.findChildMeshVisuals(current as SceneObject);
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
    const visuals = this.findChildMeshVisuals(model);
    let minY = Infinity;

    for (let i = 0; i < visuals.length; i++) {
      const localMin = modelWorldToLocal.multiplyPoint(visuals[i].worldAabbMin());
      minY = Math.min(minY, localMin.y);
    }

    this.modelLocalBaseY = minY === Infinity ? 0 : minY;
  }

  private refreshAlignNodePosition(growthScale: number): void {
    const alignNode = this.ensureAlignNode();
    const soilAnchorScale = this.getSoilAnchorScale(growthScale);
    alignNode.getTransform().setLocalPosition(
      new vec3(
        this.alignCenterX,
        -soilAnchorScale * this.modelLocalBaseY,
        this.alignCenterZ
      )
    );
  }

  private getSoilAnchorScale(growthScale: number): number {
    if (this.currentStage === PlantStage.Seed && !isNull(this.seedInstance)) {
      const seedLocalScale = (this.seedInstance as SceneObject).getTransform().getLocalScale();
      return growthScale * seedLocalScale.y;
    }

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
      return adultScale * eased;
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

  private disableManipulationOnHierarchy(root: SceneObject): void {
    this.setInteractionEnabledOnHierarchy(root, false);
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

  private computeModelXZCenterOffsetInGrowthSpace(model: SceneObject): vec3 {
    return this.withUnitGrowthScaleForMeasurement(() => {
      if (isNull(this.growthScaleNode)) {
        return vec3.zero();
      }

      const growthScaleNode = this.growthScaleNode as SceneObject;
      const growthWorldToLocal = growthScaleNode.getTransform().getWorldTransform().inverse();
      const visuals = this.findChildMeshVisuals(model);
      if (visuals.length === 0) {
        return vec3.zero();
      }

      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;

      for (let i = 0; i < visuals.length; i++) {
        const localMin = growthWorldToLocal.multiplyPoint(visuals[i].worldAabbMin());
        const localMax = growthWorldToLocal.multiplyPoint(visuals[i].worldAabbMax());
        minX = Math.min(minX, localMin.x, localMax.x);
        maxX = Math.max(maxX, localMin.x, localMax.x);
        minZ = Math.min(minZ, localMin.z, localMax.z);
        maxZ = Math.max(maxZ, localMin.z, localMax.z);
      }

      return new vec3((minX + maxX) * 0.5, 0, (minZ + maxZ) * 0.5);
    });
  }

  private withUnitGrowthScaleForMeasurement<T>(measure: () => T): T {
    if (isNull(this.growthScaleNode)) {
      return measure();
    }

    const growthScaleNode = this.growthScaleNode as SceneObject;
    const transform = growthScaleNode.getTransform();
    const savedScale = transform.getLocalScale();
    const savedPosition = transform.getLocalPosition();
    const maxAxis = Math.max(savedScale.x, savedScale.y, savedScale.z);

    if (maxAxis < 0.001) {
      transform.setLocalScale(vec3.one());
      transform.setLocalPosition(new vec3(savedPosition.x, 0, savedPosition.z));
    }

    const result = measure();

    if (maxAxis < 0.001) {
      transform.setLocalScale(savedScale);
      transform.setLocalPosition(savedPosition);
    }

    return result;
  }

  private centerActiveModelInGrowthSpace(): void {
    const model = this.getActiveStageModel();
    if (isNull(model) || isNull(this.growthScaleNode)) {
      return;
    }

    const growthScaleNode = this.growthScaleNode as SceneObject;
    const growthWorldToLocal = growthScaleNode.getTransform().getWorldTransform().inverse();
    const visuals = this.findChildMeshVisuals(model as SceneObject);
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
    const offsetY = this.isPlanted ? 0 : -centerY;
    growthScaleNode.getTransform().setLocalPosition(
      new vec3(-centerX, offsetY, -centerZ)
    );
    growthScaleNode.getTransform().setLocalScale(growthScale);

    if (this.isPlanted) {
      this.captureModelMetrics(model as SceneObject);
      this.alignCenterX = 0;
      this.alignCenterZ = 0;
      this.refreshAlignNodePosition(this.getCurrentGrowthScale());
    }

    this.debugLog(
      `centered planted model bounds=(${minX.toFixed(2)},${minY.toFixed(2)},${minZ.toFixed(2)})-(${maxX.toFixed(2)},${maxY.toFixed(2)},${maxZ.toFixed(2)}) offset=(${(-centerX).toFixed(2)},${this.isPlanted ? (-this.modelLocalBaseY).toFixed(2) : (-centerY).toFixed(2)},${(-centerZ).toFixed(2)})`
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
    this.centerActiveModelInGrowthSpace();
    this.alignPlantedRootToParent();
    this.enforcePlantedContainerScale();
    this.enforcePlantedWorldRotation();
  }

  private applyPlantedSoilAnchor(preserveContainerPlacement = false): void {
    if (!this.isPlanted) {
      return;
    }

    this.applyPlantedModelOrientation();

    const model = this.getActiveStageModel();
    if (!isNull(model)) {
      this.captureModelMetricsAtGrowthScale(model as SceneObject);
      this.alignCenterX = 0;
      this.alignCenterZ = 0;
    }

    if (!isNull(this.growthScaleNode) && !isNull(model)) {
      const growthScaleNode = this.growthScaleNode as SceneObject;
      const growthScale = growthScaleNode.getTransform().getLocalScale();
      const xzCenter = this.computeModelXZCenterOffsetInGrowthSpace(model as SceneObject);
      growthScaleNode.getTransform().setLocalPosition(
        new vec3(-xzCenter.x, 0, -xzCenter.z)
      );
      growthScaleNode.getTransform().setLocalScale(growthScale);
    } else if (!isNull(this.growthScaleNode)) {
      const growthScaleNode = this.growthScaleNode as SceneObject;
      const growthScale = growthScaleNode.getTransform().getLocalScale();
      growthScaleNode.getTransform().setLocalPosition(vec3.zero());
      growthScaleNode.getTransform().setLocalScale(growthScale);
    }

    this.refreshAlignNodePosition(this.getCurrentGrowthScale());
    if (!preserveContainerPlacement) {
      this.alignPlantedRootToParent();
    }
    this.enforcePlantedWorldRotation();
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

    this.wireManipulationToContainer(root);
    this.setInteractionEnabledOnHierarchy(root, true);
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
    this.refreshAlignNodePosition(scale);
    if (this.isPlanted) {
      this.enforcePlantedContainerScale();
    }
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
    this.refreshAlignNodePosition(adultScale);
    if (this.isPlanted) {
      this.enforcePlantedContainerScale();
    }
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

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

  onAwake(): void {
    this.debugLog(`awake plantType=${this.plantTypeId}`);
    this.babyTimerRemaining = Math.max(0, this.timeAsBaby);
    this.currentStage = this.hasBeenWatered ? PlantStage.WateredBaby : PlantStage.Seed;
    this.ensureStageRoot();
    this.showSeed();
    this.createUpdateLoop();
  }

  public setAnchorPersistence(persistence: AnchorPersistence): void {
    this.anchorPersistence = persistence;
  }

  public setPlanted(planted: boolean): void {
    this.isPlanted = planted;
    this.updateManipulationForPlantedState();
    this.notifyAnchorStateChanged();
  }

  public getIsPlanted(): boolean {
    return this.isPlanted;
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

  public water(): boolean {
    if (this.requiresPlanting && !this.isPlanted) {
      this.debugLog('water ignored: plant is not planted in a pot');
      return false;
    }

    if (this.currentStage === PlantStage.Adult || this.currentStage === PlantStage.Growing) {
      return false;
    }

    this.hasBeenWatered = true;

    if (this.currentStage === PlantStage.Seed) {
      if (this.babyTimerRemaining <= 0) {
        this.babyTimerRemaining = Math.max(0, this.timeAsBaby);
      }
      this.currentStage = PlantStage.WateredBaby;
      this.showBaby();
      this.notifyAnchorStateChanged();
      return true;
    }

    if (this.babyTimerRemaining <= 0) {
      this.startGrowth();
      return true;
    }

    this.currentStage = PlantStage.WateredBaby;
    this.notifyAnchorStateChanged();
    return true;
  }

  public getSaveState(): PlantLifecycleSaveState {
    return {
      plantTypeId: this.plantTypeId,
      stage: this.currentStage,
      babyTimerRemaining: this.babyTimerRemaining,
      growthElapsed: this.growthElapsed,
      hasBeenWatered: this.hasBeenWatered,
      isPlanted: this.isPlanted,
    };
  }

  public applySaveState(state: PlantLifecycleSaveState): void {
    this.plantTypeId = state.plantTypeId;
    this.hasBeenWatered = state.hasBeenWatered;
    this.babyTimerRemaining = Math.max(0, state.babyTimerRemaining);
    this.growthElapsed = Math.max(0, state.growthElapsed);
    this.currentStage = this.clampStage(state.stage);
    this.isPlanted = state.isPlanted;

    if (this.currentStage === PlantStage.Seed) {
      this.showSeed();
    } else if (this.currentStage === PlantStage.Growing) {
      this.showAdultAtGrowthScale();
    } else if (this.currentStage === PlantStage.Adult) {
      this.showAdult();
    } else {
      this.showBaby();
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

    if (this.currentStage !== PlantStage.Seed && this.babyTimerRemaining > 0) {
      this.babyTimerRemaining = Math.max(0, this.babyTimerRemaining - getDeltaTime());
    }

    if (this.currentStage === PlantStage.WateredBaby && this.babyTimerRemaining <= 0) {
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
        this.notifyAnchorStateChanged();
      }
    }
  }

  private startGrowth(): void {
    this.currentStage = PlantStage.Growing;
    this.growthElapsed = 0;
    this.showAdultAtGrowthScale();
    this.notifyAnchorStateChanged();
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
    this.captureModelMetrics(this.babyInstance);
    this.refreshAlignNodePosition(1);
  }

  private showSeed(): void {
    this.destroyCurrentInstances();
    this.alignCenterX = 0;
    this.alignCenterZ = 0;

    const parent = this.ensureGrowthScaleNode();
    parent.getTransform().setLocalScale(vec3.one());

    if (isNull(this.seedPlantPrefab)) {
      this.debugLog('showSeed skipped: seedPlantPrefab is null, falling back to baby');
      this.showBaby();
      return;
    }

    this.seedInstance = this.seedPlantPrefab.instantiate(parent);
    this.seedInstance.name = 'SeedPlantModel';
    this.debugLog(`spawn seed root=${this.seedInstance.name} parent=${parent.name}`);
    this.prepareStageModel(this.seedInstance);
    this.seedInstance.getTransform().setLocalScale(
      new vec3(this.seedScale, this.seedScale, this.seedScale)
    );
    this.captureModelMetrics(this.seedInstance);
    this.refreshAlignNodePosition(1);
  }

  private showAdultAtGrowthScale(): void {
    this.captureAlignCenterFromCurrentModel();
    this.destroyCurrentInstances();

    const parent = this.ensureGrowthScaleNode();
    this.adultInstance = this.spawnAdultModel(parent);
    this.applyGrowthScale();
  }

  private showAdult(): void {
    this.destroyCurrentInstances();
    const parent = this.ensureGrowthScaleNode();
    this.adultInstance = this.spawnAdultModel(parent);
    this.applyAdultScale();
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
    alignNode.getTransform().setLocalPosition(
      new vec3(
        this.alignCenterX,
        -growthScale * this.modelLocalBaseY,
        this.alignCenterZ
      )
    );
  }

  private getCurrentGrowthScale(): number {
    if (this.currentStage === PlantStage.Adult) {
      return this.scaleUpSize;
    }

    if (this.currentStage === PlantStage.Growing) {
      const t = this.growthTime <= 0 ? 1 : Math.min(this.growthElapsed / this.growthTime, 1);
      const eased = t * t * (3 - 2 * t);
      return 1 + (this.scaleUpSize - 1) * eased;
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
        script.enabled = !this.isPlanted;
        (script as unknown as InteractableManipulationLike).manipulateRootSceneObject = container;
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
  }

  private disableManipulationOnHierarchy(root: SceneObject): void {
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
        script.enabled = false;
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
  }

  private isManipulationScript(script: ScriptComponent): boolean {
    const candidate = script as unknown as Record<string, unknown>;
    return candidate.manipulateRootSceneObject !== undefined;
  }

  private notifyAnchorStateChanged(): void {
    if (isNull(this.anchorPersistence)) {
      return;
    }

    (this.anchorPersistence as AnchorPersistence).persistPlantLifecycleState(this.getSceneObject() as SceneObject);
  }

  private updateManipulationForPlantedState(): void {
    const root = this.getSceneObject();
    if (this.isPlanted) {
      this.disableManipulationOnHierarchy(root as SceneObject);
    } else {
      this.wireManipulationToContainer(root as SceneObject);
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
    this.refreshAlignNodePosition(scale);
  }

  private applyAdultScale(): void {
    const growthScaleNode = this.growthScaleNode;
    if (isNull(growthScaleNode)) {
      return;
    }

    (growthScaleNode as SceneObject).getTransform().setLocalScale(
      new vec3(this.scaleUpSize, this.scaleUpSize, this.scaleUpSize)
    );
    this.refreshAlignNodePosition(this.scaleUpSize);
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

export enum PlantStage {
  Baby = 0,
  WateredBaby = 1,
  Growing = 2,
  Adult = 3,
}

export type PlantLifecycleSaveState = {
  plantTypeId: string;
  stage: number;
  babyTimerRemaining: number;
  growthElapsed: number;
  hasBeenWatered: boolean;
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
  growthTime: number = 1;

  @input('float')
  scaleUpSize: number = 1;

  @input
  hasBeenWatered: boolean = false;

  @input
  plantTypeId: string = 'default';

  @input
  babyPlantPrefab!: ObjectPrefab;

  @input
  adultPlantPrefab!: ObjectPrefab;

  @input
  plantTexture!: Texture;

  @input
  babyMaterialTemplate!: Material;

  @input
  @allowUndefined
  stageRoot!: SceneObject;

  private currentStage: PlantStage = PlantStage.Baby;
  private babyTimerRemaining = 0;
  private growthElapsed = 0;
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

  onAwake(): void {
    this.babyTimerRemaining = Math.max(0, this.timeAsBaby);
    this.currentStage = this.hasBeenWatered ? PlantStage.WateredBaby : PlantStage.Baby;
    this.ensureStageRoot();
    this.showBaby();
    this.createUpdateLoop();
  }

  public setAnchorPersistence(persistence: AnchorPersistence): void {
    this.anchorPersistence = persistence;
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
    this.currentStage = PlantStage.Baby;
    this.showBaby();
  }

  public water(): void {
    if (this.currentStage === PlantStage.Adult || this.currentStage === PlantStage.Growing) {
      return;
    }

    this.hasBeenWatered = true;
    if (this.babyTimerRemaining <= 0) {
      this.startGrowth();
      return;
    }

    this.currentStage = PlantStage.WateredBaby;
    this.notifyAnchorStateChanged();
  }

  public getSaveState(): PlantLifecycleSaveState {
    return {
      plantTypeId: this.plantTypeId,
      stage: this.currentStage,
      babyTimerRemaining: this.babyTimerRemaining,
      growthElapsed: this.growthElapsed,
      hasBeenWatered: this.hasBeenWatered,
    };
  }

  public applySaveState(state: PlantLifecycleSaveState): void {
    this.plantTypeId = state.plantTypeId;
    this.hasBeenWatered = state.hasBeenWatered;
    this.babyTimerRemaining = Math.max(0, state.babyTimerRemaining);
    this.growthElapsed = Math.max(0, state.growthElapsed);
    this.currentStage = this.clampStage(state.stage);

    if (this.currentStage === PlantStage.Growing) {
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

    if (this.babyTimerRemaining > 0) {
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
      return this.alignNode;
    }

    for (let i = 0; i < stageRoot.getChildrenCount(); i++) {
      const child = stageRoot.getChild(i);
      if (!isNull(child) && child.name === 'PlantAlignNode') {
        this.alignNode = child;
        return child;
      }
    }

    this.alignNode = global.scene.createSceneObject('PlantAlignNode');
    this.alignNode.setParent(stageRoot);
    this.alignNode.getTransform().setLocalPosition(vec3.zero());
    this.alignNode.getTransform().setLocalRotation(quat.quatIdentity());
    this.alignNode.getTransform().setLocalScale(vec3.one());
    return this.alignNode;
  }

  private ensureGrowthScaleNode(): SceneObject {
    const alignNode = this.ensureAlignNode();
    if (!isNull(this.growthScaleNode)) {
      return this.growthScaleNode;
    }

    for (let i = 0; i < alignNode.getChildrenCount(); i++) {
      const child = alignNode.getChild(i);
      if (!isNull(child) && child.name === 'PlantGrowthScale') {
        this.growthScaleNode = child;
        return child;
      }
    }

    this.growthScaleNode = global.scene.createSceneObject('PlantGrowthScale');
    this.growthScaleNode.setParent(alignNode);
    this.growthScaleNode.getTransform().setLocalPosition(vec3.zero());
    this.growthScaleNode.getTransform().setLocalRotation(quat.quatIdentity());
    this.growthScaleNode.getTransform().setLocalScale(vec3.one());
    return this.growthScaleNode;
  }

  private showBaby(): void {
    this.destroyCurrentInstances();
    this.alignCenterX = 0;
    this.alignCenterZ = 0;

    const parent = this.ensureGrowthScaleNode();
    parent.getTransform().setLocalScale(vec3.one());

    this.babyInstance = this.babyPlantPrefab.instantiate(parent);
    this.babyInstance.name = 'BabyPlantModel';
    this.prepareStageModel(this.babyInstance);
    this.applyClonedBabyMaterial(this.babyInstance);
    this.captureModelMetrics(this.babyInstance);
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
    const current = !isNull(this.babyInstance)
      ? this.babyInstance
      : !isNull(this.adultInstance)
        ? this.adultInstance
        : null;
    if (isNull(current)) {
      return;
    }

    const stageRoot = this.ensureStageRoot();
    const stageRootWorldToLocal = stageRoot.getTransform().getWorldTransform().inverse();
    const visuals = this.findMeshVisuals(current);
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
    const visuals = this.findMeshVisuals(model);
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
        script.enabled = true;
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

    this.anchorPersistence.persistPlantLifecycleState(this.getSceneObject());
  }

  private applyClonedBabyMaterial(root: SceneObject): void {
    if (isNull(this.babyMaterialTemplate)) {
      return;
    }

    this.clonedBabyMaterial = this.babyMaterialTemplate.clone();
    if (!isNull(this.plantTexture)) {
      this.clonedBabyMaterial.mainPass.baseTex = this.plantTexture;
    }

    const visuals = this.findMeshVisuals(root);
    for (let i = 0; i < visuals.length; i++) {
      visuals[i].mainMaterial = this.clonedBabyMaterial;
    }
  }

  private applyGrowthScale(): void {
    const growthScaleNode = this.growthScaleNode;
    if (isNull(growthScaleNode)) {
      return;
    }

    const scale = this.getCurrentGrowthScale();
    growthScaleNode.getTransform().setLocalScale(new vec3(scale, scale, scale));
    this.refreshAlignNodePosition(scale);
  }

  private applyAdultScale(): void {
    const growthScaleNode = this.growthScaleNode;
    if (isNull(growthScaleNode)) {
      return;
    }

    growthScaleNode.getTransform().setLocalScale(
      new vec3(this.scaleUpSize, this.scaleUpSize, this.scaleUpSize)
    );
    this.refreshAlignNodePosition(this.scaleUpSize);
  }

  private destroyCurrentInstances(): void {
    if (!isNull(this.babyInstance)) {
      this.disableManipulationOnHierarchy(this.babyInstance);
      this.babyInstance.destroy();
      this.babyInstance = null;
    }

    if (!isNull(this.adultInstance)) {
      this.disableManipulationOnHierarchy(this.adultInstance);
      this.adultInstance.destroy();
      this.adultInstance = null;
    }
  }

  private findMeshVisuals(root: SceneObject): MaterialMeshVisual[] {
    const results: MaterialMeshVisual[] = [];
    const stack: SceneObject[] = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const visuals = current.getComponents('Component.MaterialMeshVisual');
      for (let i = 0; i < visuals.length; i++) {
        results.push(visuals[i]);
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return results;
  }

  private clampStage(stage: number): PlantStage {
    if (stage <= PlantStage.Baby) {
      return PlantStage.Baby;
    }
    if (stage >= PlantStage.Adult) {
      return PlantStage.Adult;
    }
    return stage as PlantStage;
  }
}

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

  onAwake(): void {
    this.babyTimerRemaining = Math.max(0, this.timeAsBaby);
    this.currentStage = this.hasBeenWatered ? PlantStage.WateredBaby : PlantStage.Baby;
    this.ensureStageRoot();
    this.showBaby();
    this.createUpdateLoop();
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
      }
    }
  }

  private startGrowth(): void {
    this.currentStage = PlantStage.Growing;
    this.growthElapsed = 0;
    this.showAdultAtGrowthScale();
  }

  private ensureStageRoot(): SceneObject {
    if (isNull(this.stageRoot)) {
      this.stageRoot = global.scene.createSceneObject('PlantStageRoot');
      this.stageRoot.setParent(this.getSceneObject());
      this.stageRoot.getTransform().setLocalPosition(vec3.zero());
      this.stageRoot.getTransform().setLocalRotation(quat.quatIdentity());
      this.stageRoot.getTransform().setLocalScale(vec3.one());
    }
    return this.stageRoot;
  }

  private showBaby(): void {
    this.destroyCurrentInstances();
    const root = this.ensureStageRoot();
    this.babyInstance = this.babyPlantPrefab.instantiate(root);
    this.babyInstance.name = 'BabyPlantModel';
    this.babyInstance.getTransform().setLocalPosition(vec3.zero());
    this.babyInstance.getTransform().setLocalRotation(quat.quatIdentity());
    this.babyInstance.getTransform().setLocalScale(vec3.one());
    this.applyClonedBabyMaterial(this.babyInstance);
  }

  private showAdultAtGrowthScale(): void {
    this.destroyCurrentInstances();
    this.adultInstance = this.instantiateAdult();
    this.applyGrowthScale();
  }

  private showAdult(): void {
    this.destroyCurrentInstances();
    this.adultInstance = this.instantiateAdult();
    this.applyAdultScale();
  }

  private instantiateAdult(): SceneObject {
    const root = this.ensureStageRoot();
    const adult = this.adultPlantPrefab.instantiate(root);
    adult.name = 'AdultPlantModel';
    adult.getTransform().setLocalPosition(vec3.zero());
    adult.getTransform().setLocalRotation(quat.quatIdentity());
    return adult;
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
    const adult = this.adultInstance;
    if (isNull(adult)) {
      return;
    }

    const t = this.growthTime <= 0 ? 1 : Math.min(this.growthElapsed / this.growthTime, 1);
    const eased = t * t * (3 - 2 * t);
    const startScale = Math.max(0.001, this.scaleUpSize * 0.15);
    const scale = startScale + (this.scaleUpSize - startScale) * eased;
    adult.getTransform().setLocalScale(new vec3(scale, scale, scale));
  }

  private applyAdultScale(): void {
    const adult = this.adultInstance;
    if (isNull(adult)) {
      return;
    }
    adult.getTransform().setLocalScale(
      new vec3(this.scaleUpSize, this.scaleUpSize, this.scaleUpSize)
    );
  }

  private destroyCurrentInstances(): void {
    const baby = this.babyInstance;
    const adult = this.adultInstance;
    if (!isNull(baby)) {
      baby.destroy();
    }
    if (!isNull(adult)) {
      adult.destroy();
    }
    this.babyInstance = null;
    this.adultInstance = null;
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

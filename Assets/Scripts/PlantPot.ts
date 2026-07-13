import { PlantLifecycle, PlantStage } from './PlantLifecycle';
import { playInteractionSound } from './InteractionSoundRegistry';

type AnchorPersistence = {
  registerPlantedObject(objectRoot: SceneObject): void;
  releaseTrackedContentObject?: (contentRoot: SceneObject) => void;
};

type InteractableManipulationLike = ScriptComponent & {
  manipulateRootSceneObject?: SceneObject;
};

@component
export class PlantPot extends BaseScriptComponent {
  @input
  @allowUndefined
  plantAttachPoint!: SceneObject;

  @input
  @allowUndefined
  triggerCollider!: ColliderComponent;

  @input
  @allowUndefined
  anchorController!: ScriptComponent;

  @input
  onlyAcceptSeeds: boolean = true;

  @input
  disablePlantInteractionWhenPlanted: boolean = true;

  @input
  debugLogging: boolean = false;

  private plantedPlant: PlantLifecycle | null = null;
  private anchorPersistence: AnchorPersistence | null = null;

  onAwake(): void {
    this.anchorPersistence = this.getAnchorPersistenceFromInput();
    const collider = this.getTriggerCollider();
    if (isNull(collider)) {
      print('PlantPot needs a ColliderComponent on the pot or in triggerCollider.');
      return;
    }

    collider.onOverlapEnter.add((eventArgs: OverlapEnterEventArgs) => {
      this.tryPlantFromCollider(eventArgs.overlap.collider);
    });
    collider.onOverlapStay.add((eventArgs: OverlapStayEventArgs) => {
      this.tryPlantFromCollider(eventArgs.overlap.collider);
    });
  }

  public setAnchorPersistence(persistence: AnchorPersistence): void {
    this.anchorPersistence = persistence;
  }

  public hasPlant(): boolean {
    return !isNull(this.plantedPlant);
  }

  public createRestoredPlant(plantPrefab: ObjectPrefab): PlantLifecycle {
    if (!isNull(this.plantedPlant)) {
      return this.plantedPlant as PlantLifecycle;
    }

    if (isNull(plantPrefab)) {
      return null as unknown as PlantLifecycle;
    }

    const plantRoot = plantPrefab.instantiate(this.getAttachPoint());
    plantRoot.name = 'PlantedPlant';
    this.snapRestoredPlantRootToAttachPoint(plantRoot);

    const plant = this.findPlantInHierarchy(plantRoot);
    if (isNull(plant)) {
      print('PlantPot restored a plant prefab, but no PlantLifecycle was found under it.');
      return null as unknown as PlantLifecycle;
    }

    this.plantedPlant = plant;
    plant.applyDefaultPlantedWorldScale();

    if (this.disablePlantInteractionWhenPlanted) {
      this.setPlantInteractionEnabled(plantRoot, false);
    }

    this.debugLog(`restored planted ${plantRoot.name}`);
    return plant;
  }

  private tryPlantFromCollider(otherCollider: ColliderComponent): void {
    if (this.hasPlant() || isNull(otherCollider)) {
      return;
    }

    const plant = this.findPlantInAncestors(otherCollider.getSceneObject());
    if (isNull(plant)) {
      return;
    }

    if (this.onlyAcceptSeeds && plant.getSaveState().stage !== PlantStage.Seed) {
      this.debugLog('ignored plant: only seeds can be planted');
      return;
    }

    if (plant.getIsPlanted()) {
      return;
    }

    this.attachPlant(plant);
  }

  public simulatePlantForTest(plant: PlantLifecycle): void {
    this.attachPlant(plant);
  }

  public getPlantedLifecycle(): PlantLifecycle | null {
    return this.plantedPlant;
  }

  public tryWaterPlantedPlant(): boolean {
    if (isNull(this.plantedPlant)) {
      return false;
    }

    return (this.plantedPlant as PlantLifecycle).water();
  }

  private attachPlant(plant: PlantLifecycle): void {
    const plantRoot = plant.getSceneObject();
    const attachPoint = this.getAttachPoint();
    const plantTransform = plantRoot.getTransform();
    const preservedWorldScale = plant.getHierarchyWorldScale(plantRoot);
    const worldRot = plantTransform.getWorldRotation();

    plantRoot.setParent(attachPoint);
    const localScale = plantTransform.getLocalScale();
    plantTransform.setLocalPosition(vec3.zero());
    plantTransform.setLocalScale(localScale);

    this.plantedPlant = plant;
    plant.applyPlantedWorldScale(preservedWorldScale);
    plant.applyPlantedWorldRotation(worldRot);
    plant.setPlanted(true);

    if (
      !isNull(this.anchorPersistence) &&
      typeof (this.anchorPersistence as AnchorPersistence).releaseTrackedContentObject === 'function'
    ) {
      (this.anchorPersistence as AnchorPersistence).releaseTrackedContentObject!(plantRoot);
    }

    if (this.disablePlantInteractionWhenPlanted) {
      this.setPlantInteractionEnabled(plantRoot, false);
    }

    if (!isNull(this.anchorPersistence)) {
      (this.anchorPersistence as AnchorPersistence).registerPlantedObject(this.getSceneObject() as SceneObject);
    }

    playInteractionSound((sounds) => sounds.playPlantSeed());
    this.debugLog(`planted ${plantRoot.name}`);
  }

  private snapRestoredPlantRootToAttachPoint(plantRoot: SceneObject): void {
    const scale = plantRoot.getTransform().getLocalScale();
    plantRoot.getTransform().setLocalPosition(vec3.zero());
    plantRoot.getTransform().setLocalScale(scale);
  }

  private getAttachPoint(): SceneObject {
    if (!isNull(this.plantAttachPoint)) {
      return this.plantAttachPoint;
    }
    return this.getSceneObject();
  }

  private getTriggerCollider(): ColliderComponent {
    if (!isNull(this.triggerCollider)) {
      return this.triggerCollider;
    }
    return this.getSceneObject().getComponent('Component.ColliderComponent');
  }

  private getAnchorPersistenceFromInput(): AnchorPersistence | null {
    if (isNull(this.anchorController)) {
      return null;
    }

    const candidate = this.anchorController as unknown as AnchorPersistence;
    if (typeof candidate.registerPlantedObject === 'function') {
      return candidate;
    }

    return null;
  }

  private findPlantInAncestors(sceneObject: SceneObject): PlantLifecycle {
    let current = sceneObject;
    while (!isNull(current)) {
      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const plant = scripts[i] as unknown as PlantLifecycle;
        if (
          !isNull(plant) &&
          typeof plant.water === 'function' &&
          typeof plant.setPlanted === 'function'
        ) {
          return plant;
        }
      }
      current = current.getParent();
    }
    return null as unknown as PlantLifecycle;
  }

  private findPlantInHierarchy(root: SceneObject): PlantLifecycle {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const plant = scripts[i] as unknown as PlantLifecycle;
        if (
          !isNull(plant) &&
          typeof plant.water === 'function' &&
          typeof plant.setPlanted === 'function'
        ) {
          return plant;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null as unknown as PlantLifecycle;
  }

  private setPlantInteractionEnabled(root: SceneObject, enabled: boolean): void {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i] as unknown as InteractableManipulationLike & Record<string, unknown>;
        if (isNull(script)) {
          continue;
        }

        const isManipulation = script.manipulateRootSceneObject !== undefined;
        const isInteractable =
          script.targetingMode !== undefined && script.onTriggerStart !== undefined;
        const isInteractableHelper = Array.isArray(script.onPinchUp_Select);
        if (!isManipulation && !isInteractable && !isInteractableHelper) {
          continue;
        }

        (scripts[i] as ScriptComponent).enabled = enabled;
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
  }

  private disableManipulationOnHierarchy(root: SceneObject): void {
    this.setPlantInteractionEnabled(root, false);
  }

  private debugLog(message: string): void {
    if (!this.debugLogging) {
      return;
    }

    print(`[PlantPot] ${this.getSceneObject().name}: ${message}`);
  }
}

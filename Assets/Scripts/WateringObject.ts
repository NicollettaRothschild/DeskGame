import { PlantLifecycle } from './PlantLifecycle';

@component
export class WateringObject extends BaseScriptComponent {
  @input
  @allowUndefined
  triggerCollider!: ColliderComponent;

  @input('float')
  waterCooldown: number = 0.25;

  @input
  destroyAfterWatering: boolean = true;

  private lastWaterTime = -999;
  private consumed = false;

  onAwake(): void {
    const collider = this.getTriggerCollider();
    if (isNull(collider)) {
      print('WateringObject needs a ColliderComponent on this object or in triggerCollider.');
      return;
    }

    //collider.intangible = true;
    collider.onOverlapEnter.add((eventArgs: OverlapEnterEventArgs) => {
      this.tryWaterFromCollider(eventArgs.overlap.collider);
    });
    collider.onOverlapStay.add((eventArgs: OverlapStayEventArgs) => {
      this.tryWaterFromCollider(eventArgs.overlap.collider);
    });
  }

  public waterPlant(plant: PlantLifecycle): void {
    if (isNull(plant) || this.consumed) {
      return;
    }
    plant.water();
    this.consume();
  }

  private getTriggerCollider(): ColliderComponent {
    if (!isNull(this.triggerCollider)) {
      return this.triggerCollider;
    }
    return this.getSceneObject().getComponent('Component.ColliderComponent');
  }

  private tryWaterFromCollider(otherCollider: ColliderComponent): void {
    const now = getTime();
    if (this.consumed || now - this.lastWaterTime < this.waterCooldown || isNull(otherCollider)) {
      return;
    }

    const plant = this.findPlantInAncestors(otherCollider.getSceneObject());
    if (isNull(plant)) {
      return;
    }

    this.lastWaterTime = now;
    plant.water();
    this.consume();
  }

  private consume(): void {
    if (!this.destroyAfterWatering || this.consumed) {
      return;
    }

    this.consumed = true;
    this.getSceneObject().destroy();
  }

  private findPlantInAncestors(sceneObject: SceneObject): PlantLifecycle {
    let current = sceneObject;
    while (!isNull(current)) {
      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const plant = scripts[i] as unknown as PlantLifecycle;
        if (!isNull(plant) && typeof plant.water === 'function') {
          return plant;
        }
      }
      current = current.getParent();
    }
    return null as unknown as PlantLifecycle;
  }
}

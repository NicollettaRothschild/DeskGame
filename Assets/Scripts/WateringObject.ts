import { PlantLifecycle } from './PlantLifecycle';
import { PlantPot } from './PlantPot';

import { playInteractionSound } from './InteractionSoundRegistry';

type InteractableLike = ScriptComponent & {
  enabled: boolean;
};

@component
export class WateringObject extends BaseScriptComponent {
  @input
  @allowUndefined
  triggerCollider!: ColliderComponent;

  @input('float')
  waterCooldown: number = 0.25;

  @input
  destroyAfterWatering: boolean = true;

  @input
  expireIfUnused: boolean = true;

  @input('float')
  unusedLifetime: number = 15;

  private lastWaterTime = -999;
  private consumed = false;
  private expireEvent: DelayedCallbackEvent | null = null;

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
    if (plant.water()) {
      this.consume();
    }
  }

  public beginUnusedLifetime(): void {
    if (this.consumed || !this.expireIfUnused || this.unusedLifetime <= 0) {
      return;
    }

    this.cancelUnusedLifetime();
    this.expireEvent = this.createEvent('DelayedCallbackEvent');
    this.expireEvent.bind(() => this.expireUnusedWater());
    this.expireEvent.reset(this.unusedLifetime);
  }

  public cancelUnusedLifetime(): void {
    if (!isNull(this.expireEvent)) {
      this.expireEvent.enabled = false;
      this.expireEvent = null;
    }
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

    const plant = this.findPlantFromCollider(otherCollider.getSceneObject());
    if (isNull(plant)) {
      return;
    }

    this.lastWaterTime = now;
    if (plant.water()) {
      this.consume();
    }
  }

  private findPlantFromCollider(sceneObject: SceneObject): PlantLifecycle {
    const fromAncestors = this.findPlantInAncestors(sceneObject);
    if (!isNull(fromAncestors)) {
      return fromAncestors;
    }

    return this.findPlantFromPot(sceneObject);
  }

  private findPlantFromPot(sceneObject: SceneObject): PlantLifecycle {
    let current = sceneObject;
    while (!isNull(current)) {
      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const pot = scripts[i] as unknown as PlantPot;
        if (
          !isNull(pot) &&
          typeof pot.tryWaterPlantedPlant === 'function' &&
          typeof pot.getPlantedLifecycle === 'function' &&
          !isNull(pot.getPlantedLifecycle())
        ) {
          return pot.getPlantedLifecycle() as PlantLifecycle;
        }
      }
      current = current.getParent();
    }

    return null as unknown as PlantLifecycle;
  }

  private consume(): void {
    if (this.consumed) {
      return;
    }

    this.consumed = true;
    this.cancelUnusedLifetime();

    if (!this.destroyAfterWatering) {
      return;
    }

    this.hideDisableAndPark();
  }

  private expireUnusedWater(): void {
    if (this.consumed) {
      return;
    }

    this.consumed = true;
    this.cancelUnusedLifetime();
    playInteractionSound((sounds) => sounds.playWaterSplash());
    this.getSceneObject().destroy();
  }

  private hideDisableAndPark(): void {
    const root = this.getSceneObject();
    const stack: SceneObject[] = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const visuals = current.getComponents('Component.RenderMeshVisual');
      for (let i = 0; i < visuals.length; i++) {
        visuals[i].enabled = false;
      }

      const colliders = current.getComponents('Component.ColliderComponent');
      for (let i = 0; i < colliders.length; i++) {
        colliders[i].enabled = false;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i] as unknown as InteractableLike;
        if (!isNull(script) && script !== this) {
          script.enabled = false;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    root.getTransform().setWorldPosition(new vec3(0, -10000, 0));
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

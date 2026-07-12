import { PlantLifecycle, PlantStage } from './PlantLifecycle';
import { PlantPot } from './PlantPot';

type PlantPotTestApi = {
  simulatePlantForTest: (plant: PlantLifecycle) => void;
  getAttachPointWorldPosition?: () => vec3;
};

@component
export class PlantPlantingTest extends BaseScriptComponent {
  @input
  plantPrefab!: ObjectPrefab;

  @input
  potPrefab!: ObjectPrefab;

  @input
  runOnAwake: boolean = false;

  @input('float')
  maxCenterOffsetCm: number = 8;

  @input('float')
  minUprightHeightCm: number = 0.8;

  @input('float')
  minUprightRatio: number = 1.0;

  onAwake(): void {
    if (!this.runOnAwake) {
      return;
    }

    const delayed = this.createEvent('DelayedCallbackEvent');
    delayed.bind(() => this.runTest());
    delayed.reset(1);
  }

  public runTest(): boolean {
    if (isNull(this.plantPrefab) || isNull(this.potPrefab)) {
      print('[PlantPlantingTest] FAIL missing plantPrefab or potPrefab input');
      return false;
    }

    const potRoot = this.potPrefab.instantiate(this.getSceneObject());
    potRoot.name = 'PlantingTestPot';
    potRoot.getTransform().setWorldPosition(new vec3(0, 0, -80));

    const plantRoot = this.plantPrefab.instantiate(this.getSceneObject());
    plantRoot.name = 'PlantingTestPlant';
    plantRoot.getTransform().setWorldPosition(new vec3(0, 0, -80));

    const pot = this.findPot(potRoot);
    const plant = this.findPlant(plantRoot);
    if (isNull(pot) || isNull(plant)) {
      print('[PlantPlantingTest] FAIL could not find PlantPot or PlantLifecycle on prefabs');
      potRoot.destroy();
      plantRoot.destroy();
      return false;
    }

    pot.simulatePlantForTest(plant);

    const attachPoint = this.findAttachPoint(potRoot);
    const attachWorld = attachPoint.getTransform().getWorldPosition();
    const attachWorldToLocal = attachPoint.getTransform().getWorldTransform().inverse();
    const bounds = this.measureMeshBounds(plantRoot);
    if (!bounds) {
      print('[PlantPlantingTest] FAIL no mesh bounds found on planted seed');
      potRoot.destroy();
      return false;
    }

    const centerWorld = new vec3(
      (bounds.min.x + bounds.max.x) * 0.5,
      (bounds.min.y + bounds.max.y) * 0.5,
      (bounds.min.z + bounds.max.z) * 0.5
    );
    const centerLocal = attachWorldToLocal.multiplyPoint(centerWorld);
    const offset = centerLocal.distance(vec3.zero());

    const boundsLocal = this.transformBounds(bounds, attachWorldToLocal);
    const sizeX = boundsLocal.max.x - boundsLocal.min.x;
    const sizeY = boundsLocal.max.y - boundsLocal.min.y;
    const sizeZ = boundsLocal.max.z - boundsLocal.min.z;
    const width = Math.max(sizeX, sizeZ);
    const height = sizeY;
    const uprightRatio = width <= 0.001 ? 0 : height / width;

    const isSeed = plant.getSaveState().stage === PlantStage.Seed;
    const offsetPass = offset <= this.maxCenterOffsetCm;
    const uprightPass =
      !isSeed &&
      height >= this.minUprightHeightCm &&
      uprightRatio >= this.minUprightRatio;
    const seedPass = isSeed && offsetPass;

    print(
      `[PlantPlantingTest] attachLocalCenter=${centerLocal.toString()} offset=${offset.toFixed(2)}cm localSize=(${sizeX.toFixed(2)},${sizeY.toFixed(2)},${sizeZ.toFixed(2)}) uprightRatio=${uprightRatio.toFixed(2)}`
    );

    if (seedPass || (offsetPass && uprightPass)) {
      print('[PlantPlantingTest] PASS planted seed is centered with correct orientation');
      potRoot.destroy();
      return true;
    }

    print(
      `[PlantPlantingTest] FAIL offsetPass=${offsetPass} uprightPass=${uprightPass} seedPass=${seedPass} (maxOffset=${this.maxCenterOffsetCm}, minHeight=${this.minUprightHeightCm})`
    );
    potRoot.destroy();
    return false;
  }

  private findAttachPoint(potRoot: SceneObject): SceneObject {
    const stack: SceneObject[] = [potRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }
      if (current.name === 'Anchor') {
        return current;
      }
      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
    return potRoot;
  }

  private transformBounds(
    bounds: { min: vec3; max: vec3 },
    worldToLocal: mat4
  ): { min: vec3; max: vec3 } {
    const corners = [
      new vec3(bounds.min.x, bounds.min.y, bounds.min.z),
      new vec3(bounds.min.x, bounds.min.y, bounds.max.z),
      new vec3(bounds.min.x, bounds.max.y, bounds.min.z),
      new vec3(bounds.min.x, bounds.max.y, bounds.max.z),
      new vec3(bounds.max.x, bounds.min.y, bounds.min.z),
      new vec3(bounds.max.x, bounds.min.y, bounds.max.z),
      new vec3(bounds.max.x, bounds.max.y, bounds.min.z),
      new vec3(bounds.max.x, bounds.max.y, bounds.max.z),
    ];

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < corners.length; i++) {
      const local = worldToLocal.multiplyPoint(corners[i]);
      minX = Math.min(minX, local.x);
      maxX = Math.max(maxX, local.x);
      minY = Math.min(minY, local.y);
      maxY = Math.max(maxY, local.y);
      minZ = Math.min(minZ, local.z);
      maxZ = Math.max(maxZ, local.z);
    }

    return {
      min: new vec3(minX, minY, minZ),
      max: new vec3(maxX, maxY, maxZ),
    };
  }

  private measureMeshBounds(root: SceneObject): {
    min: vec3;
    max: vec3;
  } | null {
    const visuals = this.findMeshVisuals(root);
    if (visuals.length === 0) {
      return null;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < visuals.length; i++) {
      const aabbMin = visuals[i].worldAabbMin();
      const aabbMax = visuals[i].worldAabbMax();
      minX = Math.min(minX, aabbMin.x, aabbMax.x);
      maxX = Math.max(maxX, aabbMin.x, aabbMax.x);
      minY = Math.min(minY, aabbMin.y, aabbMax.y);
      maxY = Math.max(maxY, aabbMin.y, aabbMax.y);
      minZ = Math.min(minZ, aabbMin.z, aabbMax.z);
      maxZ = Math.max(maxZ, aabbMin.z, aabbMax.z);
    }

    return {
      min: new vec3(minX, minY, minZ),
      max: new vec3(maxX, maxY, maxZ),
    };
  }

  private findMeshVisuals(root: SceneObject): RenderMeshVisual[] {
    const results: RenderMeshVisual[] = [];
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const visuals = current.getComponents('Component.RenderMeshVisual');
      for (let i = 0; i < visuals.length; i++) {
        results.push(visuals[i]);
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
    return results;
  }

  private findPot(root: SceneObject): PlantPot | null {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as PlantPot;
        if (!isNull(candidate) && typeof candidate.simulatePlantForTest === 'function') {
          return candidate;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
  }

  private findPlant(root: SceneObject): PlantLifecycle | null {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as PlantLifecycle;
        if (
          !isNull(candidate) &&
          typeof candidate.setPlanted === 'function' &&
          typeof candidate.water === 'function'
        ) {
          return candidate;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
  }
}

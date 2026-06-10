import { PlantLifecycle } from './PlantLifecycle';

@component
export class PlantSpawnConfig extends BaseScriptComponent {
  @input
  plantTypeId: string = 'default';

  @input
  adultPlantPrefab!: ObjectPrefab;

  @input
  plantTexture!: Texture;

  @input('float')
  timeAsBaby: number = 30;

  @input('float')
  growthTime: number = 1;

  @input('float')
  scaleUpSize: number = 1;

  public applyToPlant(plant: PlantLifecycle): void {
    if (isNull(plant)) {
      return;
    }

    plant.configurePlant(
      this.plantTypeId,
      this.adultPlantPrefab,
      this.plantTexture,
      this.timeAsBaby,
      this.growthTime,
      this.scaleUpSize
    );
  }
}

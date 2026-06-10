import { AnchorController } from './AnchorController';
import { PlantSpawnConfig } from './PlantSpawnConfig';

@component
export class ButtonController extends BaseScriptComponent {
  @input anchorController!: AnchorController;
  @input
  @allowUndefined
  plantSpawnConfig!: PlantSpawnConfig;

  public buttonController() {
    if (!isNull(this.plantSpawnConfig)) {
      this.anchorController.createAnchorWithConfig(this.plantSpawnConfig);
      return;
    }

    this.anchorController.createAnchor();
  }

  public undoLast() {
    this.anchorController.undoLast();
  }
}

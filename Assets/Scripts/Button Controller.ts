import { AnchorController } from './AnchorController';

@component
export class ButtonController extends BaseScriptComponent {
  @input anchorController!: AnchorController;

  public buttonController() {
    this.anchorController.createAnchor();
  }

  public undoLast() {
    this.anchorController.undoLast();
  }
}

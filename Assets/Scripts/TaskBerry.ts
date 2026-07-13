type TaskBerryCompleteHandler = {
  onBerryCompleted?: (taskId: string, berryRoot: SceneObject) => void;
};

@component
export class TaskBerry extends BaseScriptComponent {
  @input
  taskId: string = '';

  @input
  taskLabel: string = '';

  @input
  @allowUndefined
  labelText!: Text;

  @input
  @allowUndefined
  manager!: ScriptComponent;

  @input
  @allowUndefined
  interactable!: ScriptComponent;

  private completed = false;

  onAwake(): void {
    this.refreshLabel();
    this.bindInteractable();
  }

  public configure(taskId: string, taskLabel: string): void {
    this.taskId = taskId;
    this.taskLabel = taskLabel;
    this.completed = false;
    this.refreshLabel();
  }

  public getLabelText(): string {
    return this.taskLabel;
  }

  public isCompleted(): boolean {
    return this.completed;
  }

  public markCompleted(): void {
    this.completed = true;
  }

  private refreshLabel(): void {
    if (!isNull(this.labelText)) {
      this.labelText.text = this.taskLabel;
    }
  }

  private bindInteractable(): void {
    if (isNull(this.interactable)) {
      return;
    }

    const candidate = this.interactable as ScriptComponent & {
      onTriggerEnd?: { add: (cb: () => void) => void };
      onPinchUp_Select?: Array<() => void>;
    };

    if (candidate.onTriggerEnd && typeof candidate.onTriggerEnd.add === 'function') {
      candidate.onTriggerEnd.add(() => this.handleComplete());
      return;
    }

    if (Array.isArray(candidate.onPinchUp_Select)) {
      candidate.onPinchUp_Select.push(() => this.handleComplete());
    }
  }

  private handleComplete(): void {
    if (this.completed || !this.taskId) {
      return;
    }

    const handler = this.manager as unknown as TaskBerryCompleteHandler;
    if (!isNull(this.manager) && typeof handler.onBerryCompleted === 'function') {
      handler.onBerryCompleted(this.taskId, this.getSceneObject());
      return;
    }

    this.completed = true;
    this.getSceneObject().destroy();
  }
}

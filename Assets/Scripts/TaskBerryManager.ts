import { SpecsApiClient, SpecsTask } from './SpecsApiClient';
import { SpecsDeviceRegistry } from './SpecsDeviceRegistry';
import { playInteractionSound } from './InteractionSoundRegistry';
import { TaskBerry } from './TaskBerry';

const STORAGE_BERRY_LAYOUT = 'specs_berry_layout_v1';

type BerryLayoutEntry = {
  id: string;
  x: number;
  y: number;
  z: number;
};

type BerryRecord = {
  taskId: string;
  root: SceneObject;
  berry: TaskBerry;
};

type SpacePanelLike = {
  onDevicePaired?: () => void;
  refreshPanel?: () => void;
};

@component
export class TaskBerryManager extends BaseScriptComponent {
  @input
  @allowUndefined
  specsApi!: SpecsApiClient;

  @input
  @allowUndefined
  deviceRegistry!: SpecsDeviceRegistry;

  @input
  @allowUndefined
  widgetParent!: SceneObject;

  @input
  @allowUndefined
  berryPrefab!: ObjectPrefab;

  @input
  @allowUndefined
  statusText!: Text;

  @input
  @allowUndefined
  spacePanel!: ScriptComponent;

  @input
  apiBaseUrl: string = 'https://arvis.space';

  @input('float')
  pairPollSec: number = 4;

  @input('float')
  taskPollSec: number = 45;

  @input('float')
  berryRingRadius: number = 22;

  @input('float')
  berryHeight: number = 2;

  @input
  useDemoTasksWhenOffline: boolean = true;

  @input
  debugLogging: boolean = true;

  private berries: BerryRecord[] = [];
  private pairPollEvent: DelayedCallbackEvent | null = null;
  private taskPollEvent: DelayedCallbackEvent | null = null;
  private syncing = false;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => this.bootstrap());
  }

  public forceSyncTasks(): void {
    this.syncTasks();
  }

  public createVoiceTodo(text: string, onDone?: (ok: boolean) => void): void {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      if (onDone) {
        onDone(false);
      }
      return;
    }

    if (isNull(this.specsApi) || isNull(this.deviceRegistry) || !this.deviceRegistry.isPaired()) {
      if (onDone) {
        onDone(false);
      }
      return;
    }

    this.specsApi.createTask(
      this.deviceRegistry.getDeviceId(),
      this.deviceRegistry.getDeviceSecret(),
      trimmed,
      (taskId, error) => {
        if (!taskId) {
          if (this.debugLogging) {
            print(`[TaskBerry] voice todo failed: ${error || 'unknown'}`);
          }
          if (onDone) {
            onDone(false);
          }
          return;
        }

        if (this.debugLogging) {
          print(`[TaskBerry] voice todo created: ${taskId}`);
        }
        this.forceSyncTasks();
        if (onDone) {
          onDone(true);
        }
      }
    );
  }

  public completeBerryBySpeech(spokenText: string): boolean {
    const query = String(spokenText || '').trim().toLowerCase();
    let target: BerryRecord | null = null;

    if (query) {
      for (let i = 0; i < this.berries.length; i++) {
        const record = this.berries[i];
        const berry = record.berry;
        if (isNull(berry)) {
          continue;
        }
        const label = String(berry.getLabelText?.() || '').toLowerCase();
        if (label.includes(query) || query.includes(label)) {
          target = record;
          break;
        }
      }
    }

    if (!target && this.berries.length > 0) {
      target = this.berries[0];
    }

    if (!target || isNull(target.berry) || isNull(target.root)) {
      return false;
    }

    if (!target.berry.isCompleted()) {
      target.berry.markCompleted();
      this.onBerryCompleted(target.taskId, target.root);
    }
    return true;
  }

  public onBerryCompleted(taskId: string, berryRoot: SceneObject): void {
    const id = String(taskId || '').trim();
    if (!id) {
      return;
    }

    playInteractionSound((sounds) => sounds.playPlaceObject());

    if (!isNull(this.specsApi) && !isNull(this.deviceRegistry) && this.deviceRegistry.isPaired()) {
      this.specsApi.completeTask(
        this.deviceRegistry.getDeviceId(),
        this.deviceRegistry.getDeviceSecret(),
        id,
        (ok, error) => {
          if (!ok && this.debugLogging) {
            print(`[TaskBerry] complete sync failed: ${error || 'unknown'}`);
          }
        }
      );
    }

    this.removeBerryByTaskId(id);
    if (!isNull(berryRoot)) {
      berryRoot.destroy();
    }
    this.persistLayout();
  }

  private bootstrap(): void {
    if (this.isEditorPreviewSession()) {
      global.persistentStorageSystem.store.remove(STORAGE_BERRY_LAYOUT);
    }

    if (isNull(this.deviceRegistry) || isNull(this.specsApi)) {
      this.setStatus('Task berries: missing SpecsApiClient or SpecsDeviceRegistry inputs.');
      if (this.useDemoTasksWhenOffline && !this.isEditorPreviewSession()) {
        this.spawnDemoTasks();
      }
      return;
    }

    this.registerDevice();
  }

  private registerDevice(): void {
    const deviceId = this.deviceRegistry.getDeviceId();
    const mockHint = this.specsApi.isEditorMockActive()
      ? '\n(Editor preview — device is NOT on arvis.space; deploy to Specs to pair on website)'
      : this.specsApi.isAutoPairWithCredentialsEnabled()
        ? `\n(Signing in as ${this.specsApi.autoPairEmail || 'test account'}…)`
        : '';
    this.setStatus(`Pair at arvis.space/specs\nDevice: ${deviceId}${mockHint}`);

    this.specsApi.registerDevice(deviceId, (registration, error) => {
      if (!registration) {
        this.setStatus(`Specs register failed: ${error || 'unknown'}`);
        if (this.useDemoTasksWhenOffline && !this.isEditorPreviewSession()) {
          this.spawnDemoTasks();
        }
        this.schedulePairPoll();
        return;
      }

      this.deviceRegistry.applyRegistration(
        registration.deviceId,
        registration.deviceSecret,
        registration.paired
      );

      if (registration.paired) {
        this.onPaired();
        return;
      }

      if (this.specsApi.isAutoPairWithCredentialsEnabled()) {
        this.setStatus(`Pairing ${this.specsApi.autoPairEmail || 'account'}…\nDevice: ${deviceId}`);
        this.specsApi.tryAutoPairWithCredentials(registration.deviceId, (ok, userEmail, pairError) => {
          if (ok) {
            this.deviceRegistry.setPaired(true);
            this.onPaired(userEmail || null);
            return;
          }
          if (this.debugLogging) {
            print(`[TaskBerry] auto-pair failed: ${pairError || 'unknown'}`);
          }
          this.setStatus(`Pair failed: ${pairError || 'unknown'}\nDevice: ${deviceId}`);
          this.schedulePairPoll();
        });
        return;
      }

      this.schedulePairPoll();
    });
  }

  private schedulePairPoll(): void {
    if (!isNull(this.pairPollEvent)) {
      return;
    }
    this.pairPollEvent = this.createEvent('DelayedCallbackEvent');
    this.pairPollEvent.bind(() => {
      this.pairPollEvent = null;
      this.pollPairStatus();
    });
    this.pairPollEvent.reset(Math.max(2, this.pairPollSec));
  }

  private pollPairStatus(): void {
    if (isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      return;
    }

    this.specsApi.fetchPairStatus(
      this.deviceRegistry.getDeviceId(),
      this.deviceRegistry.getDeviceSecret(),
      (status, error) => {
        if (!status) {
          if (this.debugLogging) {
            print(`[TaskBerry] pair status failed: ${error || 'unknown'}`);
          }
          this.schedulePairPoll();
          return;
        }

        if (status.paired) {
          this.deviceRegistry.setPaired(true);
          this.onPaired(status.userEmail || null);
          return;
        }

        this.deviceRegistry.syncPairingFromStorage();
        if (this.deviceRegistry.isPaired()) {
          this.onPaired(null);
          return;
        }

        this.schedulePairPoll();
      }
    );
  }

  private onPaired(userEmail: string | null = null): void {
    const emailHint = userEmail ? `\n${userEmail}` : '';
    this.setStatus(`Paired${emailHint}`);
    this.notifySpacePanelPaired();
    this.syncTasks();
    this.scheduleTaskPoll();
  }

  private notifySpacePanelPaired(): void {
    if (isNull(this.spacePanel)) {
      return;
    }

    const panel = this.spacePanel as unknown as SpacePanelLike;
    if (typeof panel.onDevicePaired === 'function') {
      panel.onDevicePaired();
      return;
    }
    if (typeof panel.refreshPanel === 'function') {
      panel.refreshPanel();
    }
  }

  private scheduleTaskPoll(): void {
    if (!isNull(this.taskPollEvent)) {
      return;
    }
    this.taskPollEvent = this.createEvent('DelayedCallbackEvent');
    this.taskPollEvent.bind(() => {
      this.taskPollEvent = null;
      this.syncTasks();
      this.scheduleTaskPoll();
    });
    this.taskPollEvent.reset(Math.max(10, this.taskPollSec));
  }

  private syncTasks(): void {
    if (this.syncing || isNull(this.specsApi) || isNull(this.deviceRegistry)) {
      return;
    }
    if (!this.deviceRegistry.isPaired()) {
      return;
    }

    this.syncing = true;
    this.specsApi.fetchTasks(
      this.deviceRegistry.getDeviceId(),
      this.deviceRegistry.getDeviceSecret(),
      (tasks, paired, error) => {
        this.syncing = false;
        if (!paired) {
          this.deviceRegistry.setPaired(false);
          this.schedulePairPoll();
          return;
        }
        if (error && this.debugLogging) {
          print(`[TaskBerry] task sync failed: ${error}`);
        }
        this.reconcileTasks(tasks);
      }
    );
  }

  private reconcileTasks(tasks: SpecsTask[]): void {
    if (!this.shouldSpawnWorldBerries()) {
      this.clearWorldBerries();
      this.setStatus(`Tasks: ${tasks.length} (see ARVIS Space panel)`);
      return;
    }

    const incomingIds = new Set<string>();
    for (let i = 0; i < tasks.length; i++) {
      incomingIds.add(tasks[i].id);
    }

    for (let i = this.berries.length - 1; i >= 0; i--) {
      if (!incomingIds.has(this.berries[i].taskId)) {
        const record = this.berries[i];
        if (!isNull(record.root)) {
          record.root.destroy();
        }
        this.berries.splice(i, 1);
      }
    }

    const layout = this.loadLayout();
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      if (this.findBerry(task.id)) {
        continue;
      }
      const saved = layout.find((entry) => entry.id === task.id);
      const position = saved
        ? new vec3(saved.x, saved.y, saved.z)
        : this.computeSpawnPosition(this.berries.length);
      this.spawnBerry(task, position);
    }

    this.persistLayout();
    this.setStatus(`Tasks: ${this.berries.length} berries`);
  }

  private spawnBerry(task: SpecsTask, localPosition: vec3): void {
    const parent = this.getSpawnParent();
    if (isNull(parent) || isNull(this.berryPrefab)) {
      return;
    }

    const root = this.berryPrefab.instantiate(parent);
    root.name = `TaskBerry_${task.id}`;
    root.getTransform().setLocalPosition(localPosition);
    root.getTransform().setLocalScale(new vec3(0.35, 0.35, 0.35));

    const berry = this.findTaskBerry(root);
    if (!isNull(berry)) {
      berry.configure(task.id, task.text);
    }

    this.berries.push({ taskId: task.id, root, berry: berry as TaskBerry });
    if (this.debugLogging) {
      print(`[TaskBerry] spawned ${task.id}: ${task.text}`);
    }
  }

  private spawnDemoTasks(): void {
    const demo: SpecsTask[] = [
      { id: 'demo-1', text: 'Water the focus tree', deadline: null, source: 'demo', done: false },
      { id: 'demo-2', text: 'Reply to design review', deadline: null, source: 'demo', done: false },
      { id: 'demo-3', text: 'Ship berry sync prototype', deadline: null, source: 'demo', done: false },
    ];
    this.reconcileTasks(demo);
    if (this.shouldSpawnWorldBerries()) {
      this.setStatus('Demo tasks loaded (offline)');
    }
  }

  private shouldSpawnWorldBerries(): boolean {
    return !this.isEditorPreviewSession();
  }

  private isEditorPreviewSession(): boolean {
    if (!isNull(this.specsApi) && typeof this.specsApi.isEditorMockActive === 'function') {
      return this.specsApi.isEditorMockActive();
    }

    try {
      RemoteServiceHttpRequest.create();
      return false;
    } catch {
      return true;
    }
  }

  private clearWorldBerries(): void {
    for (let i = this.berries.length - 1; i >= 0; i--) {
      const record = this.berries[i];
      if (!isNull(record.root)) {
        record.root.destroy();
      }
    }
    this.berries = [];
    global.persistentStorageSystem.store.remove(STORAGE_BERRY_LAYOUT);
  }

  private computeSpawnPosition(index: number): vec3 {
    const angle = index * 0.9;
    const radius = this.berryRingRadius + (index % 3) * 4;
    return new vec3(
      Math.cos(angle) * radius,
      this.berryHeight,
      Math.sin(angle) * radius
    );
  }

  private getSpawnParent(): SceneObject | null {
    if (!isNull(this.widgetParent)) {
      return this.widgetParent;
    }
    return this.getSceneObject();
  }

  private findTaskBerry(root: SceneObject): TaskBerry | null {
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as TaskBerry;
      if (!isNull(candidate) && typeof candidate.configure === 'function') {
        return candidate;
      }
    }
    for (let i = 0; i < root.getChildrenCount(); i++) {
      const child = root.getChild(i);
      const nested = this.findTaskBerry(child);
      if (!isNull(nested)) {
        return nested;
      }
    }
    return null;
  }

  private findBerry(taskId: string): BerryRecord | null {
    for (let i = 0; i < this.berries.length; i++) {
      if (this.berries[i].taskId === taskId) {
        return this.berries[i];
      }
    }
    return null;
  }

  private removeBerryByTaskId(taskId: string): void {
    this.berries = this.berries.filter((entry) => entry.taskId !== taskId);
  }

  private loadLayout(): BerryLayoutEntry[] {
    const raw = global.persistentStorageSystem.store.getString(STORAGE_BERRY_LAYOUT);
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as BerryLayoutEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private persistLayout(): void {
    const layout: BerryLayoutEntry[] = [];
    for (let i = 0; i < this.berries.length; i++) {
      const record = this.berries[i];
      if (isNull(record.root)) {
        continue;
      }
      const pos = record.root.getTransform().getLocalPosition();
      layout.push({ id: record.taskId, x: pos.x, y: pos.y, z: pos.z });
    }
    global.persistentStorageSystem.store.putString(STORAGE_BERRY_LAYOUT, JSON.stringify(layout));
  }

  private setStatus(message: string): void {
    if (!isNull(this.statusText)) {
      this.statusText.text = message;
    }
    if (this.debugLogging) {
      print(`[TaskBerry] ${message.replace(/\n/g, ' | ')}`);
    }
  }
}

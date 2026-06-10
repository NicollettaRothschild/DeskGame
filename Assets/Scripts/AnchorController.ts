import {
  AnchorSession,
  AnchorSessionOptions,
} from 'Spatial Anchors.lspkg/AnchorSession';
import { Anchor } from 'Spatial Anchors.lspkg/Anchor';
import { AnchorModule } from 'Spatial Anchors.lspkg/AnchorModule';
import { AnchorComponent } from 'Spatial Anchors.lspkg/AnchorComponent';
import { PlantLifecycle, PlantLifecycleSaveState } from './PlantLifecycle';
import { PlantSpawnConfig } from './PlantSpawnConfig';

const ANCHOR_CONTROLLER_VERSION = 'v6';
const ANCHOR_SCAN_WAIT_SEC = 8;
const WORLD_PREVIEW_FALLBACK_SEC = 4;
// Plant collider is 300 units tall, centered on root, with 0.1 scale → 15 cm to desk contact.
const PLANT_ANCHOR_Y_OFFSET = 15;
const ANCHOR_RESTORE_STABLE_FRAMES = 3;

@component
export class AnchorController extends BaseScriptComponent {
  @input anchorModule!: AnchorModule;
  @input widgetParent!: SceneObject;
  @input anchorComponent!: AnchorComponent;
  @input camera!: SceneObject;
  @input menuRoot!: SceneObject;
  @input plantPrefab!: ObjectPrefab;
  @input textlog!: Text;
  @input
  plantConfigs: PlantSpawnConfig[] = [];

  private anchorSession?: AnchorSession;
  private wrappers: SceneObject[] = [];
  private objs: SceneObject[] = [];
  private currentAnchor?: Anchor;
  private floatingRoot?: SceneObject;
  private hasRestored = false;
  private anchorPersisted = false;
  private usingWorldSpace = false;
  private restoredFromWorldFallback = false;
  private saveRetryEvent?: UpdateEvent;
  private saveRetryCooldown = 0;
  private anchorSaveInProgress = false;
  private anchorRestorePending = false;
  private anchorCreationInProgress = false;
  private skipStartupWorldFallback = false;
  private pendingCreatedAnchorId?: string;

  onAwake() {
    this.createEvent('OnStartEvent').bind(() => this.onStart());
  }

  async onStart() {
    print(`AnchorController ${ANCHOR_CONTROLLER_VERSION} starting`);
    const anchorSessionOptions = new AnchorSessionOptions();
    anchorSessionOptions.scanForWorldAnchors = true;
    this.anchorSession = await this.anchorModule.openSession(anchorSessionOptions);
    this.anchorSession.onAnchorNearby.add(this.onAnchorNearby.bind(this));

    const store = global.persistentStorageSystem.store;
    if (store.has('widget_count') && store.getInt('widget_count') > 0) {
      const usesAnchorSpace =
        store.has('uses_anchor_space') && store.getBool('uses_anchor_space');
      this.textlog.text = usesAnchorSpace
        ? 'Scan desk slowly for saved anchor...'
        : 'Scanning for desk anchor...';
      print('Saved plants found, waiting for anchor');
      const fallbackSec = usesAnchorSpace ? ANCHOR_SCAN_WAIT_SEC : WORLD_PREVIEW_FALLBACK_SEC;
      this.scheduleWorldFallbackRestore(fallbackSec);
      if (usesAnchorSpace) {
        this.scheduleAnchorScanReminder(4);
      }
    }

    this.startAnchorSaveLoop();
  }

  public onAnchorNearby(anchor: Anchor) {
    print(`Anchor found: ${anchor.id}`);
    this.textlog.text = 'Anchor found';
    const hadWorldFallback = this.hasRestored && this.restoredFromWorldFallback;
    const worldSnapshots = hadWorldFallback ? this.capturePlantWorldTransforms() : [];

    const isAlreadyTracking = this.currentAnchor?.id === anchor.id;
    const isUnsavedSessionAnchor =
      this.pendingCreatedAnchorId === anchor.id && !this.anchorPersisted;
    this.anchorComponent.enabled = true;
    this.anchorComponent.anchor = anchor;
    this.currentAnchor = anchor;
    if (!isAlreadyTracking && !isUnsavedSessionAnchor) {
      this.anchorPersisted = true;
      print('Loaded previously saved anchor');
    }

    this.anchorRestorePending = true;
    this.scheduleAnchorStableRestore(() => {
      this.anchorRestorePending = false;
      this.usingWorldSpace = false;

      if (hadWorldFallback) {
        print('Upgrading world preview to anchor-local restore');
        this.hasRestored = false;
        this.restoredFromWorldFallback = false;
        this.restoreSavedObjects(true);
        return;
      }

      this.restoredFromWorldFallback = false;

      if (this.objs.length > 0 && !this.hasRestored) {
        print('Attaching existing plants to anchor');
        this.reparentPlantsToAnchor();
        this.persistPlantTransforms();
        this.hasRestored = true;
        this.usingWorldSpace = false;
        this.restoredFromWorldFallback = false;
        this.skipStartupWorldFallback = true;
        this.textlog.text = `Restored ${this.objs.length} plant(s)`;
        return;
      }

      if (this.hasRestored && !hadWorldFallback) {
        this.reparentPlantsToAnchor();
        if (worldSnapshots.length > 0) {
          this.reapplyPlantWorldTransforms(worldSnapshots);
        }
        return;
      }

      if (!this.hasRestored) {
        this.restoreSavedObjects(true);
      }
    });
  }

  async createAnchor() {
    const spawnWorldPos = this.getSpawnWorldPosition();
    this.spawnObjectAtWorld(spawnWorldPos);
  }

  public createAnchorWithConfig(config: PlantSpawnConfig) {
    const spawnWorldPos = this.getSpawnWorldPosition();
    const obj = this.spawnObjectAtWorld(spawnWorldPos);
    if (obj && !isNull(config)) {
      const plant = this.findPlantLifecycle(obj);
      if (!isNull(plant)) {
        config.applyToPlant(plant);
      }
    }
  }

  private getSpawnWorldPosition(): vec3 {
    const menuTransform = this.menuRoot.getTransform();
    const menuWorld = menuTransform.getWorldPosition();
    const cameraWorld = this.camera.getTransform().getWorldPosition();

    let towardUser = new vec3(
      cameraWorld.x - menuWorld.x,
      0,
      cameraWorld.z - menuWorld.z
    );
    const horizontalDist = Math.sqrt(
      towardUser.x * towardUser.x + towardUser.z * towardUser.z
    );
    if (horizontalDist > 0.001) {
      towardUser = new vec3(
        towardUser.x / horizontalDist,
        0,
        towardUser.z / horizontalDist
      );
    } else {
      towardUser = new vec3(0, 0, 1);
    }

    const towardUserDistance = 12;
    const downDistance = 10;
    const index = this.wrappers.length;
    const menuRight = menuTransform.getWorldRotation().multiplyVec3(new vec3(1, 0, 0));
    const stagger = ((index % 3) - 1) * 4;

    return new vec3(
      menuWorld.x + towardUser.x * towardUserDistance + menuRight.x * stagger,
      menuWorld.y - downDistance,
      menuWorld.z + towardUser.z * towardUserDistance + menuRight.z * stagger
    );
  }

  private capturePlantWorldTransforms(): { pos: vec3; rot: quat }[] {
    return this.objs
      .filter((obj) => !isNull(obj))
      .map((obj) => ({
        pos: obj.getTransform().getWorldPosition(),
        rot: obj.getTransform().getWorldRotation(),
      }));
  }

  private reapplyPlantWorldTransforms(snapshots: { pos: vec3; rot: quat }[]) {
    for (let i = 0; i < snapshots.length && i < this.objs.length; i++) {
      const obj = this.objs[i];
      if (isNull(obj)) {
        continue;
      }
      obj.getTransform().setWorldPosition(snapshots[i].pos);
      obj.getTransform().setWorldRotation(snapshots[i].rot);
    }
  }

  private scheduleDelayed(callback: () => void, delaySec: number) {
    const delayedEvent = this.createEvent('DelayedCallbackEvent');
    delayedEvent.bind(callback);
    delayedEvent.reset(delaySec);
  }

  private scheduleAnchorStableRestore(callback: () => void) {
    let stableFrames = 0;
    let lastAnchorPos: vec3 | null = null;
    let maxWaitSec = 3;
    const settleEvent = this.createEvent('UpdateEvent');
    settleEvent.bind(() => {
      if (!this.currentAnchor || !this.anchorComponent.enabled) {
        return;
      }

      maxWaitSec -= getDeltaTime();
      const anchorPos = this.widgetParent.getTransform().getWorldPosition();
      if (
        lastAnchorPos &&
        anchorPos.distance(lastAnchorPos) < 0.05
      ) {
        stableFrames++;
      } else {
        stableFrames = 0;
      }
      lastAnchorPos = anchorPos;

      if (stableFrames >= ANCHOR_RESTORE_STABLE_FRAMES || maxWaitSec <= 0) {
        settleEvent.enabled = false;
        print(
          stableFrames >= ANCHOR_RESTORE_STABLE_FRAMES
            ? 'Anchor pose stable, restoring plants'
            : 'Anchor restore timeout, applying saved offsets'
        );
        callback();
      }
    });
    settleEvent.enabled = true;
  }

  private getPlantAnchorWorldPosition(): vec3 {
    const worldPos = this.objs[0].getTransform().getWorldPosition();
    return new vec3(
      worldPos.x,
      worldPos.y - PLANT_ANCHOR_Y_OFFSET,
      worldPos.z
    );
  }

  private getPlantAnchorWorldMatrix(): mat4 {
    return mat4.fromTranslation(this.getPlantAnchorWorldPosition());
  }

  private markSessionPlantsActive() {
    this.skipStartupWorldFallback = true;
  }

  private startWorldAnchorCreation(spawnWorldMat: mat4) {
    if (this.anchorCreationInProgress || this.currentAnchor) {
      return;
    }
    this.markSessionPlantsActive();
    this.anchorCreationInProgress = true;
    this.usingWorldSpace = false;
    this.restoredFromWorldFallback = false;
    this.anchorComponent.enabled = true;
    this.textlog.text = 'Creating desk anchor...';
    print('Creating desk anchor');
    this.anchorSession!.createWorldAnchor(spawnWorldMat)
      .then((anchor) => {
        const worldSnapshots = this.capturePlantWorldTransforms();
        this.pendingCreatedAnchorId = anchor.id;
        this.currentAnchor = anchor;
        this.anchorComponent.enabled = true;
        this.anchorComponent.anchor = anchor;
        this.anchorPersisted = false;
        this.anchorCreationInProgress = false;
        this.textlog.text = 'Mapping desk... look around slowly';
        print('World anchor created at desk contact, waiting to persist');
        this.scheduleAnchorStableRestore(() => {
          this.reparentPlantsToAnchor();
          this.reapplyPlantWorldTransforms(worldSnapshots);
          this.persistPlantTransforms();
          this.trySaveAnchorOnce();
        });
      })
      .catch((error) => {
        print('Error creating anchor: ' + error);
        this.textlog.text = 'Could not create desk anchor';
        this.usingWorldSpace = true;
        this.anchorCreationInProgress = false;
        this.anchorComponent.enabled = false;
      });
  }

  private startAnchorSaveLoop() {
    if (this.saveRetryEvent) {
      return;
    }

    this.saveRetryEvent = this.createEvent('UpdateEvent');
    this.saveRetryEvent.bind(() => {
      if (!this.currentAnchor || this.anchorPersisted || this.usingWorldSpace || this.anchorCreationInProgress) {
        return;
      }
      this.saveRetryCooldown -= getDeltaTime();
      if (this.saveRetryCooldown > 0) {
        return;
      }
      this.saveRetryCooldown = 5;
      this.trySaveAnchorOnce();
    });
    this.saveRetryEvent.enabled = true;
  }

  private trySaveAnchorOnce() {
    if (!this.currentAnchor || this.anchorPersisted || this.usingWorldSpace || this.anchorSaveInProgress) {
      return;
    }

    this.anchorSaveInProgress = true;
    this.textlog.text = 'Mapping desk... look around slowly';
    this.anchorSession!.saveAnchor(this.currentAnchor)
      .then(() => {
        this.anchorPersisted = true;
        this.pendingCreatedAnchorId = undefined;
        global.persistentStorageSystem.store.putBool('uses_anchor_space', true);
        this.textlog.text = 'Anchor saved';
        print('Anchor saved successfully');
        this.persistPlantTransforms();
        this.anchorSaveInProgress = false;
      })
      .catch((e) => {
        print('Anchor save pending: ' + e);
        this.textlog.text = 'Mapping desk... stay in place';
        this.anchorSaveInProgress = false;
      });
  }

  private scheduleWorldFallbackRestore(delaySec: number) {
    this.scheduleDelayed(() => {
      if (this.shouldSkipStartupWorldFallback()) {
        print('Skipping world preview: session already has anchor or plants');
        return;
      }
      print('No saved anchor yet, using world preview');
      this.restoreSavedObjects(false);
      this.ensureDeskAnchorForRestoredPlants();
    }, delaySec);
  }

  private scheduleAnchorScanReminder(delaySec: number) {
    this.scheduleDelayed(() => {
      if (this.hasRestored || this.currentAnchor || this.objs.length > 0) {
        return;
      }
      print('Still scanning for saved desk anchor');
      this.textlog.text = 'Look at your desk slowly to find saved anchor';
    }, delaySec);
  }

  private shouldSkipStartupWorldFallback(): boolean {
    return (
      this.skipStartupWorldFallback ||
      this.hasRestored ||
      this.anchorRestorePending ||
      !!this.currentAnchor ||
      this.anchorCreationInProgress ||
      this.objs.length > 0
    );
  }

  private ensureDeskAnchorForRestoredPlants() {
    const store = global.persistentStorageSystem.store;
    if (store.has('uses_anchor_space') && store.getBool('uses_anchor_space')) {
      print('Not creating new anchor; waiting for saved anchor');
      return;
    }
    if (this.currentAnchor || this.usingWorldSpace || this.objs.length === 0) {
      return;
    }
    print('Starting desk anchor from restored plant desk contact');
    this.startWorldAnchorCreation(this.getPlantAnchorWorldMatrix());
  }

  private spawnObjectAtWorld(worldPos: vec3): SceneObject | null {
    const obj = this.spawnObject();
    if (!obj) {
      return null;
    }
    obj.getTransform().setWorldPosition(worldPos);
    return obj;
  }

  private getFloatingRoot(): SceneObject {
    if (!this.floatingRoot) {
      this.floatingRoot = global.scene.createSceneObject('PlantFloatingRoot');
    }
    return this.floatingRoot;
  }

  private getSpawnParent(): SceneObject {
    if (this.hasActiveAnchorTracking()) {
      return this.widgetParent;
    }
    return this.getFloatingRoot();
  }

  private reparentPlantsToAnchor() {
    for (let i = 0; i < this.wrappers.length; i++) {
      const wrapper = this.wrappers[i];
      const obj = this.objs[i];
      if (isNull(wrapper) || isNull(obj)) {
        continue;
      }
      const worldPos = obj.getTransform().getWorldPosition();
      const worldRot = obj.getTransform().getWorldRotation();
      wrapper.setParent(this.widgetParent);
      obj.getTransform().setWorldPosition(worldPos);
      obj.getTransform().setWorldRotation(worldRot);
    }

    if (this.floatingRoot) {
      this.floatingRoot.destroy();
      this.floatingRoot = undefined;
    }
  }

  private worldToWidgetLocal(worldPos: vec3, worldRot: quat): { pos: vec3; rot: quat } {
    const worldToLocal = this.widgetParent.getTransform().getWorldTransform().inverse();
    const parentRot = this.widgetParent.getTransform().getWorldRotation();
    return {
      pos: worldToLocal.multiplyPoint(worldPos),
      rot: parentRot.invert().multiply(worldRot),
    };
  }

  private widgetLocalToWorld(localPos: vec3, localRot: quat): { pos: vec3; rot: quat } {
    const parentWorld = this.widgetParent.getTransform().getWorldTransform();
    const parentRot = this.widgetParent.getTransform().getWorldRotation();
    return {
      pos: parentWorld.multiplyPoint(localPos),
      rot: parentRot.multiply(localRot),
    };
  }

  private isNearZeroOffset(pos: vec3): boolean {
    return Math.abs(pos.x) < 0.1 && Math.abs(pos.y) < 0.1 && Math.abs(pos.z) < 0.1;
  }

  private getStoredAnchorLocalOffset(
    store: GeneralDataStore,
    index: number
  ): { pos: vec3; rot: quat } {
    const pos = new vec3(
      store.getFloat(`w${index}_x`),
      store.getFloat(`w${index}_y`),
      store.getFloat(`w${index}_z`)
    );
    const rot = new quat(
      store.getFloat(`w${index}_rw`),
      store.getFloat(`w${index}_rx`),
      store.getFloat(`w${index}_ry`),
      store.getFloat(`w${index}_rz`)
    );
    if (
      this.isNearZeroOffset(pos) &&
      store.has('uses_anchor_space') &&
      store.getBool('uses_anchor_space')
    ) {
      print(`Migrating plant ${index} legacy zero offset to desk-contact offset`);
      pos.y = PLANT_ANCHOR_Y_OFFSET;
    }
    return { pos, rot };
  }

  spawnObject(localSpawnPos?: vec3, updateStoredCount = true): SceneObject | null {
    this.markSessionPlantsActive();
    const index = this.wrappers.length;
    const wrapper = global.scene.createSceneObject(`Plant_${index}`);
    wrapper.setParent(this.getSpawnParent());

    let obj: SceneObject;
    try {
      obj = this.plantPrefab.instantiate(wrapper);
    } catch (e) {
      print('spawnObject failed: ' + e);
      this.textlog.text = 'Spawn error';
      wrapper.destroy();
      return null;
    }
    obj.name = `PlantContent_${index}`;

    if (localSpawnPos) {
      obj.getTransform().setLocalPosition(localSpawnPos);
    }

    this.wrappers.push(wrapper);
    this.objs.push(obj);

    if (updateStoredCount) {
      global.persistentStorageSystem.store.putInt('widget_count', this.wrappers.length);
    }
    return obj;
  }

  saveObjectPosition() {
    print(
      `pinch up ${ANCHOR_CONTROLLER_VERSION} anchor=${!!this.currentAnchor} worldOnly=${this.usingWorldSpace} creating=${this.anchorCreationInProgress}`
    );

    if (!this.currentAnchor && !this.anchorCreationInProgress && this.objs.length > 0 && !this.usingWorldSpace) {
      this.startWorldAnchorCreation(this.getPlantAnchorWorldMatrix());
      return;
    }

    this.restoredFromWorldFallback = false;
    this.persistPlantTransforms();
    this.trySaveAnchorOnce();
  }

  private persistPlantTransforms() {
    const store = global.persistentStorageSystem.store;

    for (let i = 0; i < this.objs.length; i++) {
      const obj = this.objs[i];
      if (isNull(obj)) continue;

      const worldPos = obj.getTransform().getWorldPosition();
      const worldRot = obj.getTransform().getWorldRotation();
      const anchorLocal = this.hasActiveAnchorTracking()
        ? this.worldToWidgetLocal(worldPos, worldRot)
        : {
            pos: obj.getTransform().getLocalPosition(),
            rot: obj.getTransform().getLocalRotation(),
          };
      const pos = anchorLocal.pos;
      const rot = anchorLocal.rot;

      store.putFloat(`w${i}_x`, pos.x);
      store.putFloat(`w${i}_y`, pos.y);
      store.putFloat(`w${i}_z`, pos.z);
      store.putFloat(`w${i}_rx`, rot.x);
      store.putFloat(`w${i}_ry`, rot.y);
      store.putFloat(`w${i}_rz`, rot.z);
      store.putFloat(`w${i}_rw`, rot.w);
      store.putFloat(`w${i}_wx`, worldPos.x);
      store.putFloat(`w${i}_wy`, worldPos.y);
      store.putFloat(`w${i}_wz`, worldPos.z);
      store.putFloat(`w${i}_wrx`, worldRot.x);
      store.putFloat(`w${i}_wry`, worldRot.y);
      store.putFloat(`w${i}_wrz`, worldRot.z);
      store.putFloat(`w${i}_wrw`, worldRot.w);
      this.persistPlantState(store, i, obj);

      print(`Saved plant ${i} local: ${pos.toString()} world: ${worldPos.toString()}`);
      this.textlog.text = `Saved ${this.objs.length} plant(s)`;
    }

    store.putBool('has_world_data', true);
    if (this.hasActiveAnchorTracking()) {
      store.putBool('uses_anchor_space', true);
    }
  }

  private hasActiveAnchorTracking(): boolean {
    return !!this.currentAnchor && !this.usingWorldSpace && this.anchorComponent.enabled;
  }

  private restoreSavedObjects(useAnchorLocal: boolean) {
    if (this.hasRestored) {
      return;
    }

    const store = global.persistentStorageSystem.store;
    if (!store.has('widget_count') || store.getInt('widget_count') <= 0) {
      print('No saved plants to restore');
      return;
    }

    const hasWorldData = store.has('has_world_data') && store.getBool('has_world_data');
    if (!useAnchorLocal && !hasWorldData) {
      print('No world-space data yet, cannot fallback restore');
      this.textlog.text = 'Place a plant again to enable restore';
      return;
    }

    if (useAnchorLocal) {
      this.usingWorldSpace = false;
      this.anchorComponent.enabled = true;
      const restoredCount = this.restoreAllObjects(false);
      if (restoredCount === 0 && hasWorldData) {
        const usesAnchorSpace =
          store.has('uses_anchor_space') && store.getBool('uses_anchor_space');
        if (usesAnchorSpace) {
          print('Anchor-local restore empty, keep scanning for saved anchor');
          this.textlog.text = 'Scan desk slowly for saved anchor';
          this.hasRestored = false;
          return;
        }
        print('Anchor-local restore empty, falling back to world preview');
        this.hasRestored = false;
        this.restoredFromWorldFallback = true;
        this.restoreAllObjects(true);
        this.ensureDeskAnchorForRestoredPlants();
      } else {
        this.reparentPlantsToAnchor();
      }
    } else {
      this.restoredFromWorldFallback = true;
      this.anchorComponent.enabled = true;
      this.restoreAllObjects(true);
    }
  }

  private clearSpawnedObjects() {
    this.wrappers.forEach((wrapper) => wrapper.destroy());
    this.wrappers = [];
    this.objs = [];
  }

  private restoreAllObjects(useWorldSpace: boolean): number {
    const store = global.persistentStorageSystem.store;
    if (!store.has('widget_count')) {
      return 0;
    }

    const count = store.getInt('widget_count');
    if (count <= 0) {
      return 0;
    }

    this.clearSpawnedObjects();
    print(`Restoring ${count} plants (${useWorldSpace ? 'world preview' : 'anchor'} space)`);

    let restoredCount = 0;
    for (let i = 0; i < count; i++) {
      const posKey = useWorldSpace ? 'wx' : 'x';
      if (!store.has(`w${i}_${posKey}`)) {
        print(`Skipping plant ${i}: missing saved transform`);
        continue;
      }

      const wrapper = global.scene.createSceneObject(`Plant_${i}`);
      wrapper.setParent(this.getSpawnParent());

      let obj: SceneObject;
      try {
        obj = this.plantPrefab.instantiate(wrapper);
      } catch (e) {
        print('Restore spawn failed: ' + e);
        wrapper.destroy();
        continue;
      }
      obj.name = `PlantContent_${i}`;

      if (useWorldSpace) {
        const worldPos = new vec3(
          store.getFloat(`w${i}_wx`),
          store.getFloat(`w${i}_wy`),
          store.getFloat(`w${i}_wz`)
        );
        const worldRot = new quat(
          store.getFloat(`w${i}_wrw`),
          store.getFloat(`w${i}_wrx`),
          store.getFloat(`w${i}_wry`),
          store.getFloat(`w${i}_wrz`)
        );
        obj.getTransform().setWorldPosition(worldPos);
        obj.getTransform().setWorldRotation(worldRot);
        print(`Restored plant ${i} at world: ${worldPos.toString()}`);
      } else {
        const stored = this.getStoredAnchorLocalOffset(store, i);
        const world = this.widgetLocalToWorld(stored.pos, stored.rot);
        wrapper.getTransform().setLocalPosition(new vec3(0, 0, 0));
        wrapper.getTransform().setLocalRotation(new quat(1, 0, 0, 0));
        obj.getTransform().setWorldPosition(world.pos);
        obj.getTransform().setWorldRotation(world.rot);
        print(
          `Restored plant ${i} anchor-local: ${stored.pos.toString()} world: ${world.pos.toString()}`
        );
      }

      this.restorePlantState(store, i, obj);

      this.wrappers.push(wrapper);
      this.objs.push(obj);
      restoredCount++;
    }

    store.putInt('widget_count', this.wrappers.length);
    this.hasRestored = true;
    this.textlog.text = restoredCount > 0
      ? `Restored ${restoredCount} plant(s)`
      : 'Could not restore saved plants';
    return restoredCount;
  }

  undoLast() {
    if (this.objs.length === 0) {
      this.textlog.text = 'Nothing to undo';
      return;
    }

    const lastIndex = this.wrappers.length - 1;
    const store = global.persistentStorageSystem.store;

    ['x', 'y', 'z', 'rx', 'ry', 'rz', 'rw', 'wx', 'wy', 'wz', 'wrx', 'wry', 'wrz', 'wrw']
      .forEach(k => store.remove(`w${lastIndex}_${k}`));
    this.removePlantState(store, lastIndex);
    store.remove(`w${lastIndex}_prefab`);
    store.putInt('widget_count', lastIndex);

    this.wrappers[lastIndex].destroy();
    this.wrappers.pop();
    this.objs.pop();

    if (this.objs.length === 0) {
      store.remove('has_world_data');
      store.remove('uses_anchor_space');
    }

    this.textlog.text = `${this.objs.length} plant(s) remaining`;
    print(`Undo: removed plant ${lastIndex}`);
  }

  async resetAnchor() {
    const store = global.persistentStorageSystem.store;
    const count = store.has('widget_count') ? store.getInt('widget_count') : 0;

    for (let i = 0; i < count; i++) {
      ['x', 'y', 'z', 'rx', 'ry', 'rz', 'rw', 'wx', 'wy', 'wz', 'wrx', 'wry', 'wrz', 'wrw']
        .forEach(k => store.remove(`w${i}_${k}`));
      this.removePlantState(store, i);
      store.remove(`w${i}_prefab`);
    }
    store.remove('widget_count');
    store.remove('has_world_data');
    store.remove('uses_anchor_space');

    this.clearSpawnedObjects();
    if (this.floatingRoot) {
      this.floatingRoot.destroy();
      this.floatingRoot = undefined;
    }
    this.hasRestored = false;
    this.anchorPersisted = false;
    this.usingWorldSpace = false;
    this.restoredFromWorldFallback = false;
    this.anchorSaveInProgress = false;
    this.anchorCreationInProgress = false;
    this.skipStartupWorldFallback = false;
    this.pendingCreatedAnchorId = undefined;
    this.currentAnchor = undefined;
    this.anchorComponent.enabled = true;
    await this.anchorSession!.reset();
    this.textlog.text = 'Desk reset';
  }

  private persistPlantState(store: GeneralDataStore, index: number, obj: SceneObject) {
    const plant = this.findPlantLifecycle(obj);
    if (isNull(plant)) {
      return;
    }

    const state = plant.getSaveState();
    store.putString(`w${index}_plant_type`, state.plantTypeId);
    store.putInt(`w${index}_plant_stage`, state.stage);
    store.putFloat(`w${index}_plant_baby_remaining`, state.babyTimerRemaining);
    store.putFloat(`w${index}_plant_growth_elapsed`, state.growthElapsed);
    store.putBool(`w${index}_plant_watered`, state.hasBeenWatered);
  }

  private restorePlantState(store: GeneralDataStore, index: number, obj: SceneObject) {
    if (!store.has(`w${index}_plant_stage`)) {
      return;
    }

    const plant = this.findPlantLifecycle(obj);
    if (isNull(plant)) {
      return;
    }

    const plantTypeId = store.has(`w${index}_plant_type`)
      ? store.getString(`w${index}_plant_type`)
      : 'default';
    const config = this.findPlantConfig(plantTypeId);
    if (!isNull(config)) {
      config.applyToPlant(plant);
    }

    const state: PlantLifecycleSaveState = {
      plantTypeId: plantTypeId,
      stage: store.getInt(`w${index}_plant_stage`),
      babyTimerRemaining: store.has(`w${index}_plant_baby_remaining`)
        ? store.getFloat(`w${index}_plant_baby_remaining`)
        : 0,
      growthElapsed: store.has(`w${index}_plant_growth_elapsed`)
        ? store.getFloat(`w${index}_plant_growth_elapsed`)
        : 0,
      hasBeenWatered:
        store.has(`w${index}_plant_watered`) && store.getBool(`w${index}_plant_watered`),
    };
    plant.applySaveState(state);
  }

  private removePlantState(store: GeneralDataStore, index: number) {
    store.remove(`w${index}_plant_type`);
    store.remove(`w${index}_plant_stage`);
    store.remove(`w${index}_plant_baby_remaining`);
    store.remove(`w${index}_plant_growth_elapsed`);
    store.remove(`w${index}_plant_watered`);
  }

  private findPlantConfig(plantTypeId: string): PlantSpawnConfig {
    for (let i = 0; i < this.plantConfigs.length; i++) {
      const config = this.plantConfigs[i];
      if (!isNull(config) && config.plantTypeId === plantTypeId) {
        return config;
      }
    }

    return null as unknown as PlantSpawnConfig;
  }

  private findPlantLifecycle(root: SceneObject): PlantLifecycle {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const plant = scripts[i] as unknown as PlantLifecycle;
        if (!isNull(plant) && typeof plant.getSaveState === 'function') {
          return plant;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null as unknown as PlantLifecycle;
  }
}

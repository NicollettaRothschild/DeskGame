import {
  AnchorSession,
  AnchorSessionOptions,
} from 'Spatial Anchors.lspkg/AnchorSession';
import { Anchor } from 'Spatial Anchors.lspkg/Anchor';
import { AnchorModule } from 'Spatial Anchors.lspkg/AnchorModule';
import { AnchorComponent } from 'Spatial Anchors.lspkg/AnchorComponent';
import { WorldAnchor } from 'Spatial Anchors.lspkg/WorldAnchor';
import { PlantLifecycle, PlantLifecycleSaveState } from './PlantLifecycle';
import { PlantSpawnConfig } from './PlantSpawnConfig';
import { InteractionSoundRegistry, playInteractionSound } from './InteractionSoundRegistry';
import { prepareSceneObjectForDestroy } from './FlowGardenDestroyHooks';
import { SpecsApiClient } from './SpecsApiClient';

const ANCHOR_CONTROLLER_VERSION = 'v14-recovery';
const STARTUP_REBIND_DELAY_SEC = 0.35;
const STARTUP_PERSIST_DELAY_SEC = 0.5;
const PLANT_LIFECYCLE_SAVE_VERSION = 4;
const OBJECT_KIND_PLANT = 'plant';
const OBJECT_KIND_POT = 'pot';
const WORLD_PREVIEW_FALLBACK_SEC = 1;
const ANCHOR_SCAN_REMINDER_SEC = 3;
// Plant collider is 300 units tall, centered on root, with 0.1 scale → 15 cm to desk contact.
const PLANT_ANCHOR_Y_OFFSET = 15;
const ANCHOR_RESTORE_STABLE_FRAMES = 2;
const ANCHOR_RESTORE_MAX_WAIT_SEC = 1.5;

@component
export class AnchorController extends BaseScriptComponent {
  @input anchorModule!: AnchorModule;
  @input widgetParent!: SceneObject;
  @input anchorComponent!: AnchorComponent;
  @input camera!: SceneObject;
  @input menuRoot!: SceneObject;
  @input plantPrefab!: ObjectPrefab;
  @input
  potPrefabs: ObjectPrefab[] = [];
  @input textlog!: Text;
  @input
  plantConfigs: PlantSpawnConfig[] = [];

  @input('float')
  soundVolume: number = 1.25;

  @input
  soundDebugLogging: boolean = true;

  @input
  @allowUndefined
  wateringTrack!: AudioTrackAsset;

  @input
  @allowUndefined
  plantSeedTrack!: AudioTrackAsset;

  @input
  @allowUndefined
  growthStartTrack!: AudioTrackAsset;

  @input
  @allowUndefined
  growthCompleteTrack!: AudioTrackAsset;

  @input
  @allowUndefined
  spawnSeedTrack!: AudioTrackAsset;

  @input
  @allowUndefined
  spawnPotTrack!: AudioTrackAsset;

  @input
  @allowUndefined
  spawnWaterTrack!: AudioTrackAsset;

  @input
  @allowUndefined
  placeObjectTrack!: AudioTrackAsset;

  @input
  @allowUndefined
  trashBin!: ScriptComponent;

  @input
  @allowUndefined
  spacePanel!: ScriptComponent;

  @input
  @allowUndefined
  specsApi!: SpecsApiClient;

  private anchorSession?: AnchorSession;
  private wrappers: SceneObject[] = [];
  private objs: SceneObject[] = [];
  private objectKinds: string[] = [];
  private objectPrefabIndices: number[] = [];
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
  private lockedAnchorId: string | null = null;
  private anchorBindingComplete = false;
  private startupRebindInProgress = false;
  private aiContainerPersistencePaused = false;
  private startupWorldOnlySession = false;
  private isResetting = false;
  private sessionEpoch = 0;
  private anchorSettleEvent?: UpdateEvent;
  private nextPlantSpawnIndex = 0;
  private trashFixedWorldPosition: vec3 | null = null;
  private trashFixedWorldRotation: quat | null = null;
  private aiContainerFixedWorldPosition: vec3 | null = null;
  private aiContainerSceneDefaultLocalRotation: quat | null = null;
  private aiContainerRestoreApplied = false;
  private aiContainerWatchEvent: UpdateEvent | null = null;
  private lastPersistedAIContainerWorld: vec3 | null = null;
  private aiContainerPersistCooldown = 0;
  private readonly aiContainerPersistIntervalSec = 0.35;
  private readonly aiContainerMoveEpsilon = 0.5;
  private activeManipulatedRoot: SceneObject | null = null;
  private lastSaveObjectPositionAt = -1;
  private readonly saveObjectPositionCooldownSec = 0.1;
  private trashReleaseWiredObjects: SceneObject[] = [];

  onAwake() {
    this.setupInteractionSounds();
    this.createEvent('OnStartEvent').bind(() => this.onStart());
  }

  private setupInteractionSounds(): void {
    InteractionSoundRegistry.configure(
      this.getSceneObject(),
      {
        watering: this.wateringTrack,
        plantSeed: this.plantSeedTrack,
        growthStart: this.growthStartTrack,
        growthComplete: this.growthCompleteTrack,
        spawnSeed: this.spawnSeedTrack,
        spawnPot: this.spawnPotTrack,
        spawnWater: this.spawnWaterTrack,
        placeObject: this.placeObjectTrack,
      },
      this.soundVolume,
      this.soundDebugLogging
    );
  }

  async onStart() {
    this.setupInteractionSounds();
    print(`AnchorController ${ANCHOR_CONTROLLER_VERSION} starting`);

    const store = global.persistentStorageSystem.store;
    const editorPreview = this.isEditorPreviewSession();
    const hasSavedPlants =
      !editorPreview && store.has('widget_count') && store.getInt('widget_count') > 0;

    if (hasSavedPlants) {
      print('Recovery boot: restoring saved plants without anchors or background systems');
      this.startupWorldOnlySession = true;
      this.aiContainerPersistencePaused = true;
      this.usingWorldSpace = true;
      this.restoredFromWorldFallback = true;
      this.anchorComponent.enabled = false;
      this.restoreSavedObjects(false);
      this.usingWorldSpace = true;
      this.restoredFromWorldFallback = true;
      this.anchorComponent.enabled = false;
      this.menuRoot.enabled = true;
      const recoveryAIPosition = this.camera
        .getTransform()
        .getWorldTransform()
        .multiplyPoint(new vec3(0, -10, -80));
      this.menuRoot.getTransform().setWorldPosition(recoveryAIPosition);
      this.menuRoot.getTransform().setWorldRotation(
        this.camera.getTransform().getWorldRotation()
      );
      this.aiContainerFixedWorldPosition = recoveryAIPosition;
      this.hasRestored = true;
      this.textlog.text = 'Recovery mode: saved garden restored';
      print(
        `Recovery boot complete (restored ${store.getInt('widget_count')} saved object record(s))`
      );
      return;
    }

    const anchorSessionOptions = new AnchorSessionOptions();
    anchorSessionOptions.scanForWorldAnchors = true;
    this.anchorSession = await this.anchorModule.openSession(anchorSessionOptions);
    this.anchorSession.onAnchorNearby.add(this.onAnchorNearby.bind(this));

    // Editor preview can't persist world anchors reliably, but we should still allow restoring
    // saved desk layouts for iteration. Only clear saved data when the user explicitly resets.

    if (editorPreview && store.has('widget_count') && store.getInt('widget_count') > 0) {
      print('Editor preview: saved plants found, restoring');
      this.restoreSavedObjects(true);
      this.hasRestored = true;
      this.usingWorldSpace = true;
    }

    this.startAnchorSaveLoop();
    this.captureAndLockTrashAtDesk();
    this.captureAIContainerSceneDefaults();
    if (!this.aiContainerRestoreApplied) {
      this.restoreAIContainerFromStorage();
    }
    this.applyAIContainerSavedPose();
    this.maintainAIContainerAnchorBinding();
    if (!hasSavedPlants) {
      this.persistAIContainerTransform();
    }
    this.startAIContainerPersistenceLoop();
  }

  private usesSavedAnchorSpace(): boolean {
    const store = global.persistentStorageSystem.store;
    return store.has('uses_anchor_space') && store.getBool('uses_anchor_space');
  }

  private getPreferredAnchorId(): string {
    const store = global.persistentStorageSystem.store;
    return store.has('preferred_anchor_id') ? store.getString('preferred_anchor_id') : '';
  }

  private rememberPreferredAnchor(anchorId: string): void {
    if (!anchorId) {
      return;
    }
    global.persistentStorageSystem.store.putString('preferred_anchor_id', anchorId);
    this.lockedAnchorId = anchorId;
  }

  private shouldIgnoreNearbyAnchor(anchorId: string): boolean {
    if (this.lockedAnchorId && anchorId !== this.lockedAnchorId) {
      print(`Ignoring nearby anchor ${anchorId}; waiting to lock ${this.lockedAnchorId}`);
      return true;
    }

    const preferredId = this.getPreferredAnchorId();
    if (
      this.usesSavedAnchorSpace() &&
      preferredId &&
      anchorId !== preferredId &&
      this.pendingCreatedAnchorId !== anchorId
    ) {
      if (!this.lockedAnchorId) {
        this.lockedAnchorId = preferredId;
      }
      print(`Ignoring nearby anchor ${anchorId}; waiting to lock ${preferredId}`);
      return true;
    }

    if (
      this.anchorRestorePending &&
      this.currentAnchor &&
      String(this.currentAnchor.id) !== anchorId
    ) {
      print(
        `Ignoring nearby anchor ${anchorId}; restore pending for ${this.currentAnchor.id}`
      );
      return true;
    }

    if (this.anchorBindingComplete && this.currentAnchor?.id !== anchorId) {
      print(`Ignoring nearby anchor ${anchorId}; already bound to ${this.currentAnchor?.id}`);
      return true;
    }

    return false;
  }

  private finishStartupRebind(
    worldSnapshots: { pos: vec3; rot: quat }[],
    label: string
  ): void {
    this.startupRebindInProgress = true;
    this.aiContainerPersistencePaused = true;
    this.scheduleDelayed(() => {
      if (this.isResetting) {
        return;
      }
      print(`${label}: reparenting ${this.objs.length} object(s)`);
      this.reparentPlantsToAnchor();
      this.reapplyPlantWorldTransforms(worldSnapshots);
      this.scheduleDelayed(() => {
        if (this.isResetting) {
          return;
        }
        this.persistPlantTransforms(true);
        this.aiContainerPersistencePaused = false;
        this.startupRebindInProgress = false;
        this.anchorBindingComplete = true;
        if (this.currentAnchor) {
          this.rememberPreferredAnchor(String(this.currentAnchor.id || ''));
        }
        print(`Startup anchor rebind complete (${this.objs.length} object(s))`);
      }, STARTUP_PERSIST_DELAY_SEC);
    }, STARTUP_REBIND_DELAY_SEC);
  }

  public onAnchorNearby(anchor: Anchor) {
    if (this.isResetting) {
      print('Ignoring nearby anchor during reset');
      return;
    }

    const anchorId = String(anchor.id || '');
    if (!anchorId) {
      return;
    }

    if (this.startupWorldOnlySession) {
      print(`Crash-safe startup: ignoring nearby anchor ${anchorId}`);
      return;
    }

    if (this.shouldIgnoreNearbyAnchor(anchorId)) {
      return;
    }

    const isAlreadyTracking = this.currentAnchor?.id === anchorId;
    if (isAlreadyTracking && this.anchorBindingComplete) {
      return;
    }

    if (!this.lockedAnchorId && (this.usesSavedAnchorSpace() || this.hasRestored)) {
      this.lockedAnchorId = this.getPreferredAnchorId() || anchorId;
      if (this.lockedAnchorId !== anchorId) {
        print(`Ignoring nearby anchor ${anchorId}; waiting to lock ${this.lockedAnchorId}`);
        return;
      }
    }

    print(`Anchor found: ${anchorId}`);
    this.textlog.text = 'Anchor found';
    const hadWorldFallback = this.hasRestored && this.restoredFromWorldFallback;
    const worldSnapshots =
      this.objs.length > 0 ? this.capturePlantWorldTransforms() : [];

    const isUnsavedSessionAnchor =
      this.pendingCreatedAnchorId === anchorId && !this.anchorPersisted;
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
        print('Upgrading world preview to anchor space without respawn');
        this.restoredFromWorldFallback = false;
        this.finishStartupRebind(worldSnapshots, 'World preview upgrade');
        this.hasRestored = true;
        return;
      }

      this.restoredFromWorldFallback = false;

      if (this.objs.length > 0 && !this.hasRestored) {
        print('Attaching existing plants to anchor');
        this.finishStartupRebind(worldSnapshots, 'Attach existing plants');
        this.hasRestored = true;
        this.skipStartupWorldFallback = true;
        this.textlog.text = `Restored ${this.objs.length} plant(s)`;
        return;
      }

      if (this.hasRestored && !hadWorldFallback) {
        this.finishStartupRebind(worldSnapshots, 'Rebind restored plants');
        return;
      }

      if (!this.hasRestored) {
        this.restoreSavedObjects(true);
      }
    });
  }

  async createAnchor() {
    const spawnWorldPos = this.getSpawnWorldPosition();
    const config = this.getNextPlantConfig();
    const obj = this.spawnObjectAtWorld(spawnWorldPos);
    this.applyPlantConfig(obj, config);
  }

  public createAnchorWithConfig(config: PlantSpawnConfig) {
    const spawnWorldPos = this.getSpawnWorldPosition();
    const obj = this.spawnObjectAtWorld(spawnWorldPos);
    this.applyPlantConfig(obj, config);
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
    const epoch = this.sessionEpoch;
    const delayedEvent = this.createEvent('DelayedCallbackEvent');
    delayedEvent.bind(() => {
      if (epoch !== this.sessionEpoch || this.isResetting) {
        return;
      }
      callback();
    });
    delayedEvent.reset(delaySec);
  }

  private scheduleAnchorStableRestore(callback: () => void) {
    if (this.anchorSettleEvent) {
      this.anchorSettleEvent.enabled = false;
    }

    const epoch = this.sessionEpoch;
    let stableFrames = 0;
    let lastAnchorPos: vec3 | null = null;
    let maxWaitSec = ANCHOR_RESTORE_MAX_WAIT_SEC;
    const settleEvent = this.createEvent('UpdateEvent');
    this.anchorSettleEvent = settleEvent;
    settleEvent.bind(() => {
      if (epoch !== this.sessionEpoch || this.isResetting) {
        settleEvent.enabled = false;
        return;
      }
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
        this.captureAndLockTrashAtDesk();
        this.maintainAIContainerAnchorBinding();
        this.lockSpacePanelAtDesk();
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
          this.finishStartupRebind(worldSnapshots, 'New session anchor');
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
      if (this.isResetting || !this.currentAnchor || this.anchorPersisted || this.usingWorldSpace || this.anchorCreationInProgress) {
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
        if (this.currentAnchor) {
          this.rememberPreferredAnchor(String(this.currentAnchor.id || ''));
        }
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

  private runFastStartupRestore(): void {
    if (this.shouldSkipStartupWorldFallback()) {
      print('Skipping startup restore: session already has anchor or plants');
      return;
    }

    const store = global.persistentStorageSystem.store;
    const hasWorldData = store.has('has_world_data') && store.getBool('has_world_data');
    if (!hasWorldData) {
      print('No world preview data yet, deferring restore');
      this.textlog.text = 'Scanning for desk anchor...';
      this.scheduleWorldFallbackRestore(WORLD_PREVIEW_FALLBACK_SEC);
      return;
    }

    print('Fast restore: world preview while Snap anchor scans in background');
    this.textlog.text = 'Restoring saved plants...';
    this.restoreSavedObjects(false);
    if (this.objs.length > 0) {
      if (this.startupWorldOnlySession) {
        this.usingWorldSpace = true;
        this.restoredFromWorldFallback = true;
        this.anchorComponent.enabled = false;
        this.scheduleDelayed(() => {
          if (this.isResetting) {
            return;
          }
          this.aiContainerPersistencePaused = false;
          this.textlog.text = `Restored ${this.objs.length} object(s)`;
          print(`Crash-safe startup complete (${this.objs.length} object(s), world-only)`);
        }, STARTUP_PERSIST_DELAY_SEC);
      } else {
        this.ensureDeskAnchorForRestoredPlants();
      }
    } else {
      this.textlog.text = 'Could not restore saved plants';
      this.aiContainerPersistencePaused = false;
    }
  }

  private scheduleWorldFallbackRestore(delaySec: number) {
    this.scheduleDelayed(() => {
      if (this.shouldSkipStartupWorldFallback()) {
        print('Skipping world preview: session already has anchor or plants');
        return;
      }
      print('No saved Snap anchor nearby, restoring plants from world preview');
      this.restoreSavedObjects(false);
      if (this.objs.length > 0) {
        this.ensureDeskAnchorForRestoredPlants();
      } else {
        this.textlog.text = 'Could not restore saved plants';
      }
    }, delaySec);
  }

  private scheduleAnchorScanReminder(delaySec: number) {
    this.scheduleDelayed(() => {
      if (this.currentAnchor && this.anchorPersisted) {
        return;
      }
      print('Still scanning for saved desk anchor');
      this.textlog.text = this.hasRestored
        ? 'Look at your desk slowly to lock saved anchor'
        : 'Look at your desk slowly to find saved anchor';
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
    if (this.currentAnchor || this.anchorCreationInProgress || this.objs.length === 0) {
      return;
    }

    if (this.usesSavedAnchorSpace()) {
      print('Saved Snap anchor expected; waiting for scan without creating new session anchor');
      this.textlog.text = 'Look at your desk slowly to lock saved anchor';
      return;
    }

    print('No saved Snap anchor on device; creating session anchor at restored plants');
    this.textlog.text = `Anchoring ${this.objs.length} restored plant(s) to desk...`;
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

  public createPotAtWorldPosition(
    potPrefab: ObjectPrefab,
    potPrefabIndex: number,
    worldPos: vec3
  ): SceneObject | null {
    const obj = this.spawnTrackedObject(
      potPrefab,
      OBJECT_KIND_POT,
      potPrefabIndex,
      undefined,
      true
    );
    if (!obj) {
      return null;
    }

    obj.getTransform().setWorldPosition(worldPos);
    this.wirePotPersistence(obj);
    this.persistPlantTransforms();
    playInteractionSound((sounds) => sounds.playSpawnPot());
    return obj;
  }

  public createSeedAtWorldPosition(worldPos: vec3): SceneObject | null {
    const config = this.getNextPlantConfig();
    const obj = this.spawnTrackedObject(
      this.plantPrefab,
      OBJECT_KIND_PLANT,
      -1,
      undefined,
      true
    );
    if (!obj) {
      return null;
    }

    obj.getTransform().setWorldPosition(worldPos);
    this.applyPlantConfig(obj, config);
    this.persistPlantTransforms();
    return obj;
  }

  public registerPlantedObject(objectRoot: SceneObject): void {
    const index = this.findTrackedObjectIndex(objectRoot);
    if (index < 0) {
      return;
    }

    this.wirePlantLifecycle(this.objs[index]);
    this.persistPlantState(global.persistentStorageSystem.store, index, this.objs[index]);
    this.persistPlantTransforms();
  }

  public releaseTrackedContentObject(contentRoot: SceneObject): void {
    const index = this.objs.findIndex((obj) => !isNull(obj) && obj === contentRoot);
    if (index < 0) {
      return;
    }

    this.removeTrackedObjectAt(index);
  }

  public getTrackedContentRoot(candidate: SceneObject): SceneObject | null {
    const index = this.findTrackedObjectIndex(candidate);
    if (index < 0) {
      return null;
    }
    return this.objs[index];
  }

  public getTrackedContentRoots(): SceneObject[] {
    const roots: SceneObject[] = [];
    for (let i = 0; i < this.objs.length; i++) {
      if (!isNull(this.objs[i])) {
        roots.push(this.objs[i]);
      }
    }
    return roots;
  }

  public getTrackedWrapperRoots(): SceneObject[] {
    const roots: SceneObject[] = [];
    for (let i = 0; i < this.wrappers.length; i++) {
      if (!isNull(this.wrappers[i])) {
        roots.push(this.wrappers[i]);
      }
    }
    return roots;
  }

  public destroyTrackedObject(candidate: SceneObject): boolean {
    const index = this.findTrackedObjectIndex(candidate);
    if (index < 0) {
      return false;
    }

    this.removeTrackedObjectAt(index);
    return true;
  }

  private removeTrackedObjectAt(index: number): void {
    if (index < 0 || index >= this.wrappers.length) {
      return;
    }

    const store = global.persistentStorageSystem.store;
    const oldCount = this.wrappers.length;
    const wrapper = this.wrappers[index];
    const content = this.objs[index];

    this.wrappers.splice(index, 1);
    this.objs.splice(index, 1);
    this.objectKinds.splice(index, 1);
    this.objectPrefabIndices.splice(index, 1);

    if (!isNull(wrapper)) {
      prepareSceneObjectForDestroy(wrapper);
      const wrapperRef = wrapper;
      this.scheduleDelayed(() => {
        if (!isNull(wrapperRef)) {
          wrapperRef.destroy();
        }
      }, 0.15);
    }

    store.putInt('widget_count', this.wrappers.length);
    if (this.objs.length === 0) {
      store.remove('has_world_data');
      store.remove('uses_anchor_space');
    }

    this.trimStoredObjectSlots(store, this.wrappers.length, oldCount);
    this.persistPlantTransforms();
    this.textlog.text = `${this.objs.length} object(s) remaining`;
    print(`Removed tracked object at index ${index}`);
  }

  private trimStoredObjectSlots(
    store: GeneralDataStore,
    newCount: number,
    oldCount: number
  ): void {
    for (let i = newCount; i < oldCount; i++) {
      ['x', 'y', 'z', 'rx', 'ry', 'rz', 'rw', 'wx', 'wy', 'wz', 'wrx', 'wry', 'wrz', 'wrw']
        .forEach((key) => store.remove(`w${i}_${key}`));
      this.removePlantState(store, i);
      store.remove(`w${i}_prefab`);
      store.remove(`w${i}_object_kind`);
    }
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

    this.captureAndLockTrashAtDesk();
    this.reparentAIContainerToAnchor();
    this.lockSpacePanelAtDesk();
  }

  private captureAIContainerSceneDefaults(): void {
    if (isNull(this.menuRoot) || !isNull(this.aiContainerSceneDefaultLocalRotation)) {
      return;
    }

    this.aiContainerSceneDefaultLocalRotation =
      this.menuRoot.getTransform().getLocalRotation();
  }

  private applyAIContainerSceneRotation(): void {
    if (isNull(this.menuRoot)) {
      return;
    }

    const rotation = this.aiContainerSceneDefaultLocalRotation || quat.quatIdentity();
    this.menuRoot.getTransform().setLocalRotation(rotation);
  }

  private captureAIContainerWorldTransform(): void {
    if (isNull(this.menuRoot)) {
      return;
    }

    if (isNull(this.aiContainerFixedWorldPosition)) {
      this.aiContainerFixedWorldPosition = this.menuRoot.getTransform().getWorldPosition();
    }
  }

  private reparentAIContainerToAnchor(): void {
    if (isNull(this.menuRoot) || !this.hasActiveAnchorTracking()) {
      return;
    }

    const worldPos = this.menuRoot.getTransform().getWorldPosition();
    this.menuRoot.setParent(this.widgetParent);
    this.menuRoot.getTransform().setWorldPosition(worldPos);
    this.applyAIContainerSceneRotation();
    this.persistAIContainerTransform();
  }

  private shouldRestoreAIContainerInWorldSpace(): boolean {
    if (this.usingWorldSpace || this.restoredFromWorldFallback) {
      return true;
    }
    if (!this.hasActiveAnchorTracking()) {
      return true;
    }
    if (this.isEditorPreviewSession()) {
      return true;
    }
    return false;
  }

  private restoreAIContainerFromStorage(): void {
    this.restoreAIContainerTransform(this.shouldRestoreAIContainerInWorldSpace());
    this.aiContainerRestoreApplied = true;
  }

  private applyAIContainerSavedPose(): void {
    if (isNull(this.menuRoot) || isNull(this.aiContainerFixedWorldPosition)) {
      return;
    }

    this.menuRoot.getTransform().setWorldPosition(this.aiContainerFixedWorldPosition);
    this.applyAIContainerSceneRotation();
  }

  private maintainAIContainerAnchorBinding(): void {
    if (isNull(this.menuRoot)) {
      return;
    }

    if (this.hasActiveAnchorTracking()) {
      const parent = this.menuRoot.getParent();
      if (isNull(parent) || parent !== this.widgetParent) {
        this.reparentAIContainerToAnchor();
      }
      return;
    }

    const parent = this.menuRoot.getParent();
    if (!isNull(parent) && parent === this.widgetParent) {
      const worldPos = this.menuRoot.getTransform().getWorldPosition();
      this.menuRoot.setParent(this.findSceneRoot());
      this.menuRoot.getTransform().setWorldPosition(worldPos);
      this.applyAIContainerSceneRotation();
    }
  }

  private startAIContainerPersistenceLoop(): void {
    if (!isNull(this.aiContainerWatchEvent)) {
      return;
    }

    this.aiContainerWatchEvent = this.createEvent('UpdateEvent');
    this.aiContainerWatchEvent.bind(() => {
      this.maintainAIContainerAnchorBinding();
      this.maybePersistAIContainerMove();
    });
  }

  private maybePersistAIContainerMove(): void {
    if (isNull(this.menuRoot)) {
      return;
    }

    this.aiContainerPersistCooldown -= getDeltaTime();
    if (this.aiContainerPersistCooldown > 0) {
      return;
    }

    const worldPos = this.menuRoot.getTransform().getWorldPosition();
    if (!isNull(this.lastPersistedAIContainerWorld)) {
      if (worldPos.distance(this.lastPersistedAIContainerWorld) <= this.aiContainerMoveEpsilon) {
        return;
      }
    }

    this.aiContainerPersistCooldown = this.aiContainerPersistIntervalSec;
    this.persistAIContainerTransform();
  }

  private persistAIContainerTransform(): void {
    if (this.aiContainerPersistencePaused || this.startupRebindInProgress) {
      return;
    }
    if (isNull(this.menuRoot)) {
      return;
    }

    const store = global.persistentStorageSystem.store;
    const worldPos = this.menuRoot.getTransform().getWorldPosition();
    const anchorLocal = this.hasActiveAnchorTracking()
      ? this.worldToWidgetLocal(worldPos, quat.quatIdentity())
      : {
          pos: this.menuRoot.getTransform().getLocalPosition(),
        };

    store.putFloat('ai_container_x', anchorLocal.pos.x);
    store.putFloat('ai_container_y', anchorLocal.pos.y);
    store.putFloat('ai_container_z', anchorLocal.pos.z);
    store.putFloat('ai_container_wx', worldPos.x);
    store.putFloat('ai_container_wy', worldPos.y);
    store.putFloat('ai_container_wz', worldPos.z);
    store.putBool('ai_container_has_data', true);

    this.aiContainerFixedWorldPosition = worldPos;
    this.lastPersistedAIContainerWorld = worldPos;
    print(
      `Saved AIContainer local: ${anchorLocal.pos.toString()} world: ${worldPos.toString()}`
    );
  }

  private restoreAIContainerTransform(useWorldSpace: boolean): void {
    if (isNull(this.menuRoot)) {
      return;
    }

    const store = global.persistentStorageSystem.store;
    if (!store.has('ai_container_has_data') || !store.getBool('ai_container_has_data')) {
      this.captureAIContainerWorldTransform();
      this.lastPersistedAIContainerWorld = this.aiContainerFixedWorldPosition;
      return;
    }

    const useWorld =
      useWorldSpace || !this.hasActiveAnchorTracking() || !store.has('ai_container_x');
    if (useWorld && store.has('ai_container_wx')) {
      const worldPos = new vec3(
        store.getFloat('ai_container_wx'),
        store.getFloat('ai_container_wy'),
        store.getFloat('ai_container_wz')
      );
      const parent = this.menuRoot.getParent();
      if (!isNull(parent) && parent === this.widgetParent) {
        this.menuRoot.setParent(this.findSceneRoot());
      }
      this.menuRoot.getTransform().setWorldPosition(worldPos);
      this.applyAIContainerSceneRotation();
      this.aiContainerFixedWorldPosition = worldPos;
      this.lastPersistedAIContainerWorld = worldPos;
      print(`Restored AIContainer (world) at ${worldPos.toString()}`);
      return;
    }

    if (!store.has('ai_container_x')) {
      this.captureAIContainerWorldTransform();
      this.lastPersistedAIContainerWorld = this.aiContainerFixedWorldPosition;
      print('Restored AIContainer from scene default (no saved data)');
      return;
    }

    const localPos = new vec3(
      store.getFloat('ai_container_x'),
      store.getFloat('ai_container_y'),
      store.getFloat('ai_container_z')
    );
    this.menuRoot.setParent(this.widgetParent);
    this.menuRoot.getTransform().setLocalPosition(localPos);
    this.applyAIContainerSceneRotation();

    const worldPos = this.menuRoot.getTransform().getWorldPosition();
    this.aiContainerFixedWorldPosition = worldPos;
    this.lastPersistedAIContainerWorld = worldPos;
    print(`Restored AIContainer (anchor-local) at world: ${worldPos.toString()}`);
  }

  private lockSpacePanelAtDesk(): void {
    const panel = this.spacePanel as { lockAtDesk?: () => void };
    if (!isNull(panel) && typeof panel.lockAtDesk === 'function') {
      panel.lockAtDesk();
    }
  }

  private getTrashSceneObject(): SceneObject | null {
    if (isNull(this.trashBin)) {
      return null;
    }
    return this.trashBin.getSceneObject();
  }

  private findSceneRoot(): SceneObject {
    let root = this.getSceneObject();
    while (!isNull(root.getParent())) {
      root = root.getParent();
    }
    return root;
  }

  private captureAndLockTrashAtDesk(): void {
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject)) {
      return;
    }

    if (isNull(this.trashFixedWorldPosition)) {
      this.trashFixedWorldPosition = trashObject.getTransform().getWorldPosition();
      this.trashFixedWorldRotation = trashObject.getTransform().getWorldRotation();
    }

    const parent = trashObject.getParent();
    if (!isNull(parent) && parent === this.widgetParent) {
      trashObject.setParent(this.findSceneRoot());
    }

    trashObject.getTransform().setWorldPosition(this.trashFixedWorldPosition);
    trashObject.getTransform().setWorldRotation(this.trashFixedWorldRotation);
  }

  private notifyTrashSpawnGrace(content: SceneObject): void {
    const trash = this.trashBin as {
      notifySpawned?: (root: SceneObject, graceSeconds?: number) => void;
    };
    if (!isNull(trash) && typeof trash.notifySpawned === 'function') {
      trash.notifySpawned(content, 2);
    }
  }

  private tryTrashTrackedOnRelease(releasedRoot?: SceneObject | null): boolean {
    const trash = this.trashBin as {
      tryTrashTrackedOnRelease?: (root?: SceneObject | null) => boolean;
    };
    if (!isNull(trash) && typeof trash.tryTrashTrackedOnRelease === 'function') {
      return trash.tryTrashTrackedOnRelease(releasedRoot ?? null);
    }
    return false;
  }

  public setActiveManipulatedRoot(root: SceneObject | null): void {
    this.activeManipulatedRoot = root;
  }

  private resolveReleasedTrackedRoot(): SceneObject | null {
    return this.activeManipulatedRoot;
  }

  private wireTrashReleaseTracking(trackedRoot: SceneObject, wrapper?: SceneObject | null): void {
    const roots: SceneObject[] = [];
    if (!isNull(trackedRoot)) {
      roots.push(trackedRoot);
    }
    if (!isNull(wrapper) && wrapper !== trackedRoot) {
      roots.push(wrapper);
    }

    for (let i = 0; i < roots.length; i++) {
      this.bindTrashReleaseTrackingOnHierarchy(roots[i], trackedRoot);
    }
  }

  private bindTrashReleaseTrackingOnHierarchy(
    node: SceneObject,
    trackedRoot: SceneObject
  ): void {
    if (isNull(node)) {
      return;
    }

    if (!this.isTrashReleaseWired(node)) {
      this.markTrashReleaseWired(node);
      const scripts = node.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i] as ScriptComponent & {
          onDragStart?: { add: (cb: () => void) => void };
          onDragEnd?: { add: (cb: () => void) => void };
          onTriggerStart?: { add: (cb: () => void) => void };
          onTriggerEnd?: { add: (cb: () => void) => void };
          onTriggerEndOutside?: { add: (cb: () => void) => void };
          onInteractorTriggerStart?: { add: (cb: () => void) => void };
          onInteractorTriggerEnd?: { add: (cb: () => void) => void };
          onInteractorTriggerEndOutside?: { add: (cb: () => void) => void };
        };
        if (isNull(script) || !this.isTrashTrackingInteractionScript(script)) {
          continue;
        }

        const markActive = (): void => {
          this.activeManipulatedRoot = trackedRoot;
        };
        const onRelease = (): void => {
          this.activeManipulatedRoot = trackedRoot;
          this.saveObjectPosition();
        };

        if (script.onDragStart) {
          script.onDragStart.add(markActive);
        }
        if (script.onTriggerStart) {
          script.onTriggerStart.add(markActive);
        }
        if (script.onInteractorTriggerStart) {
          script.onInteractorTriggerStart.add(markActive);
        }

        if (script.onDragEnd) {
          script.onDragEnd.add(onRelease);
        }
        if (script.onTriggerEnd) {
          script.onTriggerEnd.add(onRelease);
        }
        if (script.onTriggerEndOutside) {
          script.onTriggerEndOutside.add(onRelease);
        }
        if (script.onInteractorTriggerEnd) {
          script.onInteractorTriggerEnd.add(onRelease);
        }
        if (script.onInteractorTriggerEndOutside) {
          script.onInteractorTriggerEndOutside.add(onRelease);
        }
      }
    }

    for (let i = 0; i < node.getChildrenCount(); i++) {
      this.bindTrashReleaseTrackingOnHierarchy(node.getChild(i), trackedRoot);
    }
  }

  private isTrashTrackingInteractionScript(script: ScriptComponent): boolean {
    const candidate = script as unknown as Record<string, unknown>;
    if (Array.isArray(candidate.onPinchUp_Select)) {
      return false;
    }
    if (candidate.manipulateRootSceneObject !== undefined) {
      return true;
    }
    return candidate.targetingMode !== undefined && candidate.onTriggerStart !== undefined;
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

  private clearPersistedPlantStorageOnly(): void {
    const store = global.persistentStorageSystem.store;
    const count = store.has('widget_count') ? store.getInt('widget_count') : 0;
    for (let i = 0; i < count; i++) {
      ['x', 'y', 'z', 'rx', 'ry', 'rz', 'rw', 'wx', 'wy', 'wz', 'wrx', 'wry', 'wrz', 'wrw']
        .forEach((key) => store.remove(`w${i}_${key}`));
      this.removePlantState(store, i);
      store.remove(`w${i}_prefab`);
      store.remove(`w${i}_object_kind`);
    }
    store.remove('widget_count');
    store.remove('has_world_data');
    store.remove('uses_anchor_space');
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
    const objectKind = store.has(`w${index}_object_kind`)
      ? store.getString(`w${index}_object_kind`)
      : OBJECT_KIND_PLANT;
    if (
      objectKind === OBJECT_KIND_PLANT &&
      this.isNearZeroOffset(pos) &&
      store.has('uses_anchor_space') &&
      store.getBool('uses_anchor_space')
    ) {
      print(`Migrating plant ${index} legacy zero offset to desk-contact offset`);
      pos.y = PLANT_ANCHOR_Y_OFFSET;
    }
    return { pos, rot };
  }

  private hasStoredWorldTransform(store: GeneralDataStore, index: number): boolean {
    return store.has(`w${index}_wx`);
  }

  private getStoredWorldTransform(
    store: GeneralDataStore,
    index: number
  ): { pos: vec3; rot: quat } {
    return {
      pos: new vec3(
        store.getFloat(`w${index}_wx`),
        store.getFloat(`w${index}_wy`),
        store.getFloat(`w${index}_wz`)
      ),
      rot: new quat(
        store.getFloat(`w${index}_wrw`),
        store.getFloat(`w${index}_wrx`),
        store.getFloat(`w${index}_wry`),
        store.getFloat(`w${index}_wrz`)
      ),
    };
  }

  private isNearZeroOffset(pos: vec3): boolean {
    return Math.abs(pos.x) < 0.1 && Math.abs(pos.y) < 0.1 && Math.abs(pos.z) < 0.1;
  }

  spawnObject(localSpawnPos?: vec3, updateStoredCount = true): SceneObject | null {
    return this.spawnTrackedObject(
      this.plantPrefab,
      OBJECT_KIND_PLANT,
      -1,
      localSpawnPos,
      updateStoredCount
    );
  }

  private spawnTrackedObject(
    prefab: ObjectPrefab,
    objectKind: string,
    prefabIndex: number,
    localSpawnPos?: vec3,
    updateStoredCount = true
  ): SceneObject | null {
    this.markSessionPlantsActive();
    const index = this.wrappers.length;
    const wrapper = global.scene.createSceneObject(
      objectKind === OBJECT_KIND_POT ? `Pot_${index}` : `Plant_${index}`
    );
    wrapper.setParent(this.getSpawnParent());

    let obj: SceneObject;
    try {
      obj = prefab.instantiate(wrapper);
    } catch (e) {
      print('spawnObject failed: ' + e);
      this.textlog.text = 'Spawn error';
      wrapper.destroy();
      return null;
    }
    obj.name = objectKind === OBJECT_KIND_POT ? `PotContent_${index}` : `PlantContent_${index}`;

    if (localSpawnPos) {
      obj.getTransform().setLocalPosition(localSpawnPos);
    }

    this.wrappers.push(wrapper);
    this.objs.push(obj);
    this.objectKinds.push(objectKind);
    this.objectPrefabIndices.push(prefabIndex);
    this.wirePlantLifecycle(obj);
    this.wirePotPersistence(obj);
    this.wireTrashReleaseTracking(obj, wrapper);

    if (updateStoredCount) {
      global.persistentStorageSystem.store.putInt('widget_count', this.wrappers.length);
    }
    if (objectKind === OBJECT_KIND_PLANT) {
      playInteractionSound((sounds) => sounds.playSpawnSeed());
    }
    this.notifyTrashSpawnGrace(wrapper);
    this.notifyTrashSpawnGrace(obj);
    return obj;
  }

  public persistPlantLifecycleState(plantContainer: SceneObject): void {
    const index = this.findTrackedObjectIndex(plantContainer);
    if (index < 0) {
      return;
    }

    const store = global.persistentStorageSystem.store;
    this.persistPlantState(store, index, this.objs[index]);
  }

  public notifyTrackedVisualHierarchyChanged(contentRoot: SceneObject): void {
    const index = this.findTrackedObjectIndex(contentRoot);
    if (index < 0) {
      return;
    }

    this.wireTrashReleaseTracking(this.objs[index], this.wrappers[index]);
  }

  private isTrashReleaseWired(node: SceneObject): boolean {
    for (let i = this.trashReleaseWiredObjects.length - 1; i >= 0; i--) {
      const wired = this.trashReleaseWiredObjects[i];
      if (isNull(wired)) {
        this.trashReleaseWiredObjects.splice(i, 1);
        continue;
      }
      if (wired === node) {
        return true;
      }
    }
    return false;
  }

  private markTrashReleaseWired(node: SceneObject): void {
    if (this.isTrashReleaseWired(node)) {
      return;
    }
    this.trashReleaseWiredObjects.push(node);
  }

  saveObjectPosition() {
    if (this.isResetting) {
      return;
    }

    const now = getTime();
    if (now - this.lastSaveObjectPositionAt < this.saveObjectPositionCooldownSec) {
      return;
    }
    this.lastSaveObjectPositionAt = now;

    print(
      `pinch up ${ANCHOR_CONTROLLER_VERSION} anchor=${!!this.currentAnchor} worldOnly=${this.usingWorldSpace} creating=${this.anchorCreationInProgress}`
    );

    this.captureAndLockTrashAtDesk();
    this.maintainAIContainerAnchorBinding();
    this.lockSpacePanelAtDesk();
    const releaseRoot = this.resolveReleasedTrackedRoot();
    this.activeManipulatedRoot = null;
    const trashedOnRelease = this.tryTrashTrackedOnRelease(releaseRoot);

    if (!this.currentAnchor && !this.anchorCreationInProgress && this.objs.length > 0 && !this.usingWorldSpace) {
      this.startWorldAnchorCreation(this.getPlantAnchorWorldMatrix());
      return;
    }

    this.restoredFromWorldFallback = false;
    this.persistPlantTransforms();
    if (!this.anchorCreationInProgress && !trashedOnRelease) {
      playInteractionSound((sounds) => sounds.playPlaceObject());
    }
    this.trySaveAnchorOnce();
  }

  private persistPlantTransforms(silent = false) {
    if (this.startupRebindInProgress && !silent) {
      return;
    }

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
      store.putString(`w${i}_object_kind`, this.objectKinds[i] || OBJECT_KIND_PLANT);
      store.putInt(`w${i}_prefab`, this.objectPrefabIndices[i]);
      this.persistPlantState(store, i, obj);

      if (!silent) {
        print(`Saved ${this.objectKinds[i] || OBJECT_KIND_PLANT} ${i} local: ${pos.toString()} world: ${worldPos.toString()}`);
        this.textlog.text = `Saved ${this.objs.length} object(s)`;
      }
    }

    store.putBool('has_world_data', true);
    if (this.hasActiveAnchorTracking()) {
      store.putBool('uses_anchor_space', true);
    }
    if (!this.aiContainerPersistencePaused && !this.startupRebindInProgress) {
      this.persistAIContainerTransform();
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
      if (!this.aiContainerRestoreApplied) {
        this.restoreAIContainerFromStorage();
      }
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
        print('Anchor-local restore empty, falling back to world preview');
        this.hasRestored = false;
        this.usingWorldSpace = true;
        this.restoredFromWorldFallback = true;
        this.restoreAllObjects(true);
        this.ensureDeskAnchorForRestoredPlants();
        this.restoreAIContainerFromStorage();
      } else {
        this.reparentPlantsToAnchor();
        this.restoreAIContainerFromStorage();
      }
    } else {
      this.usingWorldSpace = true;
      this.restoredFromWorldFallback = true;
      this.anchorComponent.enabled = true;
      this.restoreAllObjects(true);
      this.restoreAIContainerFromStorage();
    }
  }

  private clearSpawnedObjects() {
    this.wrappers.forEach((wrapper) => wrapper.destroy());
    this.wrappers = [];
    this.objs = [];
    this.objectKinds = [];
    this.objectPrefabIndices = [];
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
    print(`Restoring ${count} objects (${useWorldSpace ? 'world preview' : 'anchor'} space)`);

    let restoredCount = 0;
    for (let i = 0; i < count; i++) {
      const posKey = useWorldSpace ? 'wx' : 'x';
      if (!store.has(`w${i}_${posKey}`)) {
        print(`Skipping plant ${i}: missing saved transform`);
        continue;
      }

      const objectKind = store.has(`w${i}_object_kind`)
        ? store.getString(`w${i}_object_kind`)
        : OBJECT_KIND_PLANT;
      const prefabIndex = store.has(`w${i}_prefab`) ? store.getInt(`w${i}_prefab`) : -1;
      const prefab = this.getPrefabForStoredObject(objectKind, prefabIndex);
      if (isNull(prefab)) {
        print(`Skipping object ${i}: missing prefab for kind=${objectKind} index=${prefabIndex}`);
        continue;
      }

      const wrapper = global.scene.createSceneObject(
        objectKind === OBJECT_KIND_POT ? `Pot_${i}` : `Plant_${i}`
      );
      wrapper.setParent(this.getSpawnParent());

      let obj: SceneObject;
      try {
        obj = prefab.instantiate(wrapper);
      } catch (e) {
        print('Restore spawn failed: ' + e);
        wrapper.destroy();
        continue;
      }
      obj.name = objectKind === OBJECT_KIND_POT ? `PotContent_${i}` : `PlantContent_${i}`;

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
        let worldPos: vec3;
        let worldRot: quat;
        if (this.hasStoredWorldTransform(store, i)) {
          const world = this.getStoredWorldTransform(store, i);
          worldPos = world.pos;
          worldRot = world.rot;
        } else {
          const stored = this.getStoredAnchorLocalOffset(store, i);
          const world = this.widgetLocalToWorld(stored.pos, stored.rot);
          worldPos = world.pos;
          worldRot = world.rot;
        }
        wrapper.getTransform().setLocalPosition(new vec3(0, 0, 0));
        wrapper.getTransform().setLocalRotation(new quat(1, 0, 0, 0));
        obj.getTransform().setWorldPosition(worldPos);
        obj.getTransform().setWorldRotation(worldRot);
        print(`Restored plant ${i} at world: ${worldPos.toString()}`);
      }

      this.wrappers.push(wrapper);
      this.objs.push(obj);
      this.objectKinds.push(objectKind);
      this.objectPrefabIndices.push(prefabIndex);

      this.wirePotPersistence(obj);
      this.restorePlantState(store, i, obj);
      this.wirePlantLifecycle(obj);
      this.wireTrashReleaseTracking(obj, wrapper);
      restoredCount++;
    }

    store.putInt('widget_count', this.wrappers.length);
    this.hasRestored = true;
    this.syncPlantCycleFromCount();
    this.textlog.text = restoredCount > 0
      ? `Restored ${restoredCount} object(s)`
      : 'Could not restore saved objects';
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
    store.remove(`w${lastIndex}_object_kind`);
    store.putInt('widget_count', lastIndex);

    this.wrappers[lastIndex].destroy();
    this.wrappers.pop();
    this.objs.pop();
    this.objectKinds.pop();
    this.objectPrefabIndices.pop();

    if (this.objs.length === 0) {
      store.remove('has_world_data');
      store.remove('uses_anchor_space');
    }

    this.textlog.text = `${this.objs.length} plant(s) remaining`;
    print(`Undo: removed plant ${lastIndex}`);
  }

  async resetAnchor() {
    print('Reset: deleting all anchors and clearing saved plants');
    this.isResetting = true;
    this.sessionEpoch++;
    this.anchorRestorePending = false;
    this.anchorSaveInProgress = true;
    this.anchorCreationInProgress = false;
    this.aiContainerPersistencePaused = false;
    this.startupRebindInProgress = false;
    this.anchorBindingComplete = false;
    this.lockedAnchorId = null;
    this.startupWorldOnlySession = false;

    if (this.anchorSettleEvent) {
      this.anchorSettleEvent.enabled = false;
      this.anchorSettleEvent = undefined;
    }

    this.anchorComponent.enabled = false;
    const anchorToDelete = this.currentAnchor;

    const store = global.persistentStorageSystem.store;
    const count = store.has('widget_count') ? store.getInt('widget_count') : 0;
    for (let i = 0; i < count; i++) {
      ['x', 'y', 'z', 'rx', 'ry', 'rz', 'rw', 'wx', 'wy', 'wz', 'wrx', 'wry', 'wrz', 'wrw']
        .forEach(k => store.remove(`w${i}_${k}`));
      this.removePlantState(store, i);
      store.remove(`w${i}_prefab`);
      store.remove(`w${i}_object_kind`);
    }
    store.remove('widget_count');
    store.remove('has_world_data');
    store.remove('uses_anchor_space');
    store.remove('preferred_anchor_id');

    this.clearSpawnedObjects();
    if (this.floatingRoot) {
      this.floatingRoot.destroy();
      this.floatingRoot = undefined;
    }

    if (this.anchorSession) {
      const worldAnchor = anchorToDelete as WorldAnchor | undefined;
      if (worldAnchor?._sceneObject) {
        try {
          await this.anchorSession.deleteAnchor(worldAnchor);
          print('Deleted active session anchor');
        } catch (e) {
          print('Could not delete active anchor: ' + e);
        }
        worldAnchor._sceneObject.destroy();
      }

      try {
        await this.anchorSession.reset();
        print('Deleted all spatial anchors in area');
      } catch (e) {
        print('Anchor session reset failed: ' + e);
      }
    }

    this.hasRestored = false;
    this.anchorPersisted = false;
    this.usingWorldSpace = false;
    this.restoredFromWorldFallback = false;
    this.skipStartupWorldFallback = false;
    this.pendingCreatedAnchorId = undefined;
    this.currentAnchor = undefined;
    this.anchorComponent.anchor = null as unknown as Anchor;
    this.anchorComponent.enabled = true;
    this.nextPlantSpawnIndex = 0;
    this.isResetting = false;
    this.anchorSaveInProgress = false;
    this.textlog.text = 'Desk reset';
  }

  private persistPlantState(store: GeneralDataStore, index: number, obj: SceneObject) {
    const plant = this.findPlantLifecycle(obj);
    if (isNull(plant)) {
      return;
    }

    const state = plant.getSaveState();
    store.putInt(`w${index}_plant_lifecycle_version`, PLANT_LIFECYCLE_SAVE_VERSION);
    store.putString(`w${index}_plant_type`, state.plantTypeId);
    store.putInt(`w${index}_plant_stage`, state.stage);
    store.putFloat(`w${index}_plant_baby_remaining`, state.babyTimerRemaining);
    store.putFloat(`w${index}_plant_growth_elapsed`, state.growthElapsed);
    store.putBool(`w${index}_plant_watered`, state.hasBeenWatered);
    store.putBool(`w${index}_plant_planted`, state.isPlanted);
    if (state.isPlanted) {
      const plantRoot = plant.getSceneObject();
      const worldRot = plantRoot.getTransform().getWorldRotation();
      store.putFloat(`w${index}_plant_wrw`, worldRot.w);
      store.putFloat(`w${index}_plant_wrx`, worldRot.x);
      store.putFloat(`w${index}_plant_wry`, worldRot.y);
      store.putFloat(`w${index}_plant_wrz`, worldRot.z);
      if (state.plantedModelLocalBaseY !== undefined) {
        store.putFloat(`w${index}_plant_base_y`, state.plantedModelLocalBaseY);
        store.putFloat(`w${index}_plant_align_cx`, state.plantedAlignCenterX ?? 0);
        store.putFloat(`w${index}_plant_align_cz`, state.plantedAlignCenterZ ?? 0);
        store.putFloat(`w${index}_plant_align_y`, state.plantedAlignY ?? 0);
        store.putFloat(`w${index}_plant_growth_x`, state.plantedGrowthOffsetX ?? 0);
        store.putFloat(`w${index}_plant_growth_y`, state.plantedGrowthOffsetY ?? 0);
        store.putFloat(`w${index}_plant_growth_z`, state.plantedGrowthOffsetZ ?? 0);
      } else {
        store.remove(`w${index}_plant_base_y`);
        store.remove(`w${index}_plant_align_cx`);
        store.remove(`w${index}_plant_align_cz`);
        store.remove(`w${index}_plant_align_y`);
        store.remove(`w${index}_plant_growth_x`);
        store.remove(`w${index}_plant_growth_y`);
        store.remove(`w${index}_plant_growth_z`);
      }
    } else {
      store.remove(`w${index}_plant_wrw`);
      store.remove(`w${index}_plant_wrx`);
      store.remove(`w${index}_plant_wry`);
      store.remove(`w${index}_plant_wrz`);
      store.remove(`w${index}_plant_base_y`);
      store.remove(`w${index}_plant_align_cx`);
      store.remove(`w${index}_plant_align_cz`);
      store.remove(`w${index}_plant_align_y`);
      store.remove(`w${index}_plant_growth_x`);
      store.remove(`w${index}_plant_growth_y`);
      store.remove(`w${index}_plant_growth_z`);
    }
  }

  private restorePlantState(store: GeneralDataStore, index: number, obj: SceneObject) {
    if (!store.has(`w${index}_plant_stage`)) {
      return;
    }

    const plant = this.getOrCreateRestoredPlantLifecycle(store, index, obj);
    if (isNull(plant)) {
      return;
    }

    const plantTypeId = store.has(`w${index}_plant_type`)
      ? store.getString(`w${index}_plant_type`)
      : 'default';
    const config = this.findPlantConfig(plantTypeId);
    if (!isNull(config)) {
      (config as PlantSpawnConfig).applySpawnConfigToPlant(plant);
    }

    const saveVersion = store.has(`w${index}_plant_lifecycle_version`)
      ? store.getInt(`w${index}_plant_lifecycle_version`)
      : 1;
    const storedStage = store.getInt(`w${index}_plant_stage`);
    const stage = saveVersion >= PLANT_LIFECYCLE_SAVE_VERSION ? storedStage : storedStage + 1;
    const isPlanted =
      (store.has(`w${index}_plant_planted`) && store.getBool(`w${index}_plant_planted`)) ||
      (store.has(`w${index}_object_kind`) && store.getString(`w${index}_object_kind`) === OBJECT_KIND_POT);
    const plantedWorldRotation =
      isPlanted && store.has(`w${index}_plant_wrw`)
        ? new quat(
            store.getFloat(`w${index}_plant_wrw`),
            store.getFloat(`w${index}_plant_wrx`),
            store.getFloat(`w${index}_plant_wry`),
            store.getFloat(`w${index}_plant_wrz`)
          )
        : null;
    const plantedAlignment = store.has(`w${index}_plant_base_y`)
      ? {
            plantedModelLocalBaseY: store.getFloat(`w${index}_plant_base_y`),
            plantedAlignCenterX: store.has(`w${index}_plant_align_cx`)
              ? store.getFloat(`w${index}_plant_align_cx`)
              : 0,
            plantedAlignCenterZ: store.has(`w${index}_plant_align_cz`)
              ? store.getFloat(`w${index}_plant_align_cz`)
              : 0,
            plantedAlignY: store.has(`w${index}_plant_align_y`)
              ? store.getFloat(`w${index}_plant_align_y`)
              : 0,
            plantedGrowthOffsetX: store.has(`w${index}_plant_growth_x`)
              ? store.getFloat(`w${index}_plant_growth_x`)
              : 0,
            plantedGrowthOffsetY: store.has(`w${index}_plant_growth_y`)
              ? store.getFloat(`w${index}_plant_growth_y`)
              : 0,
            plantedGrowthOffsetZ: store.has(`w${index}_plant_growth_z`)
              ? store.getFloat(`w${index}_plant_growth_z`)
              : 0,
          }
        : {};

    const state: PlantLifecycleSaveState = {
      plantTypeId: plantTypeId,
      stage: stage,
      babyTimerRemaining: store.has(`w${index}_plant_baby_remaining`)
        ? store.getFloat(`w${index}_plant_baby_remaining`)
        : 0,
      growthElapsed: store.has(`w${index}_plant_growth_elapsed`)
        ? store.getFloat(`w${index}_plant_growth_elapsed`)
        : 0,
      hasBeenWatered:
        store.has(`w${index}_plant_watered`) && store.getBool(`w${index}_plant_watered`),
      isPlanted: isPlanted,
      plantedWorldRotation: plantedWorldRotation,
      ...plantedAlignment,
    };
    plant.applySaveState(state);
  }

  private getOrCreateRestoredPlantLifecycle(
    store: GeneralDataStore,
    index: number,
    obj: SceneObject
  ): PlantLifecycle {
    const existingPlant = this.findPlantLifecycle(obj);
    if (!isNull(existingPlant)) {
      return existingPlant;
    }

    const isPot = store.has(`w${index}_object_kind`) &&
      store.getString(`w${index}_object_kind`) === OBJECT_KIND_POT;
    if (!isPot) {
      return null as unknown as PlantLifecycle;
    }

    const pot = this.findPotScript(obj);
    if (isNull(pot) || typeof pot.createRestoredPlant !== 'function') {
      print(`Saved pot ${index} has plant state, but its prefab has no PlantPot restore script.`);
      return null as unknown as PlantLifecycle;
    }

    const restoredPlant = pot.createRestoredPlant(this.plantPrefab);
    if (!isNull(restoredPlant)) {
      restoredPlant.setAnchorPersistence(this);
    }

    return restoredPlant;
  }

  private removePlantState(store: GeneralDataStore, index: number) {
    store.remove(`w${index}_plant_lifecycle_version`);
    store.remove(`w${index}_plant_type`);
    store.remove(`w${index}_plant_stage`);
    store.remove(`w${index}_plant_baby_remaining`);
    store.remove(`w${index}_plant_growth_elapsed`);
    store.remove(`w${index}_plant_watered`);
    store.remove(`w${index}_plant_planted`);
    store.remove(`w${index}_plant_wrw`);
    store.remove(`w${index}_plant_wrx`);
    store.remove(`w${index}_plant_wry`);
    store.remove(`w${index}_plant_wrz`);
    store.remove(`w${index}_plant_base_y`);
    store.remove(`w${index}_plant_align_cx`);
    store.remove(`w${index}_plant_align_cz`);
    store.remove(`w${index}_plant_align_y`);
    store.remove(`w${index}_plant_growth_x`);
    store.remove(`w${index}_plant_growth_y`);
    store.remove(`w${index}_plant_growth_z`);
  }

  private getActivePlantConfigs(): PlantSpawnConfig[] {
    const configs: PlantSpawnConfig[] = [];
    for (let i = 0; i < this.plantConfigs.length; i++) {
      const config = this.plantConfigs[i];
      if (!isNull(config)) {
        configs.push(config);
      }
    }
    return configs;
  }

  private normalizePlantTypeId(plantTypeId: string): string {
    if (!plantTypeId || plantTypeId === 'default' || plantTypeId === 'Plant_1') {
      return 'plant_1';
    }

    return plantTypeId.toLowerCase().replace(/\s+/g, '_');
  }

  private getNextPlantConfig(): PlantSpawnConfig | null {
    const configs = this.getActivePlantConfigs();
    if (configs.length === 0) {
      return null;
    }

    const config = configs[this.nextPlantSpawnIndex % configs.length];
    this.nextPlantSpawnIndex = (this.nextPlantSpawnIndex + 1) % configs.length;
    return config;
  }

  private syncPlantCycleFromCount(): void {
    const configs = this.getActivePlantConfigs();
    if (configs.length === 0) {
      return;
    }

    this.nextPlantSpawnIndex = this.objs.length % configs.length;
  }

  private applyPlantConfig(obj: SceneObject | null, config: PlantSpawnConfig | null): void {
    if (isNull(obj) || isNull(config)) {
      return;
    }

    const resolvedObj = obj as SceneObject;
    const resolvedConfig = config as PlantSpawnConfig;
    const plant = this.findPlantLifecycle(resolvedObj);
    if (isNull(plant)) {
      return;
    }

    resolvedConfig.applyToPlant(plant);
    const index = this.objs.findIndex((entry) => !isNull(entry) && entry === resolvedObj);
    if (index >= 0) {
      this.persistPlantState(global.persistentStorageSystem.store, index, resolvedObj);
    }

    print(`Spawned ${resolvedConfig.plantTypeId} (next cycle index ${this.nextPlantSpawnIndex})`);
    this.textlog.text = `Placed ${resolvedConfig.plantTypeId}`;
  }

  private findPlantConfig(plantTypeId: string): PlantSpawnConfig | null {
    const normalized = this.normalizePlantTypeId(plantTypeId);
    for (let i = 0; i < this.plantConfigs.length; i++) {
      const config = this.plantConfigs[i];
      if (!isNull(config) && this.normalizePlantTypeId(config.plantTypeId) === normalized) {
        return config;
      }
    }

    return null;
  }

  private wirePlantLifecycle(obj: SceneObject): void {
    const index = this.findTrackedObjectIndex(obj);
    const isPot = index >= 0 && this.objectKinds[index] === OBJECT_KIND_POT;
    if (isPot) {
      const planted = this.findPlantedLifecycleInPot(obj);
      if (!isNull(planted)) {
        if (!planted.getIsPlanted()) {
          planted.setPlanted(true);
        } else {
          planted.setAllowTrashManipulation(false);
        }
      }
      return;
    }

    const plant = this.findPlantLifecycle(obj);
    if (isNull(plant)) {
      return;
    }

    plant.setAnchorPersistence(this);
    // Loose seeds/plants can still be moved to trash or repositioned, but once a plant is
    // marked planted we should lock manipulation to prevent accidental re-grabs.
    plant.setAllowTrashManipulation(!plant.getIsPlanted());
  }

  private findPlantedLifecycleInPot(potRoot: SceneObject): PlantLifecycle | null {
    const pot = this.findPotScript(potRoot);
    if (!isNull(pot) && typeof pot.getPlantedLifecycle === 'function') {
      const planted = pot.getPlantedLifecycle();
      if (!isNull(planted)) {
        return planted as PlantLifecycle;
      }
    }

    const stack: SceneObject[] = [potRoot];
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
          typeof plant.getIsPlanted === 'function' &&
          plant.getIsPlanted()
        ) {
          return plant;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
  }

  private wirePotPersistence(obj: SceneObject): void {
    const pot = this.findPotScript(obj);
    if (isNull(pot)) {
      return;
    }

    if (typeof pot.setAnchorPersistence === 'function') {
      pot.setAnchorPersistence(this);
    }
  }

  private getPrefabForStoredObject(objectKind: string, prefabIndex: number): ObjectPrefab {
    if (objectKind === OBJECT_KIND_POT) {
      if (prefabIndex >= 0 && prefabIndex < this.potPrefabs.length && !isNull(this.potPrefabs[prefabIndex])) {
        return this.potPrefabs[prefabIndex];
      }
      return null as unknown as ObjectPrefab;
    }

    return this.plantPrefab;
  }

  private findTrackedObjectIndex(sceneObject: SceneObject): number {
    for (let i = 0; i < this.objs.length; i++) {
      const obj = this.objs[i];
      const wrapper = this.wrappers[i];
      if (isNull(obj)) {
        continue;
      }
      if (obj === sceneObject || this.isDescendantOf(sceneObject, obj)) {
        return i;
      }
      if (
        !isNull(wrapper) &&
        (wrapper === sceneObject || this.isDescendantOf(sceneObject, wrapper))
      ) {
        return i;
      }
    }
    return -1;
  }

  private isDescendantOf(candidate: SceneObject, ancestor: SceneObject): boolean {
    let current = candidate;
    while (!isNull(current)) {
      if (current === ancestor) {
        return true;
      }
      current = current.getParent();
    }
    return false;
  }

  private findPotScript(root: SceneObject): {
    setAnchorPersistence?: (persistence: AnchorController) => void;
    createRestoredPlant?: (plantPrefab: ObjectPrefab) => PlantLifecycle;
    getPlantedLifecycle?: () => PlantLifecycle | null;
  } {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as {
          setAnchorPersistence?: (persistence: AnchorController) => void;
          createRestoredPlant?: (plantPrefab: ObjectPrefab) => PlantLifecycle;
          getPlantedLifecycle?: () => PlantLifecycle | null;
        };
        if (
          !isNull(candidate) &&
          (
            typeof candidate.setAnchorPersistence === 'function' ||
            typeof candidate.createRestoredPlant === 'function' ||
            typeof candidate.getPlantedLifecycle === 'function'
          )
        ) {
          return candidate;
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null as unknown as {
      setAnchorPersistence?: (persistence: AnchorController) => void;
      createRestoredPlant?: (plantPrefab: ObjectPrefab) => PlantLifecycle;
    };
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

import {
  AnchorSession,
  AnchorSessionOptions,
} from 'Spatial Anchors.lspkg/AnchorSession';
import { Anchor } from 'Spatial Anchors.lspkg/Anchor';
import { AnchorModule } from 'Spatial Anchors.lspkg/AnchorModule';
import { AnchorComponent } from 'Spatial Anchors.lspkg/AnchorComponent';
import { WorldAnchor } from 'Spatial Anchors.lspkg/WorldAnchor';
import { PlantLifecycle, PlantLifecycleSaveState, PlantStage } from './PlantLifecycle';
import { PlantSpawnConfig } from './PlantSpawnConfig';
import { InteractionSoundRegistry, playInteractionSound } from './InteractionSoundRegistry';
import { configureWaterSplashVfx } from './WaterSplashVfx';
import { prepareSceneObjectForDestroy } from './FlowGardenDestroyHooks';
import { SpecsApiClient } from './SpecsApiClient';
import {
  armGardenSourceStartupSpawnBlock,
  isGardenSourceSpawnBlocked,
} from './GardenSourceSpawnGuard';
import { GardenSourceMoveHandle } from './GardenSourceMoveHandle';
import { TrashBin, TrashObjectStoreSnapshot, TrashStashEntry } from './TrashBin';

const ANCHOR_CONTROLLER_VERSION = 'v36-respect-disabled-sources';
const GARDEN_SPAWN_SOURCE_NAMES = ['Water Source', 'Planter', 'Seeds', 'PostItNotes'];
/** Desk props that already have grab scripts — persist/reparent like garden sources, no MoveHandle. */
const DESK_PROP_NAMES = ['palette', 'Globe', 'Clock'];
const GARDEN_SOURCE_MOVE_HANDLE_NAME = 'MoveHandle';
const TRASH_BIN_SOURCE_NAME = 'TrashBin';
const GARDEN_MOVE_HANDLE_REFERENCE_SOURCE = 'Water Source';
const TRASH_MOVE_HANDLE_REFERENCE_SOURCE = 'Planter';
// Larger meshes overlap the default corner handle — push handles further out.
const GARDEN_SOURCE_MOVE_HANDLE_LOCAL_OFFSETS: { [sourceName: string]: vec3 } = {
  'Water Source': new vec3(1.35, 0.08, 1.35),
  Seeds: new vec3(1.25, 0.08, 1.25),
  PostItNotes: new vec3(0.55, 0.08, 0.55),
};
const SEEDS_STATIC_CHILD_NAMES = new Set([
  'Pot1',
  'Cube',
  'Dirt',
  'Pot3',
  'Pot2',
  'Seed',
  'SeedSack',
  'Backpack',
  GARDEN_SOURCE_MOVE_HANDLE_NAME,
]);
const SEEDS_HIDDEN_CHILD_NAMES = new Set([
  'Seed',
  'Pot1',
  'Pot2',
  'Pot3',
  'Dirt',
  'Backpack',
]);
const SEEDS_VISIBLE_CHILD_NAMES = new Set(['SeedSack', 'Cube']);
const AI_DESK_CONTROL_BUTTON_NAMES = ['Btn Undo', 'Btn Reset'];
const AI_LEGACY_PLANT_BUTTON_NAMES = [
  'Btn Place Plant',
  'Btn Tulip',
  'Btn Narcissus',
  'Btn Ranunculus',
];
const GARDEN_SOURCE_SCENE_DEFAULTS: Record<
  string,
  { pos: vec3; rot: quat; scale: vec3 }
> = {
  'Water Source': {
    pos: new vec3(14.318802, -20.641001, -79.9077),
    rot: quat.quatIdentity(),
    scale: new vec3(10, 10, 10),
  },
  Planter: {
    pos: new vec3(34.397942, -20.640976, -79.907722),
    rot: quat.quatIdentity(),
    scale: new vec3(8, 8, 8),
  },
  Seeds: {
    pos: new vec3(55.521027, -20.640976, -79.907722),
    rot: quat.quatIdentity(),
    scale: new vec3(8, 8, 8),
  },
  PostItNotes: {
    pos: new vec3(-10.0, -20.64, -79.9),
    rot: quat.quatIdentity(),
    scale: new vec3(1, 1, 1),
  },
};
const STARTUP_REBIND_DELAY_SEC = 0.35;
const STARTUP_PERSIST_DELAY_SEC = 0.5;
const WORLD_PREVIEW_REBIND_DELAY_SEC = 1;
const ANCHOR_SESSION_BOOT_DELAY_SEC = 0.75;
const ANCHOR_SESSION_BOOT_DELAY_SAVED_SEC = 2;
const ANCHOR_CREATE_GRACE_SEC = 4;
const ANCHOR_BIND_TIMEOUT_SEC = 12;
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
  @input
  @allowUndefined
  textlog!: Text;
  @input
  plantConfigs: PlantSpawnConfig[] = [];

  @input('float')
  soundVolume: number = 0.6;

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
  waterSplashPrefab!: ObjectPrefab;

  @input('float')
  waterSplashLifetime: number = 1.2;

  @input('float')
  waterSplashIntensity: number = 0.55;

  @input('int')
  waterSplashMaxParticles: number = 1000;

  @input
  @allowUndefined
  hoverTrack!: AudioTrackAsset;

  @input
  @allowUndefined
  trashBin!: ScriptComponent;

  @input
  @allowUndefined
  waterSourceRoot!: SceneObject;

  @input
  @allowUndefined
  planterRoot!: SceneObject;

  @input
  @allowUndefined
  seedsRoot!: SceneObject;

  @input
  @allowUndefined
  postItNotesRoot!: SceneObject;

  @input
  @allowUndefined
  paletteRoot!: SceneObject;

  @input
  @allowUndefined
  globeRoot!: SceneObject;

  @input
  @allowUndefined
  clockRoot!: SceneObject;

  @input
  @allowUndefined
  spacePanel!: ScriptComponent;

  @input
  @allowUndefined
  specsApi!: SpecsApiClient;

  @input
  @allowUndefined
  sackMaterial!: Material;

  @input
  @allowUndefined
  sackTexture!: Texture;

  @input
  @allowUndefined
  moveHandleMaterial!: Material;

  @input
  @allowUndefined
  moveHandleGlowMaterial!: Material;

  private anchorSession?: AnchorSession;
  private clonedSackMaterial: Material | null = null;
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
  private trashRestoreApplied = false;
  private lastPersistedTrashWorld: vec3 | null = null;
  private trashPersistCooldown = 0;
  private readonly trashPersistIntervalSec = 0.35;
  private readonly trashMoveEpsilon = 0.5;
  private aiContainerFixedWorldPosition: vec3 | null = null;
  private aiContainerSceneDefaultLocalRotation: quat | null = null;
  private aiContainerRestoreApplied = false;
  private aiContainerWatchEvent: UpdateEvent | null = null;
  private lastPersistedAIContainerWorld: vec3 | null = null;
  private aiContainerPersistCooldown = 0;
  private readonly aiContainerPersistIntervalSec = 0.35;
  private readonly aiContainerMoveEpsilon = 0.5;
  private activeManipulatedRoot: SceneObject | null = null;
  private trashReleaseRetryToken = 0;
  private lastSaveObjectPositionAt = -1;
  private readonly saveObjectPositionCooldownSec = 0.1;
  private trashReleaseWiredObjects: SceneObject[] = [];
  private gardenSpawnSourceDefaults = new Map<
    string,
    { pos: vec3; rot: quat; scale: vec3 }
  >();
  /** Scene editor enabled flags — layout must not force-enable disabled sources. */
  private gardenSourceSceneEnabled = new Map<string, boolean>();
  private gardenSourceFixedWorldPositions = new Map<string, vec3>();
  private gardenSourceLastPersistedWorld = new Map<string, vec3>();
  private gardenSourcePersistCooldowns = new Map<string, number>();
  private gardenSourceRestoreApplied = new Map<string, boolean>();
  private readonly gardenSourcePersistIntervalSec = 0.35;
  private readonly gardenSourceMoveEpsilon = 0.5;

  onAwake() {
    this.setupInteractionSounds();
    this.createEvent('OnStartEvent').bind(() => this.onStart());
  }

  private setStatusText(message: string): void {
    if (isNull(this.textlog)) {
      return;
    }
    this.textlog.text = message;
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
        grabObject: this.spawnPotTrack,
        releaseObject: this.placeObjectTrack,
        hover: this.hoverTrack ?? this.placeObjectTrack,
      },
      this.soundVolume,
      this.soundDebugLogging
    );
    this.setupWaterSplashVfx();
  }

  private setupWaterSplashVfx(): void {
    if (isNull(this.waterSplashPrefab)) {
      return;
    }

    configureWaterSplashVfx(
      this.waterSplashPrefab,
      this.getSceneObject(),
      this.waterSplashLifetime,
      this.waterSplashIntensity,
      this.waterSplashMaxParticles,
      this.soundDebugLogging
    );
  }

  async onStart() {
    this.setupInteractionSounds();
    armGardenSourceStartupSpawnBlock(3);
    print(`AnchorController ${ANCHOR_CONTROLLER_VERSION} starting`);
    this.captureGardenSpawnSourceDefaults();
    if (!this.trashRestoreApplied) {
      this.restoreTrashFromStorage();
    }
    this.applyTrashSavedPose();
    this.captureGardenSourcesInitialTransforms();
    if (!this.allGardenSourcesRestoreApplied()) {
      this.restoreGardenSourcesFromStorage();
    }
    this.applyGardenSourcesSavedPoses();
    this.restoreGardenSpawnSourcesLayout('startup');

    const store = global.persistentStorageSystem.store;
    this.purgeLooseUnplantedFromStorage(store);
    const editorPreview = this.isEditorPreviewSession();
    const hasSavedPlants =
      !editorPreview && store.has('widget_count') && store.getInt('widget_count') > 0;

    // Leave AIContainer/menuRoot enabled-state as authored in the scene
    // (currently hidden; ArvisGhost lives at scene root separately).

    if (hasSavedPlants) {
      print('Saved plants found: minimal boot (no anchor or background loops)');
      this.startupWorldOnlySession = true;
      this.usingWorldSpace = true;
      this.restoredFromWorldFallback = true;
      this.anchorBindingComplete = true;
      this.aiContainerPersistencePaused = true;
      this.anchorComponent.enabled = false;
      this.runFastStartupRestore(true);
      if (!this.trashRestoreApplied) {
        this.restoreTrashFromStorage();
      }
      this.applyTrashSavedPose();
      this.captureAIContainerSceneDefaults();
      if (!this.aiContainerRestoreApplied) {
        this.restoreAIContainerFromStorage();
      }
      this.applyAIContainerSavedPose();
      this.captureGardenSourcesInitialTransforms();
      if (!this.allGardenSourcesRestoreApplied()) {
        this.restoreGardenSourcesFromStorage();
      }
      this.applyGardenSourcesSavedPoses();
      this.wireTrashBinMovement();
      this.scheduleGardenAndTrashHandleWiring();
      this.restoreGardenSpawnSourcesLayout('minimal-boot');
      this.hasRestored = true;
      this.setStatusText(
        this.objs.length > 0
          ? `Restored ${this.objs.length} object(s)`
          : 'Garden restored'
      );
      print(`Minimal boot complete (${this.objs.length} object(s))`);
      return;
    }

    // Editor preview can't persist world anchors reliably, but we should still allow restoring
    // saved desk layouts for iteration. Only clear saved data when the user explicitly resets.

    if (editorPreview && store.has('widget_count') && store.getInt('widget_count') > 0) {
      print('Editor preview: saved plants found, restoring');
      this.restoreSavedObjects(true);
      this.hasRestored = true;
      this.usingWorldSpace = true;
    }

    if (!hasSavedPlants) {
      this.initLayoutObjectsFromStorage();
      if (this.hasActiveAnchorTracking()) {
        this.persistAIContainerTransform();
        this.persistTrashTransform();
        this.persistAllGardenSourceTransforms();
      }
    }

    this.startAnchorSaveLoop();
    this.wireTrashBinMovement();
    this.scheduleGardenAndTrashHandleWiring();
    this.wireAIContainerMovement();
    this.startAIContainerPersistenceLoop();

    this.scheduleDelayed(() => {
      void this.bootAnchorSession(false);
    }, ANCHOR_SESSION_BOOT_DELAY_SEC);
    print(
      `AnchorController startup complete (anchor session in ${ANCHOR_SESSION_BOOT_DELAY_SEC.toFixed(1)}s)`
    );
  }

  private disableAnchorModuleForSession(): void {
    if (isNull(this.anchorModule)) {
      return;
    }

    const moduleComponent = this.anchorModule as unknown as ScriptComponent;
    if (isNull(moduleComponent)) {
      return;
    }

    moduleComponent.enabled = false;
    const moduleObject = moduleComponent.getSceneObject();
    if (!isNull(moduleObject)) {
      moduleObject.enabled = false;
    }
    print('AnchorModule disabled for minimal boot session');
  }

  private initLayoutObjectsFromStorage(): void {
    if (!this.trashRestoreApplied) {
      this.restoreTrashFromStorage();
    }
    this.applyTrashSavedPose();
    this.maintainTrashAnchorBinding();
    this.captureAIContainerSceneDefaults();
    if (!this.aiContainerRestoreApplied) {
      this.restoreAIContainerFromStorage();
    }
    this.applyAIContainerSavedPose();
    this.maintainAIContainerAnchorBinding();

    this.captureGardenSourcesInitialTransforms();
    if (!this.allGardenSourcesRestoreApplied()) {
      this.restoreGardenSourcesFromStorage();
    }
    this.applyGardenSourcesSavedPoses();
    this.maintainGardenSourceAnchorBindings();
  }

  private initTrashAndAIContainerFromStorage(): void {
    this.initLayoutObjectsFromStorage();
  }

  private async bootAnchorSession(hasSavedPlants: boolean): Promise<void> {
    if (this.isResetting || this.anchorSession) {
      return;
    }

    if (!this.ensureAnchorModuleActive()) {
      print('Anchor session skipped: AnchorModule unavailable');
      this.setStatusText('Desk anchor unavailable');
      this.usingWorldSpace = true;
      this.aiContainerPersistencePaused = false;
      return;
    }

    try {
      print('Opening anchor session...');
      const anchorSessionOptions = new AnchorSessionOptions();
      anchorSessionOptions.scanForWorldAnchors = true;
      this.anchorSession = await this.anchorModule.openSession(anchorSessionOptions);
      this.anchorSession.onAnchorNearby.add(this.onAnchorNearby.bind(this));
      print('Anchor session ready');
    } catch (error) {
      print('Anchor session unavailable: ' + error);
      this.setStatusText('Desk anchor unavailable');
      this.usingWorldSpace = true;
      this.aiContainerPersistencePaused = false;
      return;
    }

    if (hasSavedPlants) {
      const store = global.persistentStorageSystem.store;
      const usesAnchorSpace =
        store.has('uses_anchor_space') && store.getBool('uses_anchor_space');
      if (usesAnchorSpace && !this.currentAnchor) {
        this.scheduleAnchorScanReminder(ANCHOR_SCAN_REMINDER_SEC);
      }
      if (this.objs.length > 0) {
        this.ensureDeskAnchorForRestoredPlants();
      }
      this.maintainTrashAnchorBinding();
      this.maintainAIContainerAnchorBinding();
      this.maintainGardenSourceAnchorBindings();
      this.scheduleAnchorBindTimeout();
    }
  }

  private scheduleAnchorBindTimeout(): void {
    this.scheduleDelayed(() => {
      if (this.isResetting || this.anchorBindingComplete) {
        return;
      }
      this.aiContainerPersistencePaused = false;
      this.startupRebindInProgress = false;
      this.anchorRestorePending = false;
      print('Anchor bind timeout; continuing in world space');
      this.setStatusText(
        this.hasRestored
          ? `Restored ${this.objs.length} object(s)`
          : 'Desk anchor unavailable'
      );
    }, ANCHOR_BIND_TIMEOUT_SEC);
  }

  private canPersistLayout(): boolean {
    return (
      !this.aiContainerPersistencePaused &&
      !this.startupRebindInProgress &&
      !this.anchorRestorePending &&
      (this.anchorBindingComplete || !this.hasRestored)
    );
  }

  private ensureAnchorModuleActive(): boolean {
    if (isNull(this.anchorModule)) {
      print('AnchorModule input is not wired on AnchorController');
      return false;
    }

    const moduleComponent = this.anchorModule as unknown as ScriptComponent;
    if (isNull(moduleComponent)) {
      return false;
    }

    const moduleObject = moduleComponent.getSceneObject();
    if (!isNull(moduleObject) && !moduleObject.enabled) {
      print('Enabling disabled AnchorModule scene object');
      moduleObject.enabled = true;
    }
    if (!moduleComponent.enabled) {
      moduleComponent.enabled = true;
    }

    return true;
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
      preferredId &&
      anchorId !== preferredId &&
      this.pendingCreatedAnchorId !== anchorId &&
      (this.usesSavedAnchorSpace() || this.hasRestored)
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
        this.applyAIContainerSavedPose();
        this.applyTrashSavedPose();
        this.applyGardenSourcesSavedPoses();
        this.aiContainerPersistencePaused = false;
        this.startupRebindInProgress = false;
        this.anchorBindingComplete = true;
        this.maintainTrashAnchorBinding();
        this.maintainAIContainerAnchorBinding();
        this.maintainGardenSourceAnchorBindings();
        this.persistAllGardenSourceTransforms();
        if (this.currentAnchor) {
          this.rememberPreferredAnchor(String(this.currentAnchor.id || ''));
        }
        print(`Startup anchor rebind complete (${this.objs.length} object(s))`);
      }, STARTUP_PERSIST_DELAY_SEC);
    }, STARTUP_REBIND_DELAY_SEC);
  }

  public onAnchorNearby(anchor: Anchor) {
    if (this.isResetting || this.startupWorldOnlySession) {
      return;
    }

    const anchorId = String(anchor.id || '');
    if (!anchorId) {
      return;
    }

    if (this.shouldIgnoreNearbyAnchor(anchorId)) {
      return;
    }

    if (this.anchorCreationInProgress) {
      print(`Canceling in-flight session anchor; using nearby anchor ${anchorId}`);
      this.anchorCreationInProgress = false;
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
    this.setStatusText('Anchor found');
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
    const skipSettleWait = hadWorldFallback;
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
        this.setStatusText(`Restored ${this.objs.length} plant(s)`);
        return;
      }

      if (this.hasRestored && !hadWorldFallback) {
        this.finishStartupRebind(worldSnapshots, 'Rebind restored plants');
        return;
      }

      if (!this.hasRestored) {
        this.restoreSavedObjects(true);
      }
    }, skipSettleWait);
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

  private scheduleAnchorStableRestore(callback: () => void, skipSettleWait = false) {
    if (skipSettleWait) {
      print('Skipping anchor settle wait; using timed rebind');
      this.scheduleDelayed(callback, WORLD_PREVIEW_REBIND_DELAY_SEC);
      return;
    }

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
        this.maintainTrashAnchorBinding();
        this.maintainAIContainerAnchorBinding();
        this.maintainGardenSourceAnchorBindings();
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
    if (
      this.startupWorldOnlySession ||
      !this.anchorSession ||
      this.anchorCreationInProgress ||
      this.currentAnchor
    ) {
      return;
    }
    this.markSessionPlantsActive();
    this.anchorCreationInProgress = true;
    this.usingWorldSpace = false;
    this.restoredFromWorldFallback = false;
    this.anchorComponent.enabled = true;
    this.setStatusText('Creating desk anchor...');
    print('Creating desk anchor');
    this.anchorSession!.createWorldAnchor(spawnWorldMat)
      .then((anchor) => {
        if (this.isResetting) {
          return;
        }

        const newAnchorId = String(anchor.id || '');
        const activeAnchorId = String(this.currentAnchor?.id || '');
        const preferredId = this.getPreferredAnchorId();
        if (
          (activeAnchorId && activeAnchorId !== newAnchorId) ||
          (preferredId && preferredId !== newAnchorId) ||
          this.anchorRestorePending
        ) {
          print(
            `Discarding new session anchor ${newAnchorId}; tracking ${activeAnchorId || preferredId}`
          );
          this.anchorCreationInProgress = false;
          return;
        }

        const worldSnapshots = this.capturePlantWorldTransforms();
        this.pendingCreatedAnchorId = anchor.id;
        this.currentAnchor = anchor;
        this.anchorComponent.enabled = true;
        this.anchorComponent.anchor = anchor;
        this.anchorPersisted = false;
        this.anchorCreationInProgress = false;
        this.setStatusText('Mapping desk... look around slowly');
        print('World anchor created at desk contact, waiting to persist');
        this.scheduleAnchorStableRestore(() => {
          this.finishStartupRebind(worldSnapshots, 'New session anchor');
          this.trySaveAnchorOnce();
        });
      })
      .catch((error) => {
        print('Error creating anchor: ' + error);
        this.setStatusText('Could not create desk anchor');
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
    this.setStatusText('Mapping desk... look around slowly');
    this.anchorSession!.saveAnchor(this.currentAnchor)
      .then(() => {
        this.anchorPersisted = true;
        this.pendingCreatedAnchorId = undefined;
        global.persistentStorageSystem.store.putBool('uses_anchor_space', true);
        if (this.currentAnchor) {
          this.rememberPreferredAnchor(String(this.currentAnchor.id || ''));
        }
        this.setStatusText('Anchor saved');
        print('Anchor saved successfully');
        this.persistPlantTransforms();
        this.anchorSaveInProgress = false;
      })
      .catch((e) => {
        print('Anchor save pending: ' + e);
        this.setStatusText('Mapping desk... stay in place');
        this.anchorSaveInProgress = false;
      });
  }

  private runFastStartupRestore(deferAnchorCreation = false): void {
    if (this.shouldSkipStartupWorldFallback()) {
      print('Skipping startup restore: session already has anchor or plants');
      return;
    }

    const store = global.persistentStorageSystem.store;
    const hasWorldData = store.has('has_world_data') && store.getBool('has_world_data');
    if (!hasWorldData) {
      print('No world preview data yet, deferring restore');
      this.setStatusText('Scanning for desk anchor...');
      this.scheduleWorldFallbackRestore(WORLD_PREVIEW_FALLBACK_SEC, deferAnchorCreation);
      return;
    }

    print('Fast restore: world preview while Snap anchor scans in background');
    this.setStatusText('Restoring saved plants...');
    this.restoreSavedObjects(false);
    if (this.objs.length > 0) {
      if (deferAnchorCreation) {
        this.setStatusText(`Restored ${this.objs.length} object(s)`);
      } else {
        this.ensureDeskAnchorForRestoredPlants();
      }
    } else {
      this.setStatusText('Could not restore saved plants');
      this.aiContainerPersistencePaused = false;
    }
  }

  private scheduleWorldFallbackRestore(delaySec: number, deferAnchorCreation = false) {
    this.scheduleDelayed(() => {
      if (this.shouldSkipStartupWorldFallback()) {
        print('Skipping world preview: session already has anchor or plants');
        return;
      }
      print('No saved Snap anchor nearby, restoring plants from world preview');
      this.restoreSavedObjects(false);
      if (this.objs.length > 0) {
        if (deferAnchorCreation && !this.anchorSession) {
          this.setStatusText(`Restored ${this.objs.length} object(s)`);
        } else {
          this.ensureDeskAnchorForRestoredPlants();
        }
      } else {
        this.setStatusText('Could not restore saved plants');
      }
    }, delaySec);
  }

  private scheduleAnchorScanReminder(delaySec: number) {
    this.scheduleDelayed(() => {
      if (this.currentAnchor && this.anchorPersisted) {
        return;
      }
      print('Still scanning for saved desk anchor');
      this.setStatusText(
        this.hasRestored
          ? 'Look at your desk slowly to lock saved anchor'
          : 'Look at your desk slowly to find saved anchor'
      );
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

    if (!this.anchorSession) {
      print('Deferring desk anchor until anchor session is ready');
      return;
    }

    const preferredId = this.getPreferredAnchorId();
    if (this.usesSavedAnchorSpace() || preferredId) {
      print('Saved Snap anchor expected; waiting for scan without creating new session anchor');
      this.setStatusText('Look at your desk slowly to lock saved anchor');
      return;
    }

    print(
      `Waiting ${ANCHOR_CREATE_GRACE_SEC}s for nearby anchor scan before creating session anchor`
    );
    this.setStatusText('Scanning for saved desk anchor...');
    this.scheduleDelayed(() => {
      if (
        this.isResetting ||
        this.currentAnchor ||
        this.anchorCreationInProgress ||
        this.objs.length === 0
      ) {
        return;
      }
      if (this.getPreferredAnchorId() || this.lockedAnchorId) {
        print('Nearby saved anchor detected during scan; skipping new session anchor');
        return;
      }

      print('No saved Snap anchor on device; creating session anchor at restored plants');
      this.setStatusText(`Anchoring ${this.objs.length} restored plant(s) to desk...`);
      this.startWorldAnchorCreation(this.getPlantAnchorWorldMatrix());
    }, ANCHOR_CREATE_GRACE_SEC);
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

    this.placeTrackedContentAtWorld(obj, worldPos);
    this.wirePotPersistence(obj);
    this.persistPlantTransforms();
    playInteractionSound((sounds) => sounds.playSpawnPot());
    return obj;
  }

  public placeTrackedContentAtWorld(
    content: SceneObject,
    worldPos: vec3,
    worldRot?: quat
  ): void {
    const index = this.findTrackedObjectIndex(content);
    if (index < 0) {
      content.getTransform().setWorldPosition(worldPos);
      if (!isNull(worldRot)) {
        content.getTransform().setWorldRotation(worldRot);
      }
      return;
    }

    const wrapper = this.wrappers[index];
    const contentTransform = content.getTransform();
    const localScale = contentTransform.getLocalScale();
    const targetRot = worldRot || contentTransform.getWorldRotation();

    if (!isNull(wrapper)) {
      wrapper.getTransform().setWorldPosition(worldPos);
      wrapper.getTransform().setWorldRotation(targetRot);
    }

    contentTransform.setLocalPosition(vec3.zero());
    contentTransform.setLocalRotation(quat.quatIdentity());
    contentTransform.setLocalScale(localScale);
  }

  public syncTrackedWrapperToContent(content: SceneObject): void {
    if (isNull(content)) {
      return;
    }

    this.placeTrackedContentAtWorld(
      content,
      content.getTransform().getWorldPosition(),
      content.getTransform().getWorldRotation()
    );
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

    this.placeTrackedContentAtWorld(obj, worldPos);
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

  public stashTrackedObjectInTrash(candidate: SceneObject): boolean {
    const index = this.findTrackedObjectIndex(candidate);
    if (index < 0) {
      return false;
    }

    const label = !isNull(this.wrappers[index]) ? this.wrappers[index].name : 'tracked';
    this.removeTrackedObjectAt(index);
    print(`Deleted tracked object ${label} in TrashBin`);
    return true;
  }

  /** Pots and watered/planted plants must not be deleted by pinch-up release near TrashBin. */
  public shouldProtectFromReleaseTrash(candidate: SceneObject): boolean {
    const index = this.findTrackedObjectIndex(candidate);
    if (index < 0) {
      return false;
    }

    const objectKind = this.objectKinds[index] || OBJECT_KIND_PLANT;
    if (objectKind === OBJECT_KIND_POT) {
      return true;
    }

    const obj = this.objs[index];
    if (isNull(obj)) {
      return false;
    }

    const plant = this.findPlantLifecycle(obj);
    if (isNull(plant)) {
      return false;
    }

    if (plant.getIsPlanted()) {
      return true;
    }

    const state = plant.getSaveState();
    return state.hasBeenWatered || state.stage !== PlantStage.Seed;
  }

  private cancelPendingTrashReleaseRetry(): void {
    this.trashReleaseRetryToken++;
  }

  public reinsertTrackedObject(
    entry: TrashStashEntry,
    worldPos: vec3,
    worldRot: quat
  ): boolean {
    if (isNull(entry.wrapper) || isNull(entry.content)) {
      return false;
    }

    const newIndex = this.wrappers.length;
    entry.wrapper.setParent(this.getSpawnParent());
    entry.wrapper.getTransform().setWorldPosition(worldPos);
    entry.wrapper.getTransform().setWorldRotation(worldRot);
    entry.wrapper.getTransform().setLocalScale(new vec3(1, 1, 1));
    entry.wrapper.enabled = true;
    entry.content.enabled = true;

    this.wrappers.push(entry.wrapper);
    this.objs.push(entry.content);
    this.objectKinds.push(entry.objectKind);
    this.objectPrefabIndices.push(entry.prefabIndex);
    this.writeObjectSlotSnapshot(newIndex, entry.storeSnapshot);

    const store = global.persistentStorageSystem.store;
    store.putInt('widget_count', this.wrappers.length);
    store.putBool('has_world_data', true);
    this.wirePotPersistence(entry.content);
    this.restorePlantState(store, newIndex, entry.content);
    this.wirePlantLifecycle(entry.content);
    this.persistPlantTransforms();
    this.wireTrashReleaseTracking(entry.content, entry.wrapper);
    this.notifyTrashSpawnGrace(entry.wrapper, 2);
    this.notifyTrashSpawnGrace(entry.content, 2);
    this.setStatusText(`${this.objs.length} object(s) remaining`);
    print(`Restored ${entry.wrapper.name} from TrashBin`);
    return true;
  }

  private removeTrackedObjectAt(
    index: number,
    options?: { preserveWrapper?: boolean }
  ): void {
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

    if (!isNull(wrapper) && !options?.preserveWrapper) {
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
    this.setStatusText(`${this.objs.length} object(s) remaining`);
    if (options?.preserveWrapper) {
      print(`Detached tracked object at index ${index} for TrashBin stash`);
    } else {
      print(`Removed tracked object at index ${index}`);
    }
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

  public getTrackedSpawnParent(): SceneObject {
    return this.getSpawnParent();
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

    this.lockSpacePanelAtDesk();
  }

  private shouldKeepAIContainerInWorldRoot(): boolean {
    const store = global.persistentStorageSystem.store;
    const storedInAnchorSpace =
      store.has('ai_container_uses_anchor_space') &&
      store.getBool('ai_container_uses_anchor_space');
    return (
      this.startupWorldOnlySession ||
      !storedInAnchorSpace ||
      this.usingWorldSpace ||
      this.restoredFromWorldFallback ||
      !this.anchorBindingComplete
    );
  }

  private shouldKeepTrashInWorldRoot(): boolean {
    const store = global.persistentStorageSystem.store;
    const storedInAnchorSpace =
      store.has('trash_bin_uses_anchor_space') &&
      store.getBool('trash_bin_uses_anchor_space');
    return (
      this.startupWorldOnlySession ||
      !storedInAnchorSpace ||
      this.usingWorldSpace ||
      this.restoredFromWorldFallback ||
      !this.anchorBindingComplete
    );
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
    this.aiContainerFixedWorldPosition = worldPos;
    this.lastPersistedAIContainerWorld = worldPos;
    if (this.canPersistLayout()) {
      this.persistAIContainerTransform();
    }
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

    if (this.anchorRestorePending || this.startupRebindInProgress) {
      return;
    }

    if (this.shouldKeepAIContainerInWorldRoot()) {
      const parent = this.menuRoot.getParent();
      if (!isNull(parent) && parent === this.widgetParent) {
        const worldPos = this.menuRoot.getTransform().getWorldPosition();
        this.menuRoot.setParent(this.findSceneRoot());
        this.menuRoot.getTransform().setWorldPosition(worldPos);
        this.applyAIContainerSceneRotation();
      }
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
      this.maintainTrashAnchorBinding();
      this.maintainGardenSourceAnchorBindings();
      this.maybePersistAIContainerMove();
      this.maybePersistTrashMove();
      this.maybePersistGardenSourceMoves();
    });
  }

  private maybePersistAIContainerMove(): void {
    if (isNull(this.menuRoot) || !this.canPersistLayout()) {
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
    if (!this.canPersistLayout()) {
      return;
    }
    if (isNull(this.menuRoot)) {
      return;
    }

    const store = global.persistentStorageSystem.store;
    const worldPos = this.menuRoot.getTransform().getWorldPosition();

    store.putFloat('ai_container_wx', worldPos.x);
    store.putFloat('ai_container_wy', worldPos.y);
    store.putFloat('ai_container_wz', worldPos.z);
    store.putBool('ai_container_has_data', true);

    if (this.hasActiveAnchorTracking()) {
      const anchorLocal = this.worldToWidgetLocal(worldPos, quat.quatIdentity());
      store.putFloat('ai_container_x', anchorLocal.pos.x);
      store.putFloat('ai_container_y', anchorLocal.pos.y);
      store.putFloat('ai_container_z', anchorLocal.pos.z);
      store.putBool('ai_container_uses_anchor_space', true);
    }

    this.aiContainerFixedWorldPosition = worldPos;
    this.lastPersistedAIContainerWorld = worldPos;
    print(
      `Saved AIContainer local: ${
        this.hasActiveAnchorTracking()
          ? new vec3(
              store.getFloat('ai_container_x'),
              store.getFloat('ai_container_y'),
              store.getFloat('ai_container_z')
            ).toString()
          : '(world-only)'
      } world: ${worldPos.toString()}`
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

    const storedInAnchorSpace =
      store.has('ai_container_uses_anchor_space') &&
      store.getBool('ai_container_uses_anchor_space');

    const useWorld =
      useWorldSpace ||
      !this.hasActiveAnchorTracking() ||
      !storedInAnchorSpace ||
      !store.has('ai_container_x');

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

  private getSceneSearchRoots(): SceneObject[] {
    const roots: SceneObject[] = [];
    const candidates = [
      this.camera,
      this.widgetParent,
      this.menuRoot,
      this.waterSourceRoot,
      this.planterRoot,
      this.seedsRoot,
      this.postItNotesRoot,
      this.paletteRoot,
      this.globeRoot,
      this.clockRoot,
      this.getTrashSceneObject(),
      this.getSceneObject(),
    ];

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (isNull(candidate)) {
        continue;
      }

      let top = candidate;
      while (!isNull(top.getParent())) {
        top = top.getParent();
      }

      let alreadyListed = false;
      for (let j = 0; j < roots.length; j++) {
        if (roots[j] === top) {
          alreadyListed = true;
          break;
        }
      }
      if (!alreadyListed) {
        roots.push(top);
      }
    }

    return roots;
  }

  private findSceneObjectByName(root: SceneObject, name: string): SceneObject | null {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      if (String(current.name) === name) {
        return current;
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
  }

  private findGardenSpawnSource(name: string): SceneObject | null {
    if (name === 'Water Source' && !isNull(this.waterSourceRoot)) {
      return this.waterSourceRoot;
    }
    if (name === 'Planter' && !isNull(this.planterRoot)) {
      return this.planterRoot;
    }
    if (name === 'Seeds' && !isNull(this.seedsRoot)) {
      return this.seedsRoot;
    }
    if (name === 'PostItNotes' && !isNull(this.postItNotesRoot)) {
      return this.postItNotesRoot;
    }
    if (name === 'palette' && !isNull(this.paletteRoot)) {
      return this.paletteRoot;
    }
    if (name === 'Globe' && !isNull(this.globeRoot)) {
      return this.globeRoot;
    }
    if (name === 'Clock' && !isNull(this.clockRoot)) {
      return this.clockRoot;
    }
    const searchRoots = this.getSceneSearchRoots();
    for (let i = 0; i < searchRoots.length; i++) {
      const found = this.findSceneObjectByName(searchRoots[i], name);
      if (!isNull(found)) {
        return found;
      }
    }

    return null;
  }

  private getAnchorLayoutSourceNames(): string[] {
    return GARDEN_SPAWN_SOURCE_NAMES.concat(DESK_PROP_NAMES);
  }

  private isGardenSpawnSourceObject(candidate: SceneObject): boolean {
    if (isNull(candidate)) {
      return false;
    }

    const layoutNames = this.getAnchorLayoutSourceNames();
    let current: SceneObject | null = candidate;
    while (!isNull(current)) {
      const name = String(current.name || '');
      for (let i = 0; i < layoutNames.length; i++) {
        if (name === layoutNames[i]) {
          return true;
        }
      }
      current = current.getParent();
    }

    return false;
  }

  private captureGardenSpawnSourceDefaults(): void {
    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      const name = layoutNames[i];
      const source = this.findGardenSpawnSource(name);
      if (isNull(source)) {
        continue;
      }

      if (!this.gardenSourceSceneEnabled.has(name)) {
        this.gardenSourceSceneEnabled.set(name, source.enabled);
      }

      if (this.gardenSpawnSourceDefaults.has(name)) {
        continue;
      }

      const sceneRoot = this.findSceneRoot();
      const parent = source.getParent();
      const sceneDefault = GARDEN_SOURCE_SCENE_DEFAULTS[name];
      if (
        !isNull(sceneDefault) &&
        (isNull(parent) || parent !== sceneRoot)
      ) {
        this.gardenSpawnSourceDefaults.set(name, sceneDefault);
        continue;
      }

      const transform = source.getTransform();
      this.gardenSpawnSourceDefaults.set(name, {
        pos: transform.getWorldPosition(),
        rot: transform.getWorldRotation(),
        scale: transform.getWorldScale(),
      });
    }
  }

  private disableSceneObjectTree(node: SceneObject): void {
    if (isNull(node)) {
      return;
    }

    node.enabled = false;
    for (let i = 0; i < node.getChildrenCount(); i++) {
      this.disableSceneObjectTree(node.getChild(i));
    }
  }

  private sanitizeGardenSpawnSourcePresentation(
    source: SceneObject,
    sourceName: string
  ): void {
    if (sourceName !== 'Seeds') {
      return;
    }

    for (let i = 0; i < source.getChildrenCount(); i++) {
      const child = source.getChild(i);
      if (isNull(child)) {
        continue;
      }

      const childName = String(child.name || '');
      if (SEEDS_HIDDEN_CHILD_NAMES.has(childName)) {
        this.disableSceneObjectTree(child);
      } else if (SEEDS_VISIBLE_CHILD_NAMES.has(childName)) {
        child.enabled = true;
      } else if (!SEEDS_STATIC_CHILD_NAMES.has(childName)) {
        child.destroy();
        i--;
      }
    }

    this.applySeedSackVisual(source);
  }

  private findNamedChild(root: SceneObject, name: string): SceneObject | null {
    if (isNull(root)) {
      return null;
    }

    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      if (String(current.name || '') === name) {
        return current;
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return null;
  }

  private applySeedSackVisual(seedsRoot: SceneObject): void {
    if (isNull(this.sackMaterial) || isNull(this.sackTexture)) {
      return;
    }

    const seedSack = this.findNamedChild(seedsRoot, 'SeedSack');
    if (isNull(seedSack)) {
      return;
    }

    seedSack.enabled = true;
    const sackObject = this.findNamedChild(seedSack, 'sack');
    if (isNull(sackObject)) {
      return;
    }

    sackObject.enabled = true;
    const visuals = sackObject.getComponents('Component.RenderMeshVisual');
    if (visuals.length === 0) {
      return;
    }

    if (isNull(this.clonedSackMaterial)) {
      this.clonedSackMaterial = this.sackMaterial.clone();
    }

    this.clonedSackMaterial.mainPass.baseTex = this.sackTexture;
    for (let i = 0; i < visuals.length; i++) {
      const visual = visuals[i] as RenderMeshVisual;
      if (isNull(visual)) {
        continue;
      }
      visual.mainMaterial = this.clonedSackMaterial;
      visual.enabled = true;
    }

    print(
      `Seed sack texture applied (${this.sackTexture.name}) on ${visuals.length} mesh visual(s)`
    );

    this.ensureSeedSackCollider(sackObject);
  }

  private ensureSeedSackCollider(sackObject: SceneObject): void {
    let collider = sackObject.getComponent('Component.ColliderComponent') as ColliderComponent;
    if (isNull(collider)) {
      collider = sackObject.createComponent('Component.ColliderComponent') as ColliderComponent;
    }

    if (isNull(collider)) {
      return;
    }

    collider.enabled = true;
    collider.intangible = false;
    collider.fitVisual = true;
    collider.shape = Shape.createBoxShape();
  }

  private shouldKeepGardenSourceInWorldRoot(sourceName: string): boolean {
    const store = global.persistentStorageSystem.store;
    const slug = this.getGardenSourceStorageSlug(sourceName);
    const storedInAnchorSpace =
      store.has(`${slug}_uses_anchor_space`) &&
      store.getBool(`${slug}_uses_anchor_space`);
    return (
      this.startupWorldOnlySession ||
      !storedInAnchorSpace ||
      this.usingWorldSpace ||
      this.restoredFromWorldFallback ||
      !this.anchorBindingComplete
    );
  }

  private getGardenSourceStorageSlug(sourceName: string): string {
    if (sourceName === 'Water Source') {
      return 'water_source';
    }
    if (sourceName === 'Planter') {
      return 'planter';
    }
    if (sourceName === 'Seeds') {
      return 'seeds';
    }

    return String(sourceName || 'garden_source')
      .toLowerCase()
      .replace(/\s+/g, '_');
  }

  private allGardenSourcesRestoreApplied(): boolean {
    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      if (!this.gardenSourceRestoreApplied.get(layoutNames[i])) {
        return false;
      }
    }

    return layoutNames.length > 0;
  }

  private captureGardenSourcesInitialTransforms(): void {
    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      const name = layoutNames[i];
      if (this.gardenSourceFixedWorldPositions.has(name)) {
        continue;
      }

      const source = this.findGardenSpawnSource(name);
      if (isNull(source)) {
        continue;
      }

      this.gardenSourceFixedWorldPositions.set(
        name,
        source.getTransform().getWorldPosition()
      );
    }
  }

  private restoreGardenSourcesFromStorage(): void {
    const useWorldSpace = this.shouldRestoreAIContainerInWorldSpace();
    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      const name = layoutNames[i];
      this.restoreGardenSourceTransform(name, useWorldSpace);
      this.gardenSourceRestoreApplied.set(name, true);
    }
  }

  private applyGardenSourcesSavedPoses(): void {
    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      this.applyGardenSourceSavedPose(layoutNames[i]);
    }
  }

  private applyGardenSourceSavedPose(sourceName: string): void {
    const source = this.findGardenSpawnSource(sourceName);
    const savedPos = this.gardenSourceFixedWorldPositions.get(sourceName);
    if (isNull(source) || isNull(savedPos)) {
      return;
    }

    if (!isNull(this.activeManipulatedRoot) && this.activeManipulatedRoot === source) {
      return;
    }

    source.getTransform().setWorldPosition(savedPos);
  }

  private maintainGardenSourceAnchorBindings(): void {
    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      this.maintainGardenSourceAnchorBinding(layoutNames[i]);
    }
  }

  private maintainGardenSourceAnchorBinding(sourceName: string): void {
    const source = this.findGardenSpawnSource(sourceName);
    if (isNull(source)) {
      return;
    }

    if (this.anchorRestorePending || this.startupRebindInProgress) {
      return;
    }

    if (this.shouldKeepGardenSourceInWorldRoot(sourceName)) {
      const parent = source.getParent();
      if (!isNull(parent) && parent === this.widgetParent) {
        const worldPos = source.getTransform().getWorldPosition();
        source.setParent(this.findSceneRoot());
        source.getTransform().setWorldPosition(worldPos);
      }
      return;
    }

    if (this.hasActiveAnchorTracking()) {
      const parent = source.getParent();
      if (isNull(parent) || parent !== this.widgetParent) {
        this.reparentGardenSourceToAnchor(source, sourceName);
      }
      return;
    }

    const parent = source.getParent();
    if (!isNull(parent) && parent === this.widgetParent) {
      const worldPos = source.getTransform().getWorldPosition();
      source.setParent(this.findSceneRoot());
      source.getTransform().setWorldPosition(worldPos);
    }
  }

  private reparentGardenSourceToAnchor(source: SceneObject, sourceName: string): void {
    if (!this.hasActiveAnchorTracking()) {
      return;
    }

    const worldPos = source.getTransform().getWorldPosition();
    source.setParent(this.widgetParent);
    source.getTransform().setWorldPosition(worldPos);
    if (this.canPersistLayout()) {
      this.persistGardenSourceTransform(sourceName);
    }
  }

  private maybePersistGardenSourceMoves(): void {
    if (!this.canPersistLayout()) {
      return;
    }

    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      const name = layoutNames[i];
      const source = this.findGardenSpawnSource(name);
      if (isNull(source)) {
        continue;
      }

      let cooldown = this.gardenSourcePersistCooldowns.get(name) ?? 0;
      cooldown -= getDeltaTime();
      if (cooldown > 0) {
        this.gardenSourcePersistCooldowns.set(name, cooldown);
        continue;
      }

      const worldPos = source.getTransform().getWorldPosition();
      const lastPersisted = this.gardenSourceLastPersistedWorld.get(name);
      if (!isNull(lastPersisted) && worldPos.distance(lastPersisted) <= this.gardenSourceMoveEpsilon) {
        this.gardenSourcePersistCooldowns.set(name, cooldown);
        continue;
      }

      this.gardenSourcePersistCooldowns.set(name, this.gardenSourcePersistIntervalSec);
      this.persistGardenSourceTransform(name);
    }
  }

  private clearGardenSourceStorage(sourceName: string): void {
    const store = global.persistentStorageSystem.store;
    const slug = this.getGardenSourceStorageSlug(sourceName);
    store.remove(`${slug}_wx`);
    store.remove(`${slug}_wy`);
    store.remove(`${slug}_wz`);
    store.remove(`${slug}_x`);
    store.remove(`${slug}_y`);
    store.remove(`${slug}_z`);
    store.remove(`${slug}_has_data`);
    store.remove(`${slug}_uses_anchor_space`);
  }

  private restoreGardenSourceTransform(sourceName: string, useWorldSpace: boolean): void {
    const source = this.findGardenSpawnSource(sourceName);
    if (isNull(source)) {
      return;
    }

    const store = global.persistentStorageSystem.store;
    const slug = this.getGardenSourceStorageSlug(sourceName);
    const hasDataKey = `${slug}_has_data`;
    if (!store.has(hasDataKey) || !store.getBool(hasDataKey)) {
      this.captureGardenSourceInitialTransform(sourceName);
      this.gardenSourceLastPersistedWorld.set(
        sourceName,
        this.gardenSourceFixedWorldPositions.get(sourceName) ?? source.getTransform().getWorldPosition()
      );
      return;
    }

    const storedInAnchorSpace =
      store.has(`${slug}_uses_anchor_space`) &&
      store.getBool(`${slug}_uses_anchor_space`);
    const useWorld =
      useWorldSpace ||
      !this.hasActiveAnchorTracking() ||
      !storedInAnchorSpace ||
      !store.has(`${slug}_x`);

    if (useWorld && store.has(`${slug}_wx`)) {
      const worldPos = new vec3(
        store.getFloat(`${slug}_wx`),
        store.getFloat(`${slug}_wy`),
        store.getFloat(`${slug}_wz`)
      );
      const parent = source.getParent();
      if (!isNull(parent) && parent === this.widgetParent) {
        source.setParent(this.findSceneRoot());
      }
      source.getTransform().setWorldPosition(worldPos);
      this.gardenSourceFixedWorldPositions.set(sourceName, worldPos);
      this.gardenSourceLastPersistedWorld.set(sourceName, worldPos);
      print(`Restored ${sourceName} (world) at ${worldPos.toString()}`);
      return;
    }

    if (!store.has(`${slug}_x`)) {
      this.captureGardenSourceInitialTransform(sourceName);
      this.gardenSourceLastPersistedWorld.set(
        sourceName,
        this.gardenSourceFixedWorldPositions.get(sourceName) ?? source.getTransform().getWorldPosition()
      );
      print(`Restored ${sourceName} from scene default (no saved data)`);
      return;
    }

    const localPos = new vec3(
      store.getFloat(`${slug}_x`),
      store.getFloat(`${slug}_y`),
      store.getFloat(`${slug}_z`)
    );
    source.setParent(this.widgetParent);
    source.getTransform().setLocalPosition(localPos);

    const worldPos = source.getTransform().getWorldPosition();
    this.gardenSourceFixedWorldPositions.set(sourceName, worldPos);
    this.gardenSourceLastPersistedWorld.set(sourceName, worldPos);
    print(`Restored ${sourceName} (anchor-local) at world: ${worldPos.toString()}`);
  }

  private captureGardenSourceInitialTransform(sourceName: string): void {
    if (this.gardenSourceFixedWorldPositions.has(sourceName)) {
      return;
    }

    const source = this.findGardenSpawnSource(sourceName);
    if (isNull(source)) {
      return;
    }

    this.gardenSourceFixedWorldPositions.set(
      sourceName,
      source.getTransform().getWorldPosition()
    );
  }

  private restoreGardenSpawnSourcesLayout(reason: string): void {
    const sceneRoot = this.findSceneRoot();
    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      const name = layoutNames[i];
      const source = this.findGardenSpawnSource(name);
      if (isNull(source)) {
        print(`Anchor layout object missing: ${name} (${reason})`);
        continue;
      }

      // Honor the scene checkbox — do not revive sources disabled in the editor.
      const sceneEnabled = this.gardenSourceSceneEnabled.has(name)
        ? this.gardenSourceSceneEnabled.get(name)
        : source.enabled;
      source.enabled = !!sceneEnabled;
      if (!sceneEnabled) {
        print(`Anchor layout object ${name} left disabled (${reason})`);
        continue;
      }

      this.sanitizeGardenSpawnSourcePresentation(source, name);

      if (reason === 'reset') {
        this.clearGardenSourceStorage(name);
        if (source.getParent() !== sceneRoot) {
          source.setParent(sceneRoot);
        }

        const defaults =
          GARDEN_SOURCE_SCENE_DEFAULTS[name] ||
          this.gardenSpawnSourceDefaults.get(name);
        if (defaults) {
          source.getTransform().setWorldPosition(defaults.pos);
          source.getTransform().setWorldRotation(defaults.rot);
          source.getTransform().setWorldScale(defaults.scale);
        }

        this.gardenSourceFixedWorldPositions.delete(name);
        this.gardenSourceLastPersistedWorld.delete(name);
        this.gardenSourceRestoreApplied.delete(name);
        print(`Anchor layout object ${name} reset (${reason})`);
        continue;
      }

      if (this.shouldKeepGardenSourceInWorldRoot(name)) {
        const parent = source.getParent();
        if (!isNull(parent) && parent === this.widgetParent) {
          const worldPos = source.getTransform().getWorldPosition();
          source.setParent(sceneRoot);
          source.getTransform().setWorldPosition(worldPos);
        } else if (isNull(parent) || parent !== sceneRoot) {
          const worldPos = source.getTransform().getWorldPosition();
          source.setParent(sceneRoot);
          source.getTransform().setWorldPosition(worldPos);
        }
      }

      if (!this.gardenSourceRestoreApplied.get(name)) {
        const defaults =
          this.gardenSpawnSourceDefaults.get(name) ||
          GARDEN_SOURCE_SCENE_DEFAULTS[name];
        if (defaults) {
          source.getTransform().setWorldPosition(defaults.pos);
          source.getTransform().setWorldRotation(defaults.rot);
          source.getTransform().setWorldScale(defaults.scale);
        }
      }

      const worldPos = source.getTransform().getWorldPosition();
      print(
        `Anchor layout object ${name} ready (${reason}) at world: {x: ${worldPos.x}, y: ${worldPos.y}, z: ${worldPos.z}}`
      );
    }
  }

  private restoreGardenSpawnSourcesAfterReset(): void {
    this.restoreGardenSpawnSourcesLayout('reset');
  }

  private captureTrashInitialTransform(): void {
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject) || !isNull(this.trashFixedWorldPosition)) {
      return;
    }

    this.trashFixedWorldPosition = trashObject.getTransform().getWorldPosition();
  }

  private restoreTrashFromStorage(): void {
    this.restoreTrashTransform(this.shouldRestoreAIContainerInWorldSpace());
    this.trashRestoreApplied = true;
  }

  private applyTrashSavedPose(): void {
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject) || isNull(this.trashFixedWorldPosition)) {
      return;
    }

    if (isGardenSourceSpawnBlocked(trashObject)) {
      return;
    }

    if (!isNull(this.activeManipulatedRoot) && this.activeManipulatedRoot === trashObject) {
      return;
    }

    trashObject.getTransform().setWorldPosition(this.trashFixedWorldPosition);
  }

  private maintainTrashAnchorBinding(): void {
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject)) {
      return;
    }

    if (this.anchorRestorePending || this.startupRebindInProgress) {
      return;
    }

    if (isGardenSourceSpawnBlocked(trashObject)) {
      return;
    }

    if (this.shouldKeepTrashInWorldRoot()) {
      const parent = trashObject.getParent();
      if (!isNull(parent) && parent === this.widgetParent) {
        const worldPos = trashObject.getTransform().getWorldPosition();
        trashObject.setParent(this.findSceneRoot());
        trashObject.getTransform().setWorldPosition(worldPos);
      }
      return;
    }

    if (this.hasActiveAnchorTracking()) {
      const parent = trashObject.getParent();
      if (isNull(parent) || parent !== this.widgetParent) {
        this.reparentTrashToAnchor();
      }
      return;
    }

    const parent = trashObject.getParent();
    if (!isNull(parent) && parent === this.widgetParent) {
      const worldPos = trashObject.getTransform().getWorldPosition();
      trashObject.setParent(this.findSceneRoot());
      trashObject.getTransform().setWorldPosition(worldPos);
    }
  }

  private reparentTrashToAnchor(): void {
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject) || !this.hasActiveAnchorTracking()) {
      return;
    }

    const worldPos = trashObject.getTransform().getWorldPosition();
    trashObject.setParent(this.widgetParent);
    trashObject.getTransform().setWorldPosition(worldPos);
    this.persistTrashTransform();
  }

  private maybePersistTrashMove(): void {
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject) || !this.canPersistLayout()) {
      return;
    }

    this.trashPersistCooldown -= getDeltaTime();
    if (this.trashPersistCooldown > 0) {
      return;
    }

    const worldPos = trashObject.getTransform().getWorldPosition();
    if (
      !isNull(this.lastPersistedTrashWorld) &&
      worldPos.distance(this.lastPersistedTrashWorld) <= this.trashMoveEpsilon
    ) {
      return;
    }

    this.trashPersistCooldown = this.trashPersistIntervalSec;
    this.persistTrashTransform();
  }

  public persistTrashTransform(): void {
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject)) {
      return;
    }

    const store = global.persistentStorageSystem.store;
    const worldPos = trashObject.getTransform().getWorldPosition();

    store.putFloat('trash_bin_wx', worldPos.x);
    store.putFloat('trash_bin_wy', worldPos.y);
    store.putFloat('trash_bin_wz', worldPos.z);
    store.putBool('trash_bin_has_data', true);

    if (this.hasActiveAnchorTracking()) {
      const anchorLocal = this.worldToWidgetLocal(worldPos, quat.quatIdentity());
      store.putFloat('trash_bin_x', anchorLocal.pos.x);
      store.putFloat('trash_bin_y', anchorLocal.pos.y);
      store.putFloat('trash_bin_z', anchorLocal.pos.z);
      store.putBool('trash_bin_uses_anchor_space', true);
      this.trashFixedWorldPosition = worldPos;
      this.lastPersistedTrashWorld = worldPos;
      print(
        `Saved TrashBin (anchor-local + world) at ${worldPos.toString()}`
      );
      return;
    }

    store.putBool('trash_bin_uses_anchor_space', false);
    this.trashFixedWorldPosition = worldPos;
    this.lastPersistedTrashWorld = worldPos;
    print(`Saved TrashBin (world) at ${worldPos.toString()}`);
  }

  private restoreTrashTransform(useWorldSpace: boolean): void {
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject)) {
      return;
    }

    const store = global.persistentStorageSystem.store;
    if (!store.has('trash_bin_has_data') || !store.getBool('trash_bin_has_data')) {
      this.captureTrashInitialTransform();
      this.lastPersistedTrashWorld = this.trashFixedWorldPosition;
      return;
    }

    const storedInAnchorSpace =
      store.has('trash_bin_uses_anchor_space') &&
      store.getBool('trash_bin_uses_anchor_space');

    const useWorld =
      useWorldSpace || !this.hasActiveAnchorTracking() || !storedInAnchorSpace || !store.has('trash_bin_x');
    if (useWorld && store.has('trash_bin_wx')) {
      const worldPos = new vec3(
        store.getFloat('trash_bin_wx'),
        store.getFloat('trash_bin_wy'),
        store.getFloat('trash_bin_wz')
      );
      const parent = trashObject.getParent();
      if (!isNull(parent) && parent === this.widgetParent) {
        trashObject.setParent(this.findSceneRoot());
      }
      trashObject.getTransform().setWorldPosition(worldPos);
      this.trashFixedWorldPosition = worldPos;
      this.lastPersistedTrashWorld = worldPos;
      print(`Restored TrashBin (world) at ${worldPos.toString()}`);
      return;
    }

    if (!store.has('trash_bin_x')) {
      this.captureTrashInitialTransform();
      this.lastPersistedTrashWorld = this.trashFixedWorldPosition;
      print('Restored TrashBin from scene default (no saved data)');
      return;
    }

    const localPos = new vec3(
      store.getFloat('trash_bin_x'),
      store.getFloat('trash_bin_y'),
      store.getFloat('trash_bin_z')
    );
    trashObject.setParent(this.widgetParent);
    trashObject.getTransform().setLocalPosition(localPos);

    const worldPos = trashObject.getTransform().getWorldPosition();
    this.trashFixedWorldPosition = worldPos;
    this.lastPersistedTrashWorld = worldPos;
    print(`Restored TrashBin (anchor-local) at world: ${worldPos.toString()}`);
  }

  private wireTrashBinMovement(): void {
    const trash = this.trashBin as TrashBin;
    if (!isNull(trash)) {
      if (typeof trash.setUseExternalMoveHandle === 'function') {
        trash.setUseExternalMoveHandle(true);
      }
      if (typeof trash.bindStashRestore === 'function') {
        trash.bindStashRestore(this);
      }
    }
  }

  private scheduleGardenAndTrashHandleWiring(): void {
    this.scheduleDelayed(() => {
      this.wireGardenSourceMoveHandles();
      this.ensureTrashBinMoveHandle();
    }, 0.3);
    // TrashBin is much smaller than garden sources — retry once if copySceneObject races a reset.
    this.scheduleDelayed(() => {
      this.ensureTrashBinMoveHandle();
    }, 0.75);
  }

  private findMoveHandleTemplate(): SceneObject | null {
    for (let i = 0; i < GARDEN_SPAWN_SOURCE_NAMES.length; i++) {
      const source = this.findGardenSpawnSource(GARDEN_SPAWN_SOURCE_NAMES[i]);
      if (isNull(source)) {
        continue;
      }

      const handle = this.findNamedChild(source, GARDEN_SOURCE_MOVE_HANDLE_NAME);
      if (!isNull(handle)) {
        return handle;
      }
    }

    return null;
  }

  private findTrashMoveHandleTemplate(): SceneObject | null {
    const planter = this.findGardenSpawnSource(TRASH_MOVE_HANDLE_REFERENCE_SOURCE);
    if (!isNull(planter)) {
      const handle = this.findNamedChild(planter, GARDEN_SOURCE_MOVE_HANDLE_NAME);
      if (!isNull(handle)) {
        return handle;
      }
    }

    return this.findMoveHandleTemplate();
  }

  private ensureTrashBinMoveHandle(): void {
    const trash = this.getTrashSceneObject();
    const template = this.findTrashMoveHandleTemplate();
    if (isNull(trash)) {
      print('TrashBin move handle skipped: trash scene object not found');
      return;
    }
    if (isNull(template)) {
      print('TrashBin move handle skipped: no garden source MoveHandle template found');
      return;
    }

    let handle = this.findNamedChild(trash, GARDEN_SOURCE_MOVE_HANDLE_NAME);
    if (!isNull(handle) && !this.hasGardenSourceMoveHandleScript(handle)) {
      handle.destroy();
      handle = null;
    }
    if (isNull(handle)) {
      handle = this.createMoveHandleFromTemplate(trash, template);
    }
    if (isNull(handle)) {
      print('TrashBin move handle skipped: failed to create MoveHandle');
      return;
    }

    handle.enabled = true;
    this.applyTrashBinMoveHandleLayout(handle, trash, template);
    this.applyGardenSourceMoveHandleVisual(handle);
    this.applyGardenSourceMoveHandleGlow(handle);

    // Container hover on, root grab/manipulation off — child MoveHandle owns movement.
    this.setTrashRootMoveEnabled(false);
    this.configureTrashBinForExternalHandle(trash);
    const trashComponent = this.trashBin as TrashBin;
    if (!isNull(trashComponent) && typeof trashComponent.setUseExternalMoveHandle === 'function') {
      trashComponent.setUseExternalMoveHandle(true);
    }

    let wired = false;
    const scripts = handle.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i] as GardenSourceMoveHandle;
      if (isNull(script) || typeof script.wireMoveInteraction !== 'function') {
        continue;
      }

      script.sourceRoot = trash;
      script.sourceName = TRASH_BIN_SOURCE_NAME;
      script.anchorController = this;
      if (!isNull(this.moveHandleMaterial)) {
        script.handleMaterial = this.moveHandleMaterial;
      }
      if (!isNull(this.moveHandleGlowMaterial)) {
        script.glowMaterial = this.moveHandleGlowMaterial;
      }
      script.wireMoveInteraction();
      if (typeof script.refreshManipulationRootBinding === 'function') {
        script.refreshManipulationRootBinding();
      }
      this.bindTrashHandleManipulationRoot(handle, trash);
      if (typeof script.refreshHandlePresentation === 'function') {
        script.refreshHandlePresentation();
      }
      wired = true;
    }

    // Keep corner layout after wire/visual setup (glow helpers must not fight position).
    this.applyTrashBinMoveHandleLayout(handle, trash, template);
    this.configureTrashBinForExternalHandle(trash);

    if (wired) {
      const worldPos = handle.getTransform().getWorldPosition();
      const trashWorldPos = trash.getTransform().getWorldPosition();
      const localPos = handle.getTransform().getLocalPosition();
      const manipRoot = this.getHandleManipulationRootName(handle);
      print(
        `TrashBin move handle local ${localPos.toString()} world ${worldPos.toString()} (trash ${trashWorldPos.toString()}, manipRoot=${manipRoot})`
      );
    } else {
      print('TrashBin move handle created but GardenSourceMoveHandle script was not found');
    }
  }

  private getHandleManipulationRootName(handle: SceneObject): string {
    const scripts = handle.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as ScriptComponent & {
        manipulateRootSceneObject?: SceneObject;
      };
      if (!isNull(candidate) && !isNull(candidate.manipulateRootSceneObject)) {
        return String(candidate.manipulateRootSceneObject.name || '?');
      }
    }
    return 'missing';
  }

  private hasGardenSourceMoveHandleScript(handle: SceneObject): boolean {
    const scripts = handle.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i] as GardenSourceMoveHandle;
      if (!isNull(script) && typeof script.wireMoveInteraction === 'function') {
        return true;
      }
    }
    return false;
  }

  private createMoveHandleFromTemplate(
    parent: SceneObject,
    template: SceneObject
  ): SceneObject | null {
    if (isNull(parent) || isNull(template)) {
      return null;
    }

    try {
      const handle = parent.copySceneObject(template);
      if (!isNull(handle)) {
        handle.name = GARDEN_SOURCE_MOVE_HANDLE_NAME;
        handle.enabled = true;
        return handle;
      }
    } catch (error) {
      print(`TrashBin move handle copy failed (parent.copySceneObject): ${error}`);
    }

    try {
      const handle = template.copySceneObject(parent);
      if (!isNull(handle)) {
        handle.name = GARDEN_SOURCE_MOVE_HANDLE_NAME;
        handle.enabled = true;
        return handle;
      }
    } catch (error) {
      print(`TrashBin move handle copy failed (template.copySceneObject): ${error}`);
    }

    return null;
  }

  private applyTrashBinMoveHandleLayout(
    handle: SceneObject,
    trash: SceneObject,
    template: SceneObject
  ): void {
    const templateTransform = template.getTransform();
    const templateScale = templateTransform.getLocalScale();
    const scaleCompensation = this.getTrashMoveHandleScaleCompensation(trash);
    handle.getTransform().setLocalScale(
      new vec3(
        templateScale.x * scaleCompensation,
        templateScale.y * scaleCompensation,
        templateScale.z * scaleCompensation
      )
    );

    const referenceSource = this.findGardenSpawnSource(TRASH_MOVE_HANDLE_REFERENCE_SOURCE);
    const referenceHandle = isNull(referenceSource)
      ? null
      : this.findNamedChild(referenceSource, GARDEN_SOURCE_MOVE_HANDLE_NAME);
    if (!isNull(referenceSource) && !isNull(referenceHandle)) {
      const referenceLocal = referenceHandle.getTransform().getLocalPosition();
      const referenceScale = referenceSource.getTransform().getLocalScale();
      const trashScale = trash.getTransform().getLocalScale();
      // Planter uses local (0.88,-0.05,0.88) on scale ~8. Trash root scale is much smaller,
      // so convert that corner to trash-local space — same world corner, not center of mesh.
      handle.getTransform().setLocalPosition(
        new vec3(
          (referenceLocal.x * referenceScale.x) / Math.max(trashScale.x, 0.001),
          (referenceLocal.y * referenceScale.y) / Math.max(trashScale.y, 0.001),
          (referenceLocal.z * referenceScale.z) / Math.max(trashScale.z, 0.001)
        )
      );
      return;
    }

    handle.getTransform().setLocalPosition(templateTransform.getLocalPosition());
  }

  private bindTrashHandleManipulationRoot(handle: SceneObject, trash: SceneObject): void {
    const scripts = handle.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const manipulation = scripts[i] as ScriptComponent & {
        manipulateRootSceneObject?: SceneObject;
        enableTranslation?: boolean;
        enableRotation?: boolean;
        enableScale?: boolean;
        setManipulateRoot?: (root: Transform) => void;
      };
      if (isNull(manipulation) || manipulation.manipulateRootSceneObject === undefined) {
        continue;
      }

      manipulation.manipulateRootSceneObject = trash;
      manipulation.enableTranslation = true;
      manipulation.enableRotation = false;
      manipulation.enableScale = false;
      if (typeof manipulation.setManipulateRoot === 'function') {
        manipulation.setManipulateRoot(trash.getTransform());
      }
      manipulation.enabled = true;
      return;
    }
  }

  private configureTrashBinForExternalHandle(trash: SceneObject): void {
    const scripts = trash.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as ScriptComponent & {
        targetingMode?: number;
        manipulateRootSceneObject?: SceneObject;
        enableInstantDrag?: boolean;
      };
      if (isNull(candidate)) {
        continue;
      }

      if (candidate.manipulateRootSceneObject !== undefined) {
        candidate.enabled = false;
        continue;
      }

      if (candidate.targetingMode !== undefined) {
        // Indirect-only hover on the bin body — direct pinch stays on stashed items.
        candidate.targetingMode = 2;
        if (candidate.enableInstantDrag !== undefined) {
          candidate.enableInstantDrag = false;
        }
        candidate.enabled = true;
      }
    }

    const triggerCollider = this.findTrashTriggerCollider(trash);
    const colliders = trash.getComponents('Component.ColliderComponent');
    for (let i = 0; i < colliders.length; i++) {
      const collider = colliders[i] as ColliderComponent & {
        forceCompound?: boolean;
        intangible?: boolean;
        enabled?: boolean;
        shape?: { radius?: number; FitVisual?: boolean };
      };
      if (isNull(collider)) {
        continue;
      }

      collider.forceCompound = false;

      const shapeRadius = collider.shape?.radius ?? 0;
      if (collider !== triggerCollider && shapeRadius >= 20) {
        // Large grab collider must stay off — it steals hover/grab from MoveHandle.
        collider.enabled = false;
        collider.intangible = true;
        continue;
      }

      if (collider === triggerCollider) {
        collider.enabled = true;
        collider.intangible = false;
        if (collider.shape) {
          collider.shape.FitVisual = true;
        }
      }
    }
  }

  private findTrashTriggerCollider(trash: SceneObject): ColliderComponent | null {
    const trashComponent = this.trashBin as TrashBin;
    if (!isNull(trashComponent) && !isNull(trashComponent.triggerCollider)) {
      return trashComponent.triggerCollider;
    }

    const colliders = trash.getComponents('Component.ColliderComponent');
    for (let i = 0; i < colliders.length; i++) {
      const collider = colliders[i] as ColliderComponent & { shape?: { radius?: number } };
      if (isNull(collider)) {
        continue;
      }

      const shapeRadius = collider.shape?.radius ?? 0;
      if (shapeRadius > 0 && shapeRadius < 20) {
        return collider;
      }
    }

    return colliders.length > 0 ? (colliders[0] as ColliderComponent) : null;
  }

  private getTrashMoveHandleScaleCompensation(trash: SceneObject): number {
    const referenceSource = this.findGardenSpawnSource(GARDEN_MOVE_HANDLE_REFERENCE_SOURCE);
    if (isNull(referenceSource) || isNull(trash)) {
      return 1;
    }

    const referenceScale = referenceSource.getTransform().getWorldScale();
    const trashScale = trash.getTransform().getWorldScale();
    const referenceAxis = Math.max(referenceScale.x, 0.001);
    const trashAxis = Math.max(trashScale.x, 0.001);
    return referenceAxis / trashAxis;
  }

  private setTrashRootMoveEnabled(enabled: boolean): void {
    const trash = this.getTrashSceneObject();
    if (isNull(trash)) {
      return;
    }

    const scripts = trash.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i] as ScriptComponent & {
        manipulateRootSceneObject?: SceneObject;
      };
      if (isNull(script) || script.manipulateRootSceneObject === undefined) {
        continue;
      }

      script.enabled = enabled;
    }
  }

  public persistGardenSourceTransform(sourceName: string): void {
    if (sourceName === TRASH_BIN_SOURCE_NAME) {
      this.trashPersistCooldown = 0;
      this.persistTrashTransform();
      return;
    }

    const source = this.findGardenSpawnSource(sourceName);
    if (isNull(source)) {
      return;
    }

    const transform = source.getTransform();
    const worldPos = transform.getWorldPosition();
    this.gardenSpawnSourceDefaults.set(sourceName, {
      pos: worldPos,
      rot: transform.getWorldRotation(),
      scale: transform.getWorldScale(),
    });
    this.gardenSourceFixedWorldPositions.set(sourceName, worldPos);
    this.gardenSourceLastPersistedWorld.set(sourceName, worldPos);

    const store = global.persistentStorageSystem.store;
    const slug = this.getGardenSourceStorageSlug(sourceName);
    store.putFloat(`${slug}_wx`, worldPos.x);
    store.putFloat(`${slug}_wy`, worldPos.y);
    store.putFloat(`${slug}_wz`, worldPos.z);
    store.putBool(`${slug}_has_data`, true);

    if (this.hasActiveAnchorTracking()) {
      const anchorLocal = this.worldToWidgetLocal(worldPos, quat.quatIdentity());
      store.putFloat(`${slug}_x`, anchorLocal.pos.x);
      store.putFloat(`${slug}_y`, anchorLocal.pos.y);
      store.putFloat(`${slug}_z`, anchorLocal.pos.z);
      store.putBool(`${slug}_uses_anchor_space`, true);
      print(
        `Saved ${sourceName} (anchor-local + world) at ${worldPos.toString()}`
      );
      return;
    }

    store.putBool(`${slug}_uses_anchor_space`, false);
    print(`Saved ${sourceName} (world) at ${worldPos.toString()}`);
  }

  private persistAllGardenSourceTransforms(): void {
    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      this.persistGardenSourceTransform(layoutNames[i]);
    }
  }

  private wireGardenSourceMoveHandles(): void {
    for (let i = 0; i < GARDEN_SPAWN_SOURCE_NAMES.length; i++) {
      const name = GARDEN_SPAWN_SOURCE_NAMES[i];
      const source = this.findGardenSpawnSource(name);
      if (isNull(source) || !source.enabled) {
        continue;
      }

      const handle = this.findNamedChild(source, GARDEN_SOURCE_MOVE_HANDLE_NAME);
      if (isNull(handle)) {
        continue;
      }

      handle.enabled = true;
      this.applyGardenSourceMoveHandleLayout(name, handle);
      this.applyGardenSourceMoveHandleVisual(handle);
      this.applyGardenSourceMoveHandleGlow(handle);
      this.ensureGardenSourceSpawnInteractable(source);
      const scripts = handle.getComponents('Component.ScriptComponent');
      for (let j = 0; j < scripts.length; j++) {
        const script = scripts[j] as GardenSourceMoveHandle;
        if (isNull(script) || typeof script.wireMoveInteraction !== 'function') {
          continue;
        }
        script.sourceRoot = source;
        script.sourceName = name;
        script.anchorController = this;
        if (!isNull(this.moveHandleMaterial)) {
          script.handleMaterial = this.moveHandleMaterial;
        }
        if (!isNull(this.moveHandleGlowMaterial)) {
          script.glowMaterial = this.moveHandleGlowMaterial;
        }
        script.wireMoveInteraction();
      }
    }
  }

  private ensureGardenSourceSpawnInteractable(source: SceneObject): void {
    const scripts = source.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as ScriptComponent & {
        targetingMode?: number;
        manipulateRootSceneObject?: SceneObject;
      };
      if (isNull(candidate) || candidate.targetingMode === undefined) {
        continue;
      }
      if (candidate.manipulateRootSceneObject !== undefined) {
        continue;
      }

      candidate.enabled = true;
      return;
    }
  }

  private applyGardenSourceMoveHandleLayout(sourceName: string, handle: SceneObject): void {
    const offset = GARDEN_SOURCE_MOVE_HANDLE_LOCAL_OFFSETS[sourceName];
    if (!offset) {
      return;
    }

    handle.getTransform().setLocalPosition(offset);
  }

  private applyGardenSourceMoveHandleVisual(handle: SceneObject): void {
    const glowReady = !isNull(this.moveHandleGlowMaterial) || !isNull(this.moveHandleMaterial);
    const visuals = handle.getComponents('Component.RenderMeshVisual');
    for (let i = 0; i < visuals.length; i++) {
      const visual = visuals[i] as RenderMeshVisual;
      if (isNull(visual)) {
        continue;
      }

      if (glowReady) {
        // Outer glow ring only — hide the solid inner disc mesh once glow is available.
        visual.enabled = false;
      } else if (!isNull(this.moveHandleMaterial)) {
        visual.enabled = true;
        visual.mainMaterial = this.moveHandleMaterial;
      }
    }
  }

  private applyGardenSourceMoveHandleGlow(handle: SceneObject): void {
    if (isNull(this.moveHandleGlowMaterial)) {
      return;
    }

    const visuals = handle.getComponents('Component.RenderMeshVisual');
    if (visuals.length === 0) {
      return;
    }

    const mesh = (visuals[0] as RenderMeshVisual).mesh;
    if (isNull(mesh)) {
      return;
    }

    const legacyCore = this.findNamedChild(handle, 'GlowCore');
    if (!isNull(legacyCore)) {
      legacyCore.enabled = false;
    }

    this.ensureMoveHandleGlowLayer(
      handle,
      mesh,
      'GlowHalo',
      1.55,
      8,
      new vec4(1, 0.86, 0.1, 0.36),
      new vec3(0.72, 0.58, 0.1)
    );
  }

  private ensureMoveHandleGlowLayer(
    handle: SceneObject,
    mesh: RenderMesh,
    layerName: string,
    scale: number,
    renderOrder: number,
    baseColor: vec4,
    emissive: vec3
  ): void {
    let layer = this.findNamedChild(handle, layerName);
    if (isNull(layer)) {
      layer = global.scene.createSceneObject(layerName);
      layer.setParent(handle);
      layer.getTransform().setLocalPosition(new vec3(0, 0, 0));
      const layerVisual = layer.createComponent('Component.RenderMeshVisual') as RenderMeshVisual;
      layerVisual.mesh = mesh;
    }

    layer.getTransform().setLocalScale(new vec3(scale, scale, scale));
    layer.enabled = false;

    const layerVisual = layer.getComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    if (isNull(layerVisual)) {
      return;
    }

    layerVisual.mesh = mesh;
    layerVisual.renderOrder = renderOrder;

    const layerMaterial = this.moveHandleGlowMaterial.clone();
    layerMaterial.mainPass.baseTex = this.moveHandleGlowMaterial.mainPass.baseTex;
    layerMaterial.mainPass.baseColor = baseColor;
    const passAny = layerMaterial.mainPass as { Port_Emissive_N006?: vec3 };
    if (passAny.Port_Emissive_N006 !== undefined) {
      passAny.Port_Emissive_N006 = emissive;
    }

    layerVisual.mainMaterial = layerMaterial;
    layerVisual.enabled = false;
  }

  private wireAIContainerMovement(): void {
    if (isNull(this.menuRoot)) {
      return;
    }

    const persist = (): void => {
      this.persistAIContainerTransform();
    };

    const scripts = this.menuRoot.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i] as ScriptComponent & {
        onDragEnd?: { add: (cb: () => void) => void };
        onTriggerEnd?: { add: (cb: () => void) => void };
        onTriggerEndOutside?: { add: (cb: () => void) => void };
        onInteractorTriggerEnd?: { add: (cb: () => void) => void };
        onInteractorTriggerEndOutside?: { add: (cb: () => void) => void };
        onTranslationEnd?: { add: (cb: () => void) => void };
        onMoveEnd?: { add: (cb: () => void) => void };
      };
      if (isNull(script)) {
        continue;
      }

      if (script.onTranslationEnd) {
        script.onTranslationEnd.add(persist);
      }
      if (script.onMoveEnd) {
        script.onMoveEnd.add(persist);
      }
      if (script.onDragEnd) {
        script.onDragEnd.add(persist);
      }
      if (script.onTriggerEnd) {
        script.onTriggerEnd.add(persist);
      }
      if (script.onTriggerEndOutside) {
        script.onTriggerEndOutside.add(persist);
      }
      if (script.onInteractorTriggerEnd) {
        script.onInteractorTriggerEnd.add(persist);
      }
      if (script.onInteractorTriggerEndOutside) {
        script.onInteractorTriggerEndOutside.add(persist);
      }
    }
  }

  public notifyTrashSpawnGrace(content: SceneObject, graceSeconds = 2): void {
    const trash = this.trashBin as {
      notifySpawned?: (root: SceneObject, graceSeconds?: number) => void;
      isInSpawnGrace?: (root: SceneObject) => boolean;
    };
    if (!isNull(trash) && typeof trash.notifySpawned === 'function') {
      trash.notifySpawned(content, graceSeconds);
    }
  }

  private isObjectInTrashSpawnGrace(root: SceneObject): boolean {
    const trash = this.trashBin as {
      isInSpawnGrace?: (root: SceneObject) => boolean;
    };
    if (!isNull(trash) && typeof trash.isInSpawnGrace === 'function') {
      return trash.isInSpawnGrace(root);
    }
    return false;
  }

  /** Always runs on pinch-up — not gated by saveObjectPosition cooldown. */
  public attemptTrashOnManipulatedRelease(): boolean {
    const releaseRoot = this.resolveReleasedTrackedRoot();
    this.activeManipulatedRoot = null;
    this.cancelPendingTrashReleaseRetry();
    const retryToken = this.trashReleaseRetryToken;

    let trashedOnRelease = this.tryTrashTrackedOnRelease(releaseRoot);
    if (!trashedOnRelease && !isNull(releaseRoot)) {
      const releaseRef = releaseRoot;
      this.scheduleDelayed(() => {
        if (retryToken !== this.trashReleaseRetryToken) {
          return;
        }
        if (isNull(releaseRef) || !releaseRef.enabled) {
          return;
        }
        if (this.isObjectInTrashSpawnGrace(releaseRef)) {
          return;
        }
        this.tryTrashTrackedOnRelease(releaseRef);
      }, 0.1);
    }

    return trashedOnRelease;
  }

  private tryTrashTrackedOnRelease(releasedRoot?: SceneObject | null): boolean {
    const trash = this.trashBin as {
      tryTrashReleasedObject?: (root?: SceneObject | null) => boolean;
      tryTrashTrackedOnRelease?: (root?: SceneObject | null) => boolean;
    };
    if (!isNull(trash) && typeof trash.tryTrashReleasedObject === 'function') {
      return trash.tryTrashReleasedObject(releasedRoot ?? null);
    }
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
          onTranslationEnd?: { add: (cb: () => void) => void };
          onMoveEnd?: { add: (cb: () => void) => void };
          onManipulationStart?: { add: (cb: () => void) => void };
          onManipulationEnd?: { add: (cb: () => void) => void };
        };
        if (isNull(script) || !this.isTrashTrackingInteractionScript(script)) {
          continue;
        }

        const markActive = (): void => {
          this.cancelPendingTrashReleaseRetry();
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
        if (script.onManipulationStart) {
          script.onManipulationStart.add(markActive);
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
        if (script.onTranslationEnd) {
          script.onTranslationEnd.add(onRelease);
        }
        if (script.onMoveEnd) {
          script.onMoveEnd.add(onRelease);
        }
        if (script.onManipulationEnd) {
          script.onManipulationEnd.add(onRelease);
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
      this.setStatusText('Spawn error');
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
    const spawnGraceSeconds = objectKind === OBJECT_KIND_POT ? 4 : 2;
    this.notifyTrashSpawnGrace(wrapper, spawnGraceSeconds);
    this.notifyTrashSpawnGrace(obj, spawnGraceSeconds);
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

    const trashedOnRelease = this.attemptTrashOnManipulatedRelease();

    const now = getTime();
    if (now - this.lastSaveObjectPositionAt < this.saveObjectPositionCooldownSec) {
      return;
    }
    this.lastSaveObjectPositionAt = now;

    print(
      `pinch up ${ANCHOR_CONTROLLER_VERSION} anchor=${!!this.currentAnchor} worldOnly=${this.usingWorldSpace} creating=${this.anchorCreationInProgress}`
    );

    if (!this.startupWorldOnlySession) {
      this.maintainTrashAnchorBinding();
      this.maintainAIContainerAnchorBinding();
      this.maintainGardenSourceAnchorBindings();
    }
    this.lockSpacePanelAtDesk();

    if (
      !this.startupWorldOnlySession &&
      !this.currentAnchor &&
      !this.anchorCreationInProgress &&
      this.objs.length > 0 &&
      !this.usingWorldSpace
    ) {
      this.startWorldAnchorCreation(this.getPlantAnchorWorldMatrix());
      return;
    }

    if (this.startupWorldOnlySession) {
      this.usingWorldSpace = true;
      this.restoredFromWorldFallback = true;
    } else {
      this.restoredFromWorldFallback = false;
    }
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
    const persistableIndices: number[] = [];
    for (let i = 0; i < this.objs.length; i++) {
      if (this.isPersistableTrackedObject(i)) {
        persistableIndices.push(i);
      }
    }

    const oldStoredCount = store.has('widget_count') ? store.getInt('widget_count') : 0;
    for (let slot = 0; slot < persistableIndices.length; slot++) {
      this.writeTrackedObjectToStorageSlot(
        store,
        persistableIndices[slot],
        slot,
        silent
      );
    }

    store.putInt('widget_count', persistableIndices.length);
    if (persistableIndices.length === 0) {
      store.remove('has_world_data');
      store.remove('uses_anchor_space');
    } else {
      store.putBool('has_world_data', true);
      if (this.hasActiveAnchorTracking()) {
        store.putBool('uses_anchor_space', true);
      }
    }

    const trimFrom = Math.max(oldStoredCount, this.objs.length);
    this.trimStoredObjectSlots(store, persistableIndices.length, trimFrom);

    if (!this.aiContainerPersistencePaused && !this.startupRebindInProgress) {
      this.persistAIContainerTransform();
    }
  }

  private writeTrackedObjectToStorageSlot(
    store: GeneralDataStore,
    memoryIndex: number,
    storageSlot: number,
    silent: boolean
  ): void {
    const obj = this.objs[memoryIndex];
    if (isNull(obj)) {
      return;
    }

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

    store.putFloat(`w${storageSlot}_x`, pos.x);
    store.putFloat(`w${storageSlot}_y`, pos.y);
    store.putFloat(`w${storageSlot}_z`, pos.z);
    store.putFloat(`w${storageSlot}_rx`, rot.x);
    store.putFloat(`w${storageSlot}_ry`, rot.y);
    store.putFloat(`w${storageSlot}_rz`, rot.z);
    store.putFloat(`w${storageSlot}_rw`, rot.w);
    store.putFloat(`w${storageSlot}_wx`, worldPos.x);
    store.putFloat(`w${storageSlot}_wy`, worldPos.y);
    store.putFloat(`w${storageSlot}_wz`, worldPos.z);
    store.putFloat(`w${storageSlot}_wrx`, worldRot.x);
    store.putFloat(`w${storageSlot}_wry`, worldRot.y);
    store.putFloat(`w${storageSlot}_wrz`, worldRot.z);
    store.putFloat(`w${storageSlot}_wrw`, worldRot.w);
    store.putString(
      `w${storageSlot}_object_kind`,
      this.objectKinds[memoryIndex] || OBJECT_KIND_PLANT
    );
    store.putInt(`w${storageSlot}_prefab`, this.objectPrefabIndices[memoryIndex]);
    this.persistPlantState(store, storageSlot, obj);

    if (!silent) {
      print(
        `Saved ${this.objectKinds[memoryIndex] || OBJECT_KIND_PLANT} ${memoryIndex} local: ${pos.toString()} world: ${worldPos.toString()}`
      );
      this.setStatusText('Saved garden layout');
    }
  }

  private isPersistableStoredObject(store: GeneralDataStore, index: number): boolean {
    const objectKind = store.has(`w${index}_object_kind`)
      ? store.getString(`w${index}_object_kind`)
      : OBJECT_KIND_PLANT;
    if (objectKind === OBJECT_KIND_POT) {
      return true;
    }

    return store.has(`w${index}_plant_planted`) && store.getBool(`w${index}_plant_planted`);
  }

  private isPersistableTrackedObject(index: number): boolean {
    if (index < 0 || index >= this.objs.length) {
      return false;
    }

    const objectKind = this.objectKinds[index] || OBJECT_KIND_PLANT;
    if (objectKind === OBJECT_KIND_POT) {
      return true;
    }

    const obj = this.objs[index];
    if (isNull(obj)) {
      return false;
    }

    const plant = this.findPlantLifecycle(obj);
    if (isNull(plant) || typeof plant.getIsPlanted !== 'function') {
      return false;
    }

    return plant.getIsPlanted();
  }

  private purgeLooseUnplantedFromStorage(store: GeneralDataStore): number {
    if (!store.has('widget_count')) {
      return 0;
    }

    const oldCount = store.getInt('widget_count');
    if (oldCount <= 0) {
      return 0;
    }

    let writeSlot = 0;
    let removed = 0;
    for (let readSlot = 0; readSlot < oldCount; readSlot++) {
      if (!this.isPersistableStoredObject(store, readSlot)) {
        removed++;
        continue;
      }

      if (writeSlot !== readSlot) {
        this.copyStoredObjectSlot(store, readSlot, writeSlot);
      }
      writeSlot++;
    }

    if (removed <= 0) {
      return 0;
    }

    for (let i = writeSlot; i < oldCount; i++) {
      this.clearStoredObjectSlot(store, i);
    }
    store.putInt('widget_count', writeSlot);
    if (writeSlot === 0) {
      store.remove('has_world_data');
      store.remove('uses_anchor_space');
    }

    print(`Purged ${removed} loose unplanted seed(s) from saved garden`);
    return removed;
  }

  private copyStoredObjectSlot(
    store: GeneralDataStore,
    fromIndex: number,
    toIndex: number
  ): void {
    if (fromIndex === toIndex) {
      return;
    }

    const transformKeys = [
      'x',
      'y',
      'z',
      'rx',
      'ry',
      'rz',
      'rw',
      'wx',
      'wy',
      'wz',
      'wrx',
      'wry',
      'wrz',
      'wrw',
    ];
    for (let i = 0; i < transformKeys.length; i++) {
      const key = transformKeys[i];
      const sourceKey = `w${fromIndex}_${key}`;
      const targetKey = `w${toIndex}_${key}`;
      if (store.has(sourceKey)) {
        store.putFloat(targetKey, store.getFloat(sourceKey));
      } else {
        store.remove(targetKey);
      }
    }

    if (store.has(`w${fromIndex}_object_kind`)) {
      store.putString(`w${toIndex}_object_kind`, store.getString(`w${fromIndex}_object_kind`));
    } else {
      store.remove(`w${toIndex}_object_kind`);
    }

    if (store.has(`w${fromIndex}_prefab`)) {
      store.putInt(`w${toIndex}_prefab`, store.getInt(`w${fromIndex}_prefab`));
    } else {
      store.remove(`w${toIndex}_prefab`);
    }

    this.copyStoredPlantState(store, fromIndex, toIndex);
  }

  private copyStoredPlantState(
    store: GeneralDataStore,
    fromIndex: number,
    toIndex: number
  ): void {
    const intKeys = ['plant_lifecycle_version', 'plant_stage'];
    for (let i = 0; i < intKeys.length; i++) {
      const key = intKeys[i];
      const sourceKey = `w${fromIndex}_${key}`;
      const targetKey = `w${toIndex}_${key}`;
      if (store.has(sourceKey)) {
        store.putInt(targetKey, store.getInt(sourceKey));
      } else {
        store.remove(targetKey);
      }
    }

    const floatKeys = [
      'plant_baby_remaining',
      'plant_growth_elapsed',
      'plant_base_y',
      'plant_align_cx',
      'plant_align_cz',
      'plant_align_y',
      'plant_growth_x',
      'plant_growth_y',
      'plant_growth_z',
      'plant_wrw',
      'plant_wrx',
      'plant_wry',
      'plant_wrz',
    ];
    for (let i = 0; i < floatKeys.length; i++) {
      const key = floatKeys[i];
      const sourceKey = `w${fromIndex}_${key}`;
      const targetKey = `w${toIndex}_${key}`;
      if (store.has(sourceKey)) {
        store.putFloat(targetKey, store.getFloat(sourceKey));
      } else {
        store.remove(targetKey);
      }
    }

    const boolKeys = ['plant_watered', 'plant_planted'];
    for (let i = 0; i < boolKeys.length; i++) {
      const key = boolKeys[i];
      const sourceKey = `w${fromIndex}_${key}`;
      const targetKey = `w${toIndex}_${key}`;
      if (store.has(sourceKey)) {
        store.putBool(targetKey, store.getBool(sourceKey));
      } else {
        store.remove(targetKey);
      }
    }

    const sourceTypeKey = `w${fromIndex}_plant_type`;
    const targetTypeKey = `w${toIndex}_plant_type`;
    if (store.has(sourceTypeKey)) {
      store.putString(targetTypeKey, store.getString(sourceTypeKey));
    } else {
      store.remove(targetTypeKey);
    }
  }

  private captureObjectSlotSnapshot(index: number): TrashObjectStoreSnapshot {
    const store = global.persistentStorageSystem.store;
    const snapshot: TrashObjectStoreSnapshot = {
      floats: {},
      ints: {},
      bools: {},
      strings: {},
    };

    const floatSuffixes = [
      'x',
      'y',
      'z',
      'rx',
      'ry',
      'rz',
      'rw',
      'wx',
      'wy',
      'wz',
      'wrx',
      'wry',
      'wrz',
      'wrw',
      'plant_baby_remaining',
      'plant_growth_elapsed',
      'plant_base_y',
      'plant_align_cx',
      'plant_align_cz',
      'plant_align_y',
      'plant_growth_x',
      'plant_growth_y',
      'plant_growth_z',
      'plant_wrw',
      'plant_wrx',
      'plant_wry',
      'plant_wrz',
    ];
    for (let i = 0; i < floatSuffixes.length; i++) {
      const suffix = floatSuffixes[i];
      const key = `w${index}_${suffix}`;
      if (store.has(key)) {
        snapshot.floats[suffix] = store.getFloat(key);
      }
    }

    const intSuffixes = ['prefab', 'plant_lifecycle_version', 'plant_stage'];
    for (let i = 0; i < intSuffixes.length; i++) {
      const suffix = intSuffixes[i];
      const key = `w${index}_${suffix}`;
      if (store.has(key)) {
        snapshot.ints[suffix] = store.getInt(key);
      }
    }

    const boolSuffixes = ['plant_watered', 'plant_planted'];
    for (let i = 0; i < boolSuffixes.length; i++) {
      const suffix = boolSuffixes[i];
      const key = `w${index}_${suffix}`;
      if (store.has(key)) {
        snapshot.bools[suffix] = store.getBool(key);
      }
    }

    if (store.has(`w${index}_object_kind`)) {
      snapshot.strings.object_kind = store.getString(`w${index}_object_kind`);
    }
    if (store.has(`w${index}_plant_type`)) {
      snapshot.strings.plant_type = store.getString(`w${index}_plant_type`);
    }

    return snapshot;
  }

  private writeObjectSlotSnapshot(
    index: number,
    snapshot: TrashObjectStoreSnapshot
  ): void {
    const store = global.persistentStorageSystem.store;
    const floatKeys = Object.keys(snapshot.floats);
    for (let i = 0; i < floatKeys.length; i++) {
      const suffix = floatKeys[i];
      store.putFloat(`w${index}_${suffix}`, snapshot.floats[suffix]);
    }

    const intKeys = Object.keys(snapshot.ints);
    for (let i = 0; i < intKeys.length; i++) {
      const suffix = intKeys[i];
      store.putInt(`w${index}_${suffix}`, snapshot.ints[suffix]);
    }

    const boolKeys = Object.keys(snapshot.bools);
    for (let i = 0; i < boolKeys.length; i++) {
      const suffix = boolKeys[i];
      store.putBool(`w${index}_${suffix}`, snapshot.bools[suffix]);
    }

    if (snapshot.strings.object_kind !== undefined) {
      store.putString(`w${index}_object_kind`, snapshot.strings.object_kind);
    }
    if (snapshot.strings.plant_type !== undefined) {
      store.putString(`w${index}_plant_type`, snapshot.strings.plant_type);
    }
  }

  private clearStoredObjectSlot(store: GeneralDataStore, index: number): void {
    ['x', 'y', 'z', 'rx', 'ry', 'rz', 'rw', 'wx', 'wy', 'wz', 'wrx', 'wry', 'wrz', 'wrw']
      .forEach((key) => store.remove(`w${index}_${key}`));
    store.remove(`w${index}_object_kind`);
    store.remove(`w${index}_prefab`);
    this.removePlantState(store, index);
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
      this.setStatusText('Place a plant again to enable restore');
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
      } else {
        this.reparentPlantsToAnchor();
      }
    } else {
      this.usingWorldSpace = true;
      this.restoredFromWorldFallback = true;
      this.anchorComponent.enabled = true;
      this.restoreAllObjects(true);
    }
  }

  private clearSpawnedObjects() {
    this.wrappers.forEach((wrapper) => wrapper.destroy());
    this.wrappers = [];
    this.objs = [];
    this.objectKinds = [];
    this.objectPrefabIndices = [];
  }

  private deferSceneObjectDestruction(objects: SceneObject[]) {
    objects.forEach((object) => {
      if (!isNull(object)) {
        object.enabled = false;
      }
    });

    const destroyEvent = this.createEvent('DelayedCallbackEvent');
    destroyEvent.bind(() => {
      objects.forEach((object) => {
        if (!isNull(object)) {
          object.destroy();
        }
      });
    });
    destroyEvent.reset(0.5);
  }

  private keepAIControlButtonsVisible() {
    if (isNull(this.menuRoot)) {
      return;
    }

    this.menuRoot.enabled = true;
    const stack: SceneObject[] = [this.menuRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const name = String(current.name || '');
      if (name === 'PlantBtns') {
        current.enabled = true;
      } else if (AI_DESK_CONTROL_BUTTON_NAMES.indexOf(name) >= 0) {
        current.enabled = true;
      } else if (AI_LEGACY_PLANT_BUTTON_NAMES.indexOf(name) >= 0) {
        current.enabled = false;
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
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

      if (!this.isPersistableStoredObject(store, i)) {
        print(`Skipping loose unplanted seed ${i}`);
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
    this.setStatusText(
      restoredCount > 0
        ? `Restored ${restoredCount} object(s)`
        : 'Could not restore saved objects'
    );
    return restoredCount;
  }

  undoLast() {
    if (this.objs.length === 0) {
      this.setStatusText('Nothing to undo');
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

    this.deferSceneObjectDestruction([this.wrappers[lastIndex]]);
    this.wrappers.pop();
    this.objs.pop();
    this.objectKinds.pop();
    this.objectPrefabIndices.pop();

    if (this.objs.length === 0) {
      store.remove('has_world_data');
      store.remove('uses_anchor_space');
    }

    this.setStatusText(`${this.objs.length} plant(s) remaining`);
    print(`Undo: removed plant ${lastIndex}`);
  }

  async resetAnchor() {
    print('Reset: deleting all anchors and clearing saved plants');
    this.keepAIControlButtonsVisible();
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

    const objectsToDestroy = this.wrappers.slice();
    this.wrappers = [];
    this.objs = [];
    this.objectKinds = [];
    this.objectPrefabIndices = [];
    if (this.floatingRoot) {
      objectsToDestroy.push(this.floatingRoot);
      this.floatingRoot = undefined;
    }
    this.deferSceneObjectDestruction(objectsToDestroy);

    if (this.anchorSession) {
      const worldAnchor = anchorToDelete as WorldAnchor | undefined;
      if (worldAnchor?._sceneObject) {
        try {
          await this.anchorSession.deleteAnchor(worldAnchor);
          print('Deleted active session anchor');
        } catch (e) {
          print('Could not delete active anchor: ' + e);
        }
        const anchorObject = worldAnchor._sceneObject;
        if (
          !isNull(anchorObject) &&
          anchorObject !== this.widgetParent &&
          !this.isGardenSpawnSourceObject(anchorObject)
        ) {
          anchorObject.destroy();
        }
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
    this.restoreGardenSpawnSourcesAfterReset();
    this.wireTrashBinMovement();
    this.scheduleGardenAndTrashHandleWiring();
    this.setStatusText('Desk reset');
    this.keepAIControlButtonsVisible();
    const restoreControlsEvent = this.createEvent('DelayedCallbackEvent');
    restoreControlsEvent.bind(() => this.keepAIControlButtonsVisible());
    restoreControlsEvent.reset(0.2);
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
    this.setStatusText(`Placed ${resolvedConfig.plantTypeId}`);
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

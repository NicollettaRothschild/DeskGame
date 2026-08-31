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
import { shouldRunFriendOnboardingTour } from './FriendOnboardingStorage';

const ANCHOR_CONTROLLER_VERSION = 'v44-global-object-scale';
const GLOBAL_OBJECT_SCALE_MULTIPLIER = 1.5;
const PALETTE_EXTRA_SCALE_MULTIPLIER = 1.5;
const TRASH_BIN_SCALE_MULTIPLIER = 0.55;
const GARDEN_SPAWN_SOURCE_NAMES = ['Planter', 'PostItNotes'];
const GARDEN_SOURCE_MOVE_HANDLE_NAMES = GARDEN_SPAWN_SOURCE_NAMES;
/** Desk props that already have grab scripts — persist/reparent like garden sources. */
const DESK_PROP_NAMES = ['Clock'];
const GARDEN_SOURCE_MOVE_HANDLE_NAME = 'MoveHandle';
const TRASH_BIN_SOURCE_NAME = 'TrashBin';
const GARDEN_MOVE_HANDLE_REFERENCE_SOURCE = 'Planter';
const TRASH_MOVE_HANDLE_REFERENCE_SOURCE = 'Planter';
// Larger meshes overlap the default corner handle — push handles further out.
const GARDEN_SOURCE_MOVE_HANDLE_LOCAL_OFFSETS: { [sourceName: string]: vec3 } = {
  // Keep the fallback pose near the stack edge rather than far into the room.
  PostItNotes: new vec3(2, 0.8, 2),
};
const GARDEN_SOURCE_MOVE_HANDLE_LOCAL_SCALES: { [sourceName: string]: vec3 } = {
  // Post-it pad is smaller than other sources; use a bigger handle for parity.
  PostItNotes: new vec3(0.52, 0.52, 0.52),
};
const AI_DESK_CONTROL_BUTTON_NAMES = ['Btn Undo', 'Btn Reset'];
const AI_LEGACY_PLANT_BUTTON_NAMES = [
  'Btn Place Plant',
  'Btn Tulip',
  'Btn Narcissus',
  'Btn Ranunculus',
];
const STARTUP_REBIND_DELAY_SEC = 0.35;
const STARTUP_PERSIST_DELAY_SEC = 0.5;
const ANCHOR_SESSION_BOOT_DELAY_SEC = 0.75;
const ANCHOR_CREATE_GRACE_SEC = 4;
const ANCHOR_BIND_TIMEOUT_SEC = 12;
const PLANT_LIFECYCLE_SAVE_VERSION = 4;
const OBJECT_KIND_PLANT = 'plant';
const OBJECT_KIND_POT = 'pot';
const OBJECT_KIND_STICKY_NOTE = 'sticky_note';
const TIMED_ANCHOR_REBIND_DELAY_SEC = 1;
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
  planterRoot!: SceneObject;

  @input
  @allowUndefined
  postItNotesRoot!: SceneObject;

  @input
  @allowUndefined
  paletteRoot!: SceneObject;

  @input
  @allowUndefined
  clockRoot!: SceneObject;

  @input
  @allowUndefined
  leaderboardRoot!: SceneObject;

  @input
  @allowUndefined
  spacePanel!: ScriptComponent;

  @input
  @allowUndefined
  specsApi!: SpecsApiClient;

  @input
  @allowUndefined
  moveHandleMaterial!: Material;

  @input
  @allowUndefined
  moveHandleGlowMaterial!: Material;

  /** Hide desk/garden objects when the camera is farther than this (meters). */
  @input
  enableDistanceCull: boolean = true;

  @input('float')
  @hint('Hide objects when farther than this many meters from the camera')
  distanceCullHideMeters: number = 20;

  @input('float')
  @hint('Show objects again when closer than this (keep below hide distance to avoid flicker)')
  distanceCullShowMeters: number = 18;

  @input('float')
  distanceCullCheckIntervalSec: number = 0.35;

  @input('float')
  @label('Spawn Minimum Separation (cm)')
  @hint('Minimum horizontal spacing between newly spawned desk objects.')
  spawnMinSeparationCm: number = 18;

  @input
  @hint('Also hide Friend when far away')
  distanceCullIncludeFriend: boolean = false;

  private anchorSession?: AnchorSession;
  private wrappers: SceneObject[] = [];
  private objs: SceneObject[] = [];
  private objectKinds: string[] = [];
  private objectPrefabIndices: number[] = [];
  private stickyNotePrefab: ObjectPrefab | null = null;
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
  private pendingCreatedAnchorId?: string;
  private lockedAnchorId: string | null = null;
  private anchorBindingComplete = false;
  private startupRebindInProgress = false;
  private aiContainerPersistencePaused = false;
  private isResetting = false;
  /** When FriendGrab onboarding is on, wipe prior session plants/layout once. */
  private onboardingCleanSessionApplied = false;
  private trashSceneDefault: { pos: vec3; rot: quat; scale: vec3 } | null = null;
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
  private distanceCullEvent: UpdateEvent | null = null;
  private distanceCullCooldown = 0;
  /** Objects currently hidden by distance cull → enabled state to restore when near again. */
  private distanceCullHidden = new Map<SceneObject, boolean>();
  private distanceCullLogTimer = 0;

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
    armGardenSourceStartupSpawnBlock(3);
    print(`AnchorController ${ANCHOR_CONTROLLER_VERSION} starting`);
    this.hideRetiredDeskProps();
    this.enforceNoLooseSeedTemplatesVisible('startup');
    this.scheduleDelayed(() => {
      this.enforceNoLooseSeedTemplatesVisible('post-load');
    }, 0.5);
    this.scheduleDelayed(() => {
      this.enforceNoLooseSeedTemplatesVisible('post-restore');
    }, 2.0);
    this.captureGardenSpawnSourceDefaults();
    this.captureTrashSceneDefault();
    this.applyTrashScaledWorldSize();

    // Onboarding must start from a clean desk — wipe last session before restore.
    if (this.isFriendOnboardingEnabled()) {
      this.setAIContainerBoardVisible(false);
      this.clearPreviousSessionForOnboarding();
    }

    this.captureGardenSourcesInitialTransforms();
    if (!this.onboardingCleanSessionApplied) {
      this.restoreGardenSpawnSourcesLayout('startup');
    }
    this.prepareLayoutObjectsForCameraFallback();

    const store = global.persistentStorageSystem.store;
    this.purgeLooseUnplantedFromStorage(store);
    const hasSavedPlants =
      !this.onboardingCleanSessionApplied &&
      store.has('widget_count') &&
      store.getInt('widget_count') > 0;

    if (hasSavedPlants) {
      // Keep the old saved objects untouched until a stable desk anchor is
      // available. If no anchor appears, the bind timeout creates a bounded
      // camera-relative fallback instead of replaying stale world coordinates.
      print('Saved plants found: waiting for desk anchor before restore');
      this.usingWorldSpace = false;
      this.restoredFromWorldFallback = false;
      this.anchorBindingComplete = false;
      this.aiContainerPersistencePaused = true;
      this.setStatusText('Scanning for desk anchor...');
    }

    this.startAnchorSaveLoop();
    this.wireTrashBinMovement();
    this.scheduleGardenAndTrashHandleWiring();
    this.wireAIContainerMovement();
    this.startAIContainerPersistenceLoop();
    this.startDistanceCullLoop();

    this.scheduleDelayed(() => this.pullLiveDeskPropsNearCamera(), 0.4);
    this.scheduleDelayed(() => this.pullLiveDeskPropsNearCamera(), 1.2);
    this.scheduleDelayed(() => this.pullLiveDeskPropsNearCamera(), 2.4);

    this.scheduleDelayed(() => {
      void this.bootAnchorSession(hasSavedPlants);
    }, ANCHOR_SESSION_BOOT_DELAY_SEC);
    print(
      `AnchorController startup complete (anchor session in ${ANCHOR_SESSION_BOOT_DELAY_SEC.toFixed(1)}s)`
    );
  }

  private pullLiveDeskPropsNearCamera(): void {
    // FriendGrab places Planter / PostItNotes / Clock / TrashBin in a
    // tight row around Buddy. Camera-relative pulls here used ±27 cm
    // sides and left only the trash can in view.
  }

  private initLayoutObjectsFromStorage(): void {
    if (!this.hasActiveAnchorTracking()) {
      return;
    }

    if (!this.trashRestoreApplied) {
      this.restoreTrashFromStorage();
    }
    this.captureAIContainerSceneDefaults();
    if (!this.aiContainerRestoreApplied) {
      this.restoreAIContainerFromStorage();
    }
    this.captureGardenSourcesInitialTransforms();
    if (!this.allGardenSourcesRestoreApplied()) {
      this.restoreGardenSourcesFromStorage();
    }
    this.maintainTrashAnchorBinding();
    this.maintainAIContainerAnchorBinding();
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
      if (hasSavedPlants) {
        this.scheduleAnchorBindTimeout();
      }
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
      if (hasSavedPlants) {
        this.scheduleAnchorBindTimeout();
      }
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
      this.scheduleAnchorBindTimeout();
    }
  }

  private scheduleAnchorBindTimeout(): void {
    this.scheduleDelayed(() => {
      if (this.isResetting || this.anchorBindingComplete) {
        return;
      }
      const store = global.persistentStorageSystem.store;
      if (
        !this.hasRestored &&
        store.has('widget_count') &&
        store.getInt('widget_count') > 0
      ) {
        // No stable anchor arrived in time. Restore only into a temporary,
        // camera-relative floating root; the next valid anchor will rebase it.
        this.usingWorldSpace = true;
        this.restoredFromWorldFallback = true;
        this.restoreSavedObjects(false);
      }
      this.aiContainerPersistencePaused = false;
      this.startupRebindInProgress = false;
      this.anchorRestorePending = false;
      print('Anchor bind timeout; continuing with camera-relative fallback');
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
    if (this.isResetting) {
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
      this.initLayoutObjectsFromStorage();

      if (hadWorldFallback) {
        print('Rebasing camera-relative fallback to anchor space');
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
        this.setStatusText(`Restored ${this.objs.length} plant(s)`);
        return;
      }

      if (!this.hasRestored) {
        this.restoreSavedObjects(true);
        this.hasRestored = true;
        this.anchorBindingComplete = true;
        this.aiContainerPersistencePaused = false;
        this.maintainTrashAnchorBinding();
        this.maintainAIContainerAnchorBinding();
        this.maintainGardenSourceAnchorBindings();
        this.persistAllGardenSourceTransforms();
        this.persistTrashTransform();
        this.persistAIContainerTransform();
        this.persistPlantTransforms();
        this.setStatusText(
          this.objs.length > 0
            ? `Restored ${this.objs.length} object(s)`
            : 'Desk anchor ready'
        );
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
    return this.getCameraRelativeSpawnPosition(this.wrappers.length);
  }

  /**
   * Resolve every new world-space spawn against the current camera/desk
   * coordinate space. A caller-provided hand position is accepted only while
   * it remains close to the tracked camera; stale source or legacy-root
   * coordinates fall back to a bounded camera-relative slot.
   */
  public getValidatedSpawnWorldPosition(
    preferredWorldPos?: vec3 | null,
    index: number = this.wrappers.length
  ): vec3 {
    const fallback = this.getCameraRelativeSpawnPosition(index);
    if (isNull(preferredWorldPos)) {
      return fallback;
    }

    const preferred = preferredWorldPos as vec3;
    if (
      !Number.isFinite(preferred.x) ||
      !Number.isFinite(preferred.y) ||
      !Number.isFinite(preferred.z)
    ) {
      return fallback;
    }

    const camera = this.resolvePlacementCamera();
    if (isNull(camera)) {
      return fallback;
    }

    try {
      const cameraPos = camera.getTransform().getWorldPosition();
      const dx = preferred.x - cameraPos.x;
      const dy = preferred.y - cameraPos.y;
      const dz = preferred.z - cameraPos.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > 180) {
        return fallback;
      }
      return this.findOpenTrackedSpawnPosition(preferred);
    } catch (_e) {
      return fallback;
    }
  }

  private getCameraRelativeSpawnPosition(index: number): vec3 {
    const slot = ((Math.max(0, index) % 3) - 1) * 16;
    const cameraPosition = this.getCameraRelativePosition(48, slot, -24);
    if (!isNull(cameraPosition)) {
      return this.findOpenTrackedSpawnPosition(cameraPosition);
    }

    // Camera poses can be unavailable for a short startup window. Keep this
    // deterministic fallback bounded and non-persisted until an anchor exists.
    return this.findOpenTrackedSpawnPosition(
      new vec3(slot, -24, -48)
    );
  }

  private findOpenTrackedSpawnPosition(requested: vec3): vec3 {
    const minimumSeparation = Math.max(6, this.spawnMinSeparationCm);
    const occupied: vec3[] = [];

    for (let i = 0; i < this.objs.length; i++) {
      const obj = this.objs[i];
      if (!isNull(obj)) {
        occupied.push(obj.getTransform().getWorldPosition());
      }
    }

    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      const source = this.findGardenSpawnSource(layoutNames[i]);
      if (!isNull(source)) {
        occupied.push(source.getTransform().getWorldPosition());
      }
    }
    const trash = this.getTrashSceneObject();
    if (!isNull(trash)) {
      occupied.push(trash.getTransform().getWorldPosition());
    }

    const isOpen = (candidate: vec3): boolean => {
      for (let i = 0; i < occupied.length; i++) {
        const other = occupied[i];
        if (Math.abs(candidate.y - other.y) > minimumSeparation * 1.25) {
          continue;
        }
        const dx = candidate.x - other.x;
        const dz = candidate.z - other.z;
        if (Math.sqrt(dx * dx + dz * dz) < minimumSeparation) {
          return false;
        }
      }
      return true;
    };

    if (isOpen(requested)) {
      return requested;
    }

    // Search concentric rings, nearest slots first. Eight directions per ring
    // prevent the old three-position stagger from wrapping onto occupied spots.
    const slotsPerRing = 8;
    for (let ring = 1; ring <= 6; ring++) {
      const radius = minimumSeparation * ring;
      for (let slot = 0; slot < slotsPerRing; slot++) {
        const angle = (Math.PI * 2 * slot) / slotsPerRing + (ring % 2) * (Math.PI / 8);
        const candidate = new vec3(
          requested.x + Math.cos(angle) * radius,
          requested.y,
          requested.z + Math.sin(angle) * radius
        );
        if (isOpen(candidate)) {
          print(
            `[AnchorController] shifted overlapping spawn ${requested.toString()} -> ${candidate.toString()}`
          );
          return candidate;
        }
      }
    }

    // Extremely crowded fallback: deterministic outer slot rather than overlap.
    const fallback = new vec3(
      requested.x + minimumSeparation * 7,
      requested.y,
      requested.z
    );
    print(
      `[AnchorController] crowded spawn fallback ${requested.toString()} -> ${fallback.toString()}`
    );
    return fallback;
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
      this.scheduleDelayed(callback, TIMED_ANCHOR_REBIND_DELAY_SEC);
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

  private startWorldAnchorCreation(spawnWorldMat: mat4) {
    if (
      !this.anchorSession ||
      this.anchorCreationInProgress ||
      this.currentAnchor
    ) {
      return;
    }
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
    worldPos: vec3,
    avoidOverlap: boolean = true
  ): SceneObject | null {
    // Even internal callers must pass through the camera/anchor boundary.
    // `avoidOverlap` only controls the legacy caller contract; the resolver
    // itself already returns an open position.
    void avoidOverlap;
    const resolvedWorldPos = this.getValidatedSpawnWorldPosition(worldPos);
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

    this.placeTrackedContentAtWorld(obj, resolvedWorldPos);
    this.wirePotPersistence(obj);
    if (isNull(this.ensureSeedAttachedToPot(obj, resolvedWorldPos))) {
      print(`createPotAtWorldPosition: could not attach a seed to ${obj.name}`);
    }
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

  public createSeedAtWorldPosition(
    worldPos: vec3,
    avoidOverlap: boolean = true
  ): SceneObject | null {
    const resolvedWorldPos = avoidOverlap
      ? this.findOpenTrackedSpawnPosition(worldPos)
      : worldPos;
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

    this.placeTrackedContentAtWorld(obj, resolvedWorldPos);
    this.applyPlantConfig(obj, config);
    this.persistPlantTransforms();
    return obj;
  }

  public setStickyNotePrefab(prefab: ObjectPrefab): void {
    if (!isNull(prefab)) {
      this.stickyNotePrefab = prefab;
    }
  }

  public registerStickyNoteObject(noteRoot: SceneObject, prefab: ObjectPrefab): boolean {
    if (isNull(noteRoot) || isNull(prefab)) {
      return false;
    }

    this.stickyNotePrefab = prefab;
    if (this.findTrackedObjectIndex(noteRoot) >= 0) {
      return true;
    }

    const index = this.wrappers.length;
    const transform = noteRoot.getTransform();
    const worldPos = transform.getWorldPosition();
    const worldRot = transform.getWorldRotation();
    const worldScale = transform.getWorldScale();
    const wrapper = global.scene.createSceneObject(`StickyNote_${index}`);
    wrapper.setParent(this.getSpawnParent());
    wrapper.getTransform().setWorldPosition(worldPos);
    wrapper.getTransform().setWorldRotation(worldRot);
    wrapper.getTransform().setWorldScale(vec3.one());

    noteRoot.setParent(wrapper);
    transform.setWorldPosition(worldPos);
    transform.setWorldRotation(worldRot);
    transform.setWorldScale(worldScale);

    this.wrappers.push(wrapper);
    this.objs.push(noteRoot);
    this.objectKinds.push(OBJECT_KIND_STICKY_NOTE);
    this.objectPrefabIndices.push(-1);
    this.enforceTrackedObjectManipulationSettings(noteRoot, wrapper);
    this.wireTrashReleaseTracking(noteRoot, wrapper);

    const store = global.persistentStorageSystem.store;
    store.putInt('widget_count', this.wrappers.length);
    this.persistPlantTransforms();
    return true;
  }

  /**
   * Spawn a pot with a goal seed already planted — used by Friend onboarding.
   * Returns the pot root (grab/place this), or null on failure.
   */
  public createGoalPlantedPotAtWorldPosition(
    goalText: string,
    worldPos: vec3
  ): SceneObject | null {
    if (isNull(this.plantPrefab) || this.potPrefabs.length === 0) {
      print('createGoalPlantedPotAtWorldPosition: missing plantPrefab or potPrefabs');
      return null;
    }

    let potPrefab: ObjectPrefab | null = null;
    let potPrefabIndex = 0;
    for (let i = 0; i < this.potPrefabs.length; i++) {
      if (!isNull(this.potPrefabs[i])) {
        potPrefab = this.potPrefabs[i];
        potPrefabIndex = i;
        break;
      }
    }
    if (potPrefab === null) {
      print('createGoalPlantedPotAtWorldPosition: no valid pot prefab');
      return null;
    }

    const goalWorldPos = this.getValidatedSpawnWorldPosition(worldPos);
    const pot = this.createPotAtWorldPosition(
      potPrefab,
      potPrefabIndex,
      goalWorldPos,
      false
    );
    if (pot === null) {
      return null;
    }

    const potScript = this.findPotScript(pot);
    let plant: PlantLifecycle | null = null;
    if (
      !isNull(potScript) &&
      typeof potScript.getPlantedLifecycle === 'function'
    ) {
      plant = potScript.getPlantedLifecycle();
    }
    if (plant === null) {
      plant = this.ensureSeedAttachedToPot(pot, goalWorldPos);
    }
    if (plant === null) {
      print('createGoalPlantedPotAtWorldPosition: could not attach seed into pot');
      return pot;
    }

    if (typeof plant.bindGoal === 'function') {
      plant.bindGoal(String(goalText || '').trim());
    }
    this.wirePotPersistence(pot);
    this.persistPlantTransforms();
    print(
      `Created goal planted pot at ${goalWorldPos.toString()} goal="${String(goalText || '').trim()}"`
    );
    return pot;
  }

  /**
   * Pots are goal containers, so every newly-created pot starts with exactly
   * one seed already inside it. The seed is tracked briefly while it is being
   * instantiated, then PlantPot removes that temporary tracked entry when it
   * claims the seed. If any part of the handoff fails, discard the tracked
   * seed instead of leaving a loose seed in the scene.
   */
  private ensureSeedAttachedToPot(
    pot: SceneObject,
    worldPos: vec3
  ): PlantLifecycle | null {
    const potScript = this.findPotScript(pot);
    if (
      potScript === null ||
      typeof potScript.tryAttachSeed !== 'function'
    ) {
      return null;
    }

    if (typeof potScript.getPlantedLifecycle === 'function') {
      const existing = potScript.getPlantedLifecycle();
      if (!isNull(existing)) {
        return existing as PlantLifecycle;
      }
    }

    if (isNull(this.plantPrefab)) {
      print('ensureSeedAttachedToPot: plantPrefab is missing');
      return null;
    }

    const seed = this.createSeedAtWorldPosition(worldPos, false);
    if (seed === null) {
      return null;
    }

    const plant = this.findPlantLifecycle(seed);
    if (
      plant === null ||
      typeof plant.getIsPlanted !== 'function' ||
      !potScript.tryAttachSeed(plant)
    ) {
      this.destroyTrackedObject(seed);
      return null;
    }

    if (!plant.getIsPlanted()) {
      // A defensive check for a custom PlantPot implementation that reports
      // success without actually claiming the seed.
      this.destroyTrackedObject(seed);
      return null;
    }

    return plant;
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
    entry.wrapper
      .getTransform()
      .setLocalScale(
        new vec3(
          GLOBAL_OBJECT_SCALE_MULTIPLIER,
          GLOBAL_OBJECT_SCALE_MULTIPLIER,
          GLOBAL_OBJECT_SCALE_MULTIPLIER
        )
      );
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
    return (
      !this.hasActiveAnchorTracking() ||
      this.usingWorldSpace ||
      this.restoredFromWorldFallback
    );
  }

  private shouldKeepTrashInWorldRoot(): boolean {
    return (
      !this.hasActiveAnchorTracking() ||
      this.usingWorldSpace ||
      this.restoredFromWorldFallback
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

  private restoreAIContainerFromStorage(): void {
    this.restoreAIContainerTransform(this.hasActiveAnchorTracking());
    this.aiContainerRestoreApplied = true;
  }

  private applyAIContainerSavedPose(): void {
    if (
      isNull(this.menuRoot) ||
      isNull(this.aiContainerFixedWorldPosition) ||
      !this.hasActiveAnchorTracking()
    ) {
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

  private startDistanceCullLoop(): void {
    if (!isNull(this.distanceCullEvent)) {
      return;
    }
    this.distanceCullEvent = this.createEvent('UpdateEvent');
    this.distanceCullEvent.bind(() => this.updateDistanceCull());
    print(
      `[AnchorController] distance cull armed hide>${this.distanceCullHideMeters}m show<=${this.distanceCullShowMeters}m`
    );
  }

  private updateDistanceCull(): void {
    if (!this.enableDistanceCull) {
      this.restoreAllDistanceCulledObjects();
      return;
    }

    this.distanceCullCooldown -= getDeltaTime();
    if (this.distanceCullCooldown > 0) {
      return;
    }
    this.distanceCullCooldown = Math.max(0.1, this.distanceCullCheckIntervalSec);

    const camera = this.resolveCullCamera();
    if (isNull(camera)) {
      return;
    }

    const camPos = camera.getTransform().getWorldPosition();
    const hideCm = Math.max(1, this.distanceCullHideMeters) * 100;
    const showCm = Math.max(0.5, Math.min(this.distanceCullShowMeters, this.distanceCullHideMeters)) * 100;

    const targets = this.collectDistanceCullTargets();
    let hiddenCount = 0;
    let shownCount = 0;
    const onboardingOwnsLayout = this.isOnboardingLayoutOwned();

    for (let i = 0; i < targets.length; i++) {
      const obj = targets[i];
      if (isNull(obj)) {
        continue;
      }
      if (onboardingOwnsLayout && this.isOnboardingLayoutTarget(obj)) {
        continue;
      }

      const distCm = this.horizontalDistanceCm(camPos, obj.getTransform().getWorldPosition());
      const isCulled = this.distanceCullHidden.has(obj);

      if (!isCulled && distCm > hideCm) {
        this.distanceCullHidden.set(obj, obj.enabled);
        if (obj.enabled) {
          obj.enabled = false;
          hiddenCount += 1;
        }
      } else if (isCulled && distCm <= showCm) {
        const restoreEnabled = this.distanceCullHidden.get(obj);
        this.distanceCullHidden.delete(obj);
        if (restoreEnabled === true && !obj.enabled) {
          obj.enabled = true;
          shownCount += 1;
        } else if (restoreEnabled === false) {
          obj.enabled = false;
        }
      }
    }

    // Drop entries for destroyed objects.
    this.pruneDistanceCullMap(targets);

    this.distanceCullLogTimer += Math.max(0.1, this.distanceCullCheckIntervalSec);
    if (this.distanceCullLogTimer >= 5) {
      this.distanceCullLogTimer = 0;
      if (this.distanceCullHidden.size > 0 || hiddenCount > 0 || shownCount > 0) {
        print(
          `[AnchorController] distance cull active=${this.distanceCullHidden.size} hid=${hiddenCount} shown=${shownCount}`
        );
      }
    }
  }

  private isOnboardingLayoutOwned(): boolean {
    return this.onboardingCleanSessionApplied && this.isFriendOnboardingEnabled();
  }

  private isOnboardingLayoutTarget(target: SceneObject): boolean {
    const roots: SceneObject[] = [];
    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      const source = this.findGardenSpawnSource(layoutNames[i]);
      if (!isNull(source)) {
        roots.push(source);
      }
    }
    const trash = this.getTrashSceneObject();
    if (!isNull(trash)) {
      roots.push(trash);
    }

    for (let i = 0; i < roots.length; i++) {
      if (target === roots[i] || this.isDescendantOf(target, roots[i])) {
        return true;
      }
    }
    return false;
  }

  private restoreAllDistanceCulledObjects(): void {
    if (this.distanceCullHidden.size === 0) {
      return;
    }
    const keys: SceneObject[] = [];
    this.distanceCullHidden.forEach((_enabled, obj) => {
      keys.push(obj);
    });
    for (let i = 0; i < keys.length; i++) {
      const obj = keys[i];
      if (isNull(obj)) {
        continue;
      }
      const restoreEnabled = this.distanceCullHidden.get(obj);
      if (restoreEnabled === true) {
        obj.enabled = true;
      }
    }
    this.distanceCullHidden.clear();
  }

  private pruneDistanceCullMap(liveTargets: SceneObject[]): void {
    if (this.distanceCullHidden.size === 0) {
      return;
    }
    const live = new Set<SceneObject>();
    for (let i = 0; i < liveTargets.length; i++) {
      if (!isNull(liveTargets[i])) {
        live.add(liveTargets[i]);
      }
    }
    const stale: SceneObject[] = [];
    this.distanceCullHidden.forEach((_v, obj) => {
      if (isNull(obj) || !live.has(obj)) {
        stale.push(obj);
      }
    });
    for (let i = 0; i < stale.length; i++) {
      this.distanceCullHidden.delete(stale[i]);
    }
  }

  private collectDistanceCullTargets(): SceneObject[] {
    const targets: SceneObject[] = [];
    const seen = new Set<SceneObject>();

    const add = (obj: SceneObject | null): void => {
      if (isNull(obj) || seen.has(obj)) {
        return;
      }
      seen.add(obj);
      targets.push(obj);
    };

    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      add(this.findGardenSpawnSource(layoutNames[i]));
    }
    add(this.getTrashSceneObject());
    if (!isNull(this.menuRoot)) {
      add(this.menuRoot);
    }

    for (let i = 0; i < this.wrappers.length; i++) {
      add(this.wrappers[i]);
    }
    for (let i = 0; i < this.objs.length; i++) {
      // Prefer wrappers; still include content if orphaned.
      if (isNull(this.wrappers[i])) {
        add(this.objs[i]);
      }
    }

    if (this.distanceCullIncludeFriend) {
      add(this.findNamedSceneObject('friend'));
    }

    return targets;
  }

  private resolveCullCamera(): SceneObject | null {
    if (!isNull(this.camera)) {
      return this.camera;
    }
    return this.findNamedSceneObject('Camera Object') || this.findNamedSceneObject('Camera');
  }

  private findNamedSceneObject(name: string): SceneObject | null {
    const searchRoots = this.getSceneSearchRoots();
    for (let i = 0; i < searchRoots.length; i++) {
      const found = this.findSceneObjectByName(searchRoots[i], name);
      if (!isNull(found)) {
        return found;
      }
    }
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      const found = this.findSceneObjectByName(global.scene.getRootObject(i), name);
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private horizontalDistanceCm(a: vec3, b: vec3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
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
    if (!this.hasActiveAnchorTracking()) {
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
    void useWorldSpace;
    if (isNull(this.menuRoot)) {
      return;
    }

    // AIContainer is a legacy UI root and is authored disabled in the scene.
    // Never revive or target its old far-world pose during startup.
    if (!this.menuRoot.enabled) {
      this.aiContainerFixedWorldPosition = null;
      this.lastPersistedAIContainerWorld = null;
      return;
    }

    const store = global.persistentStorageSystem.store;
    const hasAnchorLocalData =
      this.hasActiveAnchorTracking() &&
      store.has('ai_container_uses_anchor_space') &&
      store.getBool('ai_container_uses_anchor_space') &&
      store.has('ai_container_x') &&
      store.has('ai_container_y') &&
      store.has('ai_container_z');

    if (hasAnchorLocalData) {
      const localPos = new vec3(
        store.getFloat('ai_container_x'),
        store.getFloat('ai_container_y'),
        store.getFloat('ai_container_z')
      );
      this.menuRoot.setParent(this.widgetParent);
      this.menuRoot.getTransform().setLocalPosition(localPos);
      this.applyAIContainerSceneRotation();
    } else {
      this.rebaseLayoutObjectNearCamera(this.menuRoot, 58, 0, -24);
      if (this.hasActiveAnchorTracking()) {
        const worldPos = this.menuRoot.getTransform().getWorldPosition();
        this.menuRoot.setParent(this.widgetParent);
        this.menuRoot.getTransform().setWorldPosition(worldPos);
        this.applyAIContainerSceneRotation();
      }
    }

    const worldPos = this.menuRoot.getTransform().getWorldPosition();
    this.aiContainerFixedWorldPosition = worldPos;
    this.lastPersistedAIContainerWorld = worldPos;
    print(
      `AIContainer kept near user (${hasAnchorLocalData ? 'anchor-local' : 'camera fallback'}) at ${worldPos.toString()}`
    );
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
      this.planterRoot,
      this.postItNotesRoot,
      this.paletteRoot,
      this.clockRoot,
      this.leaderboardRoot,
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
    if (name === 'Planter' && !isNull(this.planterRoot)) {
      return this.planterRoot;
    }
    if (name === 'PostItNotes' && !isNull(this.postItNotesRoot)) {
      return this.postItNotesRoot;
    }
    if (name === 'palette' && !isNull(this.paletteRoot)) {
      return this.paletteRoot;
    }
    if (name === 'Clock' && !isNull(this.clockRoot)) {
      return this.clockRoot;
    }
    if (name === 'Leaderboard' && !isNull(this.leaderboardRoot)) {
      return this.leaderboardRoot;
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

  private hideRetiredDeskProps(): void {
    const retired = ['palette', 'Leaderboard'];
    for (let i = 0; i < retired.length; i++) {
      const source = this.findGardenSpawnSource(retired[i]);
      if (!isNull(source)) {
        source.enabled = false;
      }
    }
    const namedPalette = this.findNamedSceneObject('palette');
    if (!isNull(namedPalette)) {
      namedPalette.enabled = false;
    }
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
    // Water and seed trays are legacy sources and are intentionally no longer
    // part of the persisted desk layout. Keep this hook as a compatibility
    // boundary for older serialized scenes without reviving either source.
    void source;
    void sourceName;
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

  private shouldKeepGardenSourceInWorldRoot(sourceName: string): boolean {
    void sourceName;
    return (
      !this.hasActiveAnchorTracking() ||
      this.usingWorldSpace ||
      this.restoredFromWorldFallback
    );
  }

  private getGardenSourceStorageSlug(sourceName: string): string {
    if (sourceName === 'Planter') {
      return 'planter';
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
    this.hideRetiredDeskProps();
    const useAnchorLocal = this.hasActiveAnchorTracking();
    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      const name = layoutNames[i];
      this.restoreGardenSourceTransform(name, useAnchorLocal);
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
    if (
      sourceName === 'Planter' ||
      sourceName === 'PostItNotes' ||
      sourceName === 'Clock'
    ) {
      return;
    }
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

    // Do not reparent or otherwise reconcile a source while SIK is actively
    // manipulating it. Reparenting during a grab can cancel the interaction,
    // which is especially noticeable on the dynamically-created leaderboard.
    if (!isNull(this.activeManipulatedRoot) && this.activeManipulatedRoot === source) {
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

  private clearTrashStorage(): void {
    const store = global.persistentStorageSystem.store;
    store.remove('trash_bin_wx');
    store.remove('trash_bin_wy');
    store.remove('trash_bin_wz');
    store.remove('trash_bin_x');
    store.remove('trash_bin_y');
    store.remove('trash_bin_z');
    store.remove('trash_bin_has_data');
    store.remove('trash_bin_uses_anchor_space');
    this.trashFixedWorldPosition = null;
    this.lastPersistedTrashWorld = null;
    this.trashRestoreApplied = false;
  }

  private captureTrashSceneDefault(): void {
    if (!isNull(this.trashSceneDefault)) {
      return;
    }
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject)) {
      return;
    }
    const transform = trashObject.getTransform();
    this.trashSceneDefault = {
      pos: transform.getWorldPosition(),
      rot: transform.getWorldRotation(),
      scale: transform.getWorldScale(),
    };
  }

  private resetTrashToSceneDefault(): void {
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject)) {
      return;
    }
    const defaults = this.trashSceneDefault;
    if (!isNull(defaults)) {
      const sceneRoot = this.findSceneRoot();
      if (trashObject.getParent() !== sceneRoot) {
        trashObject.setParent(sceneRoot);
      }
      trashObject.getTransform().setWorldPosition(defaults.pos);
      trashObject.getTransform().setWorldRotation(defaults.rot);
      trashObject.getTransform().setWorldScale(this.getTrashScaledWorldScale(defaults.scale));
    }
    this.trashFixedWorldPosition = trashObject.getTransform().getWorldPosition();
    this.lastPersistedTrashWorld = this.trashFixedWorldPosition;
  }

  /**
   * Friend onboarding: wipe persisted plants + desk layout from the last session
   * so the tour starts empty (no leftover Planter / plants / props from storage).
   */
  public clearPreviousSessionForOnboarding(): void {
    if (this.onboardingCleanSessionApplied) {
      return;
    }
    this.onboardingCleanSessionApplied = true;
    this.applyOnboardingCleanSession();
  }

  /**
   * Voice / workspace move: force clear plants + layout and best-effort spatial reset
   * so onboarding can run again in a new place.
   */
  public prepareOnboardingRestart(): void {
    print('Workspace reset: preparing onboarding restart');
    this.onboardingCleanSessionApplied = false;
    this.applyOnboardingCleanSession();
    this.onboardingCleanSessionApplied = true;
    void this.resetSpatialAnchorsForWorkspaceMove();
  }

  private applyOnboardingCleanSession(): void {
    print('Onboarding enabled: clearing previous session plants and layout anchors');
    this.setAIContainerBoardVisible(false);
    this.restoreAllDistanceCulledObjects();

    this.clearPersistedPlantStorageOnly();

    const objectsToDestroy = this.wrappers.slice();
    this.wrappers = [];
    this.objs = [];
    this.objectKinds = [];
    this.objectPrefabIndices = [];
    for (let i = 0; i < objectsToDestroy.length; i++) {
      const wrapper = objectsToDestroy[i];
      if (!isNull(wrapper)) {
        wrapper.destroy();
      }
    }
    this.destroyLoosePlantAndSeedSceneObjects();
    this.enforceNoLooseSeedTemplatesVisible('onboarding-cleanup');

    const layoutNames = this.getAnchorLayoutSourceNames();
    for (let i = 0; i < layoutNames.length; i++) {
      this.clearGardenSourceStorage(layoutNames[i]);
      this.gardenSourceFixedWorldPositions.delete(layoutNames[i]);
      this.gardenSourceLastPersistedWorld.delete(layoutNames[i]);
      this.gardenSourceRestoreApplied.delete(layoutNames[i]);
    }
    this.clearTrashStorage();
    this.restoreGardenSpawnSourcesLayout('reset');
    this.resetTrashToSceneDefault();
    this.hideRetiredDeskProps();
    this.hasRestored = false;
    this.nextPlantSpawnIndex = 0;
  }

  private setAIContainerBoardVisible(visible: boolean): void {
    if (isNull(this.menuRoot)) {
      return;
    }
    try {
      this.menuRoot.enabled = visible;
    } catch (_e) {
      // Ignore stale/invalid menu roots during startup resets.
    }
  }

  private destroyLoosePlantAndSeedSceneObjects(): void {
    const startsWith = ['PlantContent_', 'SeedPlantModel', 'PotContent_'];
    const destroyList: SceneObject[] = [];
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      this.collectLoosePlantAndSeedObjects(global.scene.getRootObject(i), startsWith, destroyList);
    }
    for (let i = 0; i < destroyList.length; i++) {
      const node = destroyList[i];
      if (!isNull(node)) {
        node.destroy();
      }
    }
    if (destroyList.length > 0) {
      print(`Onboarding cleanup: destroyed ${destroyList.length} loose seed/plant object(s)`);
    }
  }

  private enforceNoLooseSeedTemplatesVisible(reason: string): void {
    let disabledCount = 0;
    const roots: SceneObject[] = [];
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      roots.push(global.scene.getRootObject(i));
    }

    while (roots.length > 0) {
      const node = roots.pop();
      if (!node || isNull(node)) {
        continue;
      }

      if (
        String(node.name || '') === 'Seed' &&
        !this.isInsideTrackedPlantOrPot(node)
      ) {
        if (node.enabled) {
          node.enabled = false;
          disabledCount++;
        }
        // Parent disable is sufficient and avoids touching prefab child state.
        continue;
      }

      for (let i = 0; i < node.getChildrenCount(); i++) {
        roots.push(node.getChild(i));
      }
    }

    if (disabledCount > 0) {
      print(
        `[AnchorController] ${reason}: disabled ${disabledCount} loose Seed template object(s)`
      );
    }
  }

  private isInsideTrackedPlantOrPot(candidate: SceneObject): boolean {
    let current: SceneObject | null = candidate;
    while (!isNull(current)) {
      for (let i = 0; i < this.objs.length; i++) {
        if (current === this.objs[i] || current === this.wrappers[i]) {
          return true;
        }
      }
      const name = String(current.name || '');
      if (
        name.indexOf('PlantContent_') === 0 ||
        name.indexOf('PotContent_') === 0
      ) {
        return true;
      }
      current = current.getParent();
    }
    return false;
  }

  private collectLoosePlantAndSeedObjects(
    node: SceneObject,
    startsWith: string[],
    out: SceneObject[]
  ): void {
    if (isNull(node)) {
      return;
    }
    const name = String(node.name || '');
    for (let i = 0; i < startsWith.length; i++) {
      if (name.indexOf(startsWith[i]) === 0) {
        out.push(node);
        return;
      }
    }
    for (let i = 0; i < node.getChildrenCount(); i++) {
      this.collectLoosePlantAndSeedObjects(node.getChild(i), startsWith, out);
    }
  }

  private async resetSpatialAnchorsForWorkspaceMove(): Promise<void> {
    if (!this.anchorSession) {
      return;
    }
    try {
      const worldAnchor = this.currentAnchor as WorldAnchor | undefined;
      if (worldAnchor?._sceneObject) {
        try {
          await this.anchorSession.deleteAnchor(worldAnchor);
        } catch (_e) {
          // continue
        }
      }
      await this.anchorSession.reset();
      print('Workspace reset: spatial anchors cleared');
    } catch (e) {
      print('Workspace reset: spatial anchor clear failed: ' + e);
    }
    this.currentAnchor = undefined;
    this.anchorPersisted = false;
    this.lockedAnchorId = null;
    this.anchorBindingComplete = false;
    try {
      this.anchorComponent.anchor = null as unknown as Anchor;
    } catch (_e) {
      // ignore
    }
  }

  private isFriendOnboardingEnabled(): boolean {
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      if (this.findFriendOnboardingFlag(global.scene.getRootObject(i))) {
        return true;
      }
    }
    return false;
  }

  private findFriendOnboardingFlag(node: SceneObject): boolean {
    if (isNull(node)) {
      return false;
    }

    const scripts = node.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as ScriptComponent & {
        enableOnboarding?: boolean;
        treatAsNewUser?: boolean;
      };
      if (candidate && candidate.enableOnboarding === true) {
        // Returning users keep enableOnboarding on, but skip the clean wipe
        // unless Treat As New User forces the tour every session.
        return shouldRunFriendOnboardingTour(true, !!candidate.treatAsNewUser);
      }
    }

    for (let i = 0; i < node.getChildrenCount(); i++) {
      if (this.findFriendOnboardingFlag(node.getChild(i))) {
        return true;
      }
    }
    return false;
  }

  private restoreGardenSourceTransform(sourceName: string, useWorldSpace: boolean): void {
    void useWorldSpace;
    const source = this.findGardenSpawnSource(sourceName);
    if (isNull(source)) {
      return;
    }

    const store = global.persistentStorageSystem.store;
    const slug = this.getGardenSourceStorageSlug(sourceName);
    const isLiveDeskProp =
      sourceName === 'Planter' ||
      sourceName === 'PostItNotes' ||
      sourceName === 'Clock';
    const hasAnchorLocalData =
      this.hasActiveAnchorTracking() &&
      store.has(`${slug}_uses_anchor_space`) &&
      store.getBool(`${slug}_uses_anchor_space`) &&
      store.has(`${slug}_x`) &&
      store.has(`${slug}_y`) &&
      store.has(`${slug}_z`);

    if (hasAnchorLocalData && !isLiveDeskProp) {
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
      return;
    }

    if (
      this.isOnboardingLayoutOwned() ||
      isLiveDeskProp
    ) {
      const worldPos = source.getTransform().getWorldPosition();
      this.gardenSourceFixedWorldPositions.set(sourceName, worldPos);
      this.gardenSourceLastPersistedWorld.set(sourceName, worldPos);
      print(`Kept ${sourceName} pose for Buddy desk cluster`);
      return;
    }

    this.rebaseLayoutObjectNearCamera(
      source,
      this.getGardenSourceFallbackDistance(sourceName),
      this.getGardenSourceFallbackSide(sourceName),
      -24
    );
    const worldPos = source.getTransform().getWorldPosition();
    if (this.hasActiveAnchorTracking()) {
      source.setParent(this.widgetParent);
      source.getTransform().setWorldPosition(worldPos);
    }
    this.gardenSourceFixedWorldPositions.set(sourceName, worldPos);
    this.gardenSourceLastPersistedWorld.set(sourceName, worldPos);
    print(
      `Kept ${sourceName} near user (${hasAnchorLocalData ? 'anchor-local' : 'camera fallback'}) at ${worldPos.toString()}`
    );
    return;

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

  private prepareLayoutObjectsForCameraFallback(): void {
    const trash = this.getTrashSceneObject();
    if (!isNull(trash) && !this.hasActiveAnchorTracking()) {
      this.applyTrashScaledWorldSize();
      this.trashFixedWorldPosition = trash.getTransform().getWorldPosition();
      this.lastPersistedTrashWorld = null;
      this.trashRestoreApplied = false;
    }

    // AIContainer is intentionally authored disabled. Do not enable it just
    // to migrate a legacy persisted position; its inactive state is the
    // safety boundary for the old shared UI root.
    if (
      !isNull(this.menuRoot) &&
      this.menuRoot.enabled &&
      !this.hasActiveAnchorTracking()
    ) {
      this.rebaseLayoutObjectNearCamera(this.menuRoot, 58, 0, -24);
      this.aiContainerFixedWorldPosition =
        this.menuRoot.getTransform().getWorldPosition();
      this.lastPersistedAIContainerWorld = null;
      this.aiContainerRestoreApplied = false;
    }
  }

  private resolvePlacementCamera(): SceneObject | null {
    const candidates: Array<SceneObject | null> = [
      this.camera,
      this.findNamedSceneObject('Camera Object'),
      this.findNamedSceneObject('Device Camera'),
      this.findNamedSceneObject('Camera'),
    ];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (isNull(candidate)) {
        continue;
      }
      try {
        const position = candidate.getTransform().getWorldPosition();
        if (
          Number.isFinite(position.x) &&
          Number.isFinite(position.y) &&
          Number.isFinite(position.z)
        ) {
          return candidate;
        }
      } catch (_e) {
        // Ignore stale camera references and try the next candidate.
      }
    }
    return null;
  }

  private getCameraRelativePosition(
    distanceCm: number,
    sideCm: number,
    heightCm: number
  ): vec3 | null {
    const camera = this.resolvePlacementCamera();
    if (isNull(camera)) {
      return null;
    }

    try {
      const transform = camera.getTransform();
      const cameraPos = transform.getWorldPosition();
      let cameraForward = transform.forward;
      if (isNull(cameraForward)) {
        cameraForward = new vec3(0, 0, -1);
      }

      let viewX = cameraForward.x;
      let viewZ = cameraForward.z;
      const viewLength = Math.sqrt(viewX * viewX + viewZ * viewZ);
      if (viewLength < 0.001) {
        viewX = 0;
        viewZ = -1;
      } else {
        viewX /= viewLength;
        viewZ /= viewLength;
      }

      const rightX = -viewZ;
      const rightZ = viewX;
      const result = new vec3(
        cameraPos.x + viewX * distanceCm + rightX * sideCm,
        cameraPos.y + heightCm,
        cameraPos.z + viewZ * distanceCm + rightZ * sideCm
      );
      return Number.isFinite(result.x) &&
        Number.isFinite(result.y) &&
        Number.isFinite(result.z)
        ? result
        : null;
    } catch (_e) {
      return null;
    }
  }

  private rebaseLayoutObjectNearCamera(
    object: SceneObject,
    distanceCm: number,
    sideCm: number,
    heightCm: number
  ): boolean {
    if (isNull(object)) {
      return false;
    }
    const position = this.getCameraRelativePosition(
      Math.max(32, Math.min(72, distanceCm)),
      Math.max(-36, Math.min(36, sideCm)),
      Math.max(-24, Math.min(-8, heightCm))
    );
    if (isNull(position)) {
      return false;
    }
    try {
      object.getTransform().setWorldPosition(position);
      return true;
    } catch (_e) {
      return false;
    }
  }

  private getGardenSourceFallbackDistance(sourceName: string): number {
    return sourceName === 'PostItNotes' ? 36 : 38;
  }

  private getGardenSourceFallbackSide(sourceName: string): number {
    switch (sourceName) {
      case 'Planter':
        return -10;
      case 'PostItNotes':
        return -4;
      case 'Clock':
        return 10;
      case 'palette':
        return -38;
      default:
        return 0;
    }
  }

  private placeDeskPropsAroundTrash(): void {
    // FriendGrab owns live desk placement around Buddy. Spreading
    // Planter / PostItNotes / Clock ±27 cm from trash left only the
    // bin in the Spectacles 2024 field of view.
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

      // Live desk props stay on for returning users even if a previous
      // onboarding hide captured them as disabled.
      const isLiveDeskProp =
        name === 'Planter' || name === 'PostItNotes' || name === 'Clock';
      const sceneEnabled = this.gardenSourceSceneEnabled.has(name)
        ? this.gardenSourceSceneEnabled.get(name)
        : source.enabled;
      source.enabled = isLiveDeskProp ? true : !!sceneEnabled;
      if (!source.enabled) {
        print(`Anchor layout object ${name} left disabled (${reason})`);
        continue;
      }

      this.sanitizeGardenSpawnSourcePresentation(source, name);

      if (reason === 'reset') {
        this.clearGardenSourceStorage(name);
        if (source.getParent() !== sceneRoot) {
          source.setParent(sceneRoot);
        }

        const defaults = this.gardenSpawnSourceDefaults.get(name);
        if (defaults) {
          source.getTransform().setWorldPosition(defaults.pos);
          source.getTransform().setWorldRotation(defaults.rot);
          source
            .getTransform()
            .setWorldScale(this.getLayoutScaleForSource(name, defaults.scale));
        }
        if (!isLiveDeskProp) {
          this.rebaseLayoutObjectNearCamera(
            source,
            this.getGardenSourceFallbackDistance(name),
            this.getGardenSourceFallbackSide(name),
            -10
          );
        }

        this.gardenSourceFixedWorldPositions.set(
          name,
          source.getTransform().getWorldPosition()
        );
        this.gardenSourceLastPersistedWorld.delete(name);
        this.gardenSourceRestoreApplied.delete(name);
        print(`Anchor layout object ${name} reset (${reason})`);
        continue;
      }

      if (!this.hasActiveAnchorTracking()) {
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
        const defaults = this.gardenSpawnSourceDefaults.get(name);
        if (defaults) {
          source.getTransform().setWorldRotation(defaults.rot);
          source
            .getTransform()
            .setWorldScale(this.getLayoutScaleForSource(name, defaults.scale));
        }
        if (!this.hasActiveAnchorTracking() && !isLiveDeskProp) {
          this.rebaseLayoutObjectNearCamera(
            source,
            this.getGardenSourceFallbackDistance(name),
            this.getGardenSourceFallbackSide(name),
            -10
          );
        }
      }

      const worldPos = source.getTransform().getWorldPosition();
      print(
        `Anchor layout object ${name} ready (${reason}) at world: {x: ${worldPos.x}, y: ${worldPos.y}, z: ${worldPos.z}}`
      );
    }
    this.placeDeskPropsAroundTrash();
  }

  private restoreGardenSpawnSourcesAfterReset(): void {
    this.restoreGardenSpawnSourcesLayout('reset');
  }

  private getLayoutScaleForSource(sourceName: string, baseScale: vec3): vec3 {
    if (sourceName !== 'palette') {
      return baseScale;
    }

    return new vec3(
      baseScale.x * PALETTE_EXTRA_SCALE_MULTIPLIER,
      baseScale.y * PALETTE_EXTRA_SCALE_MULTIPLIER,
      baseScale.z * PALETTE_EXTRA_SCALE_MULTIPLIER
    );
  }

  private captureTrashInitialTransform(): void {
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject) || !isNull(this.trashFixedWorldPosition)) {
      return;
    }

    this.trashFixedWorldPosition = trashObject.getTransform().getWorldPosition();
  }

  private restoreTrashFromStorage(): void {
    this.restoreTrashTransform(this.hasActiveAnchorTracking());
    this.trashRestoreApplied = true;
  }

  private applyTrashSavedPose(): void {
    // FriendGrab places TrashBin with the Buddy desk cluster.
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
    if (isNull(trashObject) || !this.hasActiveAnchorTracking()) {
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
    void useWorldSpace;
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject)) {
      return;
    }
    this.applyTrashScaledWorldSize();

    const worldPos = trashObject.getTransform().getWorldPosition();
    if (this.hasActiveAnchorTracking()) {
      trashObject.setParent(this.widgetParent);
      trashObject.getTransform().setWorldPosition(worldPos);
    }
    this.applyTrashScaledWorldSize();
    this.trashFixedWorldPosition = worldPos;
    this.lastPersistedTrashWorld = worldPos;
    print(`TrashBin kept for Buddy desk cluster at ${worldPos.toString()}`);
  }

  private getTrashScaledWorldScale(baseScale: vec3): vec3 {
    return new vec3(
      baseScale.x * TRASH_BIN_SCALE_MULTIPLIER,
      baseScale.y * TRASH_BIN_SCALE_MULTIPLIER,
      baseScale.z * TRASH_BIN_SCALE_MULTIPLIER
    );
  }

  private applyTrashScaledWorldSize(): void {
    const trashObject = this.getTrashSceneObject();
    if (isNull(trashObject) || isNull(this.trashSceneDefault)) {
      return;
    }
    trashObject
      .getTransform()
      .setWorldScale(this.getTrashScaledWorldScale(this.trashSceneDefault.scale));
  }

  private wireTrashBinMovement(): void {
    const trash = this.trashBin as TrashBin;
    if (!isNull(trash)) {
      if (typeof trash.setUseExternalMoveHandle === 'function') {
        trash.setUseExternalMoveHandle(false);
      }
      if (typeof trash.wireMoveInteraction === 'function') {
        trash.wireMoveInteraction();
      }
      if (typeof trash.bindStashRestore === 'function') {
        trash.bindStashRestore(this);
      }
    }
    this.disableTrashBinMoveHandle();
  }

  private scheduleGardenAndTrashHandleWiring(): void {
    this.scheduleDelayed(() => {
      this.wireGardenSourceMoveHandles();
    }, 0.3);
  }

  private disableTrashBinMoveHandle(): void {
    const trash = this.getTrashSceneObject();
    if (isNull(trash)) {
      return;
    }
    const handle = this.findNamedChild(trash, GARDEN_SOURCE_MOVE_HANDLE_NAME);
    if (!isNull(handle)) {
      handle.enabled = false;
    }
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
      manipulation.enableRotation = true;
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
    if (isNull(source) || !this.hasActiveAnchorTracking()) {
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
    const handleNames = GARDEN_SOURCE_MOVE_HANDLE_NAMES;
    const template = this.findMoveHandleTemplate();
    for (let i = 0; i < handleNames.length; i++) {
      const name = handleNames[i];
      const source = this.findGardenSpawnSource(name);
      // Still wire while temporarily disabled (e.g. Friend onboarding hide) so
      // the handle is ready the moment the source is revealed again.
      if (isNull(source)) {
        continue;
      }

      let handle = this.findNamedChild(source, GARDEN_SOURCE_MOVE_HANDLE_NAME);
      if (name === 'palette' && isNull(handle) && !isNull(template)) {
        handle = this.createMoveHandleFromTemplate(source, template as SceneObject);
      }
      if (isNull(handle)) {
        if (name === 'palette') {
          print('palette move handle skipped: no garden source MoveHandle template found');
        }
        continue;
      }

      handle.enabled = true;
      if (name === 'palette' && !isNull(template)) {
        this.applyCopiedMoveHandleLayout(handle, source, template as SceneObject);
        const legacyHandle = this.findNamedChild(source, 'PaletteMoveHandle');
        if (!isNull(legacyHandle)) {
          legacyHandle.enabled = false;
        }
      } else if (name === 'PostItNotes') {
        this.applyGardenSourceMoveHandleLayout(name, handle);
        this.applyPostItMoveHandleLayout(handle, source);
      } else {
        this.applyGardenSourceMoveHandleLayout(name, handle);
      }
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
        if (typeof script.refreshManipulationRootBinding === 'function') {
          script.refreshManipulationRootBinding();
        }
        if (typeof script.refreshHandlePresentation === 'function') {
          script.refreshHandlePresentation();
        }
      }
    }
  }

  private applyCopiedMoveHandleLayout(
    handle: SceneObject,
    source: SceneObject,
    template: SceneObject
  ): void {
    const templateParent = template.getParent();
    const referenceScale = isNull(templateParent)
      ? new vec3(1, 1, 1)
      : templateParent.getTransform().getWorldScale();
    const sourceScale = source.getTransform().getWorldScale();
    const templateTransform = template.getTransform();
    const templateLocalPos = templateTransform.getLocalPosition();
    const templateLocalScale = templateTransform.getLocalScale();

    handle.getTransform().setLocalPosition(
      new vec3(
        (templateLocalPos.x * referenceScale.x) / Math.max(Math.abs(sourceScale.x), 0.001),
        (templateLocalPos.y * referenceScale.y) / Math.max(Math.abs(sourceScale.y), 0.001),
        (templateLocalPos.z * referenceScale.z) / Math.max(Math.abs(sourceScale.z), 0.001)
      )
    );
    handle.getTransform().setLocalScale(
      new vec3(
        (templateLocalScale.x * referenceScale.x) / Math.max(Math.abs(sourceScale.x), 0.001),
        (templateLocalScale.y * referenceScale.y) / Math.max(Math.abs(sourceScale.y), 0.001),
        (templateLocalScale.z * referenceScale.z) / Math.max(Math.abs(sourceScale.z), 0.001)
      )
    );

    // Palette's imported mesh is rotated differently from planter/seeds, so a
    // copied local offset can land beneath it. Place the handle from measured
    // world bounds instead: just outside the front-right edge and above the top.
    const bounds = this.measureSourceVisualBoundsExcludingHandle(source, handle);
    if (!isNull(bounds)) {
      const width = Math.max(1, bounds.max.x - bounds.min.x);
      const depth = Math.max(1, bounds.max.z - bounds.min.z);
      const edgePadding = Math.max(2.5, Math.min(6, Math.max(width, depth) * 0.08));
      handle.getTransform().setWorldPosition(
        new vec3(
          bounds.max.x + edgePadding,
          bounds.max.y + Math.max(2.5, edgePadding * 0.65),
          bounds.max.z + edgePadding
        )
      );
    }
  }

  private applyPostItMoveHandleLayout(handle: SceneObject, source: SceneObject): void {
    const bounds = this.measureSourceVisualBoundsExcludingHandle(source, handle);
    if (isNull(bounds)) {
      return;
    }

    const sourcePos = source.getTransform().getWorldPosition();
    // Stay just beyond the source's grab collider so direct note pulling does
    // not steal the handle interaction, while keeping it within easy reach.
    const colliderClearanceCm = 8;
    const visualClearanceCm = 3.5;
    handle.getTransform().setWorldPosition(
      new vec3(
        Math.max(
          bounds.max.x + visualClearanceCm,
          sourcePos.x + colliderClearanceCm
        ),
        bounds.max.y + 3,
        Math.max(
          bounds.max.z + visualClearanceCm,
          sourcePos.z + colliderClearanceCm
        )
      )
    );
  }

  private measureSourceVisualBoundsExcludingHandle(
    source: SceneObject,
    excludedHandle: SceneObject
  ): { min: vec3; max: vec3 } | null {
    let min: vec3 | null = null;
    let max: vec3 | null = null;
    const stack: SceneObject[] = [source];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current) || current === excludedHandle) {
        continue;
      }
      const name = String(current.name || '');
      if (
        name === GARDEN_SOURCE_MOVE_HANDLE_NAME ||
        name === 'PaletteMoveHandle' ||
        name === 'PalettePaintCancel' ||
        name === 'PalettePaintStrokes'
      ) {
        continue;
      }

      const visuals = current.getComponents(
        'Component.RenderMeshVisual'
      ) as RenderMeshVisual[];
      for (let i = 0; i < visuals.length; i++) {
        const visual = visuals[i];
        if (isNull(visual) || !visual.enabled || isNull(visual.mesh)) {
          continue;
        }
        const visualMin = visual.worldAabbMin();
        const visualMax = visual.worldAabbMax();
        min = isNull(min)
          ? visualMin
          : new vec3(
              Math.min(min.x, visualMin.x),
              Math.min(min.y, visualMin.y),
              Math.min(min.z, visualMin.z)
            );
        max = isNull(max)
          ? visualMax
          : new vec3(
              Math.max(max.x, visualMax.x),
              Math.max(max.y, visualMax.y),
              Math.max(max.z, visualMax.z)
            );
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    return isNull(min) || isNull(max) ? null : { min, max };
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
    const scale = GARDEN_SOURCE_MOVE_HANDLE_LOCAL_SCALES[sourceName];
    if (scale) {
      handle.getTransform().setLocalScale(scale);
    }
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
    const index = this.wrappers.length;
    const wrapper = global.scene.createSceneObject(
      objectKind === OBJECT_KIND_POT ? `Pot_${index}` : `Plant_${index}`
    );
    wrapper.setParent(this.getSpawnParent());
    wrapper
      .getTransform()
      .setLocalScale(
        new vec3(
          GLOBAL_OBJECT_SCALE_MULTIPLIER,
          GLOBAL_OBJECT_SCALE_MULTIPLIER,
          GLOBAL_OBJECT_SCALE_MULTIPLIER
        )
      );

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
    this.enforceTrackedObjectManipulationSettings(obj, wrapper);
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
      `pinch up ${ANCHOR_CONTROLLER_VERSION} anchor=${!!this.currentAnchor} fallback=${this.usingWorldSpace} creating=${this.anchorCreationInProgress}`
    );

    this.maintainTrashAnchorBinding();
    this.maintainAIContainerAnchorBinding();
    this.maintainGardenSourceAnchorBindings();
    this.lockSpacePanelAtDesk();

    if (
      !this.currentAnchor &&
      !this.anchorCreationInProgress &&
      this.objs.length > 0
    ) {
      this.startWorldAnchorCreation(this.getPlantAnchorWorldMatrix());
      return;
    }

    if (this.currentAnchor && !this.usingWorldSpace) {
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
    if (!this.hasActiveAnchorTracking()) {
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
    this.persistStickyNoteState(
      store,
      storageSlot,
      obj,
      this.objectKinds[memoryIndex] || OBJECT_KIND_PLANT
    );

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
    if (objectKind === OBJECT_KIND_POT || objectKind === OBJECT_KIND_STICKY_NOTE) {
      return true;
    }

    return store.has(`w${index}_plant_planted`) && store.getBool(`w${index}_plant_planted`);
  }

  private isPersistableTrackedObject(index: number): boolean {
    if (index < 0 || index >= this.objs.length) {
      return false;
    }

    const objectKind = this.objectKinds[index] || OBJECT_KIND_PLANT;
    if (objectKind === OBJECT_KIND_POT || objectKind === OBJECT_KIND_STICKY_NOTE) {
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
      'plant_walked_meters',
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

    const sourcePendingGoalKey = `w${fromIndex}_pot_pending_goal`;
    const targetPendingGoalKey = `w${toIndex}_pot_pending_goal`;
    if (store.has(sourcePendingGoalKey)) {
      store.putString(targetPendingGoalKey, store.getString(sourcePendingGoalKey));
    } else {
      store.remove(targetPendingGoalKey);
    }

    const sourceNoteTextKey = `w${fromIndex}_note_text`;
    const targetNoteTextKey = `w${toIndex}_note_text`;
    if (store.has(sourceNoteTextKey)) {
      store.putString(targetNoteTextKey, store.getString(sourceNoteTextKey));
    } else {
      store.remove(targetNoteTextKey);
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
    if (store.has(`w${index}_pot_pending_goal`)) {
      snapshot.strings.pot_pending_goal = store.getString(`w${index}_pot_pending_goal`);
    }
    if (store.has(`w${index}_note_text`)) {
      snapshot.strings.note_text = store.getString(`w${index}_note_text`);
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
    if (snapshot.strings.pot_pending_goal !== undefined) {
      store.putString(`w${index}_pot_pending_goal`, snapshot.strings.pot_pending_goal);
    }
    if (snapshot.strings.note_text !== undefined) {
      store.putString(`w${index}_note_text`, snapshot.strings.note_text);
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
      return;
    }

    if (useAnchorLocal && this.hasActiveAnchorTracking()) {
      this.usingWorldSpace = false;
      this.anchorComponent.enabled = true;
      const restoredCount = this.restoreAllObjects(true);
      this.reparentPlantsToAnchor();
      print(`Anchor-local restore complete (${restoredCount} object(s))`);
    } else {
      // No desk anchor is available. Restore into the temporary floating root
      // using camera-relative slots; never read legacy wx/wy/wz coordinates.
      this.usingWorldSpace = true;
      this.restoredFromWorldFallback = true;
      const restoredCount = this.restoreAllObjects(false);
      print(`Camera-relative fallback restore complete (${restoredCount} object(s))`);
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

  private restoreAllObjects(useAnchorLocal: boolean): number {
    const store = global.persistentStorageSystem.store;
    if (!store.has('widget_count')) {
      return 0;
    }

    const count = store.getInt('widget_count');
    if (count <= 0) {
      return 0;
    }

    this.clearSpawnedObjects();
    print(
      `Restoring ${count} objects (${useAnchorLocal ? 'anchor-local' : 'camera-relative'} space)`
    );

    let restoredCount = 0;
    for (let i = 0; i < count; i++) {
      if (
        useAnchorLocal &&
        (!store.has(`w${i}_x`) ||
          !store.has(`w${i}_y`) ||
          !store.has(`w${i}_z`))
      ) {
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
        objectKind === OBJECT_KIND_POT
          ? `Pot_${i}`
          : objectKind === OBJECT_KIND_STICKY_NOTE
            ? `StickyNote_${i}`
            : `Plant_${i}`
      );
      wrapper.setParent(this.getSpawnParent());
      const wrapperScale =
        objectKind === OBJECT_KIND_STICKY_NOTE
          ? vec3.one()
          : new vec3(
              GLOBAL_OBJECT_SCALE_MULTIPLIER,
              GLOBAL_OBJECT_SCALE_MULTIPLIER,
              GLOBAL_OBJECT_SCALE_MULTIPLIER
            );
      wrapper.getTransform().setLocalScale(wrapperScale);

      let obj: SceneObject;
      try {
        obj = prefab.instantiate(wrapper);
      } catch (e) {
        print('Restore spawn failed: ' + e);
        wrapper.destroy();
        continue;
      }
      obj.name =
        objectKind === OBJECT_KIND_POT
          ? `PotContent_${i}`
          : objectKind === OBJECT_KIND_STICKY_NOTE
            ? `StickyNoteContent_${i}`
            : `PlantContent_${i}`;

      const canUseAnchorLocal =
        useAnchorLocal &&
        this.hasActiveAnchorTracking() &&
        store.has(`w${i}_x`) &&
        store.has(`w${i}_y`) &&
        store.has(`w${i}_z`);
      if (canUseAnchorLocal) {
        const stored = this.getStoredAnchorLocalOffset(store, i);
        wrapper.setParent(this.widgetParent);
        wrapper.getTransform().setLocalPosition(stored.pos);
        wrapper.getTransform().setLocalRotation(stored.rot);
        obj.getTransform().setLocalPosition(vec3.zero());
        obj.getTransform().setLocalRotation(quat.quatIdentity());
        print(`Restored object ${i} from anchor-local offset ${stored.pos.toString()}`);
      } else {
        const fallback = this.getCameraRelativeSpawnPosition(i);
        wrapper.getTransform().setWorldPosition(fallback);
        wrapper.getTransform().setWorldRotation(quat.quatIdentity());
        obj.getTransform().setLocalPosition(vec3.zero());
        obj.getTransform().setLocalRotation(quat.quatIdentity());
        print(`Restored object ${i} at camera-relative fallback ${fallback.toString()}`);
      }

      this.wrappers.push(wrapper);
      this.objs.push(obj);
      this.objectKinds.push(objectKind);
      this.objectPrefabIndices.push(prefabIndex);
      this.enforceTrackedObjectManipulationSettings(obj, wrapper);

      this.wirePotPersistence(obj);
      this.restorePlantState(store, i, obj);
      this.restoreStickyNoteState(store, i, obj, objectKind);
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

  private persistStickyNoteState(
    store: GeneralDataStore,
    index: number,
    obj: SceneObject,
    objectKind: string
  ): void {
    if (objectKind !== OBJECT_KIND_STICKY_NOTE) {
      store.remove(`w${index}_note_text`);
      return;
    }

    const transcript = this.findStickyNoteTranscript(obj);
    const noteText =
      !isNull(transcript) && typeof transcript.getNoteText === 'function'
        ? String(transcript.getNoteText() || '')
        : '';
    if (noteText) {
      store.putString(`w${index}_note_text`, noteText);
    } else {
      store.remove(`w${index}_note_text`);
    }
  }

  private restoreStickyNoteState(
    store: GeneralDataStore,
    index: number,
    obj: SceneObject,
    objectKind: string
  ): void {
    if (
      objectKind !== OBJECT_KIND_STICKY_NOTE ||
      !store.has(`w${index}_note_text`)
    ) {
      return;
    }

    const transcript = this.findStickyNoteTranscript(obj);
    if (!isNull(transcript) && typeof transcript.setNoteText === 'function') {
      transcript.setNoteText(store.getString(`w${index}_note_text`));
    }
  }

  private persistPlantState(store: GeneralDataStore, index: number, obj: SceneObject) {
    const pot = this.findPotScript(obj);
    const pendingGoal =
      !isNull(pot) && typeof pot.getPendingGoalText === 'function'
        ? String(pot.getPendingGoalText() || '').trim()
        : '';
    if (!isNull(pot)) {
      if (pendingGoal) {
        store.putString(`w${index}_pot_pending_goal`, pendingGoal);
      } else {
        store.remove(`w${index}_pot_pending_goal`);
      }
    } else {
      store.remove(`w${index}_pot_pending_goal`);
    }

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
    store.putFloat(`w${index}_plant_walked_meters`, state.walkedMeters ?? 0);
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
    if (state.requiresGoalCompletion && state.goalText) {
      store.putString(`w${index}_plant_goal_text`, state.goalText);
      store.putBool(`w${index}_plant_goal_required`, true);
      store.putBool(`w${index}_plant_goal_done`, !!state.goalCompleted);
    } else {
      store.remove(`w${index}_plant_goal_text`);
      store.remove(`w${index}_plant_goal_required`);
      store.remove(`w${index}_plant_goal_done`);
    }
    store.remove(`w${index}_pot_pending_goal`);
  }

  private restorePlantState(store: GeneralDataStore, index: number, obj: SceneObject) {
    const pot = this.findPotScript(obj);
    if (!store.has(`w${index}_plant_stage`)) {
      if (
        !isNull(pot) &&
        typeof pot.setPendingGoal === 'function' &&
        store.has(`w${index}_pot_pending_goal`)
      ) {
        pot.setPendingGoal(store.getString(`w${index}_pot_pending_goal`));
      }
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
      walkedMeters: store.has(`w${index}_plant_walked_meters`)
        ? store.getFloat(`w${index}_plant_walked_meters`)
        : undefined,
      hasBeenWatered:
        store.has(`w${index}_plant_watered`) && store.getBool(`w${index}_plant_watered`),
      isPlanted: isPlanted,
      plantedWorldRotation: plantedWorldRotation,
      ...plantedAlignment,
      goalText: store.has(`w${index}_plant_goal_text`)
        ? store.getString(`w${index}_plant_goal_text`)
        : '',
      requiresGoalCompletion:
        store.has(`w${index}_plant_goal_required`) &&
        store.getBool(`w${index}_plant_goal_required`),
      goalCompleted:
        store.has(`w${index}_plant_goal_done`) && store.getBool(`w${index}_plant_goal_done`),
    };
    plant.applySaveState(state);

    if (
      !isNull(pot) &&
      !state.goalText &&
      typeof pot.setPendingGoal === 'function' &&
      store.has(`w${index}_pot_pending_goal`)
    ) {
      pot.setPendingGoal(store.getString(`w${index}_pot_pending_goal`));
    }
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
    store.remove(`w${index}_plant_walked_meters`);
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
    store.remove(`w${index}_plant_goal_text`);
    store.remove(`w${index}_plant_goal_required`);
    store.remove(`w${index}_plant_goal_done`);
    store.remove(`w${index}_pot_pending_goal`);
    store.remove(`w${index}_note_text`);
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

  /**
   * Some prefabs ship with direct-only/default manipulation flags.
   * Force tracked objects to support distance pinch + rotation consistently.
   */
  private enforceTrackedObjectManipulationSettings(
    contentRoot: SceneObject,
    wrapperRoot: SceneObject | null
  ): void {
    this.applyManipulationSettingsOnHierarchy(contentRoot);
    if (!isNull(wrapperRoot)) {
      this.applyManipulationSettingsOnHierarchy(wrapperRoot as SceneObject);
    }
  }

  private applyManipulationSettingsOnHierarchy(root: SceneObject): void {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i] as ScriptComponent & {
          manipulateRootSceneObject?: SceneObject;
          enableTranslation?: boolean;
          enableRotation?: boolean;
          enableScale?: boolean;
          targetingMode?: number;
          onTriggerStart?: unknown;
          onDragStart?: unknown;
          onInteractorTriggerStart?: unknown;
          ignoreInteractionPlane?: boolean;
        };
        if (isNull(script)) {
          continue;
        }

        if (script.manipulateRootSceneObject !== undefined) {
          if (script.enableTranslation !== undefined) {
            script.enableTranslation = true;
          }
          if (script.enableRotation !== undefined) {
            script.enableRotation = true;
          }
          if (script.enableScale !== undefined) {
            script.enableScale = false;
          }
        }

        if (
          script.targetingMode !== undefined &&
          (script.onTriggerStart !== undefined ||
            script.onDragStart !== undefined ||
            script.onInteractorTriggerStart !== undefined)
        ) {
          script.targetingMode = 7;
          if (script.ignoreInteractionPlane !== undefined) {
            script.ignoreInteractionPlane = true;
          }
        }
      }

      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
  }

  private getPrefabForStoredObject(objectKind: string, prefabIndex: number): ObjectPrefab {
    if (objectKind === OBJECT_KIND_POT) {
      if (prefabIndex >= 0 && prefabIndex < this.potPrefabs.length && !isNull(this.potPrefabs[prefabIndex])) {
        return this.potPrefabs[prefabIndex];
      }
      return null as unknown as ObjectPrefab;
    }

    if (objectKind === OBJECT_KIND_STICKY_NOTE) {
      return this.stickyNotePrefab as ObjectPrefab;
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

  private findStickyNoteTranscript(root: SceneObject): {
    getNoteText?: () => string;
    setNoteText?: (value: string) => void;
  } | null {
    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as unknown as {
          getNoteText?: () => string;
          setNoteText?: (value: string) => void;
        };
        if (
          !isNull(candidate) &&
          (typeof candidate.getNoteText === 'function' ||
            typeof candidate.setNoteText === 'function')
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

  private findPotScript(root: SceneObject): {
    setAnchorPersistence?: (persistence: AnchorController) => void;
    createRestoredPlant?: (plantPrefab: ObjectPrefab) => PlantLifecycle;
    getPlantedLifecycle?: () => PlantLifecycle | null;
    tryAttachSeed?: (plant: PlantLifecycle) => boolean;
    setPendingGoal?: (goalText: string) => void;
    getPendingGoalText?: () => string;
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
          tryAttachSeed?: (plant: PlantLifecycle) => boolean;
          setPendingGoal?: (goalText: string) => void;
          getPendingGoalText?: () => string;
        };
        if (
          !isNull(candidate) &&
          (
            typeof candidate.setAnchorPersistence === 'function' ||
            typeof candidate.createRestoredPlant === 'function' ||
            typeof candidate.getPlantedLifecycle === 'function' ||
            typeof candidate.tryAttachSeed === 'function' ||
            typeof candidate.setPendingGoal === 'function' ||
            typeof candidate.getPendingGoalText === 'function'
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
      setPendingGoal?: (goalText: string) => void;
      getPendingGoalText?: () => string;
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

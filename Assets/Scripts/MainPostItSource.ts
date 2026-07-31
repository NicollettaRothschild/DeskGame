import { playInteractionSound } from './InteractionSoundRegistry';
import {
  shouldBlockGardenSourceSpawn,
  setGardenSourceSpawnPullActive,
} from './GardenSourceSpawnGuard';
import { scheduleDeferredDestroy } from './FlowGardenDestroyHooks';
import { getSharedSpeechRecognition } from './FlowGardenServiceRegistry';
import { SpeechRecognition } from './SpeechRecognition';

type PublicEventLike<T> = {
  add(callback: (event: T) => void): void;
};

type InteractorLike = {
  activeTargetingMode?: number;
  startPoint?: vec3 | null;
  direction?: vec3 | null;
  distanceToTarget?: number | null;
  targetHitPosition?: vec3 | null;
  isActive?: () => boolean;
};

type InteractorEventLike = {
  interactor?: InteractorLike | null;
};

type InteractableLike = ScriptComponent & {
  onInteractorTriggerStart?: PublicEventLike<InteractorEventLike>;
  onTriggerStart?: PublicEventLike<InteractorEventLike>;
  onTriggerUpdate?: PublicEventLike<InteractorEventLike>;
  onDragStart?: PublicEventLike<InteractorEventLike>;
  onDragUpdate?: PublicEventLike<InteractorEventLike>;
  onInteractorTriggerUpdate?: PublicEventLike<InteractorEventLike>;
  onDragEnd?: PublicEventLike<InteractorEventLike>;
  onInteractorTriggerEnd?: PublicEventLike<InteractorEventLike>;
  onInteractorTriggerEndOutside?: PublicEventLike<InteractorEventLike>;
  onTriggerEnd?: PublicEventLike<InteractorEventLike>;
  onTriggerEndOutside?: PublicEventLike<InteractorEventLike>;
  onTriggerCanceled?: PublicEventLike<InteractorEventLike>;
  targetingMode?: number;
  ignoreInteractionPlane?: boolean;
};

type AnchorNoteSpawner = {
  saveObjectPosition?: () => void;
  setActiveManipulatedRoot?: (root: SceneObject | null) => void;
  notifyTrashSpawnGrace?: (root: SceneObject, graceSeconds?: number) => void;
  syncTrackedWrapperToContent?: (content: SceneObject) => void;
  placeTrackedContentAtWorld?: (content: SceneObject, worldPos: vec3, worldRot?: quat) => void;
};

type NoteTranscriptLike = {
  beginCapture?: () => void;
  endCapture?: () => void;
};

type PullState = {
  noteObject: SceneObject;
  interactor: InteractorLike | null;
  rayDistance: number;
};

type FallbackTranscriptCapture = {
  noteObject: SceneObject;
  noteRoot: SceneObject | null;
  noteText: Text3D | null;
  listener: (text: string, isFinal: boolean) => void;
  owners: number;
};

/**
 * Post-it pad stack: pinch/grab spawns one note and follows the hand until release
 * (same pattern as MainWaterSource / MainSeedSource / MainPotSource).
 */
@component
export class MainPostItSource extends BaseScriptComponent {
  @input
  notePrefab!: ObjectPrefab;

  @input
  @allowUndefined
  anchorController!: ScriptComponent;

  @input
  @allowUndefined
  sourceInteractable!: ScriptComponent;

  @input
  @allowUndefined
  spawnParent!: SceneObject;

  @input('float')
  spawnForwardOffset: number = 0;

  @input('float')
  fallbackRayDistance: number = 35;

  @input
  followInteractorWhileHeld: boolean = true;

  @input
  allowMultipleActiveNotes: boolean = false;

  @input
  debugLogging: boolean = false;

  @input('float')
  @hint('Keep transcript capture active briefly after release')
  postReleaseCaptureSec: number = 12;

  @input
  @hint('Render source as layered sticky-note stack')
  forceLayeredStackVisual: boolean = true;

  @input
  @hint('Enlarge stack collider for easier note grabbing')
  enforceLargeSourceGrabCollider: boolean = true;

  @input
  sourceGrabColliderMinSize: vec3 = new vec3(26, 16, 20);

  @input('float')
  sourceGrabColliderPaddingCm: number = 4;

  @input('int')
  stackLayerCount: number = 10;

  @input('float')
  stackLayerThickness: number = 0.035;

  @input('float')
  stackLayerGap: number = 0.028;

  @input('float')
  stackLayerOffsetSpread: number = 0.018;

  private activePull: PullState | null = null;
  private updateEvent: UpdateEvent | null = null;
  private bindAttempts = 0;
  private isBound = false;
  private spawnSuppressed = false;
  private noteSerial = 0;
  private fallbackCaptures: FallbackTranscriptCapture[] = [];
  private sharedSpeech: SpeechRecognition | null = null;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => {
      this.ensureLayeredStackVisual();
      this.ensureSourceGrabCollider();
      this.tryBindInteractable();
    });
  }

  public setSpawnSuppressed(suppressed: boolean): void {
    this.spawnSuppressed = suppressed;
  }

  public abortActiveSpawnPull(): void {
    if (isNull(this.activePull) || isNull(this.activePull.noteObject)) {
      return;
    }

    const noteObject = this.activePull.noteObject;
    this.endNoteTranscriptCapture(noteObject);
    setGardenSourceSpawnPullActive(this.getSceneObject(), false);
    this.activePull = null;
    if (!isNull(this.updateEvent)) {
      (this.updateEvent as UpdateEvent).enabled = false;
    }

    scheduleDeferredDestroy(this, noteObject, () => {
      this.debugLog('aborted mistaken spawn pull for move handle.');
    });
  }

  public spawnNoteAtSource(): SceneObject | null {
    return this.spawnNote(this.getSceneObject().getTransform().getWorldPosition(), null);
  }

  public spawnNoteAtWorldPosition(worldPosition: vec3): SceneObject | null {
    return this.spawnNote(worldPosition, null);
  }

  private bindInteractable(interactable: InteractableLike): void {
    if (this.isBound) {
      return;
    }

    const triggerStart = interactable.onInteractorTriggerStart || interactable.onTriggerStart;
    const triggerUpdate =
      interactable.onTriggerUpdate ||
      interactable.onDragUpdate ||
      interactable.onInteractorTriggerUpdate;
    if (!triggerStart && !interactable.onDragStart) {
      this.debugLog('sourceInteractable found, but trigger/drag events are not initialized yet.');
      return;
    }

    if (triggerStart) {
      triggerStart.add((event) => this.onTriggerStart(event, 'trigger start'));
    }
    if (interactable.onDragStart) {
      interactable.onDragStart.add((event) => this.onTriggerStart(event, 'drag start'));
    }
    if (triggerUpdate) {
      triggerUpdate.add((event) => this.onTriggerUpdate(event));
    }

    if (interactable.onInteractorTriggerEnd) {
      interactable.onInteractorTriggerEnd.add(() => this.releaseActivePull());
    }
    if (interactable.onInteractorTriggerEndOutside) {
      interactable.onInteractorTriggerEndOutside.add(() => this.releaseActivePull());
    }
    if (interactable.onTriggerEnd) {
      interactable.onTriggerEnd.add(() => this.releaseActivePull());
    }
    if (interactable.onTriggerEndOutside) {
      interactable.onTriggerEndOutside.add(() => this.releaseActivePull());
    }
    if (interactable.onDragEnd) {
      interactable.onDragEnd.add(() => this.releaseActivePull());
    }
    if (interactable.onTriggerCanceled) {
      interactable.onTriggerCanceled.add(() => this.releaseActivePull());
    }

    this.isBound = true;
    if (interactable.targetingMode !== undefined) {
      interactable.targetingMode = 7;
    }
    if (interactable.ignoreInteractionPlane !== undefined) {
      interactable.ignoreInteractionPlane = true;
    }
    this.debugLog('bound to source Interactable.');
  }

  private onTriggerStart(event: InteractorEventLike, reason: string): void {
    const sourceRoot = this.getSceneObject();
    const interactor = event && event.interactor ? event.interactor : null;
    if (shouldBlockGardenSourceSpawn(sourceRoot, interactor, this.spawnSuppressed)) {
      this.debugLog(`ignored ${reason}: move handle interaction.`);
      return;
    }

    if (!this.allowMultipleActiveNotes && !isNull(this.activePull)) {
      this.debugLog(`ignored ${reason}: note already active.`);
      return;
    }

    const rayDistance = this.getRayDistance(interactor);
    const spawnPosition = this.getInteractorPosition(interactor, rayDistance);
    this.beginSpawnPull(spawnPosition, interactor, rayDistance, reason);
  }

  private beginSpawnPull(
    spawnPosition: vec3,
    interactor: InteractorLike | null,
    rayDistance: number,
    reason: string
  ): void {
    const sourceRoot = this.getSceneObject();
    if (shouldBlockGardenSourceSpawn(sourceRoot, interactor, this.spawnSuppressed)) {
      this.debugLog(`ignored ${reason}: move handle interaction.`);
      return;
    }

    if (!this.allowMultipleActiveNotes && !isNull(this.activePull)) {
      this.debugLog(`ignored ${reason}: note already active.`);
      return;
    }

    this.debugLog(`spawning post-it from ${reason}.`);
    const noteObject = this.spawnNote(spawnPosition, interactor);
    if (isNull(noteObject)) {
      return;
    }

    this.activePull = {
      noteObject: noteObject,
      interactor: interactor,
      rayDistance: rayDistance,
    };
    setGardenSourceSpawnPullActive(this.getSceneObject(), true);
    this.beginNoteTranscriptCapture(noteObject);
    const anchorSpawner = this.getAnchorNoteSpawner();
    if (!isNull(anchorSpawner)) {
      const spawner = anchorSpawner as AnchorNoteSpawner;
      if (typeof spawner.setActiveManipulatedRoot === 'function') {
        spawner.setActiveManipulatedRoot(noteObject);
      }
      this.notifyTrashSpawnGrace(noteObject, 5);
    }
    playInteractionSound((sounds) => sounds.playGrabObject());
    this.ensureUpdateLoop();
    this.updatePulledNotePosition();
  }

  private onTriggerUpdate(event: InteractorEventLike): void {
    if (isNull(this.activePull) || isNull(this.activePull.noteObject)) {
      return;
    }

    if (!isNull(event) && !isNull(event.interactor)) {
      this.activePull.interactor = event.interactor;
    }

    this.updatePulledNotePosition();
  }

  private updatePulledNotePosition(): void {
    if (
      !this.followInteractorWhileHeld ||
      isNull(this.activePull) ||
      isNull(this.activePull.noteObject)
    ) {
      return;
    }

    const interactor = this.activePull.interactor;
    if (
      interactor &&
      typeof interactor.isActive === 'function' &&
      !interactor.isActive()
    ) {
      this.finalizeReleasedPull(this.activePull.noteObject);
      return;
    }

    const position = this.getInteractorPosition(interactor, this.activePull.rayDistance);
    this.syncTrackedWrapper(this.activePull.noteObject, position);
  }

  private syncTrackedWrapper(content: SceneObject, worldPos?: vec3): void {
    const anchorSpawner = this.getAnchorNoteSpawner();
    if (!isNull(anchorSpawner)) {
      const spawner = anchorSpawner as AnchorNoteSpawner;
      if (!isNull(worldPos) && typeof spawner.placeTrackedContentAtWorld === 'function') {
        spawner.placeTrackedContentAtWorld(content, worldPos);
        return;
      }

      if (typeof spawner.syncTrackedWrapperToContent === 'function') {
        spawner.syncTrackedWrapperToContent(content);
        return;
      }
    }

    if (!isNull(worldPos)) {
      content.getTransform().setWorldPosition(worldPos);
    }
  }

  private spawnNote(worldPosition: vec3, interactor: InteractorLike | null): SceneObject | null {
    if (isNull(this.notePrefab)) {
      print('MainPostItSource needs notePrefab assigned.');
      return null;
    }

    const parent = this.getSpawnParent();
    const noteObject = this.notePrefab.instantiate(parent);
    this.noteSerial += 1;
    noteObject.name = `PostItNote_${this.noteSerial}`;
    noteObject.getTransform().setWorldPosition(this.applySpawnOffset(worldPosition, interactor));
    playInteractionSound((sounds) => sounds.playSpawnWater());
    this.debugLog(`spawned ${noteObject.name}.`);
    return noteObject;
  }

  private applySpawnOffset(worldPosition: vec3, interactor: InteractorLike | null): vec3 {
    if (Math.abs(this.spawnForwardOffset) <= 0.0001) {
      return worldPosition;
    }

    const direction =
      !isNull(interactor) && !isNull(interactor.direction)
        ? interactor.direction
        : this.getSceneObject().getTransform().forward;
    return worldPosition.add(direction.uniformScale(this.spawnForwardOffset));
  }

  private getInteractorPosition(interactor: InteractorLike | null, rayDistance: number): vec3 {
    if (interactor) {
      const startPoint = interactor.startPoint || null;
      const direction = interactor.direction || null;
      const targetHitPosition = interactor.targetHitPosition || null;
      if (interactor.activeTargetingMode === 1 && startPoint) {
        return startPoint;
      }

      if (startPoint && direction) {
        return startPoint.add(direction.uniformScale(rayDistance));
      }

      if (targetHitPosition) {
        return targetHitPosition;
      }

      if (startPoint) {
        return startPoint;
      }
    }

    return this.getSceneObject().getTransform().getWorldPosition();
  }

  private getRayDistance(interactor: InteractorLike | null): number {
    if (interactor && interactor.distanceToTarget !== null && interactor.distanceToTarget !== undefined) {
      return Math.max(0, interactor.distanceToTarget);
    }
    return Math.max(0, this.fallbackRayDistance);
  }

  private getAnchorNoteSpawner(): AnchorNoteSpawner | null {
    if (isNull(this.anchorController)) {
      return null;
    }

    const candidate = this.anchorController as unknown as AnchorNoteSpawner;
    if (typeof candidate.placeTrackedContentAtWorld === 'function') {
      return candidate;
    }

    return null;
  }

  private notifyTrashSpawnGrace(root: SceneObject, graceSeconds: number): void {
    const anchorSpawner = this.getAnchorNoteSpawner();
    if (isNull(anchorSpawner)) {
      return;
    }

    const spawner = anchorSpawner as AnchorNoteSpawner;
    if (typeof spawner.notifyTrashSpawnGrace === 'function') {
      spawner.notifyTrashSpawnGrace(root, graceSeconds);
    }
  }

  private getSpawnParent(): SceneObject {
    if (!isNull(this.spawnParent)) {
      return this.spawnParent;
    }

    const parent = this.getSceneObject().getParent();
    return !isNull(parent) ? parent : this.getSceneObject();
  }

  private getSourceInteractable(): InteractableLike {
    if (!isNull(this.sourceInteractable)) {
      return this.sourceInteractable as InteractableLike;
    }

    const scripts = this.getSceneObject().getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as InteractableLike;
      if (
        !isNull(candidate) &&
        (candidate.onInteractorTriggerStart !== undefined || candidate.onTriggerStart !== undefined) &&
        (candidate.onTriggerUpdate !== undefined ||
          candidate.onDragUpdate !== undefined ||
          candidate.onInteractorTriggerUpdate !== undefined ||
          candidate.onDragStart !== undefined)
      ) {
        return candidate;
      }
    }

    return null as unknown as InteractableLike;
  }

  private tryBindInteractable(): void {
    this.ensureSourceGrabCollider();
    if (this.isBound) {
      return;
    }

    const interactable = this.getSourceInteractable();
    if (!isNull(interactable)) {
      this.bindInteractable(interactable);
    } else {
      this.debugLog('no source Interactable found yet.');
    }

    if (this.isBound) {
      return;
    }

    this.bindAttempts++;
    if (this.bindAttempts >= 30) {
      print(
        'MainPostItSource could not bind. Assign sourceInteractable to the SIK Interactable on the post-it stack.'
      );
      return;
    }

    const retryEvent = this.createEvent('DelayedCallbackEvent');
    retryEvent.bind(() => this.tryBindInteractable());
    retryEvent.reset(0.1);
  }

  private ensureUpdateLoop(): void {
    if (!isNull(this.updateEvent)) {
      this.updateEvent.enabled = true;
      return;
    }

    this.updateEvent = this.createEvent('UpdateEvent');
    this.updateEvent.bind(() => this.updatePulledNotePosition());
    this.updateEvent.enabled = true;
  }

  private abandonActivePull(): void {
    setGardenSourceSpawnPullActive(this.getSceneObject(), false);
    this.activePull = null;
    if (!isNull(this.updateEvent)) {
      (this.updateEvent as UpdateEvent).enabled = false;
    }
  }

  private releaseActivePull(): void {
    if (isNull(this.activePull) || isNull(this.activePull.noteObject)) {
      return;
    }

    this.debugLog('released active post-it pull.');
    this.finalizeReleasedPull(this.activePull.noteObject);
  }

  private finalizeReleasedPull(releasedNote: SceneObject): void {
    this.deferEndNoteTranscriptCapture(releasedNote);
    this.abandonActivePull();

    const anchorSpawner = this.getAnchorNoteSpawner();
    if (!isNull(anchorSpawner)) {
      const spawner = anchorSpawner as AnchorNoteSpawner;
      const worldPos = releasedNote.getTransform().getWorldPosition();
      if (typeof spawner.placeTrackedContentAtWorld === 'function') {
        spawner.placeTrackedContentAtWorld(releasedNote, worldPos);
      } else if (typeof spawner.syncTrackedWrapperToContent === 'function') {
        spawner.syncTrackedWrapperToContent(releasedNote);
      }
      if (typeof spawner.setActiveManipulatedRoot === 'function') {
        spawner.setActiveManipulatedRoot(releasedNote);
      }
      this.notifyTrashSpawnGrace(releasedNote, 5);
      if (typeof spawner.saveObjectPosition === 'function') {
        spawner.saveObjectPosition();
      }
    }
  }

  private beginNoteTranscriptCapture(noteObject: SceneObject): void {
    const transcript = this.findNoteTranscript(noteObject);
    if (!isNull(transcript) && typeof transcript.beginCapture === 'function') {
      transcript.beginCapture();
      return;
    }
    this.beginFallbackTranscriptCapture(noteObject);
  }

  private endNoteTranscriptCapture(noteObject: SceneObject): void {
    const transcript = this.findNoteTranscript(noteObject);
    if (!isNull(transcript) && typeof transcript.endCapture === 'function') {
      transcript.endCapture();
      return;
    }
    this.endFallbackTranscriptCapture(noteObject);
  }

  private deferEndNoteTranscriptCapture(noteObject: SceneObject): void {
    const delaySec = Math.max(0, this.postReleaseCaptureSec);
    if (delaySec <= 0.001) {
      this.endNoteTranscriptCapture(noteObject);
      return;
    }
    const noteRef = noteObject;
    const done = this.createEvent('DelayedCallbackEvent');
    done.bind(() => this.endNoteTranscriptCapture(noteRef));
    done.reset(delaySec);
  }

  private findNoteTranscript(noteObject: SceneObject): NoteTranscriptLike | null {
    if (isNull(noteObject)) {
      return null;
    }

    const stack: SceneObject[] = [noteObject];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }

      const scripts = current.getComponents('Component.ScriptComponent');
      for (let i = 0; i < scripts.length; i++) {
        const candidate = scripts[i] as NoteTranscriptLike;
        if (
          !isNull(candidate) &&
          typeof candidate.beginCapture === 'function' &&
          typeof candidate.endCapture === 'function'
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

  private debugLog(message: string): void {
    if (!this.debugLogging) {
      return;
    }

    print(`[MainPostItSource] ${this.getSceneObject().name}: ${message}`);
  }

  private ensureSourceGrabCollider(): void {
    if (!this.enforceLargeSourceGrabCollider) {
      return;
    }

    const source = this.getSceneObject();
    let collider = source.getComponent('Physics.ColliderComponent') as ColliderComponent;
    if (isNull(collider)) {
      collider = source.getComponent('Component.ColliderComponent') as ColliderComponent;
    }
    if (isNull(collider)) {
      collider = source.createComponent('Physics.ColliderComponent') as ColliderComponent;
    }
    if (isNull(collider)) {
      collider = source.createComponent('Component.ColliderComponent') as ColliderComponent;
    }
    if (isNull(collider)) {
      return;
    }

    const bounds = this.measureSourceVisualBounds(source);
    const padding = Math.max(0, this.sourceGrabColliderPaddingCm) * 2;
    const minSize = this.sourceGrabColliderMinSize;
    const desiredWorldSize = new vec3(
      Math.max(minSize.x, bounds.x + padding),
      Math.max(minSize.y, bounds.y + padding),
      Math.max(minSize.z, bounds.z + padding)
    );

    let worldScale = source.getTransform().getWorldScale();
    if (isNull(worldScale)) {
      worldScale = vec3.one();
    }
    const sx = Math.max(0.0001, Math.abs(worldScale.x));
    const sy = Math.max(0.0001, Math.abs(worldScale.y));
    const sz = Math.max(0.0001, Math.abs(worldScale.z));
    const localSize = new vec3(
      desiredWorldSize.x / sx,
      desiredWorldSize.y / sy,
      desiredWorldSize.z / sz
    );

    const colliderLike = collider as unknown as {
      enabled?: boolean;
      intangible?: boolean;
      forceCompound?: boolean;
      fitVisual?: boolean;
      debugDrawEnabled?: boolean;
      shape?: { size?: vec3 };
    };

    colliderLike.enabled = true;
    colliderLike.intangible = false;
    colliderLike.forceCompound = false;
    colliderLike.fitVisual = false;
    colliderLike.debugDrawEnabled = false;

    const shape = Shape.createBoxShape();
    shape.size = localSize;
    colliderLike.shape = shape;
  }

  private measureSourceVisualBounds(root: SceneObject): vec3 {
    const stack: SceneObject[] = [root];
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    let found = false;

    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }
      const visuals = current.getComponents('Component.RenderMeshVisual') as RenderMeshVisual[];
      for (let i = 0; i < visuals.length; i++) {
        const visual = visuals[i];
        if (isNull(visual)) {
          continue;
        }
        const min = visual.worldAabbMin();
        const max = visual.worldAabbMax();
        minX = Math.min(minX, min.x);
        minY = Math.min(minY, min.y);
        minZ = Math.min(minZ, min.z);
        maxX = Math.max(maxX, max.x);
        maxY = Math.max(maxY, max.y);
        maxZ = Math.max(maxZ, max.z);
        found = true;
      }
      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }

    if (!found) {
      return this.sourceGrabColliderMinSize;
    }

    return new vec3(
      Math.max(0.1, maxX - minX),
      Math.max(0.1, maxY - minY),
      Math.max(0.1, maxZ - minZ)
    );
  }

  private ensureLayeredStackVisual(): void {
    if (!this.forceLayeredStackVisual) {
      return;
    }

    const root = this.getSceneObject();
    const template = this.findNamedChild(root, 'StackPad');
    if (isNull(template)) {
      return;
    }

    const templateVisual = template.getComponent('Component.RenderMeshVisual') as RenderMeshVisual;
    if (isNull(templateVisual) || isNull(templateVisual.mesh) || isNull(templateVisual.mainMaterial)) {
      return;
    }

    // Hide the chunky single slab and replace with thin layered notes.
    templateVisual.enabled = false;

    let stackRoot = this.findNamedChild(root, 'PostItStackLayers');
    if (isNull(stackRoot)) {
      stackRoot = global.scene.createSceneObject('PostItStackLayers');
      stackRoot.setParent(root);
      stackRoot.layer = root.layer;
      stackRoot.getTransform().setLocalPosition(vec3.zero());
      stackRoot.getTransform().setLocalRotation(quat.quatIdentity());
      stackRoot.getTransform().setLocalScale(vec3.one());
    }

    while (stackRoot.getChildrenCount() > 0) {
      stackRoot.getChild(0).destroy();
    }

    const baseTransform = template.getTransform();
    const basePos = baseTransform.getLocalPosition();
    const baseRot = baseTransform.getLocalRotation();
    const baseScale = baseTransform.getLocalScale();
    const count = Math.max(4, this.stackLayerCount | 0);
    const layerThickness = Math.max(0.01, this.stackLayerThickness);
    const layerGap = Math.max(0.004, this.stackLayerGap);
    const spread = Math.max(0, this.stackLayerOffsetSpread);

    for (let i = 0; i < count; i++) {
      const layer = global.scene.createSceneObject(`PostItLayer_${i}`);
      layer.setParent(stackRoot);
      layer.layer = root.layer;

      const zigX = ((i % 3) - 1) * spread;
      const zigZ = (((i + 1) % 3) - 1) * spread;
      layer
        .getTransform()
        .setLocalPosition(new vec3(basePos.x + zigX, basePos.y - i * layerGap, basePos.z + zigZ));
      layer.getTransform().setLocalRotation(baseRot);
      layer
        .getTransform()
        .setLocalScale(new vec3(baseScale.x, layerThickness, baseScale.z));

      const visual = layer.createComponent('Component.RenderMeshVisual') as RenderMeshVisual;
      visual.mesh = templateVisual.mesh as RenderMesh;
      visual.mainMaterial = templateVisual.mainMaterial as Material;
      visual.renderOrder = templateVisual.renderOrder;
    }

    this.debugLog(`layered stack visual rebuilt (${count} layers).`);
  }

  private beginFallbackTranscriptCapture(noteObject: SceneObject): void {
    const speech = this.getSpeech();
    if (isNull(speech)) {
      print(`[MainPostItSource] ${noteObject.name} transcript unavailable: no SpeechRecognition`);
      return;
    }

    let capture = this.findFallbackCapture(noteObject);
    if (isNull(capture)) {
      const visual = this.ensureFallbackNoteTextVisual(noteObject);
      const listener = (text: string, _isFinal: boolean): void => {
        const entry = this.findFallbackCapture(noteObject);
        if (isNull(entry) || entry.owners <= 0 || isNull(entry.noteText)) {
          return;
        }
        const cleaned = String(text || '').trim();
        if (!cleaned) {
          return;
        }
        const content = this.truncateFallbackTranscript(cleaned);
        (entry.noteText as Text3D).text = content;
        if (!isNull(entry.noteRoot)) {
          (entry.noteRoot as SceneObject).enabled = true;
        }
      };

      capture = {
        noteObject: noteObject,
        noteRoot: visual.root,
        noteText: visual.text,
        listener: listener,
        owners: 0,
      };
      this.fallbackCaptures.push(capture);
      speech.addTranscriptListener(listener);
    }

    capture.owners += 1;
    speech.beginPostItCapture();
    speech.clearUtteranceState();
    speech.requestListening();
    this.debugLog(`fallback transcript capture ON for ${noteObject.name}`);
  }

  private endFallbackTranscriptCapture(noteObject: SceneObject): void {
    const speech = this.getSpeech();
    const capture = this.findFallbackCapture(noteObject);
    if (isNull(speech) || isNull(capture)) {
      return;
    }

    capture.owners = Math.max(0, capture.owners - 1);
    if (capture.owners > 0) {
      return;
    }

    speech.removeTranscriptListener(capture.listener);
    speech.endPostItCapture();
    this.removeFallbackCapture(noteObject);
    this.debugLog(`fallback transcript capture OFF for ${noteObject.name}`);
  }

  private getSpeech(): SpeechRecognition | null {
    if (!isNull(this.sharedSpeech)) {
      return this.sharedSpeech;
    }
    this.sharedSpeech = getSharedSpeechRecognition();
    return this.sharedSpeech;
  }

  private findFallbackCapture(noteObject: SceneObject): FallbackTranscriptCapture | null {
    for (let i = 0; i < this.fallbackCaptures.length; i++) {
      const entry = this.fallbackCaptures[i];
      if (entry.noteObject === noteObject) {
        return entry;
      }
    }
    return null;
  }

  private removeFallbackCapture(noteObject: SceneObject): void {
    const next: FallbackTranscriptCapture[] = [];
    for (let i = 0; i < this.fallbackCaptures.length; i++) {
      if (this.fallbackCaptures[i].noteObject !== noteObject) {
        next.push(this.fallbackCaptures[i]);
      }
    }
    this.fallbackCaptures = next;
  }

  private ensureFallbackNoteTextVisual(noteObject: SceneObject): {root: SceneObject | null; text: Text3D | null} {
    const existing = this.findNamedChild(noteObject, 'FallbackNoteText');
    if (!isNull(existing)) {
      const existingText = existing.getComponent('Component.Text3D') as Text3D;
      return {root: existing, text: isNull(existingText) ? null : existingText};
    }

    const localScale = noteObject.getTransform().getLocalScale();
    const invX = 1 / Math.max(0.001, Math.abs(localScale.x));
    const invY = 1 / Math.max(0.001, Math.abs(localScale.y));
    const invZ = 1 / Math.max(0.001, Math.abs(localScale.z));

    const root = global.scene.createSceneObject('FallbackNoteText');
    root.setParent(noteObject);
    root.layer = noteObject.layer;
    root.enabled = false;
    root.getTransform().setLocalPosition(new vec3(0, 0.55, 0));
    root.getTransform().setLocalRotation(quat.fromEulerAngles(-Math.PI * 0.5, 0, 0));
    root.getTransform().setLocalScale(new vec3(invX, invZ, invY));

    const text = root.createComponent('Component.Text3D') as Text3D;
    text.enabled = true;
    text.text = '';
    text.size = 24;
    text.extrusionDepth = 0.08;
    text.horizontalAlignment = HorizontalAlignment.Center;
    text.verticalAlignment = VerticalAlignment.Center;
    text.horizontalOverflow = HorizontalOverflow.Wrap;
    text.verticalOverflow = VerticalOverflow.Overflow;
    text.worldSpaceRect = Rect.create(-3.6, 3.6, -3.2, 3.2);
    text.renderOrder = 12;

    return {root: root, text: text};
  }

  private findNamedChild(parent: SceneObject, targetName: string): SceneObject | null {
    const stack: SceneObject[] = [parent];
    while (stack.length > 0) {
      const current = stack.pop();
      if (isNull(current)) {
        continue;
      }
      if (String(current.name) === targetName) {
        return current;
      }
      for (let i = 0; i < current.getChildrenCount(); i++) {
        stack.push(current.getChild(i));
      }
    }
    return null;
  }

  private truncateFallbackTranscript(text: string): string {
    const maxChars = 140;
    if (text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, maxChars - 1)}…`;
  }
}

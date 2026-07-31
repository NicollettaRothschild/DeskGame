import { playInteractionSound } from './InteractionSoundRegistry';
import {
  shouldBlockGardenSourceSpawn,
  setGardenSourceSpawnPullActive,
} from './GardenSourceSpawnGuard';
import { scheduleDeferredDestroy } from './FlowGardenDestroyHooks';

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
  postReleaseCaptureSec: number = 6;

  private activePull: PullState | null = null;
  private updateEvent: UpdateEvent | null = null;
  private bindAttempts = 0;
  private isBound = false;
  private spawnSuppressed = false;
  private noteSerial = 0;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => this.tryBindInteractable());
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
    if (isNull(transcript) || typeof transcript.beginCapture !== 'function') {
      print(
        `[MainPostItSource] ${noteObject.name} missing PostItNoteTranscript (capture unavailable)`
      );
      return;
    }
    transcript.beginCapture();
  }

  private endNoteTranscriptCapture(noteObject: SceneObject): void {
    const transcript = this.findNoteTranscript(noteObject);
    if (isNull(transcript) || typeof transcript.endCapture !== 'function') {
      return;
    }
    transcript.endCapture();
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
}

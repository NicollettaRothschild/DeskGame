import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import { InteractableManipulation } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation';
import { ArvisGhostSpeechBubble } from './ArvisGhostSpeechBubble';
import { FlowGardenTTS } from './FlowGardenTTS';
import { getSharedFlowGardenTts } from './FlowGardenServiceRegistry';

type InteractableLike = ScriptComponent & {
  targetingMode?: number;
  ignoreInteractionPlane?: boolean;
  keepHoverOnTrigger?: boolean;
  enableInstantDrag?: boolean;
  onDragStart?: { add: (cb: () => void) => void };
  onDragEnd?: { add: (cb: () => void) => void };
  onTriggerEnd?: { add: (cb: () => void) => void };
  onTriggerEndOutside?: { add: (cb: () => void) => void };
  onInteractorTriggerEnd?: { add: (cb: () => void) => void };
  onInteractorTriggerEndOutside?: { add: (cb: () => void) => void };
  onHoverEnter?: { add: (cb: () => void) => void };
  onInteractorHoverEnter?: { add: (cb: () => void) => void };
};

type InteractableManipulationLike = ScriptComponent & {
  manipulateRootSceneObject?: SceneObject;
  enableTranslation?: boolean;
  enableRotation?: boolean;
  enableScale?: boolean;
  useFilter?: boolean;
  onManipulationStart?: { add: (cb: () => void) => void };
  onManipulationEnd?: { add: (cb: () => void) => void };
};

/**
 * Makes the Friend scene object pinch-grabbable and movable,
 * with grab/release sounds, speech bubble, TTS, proximity look-at, and idle bob.
 */
@component
export class FriendGrab extends BaseScriptComponent {
  @input
  debugLogging: boolean = false;

  @input
  colliderSize: vec3 = new vec3(1.5, 2.2, 1.5);

  @input
  @allowUndefined
  grabSoundTrack!: AudioTrackAsset;

  @input
  @allowUndefined
  releaseSoundTrack!: AudioTrackAsset;

  @input('float')
  grabSoundVolume: number = 0.85;

  @input('float')
  releaseSoundVolume: number = 0.8;

  @input
  enableGrabSounds: boolean = true;

  @input
  enableSpeechBubble: boolean = true;

  @input
  enableTts: boolean = true;

  @input
  @allowUndefined
  agentTts!: FlowGardenTTS;

  @input
  grabBubbleText: string = 'Whee!';

  @input
  releaseBubbleText: string = 'Thanks!';

  @input('float')
  speechBubbleHideDelaySec: number = 4;

  @input('float')
  bubbleScaleCompensation: number = 3.0;

  /** Local Y above Friend — raise if the bubble sits in the mesh. */
  @input('float')
  bubbleHeightOffset: number = 5.0;

  @input('float')
  bubbleForwardOffset: number = 0.15;

  @input
  enableLookAt: boolean = true;

  /** Distance (meters) at which Friend starts facing the user. */
  @input('float')
  lookAtDistanceMeters: number = 0.2;

  /** Extra meters beyond lookAtDistance before look-at turns off (reduces flicker). */
  @input('float')
  lookAtExitPaddingMeters: number = 0.05;

  /** How quickly Friend turns toward the user (higher = snappier). */
  @input('float')
  lookAtTurnSpeed: number = 6.0;

  @input
  enableIdleBob: boolean = true;

  /** Vertical bob amplitude in centimeters. */
  @input('float')
  idleBobAmplitudeCm: number = 1.5;

  /** Angular speed for idle bob (higher = faster). */
  @input('float')
  idleBobSpeed: number = 1.8;

  private grabInteractable: InteractableLike | null = null;
  private grabManipulation: InteractableManipulationLike | null = null;
  private moveInteractionWired = false;
  private moveBindAttempts = 0;
  private moveActive = false;
  private grabAudioPlayer: AudioComponent | null = null;
  private resolvedGrabTrack: AudioTrackAsset | null = null;
  private resolvedReleaseTrack: AudioTrackAsset | null = null;
  private speechBubble: ArvisGhostSpeechBubble | null = null;
  private lookAt: LookAtComponent | null = null;
  private lookAtCamera: SceneObject | null = null;
  private lookAtActive = false;
  private idleBaseLocalPos: vec3 | null = null;
  private lookAtDistanceLogTimer = 0;
  private lookAtLoggedSetup = false;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => {
      this.captureIdleBasePosition();
      this.ensureFriendSounds();
      this.ensureSpeechBubble();
      this.resolveTts();
      this.ensureLookAt();
      this.tryWireMoveInteraction();
      if (this.debugLogging) {
        print(
          `[FriendGrab] ready tts=${!isNull(this.resolveTts())} bubble=${this.enableSpeechBubble} lookAt=${this.enableLookAt} bob=${this.enableIdleBob}`
        );
      }
    });

    this.createEvent('LateUpdateEvent').bind(() => {
      this.updateProximityLookAt();
      this.updateIdleBob();
      this.syncSpeechBubble();
    });

    this.scheduleGrabWireRetry(0.25);
    this.scheduleGrabWireRetry(0.75);
  }

  public showSpeech(text: string, speak: boolean = true): void {
    const message = String(text || '').trim();
    if (!message) {
      this.hideSpeechBubble();
      return;
    }

    if (this.enableSpeechBubble) {
      this.ensureSpeechBubble();
      if (!isNull(this.speechBubble)) {
        this.speechBubble.showAgentChat('reply', '', message, 'Friend');
      }
    }

    if (speak && this.enableTts) {
      this.speakText(message);
    }
  }

  public hideSpeechBubble(): void {
    if (!isNull(this.speechBubble)) {
      this.speechBubble.hide();
    }
  }

  private resolveTts(): FlowGardenTTS | null {
    if (!isNull(this.agentTts)) {
      return this.agentTts;
    }
    this.agentTts = getSharedFlowGardenTts();
    return this.agentTts;
  }

  private speakText(text: string): void {
    const tts = this.resolveTts();
    if (isNull(tts)) {
      if (this.debugLogging) {
        print('[FriendGrab] TTS unavailable (FlowGardenTTS not registered)');
      }
      return;
    }

    tts.speak(text, (ok) => {
      if (this.debugLogging) {
        print(`[FriendGrab] TTS ${ok ? 'played' : 'failed'}: ${text}`);
      }
    });
  }

  private scheduleGrabWireRetry(delaySec: number): void {
    const retryEvent = this.createEvent('DelayedCallbackEvent');
    retryEvent.bind(() => {
      if (!this.moveInteractionWired) {
        this.tryWireMoveInteraction();
      } else {
        this.refreshGrabCollider();
      }
    });
    retryEvent.reset(delaySec);
  }

  private ensureAnchorGrabComponents(): void {
    const anchor = this.getSceneObject();
    this.refreshGrabCollider();

    let interactable = this.findExistingInteractable(anchor);
    if (isNull(interactable)) {
      interactable = anchor.createComponent(Interactable.getTypeName()) as InteractableLike;
    }

    let manipulation = this.findExistingManipulation(anchor);
    if (isNull(manipulation)) {
      manipulation = anchor.createComponent(
        InteractableManipulation.getTypeName()
      ) as unknown as InteractableManipulationLike;
    }

    interactable.targetingMode = 7;
    interactable.ignoreInteractionPlane = true;
    interactable.keepHoverOnTrigger = true;
    interactable.enableInstantDrag = true;

    manipulation.manipulateRootSceneObject = anchor;
    manipulation.enableTranslation = true;
    manipulation.enableRotation = false;
    manipulation.enableScale = false;
    manipulation.useFilter = false;

    this.grabInteractable = interactable;
    this.grabManipulation = manipulation;
  }

  private findExistingInteractable(root: SceneObject): InteractableLike | null {
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as InteractableLike;
      if (
        !isNull(candidate) &&
        candidate.targetingMode !== undefined &&
        (candidate.onDragStart !== undefined ||
          candidate.onTriggerEnd !== undefined ||
          candidate.onInteractorTriggerEnd !== undefined)
      ) {
        return candidate;
      }
    }
    return null;
  }

  private findExistingManipulation(root: SceneObject): InteractableManipulationLike | null {
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as unknown as InteractableManipulationLike;
      if (!isNull(candidate) && candidate.manipulateRootSceneObject !== undefined) {
        return candidate;
      }
    }
    return null;
  }

  private tryWireMoveInteraction(): void {
    if (this.moveInteractionWired) {
      return;
    }

    this.ensureAnchorGrabComponents();
    const interactable = this.grabInteractable;
    const manipulation = this.grabManipulation;
    if (isNull(interactable) || isNull(manipulation)) {
      this.moveBindAttempts++;
      if (this.moveBindAttempts >= 30) {
        print('[FriendGrab] could not bind grab interaction');
        return;
      }

      const retryEvent = this.createEvent('DelayedCallbackEvent');
      retryEvent.bind(() => this.tryWireMoveInteraction());
      retryEvent.reset(0.1);
      return;
    }

    this.refreshGrabCollider();
    this.bindManipulationRoot(manipulation, this.getSceneObject());

    const onGrabStart = (): void => {
      this.onFriendGrabStart();
    };
    const onGrabRelease = (): void => {
      this.onFriendGrabRelease();
    };

    if (manipulation.onManipulationStart) {
      manipulation.onManipulationStart.add(onGrabStart);
    }
    if (manipulation.onManipulationEnd) {
      manipulation.onManipulationEnd.add(onGrabRelease);
    }
    if (interactable.onDragStart) {
      interactable.onDragStart.add(onGrabStart);
    }
    if (interactable.onDragEnd) {
      interactable.onDragEnd.add(onGrabRelease);
    }
    if (interactable.onTriggerEnd) {
      interactable.onTriggerEnd.add(onGrabRelease);
    }
    if (interactable.onTriggerEndOutside) {
      interactable.onTriggerEndOutside.add(onGrabRelease);
    }
    if (interactable.onInteractorTriggerEnd) {
      interactable.onInteractorTriggerEnd.add(onGrabRelease);
    }
    if (interactable.onInteractorTriggerEndOutside) {
      interactable.onInteractorTriggerEndOutside.add(onGrabRelease);
    }

    if (this.debugLogging) {
      if (interactable.onHoverEnter) {
        interactable.onHoverEnter.add(() => print('[FriendGrab] hover enter'));
      }
      if (interactable.onInteractorHoverEnter) {
        interactable.onInteractorHoverEnter.add(() => print('[FriendGrab] hover enter'));
      }
    }

    (manipulation as ScriptComponent).enabled = true;
    (interactable as ScriptComponent).enabled = true;

    this.moveInteractionWired = true;
    print('[FriendGrab] grab interaction wired');
  }

  private onFriendGrabStart(): void {
    if (this.moveActive) {
      return;
    }
    this.moveActive = true;
    this.resetIdleBobOffset();
    this.playFriendSound(this.resolvedGrabTrack, this.grabSoundVolume, 'grab');
    if (this.grabBubbleText) {
      this.showSpeech(this.grabBubbleText);
    }
    if (this.debugLogging) {
      print('[FriendGrab] grab start');
    }
  }

  private onFriendGrabRelease(): void {
    if (!this.moveActive) {
      return;
    }
    this.moveActive = false;
    this.captureIdleBasePosition();
    this.playFriendSound(this.resolvedReleaseTrack, this.releaseSoundVolume, 'release');
    if (this.releaseBubbleText) {
      this.showSpeech(this.releaseBubbleText);
    }
    if (this.debugLogging) {
      print('[FriendGrab] grab end');
    }
  }

  private ensureFriendSounds(): void {
    if (!this.enableGrabSounds) {
      return;
    }

    this.resolvedGrabTrack = this.resolveSoundTrack(
      this.grabSoundTrack,
      'Audio/arvis_grab.wav'
    );
    this.resolvedReleaseTrack = this.resolveSoundTrack(
      this.releaseSoundTrack,
      'Audio/arvis_release.wav'
    );
    this.grabAudioPlayer = this.ensureGrabAudioPlayer();

    if (this.debugLogging) {
      print(
        `[FriendGrab] sounds grab=${!isNull(this.resolvedGrabTrack)} release=${!isNull(this.resolvedReleaseTrack)}`
      );
    }
  }

  private ensureGrabAudioPlayer(): AudioComponent | null {
    const anchor = this.getSceneObject();
    let player = anchor.getComponent('Component.AudioComponent') as AudioComponent;
    if (isNull(player)) {
      player = anchor.createComponent('Component.AudioComponent') as AudioComponent;
    }

    try {
      const configured = player as AudioComponent & {
        playbackMode?: number;
        spatialAudio?: {
          enabled?: boolean;
          distanceEffect?: { enabled?: boolean; minDistance?: number; maxDistance?: number };
        };
      };

      if (typeof configured.playbackMode !== 'undefined') {
        configured.playbackMode = Audio.PlaybackMode.LowLatency;
      }

      const spatial = configured.spatialAudio;
      if (!isNull(spatial)) {
        if (typeof spatial.enabled !== 'undefined') {
          spatial.enabled = true;
        }
        const distance = spatial.distanceEffect;
        if (!isNull(distance)) {
          if (typeof distance.enabled !== 'undefined') {
            distance.enabled = true;
          }
          if (typeof distance.minDistance !== 'undefined') {
            distance.minDistance = 5;
          }
          if (typeof distance.maxDistance !== 'undefined') {
            distance.maxDistance = 500;
          }
        }
      }
    } catch (e) {
      if (this.debugLogging) {
        print('[FriendGrab] audio extras unavailable in preview: ' + e);
      }
    }

    return player;
  }

  private resolveSoundTrack(
    assigned: AudioTrackAsset | null | undefined,
    assetPath: string
  ): AudioTrackAsset | null {
    if (!isNull(assigned)) {
      return assigned;
    }

    const candidates = [assetPath, assetPath.replace(/^Audio\//, '')];
    for (let i = 0; i < candidates.length; i++) {
      try {
        return requireAsset(candidates[i]) as AudioTrackAsset;
      } catch {
        // try next path variant
      }
    }

    if (this.debugLogging) {
      print(`[FriendGrab] missing sound asset ${assetPath}`);
    }
    return null;
  }

  private playFriendSound(
    track: AudioTrackAsset | null,
    volume: number,
    label: 'grab' | 'release'
  ): void {
    if (!this.enableGrabSounds || isNull(track)) {
      return;
    }

    if (isNull(this.grabAudioPlayer)) {
      this.grabAudioPlayer = this.ensureGrabAudioPlayer();
    }
    if (isNull(this.grabAudioPlayer)) {
      return;
    }

    const player = this.grabAudioPlayer as AudioComponent & {
      volume?: number;
      isPlaying?: () => boolean;
      stop?: (fade: boolean) => void;
    };

    if (typeof player.volume === 'number') {
      player.volume = Math.max(0, Math.min(1, volume));
    }

    player.audioTrack = track;
    if (typeof player.isPlaying === 'function' && player.isPlaying()) {
      player.stop!(false);
    }
    player.play(1);

    if (this.debugLogging) {
      print(`[FriendGrab] sfx ${label}`);
    }
  }

  private ensureSpeechBubble(): void {
    if (!this.enableSpeechBubble || !isNull(this.speechBubble)) {
      return;
    }

    // Parent to the friend root (not Body mesh) so height is measured from the character pivot.
    const followRoot = this.getSceneObject();
    this.speechBubble = new ArvisGhostSpeechBubble(followRoot, this, {
      scaleCompensation: Math.max(0.1, this.bubbleScaleCompensation),
      maxCharacters: 88,
      hideDelaySec: this.speechBubbleHideDelaySec,
      debugLogging: this.debugLogging,
      bubbleBaseY: this.bubbleHeightOffset,
      bubbleBaseZ: this.bubbleForwardOffset,
    });
  }

  private captureIdleBasePosition(): void {
    const pos = this.getSceneObject().getTransform().getLocalPosition();
    this.idleBaseLocalPos = new vec3(pos.x, pos.y, pos.z);
  }

  private resetIdleBobOffset(): void {
    if (isNull(this.idleBaseLocalPos)) {
      this.captureIdleBasePosition();
      return;
    }
    const transform = this.getSceneObject().getTransform();
    const current = transform.getLocalPosition();
    transform.setLocalPosition(
      new vec3(current.x, this.idleBaseLocalPos.y, current.z)
    );
  }

  private updateIdleBob(): void {
    if (!this.enableIdleBob || this.moveActive) {
      return;
    }

    if (isNull(this.idleBaseLocalPos)) {
      this.captureIdleBasePosition();
      if (isNull(this.idleBaseLocalPos)) {
        return;
      }
    }

    const amplitude = Math.max(0, this.idleBobAmplitudeCm);
    if (amplitude <= 0) {
      return;
    }

    const speed = Math.max(0.05, this.idleBobSpeed);
    const bobY = Math.sin(getTime() * speed) * amplitude;
    const base = this.idleBaseLocalPos;
    const transform = this.getSceneObject().getTransform();
    const current = transform.getLocalPosition();

    // Keep X/Z from the live transform (look-at / parenting), bob only Y from base.
    transform.setLocalPosition(new vec3(current.x, base.y + bobY, current.z));
    this.idleBaseLocalPos = new vec3(current.x, base.y, current.z);
  }

  private syncSpeechBubble(): void {
    if (!this.enableSpeechBubble || isNull(this.speechBubble)) {
      return;
    }
    this.speechBubble.syncToGhostBody(
      this.getSceneObject(),
      {
        scrollSpeed: 0,
        noiseScale: 1,
        offsetAmount: 0,
        tweakN11: 0,
        tweakN6: 0,
      },
      false,
      1
    );
  }

  private ensureLookAt(): void {
    if (isNull(this.lookAtCamera)) {
      this.lookAtCamera = this.findCameraObject();
    }
    if (isNull(this.lookAtCamera)) {
      print('[FriendGrab] look-at skipped: Camera Object not found');
      return;
    }

    const anchor = this.getSceneObject();
    let lookAt = anchor.getComponent('Component.LookAtComponent') as LookAtComponent;
    if (isNull(lookAt)) {
      lookAt = anchor.createComponent('Component.LookAtComponent') as LookAtComponent;
    }

    lookAt.target = this.lookAtCamera;
    lookAt.lookAtMode = LookAtComponent.LookAtMode.LookAtPoint;
    // Confirmed correct for Friend mesh (+Z toward viewer).
    lookAt.aimVectors = LookAtComponent.AimVectors.ZAimYUp;
    lookAt.worldUpVector = LookAtComponent.WorldUpVector.SceneY;
    lookAt.enabled = false;

    this.lookAt = lookAt;
  }

  private updateProximityLookAt(): void {
    if (!this.enableLookAt) {
      this.setLookAtActive(false);
      return;
    }

    if (isNull(this.lookAt) || isNull(this.lookAtCamera)) {
      this.ensureLookAt();
      if (isNull(this.lookAt) || isNull(this.lookAtCamera)) {
        return;
      }
    }

    // Always keep component config correct; never leave it enabled by accident.
    this.lookAt.target = this.lookAtCamera;
    this.lookAt.aimVectors = LookAtComponent.AimVectors.ZAimYUp;

    const friendPos = this.getSceneObject().getTransform().getWorldPosition();
    const cameraPos = this.lookAtCamera.getTransform().getWorldPosition();
    const dx = cameraPos.x - friendPos.x;
    const dz = cameraPos.z - friendPos.z;
    const distanceCm = Math.sqrt(dx * dx + dz * dz);

    const enterCm = Math.max(0.05, this.lookAtDistanceMeters) * 100.0;
    const exitCm = enterCm + Math.max(0, this.lookAtExitPaddingMeters) * 100.0;

    if (!this.lookAtLoggedSetup) {
      this.lookAtLoggedSetup = true;
      print(
        `[FriendGrab] look-at setup dist=${distanceCm.toFixed(1)}cm threshold=${enterCm.toFixed(0)}cm camera=${this.lookAtCamera.name}`
      );
    }

    this.lookAtDistanceLogTimer += getDeltaTime();
    if (this.debugLogging && this.lookAtDistanceLogTimer >= 1.5) {
      this.lookAtDistanceLogTimer = 0;
      print(
        `[FriendGrab] look-at dist=${distanceCm.toFixed(1)}cm active=${this.lookAtActive} (on<=${enterCm.toFixed(0)} off>${exitCm.toFixed(0)})`
      );
    }

    if (this.lookAtActive) {
      if (distanceCm > exitCm) {
        this.setLookAtActive(false);
      } else {
        // Re-assert enabled every frame while in range.
        this.lookAt.enabled = true;
      }
    } else if (distanceCm <= enterCm) {
      this.setLookAtActive(true);
    } else {
      this.lookAt.enabled = false;
    }
  }

  private setLookAtActive(active: boolean): void {
    if (this.lookAtActive === active) {
      if (!isNull(this.lookAt)) {
        this.lookAt.enabled = active;
      }
      return;
    }

    this.lookAtActive = active;

    if (active) {
      if (!isNull(this.lookAt)) {
        this.lookAt.enabled = true;
      }
      print('[FriendGrab] look-at ON');
      return;
    }

    // Freeze at the last facing — do not snap back to the original pose.
    if (!isNull(this.lookAt)) {
      this.lookAt.enabled = false;
    }
    print('[FriendGrab] look-at OFF');
  }

  private findCameraObject(): SceneObject | null {
    const preferredNames = ['Camera Object', 'Camera', 'Device Camera'];
    for (let i = 0; i < preferredNames.length; i++) {
      const found = this.findObjectByNameInScene(preferredNames[i]);
      if (!isNull(found)) {
        return found;
      }
    }
    return this.findObjectWithCameraComponent();
  }

  private findObjectByNameInScene(name: string): SceneObject | null {
    const count = global.scene.getRootObjectsCount();
    for (let i = 0; i < count; i++) {
      const root = global.scene.getRootObject(i);
      const found = this.findObjectByName(root, name);
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findObjectWithCameraComponent(): SceneObject | null {
    const count = global.scene.getRootObjectsCount();
    for (let i = 0; i < count; i++) {
      const root = global.scene.getRootObject(i);
      const found = this.findCameraComponentRecursive(root);
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findCameraComponentRecursive(node: SceneObject): SceneObject | null {
    if (isNull(node)) {
      return null;
    }
    const cam = node.getComponent('Component.Camera') as Camera;
    if (!isNull(cam)) {
      return node;
    }
    for (let i = 0; i < node.getChildrenCount(); i++) {
      const found = this.findCameraComponentRecursive(node.getChild(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findObjectByName(node: SceneObject, name: string): SceneObject | null {
    if (isNull(node)) {
      return null;
    }
    if (String(node.name) === name) {
      return node;
    }

    for (let i = 0; i < node.getChildrenCount(); i++) {
      const child = node.getChild(i);
      const found = this.findObjectByName(child, name);
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private refreshGrabCollider(): void {
    this.ensureAnchorGrabCollider(this.getSceneObject());
  }

  private ensureAnchorGrabCollider(anchor: SceneObject): ColliderComponent | null {
    let collider = anchor.getComponent('Physics.ColliderComponent') as ColliderComponent;
    if (isNull(collider)) {
      collider = anchor.getComponent('Component.ColliderComponent') as ColliderComponent;
    }
    if (isNull(collider)) {
      collider = anchor.createComponent('Physics.ColliderComponent') as ColliderComponent;
    }
    if (isNull(collider)) {
      collider = anchor.createComponent('Component.ColliderComponent') as ColliderComponent;
    }

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
    shape.size = this.colliderSize;
    colliderLike.shape = shape;

    return collider;
  }

  private bindManipulationRoot(
    manipulation: InteractableManipulationLike,
    anchor: SceneObject
  ): void {
    manipulation.manipulateRootSceneObject = anchor;

    const manipRecord = manipulation as unknown as Record<string, unknown>;
    const setRoot = manipRecord['setManipulateRoot'];
    if (typeof setRoot === 'function') {
      (setRoot as (this: unknown, root: Transform) => void).call(
        manipulation,
        anchor.getTransform()
      );
      return;
    }

    const component = manipulation as ScriptComponent;
    const wasEnabled = component.enabled;
    component.enabled = false;
    component.enabled = wasEnabled;
  }
}

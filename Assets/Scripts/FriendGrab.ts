import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import { InteractableManipulation } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation';
import { ArvisGhostSpeechBubble } from './ArvisGhostSpeechBubble';
import { estimateSpeechDurationSec, FlowGardenTTS } from './FlowGardenTTS';
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

  /**
   * When on, Friend hides desk props and reveals them one-by-one with a short lesson.
   * Toggle off in the Inspector once players know the ropes.
   */
  @input
  @label('Enable Onboarding')
  @hint('Friend reveals desk objects one at a time and explains grab / release')
  enableOnboarding: boolean = false;

  @input('float')
  @label('Onboarding Start Delay (sec)')
  onboardingStartDelaySec: number = 2.5;

  @input('float')
  @label('Onboarding Gap (sec)')
  onboardingGapSec: number = 0.6;

  @input('float')
  @label('Practice Timeout (sec)')
  @hint('Auto-advance if the player does not grab/release in time')
  onboardingPracticeTimeoutSec: number = 14;

  @input
  @label('Require Grab Practice')
  @hint('Wait for grab+release on movable desk props before revealing the next')
  onboardingRequirePractice: boolean = true;

  @input
  @label('Welcome Line')
  onboardingWelcomeLine: string =
    "Hi! I'm your desk buddy. I'll show you the desk one piece at a time.";

  @input
  @label('Closing Line')
  onboardingClosingLine: string =
    "You're all set! Say hey Arvis if you need help. Have fun!";

  @input
  @allowUndefined
  @label('Tour Globe')
  onboardingGlobe!: SceneObject;

  @input
  @label('Globe Line')
  onboardingGlobeLine: string =
    "Here's the globe. Pinch to grab it, move it, then release.";

  @input
  @allowUndefined
  @label('Tour Clock')
  onboardingClock!: SceneObject;

  @input
  @label('Clock Line')
  onboardingClockLine: string =
    "Here's the clock. Grab it, move it, then let go.";

  @input
  @allowUndefined
  @label('Tour Palette')
  onboardingPalette!: SceneObject;

  @input
  @label('Palette Line')
  onboardingPaletteLine: string =
    "Here's the palette. Grab and release to place it where you like.";

  @input
  @allowUndefined
  @label('Tour Planter')
  onboardingPlanter!: SceneObject;

  @input
  @label('Planter Line')
  onboardingPlanterLine: string =
    "Here's the planter stack. Pinch it to grab a pot for your garden.";

  @input
  @allowUndefined
  @label('Tour Post-its')
  onboardingPostIt!: SceneObject;

  @input
  @label('Post-it Line')
  onboardingPostItLine: string =
    "Here's the sticky notes. Pull one and speak — your words appear on it.";

  @input
  @allowUndefined
  @label('Tour Trash')
  onboardingTrash!: SceneObject;

  @input
  @label('Trash Line')
  onboardingTrashLine: string =
    "Here's the trash. Drop things into it to clean up.";

  @input
  @allowUndefined
  agentTts!: FlowGardenTTS;

  /** Fallback voice clip when cloud/native TTS is unavailable (Specs preview). */
  @input
  @allowUndefined
  grabSpeechTrack!: AudioTrackAsset;

  @input
  @allowUndefined
  releaseSpeechTrack!: AudioTrackAsset;

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
  private onboardingActive = false;
  private onboardingToken = 0;
  private onboardingPracticeDone = false;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => {
      this.captureIdleBasePosition();
      this.ensureFriendSounds();
      this.ensureSpeechBubble();
      this.resolveTts();
      this.ensureLookAt();
      this.tryWireMoveInteraction();
      this.scheduleOnboarding();
      if (this.debugLogging) {
        print(
          `[FriendGrab] ready tts=${!isNull(this.resolveTts())} bubble=${this.enableSpeechBubble} lookAt=${this.enableLookAt} bob=${this.enableIdleBob} onboarding=${this.enableOnboarding}`
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

  public showSpeech(
    text: string,
    speak: boolean = true,
    fallbackTrack: AudioTrackAsset | null = null
  ): void {
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
      this.speakText(message, fallbackTrack);
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

  private speakText(text: string, fallbackTrack: AudioTrackAsset | null = null): void {
    const tts = this.resolveTts();
    if (isNull(tts)) {
      print('[FriendGrab] TTS unavailable (FlowGardenTTS not registered) — trying phrase clip');
      this.playPhraseFallback(fallbackTrack, text);
      return;
    }

    tts.speak(text, (ok) => {
      if (!ok) {
        print(`[FriendGrab] TTS failed for "${text}" — trying phrase clip`);
        this.playPhraseFallback(fallbackTrack, text);
        return;
      }
      if (this.debugLogging) {
        print(`[FriendGrab] TTS played: ${text}`);
      }
    });
  }

  private playPhraseFallback(track: AudioTrackAsset | null, label: string): void {
    const resolved =
      track ||
      this.resolveSoundTrack(
        null,
        label.toLowerCase().indexOf('thank') >= 0
          ? 'Audio/friend_thanks.wav'
          : 'Audio/friend_whee.wav'
      );
    if (isNull(resolved)) {
      print(`[FriendGrab] no phrase clip for "${label}"`);
      return;
    }
    this.playFriendSound(resolved, this.grabSoundVolume, 'grab');
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
    // Don't interrupt the onboarding tour with grab quips.
    if (!this.onboardingActive && this.grabBubbleText) {
      this.showSpeech(this.grabBubbleText, true, this.grabSpeechTrack);
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
    if (!this.onboardingActive && this.releaseBubbleText) {
      this.showSpeech(this.releaseBubbleText, true, this.releaseSpeechTrack);
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
      maxCharacters: 120,
      hideDelaySec: Math.max(
        this.speechBubbleHideDelaySec,
        this.enableOnboarding ? 10 : this.speechBubbleHideDelaySec
      ),
      debugLogging: this.debugLogging,
      bubbleBaseY: this.bubbleHeightOffset,
      bubbleBaseZ: this.bubbleForwardOffset,
    });
  }

  private getOnboardingTourSteps(): Array<{
    key: string;
    object: SceneObject | null;
    line: string;
    requirePractice: boolean;
  }> {
    const resolve = (
      assigned: SceneObject | null | undefined,
      fallbackName: string
    ): SceneObject | null => {
      if (!isNull(assigned)) {
        return assigned;
      }
      return this.findObjectByNameInScene(fallbackName);
    };

    return [
      {
        key: 'globe',
        object: resolve(this.onboardingGlobe, 'Globe'),
        line: this.onboardingGlobeLine,
        requirePractice: true,
      },
      {
        key: 'clock',
        object: resolve(this.onboardingClock, 'Clock'),
        line: this.onboardingClockLine,
        requirePractice: true,
      },
      {
        key: 'palette',
        object: resolve(this.onboardingPalette, 'palette'),
        line: this.onboardingPaletteLine,
        requirePractice: true,
      },
      {
        key: 'planter',
        object: resolve(this.onboardingPlanter, 'Planter'),
        line: this.onboardingPlanterLine,
        requirePractice: false,
      },
      {
        key: 'postit',
        object: resolve(this.onboardingPostIt, 'PostItNotes'),
        line: this.onboardingPostItLine,
        requirePractice: false,
      },
      {
        key: 'trash',
        object: resolve(this.onboardingTrash, 'TrashBin'),
        line: this.onboardingTrashLine,
        requirePractice: false,
      },
    ];
  }

  private hideOnboardingTourObjects(): void {
    const steps = this.getOnboardingTourSteps();
    for (let i = 0; i < steps.length; i++) {
      const obj = steps[i].object;
      if (!isNull(obj)) {
        obj.enabled = false;
      }
    }
  }

  private revealAllOnboardingTourObjects(): void {
    const steps = this.getOnboardingTourSteps();
    for (let i = 0; i < steps.length; i++) {
      const obj = steps[i].object;
      if (!isNull(obj)) {
        obj.enabled = true;
      }
    }
  }

  private scheduleOnboarding(): void {
    if (!this.enableOnboarding) {
      return;
    }

    // Hide tour props immediately so the desk starts empty aside from Friend.
    this.hideOnboardingTourObjects();

    this.onboardingToken += 1;
    const token = this.onboardingToken;
    const delaySec = Math.max(0.1, this.onboardingStartDelaySec);
    const delay = this.createEvent('DelayedCallbackEvent');
    delay.bind(() => {
      if (token !== this.onboardingToken || !this.enableOnboarding) {
        return;
      }
      // Re-hide in case AnchorController layout re-enabled props during boot.
      this.hideOnboardingTourObjects();
      print('[FriendGrab] onboarding tour start');
      this.runOnboardingWelcome(token);
    });
    delay.reset(delaySec);
  }

  private runOnboardingWelcome(token: number): void {
    if (token !== this.onboardingToken || !this.enableOnboarding) {
      return;
    }
    this.onboardingActive = true;
    const welcome = String(this.onboardingWelcomeLine || '').trim();
    if (!welcome) {
      this.runOnboardingStep(0, token);
      return;
    }
    this.speakOnboardingText(welcome, token, () => {
      this.delayOnboarding(token, () => this.runOnboardingStep(0, token));
    });
  }

  private runOnboardingStep(index: number, token: number): void {
    if (token !== this.onboardingToken || !this.enableOnboarding) {
      this.onboardingActive = false;
      return;
    }

    const steps = this.getOnboardingTourSteps();
    if (index < 0 || index >= steps.length) {
      this.finishOnboardingTour(token);
      return;
    }

    const step = steps[index];
    if (isNull(step.object)) {
      print(`[FriendGrab] onboarding skip missing object: ${step.key}`);
      this.runOnboardingStep(index + 1, token);
      return;
    }

    this.onboardingActive = true;
    step.object.enabled = true;
    print(`[FriendGrab] onboarding reveal ${step.key}`);

    const line = String(step.line || '').trim();
    const afterSpeech = (): void => {
      if (token !== this.onboardingToken) {
        return;
      }
      const needsPractice =
        this.onboardingRequirePractice && step.requirePractice && !isNull(step.object);
      if (!needsPractice) {
        this.delayOnboarding(token, () => this.runOnboardingStep(index + 1, token));
        return;
      }
      this.waitForOnboardingPractice(step.object as SceneObject, token, () => {
        this.delayOnboarding(token, () => this.runOnboardingStep(index + 1, token));
      });
    };

    if (!line) {
      afterSpeech();
      return;
    }
    this.speakOnboardingText(line, token, afterSpeech);
  }

  private finishOnboardingTour(token: number): void {
    if (token !== this.onboardingToken) {
      return;
    }
    this.revealAllOnboardingTourObjects();
    const closing = String(this.onboardingClosingLine || '').trim();
    if (!closing) {
      this.onboardingActive = false;
      print('[FriendGrab] onboarding complete');
      return;
    }
    this.speakOnboardingText(closing, token, () => {
      if (token !== this.onboardingToken) {
        return;
      }
      this.onboardingActive = false;
      print('[FriendGrab] onboarding complete');
    });
  }

  private delayOnboarding(token: number, next: () => void): void {
    const gap = Math.max(0.05, this.onboardingGapSec);
    const delay = this.createEvent('DelayedCallbackEvent');
    delay.bind(() => {
      if (token !== this.onboardingToken) {
        return;
      }
      next();
    });
    delay.reset(gap);
  }

  private speakOnboardingText(
    text: string,
    token: number,
    onDone: () => void
  ): void {
    if (token !== this.onboardingToken) {
      return;
    }

    if (this.enableSpeechBubble) {
      this.ensureSpeechBubble();
      if (!isNull(this.speechBubble)) {
        this.speechBubble.showAgentChat('reply', '', text, 'Friend');
      }
    }

    const finish = (): void => {
      if (token !== this.onboardingToken) {
        return;
      }
      onDone();
    };

    if (!this.enableTts) {
      const wait = this.createEvent('DelayedCallbackEvent');
      wait.bind(finish);
      wait.reset(estimateSpeechDurationSec(text));
      return;
    }

    const tts = this.resolveTts();
    if (isNull(tts)) {
      const wait = this.createEvent('DelayedCallbackEvent');
      wait.bind(finish);
      wait.reset(estimateSpeechDurationSec(text));
      return;
    }

    tts.speak(text, (ok) => {
      if (token !== this.onboardingToken) {
        return;
      }
      if (!ok) {
        const wait = this.createEvent('DelayedCallbackEvent');
        wait.bind(finish);
        wait.reset(Math.max(1.2, estimateSpeechDurationSec(text) * 0.35));
        return;
      }
      finish();
    });
  }

  private waitForOnboardingPractice(
    target: SceneObject,
    token: number,
    onDone: () => void
  ): void {
    this.onboardingPracticeDone = false;
    let grabbed = false;

    const finish = (reason: string): void => {
      if (this.onboardingPracticeDone || token !== this.onboardingToken) {
        return;
      }
      this.onboardingPracticeDone = true;
      print(`[FriendGrab] onboarding practice ${reason}`);
      onDone();
    };

    const manip = this.findManipulationInTree(target);
    if (!isNull(manip)) {
      if (manip.onManipulationStart) {
        manip.onManipulationStart.add(() => {
          if (token !== this.onboardingToken) {
            return;
          }
          grabbed = true;
        });
      }
      if (manip.onManipulationEnd) {
        manip.onManipulationEnd.add(() => {
          if (token !== this.onboardingToken || !grabbed) {
            return;
          }
          finish('grab-release');
        });
      }
    } else {
      print(
        `[FriendGrab] onboarding no grab handler on ${target.name} — using timeout`
      );
    }

    const timeoutSec = Math.max(3, this.onboardingPracticeTimeoutSec);
    const timeout = this.createEvent('DelayedCallbackEvent');
    timeout.bind(() => finish('timeout'));
    timeout.reset(timeoutSec);

    // Nudge player if they're still waiting.
    const tip = this.createEvent('DelayedCallbackEvent');
    tip.bind(() => {
      if (this.onboardingPracticeDone || token !== this.onboardingToken) {
        return;
      }
      this.showSpeech('Try grabbing it, then release.', true, null);
    });
    tip.reset(Math.min(5, timeoutSec * 0.45));
  }

  private findManipulationInTree(root: SceneObject): InteractableManipulationLike | null {
    const direct = this.findExistingManipulation(root);
    if (!isNull(direct)) {
      return direct;
    }
    const childCount = root.getChildrenCount();
    for (let i = 0; i < childCount; i++) {
      const child = root.getChild(i);
      const nested = this.findManipulationInTree(child);
      if (!isNull(nested)) {
        return nested;
      }
    }
    return null;
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

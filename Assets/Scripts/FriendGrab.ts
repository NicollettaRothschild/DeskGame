import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import { InteractableManipulation } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation';
import { ArvisGhostSpeechBubble } from './ArvisGhostSpeechBubble';
import { estimateSpeechDurationSec, FlowGardenTTS } from './FlowGardenTTS';
import {
  getSharedFlowGardenTts,
  getSharedSpeechRecognition,
  registerFriendGrab,
} from './FlowGardenServiceRegistry';
import { PlantLifecycle } from './PlantLifecycle';
import {
  clearFriendOnboardingCompletedInStorage,
  isFriendOnboardingCompletedInStorage,
  markFriendOnboardingCompletedInStorage,
  shouldRunFriendOnboardingTour,
} from './FriendOnboardingStorage';

/** Voice phrases to wipe anchors and redo Friend onboarding (new workspace, etc.). */
export function looksLikeWorkspaceResetCommand(text: string): boolean {
  const t = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ');
  if (!t) {
    return false;
  }
  if (
    /\b(new workspace|moved workspace|i moved|start over|set up again|setup again|redo onboarding|restart onboarding)\b/.test(
      t
    )
  ) {
    return true;
  }
  const wantsReset = /\b(reset|restart|redo|clear|wipe)\b/.test(t);
  const target =
    /\b(anchor|anchors|onboarding|tour|setup|workspace|space|garden|layout)\b/.test(t);
  return wantsReset && target;
}

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
  colliderSize: vec3 = new vec3(2.4, 3.2, 2.4);

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
   * When on, first-time users get the tour. Returning users (flag in persistent storage)
   * skip the tour and load saved anchors. Say "reset anchors" to run onboarding again.
   */
  @input
  @label('Enable Onboarding')
  @hint('First launch: guided tour. Later sessions restore anchors unless user asks to reset.')
  enableOnboarding: boolean = false;

  /**
   * Dev/QA: ignore persistent completion and run the full tour every session
   * (as if the user had never onboarded). Requires Enable Onboarding.
   */
  @input
  @label('Treat As New User')
  @hint(
    'Always play onboarding each session (ignores remembered completion without deleting it). Turn off to resume returning-user restore.'
  )
  treatAsNewUser: boolean = false;

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

  /** How far in front of Friend (toward the camera) each tour object appears, in cm. */
  @input('float')
  @label('Present Distance (cm)')
  onboardingPresentDistanceCm: number = 22;

  /** Height offset from Friend when presenting (cm). */
  @input('float')
  @label('Present Height Offset (cm)')
  onboardingPresentHeightCm: number = 0;

  @input
  @label('Welcome Line')
  onboardingWelcomeLine: string =
    "Hi! I'm your buddy. I'll show you things one piece at a time.";

  @input
  @label('Closing Line')
  onboardingClosingLine: string =
    "You're all set! Say hey friend if you want to talk again. When you finish your goal, say I finished my goal. Have fun!";

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
    "Here's the planter stack for extra pots later.";

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
  @label('Goal Prompt Line')
  @hint('Spoken after the tour; Friend waits for the player to say a goal')
  onboardingGoalPromptLine: string =
    "What goal should we grow together? Say something like: I want to walk 20 meters.";

  @input
  @label('Goal Planted Pot Line')
  onboardingGoalSeedLine: string =
    "Here's your goal planter — the seed is already planted. Grab it, place it where you like, then water it. Walk goals grow automatically when you finish the distance. Or tell me when you're done!";

  @input('float')
  @label('Goal Listen Timeout (sec)')
  onboardingGoalListenTimeoutSec: number = 22;

  @input
  @label('Goal Fallback Example')
  onboardingGoalFallback: string = 'I want to walk 20 meters';

  @input
  @label('Auto Goal Fallback On Timeout')
  @hint('When enabled, uses Goal Fallback Example if no goal is heard before timeout.')
  onboardingAutoGoalFallbackOnTimeout: boolean = false;

  @input
  @label('Require Place Goal Pot')
  @hint('Wait for grab+release on the planted goal pot before finishing onboarding')
  onboardingRequireGoalPotPractice: boolean = true;

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
  @label('Always Look At User While Following')
  @hint('Keeps Buddy facing the user whenever follow mode is active, even outside proximity look-at distance.')
  lookAtAlwaysWhileFollowing: boolean = true;

  @input
  enableIdleBob: boolean = true;

  /** Vertical bob amplitude in centimeters. */
  @input('float')
  idleBobAmplitudeCm: number = 1.5;

  /** Angular speed for idle bob (higher = faster). */
  @input('float')
  idleBobSpeed: number = 1.8;

  @input
  @hint('Spoken when a bound goal is completed (walk distance or speech)')
  goalCongratsLine: string =
    "Woohoo! You did it! I'm so proud of you — your plant is fully grown!";

  @input
  @hint('Buddy follows the camera in all sessions (paused only while grabbed)')
  enableFollowAfterOnboarding: boolean = true;

  /** How far ahead of the user Buddy stays (cm, along look direction). */
  @input('float')
  followDistanceCm: number = 26;

  /** Side offset from camera forward (cm). Positive = right. */
  @input('float')
  followSideOffsetCm: number = 4;

  /** Height relative to camera (cm). Negative = a bit below eye level. */
  @input('float')
  followHeightOffsetCm: number = -18;

  /** How quickly Buddy catches up (higher = snappier). */
  @input('float')
  followLerpSpeed: number = 3.5;

  /** Ignore tiny camera wobble below this horizontal gap (cm). */
  @input('float')
  followMinMoveCm: number = 4;

  @input
  @hint('Spoken when the user asks to reset anchors / restart setup')
  workspaceResetLine: string =
    "Got it — let's set this space up again. I'll clear the anchors and walk you through onboarding.";

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
  private lastLookAtInvalidTargetLogAt = -9999;
  private onboardingActive = false;
  private onboardingToken = 0;
  private onboardingPracticeDone = false;
  private onboardingGoalListening = false;
  private goalCompletionWired = false;
  private lastGoalCompleteUtterance = '';
  private lastGoalCompleteAt = 0;
  private followActive = false;
  private followLoggedStart = false;
  private workspaceResetAt = 0;
  private static readonly MIN_COLLIDER_SIZE = new vec3(2.1, 2.8, 2.1);

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => {
      registerFriendGrab(this);
      this.captureIdleBasePosition();
      this.ensureFriendSounds();
      this.ensureSpeechBubble();
      this.resolveTts();
      this.tryWireMoveInteraction();
      this.ensureGoalCompletionListening();
      this.startFollowingUser('always-on');
      this.scheduleOnboarding();
      if (this.debugLogging) {
        print(
          `[FriendGrab] ready tts=${!isNull(this.resolveTts())} bubble=${this.enableSpeechBubble} lookAt=${this.enableLookAt} bob=${this.enableIdleBob} onboarding=${this.enableOnboarding} completed=${isFriendOnboardingCompletedInStorage()}`
        );
      }
    });

    this.createEvent('LateUpdateEvent').bind(() => {
      this.updateFollowUser();
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
      // Planter stack is skipped — a planted goal pot is gifted after the goal prompt.
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
    // Planter stack stays hidden during the tour (goal pot is gifted later).
    const planter = !isNull(this.onboardingPlanter)
      ? this.onboardingPlanter
      : this.findObjectByNameInScene('Planter');
    if (!isNull(planter)) {
      planter.enabled = false;
    }
  }

  private revealAllOnboardingTourObjects(): void {
    const steps = this.getOnboardingTourSteps();
    for (let i = 0; i < steps.length; i++) {
      const obj = steps[i].object;
      if (!isNull(obj)) {
        // Keep already-revealed props where the player left them; only place
        // anything that never got a presentation slot (still disabled).
        const needsPlacement = !obj.enabled;
        obj.enabled = true;
        if (needsPlacement) {
          this.placeObjectInFrontOfFriend(obj, steps[i].key);
        }
      }
    }
    const planter = !isNull(this.onboardingPlanter)
      ? this.onboardingPlanter
      : this.findObjectByNameInScene('Planter');
    if (!isNull(planter)) {
      planter.enabled = true;
    }
  }

  /**
   * Put the tour object in a clear presentation slot just in front of Friend
   * (toward the camera), so it doesn't pop in at a distant desk-anchor pose.
   */
  private placeObjectInFrontOfFriend(obj: SceneObject, key: string): void {
    if (isNull(obj)) {
      return;
    }

    const friendTransform = this.getSceneObject().getTransform();
    const friendPos = friendTransform.getWorldPosition();

    let dirX = 0;
    let dirZ = -1; // Lens forward default when no camera yet
    if (isNull(this.lookAtCamera)) {
      this.lookAtCamera = this.findCameraObject();
    }
    if (!isNull(this.lookAtCamera)) {
      const camPos = this.lookAtCamera.getTransform().getWorldPosition();
      const dx = camPos.x - friendPos.x;
      const dz = camPos.z - friendPos.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.5) {
        dirX = dx / len;
        dirZ = dz / len;
      }
    } else {
      // Friend LookAt uses +Z toward the user when active.
      try {
        const forward = friendTransform.forward;
        if (!isNull(forward)) {
          const len = Math.sqrt(forward.x * forward.x + forward.z * forward.z);
          if (len > 0.001) {
            dirX = forward.x / len;
            dirZ = forward.z / len;
          }
        }
      } catch (_e) {
        // keep default -Z
      }
    }

    let distance = Math.max(8, this.onboardingPresentDistanceCm);
    let height = this.onboardingPresentHeightCm;
    // Larger props sit a bit farther / lower so they don't swallow Friend.
    if (key === 'planter' || key === 'trash') {
      distance = Math.max(distance, 32);
      height = height - 4;
    } else if (key === 'palette') {
      height = height - 2;
    } else if (key === 'globe') {
      height = height + 2;
    }

    const present = this.resolveOnboardingSpawnPosition(friendPos, dirX, dirZ, distance, height);
    obj.getTransform().setWorldPosition(present);

    if (this.debugLogging) {
      print(
        `[FriendGrab] present ${key} at ${present.x.toFixed(1)}, ${present.y.toFixed(1)}, ${present.z.toFixed(1)}`
      );
    }
  }

  /** Rewire + force-show garden MoveHandle after onboarding re-enables a source. */
  private ensureOnboardingSourceHandle(source: SceneObject, key: string): void {
    if (key !== 'planter' && key !== 'postit') {
      return;
    }

    const handle = this.findNamedChild(source, 'MoveHandle');
    if (isNull(handle)) {
      print(`[FriendGrab] onboarding ${key} has no MoveHandle child`);
      return;
    }

    handle.enabled = true;
    const sourceLabel = key === 'planter' ? 'Planter' : 'PostItNotes';
    const scripts = handle.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i] as ScriptComponent & {
        sourceRoot?: SceneObject;
        sourceName?: string;
        wireMoveInteraction?: () => void;
        presentHandle?: () => void;
        clearPresentedHandle?: () => void;
      };
      if (isNull(script) || typeof script.wireMoveInteraction !== 'function') {
        continue;
      }
      script.sourceRoot = source;
      script.sourceName = sourceLabel;
      script.wireMoveInteraction();
      if (typeof script.presentHandle === 'function') {
        script.presentHandle();
      }
      print(`[FriendGrab] onboarding ${key} move handle ready`);
    }
  }

  private findNamedChild(parent: SceneObject, name: string): SceneObject | null {
    if (isNull(parent)) {
      return null;
    }
    const count = parent.getChildrenCount();
    for (let i = 0; i < count; i++) {
      const child = parent.getChild(i);
      if (!isNull(child) && child.name === name) {
        return child;
      }
    }
    return null;
  }

  private shouldRunOnboardingThisSession(): boolean {
    return shouldRunFriendOnboardingTour(this.enableOnboarding, this.treatAsNewUser);
  }

  private scheduleOnboarding(): void {
    if (!this.shouldRunOnboardingThisSession()) {
      if (this.enableOnboarding && isFriendOnboardingCompletedInStorage()) {
        print('[FriendGrab] onboarding skipped — already completed (loading anchors)');
      }
      return;
    }

    if (this.treatAsNewUser) {
      print('[FriendGrab] treat as new user — forcing onboarding this session');
    }

    // Wipe last-session plants/layout so the tour never starts with leftover anchors.
    this.requestOnboardingSessionClear();

    // Hide tour props immediately so the desk starts empty aside from Friend.
    this.hideOnboardingTourObjects();

    this.onboardingToken += 1;
    const token = this.onboardingToken;
    const delaySec = Math.max(0.1, this.onboardingStartDelaySec);
    const delay = this.createEvent('DelayedCallbackEvent');
    delay.bind(() => {
      if (token !== this.onboardingToken || !this.shouldRunOnboardingThisSession()) {
        return;
      }
      // Re-hide in case AnchorController layout re-enabled props during boot.
      this.requestOnboardingSessionClear();
      this.hideOnboardingTourObjects();
      print('[FriendGrab] onboarding tour start');
      this.runOnboardingWelcome(token);
    });
    delay.reset(delaySec);
  }

  private requestOnboardingSessionClear(): void {
    const anchor = this.findAnchorController();
    if (isNull(anchor)) {
      return;
    }
    if (typeof anchor.clearPreviousSessionForOnboarding === 'function') {
      anchor.clearPreviousSessionForOnboarding();
    }
  }

  private findAnchorController(): { clearPreviousSessionForOnboarding?: () => void } | null {
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      const found = this.findAnchorControllerOn(global.scene.getRootObject(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findAnchorControllerOn(
    node: SceneObject
  ): { clearPreviousSessionForOnboarding?: () => void } | null {
    if (isNull(node)) {
      return null;
    }

    const scripts = node.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as ScriptComponent & {
        clearPreviousSessionForOnboarding?: () => void;
      };
      if (candidate && typeof candidate.clearPreviousSessionForOnboarding === 'function') {
        return candidate;
      }
    }

    for (let i = 0; i < node.getChildrenCount(); i++) {
      const found = this.findAnchorControllerOn(node.getChild(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private runOnboardingWelcome(token: number): void {
    if (token !== this.onboardingToken || !this.enableOnboarding) {
      return;
    }
    this.onboardingActive = true;
    const welcome = this.resolveOnboardingWelcomeLine();
    if (!welcome) {
      this.runOnboardingStep(0, token);
      return;
    }
    this.speakOnboardingText(welcome, token, () => {
      this.delayOnboarding(token, () => this.runOnboardingStep(0, token));
    });
  }

  /** Prefer live script default; rewrite legacy Inspector "desk buddy" copy. */
  private resolveOnboardingWelcomeLine(): string {
    const preferred = "Hi! I'm your buddy. I'll show you things one piece at a time.";
    const raw = String(this.onboardingWelcomeLine || '').trim();
    if (!raw) {
      return preferred;
    }
    if (/desk\s+buddy/i.test(raw) || /\bthe desk\b/i.test(raw)) {
      return preferred;
    }
    return raw;
  }

  private runOnboardingStep(index: number, token: number): void {
    if (token !== this.onboardingToken || !this.enableOnboarding) {
      this.onboardingActive = false;
      return;
    }

    const steps = this.getOnboardingTourSteps();
    if (index < 0 || index >= steps.length) {
      this.runOnboardingGoalStep(token);
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
    this.placeObjectInFrontOfFriend(step.object, step.key);
    this.ensureOnboardingSourceHandle(step.object, step.key);
    print(`[FriendGrab] onboarding reveal ${step.key}`);

    const needsPractice =
      this.onboardingRequirePractice && step.requirePractice && !isNull(step.object);

    // Arm grab practice immediately so grabs during the spoken line still count.
    let speechDone = false;
    let practiceDone = !needsPractice;
    const tryAdvance = (): void => {
      if (token !== this.onboardingToken || !speechDone || !practiceDone) {
        return;
      }
      this.delayOnboarding(token, () => this.runOnboardingStep(index + 1, token));
    };

    if (needsPractice) {
      this.waitForOnboardingPractice(step.object as SceneObject, token, step.key, () => {
        practiceDone = true;
        tryAdvance();
      });
    }

    const line = String(step.line || '').trim();
    const afterSpeech = (): void => {
      if (token !== this.onboardingToken) {
        return;
      }
      speechDone = true;
      tryAdvance();
    };

    if (!line) {
      afterSpeech();
      return;
    }
    this.speakOnboardingText(line, token, afterSpeech);
  }

  private runOnboardingGoalStep(token: number): void {
    if (token !== this.onboardingToken || !this.enableOnboarding) {
      this.onboardingActive = false;
      return;
    }

    this.onboardingActive = true;
    const prompt = String(this.onboardingGoalPromptLine || '').trim();
    print('[FriendGrab] onboarding goal prompt');
    const afterPrompt = (): void => {
      if (token !== this.onboardingToken) {
        return;
      }
      this.waitForOnboardingGoalSpeech(token, (goalText) => {
        if (token !== this.onboardingToken) {
          return;
        }
        const goal = String(goalText || '').trim();
        if (!goal) {
          print('[FriendGrab] onboarding goal not provided — finishing without seeded goal pot');
          this.delayOnboarding(token, () => this.finishOnboardingTour(token));
          return;
        }
        print(`[FriendGrab] onboarding goal heard: ${goal}`);
        this.spawnOnboardingGoalPlantedPot(goal, token, (pot) => {
          if (token !== this.onboardingToken) {
            return;
          }

          let speechDone = false;
          let practiceDone =
            !this.onboardingRequireGoalPotPractice || isNull(pot);
          const tryFinish = (): void => {
            if (token !== this.onboardingToken || !speechDone || !practiceDone) {
              return;
            }
            this.delayOnboarding(token, () => this.finishOnboardingTour(token));
          };

          if (!practiceDone && !isNull(pot)) {
            this.waitForOnboardingPractice(pot as SceneObject, token, 'goal-pot', () => {
              practiceDone = true;
              tryFinish();
            });
          }

          const seedLine = this.resolveOnboardingGoalPotLine();
          if (!seedLine) {
            speechDone = true;
            tryFinish();
            return;
          }
          this.speakOnboardingText(seedLine, token, () => {
            speechDone = true;
            tryFinish();
          });
        });
      });
    };

    if (!prompt) {
      afterPrompt();
      return;
    }
    this.speakOnboardingText(prompt, token, afterPrompt);
  }

  private waitForOnboardingGoalSpeech(
    token: number,
    onGoal: (goalText: string | null) => void
  ): void {
    const speech = getSharedSpeechRecognition();
    if (isNull(speech)) {
      if (this.onboardingAutoGoalFallbackOnTimeout) {
        print('[FriendGrab] onboarding goal: no SpeechRecognition — using fallback');
        onGoal(String(this.onboardingGoalFallback || 'I want to walk 20 meters'));
      } else {
        print('[FriendGrab] onboarding goal: no SpeechRecognition — skipping planted goal pot');
        onGoal(null);
      }
      return;
    }

    this.onboardingGoalListening = true;
    speech.suppressVoiceCommandsFor(Math.max(8, this.onboardingGoalListenTimeoutSec + 2));
    speech.clearUtteranceState();

    let settled = false;
    const finish = (text: string): void => {
      if (settled || token !== this.onboardingToken) {
        return;
      }
      settled = true;
      this.onboardingGoalListening = false;
      speech.removeTranscriptListener(onTranscript);
      speech.clearUtteranceState();
      onGoal(text);
    };

    const onTranscript = (text: string, isFinal: boolean): void => {
      if (token !== this.onboardingToken || !this.onboardingGoalListening) {
        return;
      }
      const cleaned = this.normalizeGoalUtterance(text);
      if (!cleaned || cleaned.length < 4) {
        return;
      }
      if (this.looksLikeFriendEcho(cleaned)) {
        return;
      }
      if (isFinal || cleaned.length >= 10) {
        finish(cleaned);
      }
    };
    speech.addTranscriptListener(onTranscript);

    const poll = this.createEvent('UpdateEvent');
    poll.bind(() => {
      if (settled || token !== this.onboardingToken) {
        poll.enabled = false;
        return;
      }
      const stable = speech.getStableUtterance(1.1);
      const cleaned = this.normalizeGoalUtterance(stable);
      if (cleaned && cleaned.length >= 6 && !this.looksLikeFriendEcho(cleaned)) {
        poll.enabled = false;
        finish(cleaned);
      }
    });

    const timeout = this.createEvent('DelayedCallbackEvent');
    timeout.bind(() => {
      if (settled || token !== this.onboardingToken) {
        return;
      }
      poll.enabled = false;
      const fallback = String(this.onboardingGoalFallback || 'I want to walk 20 meters');
      if (this.onboardingAutoGoalFallbackOnTimeout) {
        print(`[FriendGrab] onboarding goal timeout — using fallback: ${fallback}`);
        finish(fallback);
      } else {
        print('[FriendGrab] onboarding goal timeout — no goal heard; skipping planted goal pot');
        finish('');
      }
    });
    timeout.reset(Math.max(6, this.onboardingGoalListenTimeoutSec));
  }

  private normalizeGoalUtterance(text: string): string {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private looksLikeFriendEcho(text: string): boolean {
    const lower = text.toLowerCase();
    const prompts = [
      this.onboardingGoalPromptLine,
      this.onboardingGoalSeedLine,
      this.onboardingWelcomeLine,
      this.onboardingPlanterLine,
    ];
    for (let i = 0; i < prompts.length; i++) {
      const prompt = String(prompts[i] || '')
        .toLowerCase()
        .slice(0, 40);
      if (prompt && lower.indexOf(prompt.slice(0, 24)) >= 0) {
        return true;
      }
    }
    return (
      lower.indexOf('what goal') >= 0 ||
      lower.indexOf('grow together') >= 0 ||
      lower.indexOf('say something like') >= 0
    );
  }

  private resolveOnboardingGoalPotLine(): string {
    const preferred =
      "Here's your goal planter — the seed is already planted. Grab it, place it where you like, then water it. Walk goals grow automatically when you finish the distance. Or tell me when you're done!";
    const raw = String(this.onboardingGoalSeedLine || '').trim();
    if (!raw) {
      return preferred;
    }
    if (/grab a pot from the planter|plant the seed/i.test(raw)) {
      return preferred;
    }
    return raw;
  }

  private spawnOnboardingGoalPlantedPot(
    goalText: string,
    token: number,
    onDone: (pot: SceneObject | null) => void
  ): void {
    if (token !== this.onboardingToken) {
      return;
    }

    const anchor = this.findAnchorController() as {
      clearPreviousSessionForOnboarding?: () => void;
      createGoalPlantedPotAtWorldPosition?: (
        goalText: string,
        worldPos: vec3
      ) => SceneObject | null;
    } | null;

    const friendPos = this.getSceneObject().getTransform().getWorldPosition();
    let dirX = 0;
    let dirZ = -1;
    if (isNull(this.lookAtCamera)) {
      this.lookAtCamera = this.findCameraObject();
    }
    if (!isNull(this.lookAtCamera)) {
      const camPos = this.lookAtCamera.getTransform().getWorldPosition();
      const dx = camPos.x - friendPos.x;
      const dz = camPos.z - friendPos.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.5) {
        dirX = dx / len;
        dirZ = dz / len;
      }
    }
    const spawnPos = this.resolveOnboardingSpawnPosition(
      friendPos,
      dirX,
      dirZ,
      Math.max(28, this.onboardingPresentDistanceCm),
      this.onboardingPresentHeightCm - 2
    );

    let pot: SceneObject | null = null;
    if (
      !isNull(anchor) &&
      typeof anchor.createGoalPlantedPotAtWorldPosition === 'function'
    ) {
      pot = anchor.createGoalPlantedPotAtWorldPosition(goalText, spawnPos);
    }

    if (isNull(pot)) {
      print('[FriendGrab] onboarding goal planted pot spawn failed');
      onDone(null);
      return;
    }

    pot.enabled = true;
    pot.getTransform().setWorldPosition(spawnPos);
    this.ensureGoalCompletionListening();
    print(`[FriendGrab] onboarding goal planted pot spawned for "${goalText}"`);
    onDone(pot);
  }

  /**
   * Keep onboarding spawn positions near the user to avoid rare far-away placements
   * when Friend/camera references jump between anchor states.
   */
  private resolveOnboardingSpawnPosition(
    friendPos: vec3,
    dirX: number,
    dirZ: number,
    distanceCm: number,
    heightOffsetCm: number
  ): vec3 {
    // Keep onboarding props comfortably below Buddy (not face-level).
    const underBuddyDistance = Math.max(10, Math.min(22, distanceCm * 0.55));
    const underBuddyDropCm = 18;
    const spawn = new vec3(
      friendPos.x + dirX * underBuddyDistance,
      friendPos.y - underBuddyDropCm + Math.min(0, heightOffsetCm * 0.2),
      friendPos.z + dirZ * underBuddyDistance
    );

    if (isNull(this.lookAtCamera)) {
      return spawn;
    }

    const camTransform = this.lookAtCamera.getTransform();
    const camPos = camTransform.getWorldPosition();
    let camForward = camTransform.forward;
    if (isNull(camForward)) {
      camForward = new vec3(0, 0, -1);
    }
    let fX = -camForward.x;
    let fZ = -camForward.z;
    let fLen = Math.sqrt(fX * fX + fZ * fZ);
    if (fLen < 0.001) {
      fX = dirX;
      fZ = dirZ;
      fLen = Math.sqrt(fX * fX + fZ * fZ);
    }
    if (fLen < 0.001) {
      fX = 0;
      fZ = -1;
      fLen = 1;
    }
    fX /= fLen;
    fZ /= fLen;

    // Absolute safety: never let onboarding items creep into head/eye space.
    const maxHeadClearY = camPos.y - 10;
    if (spawn.y > maxHeadClearY) {
      spawn.y = maxHeadClearY;
    }

    const camDx = spawn.x - camPos.x;
    const camDz = spawn.z - camPos.z;
    const camDist = Math.sqrt(camDx * camDx + camDz * camDz);
    const maxFromCameraCm = 60;
    const dotForward = camDx * fX + camDz * fZ;
    const isBehindCamera = dotForward < 6;
    if (camDist <= maxFromCameraCm && !isBehindCamera) {
      return spawn;
    }

    // Re-center to a reliable slot in front of the user in camera forward.
    const fallbackDist = Math.max(18, Math.min(30, underBuddyDistance));
    const clamped = new vec3(
      camPos.x + fX * fallbackDist,
      spawn.y,
      camPos.z + fZ * fallbackDist
    );
    if (this.debugLogging) {
      print(
        `[FriendGrab] onboarding spawn clamped to camera-forward slot (dist=${camDist.toFixed(1)}cm behind=${isBehindCamera})`
      );
    }
    return clamped;
  }

  private recoverOnboardingObjectIfOutOfView(target: SceneObject, key: string): void {
    if (isNull(target) || isNull(this.lookAtCamera)) {
      return;
    }

    const camPos = this.lookAtCamera.getTransform().getWorldPosition();
    const worldPos = target.getTransform().getWorldPosition();
    const dx = worldPos.x - camPos.x;
    const dz = worldPos.z - camPos.z;
    const horizontalCm = Math.sqrt(dx * dx + dz * dz);
    const yDelta = worldPos.y - camPos.y;

    // Only intervene when the object likely "vanished" from user view.
    const tooFar = horizontalCm > 120;
    const tooLow = yDelta < -120;
    const tooHigh = yDelta > 20;
    if (!tooFar && !tooLow && !tooHigh) {
      return;
    }

    this.placeObjectInFrontOfFriend(target, key);
    print(
      `[FriendGrab] onboarding ${key} recovered (dist=${horizontalCm.toFixed(1)}cm yDelta=${yDelta.toFixed(1)}cm)`
    );
  }

  private finishOnboardingTour(token: number): void {
    if (token !== this.onboardingToken) {
      return;
    }
    this.revealAllOnboardingTourObjects();
    this.ensureGoalCompletionListening();
    const markDone = (): void => {
      this.onboardingActive = false;
      markFriendOnboardingCompletedInStorage();
      this.startFollowingUser('onboarding-complete');
      print('[FriendGrab] onboarding complete');
    };
    const closing = this.resolveOnboardingClosingLine();
    if (!closing) {
      markDone();
      return;
    }
    this.speakOnboardingText(closing, token, () => {
      if (token !== this.onboardingToken) {
        return;
      }
      markDone();
    });
  }

  /** Prefer live script default; rewrite legacy Inspector "hey Arvis" copy. */
  private resolveOnboardingClosingLine(): string {
    const preferred =
      "You're all set! I'll tag along from here. Say hey friend if you want to talk again. When you finish your goal — or walk the distance — I'll congratulate you and your plant will fully grow. Have fun!";
    const raw = String(this.onboardingClosingLine || '').trim();
    if (!raw) {
      return preferred;
    }
    if (/hey\s+arvis/i.test(raw)) {
      return preferred;
    }
    return raw;
  }

  private ensureGoalCompletionListening(): void {
    if (this.goalCompletionWired) {
      return;
    }
    this.goalCompletionWired = true;

    PlantLifecycle.addGoalCompleteListener((plant) => {
      this.congratulateGoalComplete(plant);
    });

    const speech = getSharedSpeechRecognition();
    if (isNull(speech)) {
      print('[FriendGrab] goal completion listening armed (walk auto + congrats; no speech)');
      return;
    }
    speech.addTranscriptListener((text, isFinal) => {
      if (!isFinal && String(text || '').trim().length < 12) {
        return;
      }
      if (this.onboardingGoalListening) {
        return;
      }
      if (this.tryWorkspaceResetFromSpeech(text)) {
        return;
      }
      this.tryCompleteGoalFromSpeech(text);
    });
    print('[FriendGrab] goal completion listening armed');
  }

  /**
   * Clear anchors / plants and run Friend onboarding again (e.g. new workspace).
   * Returns true if the restart was scheduled.
   */
  public restartOnboardingTour(reason: string = 'voice'): boolean {
    const now = getTime();
    if (now - this.workspaceResetAt < 4) {
      print(`[FriendGrab] onboarding restart ignored — cooldown (${reason})`);
      return true;
    }
    if (this.onboardingActive) {
      print(`[FriendGrab] onboarding restart ignored — tour already active (${reason})`);
      this.showSpeech(
        "We're already setting things up — grab and place the next object when you're ready.",
        true,
        null
      );
      return false;
    }

    this.workspaceResetAt = now;
    print(`[FriendGrab] restarting onboarding (${reason})`);
    this.onboardingGoalListening = false;
    this.enableOnboarding = true;
    clearFriendOnboardingCompletedInStorage();

    // Cancel any in-flight tour callbacks.
    this.onboardingToken += 1;
    this.onboardingActive = false;

    const anchor = this.findAnchorControllerForRestart();
    if (!isNull(anchor) && typeof anchor.prepareOnboardingRestart === 'function') {
      anchor.prepareOnboardingRestart();
    } else {
      this.requestOnboardingSessionClear();
    }

    const line = String(this.workspaceResetLine || '').trim();
    if (line) {
      this.showSpeech(line, true, null);
    }

    this.hideOnboardingTourObjects();
    this.scheduleOnboardingRestartSoon();
    return true;
  }

  private tryWorkspaceResetFromSpeech(text: string): boolean {
    const cleaned = this.normalizeGoalUtterance(text);
    if (!looksLikeWorkspaceResetCommand(cleaned)) {
      return false;
    }
    const now = getTime();
    if (
      cleaned === this.lastGoalCompleteUtterance &&
      now - this.lastGoalCompleteAt < 1.5
    ) {
      return true;
    }
    this.lastGoalCompleteUtterance = cleaned;
    this.lastGoalCompleteAt = now;
    return this.restartOnboardingTour('speech');
  }

  private scheduleOnboardingRestartSoon(): void {
    this.onboardingToken += 1;
    const token = this.onboardingToken;
    const delay = this.createEvent('DelayedCallbackEvent');
    delay.bind(() => {
      if (token !== this.onboardingToken || !this.enableOnboarding) {
        return;
      }
      this.hideOnboardingTourObjects();
      print('[FriendGrab] onboarding tour restart');
      this.runOnboardingWelcome(token);
    });
    delay.reset(Math.max(1.2, this.onboardingStartDelaySec));
  }

  private findAnchorControllerForRestart(): {
    prepareOnboardingRestart?: () => void;
    clearPreviousSessionForOnboarding?: () => void;
  } | null {
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      const found = this.findAnchorControllerForRestartRecursive(global.scene.getRootObject(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findAnchorControllerForRestartRecursive(
    node: SceneObject
  ): {
    prepareOnboardingRestart?: () => void;
    clearPreviousSessionForOnboarding?: () => void;
  } | null {
    const scripts = node.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as ScriptComponent & {
        prepareOnboardingRestart?: () => void;
        clearPreviousSessionForOnboarding?: () => void;
      };
      if (
        candidate &&
        (typeof candidate.prepareOnboardingRestart === 'function' ||
          typeof candidate.clearPreviousSessionForOnboarding === 'function')
      ) {
        return candidate;
      }
    }
    const count = node.getChildrenCount();
    for (let i = 0; i < count; i++) {
      const found = this.findAnchorControllerForRestartRecursive(node.getChild(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private congratulateGoalComplete(plant: PlantLifecycle | null): void {
    if (isNull(plant)) {
      return;
    }
    const now = getTime();
    if (now - this.lastGoalCompleteAt < 1.5) {
      return;
    }
    this.lastGoalCompleteAt = now;

    // Make sure buddy is visible/audible even if something disabled the root.
    const self = this.getSceneObject();
    if (!isNull(self) && !self.enabled) {
      self.enabled = true;
    }

    const goal = plant.getGoalText() || 'your goal';
    const template = String(this.goalCongratsLine || '').trim();
    const line = template
      ? template.indexOf('{goal}') >= 0
        ? template.split('{goal}').join(goal)
        : `${template} "${goal}"`
      : `Woohoo! You did it — "${goal}"! Your plant is fully grown!`;

    print(`[FriendGrab] congratulating goal complete: ${goal}`);
    this.showSpeech(line, true, null);
  }

  private tryCompleteGoalFromSpeech(text: string): void {
    const cleaned = this.normalizeGoalUtterance(text);
    if (!cleaned || cleaned.length < 4) {
      return;
    }
    const now = getTime();
    if (
      cleaned === this.lastGoalCompleteUtterance &&
      now - this.lastGoalCompleteAt < 2.5
    ) {
      return;
    }

    const plant = PlantLifecycle.tryCompleteGoalBySpeech(cleaned);
    if (isNull(plant)) {
      return;
    }

    this.lastGoalCompleteUtterance = cleaned;
    // Celebration speech comes from congratulateGoalComplete via the listener.
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
    key: string,
    onDone: () => void
  ): void {
    this.onboardingPracticeDone = false;
    let grabbed = false;
    let listenersWired = false;
    const presentPos = target.getTransform().getWorldPosition();

    const finish = (reason: string): void => {
      if (this.onboardingPracticeDone || token !== this.onboardingToken) {
        return;
      }
      this.onboardingPracticeDone = true;
      print(`[FriendGrab] onboarding practice ${reason}`);
      onDone();
    };

    const hasMovedFromPresent = (): boolean => {
      const pos = target.getTransform().getWorldPosition();
      return pos.distance(presentPos) > 2.5;
    };

    const onGrabStart = (): void => {
      if (token !== this.onboardingToken || this.onboardingPracticeDone) {
        return;
      }
      grabbed = true;
    };

    const onGrabEnd = (): void => {
      if (token !== this.onboardingToken || this.onboardingPracticeDone) {
        return;
      }
      // Count release even if we armed mid-grab (missed the start event).
      if (grabbed || hasMovedFromPresent()) {
        this.recoverOnboardingObjectIfOutOfView(target, key);
        finish('grab-release');
      }
    };

    const tryWireListeners = (): boolean => {
      if (listenersWired || this.onboardingPracticeDone || token !== this.onboardingToken) {
        return listenersWired;
      }

      const manip = this.findManipulationInTree(target);
      const interactable = this.findInteractableInTree(target);
      if (isNull(manip) && isNull(interactable)) {
        return false;
      }

      listenersWired = true;
      if (!isNull(manip)) {
        if (manip.onManipulationStart) {
          manip.onManipulationStart.add(onGrabStart);
        }
        if (manip.onManipulationEnd) {
          manip.onManipulationEnd.add(onGrabEnd);
        }
      }
      if (!isNull(interactable)) {
        if (interactable.onDragStart) {
          interactable.onDragStart.add(onGrabStart);
        }
        if (interactable.onDragEnd) {
          interactable.onDragEnd.add(onGrabEnd);
        }
        if (interactable.onTriggerEnd) {
          interactable.onTriggerEnd.add(onGrabEnd);
        }
        if (interactable.onTriggerEndOutside) {
          interactable.onTriggerEndOutside.add(onGrabEnd);
        }
        if (interactable.onInteractorTriggerEnd) {
          interactable.onInteractorTriggerEnd.add(onGrabEnd);
        }
        if (interactable.onInteractorTriggerEndOutside) {
          interactable.onInteractorTriggerEndOutside.add(onGrabEnd);
        }
      }
      print(`[FriendGrab] onboarding practice armed on ${target.name}`);
      return true;
    };

    if (!tryWireListeners()) {
      // GlobeGrab / ClockGrab / PaletteGrab often wire a moment after enable.
      const retryDelays = [0.2, 0.5, 1.0, 1.6];
      for (let i = 0; i < retryDelays.length; i++) {
        const retry = this.createEvent('DelayedCallbackEvent');
        retry.bind(() => {
          if (!tryWireListeners() && i === retryDelays.length - 1) {
            print(
              `[FriendGrab] onboarding no grab handler on ${target.name} — using timeout`
            );
          }
        });
        retry.reset(retryDelays[i]);
      }
    }

    const timeoutSec = Math.max(3, this.onboardingPracticeTimeoutSec);
    const timeout = this.createEvent('DelayedCallbackEvent');
    timeout.bind(() => {
      if (this.onboardingPracticeDone || token !== this.onboardingToken) {
        return;
      }
      print('[FriendGrab] onboarding practice waiting for grab-release');
      this.showSpeech('Try grabbing it, then release.', true, null);
      timeout.reset(timeoutSec);
    });
    timeout.reset(timeoutSec);

    // Nudge only if they still haven't practiced (don't nag after a mid-speech grab).
    const tip = this.createEvent('DelayedCallbackEvent');
    tip.bind(() => {
      if (this.onboardingPracticeDone || token !== this.onboardingToken) {
        return;
      }
      this.showSpeech('Try grabbing it, then release.', true, null);
    });
    tip.reset(Math.min(8, Math.max(5.5, timeoutSec * 0.45)));
  }

  private findInteractableInTree(root: SceneObject): InteractableLike | null {
    if (isNull(root)) {
      return null;
    }
    const scripts = root.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      const candidate = scripts[i] as InteractableLike;
      if (
        !isNull(candidate) &&
        (candidate.onDragStart !== undefined ||
          candidate.onTriggerEnd !== undefined ||
          candidate.targetingMode !== undefined)
      ) {
        return candidate;
      }
    }
    const childCount = root.getChildrenCount();
    for (let i = 0; i < childCount; i++) {
      const nested = this.findInteractableInTree(root.getChild(i));
      if (!isNull(nested)) {
        return nested;
      }
    }
    return null;
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

  private startFollowingUser(reason: string): void {
    if (!this.enableFollowAfterOnboarding) {
      return;
    }
    this.followActive = true;
    if (!this.followLoggedStart) {
      this.followLoggedStart = true;
      print(`[FriendGrab] follow started (${reason})`);
    }
  }

  private updateFollowUser(): void {
    if (!this.followActive || !this.enableFollowAfterOnboarding) {
      return;
    }
    if (this.moveActive) {
      return;
    }
    const self = this.getSceneObject();
    if (!isNull(self) && !self.enabled) {
      self.enabled = true;
    }

    const preferredCamera = this.findCameraObject();
    if (!isNull(preferredCamera)) {
      this.lookAtCamera = preferredCamera;
    }
    if (!this.isValidSceneObject(this.lookAtCamera)) {
      this.lookAtCamera = null;
      return;
    }

    const camTransform = (this.lookAtCamera as SceneObject).getTransform();
    const camPos = camTransform.getWorldPosition();

    let forward = camTransform.forward;
    if (isNull(forward)) {
      forward = new vec3(0, 0, -1);
    }
    // Lens world forward is -Z; invert camera forward so Buddy stays in front of the user.
    let fx = -forward.x;
    let fz = -forward.z;
    let flatLen = Math.sqrt(fx * fx + fz * fz);
    if (flatLen < 0.001) {
      fx = 0;
      fz = -1;
      flatLen = 1;
    }
    fx /= flatLen;
    fz /= flatLen;

    // Right vector from flattened forward (XZ).
    const rx = -fz;
    const rz = fx;

    // Spectacles comfort bounds: keep Buddy centered and inside forward FOV
    // even if inspector values were previously tuned too far to the right/far.
    const dist = Math.max(18, Math.min(30, this.followDistanceCm));
    const side = Math.max(-2, Math.min(2, this.followSideOffsetCm));
    const height = this.followHeightOffsetCm;
    const target = new vec3(
      camPos.x + fx * dist + rx * side,
      camPos.y + height,
      camPos.z + fz * dist + rz * side
    );

    const transform = this.getSceneObject().getTransform();
    const current = transform.getWorldPosition();
    const dx = target.x - current.x;
    const dyRaw = target.y - current.y;
    const dz = target.z - current.z;
    const horizontalGap = Math.sqrt(dx * dx + dz * dz);
    const gap = Math.sqrt(dx * dx + dyRaw * dyRaw + dz * dz);
    const snapThresholdCm = Math.max(100, dist * 3);
    if (gap > snapThresholdCm) {
      transform.setWorldPosition(target);
      this.captureIdleBasePosition();
      if (this.debugLogging) {
        print(`[FriendGrab] follow snap (gap=${gap.toFixed(1)}cm)`);
      }
      return;
    }
    const verticalDeadzoneCm = 1.25;
    if (
      horizontalGap < Math.max(0.5, this.followMinMoveCm) &&
      Math.abs(dyRaw) < verticalDeadzoneCm
    ) {
      return;
    }

    const dt = Math.max(0.001, getDeltaTime());
    const speed = Math.max(0.5, this.followLerpSpeed);
    const t = 1 - Math.exp(-speed * dt);
    const maxVerticalStepCm = Math.max(0.2, 10 * dt);
    let dy = 0;
    if (Math.abs(dyRaw) >= verticalDeadzoneCm) {
      dy = Math.max(-maxVerticalStepCm, Math.min(maxVerticalStepCm, dyRaw));
    }
    const verticalT = Math.min(1, t * 0.45);
    const next = new vec3(
      current.x + dx * t,
      current.y + dy * verticalT,
      current.z + dz * t
    );
    transform.setWorldPosition(next);
    this.captureIdleBasePosition();
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

    // Follow motion already has enough life; bobbing while following looks jumpy on Specs.
    if (this.followActive) {
      this.resetIdleBobOffset();
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
    this.lookAtCamera = this.findCameraObject();
    if (!this.isValidSceneObject(this.lookAtCamera)) {
      this.lookAtCamera = null;
      print('[FriendGrab] look-at skipped: Camera Object not found');
      return;
    }

    const anchor = this.getSceneObject();
    let lookAt = anchor.getComponent('Component.LookAtComponent') as LookAtComponent;
    if (isNull(lookAt)) {
      lookAt = anchor.createComponent('Component.LookAtComponent') as LookAtComponent;
    }

    try {
      lookAt.target = this.lookAtCamera as SceneObject;
    } catch (e) {
      const now = getTime();
      if (now - this.lastLookAtInvalidTargetLogAt > 1.5) {
        this.lastLookAtInvalidTargetLogAt = now;
        print('[FriendGrab] look-at skipped: invalid camera target: ' + e);
      }
      this.lookAtCamera = null;
      return;
    }
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
    if (!this.isValidSceneObject(this.lookAtCamera)) {
      this.lookAtCamera = null;
      this.lookAt.enabled = false;
      return;
    }

    // Always keep component config correct; never leave it enabled by accident.
    try {
      this.lookAt.target = this.lookAtCamera;
    } catch (e) {
      print('[FriendGrab] look-at target refresh failed: ' + e);
      this.lookAtCamera = null;
      this.lookAt.enabled = false;
      return;
    }
    this.lookAt.aimVectors = LookAtComponent.AimVectors.ZAimYUp;

    const forceFollowLookAt =
      this.lookAtAlwaysWhileFollowing &&
      this.followActive &&
      this.enableFollowAfterOnboarding &&
      !this.moveActive;
    if (forceFollowLookAt) {
      this.setLookAtActive(true);
      this.lookAt.enabled = true;
      return;
    }

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
    // Prefer AnchorController camera input first (usually the tracked device camera).
    const anchorCamera = this.findAnchorControllerCamera();
    if (this.isUsableCameraObject(anchorCamera)) {
      return anchorCamera;
    }

    // Then prefer explicit scene camera objects.
    const preferredNames = ['Camera Object', 'Device Camera', 'Camera'];
    for (let i = 0; i < preferredNames.length; i++) {
      const found = this.findObjectByNameInScene(preferredNames[i]);
      if (this.isUsableCameraObject(found)) {
        return found;
      }
    }
    const fallback = this.findObjectWithCameraComponent();
    return this.isUsableCameraObject(fallback) ? fallback : null;
  }

  private findAnchorControllerCamera(): SceneObject | null {
    const rootCount = global.scene.getRootObjectsCount();
    for (let i = 0; i < rootCount; i++) {
      const found = this.findAnchorControllerCameraRecursive(global.scene.getRootObject(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private findAnchorControllerCameraRecursive(node: SceneObject): SceneObject | null {
    if (isNull(node)) {
      return null;
    }
    const scripts = node.getComponents('Component.ScriptComponent');
    for (let i = 0; i < scripts.length; i++) {
      try {
        const candidate = scripts[i] as ScriptComponent & { camera?: SceneObject };
        if (isNull(candidate) || isNull(candidate.camera)) {
          continue;
        }
        const camObj = candidate.camera as SceneObject;
        if (this.isUsableCameraObject(camObj)) {
          return camObj;
        }
      } catch (_e) {
        // Ignore stale script/camera bindings and continue searching.
      }
    }
    for (let i = 0; i < node.getChildrenCount(); i++) {
      const found = this.findAnchorControllerCameraRecursive(node.getChild(i));
      if (!isNull(found)) {
        return found;
      }
    }
    return null;
  }

  private isUsableCameraObject(node: SceneObject | null): boolean {
    if (!this.isValidSceneObject(node)) {
      return false;
    }
    try {
      const camera = (node as SceneObject).getComponent('Component.Camera') as Camera;
      return !isNull(camera);
    } catch (_e) {
      return false;
    }
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

  private isValidSceneObject(node: SceneObject | null): boolean {
    if (isNull(node)) {
      return false;
    }
    try {
      const t = node.getTransform();
      return !isNull(t);
    } catch (_e) {
      return false;
    }
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
    shape.size = this.getEffectiveColliderSize();
    colliderLike.shape = shape;

    return collider;
  }

  private getEffectiveColliderSize(): vec3 {
    const configured = this.colliderSize || new vec3(0, 0, 0);
    const min = FriendGrab.MIN_COLLIDER_SIZE;
    return new vec3(
      Math.max(min.x, configured.x),
      Math.max(min.y, configured.y),
      Math.max(min.z, configured.z)
    );
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

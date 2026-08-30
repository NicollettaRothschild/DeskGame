import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import { InteractableManipulation } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation';
import {
  ArvisGhostSpeechBubble,
  CompanionNameTag,
} from './ArvisGhostSpeechBubble';
import { estimateSpeechDurationSec, FlowGardenTTS } from './FlowGardenTTS';
import {
  getSharedArvisAgentChat,
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
import { GoalLeaderboardBoard } from './GoalLeaderboardBoard';
import { LeaderboardGrab } from './LeaderboardGrab';

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
  useFilteredPinch?: boolean;
  onTriggerStart?: { add: (cb: () => void) => void };
  onInteractorTriggerStart?: { add: (cb: () => void) => void };
  onDragStart?: { add: (cb: () => void) => void };
  onDragEnd?: { add: (cb: () => void) => void };
  onTriggerEnd?: { add: (cb: () => void) => void };
  onTriggerEndOutside?: { add: (cb: () => void) => void };
  onTriggerCanceled?: { add: (cb: () => void) => void };
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
  enablePetReaction: boolean = true;

  @input
  @allowUndefined
  petSoundTrack!: AudioTrackAsset;

  @input('float')
  petReactionCooldownSec: number = 2.5;

  @input
  @label('Pet Poke Collider Size')
  petPokeColliderSize: vec3 = new vec3(3.4, 4.2, 3.4);

  @input
  @label('Pet Poke Local Position')
  petPokeLocalPosition: vec3 = new vec3(0, 0, 0.8);

  @input
  petDialogueLines: string[] = [
    'Aww, thank you!',
    'That tickles!',
    'Hehe, I like that!',
    "You're a good friend.",
  ];

  @input
  @label('Companion Name')
  @hint('Name shown above this companion when multiple AI companions are active.')
  companionName: string = 'Buddy';

  @input
  @label('Show Name Tag With Multiple Companions')
  @hint('Display this name tag when more than one enabled companion is present.')
  showNameTagWhenMultiple: boolean = true;

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
  @hint('Minimum seconds before repeating onboarding practice reminders')
  onboardingPracticeTimeoutSec: number = 14;

  @input('float')
  @label('Practice First Reminder (sec)')
  @hint('Delay before the first "grab then release" reminder during a practice step')
  onboardingPracticeFirstReminderSec: number = 7.5;

  @input('int')
  @label('Practice Reminder Max Count')
  @hint('Maximum reminder lines spoken per practice step (0 = unlimited)')
  onboardingPracticeReminderMaxCount: number = 2;

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

  @input('float')
  @label('Onboarding Object Spacing (cm)')
  onboardingObjectSpacingCm: number = 18;

  @input
  @label('Welcome Line')
  onboardingWelcomeLine: string =
    "Hi! I’m your companion. Let’s set up your space! I’ll give you a few tools, and you can put them wherever they work best for you.";

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
    "Here’s your clock. Put it somewhere easy to check while you work.";

  @input
  @allowUndefined
  @label('Tour Palette')
  onboardingPalette!: SceneObject;

  @input
  @label('Include Palette In Onboarding')
  @hint('Archived for now. Enable this only when the palette tour returns.')
  onboardingIncludePalette: boolean = false;

  @input
  @label('Palette Line')
  onboardingPaletteLine: string =
    "This is your palette. Paint your world with it! Put it somewhere you can reach while you work.";

  @input
  @allowUndefined
  @label('Tour Planter')
  onboardingPlanter!: SceneObject;

  @input
  @label('Planter Line')
  onboardingPlanterLine: string =
    "This is your garden. Your goals will grow into plants here. Find a good spot for your extra planters.";

  @input
  @allowUndefined
  @label('Tour Post-its')
  onboardingPostIt!: SceneObject;

  @input
  @label('Post-it Line')
  onboardingPostItLine: string =
    "These are your sticky notes. Pull one out and start speaking, and I’ll write down what you say.";

  @input
  @allowUndefined
  @label('Tour Trash')
  onboardingTrash!: SceneObject;

  @input
  @label('Trash Line')
  onboardingTrashLine: string =
    "And here’s the trash. Put it wherever you like, then drop things in when you don’t need them anymore.";

  @input
  @allowUndefined
  @label('Tour Leaderboard')
  onboardingLeaderboard!: SceneObject;

  @input
  @label('Leaderboard Line')
  onboardingLeaderboardLine: string =
    "And here's your distance leaderboard. Grab it to place it anywhere in your space.";

  @input
  @label('Goal Prompt Line')
  @hint('Spoken after the tour; Friend waits for the player to say a goal')
  onboardingGoalPromptLine: string =
    "What goal should we grow together? Say something like: I want to walk 20 meters.";

  @input
  @label('Goal Planted Pot Line')
  onboardingGoalSeedLine: string =
    "There it is! Every goal starts as a seed. Put your planter somewhere you’ll see it, then give it some water. Your plant will grow as you make progress.";

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
  @label('Enable Goal Leaderboard')
  @hint('Submits completed goals to Snap Leaderboard API (requires a LeaderboardModule asset).')
  enableGoalLeaderboard: boolean = true;

  @input
  @allowUndefined
  @label('Goal Leaderboard Module')
  goalLeaderboardModule!: LeaderboardModule;

  @input
  @label('Goal Leaderboard Name')
  goalLeaderboardName: string = 'DeskGameDistance';

  @input('float')
  @label('Goal Leaderboard TTL (sec)')
  goalLeaderboardTtlSec: number = 31536000;

  @input('int')
  @label('Non-distance Goal Score')
  @hint('Score submitted when a completed goal is not a walk/run distance goal.')
  nonDistanceGoalScore: number = 100;

  @input
  @label('Distance Goals Only')
  @hint('Only walk/run distance goals are submitted to the distance leaderboard.')
  leaderboardDistanceGoalsOnly: boolean = true;

  @input
  @label('Fetch Leaderboard After Submit')
  fetchLeaderboardAfterSubmit: boolean = true;

  @input('int')
  @label('Leaderboard Users Limit')
  leaderboardUsersLimit: number = 5;

  @input
  @label('Leaderboard Use Global')
  @hint('When off, fetches friends leaderboard instead of global.')
  leaderboardUseGlobal: boolean = true;

  @input
  @label('Announce Leaderboard Rank')
  @hint('Speak the user rank after a successful score submit.')
  announceLeaderboardRank: boolean = false;

  @input
  @hint('Buddy follows the camera until manually placed; say "hey friend" to resume')
  enableFollowAfterOnboarding: boolean = true;

  /** How far ahead of the user Buddy stays (cm, along look direction). */
  @input('float')
  followDistanceCm: number = 45;

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
  private petPokeTarget: SceneObject | null = null;
  private petPokeInteractable: InteractableLike | null = null;
  private petInteractionWired = false;
  private moveInteractionWired = false;
  private moveBindAttempts = 0;
  private moveActive = false;
  private grabStartWorldPosition: vec3 | null = null;
  private companionTalkActive = false;
  private grabAudioPlayer: AudioComponent | null = null;
  private resolvedGrabTrack: AudioTrackAsset | null = null;
  private resolvedReleaseTrack: AudioTrackAsset | null = null;
  private speechBubble: ArvisGhostSpeechBubble | null = null;
  private companionNameTag: CompanionNameTag | null = null;
  private lookAt: LookAtComponent | null = null;
  private lookAtCamera: SceneObject | null = null;
  private lookAtTargetProxy: SceneObject | null = null;
  private lookAtActive = false;
  private idleBaseLocalPos: vec3 | null = null;
  private lookAtDistanceLogTimer = 0;
  private lookAtLoggedSetup = false;
  private lastLookAtInvalidTargetLogAt = -9999;
  private nextLookAtRetryAt = 0;
  private onboardingActive = false;
  private onboardingToken = 0;
  private onboardingStepRunId = 0;
  private onboardingGoalListening = false;
  private goalCompletionWired = false;
  private lastGoalCompleteUtterance = '';
  private lastGoalCompleteAt = 0;
  private followActive = false;
  private followLoggedStart = false;
  private manualPlacementActive = false;
  private workspaceResetAt = 0;
  private goalLeaderboard: Leaderboard | null = null;
  private resolvingGoalLeaderboard = false;
  private goalLeaderboardWaiters: Array<(leaderboard: Leaderboard | null) => void> = [];
  private leaderboardModuleMissingLogged = false;
  private generatedLeaderboard: SceneObject | null = null;
  private nextPetReactionAt = 0;
  private petDialogueIndex = 0;
  private followPausedByVoice = false;
  private static readonly MIN_COLLIDER_SIZE = new vec3(2.1, 2.8, 2.1);
  private static readonly MANUAL_PLACEMENT_THRESHOLD_CM = 4;

  onAwake(): void {
    this.ensureLeaderboardPanel();
    this.ensurePetPokeTarget();
    this.createEvent('OnStartEvent').bind(() => {
      registerFriendGrab(this);
      this.captureIdleBasePosition();
      this.ensureFriendSounds();
      this.ensureSpeechBubble();
      this.ensureCompanionNameTag();
      this.resolveTts();
      this.tryWireMoveInteraction();
      this.wirePetPokeInteraction();
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

  onDestroy(): void {
    if (!isNull(this.companionNameTag)) {
      this.companionNameTag.dispose();
      this.companionNameTag = null;
    }
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
    let resolved = track;
    if (isNull(resolved)) {
      try {
        resolved =
          label.toLowerCase().indexOf('thank') >= 0
            ? (requireAsset('Audio/friend_thanks.wav') as AudioTrackAsset)
            : (requireAsset('Audio/friend_whee.wav') as AudioTrackAsset);
      } catch (_error) {
        resolved = null;
      }
    }
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

    // A movable object should use pinch/ray targeting. Poke is reserved for
    // the separate pet target because SIK disables Poke on manipulated objects.
    interactable.targetingMode = 3;
    interactable.ignoreInteractionPlane = true;
    interactable.keepHoverOnTrigger = true;
    interactable.enableInstantDrag = true;
    if (interactable.useFilteredPinch !== undefined) {
      interactable.useFilteredPinch = true;
    }

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

  private ensurePetPokeTarget(): void {
    const friend = this.getSceneObject();
    let target = this.findObjectByName(friend, 'FriendPetPokeTarget');
    if (isNull(target) || target === friend) {
      target = global.scene.createSceneObject('FriendPetPokeTarget');
      target.setParent(friend);
    }
    target.layer = friend.layer;
    target.enabled = this.enablePetReaction;
    target.getTransform().setLocalPosition(this.petPokeLocalPosition);
    target.getTransform().setLocalRotation(quat.quatIdentity());
    target.getTransform().setLocalScale(vec3.one());

    let collider = target.getComponent('Component.ColliderComponent') as ColliderComponent;
    if (isNull(collider)) {
      collider = target.createComponent('Component.ColliderComponent') as ColliderComponent;
    }
    const colliderLike = collider as unknown as {
      enabled?: boolean;
      intangible?: boolean;
      fitVisual?: boolean;
      debugDrawEnabled?: boolean;
      shape?: { size?: vec3 };
    };
    colliderLike.enabled = this.enablePetReaction;
    // Keep this as a real overlap target so the tracked hand collider can
    // make contact with the pet zone without affecting the companion's grab
    // collider.
    colliderLike.intangible = false;
    colliderLike.fitVisual = false;
    colliderLike.debugDrawEnabled = false;
    const shape = Shape.createBoxShape();
    shape.size = this.petPokeColliderSize;
    colliderLike.shape = shape;

    let interactable = target.getComponent(
      Interactable.getTypeName()
    ) as unknown as InteractableLike;
    if (isNull(interactable)) {
      interactable = target.createComponent(Interactable.getTypeName()) as InteractableLike;
    }
    // Poke is the open-hand/index-finger contact path. Direct would require a
    // pinch, which makes the pet interaction feel like another grab.
    interactable.targetingMode = 4;
    interactable.ignoreInteractionPlane = true;
    interactable.keepHoverOnTrigger = false;
    interactable.enableInstantDrag = false;
    const interactableOptions = interactable as unknown as {
      allowMultipleInteractors?: boolean;
      enablePokeDirectionality?: boolean;
    };
    interactableOptions.allowMultipleInteractors = true;
    interactableOptions.enablePokeDirectionality = false;
    (interactable as ScriptComponent).enabled = this.enablePetReaction;

    this.petPokeTarget = target;
    this.petPokeInteractable = interactable;
  }

  private wirePetPokeInteraction(): void {
    if (this.petInteractionWired || !this.enablePetReaction) {
      return;
    }
    if (isNull(this.petPokeInteractable)) {
      this.ensurePetPokeTarget();
    }
    const interactable = this.petPokeInteractable;
    if (isNull(interactable) || !interactable.onTriggerStart) {
      const retry = this.createEvent('DelayedCallbackEvent');
      retry.bind(() => this.wirePetPokeInteraction());
      retry.reset(0.1);
      return;
    }

    interactable.onTriggerStart.add(() => this.onFriendPet());
    this.petInteractionWired = true;
    print('[FriendGrab] pet poke interaction wired');
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
    if (interactable.onTriggerStart) {
      interactable.onTriggerStart.add(onGrabStart);
    }
    if (interactable.onInteractorTriggerStart) {
      interactable.onInteractorTriggerStart.add(onGrabStart);
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
    if (interactable.onTriggerCanceled) {
      interactable.onTriggerCanceled.add(onGrabRelease);
    }
    (manipulation as ScriptComponent).enabled = true;
    (interactable as ScriptComponent).enabled = true;

    this.moveInteractionWired = true;
    print('[FriendGrab] grab interaction wired');
  }

  private onFriendPet(): void {
    if (!this.enablePetReaction) {
      return;
    }

    const now = getTime();
    if (now < this.nextPetReactionAt) {
      return;
    }
    this.nextPetReactionAt = now + Math.max(0.5, this.petReactionCooldownSec);

    const configuredLines = this.petDialogueLines || [];
    const line =
      configuredLines.length > 0
        ? String(configuredLines[this.petDialogueIndex % configuredLines.length] || '').trim()
        : 'Aww, thank you!';
    this.petDialogueIndex += 1;

    let reactionTrack = !isNull(this.petSoundTrack) ? this.petSoundTrack : null;
    if (isNull(reactionTrack)) {
      try {
        // Keep this literal so Lens Studio includes the audio in the device bundle.
        reactionTrack = requireAsset('Audio/friend_whee.wav') as AudioTrackAsset;
      } catch (_e) {
        reactionTrack = null;
      }
    }
    if (!isNull(reactionTrack)) {
      this.playFriendSound(reactionTrack, 0.65, 'pet');
    }
    this.showSpeech(line || 'Aww, thank you!', true, null);
    if (this.debugLogging) {
      print(`[FriendGrab] pet reaction: ${line}`);
    }
  }

  private onFriendGrabStart(): void {
    if (this.moveActive) {
      return;
    }
    this.moveActive = true;
    const startPosition = this.getSceneObject().getTransform().getWorldPosition();
    this.grabStartWorldPosition = new vec3(
      startPosition.x,
      startPosition.y,
      startPosition.z
    );
    this.companionTalkActive =
      !this.onboardingActive && this.beginCompanionGrabTalk();
    this.resetIdleBobOffset();
    // Keep the physical SFX, but never speak a grab quip. Grabbing is now the
    // companion's hold-to-talk gesture, so "Whee!" would pollute the mic and
    // can repeat when SIK reports more than one end/start event.
    this.playFriendSound(this.resolvedGrabTrack, this.grabSoundVolume, 'grab');
    if (this.debugLogging) {
      print(
        `[FriendGrab] grab start${this.companionTalkActive ? ' — companion voice capture active' : ''}`
      );
    }
  }

  private onFriendGrabRelease(): void {
    if (!this.moveActive) {
      return;
    }
    const wasManuallyMoved = this.wasMovedDuringGrab();
    this.moveActive = false;
    this.grabStartWorldPosition = null;
    const wasCompanionTalkActive = this.companionTalkActive;
    this.companionTalkActive = false;
    if (wasCompanionTalkActive) {
      const agent = getSharedArvisAgentChat();
      if (!isNull(agent)) {
        agent.endAgentTalkAndSend();
      }
    }
    this.captureIdleBasePosition();
    if (wasManuallyMoved) {
      // Keep a deliberate drag at its dropped position. A short grab remains
      // the companion voice gesture and continues to follow the user.
      this.manualPlacementActive = true;
      this.followPausedByVoice = true;
      this.followActive = false;
      this.setLookAtActive(false);
      if (!isNull(this.lookAt)) {
        this.lookAt.enabled = false;
      }
      if (this.debugLogging) {
        print('[FriendGrab] manual placement saved — follow paused');
      }
    }
    // Release feedback is audio-only; do not speak "Thanks!" after a voice
    // capture because it can be heard as another command on the next session.
    this.playFriendSound(this.resolvedReleaseTrack, this.releaseSoundVolume, 'release');
    if (this.debugLogging) {
      print(
        `[FriendGrab] grab end${wasCompanionTalkActive ? ' — companion voice capture submitted' : ''}`
      );
    }
  }

  private beginCompanionGrabTalk(): boolean {
    const agent = getSharedArvisAgentChat();
    if (isNull(agent)) {
      return false;
    }
    return agent.beginCompanionGrabTalk();
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
    label: 'grab' | 'release' | 'pet'
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

  private ensureCompanionNameTag(): void {
    if (!isNull(this.companionNameTag)) {
      return;
    }

    this.companionNameTag = new CompanionNameTag(this.getSceneObject(), this, {
      name: this.companionName,
      scaleCompensation: Math.max(0.1, this.bubbleScaleCompensation),
      heightOffset: Math.max(0.1, this.bubbleHeightOffset + 0.35),
      showWhenMultiple: this.showNameTagWhenMultiple,
      debugLogging: this.debugLogging,
    });
  }

  private ensureLeaderboardPanel(): SceneObject | null {
    const anchor = this.findAnchorController() as
      | (ScriptComponent & {
          widgetParent?: SceneObject;
          leaderboardRoot?: SceneObject;
        })
      | null;

    if (!isNull(this.onboardingLeaderboard)) {
      (this.onboardingLeaderboard as SceneObject).enabled = true;
      this.ensureLeaderboardGrabOnPanel(this.onboardingLeaderboard, anchor);
      return this.onboardingLeaderboard;
    }
    if (!isNull(this.generatedLeaderboard)) {
      (this.generatedLeaderboard as SceneObject).enabled = true;
      this.ensureLeaderboardGrabOnPanel(this.generatedLeaderboard, anchor);
      return this.generatedLeaderboard;
    }

    const existing = this.findObjectByNameInScene('Leaderboard');
    if (!isNull(existing)) {
      const shouldReposition = this.shouldRepositionLeaderboard(existing);
      existing.enabled = true;
      this.generatedLeaderboard = existing;
      this.onboardingLeaderboard = existing;
      this.ensureLeaderboardGrabOnPanel(existing, anchor);
      if (!isNull(anchor)) {
        anchor.leaderboardRoot = existing;
      }
      if (shouldReposition) {
        this.placeObjectInFrontOfFriend(existing, 'leaderboard');
      }
      if (this.debugLogging) {
        print('[FriendGrab] reusing existing leaderboard panel');
      }
      return existing;
    }

    const panel = global.scene.createSceneObject('Leaderboard');
    panel.enabled = true;
    panel.layer = this.getSceneObject().layer;
    if (!isNull(anchor) && !isNull(anchor.widgetParent)) {
      panel.setParent(anchor.widgetParent as SceneObject);
    }
    panel.getTransform().setWorldRotation(
      this.getSceneObject().getTransform().getWorldRotation()
    );
    panel.getTransform().setWorldScale(vec3.one());

    const board = panel.createComponent(
      GoalLeaderboardBoard.getTypeName()
    ) as GoalLeaderboardBoard;
    board.leaderboardName = this.goalLeaderboardName;
    board.leaderboardTtlSec = this.goalLeaderboardTtlSec;
    board.usersLimit = this.leaderboardUsersLimit;
    board.useGlobal = this.leaderboardUseGlobal;

    // Build the native BackPlate/Interactable before adding the movement
    // helper. LeaderboardGrab defers its wiring until BackPlate's OnStart, but
    // this ordering also keeps the panel's single interaction target clear.
    this.ensureLeaderboardGrabOnPanel(panel, anchor);

    if (!isNull(anchor)) {
      anchor.leaderboardRoot = panel;
    }
    this.generatedLeaderboard = panel;
    this.onboardingLeaderboard = panel;
    this.placeObjectInFrontOfFriend(panel, 'leaderboard');
    print('[FriendGrab] created placeable UIKit leaderboard panel');
    return panel;
  }

  private ensureLeaderboardGrabOnPanel(
    panel: SceneObject,
    anchor: ScriptComponent | null
  ): void {
    if (isNull(panel)) {
      return;
    }

    let grab = panel.getComponent(LeaderboardGrab.getTypeName()) as LeaderboardGrab;
    if (isNull(grab)) {
      grab = panel.createComponent(LeaderboardGrab.getTypeName()) as LeaderboardGrab;
    }
    if (isNull(grab)) {
      return;
    }

    if (!isNull(anchor)) {
      grab.anchorController = anchor;
    }
    // Give the whole panel a generous grab target; the visual itself is much
    // smaller than this on Specs and has no separate move handle.
    grab.colliderSize = new vec3(100, 80, 24);
    grab.requestMoveInteractionWire();
  }

  private shouldRepositionLeaderboard(panel: SceneObject): boolean {
    if (isNull(panel)) {
      return false;
    }
    const friendPos = this.getSceneObject().getTransform().getWorldPosition();
    const panelPos = panel.getTransform().getWorldPosition();
    const dx = panelPos.x - friendPos.x;
    const dz = panelPos.z - friendPos.z;
    const horizontal = Math.sqrt(dx * dx + dz * dz);
    const vertical = Math.abs(panelPos.y - friendPos.y);
    // Recover leaderboard if it drifted far away, got restored at origin, or ended up too high/low.
    return horizontal > 220 || horizontal < 4 || vertical > 130;
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

    const steps = [
      {
        key: 'clock',
        object: resolve(this.onboardingClock, 'Clock'),
        line: this.onboardingClockLine,
        requirePractice: true,
      },
      {
        key: 'postit',
        object: resolve(this.onboardingPostIt, 'PostItNotes'),
        line: this.onboardingPostItLine,
        requirePractice: true,
      },
      {
        key: 'trash',
        object: resolve(this.onboardingTrash, 'TrashBin'),
        line: this.onboardingTrashLine,
        requirePractice: true,
      },
      {
        key: 'leaderboard',
        object:
          resolve(this.onboardingLeaderboard, 'Leaderboard') ||
          this.ensureLeaderboardPanel(),
        line: this.onboardingLeaderboardLine,
        requirePractice: true,
      },
      // Planter stack is skipped — a planted goal pot is gifted after the goal prompt.
    ];

    if (this.onboardingIncludePalette) {
      steps.splice(1, 0, {
        key: 'palette',
        object: resolve(this.onboardingPalette, 'palette'),
        line: this.onboardingPaletteLine,
        requirePractice: true,
      });
    }
    return steps;
  }

  private hideOnboardingTourObjects(): void {
    const steps = this.getOnboardingTourSteps();
    for (let i = 0; i < steps.length; i++) {
      const obj = steps[i].object;
      if (!isNull(obj)) {
        obj.enabled = false;
      }
    }
    // The palette is archived from the tour for now. Keep it hidden during
    // onboarding even if AnchorController restored its saved layout position.
    if (!this.onboardingIncludePalette) {
      const palette = !isNull(this.onboardingPalette)
        ? this.onboardingPalette
        : this.findObjectByNameInScene('palette');
      if (!isNull(palette)) {
        (palette as SceneObject).enabled = false;
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
      } else {
        try {
          const forward = friendTransform.forward;
          if (!isNull(forward)) {
            const forwardLen = Math.sqrt(forward.x * forward.x + forward.z * forward.z);
            if (forwardLen > 0.001) {
              dirX = forward.x / forwardLen;
              dirZ = forward.z / forwardLen;
            }
          }
        } catch (_e) {
          // keep default -Z
        }
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
    } else if (key === 'leaderboard') {
      distance = Math.max(distance, 30);
      height = height - 2;
    } else if (key === 'palette') {
      height = height - 2;
    } else if (key === 'globe') {
      height = height + 2;
    }

    const basePresent = this.resolveOnboardingSpawnPosition(
      friendPos,
      dirX,
      dirZ,
      distance,
      height
    );
    // Keep each tour prop in its own nearby presentation slot. This prevents
    // props that are released without much movement from stacking at one point.
    const slot = this.getOnboardingPresentationSlot(key);
    const spacing = Math.max(10, this.onboardingObjectSpacingCm);
    const rightX = dirZ;
    const rightZ = -dirX;
    const present = new vec3(
      basePresent.x + rightX * slot * spacing,
      basePresent.y,
      basePresent.z + rightZ * slot * spacing
    );
    obj.getTransform().setWorldPosition(present);

    if (this.debugLogging) {
      print(
        `[FriendGrab] present ${key} at ${present.x.toFixed(1)}, ${present.y.toFixed(1)}, ${present.z.toFixed(1)}`
      );
    }
  }

  private getOnboardingPresentationSlot(key: string): number {
    switch (key) {
      case 'clock':
        return -2;
      case 'palette':
        return -1;
      case 'postit':
        return 0;
      case 'trash':
        return 1;
      case 'leaderboard':
        return 2;
      default:
        return 0;
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
    const preferred =
      "Hey there! I'm your companion, and I've got some objects for you that you can add to your space one by one.";
    const raw = String(this.onboardingWelcomeLine || '').trim();
    if (!raw) {
      return preferred;
    }
    if (
      /desk\s+buddy/i.test(raw) ||
      /\bthe desk\b/i.test(raw) ||
      (/i'?m your buddy/i.test(raw) && /one piece at a time/i.test(raw))
    ) {
      return preferred;
    }
    return raw;
  }

  private runOnboardingStep(index: number, token: number): void {
    if (token !== this.onboardingToken || !this.enableOnboarding) {
      this.onboardingActive = false;
      return;
    }

    this.onboardingStepRunId += 1;
    const stepRunId = this.onboardingStepRunId;
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

    // Every tour prop must be physically moved and released before the next
    // one is revealed. This is intentionally not bypassed by the legacy toggle.
    const needsPractice = step.requirePractice && !isNull(step.object);

    // Arm grab practice immediately so grabs during the spoken line still count.
    let speechDone = false;
    let practiceDone = !needsPractice;
    let advanceScheduled = false;
    const tryAdvance = (): void => {
      if (
        token !== this.onboardingToken ||
        stepRunId !== this.onboardingStepRunId ||
        advanceScheduled ||
        !speechDone ||
        !practiceDone
      ) {
        return;
      }
      advanceScheduled = true;
      this.delayOnboarding(token, () => this.runOnboardingStep(index + 1, token));
    };

    if (needsPractice) {
      this.waitForOnboardingPractice(
        step.object as SceneObject,
        token,
        stepRunId,
        step.key,
        () => {
          practiceDone = true;
          tryAdvance();
        }
      );
    }

    const line = String(step.line || '').trim();
    const afterSpeech = (): void => {
      if (token !== this.onboardingToken || stepRunId !== this.onboardingStepRunId) {
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
            this.waitForOnboardingPractice(
              pot as SceneObject,
              token,
              this.onboardingStepRunId,
              'goal-pot',
              () => {
                practiceDone = true;
                tryFinish();
              }
            );
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
    speech.beginAgentSession();

    let settled = false;
    const finish = (text: string): void => {
      if (settled || token !== this.onboardingToken) {
        return;
      }
      settled = true;
      this.onboardingGoalListening = false;
      speech.removeTranscriptListener(onTranscript);
      speech.endAgentSession();
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
    const underBuddyDistance = Math.max(16, Math.min(30, distanceCm));
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
      this.submitGoalToLeaderboard(plant);
      this.congratulateGoalComplete(plant);
    });

    const speech = getSharedSpeechRecognition();
    if (isNull(speech)) {
      print('[FriendGrab] goal completion listening armed (walk auto + congrats; no speech)');
      return;
    }
    speech.addTranscriptListener((text, isFinal) => {
      const rawText = String(text || '').trim();
      if (!isFinal && rawText.length < 12 && !this.companionTalkActive) {
        return;
      }
      if (this.onboardingGoalListening) {
        return;
      }
      const normalized = this.normalizeGoalUtterance(text);
      if (this.tryHandleFollowVoiceCommands(normalized)) {
        return;
      }
      // While Buddy is held, short interim text is only a command candidate.
      // Do not let it trigger unrelated goal-completion logic.
      if (!isFinal && this.companionTalkActive) {
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

  private tryHandleFollowVoiceCommands(text: string): boolean {
    const cleaned = String(text || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) {
      return false;
    }

    if (this.isStopFollowingCommand(cleaned)) {
      this.cancelCompanionGrabTalk();
      this.pauseFollowingByVoice();
      return true;
    }

    if (this.followPausedByVoice && this.isHeyFriendWakeCommand(cleaned)) {
      this.resumeFollowingByVoice();
      return true;
    }

    return false;
  }

  private isStopFollowingCommand(cleanedLower: string): boolean {
    const addressedWithWake = cleanedLower.indexOf('hey friend') >= 0;
    if (!addressedWithWake && !this.companionTalkActive) {
      return false;
    }

    if (this.companionTalkActive) {
      return /\b(?:leave me alone|leave us alone|go away|get away|stay there|stop following(?: me| us)?|(?:dont|don t|do not) follow(?: me| us)?|pause following(?: me| us)?|stop tagging along|(?:dont|don t|do not) come with me)\b/.test(
        cleanedLower
      );
    }

    const asksStop =
      cleanedLower.indexOf('stop following') >= 0 ||
      cleanedLower.indexOf('dont follow') >= 0 ||
      cleanedLower.indexOf("don't follow") >= 0 ||
      cleanedLower.indexOf('pause following') >= 0;
    const targetMe =
      cleanedLower.indexOf('me') >= 0 ||
      cleanedLower.indexOf('us') >= 0 ||
      cleanedLower.indexOf('my') >= 0;
    return asksStop && targetMe;
  }

  private cancelCompanionGrabTalk(): void {
    if (!this.companionTalkActive) {
      return;
    }
    this.companionTalkActive = false;
    // If the command is spoken while Buddy is still held, the hide operation
    // can prevent a later SIK release event. Clear the movement latch now.
    this.moveActive = false;
    const agent = getSharedArvisAgentChat();
    if (!isNull(agent)) {
      agent.cancelAgentTalk();
    }
  }

  private isHeyFriendWakeCommand(cleanedLower: string): boolean {
    return /^hey friend(?:\b.*)?$/.test(cleanedLower);
  }

  private pauseFollowingByVoice(): void {
    if (this.followPausedByVoice) {
      return;
    }
    this.followPausedByVoice = true;
    this.followActive = false;
    this.setLookAtActive(false);
    if (!isNull(this.lookAt)) {
      this.lookAt.enabled = false;
    }
    this.setFriendVisualState(false);
    this.hideSpeechBubble();
    print('[FriendGrab] follow paused by voice');
  }

  private resumeFollowingByVoice(): void {
    this.manualPlacementActive = false;
    this.followPausedByVoice = false;
    this.setFriendVisualState(true);
    this.startFollowingUser('voice-resume');
    this.followActive = true;
    this.lookAtCamera = this.findCameraObject();
    this.showSpeech("I'm back.", true, null);
    print('[FriendGrab] follow resumed by voice');
  }

  private wasMovedDuringGrab(): boolean {
    if (isNull(this.grabStartWorldPosition)) {
      return false;
    }
    const current = this.getSceneObject().getTransform().getWorldPosition();
    const start = this.grabStartWorldPosition;
    const dx = current.x - start.x;
    const dy = current.y - start.y;
    const dz = current.z - start.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return distance >= FriendGrab.MANUAL_PLACEMENT_THRESHOLD_CM;
  }

  private setFriendVisualState(visible: boolean): void {
    const root = this.getSceneObject();
    if (isNull(root)) {
      return;
    }
    root.enabled = true;

    const stack: SceneObject[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (isNull(node)) {
        continue;
      }

      const visuals = node.getComponents('Component.RenderMeshVisual') as RenderMeshVisual[];
      for (let i = 0; i < visuals.length; i++) {
        const visual = visuals[i];
        if (!isNull(visual)) {
          visual.enabled = visible;
        }
      }
      const texts = node.getComponents('Component.Text3D') as Text3D[];
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        if (!isNull(text)) {
          text.enabled = visible;
        }
      }
      const colliders = node.getComponents('Component.ColliderComponent') as ColliderComponent[];
      for (let i = 0; i < colliders.length; i++) {
        const collider = colliders[i];
        if (!isNull(collider)) {
          collider.enabled = visible;
        }
      }

      for (let i = 0; i < node.getChildrenCount(); i++) {
        stack.push(node.getChild(i));
      }
    }
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

  private submitGoalToLeaderboard(plant: PlantLifecycle | null): void {
    if (!this.enableGoalLeaderboard || isNull(plant)) {
      return;
    }
    const leaderboardModule = this.resolveGoalLeaderboardModule();
    if (isNull(leaderboardModule)) {
      if (!this.leaderboardModuleMissingLogged) {
        this.leaderboardModuleMissingLogged = true;
        print('[FriendGrab] goal leaderboard module unavailable');
      }
      return;
    }

    const score = this.computeLeaderboardScore(plant);
    if (isNull(score)) {
      print('[FriendGrab] leaderboard skipped: completed goal has no distance');
      return;
    }
    this.resolveGoalLeaderboard((leaderboard) => {
      if (isNull(leaderboard)) {
        return;
      }
      leaderboard.submitScore(
        score,
        (record) => {
          const rank =
            !isNull(record) && record.globalExactRank !== undefined ? record.globalExactRank : null;
          print(
            `[FriendGrab] leaderboard score submitted=${score}${!isNull(rank) ? ` rank=${rank}` : ''}`
          );
          if (this.announceLeaderboardRank && !isNull(rank)) {
            this.showSpeech(`Leaderboard updated. You're now rank ${rank}.`, true, null);
          }
          if (this.fetchLeaderboardAfterSubmit) {
            this.fetchLeaderboardSnapshot(leaderboard as Leaderboard);
          }
        },
        (status) => {
          print(`[FriendGrab] leaderboard submit failed status=${status}`);
        }
      );
    });
  }

  private computeLeaderboardScore(plant: PlantLifecycle): number | null {
    const goalMeters = Math.max(0, plant.getWalkGoalMeters());
    const walkedMeters = Math.max(0, plant.getWalkedMeters());
    const distanceMeters = Math.max(goalMeters, walkedMeters);
    if (distanceMeters > 0) {
      // Submit in centimeters to preserve precision while keeping integer score.
      return Math.max(1, Math.round(distanceMeters * 100));
    }
    if (this.leaderboardDistanceGoalsOnly) {
      return null;
    }
    return Math.max(1, Math.floor(this.nonDistanceGoalScore));
  }

  private resolveGoalLeaderboard(onResolved: (leaderboard: Leaderboard | null) => void): void {
    if (!isNull(this.goalLeaderboard)) {
      onResolved(this.goalLeaderboard as Leaderboard);
      return;
    }

    this.goalLeaderboardWaiters.push(onResolved);
    if (this.resolvingGoalLeaderboard) {
      return;
    }
    this.resolvingGoalLeaderboard = true;

    const options = Leaderboard.CreateOptions.create();
    const configuredName = String(this.goalLeaderboardName || '').trim();
    options.name = configuredName.length > 0 ? configuredName : 'DeskGameDistance';
    options.orderingType = Leaderboard.OrderingType.Descending;
    options.ttlSeconds = Math.max(0, Math.floor(this.goalLeaderboardTtlSec));

    const leaderboardModule = this.resolveGoalLeaderboardModule();
    if (isNull(leaderboardModule)) {
      this.resolvingGoalLeaderboard = false;
      const waiters = this.goalLeaderboardWaiters.slice();
      this.goalLeaderboardWaiters = [];
      for (let i = 0; i < waiters.length; i++) {
        waiters[i](null);
      }
      return;
    }

    leaderboardModule.getLeaderboard(
      options,
      (leaderboard) => {
        this.goalLeaderboard = leaderboard;
        this.resolvingGoalLeaderboard = false;
        const waiters = this.goalLeaderboardWaiters.slice();
        this.goalLeaderboardWaiters = [];
        for (let i = 0; i < waiters.length; i++) {
          waiters[i](leaderboard);
        }
      },
      (message) => {
        print(`[FriendGrab] leaderboard get failed: ${String(message || 'unknown')}`);
        this.resolvingGoalLeaderboard = false;
        const waiters = this.goalLeaderboardWaiters.slice();
        this.goalLeaderboardWaiters = [];
        for (let i = 0; i < waiters.length; i++) {
          waiters[i](null);
        }
      }
    );
  }

  private resolveGoalLeaderboardModule(): LeaderboardModule | null {
    if (!isNull(this.goalLeaderboardModule)) {
      return this.goalLeaderboardModule;
    }
    try {
      this.goalLeaderboardModule = require(
        'LensStudio:LeaderboardModule'
      ) as LeaderboardModule;
      return this.goalLeaderboardModule;
    } catch (error) {
      if (!this.leaderboardModuleMissingLogged) {
        this.leaderboardModuleMissingLogged = true;
        print(`[FriendGrab] LeaderboardModule unavailable: ${error}`);
      }
      return null;
    }
  }

  private fetchLeaderboardSnapshot(leaderboard: Leaderboard): void {
    const options = Leaderboard.RetrievalOptions.create();
    options.usersLimit = Math.max(1, Math.min(20, Math.floor(this.leaderboardUsersLimit)));
    options.usersType = this.leaderboardUseGlobal
      ? Leaderboard.UsersType.Global
      : Leaderboard.UsersType.Friends;

    leaderboard.getLeaderboardInfo(
      options,
      (othersInfo, currentUserInfo) => {
        let currentPart = 'current=unknown';
        if (!isNull(currentUserInfo)) {
          const rank =
            currentUserInfo.globalExactRank !== undefined
              ? String(currentUserInfo.globalExactRank)
              : '?';
          currentPart = `current=rank${rank} score=${currentUserInfo.score}`;
        }
        print(
          `[FriendGrab] leaderboard snapshot users=${othersInfo.length} ${currentPart} scope=${
            this.leaderboardUseGlobal ? 'global' : 'friends'
          }`
        );
      },
      (status) => {
        print(
          `[FriendGrab] leaderboard snapshot unavailable status=${status} (Snap privacy opt-in or network may be pending)`
        );
      }
    );
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
    stepRunId: number,
    key: string,
    onDone: () => void
  ): void {
    let settled = false;
    let grabbed = false;
    let listenersWired = false;
    const finish = (reason: string): void => {
      if (
        settled ||
        token !== this.onboardingToken ||
        stepRunId !== this.onboardingStepRunId
      ) {
        return;
      }
      settled = true;
      print(`[FriendGrab] onboarding practice ${key} ${reason}`);
      onDone();
    };

    const onGrabStart = (): void => {
      if (
        settled ||
        token !== this.onboardingToken ||
        stepRunId !== this.onboardingStepRunId
      ) {
        return;
      }
      grabbed = true;
    };

    const onGrabEnd = (): void => {
      if (
        settled ||
        token !== this.onboardingToken ||
        stepRunId !== this.onboardingStepRunId
      ) {
        return;
      }
      // The step completes only after this object emits a matching grab start
      // and release. There is deliberately no movement-distance threshold.
      if (grabbed) {
        this.recoverOnboardingObjectIfOutOfView(target, key);
        finish('grabbed-and-released');
      }
    };

    const tryWireListeners = (): boolean => {
      if (
        listenersWired ||
        settled ||
        token !== this.onboardingToken ||
        stepRunId !== this.onboardingStepRunId
      ) {
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

    const repeatSec = Math.max(6, this.onboardingPracticeTimeoutSec);
    const firstReminderSec = Math.max(
      4,
      Math.min(repeatSec, this.onboardingPracticeFirstReminderSec)
    );
    const maxReminders = Math.max(0, Math.floor(this.onboardingPracticeReminderMaxCount));
    let reminderCount = 0;

    const reminder = this.createEvent('DelayedCallbackEvent');
    reminder.bind(() => {
      if (
        settled ||
        token !== this.onboardingToken ||
        stepRunId !== this.onboardingStepRunId
      ) {
        return;
      }
      if (maxReminders > 0 && reminderCount >= maxReminders) {
        return;
      }
      reminderCount += 1;
      print(
        `[FriendGrab] onboarding practice waiting for ${key} placement (reminder ${reminderCount})`
      );
      this.showSpeech('Move it where you want, then release.', true, null);
      if (maxReminders === 0 || reminderCount < maxReminders) {
        reminder.reset(repeatSec);
      }
    });
    reminder.reset(firstReminderSec);
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
    if (!this.enableFollowAfterOnboarding || this.manualPlacementActive) {
      return;
    }
    this.followActive = true;
    if (!this.followLoggedStart) {
      this.followLoggedStart = true;
      print(`[FriendGrab] follow started (${reason})`);
    }
  }

  private updateFollowUser(): void {
    if (
      !this.followActive ||
      !this.enableFollowAfterOnboarding ||
      this.manualPlacementActive
    ) {
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
    const dist = Math.max(18, Math.min(45, this.followDistanceCm));
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
    const now = getTime();
    if (now < this.nextLookAtRetryAt) {
      return;
    }
    const targetProxy = this.ensureLookAtTargetProxy();
    if (isNull(targetProxy)) {
      this.nextLookAtRetryAt = now + 1.0;
      return;
    }
    this.refreshLookAtTargetProxyPosition();

    const anchor = this.getSceneObject();
    let lookAt = anchor.getComponent('Component.LookAtComponent') as LookAtComponent;
    if (isNull(lookAt)) {
      lookAt = anchor.createComponent('Component.LookAtComponent') as LookAtComponent;
    }

    try {
      lookAt.target = targetProxy as SceneObject;
    } catch (e) {
      if (now - this.lastLookAtInvalidTargetLogAt > 3.0) {
        this.lastLookAtInvalidTargetLogAt = now;
        print('[FriendGrab] look-at skipped: invalid camera target: ' + e);
      }
      this.nextLookAtRetryAt = now + 1.5;
      return;
    }
    this.nextLookAtRetryAt = 0;
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

    if (isNull(this.lookAt) || isNull(this.lookAtTargetProxy)) {
      this.ensureLookAt();
      if (isNull(this.lookAt) || isNull(this.lookAtTargetProxy)) {
        return;
      }
    }
    this.refreshLookAtTargetProxyPosition();

    // Always keep component config correct; never leave it enabled by accident.
    try {
      this.lookAt.target = this.lookAtTargetProxy as SceneObject;
    } catch (e) {
      const now = getTime();
      if (now - this.lastLookAtInvalidTargetLogAt > 3.0) {
        this.lastLookAtInvalidTargetLogAt = now;
        print('[FriendGrab] look-at target refresh failed: ' + e);
      }
      this.lookAt.enabled = false;
      this.nextLookAtRetryAt = now + 1.5;
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
    const cameraPos = (this.lookAtTargetProxy as SceneObject).getTransform().getWorldPosition();
    const dx = cameraPos.x - friendPos.x;
    const dz = cameraPos.z - friendPos.z;
    const distanceCm = Math.sqrt(dx * dx + dz * dz);

    const enterCm = Math.max(0.05, this.lookAtDistanceMeters) * 100.0;
    const exitCm = enterCm + Math.max(0, this.lookAtExitPaddingMeters) * 100.0;

    if (!this.lookAtLoggedSetup) {
      this.lookAtLoggedSetup = true;
      print(
        `[FriendGrab] look-at setup dist=${distanceCm.toFixed(1)}cm threshold=${enterCm.toFixed(0)}cm camera=proxy`
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

  private ensureLookAtTargetProxy(): SceneObject | null {
    if (this.isValidSceneObject(this.lookAtTargetProxy)) {
      return this.lookAtTargetProxy as SceneObject;
    }
    try {
      const proxy = global.scene.createSceneObject('FriendLookAtTarget');
      proxy.layer = this.getSceneObject().layer;
      const parent = this.getSceneObject().hasParent()
        ? this.getSceneObject().getParent()
        : null;
      if (!isNull(parent)) {
        proxy.setParent(parent);
      }
      proxy.getTransform().setWorldPosition(this.getSceneObject().getTransform().getWorldPosition());
      this.lookAtTargetProxy = proxy;
      return proxy;
    } catch (_e) {
      this.lookAtTargetProxy = null;
      return null;
    }
  }

  private refreshLookAtTargetProxyPosition(): void {
    const proxy = this.ensureLookAtTargetProxy();
    if (isNull(proxy)) {
      return;
    }
    const preferred = this.findCameraObject();
    if (this.isValidSceneObject(preferred)) {
      this.lookAtCamera = preferred as SceneObject;
    }

    if (this.isValidSceneObject(this.lookAtCamera)) {
      try {
        const pos = (this.lookAtCamera as SceneObject).getTransform().getWorldPosition();
        proxy.getTransform().setWorldPosition(pos);
        return;
      } catch (_e) {
        this.lookAtCamera = null;
      }
    }

    // Last-resort fallback: keep a stable point in front of Friend.
    const selfTransform = this.getSceneObject().getTransform();
    const selfPos = selfTransform.getWorldPosition();
    const forward = selfTransform.forward;
    const fallback = selfPos.add(new vec3(forward.x * 40, 0, forward.z * 40));
    proxy.getTransform().setWorldPosition(fallback);
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

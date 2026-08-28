import { Interactable } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable';
import { InteractableManipulation } from 'SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation';
import { InteractorInputType } from 'SpectaclesInteractionKit.lspkg/Core/Interactor/Interactor';
import { SIK } from 'SpectaclesInteractionKit.lspkg/SIK';
import { GLOBE_COUNTRY_REGIONS, GlobeCountryRegion } from './GlobeCountryData';
import {
  getSharedFlowGardenTts,
  getSharedFriendGrab,
} from './FlowGardenServiceRegistry';

type InteractableLike = ScriptComponent & {
  targetingMode?: number;
  ignoreInteractionPlane?: boolean;
  keepHoverOnTrigger?: boolean;
  enableInstantDrag?: boolean;
  onHoverEnter?: { add: (cb: (event?: InteractorEventLike) => void) => void };
  onHoverExit?: { add: (cb: (event?: InteractorEventLike) => void) => void };
  onInteractorHoverEnter?: { add: (cb: (event?: InteractorEventLike) => void) => void };
  onInteractorHoverExit?: { add: (cb: (event?: InteractorEventLike) => void) => void };
  onDragStart?: { add: (cb: () => void) => void };
  onDragEnd?: { add: (cb: () => void) => void };
  onTriggerEnd?: { add: (cb: () => void) => void };
  onTriggerEndOutside?: { add: (cb: () => void) => void };
  onInteractorTriggerEnd?: { add: (cb: () => void) => void };
  onInteractorTriggerEndOutside?: { add: (cb: () => void) => void };
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

type InteractorLike = {
  startPoint?: vec3 | null;
  direction?: vec3 | null;
  targetHitPosition?: vec3 | null;
  planecastPoint?: vec3 | null;
  isActive?: () => boolean;
};

type InteractorEventLike = {
  interactor?: InteractorLike | null;
};

/**
 * Makes the Globe scene object pinch-grabbable and movable.
 */
@component
export class GlobeGrab extends BaseScriptComponent {
  @input
  debugLogging: boolean = false;

  /** Local-space box size. Globe is a unit sphere scaled ~10. */
  @input
  colliderSize: vec3 = new vec3(1.2, 1.2, 1.2);

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
  @hint('Slowly rotate globe when not grabbed')
  enableIdleRotation: boolean = true;

  @input('float')
  @hint('Idle rotation speed in degrees/second')
  idleRotationDegreesPerSecond: number = 8;

  @input
  @allowUndefined
  anchorController!: ScriptComponent;

  private grabInteractable: InteractableLike | null = null;
  private grabManipulation: InteractableManipulationLike | null = null;
  private moveInteractionWired = false;
  private moveBindAttempts = 0;
  private moveActive = false;
  private grabAudioPlayer: AudioComponent | null = null;
  private resolvedGrabTrack: AudioTrackAsset | null = null;
  private resolvedReleaseTrack: AudioTrackAsset | null = null;
  private countryHoverWired = false;
  private countryHoverActive = false;
  private countryHoverPollingFallback = false;
  private hoveredInteractors: InteractorLike[] = [];
  private pendingHoverCountry = '';
  private pendingHoverCountrySince = 0;
  private countryHoverLastSeenAt = 0;
  private lastAnnouncedCountry = '';
  private lastResolvedLatitude = Number.NaN;
  private lastResolvedLongitude = Number.NaN;
  private lastResolvedCountry: string | null = null;

  private static readonly ANCHOR_SOURCE_NAME = 'Globe';
  private static readonly COUNTRY_HOVER_STABILITY_SEC = 0.2;
  private static readonly COUNTRY_HOVER_EXIT_GRACE_SEC = 0.35;
  private static readonly COUNTRY_HOVER_MIN_COORD_DELTA_DEG = 0.25;
  private static readonly GLOBE_UNIT_RADIUS = 1.0;
  private static readonly GLOBE_MIN_HIT_RADIUS = 0.2;
  private static readonly GLOBE_MAX_HIT_RADIUS = 1.8;

  private getAnchorHandler(): {
    persistGardenSourceTransform?: (sourceName: string) => void;
    setActiveManipulatedRoot?: (root: SceneObject | null) => void;
  } | null {
    if (isNull(this.anchorController)) {
      return null;
    }
    return this.anchorController as unknown as {
      persistGardenSourceTransform?: (sourceName: string) => void;
      setActiveManipulatedRoot?: (root: SceneObject | null) => void;
    };
  }

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => {
      this.ensureGrabSounds();
      this.tryWireMoveInteraction();
      if (this.debugLogging) {
        print('[GlobeGrab] ready');
      }
    });

    this.createEvent('UpdateEvent').bind(() => {
      this.updateIdleRotation();
      this.updateCountryHover();
    });

    this.scheduleGrabWireRetry(0.25);
    this.scheduleGrabWireRetry(0.75);
  }

  private updateIdleRotation(): void {
    if (!this.enableIdleRotation || this.moveActive) {
      return;
    }

    const speed = Math.max(0, this.idleRotationDegreesPerSecond);
    if (speed <= 0.0001) {
      return;
    }

    const dt = Math.max(0, getDeltaTime());
    if (dt <= 0.000001) {
      return;
    }

    const radians = (speed * Math.PI * dt) / 180.0;
    const transform = this.getSceneObject().getTransform();
    const current = transform.getLocalRotation();
    const delta = quat.angleAxis(radians, vec3.up());
    transform.setLocalRotation(current.multiply(delta));
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
    manipulation.enableRotation = true;
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
        print('[GlobeGrab] could not bind grab interaction');
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
      this.onGlobeGrabStart();
    };
    const onGrabRelease = (): void => {
      this.onGlobeGrabRelease();
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

    this.bindCountryHover(interactable);
    (manipulation as ScriptComponent).enabled = true;
    (interactable as ScriptComponent).enabled = true;

    this.moveInteractionWired = true;
    print('[GlobeGrab] grab interaction wired');
  }

  private bindCountryHover(interactable: InteractableLike): void {
    if (this.countryHoverWired) {
      return;
    }

    let bound = false;
    const onHoverEnter = (event?: InteractorEventLike): void => {
      this.countryHoverActive = true;
      const interactor = event?.interactor || null;
      if (isNull(interactor)) {
        this.countryHoverPollingFallback = true;
        return;
      }
      this.addHoveredInteractor(interactor);
    };
    const onHoverExit = (event?: InteractorEventLike): void => {
      const interactor = event?.interactor || null;
      if (isNull(interactor)) {
        this.clearCountryHover();
        return;
      }
      this.removeHoveredInteractor(interactor);
    };

    if (interactable.onHoverEnter) {
      interactable.onHoverEnter.add(onHoverEnter);
      bound = true;
    }
    if (interactable.onInteractorHoverEnter) {
      interactable.onInteractorHoverEnter.add(onHoverEnter);
      bound = true;
    }
    if (interactable.onHoverExit) {
      interactable.onHoverExit.add(onHoverExit);
      bound = true;
    }
    if (interactable.onInteractorHoverExit) {
      interactable.onInteractorHoverExit.add(onHoverExit);
      bound = true;
    }

    this.countryHoverWired = bound;
    this.countryHoverPollingFallback = !bound;
    if (this.debugLogging) {
      print(
        `[GlobeGrab] country hover ${bound ? 'wired' : 'using interactor polling fallback'}`
      );
    }
  }

  private addHoveredInteractor(interactor: InteractorLike): void {
    for (let i = 0; i < this.hoveredInteractors.length; i++) {
      if (this.hoveredInteractors[i] === interactor) {
        return;
      }
    }
    this.hoveredInteractors.push(interactor);
    this.countryHoverPollingFallback = false;
    this.resetCountryAnnouncement();
  }

  private removeHoveredInteractor(interactor: InteractorLike): void {
    const index = this.hoveredInteractors.indexOf(interactor);
    if (index >= 0) {
      this.hoveredInteractors.splice(index, 1);
    }
    if (this.hoveredInteractors.length === 0) {
      this.clearCountryHover();
    }
  }

  private clearCountryHover(): void {
    this.countryHoverActive = false;
    this.countryHoverPollingFallback = false;
    this.hoveredInteractors = [];
    this.resetCountryAnnouncement();
  }

  private resetCountryAnnouncement(): void {
    this.pendingHoverCountry = '';
    this.pendingHoverCountrySince = 0;
    this.countryHoverLastSeenAt = 0;
    this.lastAnnouncedCountry = '';
    this.lastResolvedLatitude = Number.NaN;
    this.lastResolvedLongitude = Number.NaN;
    this.lastResolvedCountry = null;
  }

  private updateCountryHover(): void {
    const now = getTime();
    const localPoint = this.resolveCurrentHoverLocalPoint();
    if (isNull(localPoint)) {
      if (
        this.countryHoverActive &&
        this.countryHoverLastSeenAt > 0 &&
        now - this.countryHoverLastSeenAt > GlobeGrab.COUNTRY_HOVER_EXIT_GRACE_SEC
      ) {
        this.clearCountryHover();
      }
      return;
    }

    this.countryHoverActive = true;
    this.countryHoverLastSeenAt = now;
    const country = this.resolveCountryAtLocalPoint(localPoint);
    if (!country) {
      this.pendingHoverCountry = '';
      this.pendingHoverCountrySince = 0;
      return;
    }

    if (country !== this.pendingHoverCountry) {
      this.pendingHoverCountry = country;
      this.pendingHoverCountrySince = now;
      return;
    }

    if (
      country !== this.lastAnnouncedCountry &&
      now - this.pendingHoverCountrySince >= GlobeGrab.COUNTRY_HOVER_STABILITY_SEC
    ) {
      this.lastAnnouncedCountry = country;
      this.announceCountry(country);
    }
  }

  private resolveCurrentHoverLocalPoint(): vec3 | null {
    const candidates: InteractorLike[] =
      this.hoveredInteractors.length > 0
        ? this.hoveredInteractors
        : this.countryHoverPollingFallback
          ? this.getAllInteractors()
          : [];

    for (let i = 0; i < candidates.length; i++) {
      const localPoint = this.resolveInteractorGlobePoint(candidates[i]);
      if (!isNull(localPoint)) {
        return localPoint;
      }
    }
    return null;
  }

  private getAllInteractors(): InteractorLike[] {
    try {
      return SIK.InteractionManager.getInteractorsByType(
        InteractorInputType.All
      ) as unknown as InteractorLike[];
    } catch (_error) {
      return [];
    }
  }

  private resolveInteractorGlobePoint(interactor: InteractorLike | null): vec3 | null {
    if (isNull(interactor)) {
      return null;
    }
    if (typeof interactor.isActive === 'function' && !interactor.isActive()) {
      return null;
    }

    const globeTransform = this.getSceneObject().getTransform();
    const worldToLocal = globeTransform.getWorldTransform().inverse();
    const start = interactor.startPoint || null;
    const direction = interactor.direction || null;
    const targetHit = interactor.targetHitPosition || null;
    if (!isNull(targetHit)) {
      const localTargetHit = worldToLocal.multiplyPoint(targetHit as vec3);
      const targetHitRadius = localTargetHit.distance(vec3.zero());
      if (
        targetHitRadius < GlobeGrab.GLOBE_MIN_HIT_RADIUS ||
        targetHitRadius > GlobeGrab.GLOBE_MAX_HIT_RADIUS
      ) {
        return null;
      }
    }

    if (!isNull(start) && !isNull(direction)) {
      const localStart = worldToLocal.multiplyPoint(start as vec3);
      const localDirection = worldToLocal
        .multiplyPoint((start as vec3).add(direction as vec3))
        .sub(localStart);
      const a = localDirection.dot(localDirection);
      if (a > 0.000001) {
        const b = 2 * localStart.dot(localDirection);
        const c =
          localStart.dot(localStart) -
          GlobeGrab.GLOBE_UNIT_RADIUS * GlobeGrab.GLOBE_UNIT_RADIUS;
        const discriminant = b * b - 4 * a * c;
        if (discriminant >= 0) {
          const root = Math.sqrt(discriminant);
          const firstHit = (-b - root) / (2 * a);
          const secondHit = (-b + root) / (2 * a);
          const hitDistance = firstHit >= 0 ? firstHit : secondHit;
          if (hitDistance >= 0) {
            const localHit = localStart.add(localDirection.uniformScale(hitDistance));
            const hitRadius = localHit.distance(vec3.zero());
            if (hitRadius >= GlobeGrab.GLOBE_MIN_HIT_RADIUS) {
              return localHit.uniformScale(1 / hitRadius);
            }
          }
        }
      }
    }

    const target = targetHit || interactor.planecastPoint || null;
    if (isNull(target)) {
      return null;
    }

    const localTarget = worldToLocal.multiplyPoint(target as vec3);
    const targetRadius = localTarget.distance(vec3.zero());
    if (
      targetRadius < GlobeGrab.GLOBE_MIN_HIT_RADIUS ||
      targetRadius > GlobeGrab.GLOBE_MAX_HIT_RADIUS
    ) {
      return null;
    }
    return localTarget.uniformScale(1 / targetRadius);
  }

  private resolveCountryAtLocalPoint(localPoint: vec3): string | null {
    const latitude = (Math.asin(Math.max(-1, Math.min(1, localPoint.y))) * 180) / Math.PI;
    const longitude = (Math.atan2(localPoint.x, -localPoint.z) * 180) / Math.PI;

    if (
      !Number.isNaN(this.lastResolvedLatitude) &&
      Math.abs(latitude - this.lastResolvedLatitude) <
        GlobeGrab.COUNTRY_HOVER_MIN_COORD_DELTA_DEG &&
      Math.abs(longitude - this.lastResolvedLongitude) <
        GlobeGrab.COUNTRY_HOVER_MIN_COORD_DELTA_DEG
    ) {
      return this.lastResolvedCountry;
    }

    this.lastResolvedLatitude = latitude;
    this.lastResolvedLongitude = longitude;
    this.lastResolvedCountry = this.findCountry(latitude, longitude);
    return this.lastResolvedCountry;
  }

  private findCountry(latitude: number, longitude: number): string | null {
    for (let i = 0; i < GLOBE_COUNTRY_REGIONS.length; i++) {
      const region = GLOBE_COUNTRY_REGIONS[i];
      const longitudeSpan = region.maxLon - region.minLon;
      if (
        longitudeSpan <= 180 &&
        (longitude < region.minLon || longitude > region.maxLon)
      ) {
        continue;
      }
      if (latitude < region.minLat || latitude > region.maxLat) {
        continue;
      }
      if (this.isPointInCountryRing(longitude, latitude, region)) {
        return region.name;
      }
    }
    return null;
  }

  private isPointInCountryRing(
    longitude: number,
    latitude: number,
    region: GlobeCountryRegion
  ): boolean {
    let inside = false;
    const ring = region.ring;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      let firstLongitude = ring[i][0];
      let lastLongitude = ring[j][0];
      const firstLatitude = ring[i][1];
      const lastLatitude = ring[j][1];

      if (Math.abs(firstLongitude - longitude) > 180) {
        firstLongitude += firstLongitude < longitude ? 360 : -360;
      }
      if (Math.abs(lastLongitude - longitude) > 180) {
        lastLongitude += lastLongitude < longitude ? 360 : -360;
      }

      if (
        firstLatitude > latitude !== lastLatitude > latitude &&
        longitude <
          ((lastLongitude - firstLongitude) * (latitude - firstLatitude)) /
            (lastLatitude - firstLatitude) +
            firstLongitude
      ) {
        inside = !inside;
      }
    }
    return inside;
  }

  private announceCountry(country: string): void {
    const message = `You're hovering over ${country}.`;
    const friend = getSharedFriendGrab();
    if (!isNull(friend) && typeof friend.showSpeech === 'function') {
      friend.showSpeech(message, true);
    } else {
      const tts = getSharedFlowGardenTts();
      if (!isNull(tts)) {
        tts.speak(message, () => {});
      }
    }
    if (this.debugLogging) {
      print(`[GlobeGrab] country hover: ${country}`);
    }
  }

  private onGlobeGrabStart(): void {
    if (this.moveActive) {
      return;
    }
    this.moveActive = true;
    const handler = this.getAnchorHandler();
    if (!isNull(handler) && typeof handler.setActiveManipulatedRoot === 'function') {
      handler.setActiveManipulatedRoot(this.getSceneObject());
    }
    this.playGrabSound(this.resolvedGrabTrack, this.grabSoundVolume, 'grab');
    if (this.debugLogging) {
      print('[GlobeGrab] grab start');
    }
  }

  private onGlobeGrabRelease(): void {
    if (!this.moveActive) {
      return;
    }
    this.moveActive = false;
    const handler = this.getAnchorHandler();
    if (!isNull(handler)) {
      if (typeof handler.setActiveManipulatedRoot === 'function') {
        handler.setActiveManipulatedRoot(null);
      }
      if (typeof handler.persistGardenSourceTransform === 'function') {
        handler.persistGardenSourceTransform(GlobeGrab.ANCHOR_SOURCE_NAME);
      }
    }
    this.playGrabSound(this.resolvedReleaseTrack, this.releaseSoundVolume, 'release');
    if (this.debugLogging) {
      print('[GlobeGrab] grab end');
    }
  }

  private ensureGrabSounds(): void {
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
        print('[GlobeGrab] audio extras unavailable in preview: ' + e);
      }
    }

    return player;
  }

  private resolveSoundTrack(
    assigned: AudioTrackAsset | null | undefined,
    assetPath: string
  ): AudioTrackAsset | null {
    if (!isNull(assigned) && assigned) {
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

    print(`[GlobeGrab] missing sound asset ${assetPath}`);
    return null;
  }

  private playGrabSound(
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
      print(`[GlobeGrab] sfx ${label}`);
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

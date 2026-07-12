type AudioPlayerLike = AudioComponent & {
  isPlaying?: () => boolean;
  stop?: (fade: boolean) => void;
  volume?: number;
};

export type InteractionSoundTracks = {
  watering?: AudioTrackAsset | null;
  plantSeed?: AudioTrackAsset | null;
  growthStart?: AudioTrackAsset | null;
  growthComplete?: AudioTrackAsset | null;
  spawnSeed?: AudioTrackAsset | null;
  spawnPot?: AudioTrackAsset | null;
  spawnWater?: AudioTrackAsset | null;
  placeObject?: AudioTrackAsset | null;
};

export class InteractionSoundRegistry {
  private static tracks: InteractionSoundTracks = {};
  private static players: AudioComponent[] = [];
  private static volume = 1.25;
  private static minReplayInterval = 0.05;
  private static debugLogging = true;
  private static lastPlayTimes: Record<string, number> = {};
  private static nextPlayerIndex = 0;
  private static ready = false;

  public static configure(
    host: SceneObject,
    tracks: InteractionSoundTracks,
    volume = 1.25,
    debugLogging = true
  ): void {
    InteractionSoundRegistry.tracks = tracks;
    InteractionSoundRegistry.volume = volume;
    InteractionSoundRegistry.debugLogging = debugLogging;
    InteractionSoundRegistry.collectPlayers(host);
    InteractionSoundRegistry.ready = InteractionSoundRegistry.players.length > 0;
    InteractionSoundRegistry.debugLog(
      `ready players=${InteractionSoundRegistry.players.length}`
    );
  }

  public static playWatering(): void {
    InteractionSoundRegistry.play('watering', InteractionSoundRegistry.tracks.watering);
  }

  public static playPlantSeed(): void {
    InteractionSoundRegistry.play('plantSeed', InteractionSoundRegistry.tracks.plantSeed);
  }

  public static playGrowthStart(): void {
    InteractionSoundRegistry.play('growthStart', InteractionSoundRegistry.tracks.growthStart);
  }

  public static playGrowthComplete(): void {
    InteractionSoundRegistry.play(
      'growthComplete',
      InteractionSoundRegistry.tracks.growthComplete
    );
  }

  public static playSpawnSeed(): void {
    InteractionSoundRegistry.play('spawnSeed', InteractionSoundRegistry.tracks.spawnSeed);
  }

  public static playSpawnPot(): void {
    InteractionSoundRegistry.play('spawnPot', InteractionSoundRegistry.tracks.spawnPot);
  }

  public static playSpawnWater(): void {
    InteractionSoundRegistry.play('spawnWater', InteractionSoundRegistry.tracks.spawnWater);
  }

  public static playPlaceObject(): void {
    InteractionSoundRegistry.play('placeObject', InteractionSoundRegistry.tracks.placeObject);
  }

  private static collectPlayers(host: SceneObject): void {
    const players: AudioComponent[] = [];
    const components = host.getComponents('Component.AudioComponent') as AudioComponent[];
    for (let i = 0; i < components.length; i++) {
      if (!isNull(components[i])) {
        players.push(components[i]);
      }
    }

    if (players.length === 0) {
      const created = host.createComponent('Component.AudioComponent') as AudioComponent;
      if (!isNull(created)) {
        players.push(created);
      }
    }

    InteractionSoundRegistry.players = players;
  }

  private static getNextPlayer(): AudioComponent | null {
    if (InteractionSoundRegistry.players.length === 0) {
      return null;
    }

    const startIndex = InteractionSoundRegistry.nextPlayerIndex;
    for (let i = 0; i < InteractionSoundRegistry.players.length; i++) {
      const index = (startIndex + i) % InteractionSoundRegistry.players.length;
      const player = InteractionSoundRegistry.players[index] as AudioPlayerLike;
      if (typeof player.isPlaying !== 'function' || !player.isPlaying()) {
        InteractionSoundRegistry.nextPlayerIndex =
          (index + 1) % InteractionSoundRegistry.players.length;
        return InteractionSoundRegistry.players[index];
      }
    }

    const fallback =
      InteractionSoundRegistry.players[
        startIndex % InteractionSoundRegistry.players.length
      ];
    InteractionSoundRegistry.nextPlayerIndex =
      (startIndex + 1) % InteractionSoundRegistry.players.length;
    return fallback;
  }

  private static play(key: string, track: AudioTrackAsset | null | undefined): void {
    if (!InteractionSoundRegistry.ready) {
      InteractionSoundRegistry.debugLog(`skip ${key}: registry not ready`);
      return;
    }
    if (isNull(track)) {
      InteractionSoundRegistry.debugLog(`skip ${key}: missing track`);
      return;
    }

    const now = getTime();
    const lastPlay = InteractionSoundRegistry.lastPlayTimes[key] ?? -999;
    if (now - lastPlay < InteractionSoundRegistry.minReplayInterval) {
      return;
    }
    InteractionSoundRegistry.lastPlayTimes[key] = now;

    const audioPlayer = InteractionSoundRegistry.getNextPlayer();
    if (isNull(audioPlayer)) {
      InteractionSoundRegistry.debugLog(`skip ${key}: no audio player`);
      return;
    }

    const player = audioPlayer as AudioPlayerLike;
    audioPlayer.audioTrack = track as AudioTrackAsset;
    if (typeof player.volume === 'number') {
      player.volume = Math.max(0, InteractionSoundRegistry.volume);
    }
    if (typeof player.isPlaying === 'function' && player.isPlaying()) {
      player.stop!(false);
    }
    audioPlayer.play(1);
    InteractionSoundRegistry.debugLog(`play ${key}`);
  }

  private static debugLog(message: string): void {
    if (!InteractionSoundRegistry.debugLogging) {
      return;
    }
    print(`[InteractionSound] ${message}`);
  }
}

export function playInteractionSound(
  play: (sounds: typeof InteractionSoundRegistry) => void
): void {
  play(InteractionSoundRegistry);
}

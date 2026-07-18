import { InteractionSoundRegistry, playInteractionSound } from './InteractionSoundRegistry';

export { playInteractionSound };

@component
export class InteractionSoundPlayer extends BaseScriptComponent {
  @input
  @allowUndefined
  audioPlayer!: AudioComponent;

  @input('float')
  volume: number = 1.25;

  @input
  debugLogging: boolean = true;

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
  hoverTrack!: AudioTrackAsset;

  onAwake(): void {
    this.configureRegistry();
    this.createEvent('OnStartEvent').bind(() => this.configureRegistry());
  }

  private configureRegistry(): void {
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
      this.volume,
      this.debugLogging
    );
  }
}

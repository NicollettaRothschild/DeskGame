@component
export class WaterSplashBurst extends BaseScriptComponent {
  @input
  @allowUndefined
  particleVisual!: RenderMeshVisual;

  @input('float')
  burstIntensity: number = 0.55;

  @input('int')
  maxParticles: number = 1000;

  @input('float')
  lifetime: number = 1.2;

  onAwake(): void {
    this.createEvent('OnStartEvent').bind(() => this.playBurst());
  }

  public configureBurst(lifetime: number, intensity: number, maxCount: number): void {
    this.lifetime = Math.max(0.2, lifetime);
    this.burstIntensity = Math.max(0.05, Math.min(1, intensity));
    this.maxParticles = Math.max(1, Math.floor(maxCount));
  }

  private playBurst(): void {
    const visual = this.resolveVisual();
    if (isNull(visual)) {
      this.scheduleDestroy(0.05);
      return;
    }

    visual.enabled = true;
    const material = visual.mainMaterial;
    if (!isNull(material) && material.mainPass) {
      const count = Math.max(
        1,
        Math.floor(this.maxParticles * Math.max(0.05, Math.min(1, this.burstIntensity)))
      );
      material.mainPass.instanceCount = count;
    }

    this.scheduleDestroy(this.lifetime);
  }

  private resolveVisual(): RenderMeshVisual | null {
    if (!isNull(this.particleVisual)) {
      return this.particleVisual;
    }

    const visuals = this.getSceneObject().getComponents(
      'Component.RenderMeshVisual'
    ) as RenderMeshVisual[];
    for (let i = 0; i < visuals.length; i++) {
      if (!isNull(visuals[i])) {
        return visuals[i];
      }
    }

    return null;
  }

  private scheduleDestroy(delaySec: number): void {
    const destroyEvent = this.createEvent('DelayedCallbackEvent');
    destroyEvent.bind(() => {
      const root = this.getSceneObject();
      if (!isNull(root)) {
        root.destroy();
      }
    });
    destroyEvent.reset(Math.max(0.05, delaySec));
  }
}

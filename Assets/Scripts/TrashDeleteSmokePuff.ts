type GpuParticlePass = Pass & {
  instanceCount?: number;
  spawnDuration?: number;
  lifeTimeMinMax?: vec2;
  colorStart?: vec3;
  colorEnd?: vec3;
  alphaStart?: number;
  alphaEnd?: number;
  velocityMin?: vec3;
  velocityMax?: vec3;
  spawnSphere?: vec3;
  sizeStartMin?: vec2;
  sizeStartMax?: vec2;
  sizeEndMin?: vec2;
  sizeEndMax?: vec2;
  gravity?: number;
  externalSeed?: number;
};

const PARTICLE_MESH_CANDIDATES = [
  'GPU Particles Effects Pack  PLACE IN SCENE.lspkg/Meshes/Particles Mesh.mesh',
  '../GPU Particles Effects Pack  PLACE IN SCENE.lspkg/Meshes/Particles Mesh.mesh',
];

const PARTICLE_MATERIAL_CANDIDATES = [
  'GPU Particles Effects Pack  PLACE IN SCENE.lspkg/Materials/Bokeh [EDIT_ME].mat',
  '../GPU Particles Effects Pack  PLACE IN SCENE.lspkg/Materials/Bokeh [EDIT_ME].mat',
];

let cachedParticleMesh: RenderMesh | null = null;
let cachedParticleMaterial: Material | null = null;
let assetLoadFailed = false;

function loadFirstAsset<T extends Asset>(candidates: string[]): T | null {
  for (let i = 0; i < candidates.length; i++) {
    try {
      const asset = requireAsset(candidates[i]);
      if (!isNull(asset)) {
        return asset as T;
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return null;
}

function resolveSmokePuffAssets(
  overrideMesh?: RenderMesh | null,
  overrideMaterial?: Material | null
): { mesh: RenderMesh; material: Material } | null {
  if (!isNull(overrideMesh) && !isNull(overrideMaterial)) {
    return { mesh: overrideMesh, material: overrideMaterial };
  }

  if (assetLoadFailed) {
    return null;
  }

  if (isNull(cachedParticleMesh)) {
    cachedParticleMesh = loadFirstAsset<RenderMesh>(PARTICLE_MESH_CANDIDATES);
  }
  if (isNull(cachedParticleMaterial)) {
    cachedParticleMaterial = loadFirstAsset<Material>(PARTICLE_MATERIAL_CANDIDATES);
  }

  if (isNull(cachedParticleMesh) || isNull(cachedParticleMaterial)) {
    assetLoadFailed = true;
    print('[TrashDeleteSmokePuff] GPU particle assets unavailable; assign mesh/material on TrashDeleteSmokePuff.');
    return null;
  }

  return {
    mesh: cachedParticleMesh,
    material: cachedParticleMaterial,
  };
}

function configureSmokePuffPass(pass: GpuParticlePass, seed: number): void {
  pass.instanceCount = 96;
  pass.spawnDuration = 0.14;
  pass.lifeTimeMinMax = new vec2(0.35, 0.75);
  pass.colorStart = new vec3(0.88, 0.88, 0.88);
  pass.colorEnd = new vec3(0.55, 0.55, 0.55);
  pass.alphaStart = 0.62;
  pass.alphaEnd = 0.0;
  pass.velocityMin = new vec3(-14.0, 8.0, -14.0);
  pass.velocityMax = new vec3(14.0, 24.0, 14.0);
  pass.spawnSphere = new vec3(10.0, 8.0, 10.0);
  pass.sizeStartMin = new vec2(2.0, 2.0);
  pass.sizeStartMax = new vec2(5.0, 5.0);
  pass.sizeEndMin = new vec2(10.0, 10.0);
  pass.sizeEndMax = new vec2(18.0, 18.0);
  pass.gravity = -6.0;
  pass.externalSeed = seed;
}

export function playTrashDeleteSmokePuff(
  worldPos: vec3,
  host: ScriptComponent,
  options?: {
    particleMesh?: RenderMesh | null;
    particleMaterial?: Material | null;
    lifetimeSec?: number;
  }
): void {
  if (isNull(host) || isNull(worldPos)) {
    return;
  }

  const assets = resolveSmokePuffAssets(options?.particleMesh, options?.particleMaterial);
  if (isNull(assets)) {
    return;
  }

  const puffRoot = global.scene.createSceneObject('TrashSmokePuff');
  puffRoot.getTransform().setWorldPosition(worldPos);
  puffRoot.getTransform().setLocalScale(new vec3(0.22, 0.22, 0.22));

  const visual = puffRoot.createComponent('Component.RenderMeshVisual') as RenderMeshVisual;
  visual.mesh = assets.mesh;
  const material = assets.material.clone();
  visual.mainMaterial = material;
  configureSmokePuffPass(material.mainPass as GpuParticlePass, getTime() * 1000.0);

  const lifetimeSec = options?.lifetimeSec ?? 1.35;
  const puffRef = puffRoot;
  const cleanup = host.createEvent('DelayedCallbackEvent');
  cleanup.bind(() => {
    if (!isNull(puffRef)) {
      puffRef.destroy();
    }
  });
  cleanup.reset(lifetimeSec);
}

@component
export class TrashDeleteSmokePuff extends BaseScriptComponent {
  @input
  @allowUndefined
  particleMesh!: RenderMesh;

  @input
  @allowUndefined
  particleMaterial!: Material;

  @input('float')
  puffLifetimeSec: number = 1.35;

  onAwake(): void {
    if (!isNull(this.particleMesh) && !isNull(this.particleMaterial)) {
      cachedParticleMesh = this.particleMesh;
      cachedParticleMaterial = this.particleMaterial;
      assetLoadFailed = false;
    }
  }

  public playAt(worldPos: vec3): void {
    playTrashDeleteSmokePuff(worldPos, this, {
      particleMesh: this.particleMesh,
      particleMaterial: this.particleMaterial,
      lifetimeSec: this.puffLifetimeSec,
    });
  }
}

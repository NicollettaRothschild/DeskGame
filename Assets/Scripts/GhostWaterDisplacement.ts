export type GhostWaterDisplacementConfig = {
  scrollSpeed: number;
  noiseScale: number;
  offsetAmount: number;
  tweakN11: number;
  tweakN6: number;
};

const NOISE_LAYER_SCALES = [3.0, 1.0, 5.0, 10.0] as const;
const NOISE_LAYER_WEIGHTS = [0.2, 0.9, 0.1, 0.1] as const;

function quantize(value: number): number {
  return Math.floor(value * 10000.0) * 0.0001;
}

function dot2(a: vec2, b: vec2): number {
  return a.x * b.x + a.y * b.y;
}

// Port of WaterMaterial.ss_graph snoise().
function shaderSnoise(v: vec2): number {
  const skew = 0.36602542;
  const unskew = 0.21132487;
  const k2 = -0.57735026;

  const i = new vec2(
    Math.floor(v.x + dot2(v, new vec2(skew, skew))),
    Math.floor(v.y + dot2(v, new vec2(skew, skew)))
  );
  const x0 = new vec2(
    v.x - i.x + dot2(i, new vec2(unskew, unskew)),
    v.y - i.y + dot2(i, new vec2(unskew, unskew))
  );

  const i1 = x0.x > x0.y ? new vec2(1.0, 0.0) : new vec2(0.0, 1.0);
  const x1 = new vec2(x0.x + unskew - i1.x, x0.y + unskew - i1.y);
  const x2 = new vec2(x0.x + k2, x0.y + k2);

  const mod289 = (value: number): number => value - Math.floor(value * 0.0034602077) * 289.0;
  const permute = (value: vec3): vec3 => {
    const scaled = new vec3(
      (value.x * 34.0 + 1.0) * value.x,
      (value.y * 34.0 + 1.0) * value.y,
      (value.z * 34.0 + 1.0) * value.z
    );
    return new vec3(mod289(scaled.x), mod289(scaled.y), mod289(scaled.z));
  };

  let ii = mod289(i.y);
  const pBase = permute(new vec3(ii + 0.0, ii + i1.y, ii + 1.0));
  let ix = mod289(i.x);
  const p = permute(new vec3(pBase.x + ix + 0.0, pBase.y + ix + i1.x, pBase.z + ix + 1.0));

  const m0 = Math.max(0.5 - dot2(x0, x0), 0.0);
  const m1 = Math.max(0.5 - dot2(x1, x1), 0.0);
  const m2 = Math.max(0.5 - dot2(x2, x2), 0.0);
  const m = new vec3(m0 * m0, m1 * m1, m2 * m2);
  const mSq = new vec3(m.x * m.x, m.y * m.y, m.z * m.z);

  const x = new vec3(
    (p.x * 0.024390243 - Math.floor(p.x * 0.024390243)) * 2.0 - 1.0,
    (p.y * 0.024390243 - Math.floor(p.y * 0.024390243)) * 2.0 - 1.0,
    (p.z * 0.024390243 - Math.floor(p.z * 0.024390243)) * 2.0 - 1.0
  );
  const h = new vec3(
    Math.abs(x.x) - 0.5,
    Math.abs(x.y) - 0.5,
    Math.abs(x.z) - 0.5
  );
  const ox = new vec3(
    Math.floor(x.x + 0.5),
    Math.floor(x.y + 0.5),
    Math.floor(x.z + 0.5)
  );
  const a0 = new vec3(x.x - ox.x, x.y - ox.y, x.z - ox.z);
  const mAtt = new vec3(
    mSq.x * (1.7928429 - ((a0.x * a0.x + h.x * h.x) * 0.85373473)),
    mSq.y * (1.7928429 - ((a0.y * a0.y + h.y * h.y) * 0.85373473)),
    mSq.z * (1.7928429 - ((a0.z * a0.z + h.z * h.z) * 0.85373473))
  );

  const g0 = a0.x * x0.x + h.x * x0.y;
  const g1 = a0.y * x1.x + h.y * x1.y;
  const g2 = a0.z * x2.x + h.z * x2.y;

  return 130.0 * (mAtt.x * g0 + mAtt.y * g1 + mAtt.z * g2);
}

function voronoiHash2D(uvIn: vec2, offset: number): vec2 {
  const uvX = uvIn.x * 0.15270001 + uvIn.y * 0.4991;
  const uvY = uvIn.x * 0.4763 + uvIn.y * 0.8998;
  const modded = new vec2(
    uvX - 3.1400001 * Math.floor(uvX / 3.1400001),
    uvY - 3.1400001 * Math.floor(uvY / 3.1400001)
  );
  const uv = new vec2(
    Math.sin(modded.x) * 0.32345 - Math.floor(Math.sin(modded.x) * 0.32345),
    Math.sin(modded.y) * 0.32345 - Math.floor(Math.sin(modded.y) * 0.32345)
  );
  return new vec2(
    Math.sin(uv.y * offset) * 0.5 + 0.5,
    Math.cos(uv.x * offset) * 0.5 + 0.5
  );
}

function shaderNoiseLayer(coordX: number, coordZ: number, scale: number, noiseScale: number): number {
  let x = coordX * scale;
  let z = coordZ * scale;
  x = quantize(x);
  z = quantize(z);
  x *= noiseScale * 0.5;
  z *= noiseScale * 0.5;
  const sample = shaderSnoise(new vec2(x, z));
  return quantize(sample * 0.5 + 0.5);
}

function sampleNoiseSum(worldX: number, worldZ: number, time: number, config: GhostWaterDisplacementConfig): number {
  const scroll = time * config.scrollSpeed;
  const coordX = worldX + scroll;
  const coordZ = worldZ + scroll;
  // Template defaults noiseScale to 0; the ghost configures 0.055 on GPU only.
  const noiseScale = Math.max(config.noiseScale, 0.0001);

  let sum = 0;
  for (let i = 0; i < NOISE_LAYER_SCALES.length; i++) {
    sum += shaderNoiseLayer(coordX, coordZ, NOISE_LAYER_SCALES[i], noiseScale) * NOISE_LAYER_WEIGHTS[i];
  }
  return sum;
}

function sampleVoronoiGate(worldX: number, worldZ: number, time: number, config: GhostWaterDisplacementConfig): number {
  let uvX = quantize(worldX);
  let uvZ = quantize(worldZ);
  const gateScale = config.tweakN11;
  const gateTime = time * config.tweakN6;
  const offset = Math.abs(gateTime) + 1000.0;

  const scaledX = uvX * gateScale;
  const scaledZ = uvZ * gateScale;
  const cellBaseX = Math.floor(scaledX);
  const cellBaseZ = Math.floor(scaledZ);
  const fractX = scaledX - cellBaseX;
  const fractZ = scaledZ - cellBaseZ;

  let best = 8.0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const hash = voronoiHash2D(
        new vec2(cellBaseX + i, cellBaseZ + j),
        offset
      );
      const dx = i + hash.x - fractX;
      const dz = j + hash.y - fractZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < best) {
        best = dist;
      }
    }
  }

  return quantize(best);
}

export function sampleGhostWaterDisplacementY(
  worldX: number,
  worldZ: number,
  time: number,
  config: GhostWaterDisplacementConfig
): number {
  const noiseSum = sampleNoiseSum(worldX, worldZ, time, config);
  const voronoiGate = sampleVoronoiGate(worldX, worldZ, time, config);
  const gated = noiseSum * voronoiGate;
  return config.offsetAmount * gated;
}

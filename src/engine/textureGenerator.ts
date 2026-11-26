import * as THREE from 'three';
import { PartPaint } from '../types/weapon';

export interface ProceduralPBRMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  metalnessMap: THREE.CanvasTexture;
}

const MAX_CACHE = 48;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Fast deterministic integer hash returning [0, 1). */
function hashInt(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Seamless tileable 2D value noise over [0,1) x [0,1) with integer periods fx, fy. */
function tileNoise(u: number, v: number, fx: number, fy: number, seed: number): number {
  const px = ((u * fx) % fx + fx) % fx;
  const py = ((v * fy) % fy + fy) % fy;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = (x0 + 1) % fx;
  const y1 = (y0 + 1) % fy;
  const tx = px - x0;
  const ty = py - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);

  const n00 = hashInt(x0, y0, seed);
  const n10 = hashInt(x1, y0, seed);
  const n01 = hashInt(x0, y1, seed);
  const n11 = hashInt(x1, y1, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

/** Seamless tileable multi-octave fBm returning [0, 1]. */
function tileFbm(
  u: number,
  v: number,
  baseFx: number,
  baseFy: number,
  octaves: number,
  seed: number
): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = baseFx;
  let fy = baseFy;
  for (let i = 0; i < octaves; i++) {
    sum += tileNoise(u, v, fx, fy, seed + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    fx <<= 1;
    fy <<= 1;
  }
  return sum / norm;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return [60, 68, 78];
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Computes a seamless tangent-space normal map from a floating-point heightfield [0..1] via 3x3 Sobel filter. */
function buildNormalMapCanvas(
  height: Float32Array,
  size: number,
  strength: number
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const mask = size - 1;

  for (let y = 0; y < size; y++) {
    const ym = ((y - 1) & mask) * size;
    const y0 = y * size;
    const yp = ((y + 1) & mask) * size;

    for (let x = 0; x < size; x++) {
      const xm = (x - 1) & mask;
      const xp = (x + 1) & mask;

      const tl = height[ym + xm];
      const tc = height[ym + x];
      const tr = height[ym + xp];
      const ml = height[y0 + xm];
      const mr = height[y0 + xp];
      const bl = height[yp + xm];
      const bc = height[yp + x];
      const br = height[yp + xp];

      const dx = (tr + 2 * mr + br - (tl + 2 * ml + bl)) * strength;
      const dy = (bl + 2 * bc + br - (tl + 2 * tc + tr)) * strength;

      let nx = -dx;
      let ny = -dy;
      let nz = 1.0;
      const invLen = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= invLen;
      ny *= invLen;
      nz *= invLen;

      const idx = (y0 + x) * 4;
      data[idx] = clampByte((nx * 0.5 + 0.5) * 255);
      data[idx + 1] = clampByte((ny * 0.5 + 0.5) * 255);
      data[idx + 2] = clampByte((nz * 0.5 + 0.5) * 255);
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Draws a crisp realistic hairline scratch into albedo, roughness, metalness, and heightfield buffers. */
function carveScratch(
  albData: Uint8ClampedArray,
  rghData: Uint8ClampedArray,
  metData: Uint8ClampedArray,
  height: Float32Array,
  size: number,
  x0: number,
  y0: number,
  angle: number,
  length: number,
  width: number,
  intensity: number,
  scratchRgb: [number, number, number],
  scratchRoughByte: number,
  boostMetal: boolean
): void {
  const steps = Math.max(5, Math.ceil(length * 1.6));
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const perpX = -sinA;
  const perpY = cosA;
  const mask = size - 1;

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const taper = Math.sin(t * Math.PI);
    const jitter = (hashInt(s, Math.round(x0 + y0), 917) - 0.5) * 0.42;
    const cx = x0 + cosA * length * t + perpX * jitter;
    const cy = y0 + sinA * length * t + perpY * jitter;
    const halfW = Math.max(0.42, width * taper);
    const r = Math.ceil(halfW + 1.0);

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.hypot(dx, dy);
        if (dist > halfW + 0.8) continue;

        const px = Math.round(cx + dx) & mask;
        const py = Math.round(cy + dy) & mask;
        const pIdx = py * size + px;
        const i4 = pIdx * 4;

        if (dist <= halfW) {
          const core = (1 - dist / (halfW + 0.001)) * taper * intensity;
          albData[i4] = clampByte(lerp(albData[i4], scratchRgb[0], core * 0.58));
          albData[i4 + 1] = clampByte(lerp(albData[i4 + 1], scratchRgb[1], core * 0.58));
          albData[i4 + 2] = clampByte(lerp(albData[i4 + 2], scratchRgb[2], core * 0.58));

          rghData[i4] = clampByte(lerp(rghData[i4], scratchRoughByte, core * 0.82));
          rghData[i4 + 1] = rghData[i4];
          rghData[i4 + 2] = rghData[i4];

          if (boostMetal) {
            const mv = clampByte(lerp(metData[i4], 255, core * 0.88));
            metData[i4] = mv;
            metData[i4 + 1] = mv;
            metData[i4 + 2] = mv;
          }

          height[pIdx] = Math.max(0.04, height[pIdx] - core * 0.2);
        } else {
          // Subtle raised micro-burr shoulder next to metal scratches
          const ridge = (1 - (dist - halfW) / 0.8) * taper * intensity * 0.25;
          height[pIdx] = Math.min(0.96, height[pIdx] + ridge * 0.08);
        }
      }
    }
  }
}

/** Distance from point to nearest tileable hexagon edge for hex_tech pattern. */
function sampleHexTile(
  u: number,
  v: number,
  cols: number
): { cellId: number; edgeDist: number } {
  const aspect = Math.sqrt(3);
  const gx = u * cols;
  const gy = v * cols * aspect;

  const ix0 = Math.floor(gx);
  const iy0 = Math.floor(gy);
  const fx0 = gx - ix0 - 0.5;
  const fy0 = (gy - iy0 - 0.5) / aspect;

  const gx1 = gx + 0.5;
  const gy1 = gy + 0.5;
  const ix1 = Math.floor(gx1);
  const iy1 = Math.floor(gy1);
  const fx1 = gx1 - ix1 - 0.5;
  const fy1 = (gy1 - iy1 - 0.5) / aspect;

  const d0 = fx0 * fx0 + fy0 * fy0;
  const d1 = fx1 * fx1 + fy1 * fy1;

  const useFirst = d0 <= d1;
  const rx = useFirst ? fx0 : fx1;
  const ry = useFirst ? fy0 : fy1;
  const cx = ((useFirst ? ix0 : ix1) % cols + cols) % cols;
  const cy = ((useFirst ? iy0 : iy1) % cols + cols) % cols;

  const ax = Math.abs(rx);
  const ay = Math.abs(ry) * 1.1547;
  const hexR = Math.max(ax * 0.866025 + ay * 0.5, ay);
  const edgeDist = Math.max(0, 0.44 - hexR);
  const cellId = hashInt(cx + (useFirst ? 0 : 131), cy + (useFirst ? 0 : 257), 701);

  return { cellId, edgeDist };
}

export type TextureResolution = 512 | 1024 | 2048 | 4096;

export class TextureCache {
  private cache = new Map<string, ProceduralPBRMaps>();
  private surfaceCanvasCache = new Map<
    string,
    { normCanvas: HTMLCanvasElement; mrCanvas: HTMLCanvasElement }
  >();
  private albedoCanvasCache = new Map<string, HTMLCanvasElement>();
  private maxAnisotropy: number;
  private resolution: TextureResolution;

  constructor(maxAnisotropy: number, resolution: number = 1024) {
    this.maxAnisotropy = Math.max(1, maxAnisotropy);
    this.resolution =
      resolution >= 4096 ? 4096 : resolution >= 2048 ? 2048 : resolution >= 1024 ? 1024 : 512;
  }

  public getResolution(): TextureResolution {
    return this.resolution;
  }

  private getSurfaceKey(paint: PartPaint): string {
    return [
      this.resolution,
      paint.pattern,
      paint.wear.toFixed(2),
      paint.metalness >= 0.45 ? 'm' : 'd',
    ].join('|');
  }

  private getAlbedoKey(paint: PartPaint): string {
    return [
      this.resolution,
      paint.pattern,
      paint.primaryColor.toLowerCase(),
      paint.secondaryColor.toLowerCase(),
      paint.wear.toFixed(2),
      paint.metalness >= 0.45 ? 'm' : 'd',
    ].join('|');
  }

  private getKey(paint: PartPaint): string {
    return `${this.getAlbedoKey(paint)}|${paint.patternScale.toFixed(2)}`;
  }

  public getMaps(paint: PartPaint): ProceduralPBRMaps {
    const key = this.getKey(paint);
    const existing = this.cache.get(key);
    if (existing) {
      this.cache.delete(key);
      this.cache.set(key, existing);
      return existing;
    }

    const generated = this.generateMaps(paint);
    this.cache.set(key, generated);
    if (this.cache.size > MAX_CACHE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        const old = this.cache.get(oldestKey);
        old?.map.dispose();
        old?.normalMap.dispose();
        old?.roughnessMap.dispose();
        if (old && old.metalnessMap !== old.roughnessMap) {
          old.metalnessMap.dispose();
        }
        this.cache.delete(oldestKey);
      }
    }
    return generated;
  }

  private configureTexture(
    canvas: HTMLCanvasElement,
    isColor: boolean,
    scale: number
  ): THREE.CanvasTexture {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(scale, scale);
    tex.anisotropy = this.maxAnisotropy;
    tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.userData.mimeType = 'image/jpeg';
    tex.needsUpdate = true;
    return tex;
  }

  /** Builds a crisp 256x256 native-pixel translucent micro-grain tile for fast 2K/4K export enhancement. */
  private buildMicroDetailTile(pattern: PartPaint['pattern']): HTMLCanvasElement {
    const tile = document.createElement('canvas');
    tile.width = 256;
    tile.height = 256;
    const ctx = tile.getContext('2d')!;
    const img = ctx.createImageData(256, 256);
    const data = img.data;
    const isDirectional = pattern === 'brushed_steel' || pattern === 'wood';

    for (let y = 0; y < 256; y++) {
      const row = y * 256;
      const lineBias = isDirectional ? (hashInt(0, y, 421) - 0.5) * 48 : 0;
      for (let x = 0; x < 256; x++) {
        const n = hashInt(x, y, 733);
        const delta = isDirectional
          ? lineBias * 0.65 + (n - 0.5) * 86
          : pattern === 'carbon'
            ? Math.sin((x + y) * 0.7854) * 34 + (n - 0.5) * 52
            : (n - 0.5) * 96;
        const bright = delta >= 0 ? 255 : 0;
        const alpha = clampByte(Math.min(255, Math.abs(delta) * 2.2));
        const i4 = (row + x) * 4;
        data[i4] = bright;
        data[i4 + 1] = bright;
        data[i4 + 2] = bright;
        data[i4 + 3] = alpha;
      }
    }
    ctx.putImageData(img, 0, 0);
    return tile;
  }

  /** Upscales a base canvas to exact 2K/4K dimensions with fast native micro-grain & crisp hairline wear. */
  private upscaleCanvasWithDetail(
    src: HTMLCanvasElement,
    targetSize: number,
    microTile: HTMLCanvasElement | null,
    overlayAlpha: number,
    scratchOverlay?: {
      wear: number;
      color: string;
      alpha: number;
    }
  ): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = targetSize;
    out.height = targetSize;
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, targetSize, targetSize);

    if (microTile && overlayAlpha > 0) {
      const pat = ctx.createPattern(microTile, 'repeat');
      if (pat) {
        ctx.save();
        ctx.globalAlpha = overlayAlpha;
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, targetSize, targetSize);
        ctx.restore();
      }
    }

    if (scratchOverlay && scratchOverlay.wear > 0.02) {
      const count = Math.round(48 * scratchOverlay.wear);
      const scale = targetSize / 1024;
      ctx.save();
      ctx.strokeStyle = scratchOverlay.color;
      ctx.globalAlpha = scratchOverlay.alpha;
      ctx.lineCap = 'round';
      for (let i = 0; i < count; i++) {
        const x0 = hashInt(i, 211, 953) * targetSize;
        const y0 = hashInt(i, 307, 953) * targetSize;
        const angle = (hashInt(i, 401, 953) - 0.5) * Math.PI * 1.2;
        const len = (14 + hashInt(i, 509, 953) * 44) * scale;
        ctx.lineWidth = Math.max(0.75, (0.55 + hashInt(i, 613, 953) * 0.7) * scale);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + Math.cos(angle) * len, y0 + Math.sin(angle) * len);
        ctx.stroke();
      }
      ctx.restore();
    }

    return out;
  }

  private generateMaps(paint: PartPaint): ProceduralPBRMaps {
    const surfaceKey = this.getSurfaceKey(paint);
    const albedoKey = this.getAlbedoKey(paint);
    const cachedSurface = this.surfaceCanvasCache.get(surfaceKey);
    const cachedAlbedo = this.albedoCanvasCache.get(albedoKey);

    // Fast path: reuse both shared albedo & surface HTMLCanvasElements (only wrap with new repeat scale)
    if (cachedAlbedo && cachedSurface) {
      const metallicRoughnessMap = this.configureTexture(
        cachedSurface.mrCanvas,
        false,
        paint.patternScale
      );
      return {
        map: this.configureTexture(cachedAlbedo, true, paint.patternScale),
        normalMap: this.configureTexture(cachedSurface.normCanvas, false, paint.patternScale),
        roughnessMap: metallicRoughnessMap,
        metalnessMap: metallicRoughnessMap,
      };
    }

    const targetSize = this.resolution;
    // Synthesize full procedural noise base at up to 1024px, then enhance natively to 2K/4K for fast crisp exports
    const size = Math.min(targetSize, 1024);

    const albCanvas = document.createElement('canvas');
    albCanvas.width = size;
    albCanvas.height = size;
    const albCtx = albCanvas.getContext('2d')!;
    const albImg = albCtx.createImageData(size, size);
    const albData = albImg.data;

    const rghData = new Uint8ClampedArray(size * size * 4);
    const metData = new Uint8ClampedArray(size * size * 4);

    const height = new Float32Array(size * size);

    const pRgb = hexToRgb(paint.primaryColor);
    const sRgb = hexToRgb(paint.secondaryColor);
    const invSize = 1 / size;
    const isMetallic = paint.metalness >= 0.45;

    let normalStrength = 0.72;

    switch (paint.pattern) {
      case 'solid': {
        // Glass-filled tactical polymer / Type-III bead-blasted hardcoat with tactile micro-pebble stipple
        normalStrength = 0.68;
        for (let y = 0; y < size; y++) {
          const v = y * invSize;
          const row = y * size;
          for (let x = 0; x < size; x++) {
            const u = x * invSize;
            const macro = tileFbm(u, v, 5, 5, 3, 11);
            const pebble = tileNoise(u, v, 64, 64, 37);
            const fine = tileNoise(u, v, 160, 160, 73);
            const sparkle = hashInt(x, y, 107);
            const stipple = pebble * 0.56 + fine * 0.36 + sparkle * 0.08;

            // Micro-AO darkening inside pebble valleys + soft matte highlights on pebble crests
            const cavity = clamp01((stipple - 0.18) / 0.82);
            const toneShift = (macro - 0.5) * 14 + (stipple - 0.5) * 13;
            const aoFactor = 0.91 + cavity * 0.11;
            const i4 = (row + x) * 4;
            albData[i4] = clampByte((pRgb[0] + toneShift) * aoFactor);
            albData[i4 + 1] = clampByte((pRgb[1] + toneShift) * aoFactor);
            albData[i4 + 2] = clampByte((pRgb[2] + toneShift) * aoFactor);
            albData[i4 + 3] = 255;

            height[row + x] = 0.5 + (macro - 0.5) * 0.09 + (pebble - 0.5) * 0.22 + (fine - 0.5) * 0.12;

            // Rich tactile roughness variation (168..248) — realistic satin-matte polymer breakup
            const rv = clampByte(174 + (1 - stipple) * 46 + macro * 26);
            rghData[i4] = rv;
            rghData[i4 + 1] = rv;
            rghData[i4 + 2] = rv;
            rghData[i4 + 3] = 255;

            const mv = isMetallic ? clampByte(226 + stipple * 24) : 255;
            metData[i4] = mv;
            metData[i4 + 1] = mv;
            metData[i4 + 2] = mv;
            metData[i4 + 3] = 255;
          }
        }
        break;
      }

      case 'brushed_steel': {
        // CNC-machined & Type-III anodized / blued ordnance metal with ultra-fine micro-brushing & crystal grain
        normalStrength = 0.62;
        for (let y = 0; y < size; y++) {
          const v = y * invSize;
          const row = y * size;
          for (let x = 0; x < size; x++) {
            const u = x * invSize;
            // Fine short-coherence CNC brush grain + bead-blasted anodized micro-crystal + subtle gun-oil patina
            const brush = tileFbm(u, v, 10, 140, 3, 131);
            const fineBrush = tileNoise(u, v, 24, 320, 167);
            const crystal = tileNoise(u, v, 144, 144, 199);
            const microCrystal = tileNoise(u, v, 256, 256, 211);
            const oilCloud = tileFbm(u, v, 5, 5, 3, 241);

            const mixT = clamp01(0.05 + oilCloud * 0.16 + crystal * 0.08 + brush * 0.08);
            const microTone =
              (fineBrush - 0.5) * 6.5 + (crystal - 0.5) * 7.5 + (microCrystal - 0.5) * 4.5;
            const i4 = (row + x) * 4;

            albData[i4] = clampByte(lerp(pRgb[0], sRgb[0], mixT) + microTone);
            albData[i4 + 1] = clampByte(lerp(pRgb[1], sRgb[1], mixT) + microTone);
            albData[i4 + 2] = clampByte(lerp(pRgb[2], sRgb[2], mixT) + microTone);
            albData[i4 + 3] = 255;

            height[row + x] =
              0.5 +
              (brush - 0.5) * 0.09 +
              (fineBrush - 0.5) * 0.08 +
              (crystal - 0.5) * 0.08 +
              (microCrystal - 0.5) * 0.05;

            // High-contrast metallic studio roughness breakup (124..242): satin CNC sheen vs micro-blasted anodized crystal
            const rv = clampByte(126 + oilCloud * 54 + (1 - fineBrush) * 28 + crystal * 26);
            rghData[i4] = rv;
            rghData[i4 + 1] = rv;
            rghData[i4 + 2] = rv;
            rghData[i4 + 3] = 255;

            // Bare machined micro-ridges slightly more metallic than dark oil patina pockets
            const mv = clampByte(224 + fineBrush * 16 + (1 - oilCloud) * 14);
            metData[i4] = mv;
            metData[i4 + 1] = mv;
            metData[i4 + 2] = mv;
            metData[i4 + 3] = 255;
          }
        }
        break;
      }

      case 'wood': {
        // Quarter-sawn oil-rubbed European walnut with crisp cathedral rings, medullary cross-rays & elongated open pores
        normalStrength = 0.94;
        for (let y = 0; y < size; y++) {
          const v = y * invSize;
          const row = y * size;
          for (let x = 0; x < size; x++) {
            const u = x * invSize;
            // Flowing organic figure warp along barrel/stock axis (U)
            const warpA = tileFbm(u, v, 2, 3, 3, 307);
            const warpB = tileFbm(u + warpA * 0.18, v, 4, 8, 3, 331);
            const dxk = u - 0.34;
            const dyk = v - 0.56;
            const knot = Math.exp(-(dxk * dxk * 16 + dyk * dyk * 42)) * 0.42;

            // Tighter realistic walnut growth rings with sharp dark latewood lines
            const ringCoord = v * 19.5 + warpA * 3.6 + warpB * 1.4 + knot * 4.4;
            const ringFrac = ringCoord - Math.floor(ringCoord);
            const earlyToLate = Math.pow(Math.sin(ringFrac * Math.PI), 0.62);
            // Sharp dark winter-growth vein at the ring boundary
            const darkVein = Math.pow(Math.max(0, 1 - Math.abs(ringFrac - 0.5) * 6.5), 2.2) * 0.45;

            // Fine longitudinal wood fibers + subtle perpendicular medullary rays (authentic hardwood chatoyance!)
            const fiber = tileNoise(u, v, 8, 160, 359);
            const medRay = tileNoise(u, v, 96, 12, 373);
            const raySheen = medRay > 0.78 ? (medRay - 0.78) * 1.6 : 0;

            // Crisp elongated dark walnut vessels / open pores running along U
            const poreField = tileNoise(u, v, 14, 240, 389);
            const poreBreak = tileNoise(u, v, 48, 64, 409);
            const poreRaw = poreField * 0.74 + poreBreak * 0.26;
            const isPore = poreRaw > 0.84 ? clamp01((poreRaw - 0.84) / 0.16) : 0;

            const warmMottle = tileFbm(u, v, 3, 4, 3, 433);
            const t = clamp01(
              0.08 +
                earlyToLate * 0.54 +
                darkVein * 0.35 +
                (fiber - 0.5) * 0.22 +
                (warmMottle - 0.5) * 0.22 +
                isPore * 0.32
            );
            const poreDarken = 1 - isPore * 0.44;
            const rayHighlight = 1 + raySheen * 0.14;

            const i4 = (row + x) * 4;
            albData[i4] = clampByte(lerp(pRgb[0], sRgb[0], t) * poreDarken * rayHighlight);
            albData[i4 + 1] = clampByte(lerp(pRgb[1], sRgb[1], t) * poreDarken * rayHighlight);
            albData[i4 + 2] = clampByte(lerp(pRgb[2], sRgb[2], t) * poreDarken * rayHighlight);
            albData[i4 + 3] = 255;

            // Tactile grain contour + crisp recessed open pores
            height[row + x] =
              0.56 +
              (1 - earlyToLate) * 0.11 -
              darkVein * 0.08 +
              (fiber - 0.5) * 0.09 -
              isPore * 0.3;

            // Hand-rubbed satin linseed oil sheen: glossy earlywood flats (142) vs matte dark veins & deep pores (246)
            const rv = clampByte(
              146 + earlyToLate * 42 + darkVein * 28 + isPore * 48 + (warmMottle - 0.5) * 18 - raySheen * 18
            );
            rghData[i4] = rv;
            rghData[i4 + 1] = rv;
            rghData[i4 + 2] = rv;
            rghData[i4 + 3] = 255;

            metData[i4] = 255;
            metData[i4 + 1] = 255;
            metData[i4 + 2] = 255;
            metData[i4 + 3] = 255;
          }
        }
        break;
      }

      case 'carbon': {
        // Aerospace 2x2 diagonal twill carbon fiber with distinct multi-filament sheen & glossy resin depth
        normalStrength = 1.18;
        const cellsPerTile = size >= 1024 ? 128 : 96;
        const cellPx = size / cellsPerTile;
        for (let y = 0; y < size; y++) {
          const row = y * size;
          const gy = Math.floor(y / cellPx);
          const ly = (y - gy * cellPx) / cellPx;
          for (let x = 0; x < size; x++) {
            const gx = Math.floor(x / cellPx);
            const lx = (x - gx * cellPx) / cellPx;

            const phase = (gx + gy) & 3;
            const isHoriz = phase < 2;

            const across = isHoriz ? ly : lx;
            const along = isHoriz
              ? (phase === 0 ? lx * 0.5 : 0.5 + lx * 0.5)
              : (phase === 2 ? ly * 0.5 : 0.5 + ly * 0.5);

            const archAcross = Math.sin(across * Math.PI);
            const archAlong = Math.sin(along * Math.PI);
            const pillow =
              Math.pow(Math.max(0, archAcross), 0.58) *
              (0.46 + 0.54 * Math.pow(Math.max(0, archAlong), 0.48));

            const strand = 0.5 + 0.5 * Math.sin(across * Math.PI * 14);
            const seam = archAcross < 0.16 ? 0.42 : 1.0;

            // High-contrast anisotropic graphite light-catch between warp and weft tows
            const sheen = isHoriz ? 0.62 + 0.38 * pillow : 0.12 + 0.24 * pillow;
            const specGlow = isHoriz ? 26 * pillow * (0.76 + 0.24 * strand) : 6 * pillow * strand;

            const i4 = (row + x) * 4;
            const baseR = lerp(sRgb[0], pRgb[0], clamp01(sheen));
            const baseG = lerp(sRgb[1], pRgb[1], clamp01(sheen));
            const baseB = lerp(sRgb[2], pRgb[2], clamp01(sheen));

            albData[i4] = clampByte((baseR + specGlow) * seam);
            albData[i4 + 1] = clampByte((baseG + specGlow) * seam);
            albData[i4 + 2] = clampByte((baseB + specGlow * 1.1) * seam);
            albData[i4 + 3] = 255;

            height[row + x] = 0.2 + pillow * 0.58 + strand * 0.045;

            // Glossy clear resin over tow crowns (104) vs matte recessed weave pockets (238)
            const rv = clampByte(
              isHoriz ? 106 + (1 - pillow) * 110 : 148 + (1 - pillow) * 90
            );
            rghData[i4] = rv;
            rghData[i4 + 1] = rv;
            rghData[i4 + 2] = rv;
            rghData[i4 + 3] = 255;

            const mv = clampByte(isHoriz ? 235 : 190);
            metData[i4] = mv;
            metData[i4 + 1] = mv;
            metData[i4 + 2] = mv;
            metData[i4 + 3] = 255;
          }
        }
        break;
      }

      case 'digital_camo': {
        // Multi-scale tactical Cerakote digital camo with fine powder-coat micro-grain & tone roughness breakup
        normalStrength = 0.62;
        const midRgb: [number, number, number] = [
          Math.round(lerp(pRgb[0], sRgb[0], 0.48)),
          Math.round(lerp(pRgb[1], sRgb[1], 0.48)),
          Math.round(lerp(pRgb[2], sRgb[2], 0.48)),
        ];
        const hiRgb: [number, number, number] = [
          clampByte(lerp(pRgb[0], 228, 0.18)),
          clampByte(lerp(pRgb[1], 232, 0.18)),
          clampByte(lerp(pRgb[2], 236, 0.18)),
        ];

        for (let y = 0; y < size; y++) {
          const v = y * invSize;
          const row = y * size;
          const pyLarge = Math.floor(v * 16);
          const pyMed = Math.floor(v * 32);
          const pySmall = Math.floor(v * 64);
          for (let x = 0; x < size; x++) {
            const u = x * invSize;
            const pxLarge = Math.floor(u * 16);
            const pxMed = Math.floor(u * 32);
            const pxSmall = Math.floor(u * 64);

            const nLarge = hashInt(pxLarge, pyLarge, 503);
            const nMed = hashInt(pxMed, pyMed, 521);
            const nSmall = hashInt(pxSmall, pySmall, 541);
            const combined = nLarge * 0.52 + nMed * 0.3 + nSmall * 0.18;

            const chosen =
              combined < 0.36 ? sRgb : combined < 0.62 ? pRgb : combined < 0.84 ? midRgb : hiRgb;

            const grit = tileNoise(u, v, 72, 72, 563) * 0.58 + tileNoise(u, v, 160, 160, 577) * 0.42;
            const macro = tileFbm(u, v, 4, 4, 2, 587);
            const shift = (grit - 0.5) * 11 + (macro - 0.5) * 8;

            const i4 = (row + x) * 4;
            albData[i4] = clampByte(chosen[0] + shift);
            albData[i4 + 1] = clampByte(chosen[1] + shift);
            albData[i4 + 2] = clampByte(chosen[2] + shift);
            albData[i4 + 3] = 255;

            height[row + x] = 0.5 + (grit - 0.5) * 0.22 + (combined < 0.36 ? -0.025 : 0.02);

            const baseRgh = combined < 0.36 ? 236 : combined < 0.62 ? 204 : 186;
            const rv = clampByte(baseRgh + (grit - 0.5) * 26);
            rghData[i4] = rv;
            rghData[i4 + 1] = rv;
            rghData[i4 + 2] = rv;
            rghData[i4 + 3] = 255;

            const mv = isMetallic ? clampByte(combined < 0.36 ? 210 : 244) : 255;
            metData[i4] = mv;
            metData[i4 + 1] = mv;
            metData[i4 + 2] = mv;
            metData[i4 + 3] = 255;
          }
        }
        break;
      }

      case 'tiger_stripe': {
        // Domain-warped tactical tiger-stripe Cerakote with micro-stipple powder-coat depth
        normalStrength = 0.62;
        const darkRgb: [number, number, number] = [
          clampByte(sRgb[0] * 0.54),
          clampByte(sRgb[1] * 0.54),
          clampByte(sRgb[2] * 0.54),
        ];
        const midRgb: [number, number, number] = [
          Math.round(lerp(pRgb[0], sRgb[0], 0.5)),
          Math.round(lerp(pRgb[1], sRgb[1], 0.5)),
          Math.round(lerp(pRgb[2], sRgb[2], 0.5)),
        ];

        for (let y = 0; y < size; y++) {
          const v = y * invSize;
          const row = y * size;
          for (let x = 0; x < size; x++) {
            const u = x * invSize;
            const warpX = tileFbm(u, v, 3, 6, 3, 601);
            const warpY = tileFbm(u, v, 4, 8, 3, 619);
            const band = tileFbm(u + warpX * 0.22, v * 2.2 + warpY * 0.42, 2, 10, 3, 641);
            const slash = Math.sin((v * 8 + warpX * 2.6 + u * 1.4) * Math.PI * 2) * 0.5 + 0.5;
            const maskVal = band * 0.65 + slash * 0.35;

            const chosen =
              maskVal < 0.31 ? darkRgb : maskVal < 0.5 ? sRgb : maskVal < 0.72 ? pRgb : midRgb;

            const grit = tileNoise(u, v, 72, 72, 659) * 0.58 + tileNoise(u, v, 160, 160, 673) * 0.42;
            const shift = (grit - 0.5) * 11;

            const i4 = (row + x) * 4;
            albData[i4] = clampByte(chosen[0] + shift);
            albData[i4 + 1] = clampByte(chosen[1] + shift);
            albData[i4 + 2] = clampByte(chosen[2] + shift);
            albData[i4 + 3] = 255;

            height[row + x] = 0.5 + (grit - 0.5) * 0.22;

            const rv = clampByte((maskVal < 0.31 ? 238 : 196) + (grit - 0.5) * 26);
            rghData[i4] = rv;
            rghData[i4 + 1] = rv;
            rghData[i4 + 2] = rv;
            rghData[i4 + 3] = 255;

            const mv = isMetallic ? clampByte(maskVal < 0.31 ? 205 : 242) : 255;
            metData[i4] = mv;
            metData[i4 + 1] = mv;
            metData[i4 + 2] = mv;
            metData[i4 + 3] = 255;
          }
        }
        break;
      }

      case 'hex_tech': {
        // Precision CNC-milled hex tactical armor with brushed metallic facets & dark micro-AO chamfered grooves
        normalStrength = 1.24;
        const hexCols = 22;
        for (let y = 0; y < size; y++) {
          const v = y * invSize;
          const row = y * size;
          for (let x = 0; x < size; x++) {
            const u = x * invSize;
            const { cellId, edgeDist } = sampleHexTile(u, v, hexCols);

            const bevel = clamp01((edgeDist - 0.02) / 0.044);
            const brush = tileNoise(u, v, 8, 160, 727);
            // Crisp specular edge glint right on the hex chamfer lip
            const lipGlint = edgeDist > 0.036 && edgeDist < 0.068 ? 10 : 0;

            const faceR = lerp(pRgb[0], sRgb[0], cellId * 0.32) + (brush - 0.5) * 11 + lipGlint;
            const faceG = lerp(pRgb[1], sRgb[1], cellId * 0.32) + (brush - 0.5) * 11 + lipGlint;
            const faceB = lerp(pRgb[2], sRgb[2], cellId * 0.32) + (brush - 0.5) * 11 + lipGlint;

            const seamR = sRgb[0] * 0.36;
            const seamG = sRgb[1] * 0.36;
            const seamB = sRgb[2] * 0.36;

            const i4 = (row + x) * 4;
            albData[i4] = clampByte(lerp(seamR, faceR, bevel));
            albData[i4 + 1] = clampByte(lerp(seamG, faceG, bevel));
            albData[i4 + 2] = clampByte(lerp(seamB, faceB, bevel));
            albData[i4 + 3] = 255;

            height[row + x] = 0.16 + bevel * 0.64 + (brush - 0.5) * 0.05;

            const rv = clampByte(lerp(246, 136 + cellId * 52 + (brush - 0.5) * 18, bevel));
            rghData[i4] = rv;
            rghData[i4 + 1] = rv;
            rghData[i4 + 2] = rv;
            rghData[i4 + 3] = 255;

            const mv = clampByte(lerp(135, 248, bevel));
            metData[i4] = mv;
            metData[i4 + 1] = mv;
            metData[i4 + 2] = mv;
            metData[i4 + 3] = 255;
          }
        }
        break;
      }
    }

    // Battle Wear: Carbon fouling + handling patina + exposed raw-metal hairline scratches + micro-pitting
    if (paint.wear > 0.02) {
      const w = paint.wear;

      // 1. Organic carbon fouling & handling sheen breakup
      for (let y = 0; y < size; y++) {
        const v = y * invSize;
        const row = y * size;
        for (let x = 0; x < size; x++) {
          const u = x * invSize;
          const grimeField = tileFbm(u, v, 4, 4, 3, 811);
          if (grimeField > 0.56) {
            const grime = clamp01(((grimeField - 0.56) / 0.44) * w * 0.78);
            const i4 = (row + x) * 4;
            albData[i4] = clampByte(lerp(albData[i4], 18, grime * 0.5));
            albData[i4 + 1] = clampByte(lerp(albData[i4 + 1], 16, grime * 0.5));
            albData[i4 + 2] = clampByte(lerp(albData[i4 + 2], 14, grime * 0.5));

            const rv = clampByte(lerp(rghData[i4], 252, grime * 0.78));
            rghData[i4] = rv;
            rghData[i4 + 1] = rv;
            rghData[i4 + 2] = rv;

            if (isMetallic) {
              const mv = clampByte(lerp(metData[i4], 150, grime * 0.65));
              metData[i4] = mv;
              metData[i4 + 1] = mv;
              metData[i4 + 2] = mv;
            }
          }
        }
      }

      // 2. Crisp hairline scratches & worn micro-flecks catching raking studio light
      const isWood = paint.pattern === 'wood';
      const scratchRgb: [number, number, number] = isWood
        ? [clampByte(pRgb[0] * 1.24 + 18), clampByte(pRgb[1] * 1.2 + 12), clampByte(pRgb[2] * 1.14 + 8)]
        : isMetallic
          ? [206, 214, 224]
          : [clampByte(pRgb[0] + 32), clampByte(pRgb[1] + 32), clampByte(pRgb[2] + 34)];
      const scratchRoughByte = isMetallic ? 72 : isWood ? 236 : 184;

      const scaleFactor = size / 512;
      const scratchCount = Math.round(64 * w);
      for (let i = 0; i < scratchCount; i++) {
        const x0 = hashInt(i, 17, 907) * size;
        const y0 = hashInt(i, 41, 907) * size;
        const angle = (hashInt(i, 67, 907) - 0.5) * Math.PI * 1.15;
        const len = (8 + hashInt(i, 89, 907) * 34) * scaleFactor;
        const width = (0.42 + hashInt(i, 113, 907) * 0.62) * scaleFactor;
        const intensity = 0.4 + w * 0.55;

        carveScratch(
          albData,
          rghData,
          metData,
          height,
          size,
          x0,
          y0,
          angle,
          len,
          width,
          intensity,
          scratchRgb,
          scratchRoughByte,
          isMetallic
        );
      }
    }

    albCtx.putImageData(albImg, 0, 0);

    let finalAlbCanvas = albCanvas;
    let finalMrCanvas: HTMLCanvasElement;
    let finalNormCanvas: HTMLCanvasElement;

    if (cachedSurface) {
      finalMrCanvas = cachedSurface.mrCanvas;
      finalNormCanvas = cachedSurface.normCanvas;
      if (targetSize > size) {
        const microTile = this.buildMicroDetailTile(paint.pattern);
        const isWood = paint.pattern === 'wood';
        const scratchHex = isWood
          ? `rgb(${clampByte(pRgb[0] * 1.24 + 18)}, ${clampByte(pRgb[1] * 1.2 + 12)}, ${clampByte(pRgb[2] * 1.14 + 8)})`
          : isMetallic
            ? 'rgb(214, 222, 232)'
            : `rgb(${clampByte(pRgb[0] + 32)}, ${clampByte(pRgb[1] + 32)}, ${clampByte(pRgb[2] + 34)})`;
        finalAlbCanvas = this.upscaleCanvasWithDetail(albCanvas, targetSize, microTile, 0.06, {
          wear: paint.wear,
          color: scratchHex,
          alpha: 0.42,
        });
      }
    } else {
      // Pack Roughness (G) and Metalness (B) into a single glTF 2.0 native metallicRoughnessMap
      const mrCanvas = document.createElement('canvas');
      mrCanvas.width = size;
      mrCanvas.height = size;
      const mrCtx = mrCanvas.getContext('2d')!;
      const mrImg = mrCtx.createImageData(size, size);
      const mrData = mrImg.data;
      const totalPixels = size * size;
      for (let p = 0; p < totalPixels; p++) {
        const i4 = p * 4;
        mrData[i4] = 255; // R: neutral AO
        mrData[i4 + 1] = rghData[i4]; // G: roughness
        mrData[i4 + 2] = metData[i4]; // B: metalness
        mrData[i4 + 3] = 255;
      }
      mrCtx.putImageData(mrImg, 0, 0);

      const normCanvas = buildNormalMapCanvas(height, size, normalStrength);
      finalMrCanvas = mrCanvas;
      finalNormCanvas = normCanvas;

      if (targetSize > size) {
        const microTile = this.buildMicroDetailTile(paint.pattern);
        const isWood = paint.pattern === 'wood';
        const scratchHex = isWood
          ? `rgb(${clampByte(pRgb[0] * 1.24 + 18)}, ${clampByte(pRgb[1] * 1.2 + 12)}, ${clampByte(pRgb[2] * 1.14 + 8)})`
          : isMetallic
            ? 'rgb(214, 222, 232)'
            : `rgb(${clampByte(pRgb[0] + 32)}, ${clampByte(pRgb[1] + 32)}, ${clampByte(pRgb[2] + 34)})`;
        const mrScratchColor = isMetallic ? 'rgb(255, 76, 255)' : isWood ? 'rgb(255, 236, 255)' : 'rgb(255, 186, 255)';

        const auxMapSize = Math.min(targetSize, 2048);
        finalAlbCanvas = this.upscaleCanvasWithDetail(albCanvas, targetSize, microTile, 0.06, {
          wear: paint.wear,
          color: scratchHex,
          alpha: 0.42,
        });
        finalMrCanvas = this.upscaleCanvasWithDetail(mrCanvas, auxMapSize, microTile, 0.04, {
          wear: paint.wear,
          color: mrScratchColor,
          alpha: 0.55,
        });
        finalNormCanvas = this.upscaleCanvasWithDetail(normCanvas, auxMapSize, null, 0);
      }

      if (this.surfaceCanvasCache.size >= MAX_CACHE) {
        const oldest = this.surfaceCanvasCache.keys().next().value;
        if (oldest) this.surfaceCanvasCache.delete(oldest);
      }
      this.surfaceCanvasCache.set(surfaceKey, {
        normCanvas: finalNormCanvas,
        mrCanvas: finalMrCanvas,
      });
    }

    if (this.albedoCanvasCache.size >= MAX_CACHE) {
      const oldest = this.albedoCanvasCache.keys().next().value;
      if (oldest) this.albedoCanvasCache.delete(oldest);
    }
    this.albedoCanvasCache.set(albedoKey, finalAlbCanvas);

    const metallicRoughnessMap = this.configureTexture(finalMrCanvas, false, paint.patternScale);
    return {
      map: this.configureTexture(finalAlbCanvas, true, paint.patternScale),
      normalMap: this.configureTexture(finalNormCanvas, false, paint.patternScale),
      roughnessMap: metallicRoughnessMap,
      metalnessMap: metallicRoughnessMap,
    };
  }

  public disposeAll(): void {
    for (const entry of this.cache.values()) {
      entry.map.dispose();
      entry.normalMap.dispose();
      entry.roughnessMap.dispose();
      if (entry.metalnessMap !== entry.roughnessMap) {
        entry.metalnessMap.dispose();
      }
    }
    this.cache.clear();
    this.surfaceCanvasCache.clear();
    this.albedoCanvasCache.clear();
  }
}

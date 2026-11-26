import { GlbExportQuality, PartPaint } from '../types/weapon';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

export interface GlbBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
  name?: string;
}

export interface GlbImageDef {
  mimeType?: string;
  bufferView?: number;
  uri?: string;
  name?: string;
}

export interface GlbTextureDef {
  source?: number;
  sampler?: number;
}

export interface GlbMaterialDef {
  pbrMetallicRoughness?: {
    baseColorTexture?: { index: number };
    metallicRoughnessTexture?: { index: number };
  };
  normalTexture?: { index: number };
  occlusionTexture?: { index: number };
  emissiveTexture?: { index: number };
}

export interface GlbAccessorDef {
  bufferView?: number;
  sparse?: {
    indices?: { bufferView: number };
    values?: { bufferView: number };
  };
  [key: string]: unknown;
}

export interface GlbJson {
  asset: { version: string; generator?: string };
  buffers?: Array<{ byteLength: number; uri?: string }>;
  bufferViews?: GlbBufferView[];
  accessors?: GlbAccessorDef[];
  images?: GlbImageDef[];
  textures?: GlbTextureDef[];
  materials?: GlbMaterialDef[];
  [key: string]: unknown;
}

export interface ParsedGlb {
  json: GlbJson;
  bin: Uint8Array;
}

/**
 * Parses a binary glTF 2.0 (.glb) buffer into its JSON descriptor and BIN payload.
 */
export function parseGlbChunks(buffer: ArrayBuffer): ParsedGlb {
  if (buffer.byteLength < 20) {
    throw new Error('Invalid GLB: file too short.');
  }
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  if (magic !== GLB_MAGIC || version !== GLB_VERSION) {
    throw new Error('Invalid GLB header or unsupported glTF version.');
  }

  let offset = 12;
  let json: GlbJson | null = null;
  let bin: Uint8Array = new Uint8Array(0);

  while (offset + 8 <= buffer.byteLength) {
    const chunkLen = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLen;
    if (chunkEnd > buffer.byteLength) {
      throw new Error('Invalid GLB: truncated chunk.');
    }

    if (chunkType === CHUNK_JSON) {
      const jsonText = new TextDecoder('utf-8').decode(new Uint8Array(buffer, chunkStart, chunkLen));
      json = JSON.parse(jsonText) as GlbJson;
    } else if (chunkType === CHUNK_BIN) {
      bin = new Uint8Array(buffer, chunkStart, chunkLen);
    }

    offset = chunkEnd;
  }

  if (!json) {
    throw new Error('Invalid GLB: missing JSON chunk.');
  }

  return { json, bin };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hashBytesKey(prefix: string, bytes: Uint8Array): string {
  let h1 = 2166136261 >>> 0;
  let h2 = 2166136261 >>> 0;
  const step = Math.max(1, Math.floor(bytes.byteLength / 2048));
  for (let i = 0; i < bytes.byteLength; i += step) {
    h1 = Math.imul(h1 ^ bytes[i], 16777619) >>> 0;
    h2 = Math.imul(h2 ^ bytes[bytes.byteLength - 1 - i], 16777619) >>> 0;
  }
  return `${prefix}|${bytes.byteLength}|${h1.toString(16)}|${h2.toString(16)}`;
}

/**
 * Rebuilds a strictly 4-byte-aligned core glTF 2.0 .glb binary after replacing one or more
 * bufferViews and optionally compacting out dropped duplicate image bufferViews.
 */
export function replaceGlbBufferViews(
  buffer: ArrayBuffer,
  replacements: Map<number, Uint8Array>,
  dropDuplicateImages = true
): ArrayBuffer {
  const { json, bin } = parseGlbChunks(buffer);
  const origBufferViews = json.bufferViews ?? [];

  // Resolve current bytes for every bufferView
  const bvBytes: Uint8Array[] = origBufferViews.map((bv, i) => {
    const rep = replacements.get(i);
    if (rep) return rep;
    const origOffset = bv.byteOffset ?? 0;
    return bin.subarray(origOffset, origOffset + bv.byteLength);
  });

  // Collect bufferViews referenced by accessors so we never drop non-image geometry views
  const accessorBufferViews = new Set<number>();
  for (const acc of json.accessors ?? []) {
    if (acc.bufferView !== undefined) accessorBufferViews.add(acc.bufferView);
    if (acc.sparse?.indices?.bufferView !== undefined) {
      accessorBufferViews.add(acc.sparse.indices.bufferView);
    }
    if (acc.sparse?.values?.bufferView !== undefined) {
      accessorBufferViews.add(acc.sparse.values.bufferView);
    }
  }

  // Exact byte-for-byte deduplication of embedded images (eliminates GLTFExporter duplicate normal canvases)
  const droppedBvIndices = new Set<number>();
  let imagesCompacted = false;

  if (dropDuplicateImages && json.images && json.images.length > 1) {
    const hashBuckets = new Map<string, number[]>();
    const oldImgToNewImg = new Map<number, number>();
    const keptImages: GlbImageDef[] = [];
    const keptImgBytes: Uint8Array[] = [];

    for (let imgIdx = 0; imgIdx < json.images.length; imgIdx++) {
      const img = json.images[imgIdx];
      if (img.bufferView === undefined) {
        oldImgToNewImg.set(imgIdx, keptImages.length);
        keptImages.push(img);
        keptImgBytes.push(new Uint8Array(0));
        continue;
      }

      const bytes = bvBytes[img.bufferView];
      const key = hashBytesKey(img.mimeType ?? '', bytes);
      const candidates = hashBuckets.get(key);
      let duplicateNewIdx = -1;
      if (candidates) {
        for (const candNewIdx of candidates) {
          if (bytesEqual(keptImgBytes[candNewIdx], bytes)) {
            duplicateNewIdx = candNewIdx;
            break;
          }
        }
      }

      if (duplicateNewIdx >= 0) {
        oldImgToNewImg.set(imgIdx, duplicateNewIdx);
        if (!accessorBufferViews.has(img.bufferView)) {
          droppedBvIndices.add(img.bufferView);
        }
        imagesCompacted = true;
      } else {
        const newIdx = keptImages.length;
        oldImgToNewImg.set(imgIdx, newIdx);
        keptImages.push(img);
        keptImgBytes.push(bytes);
        if (candidates) candidates.push(newIdx);
        else hashBuckets.set(key, [newIdx]);
      }
    }

    if (imagesCompacted) {
      // Guard: never drop a bufferView still referenced by any kept image
      for (const img of keptImages) {
        if (img.bufferView !== undefined) {
          droppedBvIndices.delete(img.bufferView);
        }
      }
      json.images = keptImages;
      for (const tex of json.textures ?? []) {
        if (tex.source !== undefined && oldImgToNewImg.has(tex.source)) {
          tex.source = oldImgToNewImg.get(tex.source)!;
        }
      }
    }
  }

  if (replacements.size === 0 && !imagesCompacted) {
    return buffer;
  }

  // Compact bufferViews if any duplicate image bufferViews were dropped
  const oldBvToNewBv = new Map<number, number>();
  const keptBufferViews: GlbBufferView[] = [];
  const keptSlices: Uint8Array[] = [];
  for (let i = 0; i < origBufferViews.length; i++) {
    if (droppedBvIndices.has(i)) continue;
    oldBvToNewBv.set(i, keptBufferViews.length);
    keptBufferViews.push(origBufferViews[i]);
    keptSlices.push(bvBytes[i]);
  }

  if (droppedBvIndices.size > 0) {
    json.bufferViews = keptBufferViews;
    for (const img of json.images ?? []) {
      if (img.bufferView !== undefined && oldBvToNewBv.has(img.bufferView)) {
        img.bufferView = oldBvToNewBv.get(img.bufferView)!;
      }
    }
    for (const acc of json.accessors ?? []) {
      if (acc.bufferView !== undefined && oldBvToNewBv.has(acc.bufferView)) {
        acc.bufferView = oldBvToNewBv.get(acc.bufferView)!;
      }
      if (acc.sparse?.indices?.bufferView !== undefined && oldBvToNewBv.has(acc.sparse.indices.bufferView)) {
        acc.sparse.indices.bufferView = oldBvToNewBv.get(acc.sparse.indices.bufferView)!;
      }
      if (acc.sparse?.values?.bufferView !== undefined && oldBvToNewBv.has(acc.sparse.values.bufferView)) {
        acc.sparse.values.bufferView = oldBvToNewBv.get(acc.sparse.values.bufferView)!;
      }
    }
  }

  // Calculate exact aligned BIN length
  let totalBinLen = 0;
  for (let i = 0; i < keptSlices.length; i++) {
    totalBinLen = (totalBinLen + 3) & ~3;
    totalBinLen += keptSlices[i].byteLength;
  }
  const paddedBinLen = (totalBinLen + 3) & ~3;

  // Assemble aligned BIN buffer and update bufferView offsets/lengths
  const newBin = new Uint8Array(paddedBinLen);
  let cursor = 0;
  for (let i = 0; i < keptBufferViews.length; i++) {
    cursor = (cursor + 3) & ~3;
    const bytes = keptSlices[i];
    newBin.set(bytes, cursor);
    keptBufferViews[i].byteOffset = cursor;
    keptBufferViews[i].byteLength = bytes.byteLength;
    cursor += bytes.byteLength;
  }

  if (json.buffers && json.buffers.length > 0) {
    json.buffers[0].byteLength = paddedBinLen;
  }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const paddedJsonLen = (jsonBytes.byteLength + 3) & ~3;

  const totalGlbLen = 12 + 8 + paddedJsonLen + 8 + paddedBinLen;
  const out = new ArrayBuffer(totalGlbLen);
  const outView = new DataView(out);
  const outBytes = new Uint8Array(out);

  // 12-byte GLB header
  outView.setUint32(0, GLB_MAGIC, true);
  outView.setUint32(4, GLB_VERSION, true);
  outView.setUint32(8, totalGlbLen, true);

  // JSON chunk (0x20 space-padded to 4-byte boundary per glTF 2.0 spec)
  outView.setUint32(12, paddedJsonLen, true);
  outView.setUint32(16, CHUNK_JSON, true);
  outBytes.set(jsonBytes, 20);
  for (let i = jsonBytes.byteLength; i < paddedJsonLen; i++) {
    outBytes[20 + i] = 0x20;
  }

  // BIN chunk (0x00 zero-padded to 4-byte boundary per glTF 2.0 spec)
  const binChunkOffset = 20 + paddedJsonLen;
  outView.setUint32(binChunkOffset, paddedBinLen, true);
  outView.setUint32(binChunkOffset + 4, CHUNK_BIN, true);
  outBytes.set(newBin, binChunkOffset + 8);

  return out;
}

/**
 * Calibrated visual-lossless JPEG quality per export tier.
 * Technical maps (normal & metallicRoughness) receive higher quality to keep surface shading clean.
 */
export function getGlbJpegQuality(quality: GlbExportQuality): { albedo: number; technical: number } {
  switch (quality) {
    case '500':
      return { albedo: 0.78, technical: 0.84 };
    case '1k':
      return { albedo: 0.82, technical: 0.87 };
    case '2k':
      return { albedo: 0.85, technical: 0.9 };
    case '4k':
      return { albedo: 0.88, technical: 0.92 };
  }
}

/**
 * Deduplicates exact-duplicate embedded images and recompresses unique JPEG images at calibrated
 * visual-lossless quality (core glTF 2.0, zero required extensions).
 */
export async function recompressGlbJpegs(
  glbBuffer: ArrayBuffer,
  quality: GlbExportQuality
): Promise<ArrayBuffer> {
  // First deduplicate byte-identical images (e.g. duplicate flipped normal canvases from GLTFExporter)
  const dedupedBuffer = replaceGlbBufferViews(glbBuffer, new Map(), true);

  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') {
    return dedupedBuffer;
  }

  const { json, bin } = parseGlbChunks(dedupedBuffer);
  const images = json.images;
  const bufferViews = json.bufferViews;
  if (!images || images.length === 0 || !bufferViews) {
    return dedupedBuffer;
  }

  // Track which image indices serve as normal or metallicRoughness technical maps
  const technicalImageIndices = new Set<number>();
  const textures = json.textures ?? [];
  for (const mat of json.materials ?? []) {
    const normTex = mat.normalTexture?.index;
    if (normTex !== undefined && textures[normTex]?.source !== undefined) {
      technicalImageIndices.add(textures[normTex].source!);
    }
    const mrTex = mat.pbrMetallicRoughness?.metallicRoughnessTexture?.index;
    if (mrTex !== undefined && textures[mrTex]?.source !== undefined) {
      technicalImageIndices.add(textures[mrTex].source!);
    }
  }

  const { albedo: albedoQ, technical: techQ } = getGlbJpegQuality(quality);
  const replacements = new Map<number, Uint8Array>();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return dedupedBuffer;

  for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
    const img = images[imgIdx];
    if (img.mimeType !== 'image/jpeg' || img.bufferView === undefined) continue;

    const bv = bufferViews[img.bufferView];
    if (!bv) continue;

    const bvOffset = bv.byteOffset ?? 0;
    const rawSlice = bin.subarray(bvOffset, bvOffset + bv.byteLength);
    const blobBytes = new Uint8Array(rawSlice.byteLength);
    blobBytes.set(rawSlice);
    const srcBlob = new Blob([blobBytes], { type: 'image/jpeg' });

    const bitmap = await createImageBitmap(srcBlob);
    try {
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      ctx.drawImage(bitmap, 0, 0);
    } finally {
      bitmap.close();
    }

    const targetQ = technicalImageIndices.has(imgIdx) ? techQ : albedoQ;
    const reencodedBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', targetQ);
    });

    if (reencodedBlob && reencodedBlob.size > 0 && reencodedBlob.size < rawSlice.byteLength) {
      const ab = await reencodedBlob.arrayBuffer();
      replacements.set(img.bufferView, new Uint8Array(ab));
    }
  }

  canvas.width = 1;
  canvas.height = 1;

  return replaceGlbBufferViews(dedupedBuffer, replacements, true);
}

function parseHexRgb(hex: string): [number, number, number] | null {
  const clean = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/**
 * Maps wear into 4 clean perceptual tiers (Factory Clean, Field Service, Battle-Worn, Distressed)
 * during GLB export so parts with subtly different wear (e.g. 0.14 vs 0.24 vs 0.34) share one
 * PBR surface map set instead of embedding redundant full-resolution copies.
 */
export function quantizeExportWear(wear: number): number {
  if (wear < 0.08) return 0.0;
  if (wear <= 0.4) return 0.22;
  if (wear <= 0.72) return 0.55;
  return 0.85;
}

export interface MonochromeExportTint {
  basePaint: PartPaint;
  tintHex: string;
}

/**
 * Returns true when a paint's albedo can be represented losslessly via a shared neutral
 * grayscale base texture multiplied by a glTF `baseColorFactor` tint, collapsing multiple
 * same-pattern steel/polymer/wood parts into a single shared embedded albedo image.
 *
 * Returns false for two-tone hues, camo/carbon/hex patterns, near-white paints that could
 * clip highlights, or heavily battle-worn steel (>0.45 wear) where bright silver scratches
 * need un-tinted RGB contrast.
 */
export function isMonochromeTintable(paint: PartPaint): boolean {
  if (paint.pattern !== 'brushed_steel' && paint.pattern !== 'solid' && paint.pattern !== 'wood') {
    return false;
  }
  if (paint.wear > 0.45) return false;

  const p = parseHexRgb(paint.primaryColor);
  const s = parseHexRgb(paint.secondaryColor);
  if (!p || !s) return false;

  const maxP = Math.max(p[0], p[1], p[2]);
  if (maxP < 20 || maxP > 228) return false;

  if (paint.pattern === 'solid') {
    return true;
  }

  const lumP = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
  const lumS = 0.299 * s[0] + 0.587 * s[1] + 0.114 * s[2];
  if (lumP < 12) return false;

  const ratio = lumS / lumP;
  if (paint.pattern === 'brushed_steel') {
    if (ratio < 0.42 || ratio > 0.8) return false;
  } else if (paint.pattern === 'wood') {
    if (ratio < 0.35 || ratio > 0.65) return false;
  }

  // Ensure secondaryColor is a monochrome darker shade of primaryColor (no two-tone hue shift)
  for (let c = 0; c < 3; c++) {
    if (p[c] >= 28) {
      const chRatio = s[c] / p[c];
      if (Math.abs(chRatio - ratio) > 0.15) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Builds the shared neutral-grayscale base paint and exact glTF material `color` tint
 * for monochrome-tintable paints during GLB export.
 */
export function buildMonochromeExportTint(paint: PartPaint): MonochromeExportTint | null {
  if (!isMonochromeTintable(paint)) return null;
  const p = parseHexRgb(paint.primaryColor)!;
  const exportWear = quantizeExportWear(paint.wear);

  if (paint.pattern === 'brushed_steel') {
    return {
      basePaint: {
        ...paint,
        primaryColor: '#ffffff',
        secondaryColor: '#999999',
        wear: exportWear,
      },
      tintHex: paint.primaryColor,
    };
  }

  if (paint.pattern === 'solid') {
    const scale = 255 / 240;
    return {
      basePaint: {
        ...paint,
        primaryColor: '#f0f0f0',
        secondaryColor: '#b0b0b0',
        wear: exportWear,
      },
      tintHex: rgbToHex(p[0] * scale, p[1] * scale, p[2] * scale),
    };
  }

  // wood
  const scale = 255 / 232;
  return {
    basePaint: {
      ...paint,
      primaryColor: '#e8e8e8',
      secondaryColor: '#6e6e6e',
      wear: exportWear,
    },
    tintHex: rgbToHex(p[0] * scale, p[1] * scale, p[2] * scale),
  };
}

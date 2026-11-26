import { getInitialWeaponConfig, SLOT_ORDER } from '../data/catalog';
import {
  GodotWeaponCategory,
  WeaponConfig,
  WeaponDimensions,
  WeaponPaints,
  WeaponParts,
} from '../types/weapon';
import { clamp, sanitizeWeaponConfig } from './weaponLogic';

export const FIRESTORE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

export const ALLOWED_WEAPON_CATEGORIES: readonly GodotWeaponCategory[] = [
  'pistol',
  'smg',
  'assault_rifle',
  'shotgun',
  'sniper',
  'lmg',
] as const;

export const MAX_BUILD_NAME_LEN = 80;
export const MAX_DISPLAY_NAME_LEN = 120;
export const MAX_EMAIL_LEN = 200;
export const MAX_PHOTO_URL_LEN = 500;

export const DIMENSION_KEYS: readonly (keyof WeaponDimensions)[] = [
  'receiverLength',
  'receiverHeight',
  'receiverWidth',
  'receiverRailHeight',
  'barrelLength',
  'barrelThickness',
  'barrelOffsetY',
  'handguardLength',
  'handguardBulk',
  'handguardHeight',
  'handguardOffset',
  'stockLength',
  'stockWidth',
  'stockDrop',
  'stockButtHeight',
  'stockCheekHeight',
  'magLength',
  'magCurve',
  'magWidth',
  'magAngle',
  'gripLength',
  'gripAngle',
  'gripThickness',
  'muzzleScale',
  'muzzleLengthScale',
  'muzzleDiameterScale',
  'opticOffset',
  'opticScale',
  'opticMountHeight',
  'opticLensScale',
  'underbarrelOffset',
  'underbarrelScale',
  'underbarrelWidth',
  'underbarrelDrop',
] as const;

export interface CloudUserAccountDoc {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string;
  exportCount: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface CloudSavedBuildDoc {
  id: string;
  ownerId: string;
  name: string;
  category: GodotWeaponCategory;
  lengthCm: number;
  parts: WeaponParts;
  dimensions: WeaponDimensions;
  paints: WeaponPaints;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface CloudSavedBuildView extends CloudSavedBuildDoc {
  updatedAtMs: number;
}

export function isValidFirestoreId(id: string): boolean {
  return typeof id === 'string' && FIRESTORE_ID_REGEX.test(id);
}

export function generateBuildId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
  const rand = Math.random().toString(36).slice(2, 8);
  const raw = `${slug || 'build'}_${Date.now().toString(36)}_${rand}`;
  return raw.slice(0, 128);
}

function normalizeDisplayName(displayName: string | null | undefined, email: string): string {
  const trimmed = (displayName ?? '').trim();
  if (trimmed.length >= 1) {
    return trimmed.slice(0, MAX_DISPLAY_NAME_LEN);
  }
  const emailPrefix = email.split('@')[0]?.trim() || 'ForgeArm Creator';
  return emailPrefix.slice(0, MAX_DISPLAY_NAME_LEN);
}

function normalizeEmail(email: string | null | undefined): string {
  const trimmed = (email ?? '').trim();
  if (trimmed.length >= 3) {
    return trimmed.slice(0, MAX_EMAIL_LEN);
  }
  throw new Error('Google account email is required to sync your ForgeArm profile.');
}

function normalizePhotoUrl(photoURL: string | null | undefined): string | undefined {
  if (!photoURL) return undefined;
  const trimmed = photoURL.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_PHOTO_URL_LEN);
}

export function sanitizeAccountCreatePayload(input: {
  uid: string;
  displayName?: string | null;
  email?: string | null;
  photoURL?: string | null;
}): Omit<CloudUserAccountDoc, 'createdAt' | 'updatedAt'> {
  if (!isValidFirestoreId(input.uid)) {
    throw new Error('Invalid Firebase UID.');
  }
  const email = normalizeEmail(input.email);
  const displayName = normalizeDisplayName(input.displayName, email);
  const photoURL = normalizePhotoUrl(input.photoURL);

  const payload: Omit<CloudUserAccountDoc, 'createdAt' | 'updatedAt'> = {
    uid: input.uid,
    displayName,
    email,
    exportCount: 0,
  };
  if (photoURL !== undefined) {
    payload.photoURL = photoURL;
  }
  return payload;
}

export function sanitizeAccountIdentityPatch(input: {
  displayName?: string | null;
  email?: string | null;
  photoURL?: string | null;
}): { displayName: string; email: string; photoURL?: string } {
  const email = normalizeEmail(input.email);
  const displayName = normalizeDisplayName(input.displayName, email);
  const photoURL = normalizePhotoUrl(input.photoURL);

  const patch: { displayName: string; email: string; photoURL?: string } = {
    displayName,
    email,
  };
  if (photoURL !== undefined) {
    patch.photoURL = photoURL;
  }
  return patch;
}

function sanitizeCategory(category: GodotWeaponCategory): GodotWeaponCategory {
  return ALLOWED_WEAPON_CATEGORIES.includes(category) ? category : 'assault_rifle';
}

function sanitizeBuildName(name: string): string {
  const trimmed = name.trim();
  return (trimmed || 'Untitled Build').slice(0, MAX_BUILD_NAME_LEN);
}

function pickExactDimensions(d: WeaponDimensions): WeaponDimensions {
  const out = {} as WeaponDimensions;
  for (const key of DIMENSION_KEYS) {
    out[key] = Number.isFinite(d[key]) ? Number(d[key].toFixed(5)) : 0;
  }
  return out;
}

function pickExactParts(p: WeaponParts): WeaponParts {
  const out = {} as Record<string, string>;
  for (const slot of SLOT_ORDER) {
    out[slot] = String(p[slot]);
  }
  return out as unknown as WeaponParts;
}

function pickExactPaints(paints: WeaponPaints): WeaponPaints {
  const out = {} as Record<string, unknown>;
  for (const slot of SLOT_ORDER) {
    const src = paints[slot];
    out[slot] = {
      primaryColor: src.primaryColor,
      secondaryColor: src.secondaryColor,
      pattern: src.pattern,
      metalness: Number(src.metalness.toFixed(3)),
      roughness: Number(src.roughness.toFixed(3)),
      patternScale: Number(src.patternScale.toFixed(3)),
      wear: Number(src.wear.toFixed(3)),
    };
  }
  return out as unknown as WeaponPaints;
}

export function sanitizeBuildCreatePayload(input: {
  buildId: string;
  ownerId: string;
  config: WeaponConfig;
  category: GodotWeaponCategory;
  lengthCm: number;
}): Omit<CloudSavedBuildDoc, 'createdAt' | 'updatedAt'> {
  if (!isValidFirestoreId(input.buildId) || !isValidFirestoreId(input.ownerId)) {
    throw new Error('Invalid build or owner ID.');
  }
  const cleanConfig = sanitizeWeaponConfig(input.config, getInitialWeaponConfig());
  return {
    id: input.buildId,
    ownerId: input.ownerId,
    name: sanitizeBuildName(cleanConfig.name),
    category: sanitizeCategory(input.category),
    lengthCm: Math.round(clamp(Number.isFinite(input.lengthCm) ? input.lengthCm : 88, 10, 250)),
    parts: pickExactParts(cleanConfig.parts),
    dimensions: pickExactDimensions(cleanConfig.dimensions),
    paints: pickExactPaints(cleanConfig.paints),
  };
}

export function sanitizeBuildUpdatePatch(input: {
  config: WeaponConfig;
  category: GodotWeaponCategory;
  lengthCm: number;
}): Pick<
  CloudSavedBuildDoc,
  'name' | 'category' | 'lengthCm' | 'parts' | 'dimensions' | 'paints'
> {
  const cleanConfig = sanitizeWeaponConfig(input.config, getInitialWeaponConfig());
  return {
    name: sanitizeBuildName(cleanConfig.name),
    category: sanitizeCategory(input.category),
    lengthCm: Math.round(clamp(Number.isFinite(input.lengthCm) ? input.lengthCm : 88, 10, 250)),
    parts: pickExactParts(cleanConfig.parts),
    dimensions: pickExactDimensions(cleanConfig.dimensions),
    paints: pickExactPaints(cleanConfig.paints),
  };
}

export function extractTimestampMs(ts: unknown): number {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'object' && ts !== null) {
    const maybe = ts as { toMillis?: () => number; seconds?: number };
    if (typeof maybe.toMillis === 'function') {
      return maybe.toMillis();
    }
    if (typeof maybe.seconds === 'number') {
      return maybe.seconds * 1000;
    }
  }
  return 0;
}

export function sortSavedBuildsDesc(builds: CloudSavedBuildView[]): CloudSavedBuildView[] {
  return [...builds].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

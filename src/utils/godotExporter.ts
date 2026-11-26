import {
  GlbExportQuality,
  GodotFireMode,
  GodotHandOrientationSpec,
  GodotSocketRole,
  GodotSocketTransform,
  GodotWeaponCategory,
  GodotWeaponMetadata,
  GodotWeaponStats,
  ResolvedMechanics,
  Vec3Tuple,
  WeaponConfig,
  WeaponJsonExport,
} from '../types/weapon';
import { resolveMixamoHandRig } from './handRig';
import { clamp, getGlbExportSpec } from './weaponLogic';

function roundN(v: number, digits = 3): number {
  const m = 10 ** digits;
  const r = Math.round(v * m) / m;
  return Object.is(r, -0) ? 0 : r;
}

export function slugifyWeaponName(weaponName: string): string {
  return (
    weaponName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'forgearm_weapon'
  );
}

export function toGodotNodeName(weaponName: string): string {
  const words = weaponName
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  if (!pascal) return 'ForgeArmWeapon';
  return /^[0-9]/.test(pascal) ? `Weapon${pascal}` : pascal;
}

export function buildGodotBundleFilename(weaponName: string, quality: GlbExportQuality): string {
  const slug = slugifyWeaponName(weaponName);
  const spec = getGlbExportSpec(quality);
  return `${slug}_godot_pack_${spec.filenameTag}.zip`;
}

/**
 * Classifies the configured modular weapon into one of the 6 standardized Godot 4 FPS categories:
 * "pistol", "smg", "assault_rifle", "shotgun", "sniper", or "lmg".
 */
export function computeGodotWeaponCategory(
  config: WeaponConfig,
  mechanics: ResolvedMechanics
): GodotWeaponCategory {
  const { parts, dimensions: d } = config;

  if (parts.receiver === 'bolt_chassis') {
    return 'sniper';
  }
  if (parts.barrel === 'heavy_sniper' && (parts.optic === 'sniper_scope' || parts.magazine === 'box_sniper')) {
    return 'sniper';
  }
  if (parts.magazine === 'drum_mag' || parts.barrel === 'finned_lmg') {
    return 'lmg';
  }
  if (
    mechanics.effectiveUnderbarrel === 'masterkey_shotgun' &&
    d.barrelLength <= 0.34 &&
    parts.receiver !== 'smg_mp5'
  ) {
    return 'shotgun';
  }
  if (
    parts.stock === 'none' &&
    parts.barrel === 'compact_smg' &&
    d.barrelLength <= 0.2 &&
    mechanics.exactLengthMeters <= 0.44
  ) {
    return 'pistol';
  }
  if (parts.receiver === 'smg_mp5' || (parts.barrel === 'compact_smg' && parts.magazine === 'smg_stick')) {
    return 'smg';
  }
  return 'assault_rifle';
}

/**
 * Computes realistic, balanced FPS gameplay statistics for Godot 4.7.2 directly from active parts
 * and physical weapon dimensions.
 */
export function computeGodotWeaponStats(
  config: WeaponConfig,
  mechanics: ResolvedMechanics
): GodotWeaponStats {
  const { parts, dimensions: d } = config;
  const effectiveUb = mechanics.effectiveUnderbarrel;
  const category = computeGodotWeaponCategory(config, mechanics);

  const suppressed =
    parts.muzzle === 'suppressor' ||
    parts.muzzle === 'osp_rectangular' ||
    parts.barrel === 'integral_suppressed';

  // 1. Base platform profile from receiver
  let fireMode: GodotFireMode = 'auto';
  let damage = 36;
  let rpm = 650;
  let baseReload = 2.25;
  let baseAdsTime = 0.24;
  let recoilPitch = 1.45;
  let recoilYaw = 0.52;
  let recoilKickZ = 0.032;
  let spreadHip = 2.4;
  let spreadAds = 0.32;
  let baseRangeM = 160;
  let pelletCount = 1;
  let baseSoundBank = 'rifle_556_ar';

  switch (parts.receiver) {
    case 'ak_stamped':
      fireMode = 'auto';
      damage = 40;
      rpm = 600;
      baseReload = 2.4;
      baseAdsTime = 0.25;
      recoilPitch = 1.75;
      recoilYaw = 0.62;
      recoilKickZ = 0.038;
      spreadHip = 2.6;
      spreadAds = 0.36;
      baseRangeM = 175;
      baseSoundBank = 'rifle_762_ak';
      break;
    case 'ak12_modern':
      fireMode = 'auto';
      damage = 37;
      rpm = 680;
      baseReload = 2.2;
      baseAdsTime = 0.23;
      recoilPitch = 1.48;
      recoilYaw = 0.5;
      recoilKickZ = 0.034;
      spreadHip = 2.35;
      spreadAds = 0.3;
      baseRangeM = 180;
      baseSoundBank = 'rifle_545_ak12';
      break;
    case 'ar_flattop':
      fireMode = 'auto';
      damage = 34;
      rpm = 750;
      baseReload = 2.05;
      baseAdsTime = 0.22;
      recoilPitch = 1.28;
      recoilYaw = 0.44;
      recoilKickZ = 0.029;
      spreadHip = 2.2;
      spreadAds = 0.28;
      baseRangeM = 185;
      baseSoundBank = 'rifle_556_ar';
      break;
    case 'scar_monolithic':
      fireMode = 'auto';
      damage = 45;
      rpm = 580;
      baseReload = 2.35;
      baseAdsTime = 0.27;
      recoilPitch = 1.85;
      recoilYaw = 0.56;
      recoilKickZ = 0.042;
      spreadHip = 2.7;
      spreadAds = 0.26;
      baseRangeM = 230;
      baseSoundBank = 'battle_rifle_762_scar';
      break;
    case 'smg_mp5':
      fireMode = 'auto';
      damage = 26;
      rpm = 850;
      baseReload = 1.85;
      baseAdsTime = 0.17;
      recoilPitch = 0.92;
      recoilYaw = 0.38;
      recoilKickZ = 0.02;
      spreadHip = 1.65;
      spreadAds = 0.42;
      baseRangeM = 75;
      baseSoundBank = 'smg_9mm_mp5';
      break;
    case 'bolt_chassis':
      fireMode = 'bolt';
      damage = 92;
      rpm = 46;
      baseReload = 3.05;
      baseAdsTime = 0.36;
      recoilPitch = 3.4;
      recoilYaw = 0.48;
      recoilKickZ = 0.068;
      spreadHip = 4.6;
      spreadAds = 0.08;
      baseRangeM = 450;
      baseSoundBank = 'sniper_308_bolt';
      break;
    case 'bullpup':
      fireMode = 'auto';
      damage = 35;
      rpm = 780;
      baseReload = 2.55;
      baseAdsTime = 0.21;
      recoilPitch = 1.32;
      recoilYaw = 0.46;
      recoilKickZ = 0.03;
      spreadHip = 1.85;
      spreadAds = 0.27;
      baseRangeM = 190;
      baseSoundBank = 'rifle_556_bullpup';
      break;
    case 'scifi_rail':
      fireMode = 'burst';
      damage = 48;
      rpm = 540;
      baseReload = 2.4;
      baseAdsTime = 0.25;
      recoilPitch = 1.15;
      recoilYaw = 0.34;
      recoilKickZ = 0.026;
      spreadHip = 2.1;
      spreadAds = 0.16;
      baseRangeM = 280;
      baseSoundBank = 'scifi_railgun';
      break;
  }

  if (category === 'pistol') {
    fireMode = 'semi';
    baseRangeM = Math.min(baseRangeM, 55);
  } else if (category === 'shotgun') {
    fireMode = 'semi';
    pelletCount = 8;
    damage = 18;
    rpm = 160;
    baseRangeM = 40;
    spreadHip = 4.8;
    spreadAds = 2.6;
    recoilKickZ = 0.056;
  }

  // 2. Barrel modifiers
  switch (parts.barrel) {
    case 'heavy_sniper':
      damage += 8;
      rpm = Math.round(rpm * 0.92);
      baseAdsTime += 0.05;
      recoilPitch *= 0.88;
      recoilKickZ *= 0.92;
      spreadAds *= 0.65;
      spreadHip += 0.4;
      baseRangeM += 90;
      break;
    case 'carbon_wrapped':
      damage += 5;
      spreadAds *= 0.72;
      recoilPitch *= 0.94;
      baseAdsTime += 0.01;
      baseRangeM += 50;
      break;
    case 'compact_smg':
      damage -= 3;
      rpm = Math.round(rpm * 1.08);
      baseAdsTime -= 0.03;
      recoilPitch *= 1.1;
      recoilKickZ *= 1.06;
      spreadHip *= 0.85;
      spreadAds *= 1.18;
      baseRangeM -= 35;
      break;
    case 'integral_suppressed':
      damage -= 2;
      recoilPitch *= 0.88;
      recoilYaw *= 0.9;
      recoilKickZ *= 0.86;
      spreadAds *= 0.9;
      baseRangeM -= 15;
      break;
    case 'finned_lmg':
      damage += 3;
      rpm = Math.round(rpm * 1.05);
      baseAdsTime += 0.06;
      recoilPitch *= 0.9;
      recoilKickZ *= 0.9;
      spreadHip += 0.5;
      baseRangeM += 35;
      break;
    case 'twin_scifi':
      damage += 6;
      fireMode = 'burst';
      recoilPitch *= 1.08;
      spreadAds *= 0.82;
      baseRangeM += 40;
      break;
    case 'ak_gastube':
      break;
  }

  // Barrel length scaling (relative to standard 39cm)
  const barrelDelta = d.barrelLength - 0.39;
  damage += Math.round(barrelDelta * 22);
  baseAdsTime += barrelDelta * 0.16;
  recoilPitch *= 1 - barrelDelta * 0.45;
  recoilKickZ *= 1 - barrelDelta * 0.35;
  spreadAds *= 1 - barrelDelta * 0.65;
  spreadHip += barrelDelta * 1.4;
  baseRangeM += Math.round(barrelDelta * 220);

  // 3. Magazine size & reload modifiers
  let magSize = 30;
  let reloadDelta = 0;
  switch (parts.magazine) {
    case 'none':
      magSize = 0;
      reloadDelta = -0.4;
      baseAdsTime -= 0.03;
      break;
    case 'ak_curved':
      magSize = 30;
      break;
    case 'ak_bakelite':
      magSize = 30;
      reloadDelta = -0.08;
      break;
    case 'ar_stanag':
      magSize = 30;
      reloadDelta = -0.15;
      break;
    case 'smg_stick':
      magSize = 32;
      reloadDelta = -0.25;
      baseAdsTime -= 0.02;
      break;
    case 'drum_mag':
      magSize = 75;
      reloadDelta = 1.15;
      baseAdsTime += 0.08;
      spreadHip += 0.35;
      break;
    case 'coupled_dual':
      magSize = 60;
      reloadDelta = -0.45;
      baseAdsTime += 0.03;
      break;
    case 'box_sniper':
      magSize = 10;
      reloadDelta = 0.25;
      if (parts.receiver === 'bolt_chassis') magSize = 5;
      break;
    case 'scifi_cell':
      magSize = 45;
      reloadDelta = 0.1;
      break;
  }
  if (magSize > 0 && parts.magazine !== 'drum_mag' && parts.magazine !== 'box_sniper') {
    const magLenRatio = clamp(d.magLength / 0.205, 0.72, 1.35);
    magSize = Math.max(5, Math.round((magSize * magLenRatio) / 5) * 5);
  }

  // Reserve ammo scaled realistically by category and mag capacity
  const reserveMagMultiplier =
    category === 'sniper' ? 5 : category === 'lmg' ? 3 : category === 'smg' ? 5 : 4;
  const reserveAmmo = magSize > 0 ? magSize * reserveMagMultiplier : 0;

  // 4. Muzzle device modifiers
  switch (parts.muzzle) {
    case 'suppressor':
      recoilPitch *= 0.86;
      recoilYaw *= 0.88;
      recoilKickZ *= 0.86;
      baseAdsTime += 0.025;
      spreadAds *= 0.92;
      baseRangeM -= 10;
      break;
    case 'osp_rectangular':
      recoilPitch *= 0.88;
      recoilYaw *= 0.86;
      recoilKickZ *= 0.88;
      baseAdsTime += 0.02;
      spreadAds *= 0.94;
      baseRangeM -= 8;
      break;
    case 'tank_brake':
      recoilPitch *= 0.72;
      recoilYaw *= 0.82;
      recoilKickZ *= 0.74;
      spreadHip += 0.15;
      break;
    case 'slant_brake':
      recoilPitch *= 0.85;
      recoilYaw *= 0.84;
      recoilKickZ *= 0.9;
      break;
    case 'flash_hider':
      recoilPitch *= 0.94;
      spreadAds *= 0.95;
      break;
    case 'linear_comp':
      recoilPitch *= 0.88;
      recoilYaw *= 0.8;
      recoilKickZ *= 0.88;
      break;
    case 'breacher_spike':
      recoilPitch *= 0.92;
      spreadHip *= 0.95;
      break;
    case 'none':
      break;
  }

  // 5. Stock & grip modifiers
  switch (parts.stock) {
    case 'none':
      recoilPitch *= 1.38;
      recoilYaw *= 1.35;
      recoilKickZ *= 1.36;
      baseAdsTime -= 0.055;
      spreadHip *= 0.84;
      spreadAds *= 1.32;
      break;
    case 'pdw_wire':
    case 'skeleton_folder':
      recoilPitch *= 1.08;
      recoilKickZ *= 1.08;
      baseAdsTime -= 0.02;
      spreadHip *= 0.92;
      break;
    case 'precision_sniper':
    case 'thumbhole_sport':
      recoilPitch *= 0.84;
      recoilYaw *= 0.82;
      recoilKickZ *= 0.84;
      baseAdsTime += 0.035;
      spreadAds *= 0.82;
      break;
    case 'tactical_carbine':
    case 'scar_boot':
      recoilPitch *= 0.92;
      recoilYaw *= 0.9;
      recoilKickZ *= 0.92;
      break;
    case 'ak_wood':
    case 'bullpup_buttpad':
      recoilPitch *= 0.94;
      recoilKickZ *= 0.94;
      break;
  }

  // Grip angle ergonomics (steeper CQB angle speeds ADS; wider grip damps yaw)
  const gripAngleDelta = d.gripAngle - 21;
  baseAdsTime += gripAngleDelta * 0.0012;
  recoilYaw *= 1 - (d.gripThickness - 1) * 0.12;

  // 6. Underbarrel modifiers
  switch (effectiveUb) {
    case 'vertical_grip':
      recoilPitch *= 0.84;
      recoilYaw *= 0.88;
      recoilKickZ *= 0.88;
      spreadHip *= 0.88;
      break;
    case 'angled_grip':
      recoilYaw *= 0.82;
      baseAdsTime -= 0.02;
      break;
    case 'handstop_kit':
      baseAdsTime -= 0.025;
      spreadHip *= 0.9;
      break;
    case 'tactical_laser':
      spreadHip *= 0.68;
      baseAdsTime -= 0.01;
      break;
    case 'tactical_light':
      spreadHip *= 0.92;
      break;
    case 'bipod':
      recoilPitch *= 0.78;
      recoilYaw *= 0.75;
      recoilKickZ *= 0.8;
      spreadAds *= 0.72;
      baseAdsTime += 0.04;
      break;
    case 'grenade_launcher':
    case 'masterkey_shotgun':
      baseAdsTime += 0.055;
      recoilPitch *= 0.92;
      spreadHip += 0.35;
      break;
    case 'none':
      break;
  }

  // 7. Optic ADS FOV & handling speed
  let adsFov = 65;
  switch (parts.optic) {
    case 'none':
    case 'iron_sights':
      adsFov = 65;
      break;
    case 'micro_reflex':
      adsFov = 62;
      baseAdsTime -= 0.015;
      break;
    case 'red_dot':
      adsFov = 58;
      break;
    case 'thermal_holo':
      adsFov = 44;
      baseAdsTime += 0.03;
      break;
    case 'acog':
      adsFov = 34;
      baseAdsTime += 0.035;
      spreadAds *= 0.9;
      baseRangeM += 40;
      break;
    case 'lpvo_tactical':
      adsFov = 28;
      baseAdsTime += 0.04;
      spreadAds *= 0.86;
      baseRangeM += 60;
      break;
    case 'sniper_scope':
      adsFov = 18;
      baseAdsTime += 0.065;
      spreadAds *= 0.8;
      baseRangeM += 120;
      break;
  }

  // 8. Final sound bank name with suppression suffix
  const soundBank = suppressed ? `${baseSoundBank}_suppressed` : baseSoundBank;

  return {
    damage: Math.round(clamp(damage, 12, 130)),
    fire_rate_rpm: Math.round(clamp(rpm, 32, 1200)),
    fire_mode: fireMode,
    mag_size: magSize,
    reserve_ammo: reserveAmmo,
    reload_time_s: roundN(clamp(baseReload + reloadDelta, 1.1, 4.8), 2),
    recoil_pitch: roundN(clamp(recoilPitch, 0.35, 5.5), 2),
    recoil_yaw: roundN(clamp(recoilYaw, 0.12, 2.2), 2),
    recoil_kick_z: roundN(clamp(recoilKickZ, 0.012, 0.095), 4),
    hip_spread_deg: roundN(clamp(spreadHip, 0.7, 7.5), 2),
    ads_spread_deg: roundN(clamp(spreadAds, 0.03, 3.2), 2),
    ads_fov: adsFov,
    ads_time_s: roundN(clamp(baseAdsTime, 0.12, 0.55), 2),
    pellet_count: pelletCount,
    range_m: Math.round(clamp(baseRangeM, 25, 800)),
    suppressed,
    sound_bank: soundBank,
  };
}

function relativeToOrigin(pos: Vec3Tuple, origin: Vec3Tuple): [number, number, number] {
  return [
    roundN(pos.x - origin.x, 4),
    roundN(pos.y - origin.y, 4),
    roundN(pos.z - origin.z, 4),
  ];
}

function normalizeVec(v: Vec3Tuple): Vec3Tuple {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function crossVec(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function makeGodotSocketTransform(
  position: [number, number, number],
  forwardRaw: Vec3Tuple,
  upRaw: Vec3Tuple,
  socketRole: GodotSocketRole,
  contactNormalRaw?: Vec3Tuple
): GodotSocketTransform {
  const fwd = normalizeVec(forwardRaw);
  const right = normalizeVec(crossVec(fwd, upRaw));
  const up = normalizeVec(crossVec(right, fwd));
  const back = { x: -fwd.x, y: -fwd.y, z: -fwd.z };

  // Right-handed basis [right (+X), up (+Y), back (+Z = -fwd)] -> Three.js / glTF XYZ Euler radians
  const m13 = back.x;
  const ry = Math.asin(clamp(m13, -1, 1));
  let rx = 0;
  let rz = 0;
  if (Math.abs(m13) < 0.9999999) {
    rx = Math.atan2(-back.y, back.z);
    rz = Math.atan2(-up.x, right.x);
  } else {
    rx = Math.atan2(up.z, up.y);
    rz = 0;
  }

  const out: GodotSocketTransform = {
    position,
    rotation: [roundN(rx, 4), roundN(ry, 4), roundN(rz, 4)],
    grip_forward: [roundN(fwd.x, 4), roundN(fwd.y, 4), roundN(fwd.z, 4)],
    grip_up: [roundN(up.x, 4), roundN(up.y, 4), roundN(up.z, 4)],
    socket_role: socketRole,
  };
  if (contactNormalRaw) {
    const n = normalizeVec(contactNormalRaw);
    out.contact_normal = [roundN(n.x, 4), roundN(n.y, 4), roundN(n.z, 4)];
  }
  return out;
}

export const GODOT_HAND_ORIENTATION_SPEC: GodotHandOrientationSpec = {
  socket_semantics: 'grip_contact_point',
  is_joint: false,
  applies_palm_offset: 'runtime_outward_along_contact_normal',
  description:
    'Grip sockets (Socket_Grip_Right, Socket_Grip_Left) mark exterior mesh surface contact points where the palm presses against the weapon, NOT wrist joints. The runtime applies its own palm-to-wrist offset outward along contact_normal; placing a socket at a wrist joint would double-count that offset. Every socket emits orthonormal grip_forward (local -Z) and grip_up (local +Y) so orientation solves unambiguously via Basis.looking_at(grip_forward, grip_up).',
  coordinate_system: {
    forward: '-Z',
    up: '+Y',
    right: '+X',
    units: 'meters',
    origin: 'pistol_grip_center_pivot',
  },
  socket_basis_axes: {
    grip_forward: 'socket_local_-Z_finger_extension_and_wrap_forward',
    grip_up: 'socket_local_+Y_thumb_and_radial_hand_up',
    right_hand_contact_normal: 'socket_local_+X_outward_from_grip_to_palm',
    left_hand_contact_normal: 'socket_local_-X_outward_from_grip_to_palm',
  },
  finger_axis: '-Z',
  up_axis: '+Y',
  solve_note:
    'Align hand -Z (finger wrap/extension direction) to grip_forward and hand +Y (thumb/radial up) to grip_up; offset wrist outward from the surface contact point along contact_normal (+X side for right hand, -X/lower-left side for left hand).',
};

/**
 * Computes exact local [x, y, z] coordinates (meters), Euler angles, and two-vector orientation basis
 * (grip_forward + grip_up) for every Godot 4.7.2 Socket_* node relative to WeaponRoot origin (gripPivotPos = (0, 0, 0)).
 */
export function buildGodotSocketsMap(
  config: WeaponConfig,
  mechanics: ResolvedMechanics
): Record<string, GodotSocketTransform> {
  const origin = mechanics.gripPivotPos;
  const fwdWeapon: Vec3Tuple = { x: 0, y: 0, z: -1 };
  const upWeapon: Vec3Tuple = { x: 0, y: 1, z: 0 };

  const sockets: Record<string, GodotSocketTransform> = {
    Socket_Muzzle: makeGodotSocketTransform(
      relativeToOrigin(mechanics.socketMuzzlePos, origin),
      fwdWeapon,
      upWeapon,
      'muzzle'
    ),
    Socket_Grip_Right: makeGodotSocketTransform(
      relativeToOrigin(mechanics.socketHandRPos, origin),
      mechanics.socketHandRForward,
      mechanics.socketHandRUp,
      'grip_contact_point',
      mechanics.socketHandRNormal
    ),
    Socket_Grip_Left: makeGodotSocketTransform(
      relativeToOrigin(mechanics.socketHandLPos, origin),
      mechanics.socketHandLForward,
      mechanics.socketHandLUp,
      'grip_contact_point',
      mechanics.socketHandLNormal
    ),
    Socket_ADS: makeGodotSocketTransform(
      relativeToOrigin(mechanics.socketAdsPos, origin),
      fwdWeapon,
      upWeapon,
      'camera_ads'
    ),
    Socket_Eject: makeGodotSocketTransform(
      relativeToOrigin(mechanics.socketEjectPos, origin),
      fwdWeapon,
      upWeapon,
      'eject_port',
      { x: 1, y: 0, z: 0 }
    ),
    Socket_Mag: makeGodotSocketTransform(
      relativeToOrigin(mechanics.magwellPos, origin),
      fwdWeapon,
      upWeapon,
      'magazine_well'
    ),
    Socket_Optic: makeGodotSocketTransform(
      relativeToOrigin(mechanics.opticMountPos, origin),
      fwdWeapon,
      upWeapon,
      'rail_mount'
    ),
  };

  if (config.parts.handguard !== 'none') {
    sockets.Socket_Underbarrel = makeGodotSocketTransform(
      relativeToOrigin(mechanics.underbarrelMountPos, origin),
      fwdWeapon,
      upWeapon,
      'rail_mount'
    );
  }

  return sockets;
}

/**
 * Returns the exact list of exported movable Part_* node names present in the .glb.
 */
export function getExportedMovableParts(config: WeaponConfig): string[] {
  const partsList = ['Part_Bolt', 'Part_Trigger', 'Part_Selector'];
  if (config.parts.magazine !== 'none') {
    partsList.splice(1, 0, 'Part_Magazine');
  }
  if (config.parts.stock !== 'none') {
    partsList.push('Part_Stock');
  }
  return partsList;
}

/**
 * Estimates [width_x, height_y, length_z] in meters from mechanical constraints when a live 3D Box3
 * is not available (e.g., headless unit tests or JSON-only export before mesh bounds query).
 */
export function estimateWeaponDimensionsM(
  config: WeaponConfig,
  mechanics: ResolvedMechanics
): [number, number, number] {
  const d = config.dimensions;
  const widthX = Math.max(
    d.receiverWidth * 1.45,
    config.parts.magazine === 'drum_mag' ? 0.145 * d.magWidth : d.handguardBulk * 2.1
  );
  const topY = mechanics.socketAdsPos.y + 0.025;
  const magDrop = config.parts.magazine === 'none' ? 0 : d.magLength;
  const gripDrop = d.gripLength * 0.9;
  const bottomY = Math.min(mechanics.magwellPos.y - magDrop, mechanics.receiverBottomY - gripDrop);
  const heightY = Math.max(0.14, topY - bottomY);
  const lengthZ = mechanics.exactLengthMeters;
  return [roundN(widthX, 4), roundN(heightY, 4), roundN(lengthZ, 4)];
}

/**
 * Builds the clean, JSON-serializable Godot 4.7.2 metadata payload embedded directly inside the .glb
 * (WeaponRoot.userData + primary mesh userData -> glTF extras) and exported alongside as <weapon_id>.json.
 */
export function buildGodotWeaponMetadata(
  config: WeaponConfig,
  mechanics: ResolvedMechanics,
  exactDimensionsM?: [number, number, number]
): GodotWeaponMetadata {
  const dims: [number, number, number] = exactDimensionsM
    ? [roundN(exactDimensionsM[0], 4), roundN(exactDimensionsM[1], 4), roundN(exactDimensionsM[2], 4)]
    : estimateWeaponDimensionsM(config, mechanics);

  return {
    weapon_id: slugifyWeaponName(config.name),
    name: config.name,
    category: computeGodotWeaponCategory(config, mechanics),
    forward_axis: '-Z',
    units: 'meters',
    hand_orientation: GODOT_HAND_ORIENTATION_SPEC,
    hand_rig: resolveMixamoHandRig(config, mechanics),
    stats: computeGodotWeaponStats(config, mechanics),
    sockets: buildGodotSocketsMap(config, mechanics),
    movable_parts: getExportedMovableParts(config),
    dimensions_m: dims,
  };
}

/**
 * Builds the unified JSON export payload containing the exact Godot 4.7.2 metadata/stats/sockets
 * alongside ForgeArm's full build config (100% backwards-compatible with Load JSON).
 */
export function buildWeaponJsonExport(
  config: WeaponConfig,
  mechanics: ResolvedMechanics,
  exactDimensionsM?: [number, number, number]
): WeaponJsonExport {
  return {
    ...buildGodotWeaponMetadata(config, mechanics, exactDimensionsM),
    parts: config.parts,
    dimensions: config.dimensions,
    paints: config.paints,
  };
}

function fmtVec3(v: [number, number, number]): string {
  return `Vector3(${roundN(v[0], 4)}, ${roundN(v[1], 4)}, ${roundN(v[2], 4)})`;
}

/**
 * Generates a ready-to-drop Godot 4.7.2 rigged weapon scene (.tscn format=3) instancing the exported
 * .glb with editable child parts and pre-wired AnimationPlayer tracks (RESET, fire, reload, fold_stock).
 */
export function generateGodotSceneTscn(
  config: WeaponConfig,
  mechanics: ResolvedMechanics,
  glbFilename: string,
  scriptFilename: string,
  metadata: GodotWeaponMetadata
): string {
  const rootNodeName = toGodotNodeName(config.name);
  const origin = mechanics.gripPivotPos;
  const boltRest = relativeToOrigin(mechanics.boltRestPos, origin);
  const boltBack: [number, number, number] = [boltRest[0], boltRest[1], roundN(boltRest[2] + 0.055, 4)];
  const magRest = relativeToOrigin(mechanics.magwellPos, origin);
  const magDropped: [number, number, number] = [
    magRest[0],
    roundN(magRest[1] - 0.16, 4),
    roundN(magRest[2] - 0.025, 4),
  ];

  const stats = metadata.stats;
  const fireLen = roundN(clamp(60 / Math.max(60, stats.fire_rate_rpm), 0.09, 0.36), 3);
  const firePeak = roundN(fireLen * 0.35, 3);
  const reloadLen = roundN(clamp(stats.reload_time_s, 1.2, 4.5), 3);
  const relT1 = roundN(reloadLen * 0.26, 3);
  const relT2 = roundN(reloadLen * 0.56, 3);
  const relT3 = roundN(reloadLen * 0.72, 3);
  const relT4 = roundN(reloadLen * 0.86, 3);

  return `[gd_scene load_steps=8 format=3]

[ext_resource type="PackedScene" path="${glbFilename}" id="1_model"]
[ext_resource type="Script" path="${scriptFilename}" id="2_script"]

[sub_resource type="Animation" id="Animation_reset"]
resource_name = "RESET"
length = 0.01
tracks/0/type = "value"
tracks/0/imported = false
tracks/0/enabled = true
tracks/0/path = NodePath("Model/Part_Bolt:position")
tracks/0/interp = 1
tracks/0/loop_wrap = true
tracks/0/keys = {
"times": PackedFloat32Array(0),
"transitions": PackedFloat32Array(1),
"update": 0,
"values": [${fmtVec3(boltRest)}]
}
tracks/1/type = "value"
tracks/1/imported = false
tracks/1/enabled = true
tracks/1/path = NodePath("Model/Part_Trigger:rotation")
tracks/1/interp = 1
tracks/1/loop_wrap = true
tracks/1/keys = {
"times": PackedFloat32Array(0),
"transitions": PackedFloat32Array(1),
"update": 0,
"values": [Vector3(0, 0, 0)]
}
tracks/2/type = "value"
tracks/2/imported = false
tracks/2/enabled = true
tracks/2/path = NodePath("Model/Part_Magazine:position")
tracks/2/interp = 1
tracks/2/loop_wrap = true
tracks/2/keys = {
"times": PackedFloat32Array(0),
"transitions": PackedFloat32Array(1),
"update": 0,
"values": [${fmtVec3(magRest)}]
}
tracks/3/type = "value"
tracks/3/imported = false
tracks/3/enabled = true
tracks/3/path = NodePath("Model/Part_Magazine:rotation")
tracks/3/interp = 1
tracks/3/loop_wrap = true
tracks/3/keys = {
"times": PackedFloat32Array(0),
"transitions": PackedFloat32Array(1),
"update": 0,
"values": [Vector3(0, 0, 0)]
}
tracks/4/type = "value"
tracks/4/imported = false
tracks/4/enabled = true
tracks/4/path = NodePath("Model/Part_Stock:rotation")
tracks/4/interp = 1
tracks/4/loop_wrap = true
tracks/4/keys = {
"times": PackedFloat32Array(0),
"transitions": PackedFloat32Array(1),
"update": 0,
"values": [Vector3(0, 0, 0)]
}

[sub_resource type="Animation" id="Animation_fire"]
resource_name = "fire"
length = ${fireLen}
tracks/0/type = "value"
tracks/0/imported = false
tracks/0/enabled = true
tracks/0/path = NodePath("Model/Part_Bolt:position")
tracks/0/interp = 1
tracks/0/loop_wrap = true
tracks/0/keys = {
"times": PackedFloat32Array(0, ${firePeak}, ${fireLen}),
"transitions": PackedFloat32Array(1, 1, 1),
"update": 0,
"values": [${fmtVec3(boltRest)}, ${fmtVec3(boltBack)}, ${fmtVec3(boltRest)}]
}
tracks/1/type = "value"
tracks/1/imported = false
tracks/1/enabled = true
tracks/1/path = NodePath("Model/Part_Trigger:rotation")
tracks/1/interp = 1
tracks/1/loop_wrap = true
tracks/1/keys = {
"times": PackedFloat32Array(0, ${firePeak}, ${fireLen}),
"transitions": PackedFloat32Array(1, 1, 1),
"update": 0,
"values": [Vector3(0, 0, 0), Vector3(-0.42, 0, 0), Vector3(0, 0, 0)]
}

[sub_resource type="Animation" id="Animation_reload"]
resource_name = "reload"
length = ${reloadLen}
tracks/0/type = "value"
tracks/0/imported = false
tracks/0/enabled = true
tracks/0/path = NodePath("Model/Part_Magazine:position")
tracks/0/interp = 1
tracks/0/loop_wrap = true
tracks/0/keys = {
"times": PackedFloat32Array(0, ${relT1}, ${relT2}, ${relT3}),
"transitions": PackedFloat32Array(1, 1, 1, 1),
"update": 0,
"values": [${fmtVec3(magRest)}, ${fmtVec3(magDropped)}, ${fmtVec3(magDropped)}, ${fmtVec3(magRest)}]
}
tracks/1/type = "value"
tracks/1/imported = false
tracks/1/enabled = true
tracks/1/path = NodePath("Model/Part_Magazine:rotation")
tracks/1/interp = 1
tracks/1/loop_wrap = true
tracks/1/keys = {
"times": PackedFloat32Array(0, ${relT1}, ${relT2}, ${relT3}),
"transitions": PackedFloat32Array(1, 1, 1, 1),
"update": 0,
"values": [Vector3(0, 0, 0), Vector3(-0.42, 0, 0), Vector3(-0.42, 0, 0), Vector3(0, 0, 0)]
}
tracks/2/type = "value"
tracks/2/imported = false
tracks/2/enabled = true
tracks/2/path = NodePath("Model/Part_Bolt:position")
tracks/2/interp = 1
tracks/2/loop_wrap = true
tracks/2/keys = {
"times": PackedFloat32Array(0, ${relT3}, ${relT4}, ${reloadLen}),
"transitions": PackedFloat32Array(1, 1, 1, 1),
"update": 0,
"values": [${fmtVec3(boltRest)}, ${fmtVec3(boltRest)}, ${fmtVec3(boltBack)}, ${fmtVec3(boltRest)}]
}

[sub_resource type="Animation" id="Animation_fold_stock"]
resource_name = "fold_stock"
length = 0.35
tracks/0/type = "value"
tracks/0/imported = false
tracks/0/enabled = true
tracks/0/path = NodePath("Model/Part_Stock:rotation")
tracks/0/interp = 1
tracks/0/loop_wrap = true
tracks/0/keys = {
"times": PackedFloat32Array(0, 0.35),
"transitions": PackedFloat32Array(1, 1),
"update": 0,
"values": [Vector3(0, 0, 0), Vector3(0, -2.8798, 0)]
}

[sub_resource type="AnimationLibrary" id="AnimationLibrary_weapon"]
_data = {
"RESET": SubResource("Animation_reset"),
"fire": SubResource("Animation_fire"),
"fold_stock": SubResource("Animation_fold_stock"),
"reload": SubResource("Animation_reload")
}

[node name="${rootNodeName}" type="Node3D"]
script = ExtResource("2_script")

[node name="Model" parent="." instance=ExtResource("1_model")]

[node name="AnimationPlayer" type="AnimationPlayer" parent="."]
libraries = {
"": SubResource("AnimationLibrary_weapon")
}

[editable path="Model"]
`;
}

/**
 * Generates a typed Godot 4.7.2 GDScript weapon controller pre-populated with computed FPS stats
 * and bound to all standardized Socket_* and Part_* nodes inside the exported .glb.
 */
export function generateGodotScriptGd(metadata: GodotWeaponMetadata): string {
  const safeTitle = metadata.name.replace(/"/g, '\\"');
  const s = metadata.stats;
  return `extends Node3D

## Auto-generated by ForgeArm 3D for Godot 4.7.2
## Scale: 1 unit = 1 meter | Forward: -Z | Up: +Y | Origin: Pistol Grip Center Pivot (0, 0, 0)
## Grip Sockets (Socket_Grip_Right, Socket_Grip_Left): Exterior surface CONTACT POINTS (NOT wrist joints).
##   - Runtime applies its own palm offset outward along contact_normal; do not treat sockets as wrist joints.
##   - Finger extension/wrap direction runs along socket -Z (grip_forward); thumb/radial up runs along +Y (grip_up).

@export_group("Weapon Identity")
@export var weapon_id: String = "${metadata.weapon_id}"
@export var weapon_name: String = "${safeTitle}"
@export_enum("pistol", "smg", "assault_rifle", "shotgun", "sniper", "lmg") var category: String = "${metadata.category}"
@export_enum("auto", "burst", "bolt", "semi") var fire_mode: String = "${s.fire_mode}"
@export var sound_bank: String = "${s.sound_bank}"
@export var suppressed: bool = ${s.suppressed ? 'true' : 'false'}
@export var dimensions_m: Vector3 = Vector3(${metadata.dimensions_m[0]}, ${metadata.dimensions_m[1]}, ${metadata.dimensions_m[2]})

@export_group("Ballistics & Handling")
@export var damage: float = ${s.damage}.0
@export var fire_rate_rpm: int = ${s.fire_rate_rpm}
@export var mag_size: int = ${s.mag_size}
@export var reserve_ammo: int = ${s.reserve_ammo}
@export var reload_time_s: float = ${s.reload_time_s}
@export var recoil_pitch: float = ${s.recoil_pitch}
@export var recoil_yaw: float = ${s.recoil_yaw}
@export var recoil_kick_z: float = ${s.recoil_kick_z}
@export var hip_spread_deg: float = ${s.hip_spread_deg}
@export var ads_spread_deg: float = ${s.ads_spread_deg}
@export var ads_fov: float = ${s.ads_fov}.0
@export var ads_time_s: float = ${s.ads_time_s}
@export var pellet_count: int = ${s.pellet_count}
@export var range_m: float = ${s.range_m}.0

@onready var model: Node3D = $Model
@onready var anim_player: AnimationPlayer = $AnimationPlayer

@onready var socket_muzzle: Node3D = model.find_child("Socket_Muzzle", true, false) as Node3D
@onready var socket_grip_right: Node3D = model.find_child("Socket_Grip_Right", true, false) as Node3D
@onready var socket_grip_left: Node3D = model.find_child("Socket_Grip_Left", true, false) as Node3D
@onready var socket_ads: Node3D = model.find_child("Socket_ADS", true, false) as Node3D
@onready var socket_eject: Node3D = model.find_child("Socket_Eject", true, false) as Node3D
@onready var socket_mag: Node3D = model.find_child("Socket_Mag", true, false) as Node3D
@onready var socket_optic: Node3D = model.find_child("Socket_Optic", true, false) as Node3D
@onready var socket_underbarrel: Node3D = model.find_child("Socket_Underbarrel", true, false) as Node3D

@onready var right_hand: Node3D = model.find_child("RightHand", true, false) as Node3D
@onready var left_hand: Node3D = model.find_child("LeftHand", true, false) as Node3D

@onready var part_bolt: Node3D = model.find_child("Part_Bolt", true, false) as Node3D
@onready var part_magazine: Node3D = model.find_child("Part_Magazine", true, false) as Node3D
@onready var part_trigger: Node3D = model.find_child("Part_Trigger", true, false) as Node3D
@onready var part_stock: Node3D = model.find_child("Part_Stock", true, false) as Node3D

const MIXAMO_FINGERS := ["Thumb", "Index", "Middle", "Ring", "Pinky"]
const MIXAMO_PREFIX := "mixamorig:"

var is_stock_folded: bool = false

func play_fire() -> void:
\tif anim_player and anim_player.has_animation("fire"):
\t\tanim_player.stop()
\t\tanim_player.play("fire")

func play_reload() -> void:
\tif anim_player and anim_player.has_animation("reload"):
\t\tanim_player.play("reload")

func set_stock_folded(folded: bool) -> void:
\tif is_stock_folded == folded or not anim_player:
\t\treturn
\tis_stock_folded = folded
\tif folded:
\t\tanim_player.play("fold_stock")
\telse:
\t\tanim_player.play_backwards("fold_stock")

## Returns any Mixamo-named hand bone node (accepts "RightHandIndex1", "mixamorig:RightHandIndex1", or "mixamorig_RightHandIndex1").
func get_hand_bone(bone_name: String) -> Node3D:
\tif model == null:
\t\treturn null
\tvar normalized := bone_name.replace("mixamorig:", "").replace("mixamorig_", "")
\treturn model.find_child(normalized, true, false) as Node3D

## Returns a Dictionary mapping all 21 Mixamo bone names ("Right" or "Left") to their global Transform3D.
## Set use_mixamo_prefix = true to key the Dictionary with "mixamorig:RightHand*" / "mixamorig:LeftHand*".
func get_hand_bone_poses(side: String, use_mixamo_prefix: bool = false) -> Dictionary:
\tvar poses := {}
\tvar wrist_name := side + "Hand"
\tvar prefix := MIXAMO_PREFIX if use_mixamo_prefix else ""
\tvar wrist := get_hand_bone(wrist_name)
\tif wrist != null:
\t\tposes[prefix + wrist_name] = wrist.global_transform
\tfor finger in MIXAMO_FINGERS:
\t\tfor p in range(1, 5):
\t\t\tvar bname := "%s%s%d" % [wrist_name, finger, p]
\t\t\tvar node := get_hand_bone(bname)
\t\t\tif node != null:
\t\t\t\tposes[prefix + bname] = node.global_transform
\treturn poses

## Builds an unambiguous Basis from manifest grip_forward (-Z, finger wrap) and grip_up (+Y, thumb up).
static func solve_grip_basis(grip_forward: Vector3, grip_up: Vector3) -> Basis:
\treturn Basis.looking_at(grip_forward.normalized(), grip_up.normalized())

## Returns the baked orthonormal grip Basis for any Socket_* Node3D (-Z = grip_forward, +Y = grip_up).
func get_socket_basis(socket: Node3D) -> Basis:
\tif socket == null:
\t\treturn Basis.IDENTITY
\treturn socket.global_transform.basis.orthonormalized()

## Returns the local offset needed to align Socket_ADS directly with an FPS camera center.
func get_ads_offset() -> Vector3:
\tif socket_ads == null:
\t\treturn Vector3.ZERO
\treturn -socket_ads.position
`;
}

// IEEE 802.3 CRC-32 lookup table for standard PKZIP archives
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
}

/**
 * Builds a valid standard PKZIP (STORE method 0) archive in pure TypeScript with zero dependencies.
 */
export function buildStoreZip(entries: ZipEntryInput[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const prepared = entries.map((e) => ({
    nameBytes: encoder.encode(e.name),
    data: e.data,
    crc: computeCrc32(e.data),
    localOffset: 0,
  }));

  let localTotal = 0;
  let centralTotal = 0;
  for (const item of prepared) {
    item.localOffset = localTotal;
    localTotal += 30 + item.nameBytes.byteLength + item.data.byteLength;
    centralTotal += 46 + item.nameBytes.byteLength;
  }

  const totalSize = localTotal + centralTotal + 22;
  const out = new Uint8Array(new ArrayBuffer(totalSize));
  const view = new DataView(out.buffer);
  let pos = 0;

  // Local file headers + payloads
  for (const item of prepared) {
    view.setUint32(pos, 0x04034b50, true); // Local file header signature
    view.setUint16(pos + 4, 20, true); // Version needed to extract (2.0)
    view.setUint16(pos + 6, 0x0800, true); // UTF-8 filename flag
    view.setUint16(pos + 8, 0, true); // Compression method: STORE (0)
    view.setUint16(pos + 10, 0, true); // Mod time
    view.setUint16(pos + 12, 0x5821, true); // Mod date
    view.setUint32(pos + 14, item.crc, true);
    view.setUint32(pos + 18, item.data.byteLength, true);
    view.setUint32(pos + 22, item.data.byteLength, true);
    view.setUint16(pos + 26, item.nameBytes.byteLength, true);
    view.setUint16(pos + 28, 0, true); // Extra field length
    out.set(item.nameBytes, pos + 30);
    pos += 30 + item.nameBytes.byteLength;
    out.set(item.data, pos);
    pos += item.data.byteLength;
  }

  const centralDirStart = pos;

  // Central directory headers
  for (const item of prepared) {
    view.setUint32(pos, 0x02014b50, true); // Central directory header signature
    view.setUint16(pos + 4, 20, true); // Version made by
    view.setUint16(pos + 6, 20, true); // Version needed
    view.setUint16(pos + 8, 0x0800, true); // UTF-8 flag
    view.setUint16(pos + 10, 0, true); // Method: STORE
    view.setUint16(pos + 12, 0, true); // Mod time
    view.setUint16(pos + 14, 0x5821, true); // Mod date
    view.setUint32(pos + 16, item.crc, true);
    view.setUint32(pos + 20, item.data.byteLength, true);
    view.setUint32(pos + 24, item.data.byteLength, true);
    view.setUint16(pos + 28, item.nameBytes.byteLength, true);
    view.setUint16(pos + 30, 0, true); // Extra len
    view.setUint16(pos + 32, 0, true); // Comment len
    view.setUint16(pos + 34, 0, true); // Disk number
    view.setUint16(pos + 36, 0, true); // Internal attrs
    view.setUint32(pos + 38, 0, true); // External attrs
    view.setUint32(pos + 42, item.localOffset, true);
    out.set(item.nameBytes, pos + 46);
    pos += 46 + item.nameBytes.byteLength;
  }

  // End of Central Directory (EOCD) record
  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, prepared.length, true);
  view.setUint16(pos + 10, prepared.length, true);
  view.setUint32(pos + 12, centralTotal, true);
  view.setUint32(pos + 16, centralDirStart, true);
  view.setUint16(pos + 20, 0, true);

  return out;
}

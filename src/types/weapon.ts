export type SlotId =
  | 'receiver'
  | 'barrel'
  | 'handguard'
  | 'stock'
  | 'magazine'
  | 'grip'
  | 'muzzle'
  | 'optic'
  | 'underbarrel';

export type ReceiverVariant =
  | 'ak_stamped'
  | 'ak12_modern'
  | 'ar_flattop'
  | 'bullpup'
  | 'scifi_rail'
  | 'scar_monolithic'
  | 'smg_mp5'
  | 'bolt_chassis';

export type BarrelVariant =
  | 'ak_gastube'
  | 'heavy_sniper'
  | 'compact_smg'
  | 'integral_suppressed'
  | 'twin_scifi'
  | 'carbon_wrapped'
  | 'finned_lmg';

export type HandguardVariant =
  | 'none'
  | 'ak_wood'
  | 'tactical_mlok'
  | 'quad_rail'
  | 'compact_shroud'
  | 'scifi_angled'
  | 'keymod_slim'
  | 'heatshield_perforated';

export type StockVariant =
  | 'none'
  | 'ak_wood'
  | 'tactical_carbine'
  | 'skeleton_folder'
  | 'precision_sniper'
  | 'bullpup_buttpad'
  | 'scar_boot'
  | 'pdw_wire'
  | 'thumbhole_sport';

export type MagazineVariant =
  | 'none'
  | 'ak_curved'
  | 'ak_bakelite'
  | 'ar_stanag'
  | 'smg_stick'
  | 'drum_mag'
  | 'scifi_cell'
  | 'coupled_dual'
  | 'box_sniper';

export type GripVariant =
  | 'ak_slanted'
  | 'tactical_ergo'
  | 'cqb_vertical'
  | 'precision_palm'
  | 'skeleton_cnc'
  | 'rubber_overmold'
  | 'angled_pdw';

export type MuzzleVariant =
  | 'none'
  | 'slant_brake'
  | 'suppressor'
  | 'tank_brake'
  | 'flash_hider'
  | 'linear_comp'
  | 'osp_rectangular'
  | 'breacher_spike';

export type OpticVariant =
  | 'none'
  | 'iron_sights'
  | 'red_dot'
  | 'micro_reflex'
  | 'acog'
  | 'sniper_scope'
  | 'lpvo_tactical'
  | 'thermal_holo';

export type UnderbarrelVariant =
  | 'none'
  | 'vertical_grip'
  | 'angled_grip'
  | 'grenade_launcher'
  | 'tactical_laser'
  | 'bipod'
  | 'handstop_kit'
  | 'tactical_light'
  | 'masterkey_shotgun';

export type CameraViewPreset = 'three_quarter' | 'right' | 'left' | 'top' | 'ads';

export type GlbExportQuality = '500' | '1k' | '2k' | '4k';

export interface GlbExportQualitySpec {
  id: GlbExportQuality;
  label: string;
  textureSize: 512 | 1024 | 2048 | 4096;
  resolutionText: string;
  tierHint: string;
  filenameTag: string;
}

export interface WeaponParts {
  receiver: ReceiverVariant;
  barrel: BarrelVariant;
  handguard: HandguardVariant;
  stock: StockVariant;
  magazine: MagazineVariant;
  grip: GripVariant;
  muzzle: MuzzleVariant;
  optic: OpticVariant;
  underbarrel: UnderbarrelVariant;
}

export interface WeaponDimensions {
  receiverLength: number;
  receiverHeight: number;
  receiverWidth: number;
  receiverRailHeight: number;
  barrelLength: number;
  barrelThickness: number;
  barrelOffsetY: number;
  handguardLength: number;
  handguardBulk: number;
  handguardHeight: number;
  handguardOffset: number;
  stockLength: number;
  stockWidth: number;
  stockDrop: number;
  stockButtHeight: number;
  stockCheekHeight: number;
  magLength: number;
  magCurve: number;
  magWidth: number;
  magAngle: number;
  gripLength: number;
  gripAngle: number;
  gripThickness: number;
  muzzleScale: number;
  muzzleLengthScale: number;
  muzzleDiameterScale: number;
  opticOffset: number;
  opticScale: number;
  opticMountHeight: number;
  opticLensScale: number;
  underbarrelOffset: number;
  underbarrelScale: number;
  underbarrelWidth: number;
  underbarrelDrop: number;
}

export type PaintPattern =
  | 'solid'
  | 'wood'
  | 'carbon'
  | 'digital_camo'
  | 'tiger_stripe'
  | 'hex_tech'
  | 'brushed_steel';

export type PaintGroup = 'single' | 'metal' | 'furniture' | 'attachments' | 'all';

export interface PartPaint {
  primaryColor: string;
  secondaryColor: string;
  pattern: PaintPattern;
  metalness: number;
  roughness: number;
  patternScale: number;
  wear: number; // 0..1
}

export type WeaponPaints = Record<SlotId, PartPaint>;

export interface WeaponConfig {
  name: string;
  parts: WeaponParts;
  dimensions: WeaponDimensions;
  paints: WeaponPaints;
}

export interface Vec3Tuple {
  x: number;
  y: number;
  z: number;
}

export interface ResolvedMechanics {
  isBullpup: boolean;
  effectiveHandguardLength: number;
  handguardClamped: boolean;
  effectiveUnderbarrel: UnderbarrelVariant;
  underbarrelDisabledByHandguard: boolean;
  receiverFrontZ: number;
  receiverRearZ: number;
  receiverCenterY: number;
  receiverTopY: number;
  receiverRailTopY: number;
  receiverBottomY: number;
  needsAkSideBridge: boolean;
  barrelAxisY: number;
  barrelStartZ: number;
  barrelEndZ: number;
  handguardStartZ: number;
  handguardEndZ: number;
  magwellPos: Vec3Tuple;
  stockAttachPos: Vec3Tuple;
  opticMountPos: Vec3Tuple;
  underbarrelMountPos: Vec3Tuple;
  gripPivotPos: Vec3Tuple;
  socketMuzzlePos: Vec3Tuple;
  socketEjectPos: Vec3Tuple;
  socketAdsPos: Vec3Tuple;
  rightGripSurfaceHalfW: number;
  socketHandRPos: Vec3Tuple;
  socketHandRForward: Vec3Tuple;
  socketHandRUp: Vec3Tuple;
  socketHandRNormal: Vec3Tuple;
  socketHandLPos: Vec3Tuple;
  socketHandLForward: Vec3Tuple;
  socketHandLUp: Vec3Tuple;
  socketHandLNormal: Vec3Tuple;
  leftGripPlacement: LeftGripPlacement;
  leftGripCenterZ: number;
  leftGripEnvelopeHalfW: number;
  leftGripEnvelopeRightClearX: number;
  leftGripEnvelopeCenterY: number;
  leftGripEnvelopeBotY: number;
  boltRestPos: Vec3Tuple;
  triggerPivotPos: Vec3Tuple;
  selectorPos: Vec3Tuple;
  exactLengthMeters: number;
  estimatedLengthCm: number;
}

export type GodotWeaponCategory =
  | 'pistol'
  | 'smg'
  | 'assault_rifle'
  | 'shotgun'
  | 'sniper'
  | 'lmg';

export type GodotFireMode = 'auto' | 'burst' | 'bolt' | 'semi';

export interface GodotWeaponStats {
  damage: number;
  fire_rate_rpm: number;
  fire_mode: GodotFireMode;
  mag_size: number;
  reserve_ammo: number;
  reload_time_s: number;
  recoil_pitch: number;
  recoil_yaw: number;
  recoil_kick_z: number;
  hip_spread_deg: number;
  ads_spread_deg: number;
  ads_fov: number;
  ads_time_s: number;
  pellet_count: number;
  range_m: number;
  suppressed: boolean;
  sound_bank: string;
}

export type GodotSocketRole =
  | 'grip_contact_point'
  | 'muzzle'
  | 'camera_ads'
  | 'eject_port'
  | 'magazine_well'
  | 'rail_mount';

export interface GodotSocketTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  wrist_offset_weapon_space?: [number, number, number];
  hand_y_axis?: [number, number, number];
  hand_x_axis?: [number, number, number];
  grip_forward?: [number, number, number];
  grip_up?: [number, number, number];
  contact_normal?: [number, number, number];
  socket_role?: GodotSocketRole;
}

export type HandSide = 'left' | 'right';

export type HandFingerName = 'wrist' | 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

export type LeftGripPlacement =
  | 'direct_grip'
  | 'angled_cradle'
  | 'handstop_pocket'
  | 'rear_of_attachment'
  | 'front_of_attachment'
  | 'wrapped_attachment'
  | 'handguard_cradle'
  | 'bare_barrel';

export type LeftGripStyle =
  | 'vertical_grip'
  | 'angled_grip'
  | 'underbarrel_cradle'
  | 'handguard_cradle'
  | 'bare_barrel';

export interface HandBoneNodeSpec {
  name: string;
  mixamo_name: string;
  parent: string;
  hand: HandSide;
  finger: HandFingerName;
  phalanx: 0 | 1 | 2 | 3 | 4;
  position: [number, number, number];
  rotation: [number, number, number];
  rotation_deg: [number, number, number];
  quaternion: [number, number, number, number];
  world_position: [number, number, number];
  world_rotation: [number, number, number];
  world_rotation_deg: [number, number, number];
  world_quaternion: [number, number, number, number];
  bone_forward: [number, number, number];
  bone_normal: [number, number, number];
}

export interface GripSolveVectors {
  wrist_offset_weapon_space: [number, number, number];
  hand_y_axis: [number, number, number];
  hand_x_axis: [number, number, number];
}

export interface GodotHandRigSpec {
  naming_convention: 'mixamo';
  mixamo_prefix: 'mixamorig1_';
  finger_axis: '+Y';
  bone_longitudinal_axis: '+Y';
  wrist_bones: {
    right: 'RightHand';
    left: 'LeftHand';
  };
  wrist_mixamo_names: {
    right: 'mixamorig1_RightHand';
    left: 'mixamorig1_LeftHand';
  };
  right_grip_style: 'pistol_grip';
  left_grip_style: LeftGripStyle;
  left_grip_placement: LeftGripPlacement;
  underbarrel_variant: UnderbarrelVariant;
  grips: {
    right: GripSolveVectors;
    left: GripSolveVectors;
  };
  bones: Record<string, HandBoneNodeSpec>;
}

export interface GodotWeaponMetadata {
  weapon_id: string;
  name: string;
  category: GodotWeaponCategory;
  forward_axis: '-Z';
  units: 'meters';
  socket_semantics: 'grip_contact_point';
  is_joint: false;
  stats: GodotWeaponStats;
  dimensions_m: [number, number, number];
  movable_parts: string[];
  sockets: Record<string, GodotSocketTransform>;
}

export interface WeaponJsonExport extends GodotWeaponMetadata {
  parts: WeaponParts;
  dimensions: WeaponDimensions;
  paints: WeaponPaints;
}

export interface WeaponRigDebugExport {
  warning: string;
  game_must_not_load: true;
  weapon_id: string;
  naming_convention: 'mixamo';
  mixamo_prefix: 'mixamorig1_';
  finger_axis: '+Y';
  bone_longitudinal_axis: '+Y';
  rotation_order: 'XYZ';
  rotation_units: {
    rotation: 'radians';
    rotation_deg: 'degrees';
  };
  palm_offset_model: string;
  grips: {
    right: GripSolveVectors;
    left: GripSolveVectors;
  };
  bones: Record<
    string,
    {
      name: string;
      mixamo_name: string;
      parent: string;
      hand: HandSide;
      finger: HandFingerName;
      position: [number, number, number];
      rotation: [number, number, number];
      rotation_deg: [number, number, number];
      quaternion: [number, number, number, number];
      world_position: [number, number, number];
      world_rotation: [number, number, number];
      world_rotation_deg: [number, number, number];
      world_quaternion: [number, number, number, number];
    }
  >;
}

export interface ViewportTelemetry {
  triangles: number;
  partCount: number;
  lengthCm: number;
}

export interface ProjectedRigNode {
  name: string;
  shortLabel: string;
  color: string;
  kind: 'root' | 'bone' | 'socket';
  x: number;
  y: number;
  visible: boolean;
  rotationDeg?: [number, number, number];
}

export interface HoveredPartInfo {
  slot: SlotId;
  screenX: number;
  screenY: number;
}

export interface HoveredRigBoneInfo {
  name: string;
  mixamoName: string;
  hand: HandSide;
  screenX: number;
  screenY: number;
  rotationRad: [number, number, number];
  rotationDeg: [number, number, number];
  worldRotationDeg: [number, number, number];
  quaternion: [number, number, number, number];
}

export interface DimensionSliderSpec {
  key: keyof WeaponDimensions;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  displayMultiplier?: number;
  defaultValue: number;
}

export interface VariantSpec {
  id: string;
  name: string;
  shortDesc: string;
}

export interface ShapePreset {
  id: string;
  label: string;
  desc: string;
  values: Partial<WeaponDimensions>;
}

export interface SlotSpec {
  id: SlotId;
  label: string;
  optional: boolean;
  group: Exclude<PaintGroup, 'single' | 'all'>;
  mountInterface: string;
  relatedSlots: SlotId[];
  variants: VariantSpec[];
  sliders: DimensionSliderSpec[];
  shapePresets: ShapePreset[];
}

export interface FinishPreset {
  id: string;
  label: string;
  metalness: number;
  roughness: number;
  pattern?: PaintPattern;
  primaryColor?: string;
  secondaryColor?: string;
}

export interface WeaponThemePreset {
  id: string;
  name: string;
  swatches: [string, string, string];
  paints: WeaponPaints;
}

export interface StarterPreset {
  id: string;
  name: string;
  subtitle: string;
  config: WeaponConfig;
}

export interface ToastMessage {
  id: string;
  message: string;
  tone: 'info' | 'success' | 'warning';
}

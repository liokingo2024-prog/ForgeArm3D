import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { getInitialWeaponConfig, SLOT_ORDER, SLOT_SPECS, STARTER_PRESETS } from '../data/catalog';
import {
  ALL_MIXAMO_HAND_BONE_NAMES,
  MIXAMO_FINGERS,
  MIXAMO_LEFT_BONE_NAMES,
  MIXAMO_RIGHT_BONE_NAMES,
  resolveMixamoHandRig,
} from './handRig';
import {
  applyDimensionPatch,
  applyPaintToGroup,
  applyWeaponTheme,
  buildGlbExportFilename,
  createHistory,
  formatExportByteSize,
  getGlbExportSpec,
  GLB_EXPORT_QUALITIES,
  harmonizeAccentColor,
  parseOfflineKeywordPrompt,
  pushHistory,
  redoHistory,
  resetAllDimensions,
  resetSlotDimensions,
  resolveMechanicalConstraints,
  sanitizeWeaponConfig,
  undoHistory,
} from './weaponLogic';
import {
  buildMonochromeExportTint,
  getGlbJpegQuality,
  isMonochromeTintable,
  parseGlbChunks,
  quantizeExportWear,
  replaceGlbBufferViews,
} from './glbOptimizer';
import {
  buildGlbEmbeddedExtras,
  buildGlbHandBoneRotationsPayload,
  buildGlbSocketExtrasMap,
  buildGodotBundleFilename,
  buildGodotSocketsMap,
  buildGodotWeaponMetadata,
  buildStoreZip,
  buildWeaponJsonExport,
  buildWeaponRigDebugJson,
  computeCrc32,
  computeGodotWeaponCategory,
  computeGodotWeaponStats,
  generateGodotSceneTscn,
  generateGodotScriptGd,
  getExportedMovableParts,
  runManifestSelfCheck,
  slugifyWeaponName,
  toGodotNodeName,
} from './godotExporter';

test('handguard-to-barrel guardrail clamps effective handguard length safely behind muzzle', () => {
  const cfg = getInitialWeaponConfig();
  cfg.dimensions.barrelLength = 0.2;
  cfg.dimensions.handguardLength = 0.35;

  const solved = resolveMechanicalConstraints(cfg);
  assert.equal(solved.handguardClamped, true);
  assert.ok(solved.effectiveHandguardLength <= 0.2 - 0.031);
  assert.ok(solved.handguardEndZ > solved.barrelEndZ);
});

test('bullpup architecture relocates magwell behind pistol grip (+Z)', () => {
  const standard = resolveMechanicalConstraints(STARTER_PRESETS[0].config);
  const bullpup = resolveMechanicalConstraints(STARTER_PRESETS[2].config);

  assert.equal(standard.isBullpup, false);
  assert.ok(standard.magwellPos.z < 0, 'Standard rifle magwell should sit ahead of pistol grip (-Z)');

  assert.equal(bullpup.isBullpup, true);
  assert.ok(bullpup.magwellPos.z > 0, 'Bullpup magwell must relocate behind pistol grip (+Z)');
});

test('removing handguard disables underbarrel mount and relocates socket_hand_l cleanly', () => {
  const cfg = getInitialWeaponConfig();
  cfg.parts.handguard = 'tactical_mlok';
  cfg.parts.underbarrel = 'vertical_grip';
  const withHandguard = resolveMechanicalConstraints(cfg);
  assert.equal(withHandguard.effectiveUnderbarrel, 'vertical_grip');
  assert.equal(withHandguard.underbarrelDisabledByHandguard, false);

  cfg.parts.handguard = 'none';
  const withoutHandguard = resolveMechanicalConstraints(cfg);
  assert.equal(withoutHandguard.effectiveUnderbarrel, 'none');
  assert.equal(withoutHandguard.underbarrelDisabledByHandguard, true);
  assert.ok(withoutHandguard.socketHandLPos.z < 0);
});

test('smart paint group sync applies paint across targeted mechanical groups only', () => {
  const cfg = getInitialWeaponConfig();
  const updated = applyPaintToGroup(
    cfg,
    'handguard',
    { primaryColor: '#445533', pattern: 'digital_camo', wear: 0.5 },
    'furniture'
  );

  assert.equal(updated.paints.handguard.primaryColor, '#445533');
  assert.equal(updated.paints.stock.primaryColor, '#445533');
  assert.equal(updated.paints.grip.primaryColor, '#445533');
  assert.equal(updated.paints.stock.pattern, 'digital_camo');
  // Receiver is in 'metal', not 'furniture', so it stays untouched
  assert.notEqual(updated.paints.receiver.primaryColor, '#445533');
});

test('offline keyword gunsmith preserves existing parts on targeted edit prompts', () => {
  const base = getInitialWeaponConfig();
  base.parts.receiver = 'ar_flattop';
  base.parts.handguard = 'quad_rail';

  const { config } = parseOfflineKeywordPrompt(
    'keep my parts, just paint it battle-worn desert camo and add a red dot',
    base
  );

  assert.equal(config.parts.receiver, 'ar_flattop');
  assert.equal(config.parts.handguard, 'quad_rail');
  assert.equal(config.parts.optic, 'red_dot');
  assert.equal(config.paints.receiver.wear, 0.72);
});

test('offline keyword gunsmith builds compact suppressed bullpup in OD green', () => {
  const base = getInitialWeaponConfig();
  const { config } = parseOfflineKeywordPrompt(
    'build a compact suppressed bullpup in OD green',
    base
  );

  assert.equal(config.parts.receiver, 'bullpup');
  assert.equal(config.parts.muzzle, 'suppressor');
  assert.ok(config.dimensions.barrelLength <= 0.25);
  assert.equal(config.paints.handguard.pattern, 'tiger_stripe');
});

test('sanitizeWeaponConfig clamps out-of-range dimensions and ignores invalid enums', () => {
  const base = getInitialWeaponConfig();
  const cleaned = sanitizeWeaponConfig(
    {
      parts: { receiver: 'invalid_part', muzzle: 'suppressor' },
      dimensions: { barrelLength: 99, gripAngle: -50 },
    },
    base
  );

  assert.equal(cleaned.parts.receiver, base.parts.receiver);
  assert.equal(cleaned.parts.muzzle, 'suppressor');
  assert.equal(cleaned.dimensions.barrelLength, 0.64);
  assert.equal(cleaned.dimensions.gripAngle, 8);
});

test('optic mount seats cleanly on every receiver rail and triggers AK side bridge when needed', () => {
  for (const preset of STARTER_PRESETS) {
    const solved = resolveMechanicalConstraints(preset.config);
    assert.ok(
      Math.abs(solved.opticMountPos.y - solved.receiverRailTopY) < 0.0001,
      `${preset.id} optic mount must align exactly with receiverRailTopY`
    );
    assert.ok(
      solved.opticMountPos.z <= solved.receiverRearZ &&
        solved.opticMountPos.z >= solved.receiverFrontZ,
      `${preset.id} optic Z must sit within receiver rail span`
    );
  }
  const akSolved = resolveMechanicalConstraints(STARTER_PRESETS[0].config);
  assert.equal(akSolved.needsAkSideBridge, true);
  const arSolved = resolveMechanicalConstraints(STARTER_PRESETS[1].config);
  assert.equal(arSolved.needsAkSideBridge, false);

  const modified = getInitialWeaponConfig();
  modified.dimensions.opticOffset = 0.05;
  modified.dimensions.opticMountHeight = 0.025;
  modified.dimensions.opticLensScale = 1.25;
  const reset = resetSlotDimensions(modified, 'optic');
  assert.equal(reset.dimensions.opticOffset, 0);
  assert.equal(reset.dimensions.opticMountHeight, 0);
  assert.equal(reset.dimensions.opticLensScale, 1.0);
});

test('undo and redo history stack caps at 25 steps and restores exact states', () => {
  let hist = createHistory(0);
  for (let i = 1; i <= 30; i++) {
    hist = pushHistory(hist, i);
  }
  assert.equal(hist.present, 30);
  assert.equal(hist.past.length, 25);

  hist = undoHistory(hist);
  assert.equal(hist.present, 29);
  hist = redoHistory(hist);
  assert.equal(hist.present, 30);
});

test('harmonizeAccentColor returns valid 6-digit hex and theme application works', () => {
  const accent = harmonizeAccentColor('#a68e6b');
  assert.match(accent, /^#[0-9a-f]{6}$/);

  const base = getInitialWeaponConfig();
  const themed = applyWeaponTheme(base, 'cyber_titanium_gold');
  assert.equal(themed.paints.receiver.pattern, 'hex_tech');
});

test('applyDimensionPatch clamps values, resetAllDimensions restores defaults, and all slot shapePresets are in bounds', () => {
  const base = getInitialWeaponConfig();
  const patched = applyDimensionPatch(base, {
    barrelLength: 0.95,
    gripAngle: 2,
    opticMountHeight: 0.012,
  });
  assert.equal(patched.dimensions.barrelLength, 0.64);
  assert.equal(patched.dimensions.gripAngle, 8);
  assert.equal(patched.dimensions.opticMountHeight, 0.012);

  const restored = resetAllDimensions(patched);
  assert.equal(restored.dimensions.barrelLength, base.dimensions.barrelLength);
  assert.equal(restored.dimensions.gripAngle, base.dimensions.gripAngle);
  assert.equal(restored.dimensions.opticMountHeight, 0);

  for (const slot of SLOT_ORDER) {
    const spec = SLOT_SPECS[slot];
    assert.equal(spec.shapePresets.length, 3, `${slot} should define 3 shape presets`);
    assert.ok(spec.mountInterface.length > 0, `${slot} should define mountInterface`);
    assert.ok(spec.relatedSlots.length >= 2, `${slot} should define relatedSlots`);
    for (const preset of spec.shapePresets) {
      for (const slider of spec.sliders) {
        const v = preset.values[slider.key];
        if (v !== undefined) {
          assert.ok(
            v >= slider.min && v <= slider.max,
            `${slot}.${preset.id}.${slider.key} (${v}) out of [${slider.min}, ${slider.max}]`
          );
        }
      }
    }
  }
});

test('every weapon slot exposes a width/thickness shape slider and expanded hardware variants resolve cleanly', () => {
  const widthSliderKeys = new Set([
    'receiverWidth',
    'barrelThickness',
    'handguardBulk',
    'stockWidth',
    'magWidth',
    'gripThickness',
    'muzzleDiameterScale',
    'opticLensScale',
    'underbarrelWidth',
  ]);

  for (const slot of SLOT_ORDER) {
    const spec = SLOT_SPECS[slot];
    const hasWidth = spec.sliders.some((s) => widthSliderKeys.has(s.key));
    assert.equal(hasWidth, true, `${slot} must expose a width/thickness adjuster slider`);
    assert.ok(
      spec.variants.length >= 7,
      `${slot} should expose expanded hardware catalog (>= 7 variants, got ${spec.variants.length})`
    );
  }

  const base = getInitialWeaponConfig();
  const clamped = applyDimensionPatch(base, {
    stockWidth: 3.5,
    underbarrelWidth: 0.1,
  });
  assert.equal(clamped.dimensions.stockWidth, 1.48);
  assert.equal(clamped.dimensions.underbarrelWidth, 0.72);

  const combo = sanitizeWeaponConfig(
    {
      parts: {
        receiver: 'scar_monolithic',
        barrel: 'carbon_wrapped',
        handguard: 'keymod_slim',
        stock: 'scar_boot',
        magazine: 'coupled_dual',
        grip: 'skeleton_cnc',
        muzzle: 'osp_rectangular',
        optic: 'lpvo_tactical',
        underbarrel: 'masterkey_shotgun',
      },
      dimensions: { stockWidth: 1.22, underbarrelWidth: 1.15 },
    },
    base
  );
  const solved = resolveMechanicalConstraints(combo);
  assert.equal(combo.parts.receiver, 'scar_monolithic');
  assert.equal(combo.parts.underbarrel, 'masterkey_shotgun');
  assert.ok(Math.abs(solved.opticMountPos.y - solved.receiverRailTopY) < 0.0001);
  assert.ok(solved.estimatedLengthCm > 60 && solved.estimatedLengthCm < 150);

  for (const receiver of ['scar_monolithic', 'smg_mp5', 'bolt_chassis'] as const) {
    const cfg = getInitialWeaponConfig();
    cfg.parts.receiver = receiver;
    cfg.parts.muzzle = 'breacher_spike';
    cfg.parts.optic = 'thermal_holo';
    cfg.parts.underbarrel = 'handstop_kit';
    const r = resolveMechanicalConstraints(cfg);
    assert.ok(Math.abs(r.opticMountPos.y - r.receiverRailTopY) < 0.0001);
    assert.ok(Number.isFinite(r.socketMuzzlePos.z));
    assert.ok(Number.isFinite(r.socketHandLPos.y));
  }
});

test('GLB export quality specs expose 500, 1K, 2K, and 4K tiers with valid filenames and size labels', () => {
  assert.deepEqual(
    GLB_EXPORT_QUALITIES.map((q) => [q.id, q.label, q.textureSize]),
    [
      ['500', '500', 512],
      ['1k', '1K', 1024],
      ['2k', '2K', 2048],
      ['4k', '4K', 4096],
    ]
  );
  assert.equal(getGlbExportSpec('500').textureSize, 512);
  assert.equal(getGlbExportSpec('1k').textureSize, 1024);
  assert.equal(getGlbExportSpec('2k').textureSize, 2048);
  assert.equal(getGlbExportSpec('4k').textureSize, 4096);

  assert.equal(buildGlbExportFilename('AK-47 Classic', '500'), 'ak_47_classic_500.glb');
  assert.equal(buildGlbExportFilename('M4A1 Spec-Ops', '2k'), 'm4a1_spec_ops_2k.glb');
  assert.equal(buildGlbExportFilename('   ', '4k'), 'forgearm_weapon_4k.glb');

  assert.equal(formatExportByteSize(512 * 1024), '512 KB');
  assert.equal(formatExportByteSize(3.25 * 1024 * 1024), '3.3 MB');
});

test('GLB binary rebuilder preserves 4-byte alignment, deduplicates identical images, and remaps bufferViews', () => {
  const geoBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const origImgBytes = new Uint8Array([0xff, 0xd8, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 0xff, 0xd9]);
  const tailGeoBytes = new Uint8Array([21, 22, 23, 24]);
  const jsonObj = {
    asset: { version: '2.0', generator: 'test' },
    buffers: [{ byteLength: 40 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 12 },
      { buffer: 0, byteOffset: 12, byteLength: 10 },
      { buffer: 0, byteOffset: 24, byteLength: 10 },
      { buffer: 0, byteOffset: 36, byteLength: 4 },
    ],
    accessors: [{ bufferView: 0 }, { bufferView: 3 }],
    images: [
      { mimeType: 'image/jpeg', bufferView: 1 },
      { mimeType: 'image/jpeg', bufferView: 2 },
    ],
    textures: [{ source: 0 }, { source: 1 }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(jsonObj));
  const paddedJsonLen = (jsonBytes.byteLength + 3) & ~3;
  const binBuf = new Uint8Array(40);
  binBuf.set(geoBytes, 0);
  binBuf.set(origImgBytes, 12);
  binBuf.set(origImgBytes, 24);
  binBuf.set(tailGeoBytes, 36);

  const totalLen = 12 + 8 + paddedJsonLen + 8 + 40;
  const srcAb = new ArrayBuffer(totalLen);
  const dv = new DataView(srcAb);
  const u8 = new Uint8Array(srcAb);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLen, true);
  dv.setUint32(12, paddedJsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  u8.set(jsonBytes, 20);
  for (let i = jsonBytes.byteLength; i < paddedJsonLen; i++) u8[20 + i] = 0x20;
  dv.setUint32(20 + paddedJsonLen, 40, true);
  dv.setUint32(24 + paddedJsonLen, 0x004e4942, true);
  u8.set(binBuf, 28 + paddedJsonLen);

  const compactImg = new Uint8Array([0xff, 0xd8, 0x42, 0xff, 0xd9]);
  const rebuilt = replaceGlbBufferViews(
    srcAb,
    new Map([
      [1, compactImg],
      [2, compactImg],
    ]),
    true
  );

  assert.equal(rebuilt.byteLength % 4, 0, 'Rebuilt GLB total length must be 4-byte aligned');
  const parsed = parseGlbChunks(rebuilt);
  assert.equal(parsed.json.images?.length, 1);
  assert.equal(parsed.json.textures?.[0].source, 0);
  assert.equal(parsed.json.textures?.[1].source, 0);
  assert.equal(parsed.json.bufferViews?.length, 3);
  assert.equal(parsed.json.accessors?.[1].bufferView, 2);
  assert.equal(parsed.json.bufferViews?.[0].byteOffset, 0);
  assert.equal(parsed.json.bufferViews?.[1].byteOffset, 12);
  assert.equal(parsed.json.bufferViews?.[1].byteLength, 5);
  assert.equal(parsed.json.bufferViews?.[2].byteOffset, 20);
  assert.equal(parsed.json.buffers?.[0].byteLength, 24);
  assert.deepEqual(Array.from(parsed.bin.subarray(0, 12)), Array.from(geoBytes));
  assert.deepEqual(Array.from(parsed.bin.subarray(12, 17)), Array.from(compactImg));
  assert.deepEqual(Array.from(parsed.bin.subarray(20, 24)), Array.from(tailGeoBytes));
});

test('monochrome export tinting deduplicates single-tone metal/wood/polymer while protecting two-tone & camo', () => {
  const akTheme = STARTER_PRESETS[0].config.paints;
  assert.equal(isMonochromeTintable(akTheme.receiver), true);
  assert.equal(isMonochromeTintable(akTheme.barrel), true);
  assert.equal(isMonochromeTintable(akTheme.handguard), true);
  assert.equal(isMonochromeTintable(akTheme.underbarrel), true);

  const receiverTint = buildMonochromeExportTint(akTheme.receiver);
  const barrelTint = buildMonochromeExportTint(akTheme.barrel);
  assert.ok(receiverTint && barrelTint);
  assert.equal(receiverTint.basePaint.primaryColor, barrelTint.basePaint.primaryColor);
  assert.equal(receiverTint.basePaint.wear, barrelTint.basePaint.wear);
  assert.equal(receiverTint.tintHex, akTheme.receiver.primaryColor);

  assert.equal(
    isMonochromeTintable({
      ...akTheme.receiver,
      primaryColor: '#c83228',
      secondaryColor: '#1f4e99',
    }),
    false
  );
  assert.equal(isMonochromeTintable({ ...akTheme.receiver, wear: 0.72 }), false);
  assert.equal(isMonochromeTintable({ ...akTheme.receiver, pattern: 'digital_camo' }), false);
  assert.equal(isMonochromeTintable({ ...akTheme.receiver, pattern: 'carbon' }), false);
  assert.equal(isMonochromeTintable({ ...akTheme.receiver, pattern: 'hex_tech' }), false);

  assert.equal(quantizeExportWear(0.05), 0.0);
  assert.equal(quantizeExportWear(0.18), 0.22);
  assert.equal(quantizeExportWear(0.34), 0.22);
  assert.equal(quantizeExportWear(0.58), 0.55);
  assert.equal(quantizeExportWear(0.88), 0.85);
  const q500 = getGlbJpegQuality('500');
  const q1k = getGlbJpegQuality('1k');
  const q2k = getGlbJpegQuality('2k');
  const q4k = getGlbJpegQuality('4k');
  assert.ok(q500.albedo < q1k.albedo && q1k.albedo < q2k.albedo && q2k.albedo < q4k.albedo);
  assert.ok(q1k.technical > q1k.albedo);
});

test('Godot 4 socket constraints resolve finite meter-scale positions across all presets and optics', () => {
  for (const preset of STARTER_PRESETS) {
    const m = resolveMechanicalConstraints(preset.config);
    assert.ok(m.exactLengthMeters > 0.5 && m.exactLengthMeters < 1.6, `${preset.id} length_m out of realistic range`);
    assert.ok(m.socketMuzzlePos.z < m.socketHandRPos.z - 0.3, `${preset.id} muzzle must point forward down -Z`);
    assert.ok(m.socketEjectPos.x > 0, `${preset.id} ejection port must sit on right side (+X)`);
    assert.ok(m.socketAdsPos.y > m.receiverRailTopY, `${preset.id} ADS line-of-sight must sit above receiver rail`);
    assert.ok(m.socketHandRPos.y < m.triggerPivotPos.y, `${preset.id} right hand palm must sit below trigger`);
  }

  for (const optic of SLOT_SPECS.optic.variants) {
    const low = getInitialWeaponConfig();
    low.parts.optic = optic.id as typeof low.parts.optic;
    low.dimensions.opticMountHeight = 0;
    const high = getInitialWeaponConfig();
    high.parts.optic = optic.id as typeof high.parts.optic;
    high.dimensions.opticMountHeight = 0.02;

    const mLow = resolveMechanicalConstraints(low);
    const mHigh = resolveMechanicalConstraints(high);
    assert.ok(Number.isFinite(mLow.socketAdsPos.y) && Number.isFinite(mHigh.socketAdsPos.y));
    if (optic.id !== 'none' && optic.id !== 'iron_sights') {
      assert.ok(
        Math.abs(mHigh.socketAdsPos.y - mLow.socketAdsPos.y - 0.02) < 0.001,
        `optic ${optic.id} Socket_ADS Y must track opticMountHeight`
      );
    }
  }
});

test('computeGodotWeaponStats & category output all Godot 4.7.2 fields accurately across weapon classes', () => {
  const requiredStatKeys = [
    'damage',
    'fire_rate_rpm',
    'fire_mode',
    'mag_size',
    'reserve_ammo',
    'reload_time_s',
    'recoil_pitch',
    'recoil_yaw',
    'recoil_kick_z',
    'hip_spread_deg',
    'ads_spread_deg',
    'ads_fov',
    'ads_time_s',
    'pellet_count',
    'range_m',
    'suppressed',
    'sound_bank',
  ].sort();

  const validCategories = new Set(['pistol', 'smg', 'assault_rifle', 'shotgun', 'sniper', 'lmg']);

  for (const preset of STARTER_PRESETS) {
    const m = resolveMechanicalConstraints(preset.config);
    const cat = computeGodotWeaponCategory(preset.config, m);
    const stats = computeGodotWeaponStats(preset.config, m);
    assert.ok(validCategories.has(cat), `Invalid category ${cat}`);
    assert.deepEqual(Object.keys(stats).sort(), requiredStatKeys);
    assert.ok(['auto', 'burst', 'bolt', 'semi'].includes(stats.fire_mode));
    assert.ok(stats.reserve_ammo >= stats.mag_size);
    assert.ok(stats.range_m >= 25);
  }

  const sniper = getInitialWeaponConfig();
  sniper.parts.receiver = 'bolt_chassis';
  sniper.parts.barrel = 'heavy_sniper';
  sniper.parts.muzzle = 'suppressor';
  sniper.parts.optic = 'sniper_scope';
  sniper.parts.magazine = 'box_sniper';
  const sniperM = resolveMechanicalConstraints(sniper);
  const sniperStats = computeGodotWeaponStats(sniper, sniperM);
  assert.equal(computeGodotWeaponCategory(sniper, sniperM), 'sniper');
  assert.equal(sniperStats.fire_mode, 'bolt');
  assert.equal(sniperStats.suppressed, true);
  assert.match(sniperStats.sound_bank, /_suppressed$/);
  assert.equal(sniperStats.ads_fov, 18);
  assert.equal(sniperStats.mag_size, 5);
  assert.equal(sniperStats.pellet_count, 1);
  assert.ok(sniperStats.damage >= 90);
  assert.ok(sniperStats.range_m >= 400);

  const pistol = getInitialWeaponConfig();
  pistol.parts.receiver = 'smg_mp5';
  pistol.parts.barrel = 'compact_smg';
  pistol.parts.stock = 'none';
  pistol.parts.muzzle = 'none';
  pistol.dimensions.barrelLength = 0.16;
  pistol.dimensions.receiverLength = 0.18;
  const pistolM = resolveMechanicalConstraints(pistol);
  assert.equal(computeGodotWeaponCategory(pistol, pistolM), 'pistol');
  assert.equal(computeGodotWeaponStats(pistol, pistolM).fire_mode, 'semi');

  const smg = getInitialWeaponConfig();
  smg.parts.receiver = 'smg_mp5';
  smg.parts.magazine = 'smg_stick';
  assert.equal(computeGodotWeaponCategory(smg, resolveMechanicalConstraints(smg)), 'smg');

  const lmg = getInitialWeaponConfig();
  lmg.parts.receiver = 'scifi_rail';
  lmg.parts.magazine = 'drum_mag';
  lmg.parts.barrel = 'integral_suppressed';
  const lmgM = resolveMechanicalConstraints(lmg);
  const lmgStats = computeGodotWeaponStats(lmg, lmgM);
  assert.equal(computeGodotWeaponCategory(lmg, lmgM), 'lmg');
  assert.equal(lmgStats.fire_mode, 'burst');
  assert.equal(lmgStats.suppressed, true);
  assert.equal(lmgStats.mag_size, 75);

  const shotty = getInitialWeaponConfig();
  shotty.parts.handguard = 'tactical_mlok';
  shotty.parts.underbarrel = 'masterkey_shotgun';
  shotty.dimensions.barrelLength = 0.3;
  const shottyM = resolveMechanicalConstraints(shotty);
  assert.equal(computeGodotWeaponCategory(shotty, shottyM), 'shotgun');
  assert.equal(computeGodotWeaponStats(shotty, shottyM).pellet_count, 8);
});

test('weapon manifest removes Grip_Left, embeds bone_attach & all 42 bone positions/rotations, and passes all 15 self-checks', () => {
  const cfg = getInitialWeaponConfig();
  const m = resolveMechanicalConstraints(cfg);
  const exported = buildWeaponJsonExport(cfg, m, [0.064, 0.285, 0.92]);

  assert.deepEqual(
    Object.keys(exported).sort(),
    [
      'weapon_id',
      'name',
      'category',
      'forward_axis',
      'units',
      'socket_semantics',
      'is_joint',
      'stats',
      'dimensions_m',
      'movable_parts',
      'parts',
      'dimensions',
      'paints',
      'sockets',
      'bone_attach',
      'hand_bone_rotations',
    ].sort()
  );

  assert.equal(exported.weapon_id, 'ak_47_classic');
  assert.equal(exported.forward_axis, '-Z');
  assert.equal(exported.units, 'meters');
  assert.equal(exported.socket_semantics, 'grip_contact_point');
  assert.equal(exported.is_joint, false);
  assert.deepEqual(exported.dimensions_m, [0.064, 0.285, 0.92]);

  // Verify Socket_Grip_Left is completely removed
  assert.equal(exported.sockets.Socket_Grip_Left, undefined);

  // Verify Socket_Grip_Right matches Mixamo (+Y longitudinal, +X thumbward, +Z palmar)
  const rightGrip = exported.sockets.Socket_Grip_Right;
  assert.deepEqual(rightGrip.position, [0, 0, 0]);
  assert.deepEqual(rightGrip.rotation, [0, 0, 0]);
  assert.ok(rightGrip.wrist_offset_weapon_space);
  assert.ok(rightGrip.wrist_offset_weapon_space[0] > 0.025);
  assert.ok(rightGrip.wrist_offset_weapon_space[2] > 0.045);
  assert.ok(rightGrip.hand_y_axis && rightGrip.hand_y_axis[2] < -0.9);
  assert.ok(rightGrip.hand_x_axis && rightGrip.hand_x_axis[1] > 0.85);
  assert.ok(exported.hand_bone_rotations.bones.RightHand.bone_normal[0] < -0.9);

  // Verify bone_attach is exact inverse of RightHand wrist transform
  assert.equal(exported.bone_attach.attach_bone, 'mixamorig1_RightHand');
  const rwBone = exported.hand_bone_rotations.bones.RightHand;
  const wristMat = new THREE.Matrix4().compose(
    new THREE.Vector3(...rwBone.world_position),
    new THREE.Quaternion(...rwBone.world_quaternion),
    new THREE.Vector3(1, 1, 1)
  );
  const attachMat = new THREE.Matrix4().compose(
    new THREE.Vector3(...exported.bone_attach.weapon_offset_position),
    new THREE.Quaternion(...exported.bone_attach.weapon_offset_quaternion),
    new THREE.Vector3(1, 1, 1)
  );
  const product = wristMat.multiply(attachMat);
  const identErr = product.elements.reduce((acc, v, i) => {
    const expected = i % 5 === 0 ? 1 : 0;
    return Math.max(acc, Math.abs(v - expected));
  }, 0);
  assert.ok(identErr < 0.002, `bone_attach inverse matrix mismatch: max err=${identErr}`);

  // Verify all 42 bone positions & rotations exist directly in <weapon_id>.json
  assert.equal(exported.hand_bone_rotations.palmar_axis, '+Z');
  assert.equal(Object.keys(exported.hand_bone_rotations.bones).length, 42);
  for (const b of Object.values(exported.hand_bone_rotations.bones)) {
    assert.equal(b.position.length, 3);
    assert.equal(b.world_position.length, 3);
    assert.equal(b.right_hand_position.length, 3);
    assert.ok(Number.isFinite(b.bone_length_m));
  }

  // Verify Socket_Shoulder derivation
  const shoulder = exported.sockets.Socket_Shoulder;
  assert.ok(shoulder, 'Stocked weapon must emit Socket_Shoulder');
  assert.deepEqual(shoulder.rotation, [0, 0, 0]);
  assert.equal(shoulder.position[0], 0);
  assert.equal(shoulder.position[1], -cfg.dimensions.stockDrop);
  assert.ok(
    Math.abs(shoulder.position[2] - (exported.sockets.Socket_Muzzle.position[2] + 0.92)) <= 0.001
  );

  // Verify zero legacy/forbidden strings in serialized runtime manifest
  const jsonText = JSON.stringify(exported);
  for (const forbidden of [
    'Grip_Left',
    'left_grip_',
    'hand_rig',
    'hand_orientation',
    'HandRig_',
    'mixamorig:',
    'runtime_outward_along_contact_normal',
  ]) {
    assert.equal(jsonText.includes(forbidden), false, `Forbidden token "${forbidden}" found in runtime manifest`);
  }

  // Test stockless pistol omits Socket_Shoulder
  const stockless = getInitialWeaponConfig();
  stockless.parts.stock = 'none';
  stockless.parts.handguard = 'none';
  stockless.parts.magazine = 'none';
  const stocklessMeta = buildGodotWeaponMetadata(stockless, resolveMechanicalConstraints(stockless));
  assert.equal(stocklessMeta.sockets.Socket_Shoulder, undefined);
  assert.equal(stocklessMeta.sockets.Socket_Underbarrel, undefined);
  assert.equal(getExportedMovableParts(stockless).includes('Part_Magazine'), false);
  assert.equal(getExportedMovableParts(stockless).includes('Part_Stock'), false);

  // Run all 15 self-checks across all starter presets, stockless build, all 9 underbarrels, and all 7 grips
  const checkConfigs: Array<{ label: string; cfg: typeof cfg }> = [
    ...STARTER_PRESETS.map((p) => ({ label: `preset:${p.id}`, cfg: p.config })),
    { label: 'stockless', cfg: stockless },
    ...SLOT_SPECS.underbarrel.variants.map((ub) => {
      const c = getInitialWeaponConfig();
      c.parts.handguard = 'tactical_mlok';
      c.parts.underbarrel = ub.id as typeof c.parts.underbarrel;
      return { label: `underbarrel:${ub.id}`, cfg: c };
    }),
    ...SLOT_SPECS.grip.variants.map((g) => {
      const c = getInitialWeaponConfig();
      c.parts.grip = g.id as typeof c.parts.grip;
      return { label: `grip:${g.id}`, cfg: c };
    }),
  ];

  for (const { label, cfg: testCfg } of checkConfigs) {
    const solvedM = resolveMechanicalConstraints(testCfg);
    const manifest = buildGodotWeaponMetadata(testCfg, solvedM);
    const results = runManifestSelfCheck(manifest, testCfg.parts.stock !== 'none');
    for (const r of results) {
      assert.equal(r.pass, true, `${label} failed check #${r.id} (${r.label}): ${r.detail}`);
    }
  }

  // Round-trip through sanitizeWeaponConfig (Load JSON backwards compatibility)
  const roundTripped = sanitizeWeaponConfig(JSON.parse(jsonText), STARTER_PRESETS[1].config);
  assert.deepEqual(roundTripped.parts, cfg.parts);
  assert.deepEqual(roundTripped.dimensions, cfg.dimensions);
  assert.equal(roundTripped.name, cfg.name);

  // Verify buildWeaponRigDebugJson emits all bone positions & rotations without left_grip info
  const debugJson = buildWeaponRigDebugJson(cfg, m);
  assert.equal(debugJson.mixamo_prefix, 'mixamorig1_');
  assert.equal(debugJson.finger_axis, '+Y');
  assert.equal(debugJson.palmar_axis, '+Z');
  assert.equal(debugJson.rotation_order, 'XYZ');
  assert.deepEqual(debugJson.rotation_units, { rotation: 'radians', rotation_deg: 'degrees' });
  assert.equal(debugJson.bones.RightHand.parent, 'mixamorig1_RightForeArm');
  assert.equal(debugJson.bones.LeftHand.parent, 'mixamorig1_LeftForeArm');
  assert.equal(JSON.stringify(debugJson).includes('Grip_Left'), false);
  for (const b of Object.values(debugJson.bones)) {
    assert.equal(b.position.length, 3);
    assert.equal(b.world_position.length, 3);
    assert.equal(b.right_hand_position.length, 3);
    assert.equal(b.rotation.length, 3);
    assert.equal(b.rotation_deg.length, 3);
    assert.equal(b.quaternion.length, 4);
    assert.equal(b.world_rotation.length, 3);
    assert.equal(b.world_rotation_deg.length, 3);
    assert.equal(b.world_quaternion.length, 4);
    const qFromEuler = new THREE.Quaternion().setFromEuler(new THREE.Euler(b.rotation[0], b.rotation[1], b.rotation[2], 'XYZ'));
    const qStored = new THREE.Quaternion(...b.quaternion).normalize();
    assert.ok(Math.abs(qFromEuler.dot(qStored)) > 0.9999, `${b.name} local Euler/quaternion mismatch`);
    const qWorldEuler = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(b.world_rotation[0], b.world_rotation[1], b.world_rotation[2], 'XYZ')
    );
    const qWorldStored = new THREE.Quaternion(...b.world_quaternion).normalize();
    assert.ok(Math.abs(qWorldEuler.dot(qWorldStored)) > 0.9999, `${b.name} world Euler/quaternion mismatch`);
  }

  // Verify GLB embedded extras payload & Socket_Grip_Right extras contain full bone positions & rotations
  const glbRotPayload = buildGlbHandBoneRotationsPayload(cfg, m);
  assert.equal(glbRotPayload.mixamo_prefix, 'mixamorig1_');
  assert.equal(glbRotPayload.finger_axis, '+Y');
  assert.equal(glbRotPayload.palmar_axis, '+Z');
  assert.equal(glbRotPayload.rotation_order, 'XYZ');
  assert.equal(Object.keys(glbRotPayload.bones).length, 42);
  assert.equal(glbRotPayload.right_wrist.bone, 'mixamorig1_RightHand');
  assert.equal(glbRotPayload.left_wrist.bone, 'mixamorig1_LeftHand');
  assert.equal(glbRotPayload.right_wrist.world_position.length, 3);
  assert.equal(glbRotPayload.left_wrist.world_position.length, 3);

  const meta = buildGodotWeaponMetadata(cfg, m, [0.064, 0.285, 0.92]);
  const glbExtras = buildGlbEmbeddedExtras(meta, cfg, m);
  assert.equal(glbExtras.weapon_id, 'ak_47_classic');
  assert.equal(Object.keys(glbExtras.hand_bone_rotations.bones).length, 42);
  assert.equal(JSON.stringify(glbExtras).includes('mixamorig:'), false);
  assert.equal(JSON.stringify(glbExtras).includes('HandRig_'), false);
  assert.equal(JSON.stringify(glbExtras).includes('Grip_Left'), false);

  const socketExtras = buildGlbSocketExtrasMap(meta, cfg, m);
  assert.equal(socketExtras.Socket_Grip_Left, undefined);
  assert.equal(Object.keys((socketExtras.Socket_Grip_Right as { bones: Record<string, unknown> }).bones).length, 21);
  assert.ok((socketExtras.Socket_Grip_Right as { wrist_rotation_deg: number[] }).wrist_rotation_deg.length === 3);
  assert.ok((socketExtras.Socket_Grip_Right as { wrist_world_position: number[] }).wrist_world_position.length === 3);
});

test('Godot 4.7.2 .tscn, .gd, and PKZIP pack generators emit valid format=3 scene, typed GDScript, and CRC-verified zip', () => {
  const cfg = getInitialWeaponConfig();
  const m = resolveMechanicalConstraints(cfg);
  const metadata = buildGodotWeaponMetadata(cfg, m, [0.064, 0.285, 0.92]);

  assert.equal(slugifyWeaponName('AK-47 Classic'), 'ak_47_classic');
  assert.equal(toGodotNodeName('AK-47 Classic'), 'AK47Classic');
  assert.equal(toGodotNodeName('47 Rifle'), 'Weapon47Rifle');
  assert.equal(buildGodotBundleFilename('AK-47 Classic', '1k'), 'ak_47_classic_godot_pack_1k.zip');

  const tscn = generateGodotSceneTscn(cfg, m, 'ak_47_classic.glb', 'ak_47_classic.gd', metadata);
  assert.match(tscn, /^\[gd_scene load_steps=8 format=3\]/);
  assert.match(tscn, /path="ak_47_classic\.glb"/);
  assert.match(tscn, /path="ak_47_classic\.gd"/);
  assert.match(tscn, /resource_name = "RESET"/);
  assert.match(tscn, /resource_name = "fire"/);
  assert.match(tscn, /resource_name = "reload"/);
  assert.match(tscn, /resource_name = "fold_stock"/);
  assert.match(tscn, /NodePath\("Model\/Part_Bolt:position"\)/);
  assert.match(tscn, /NodePath\("Model\/Part_Magazine:position"\)/);
  assert.match(tscn, /NodePath\("Model\/Part_Trigger:rotation"\)/);
  assert.match(tscn, /NodePath\("Model\/Part_Stock:rotation"\)/);
  assert.match(tscn, /\[editable path="Model"\]/);

  const gd = generateGodotScriptGd(metadata);
  assert.match(gd, /extends Node3D/);
  assert.match(gd, /@export var weapon_id: String = "ak_47_classic"/);
  assert.match(gd, /var category: String = "assault_rifle"/);
  assert.match(gd, /MIXAMO_PREFIX := "mixamorig1_"/);
  assert.match(gd, /func get_bone_attach_transform\(\) -> Transform3D/);
  assert.match(gd, /static func solve_hand_basis\(/);
  assert.match(gd, /func get_embedded_hand_bone_rotations\(\) -> Dictionary/);
  assert.match(gd, /find_child\("Socket_Shoulder", true, false\)/);
  assert.equal(gd.includes('Socket_Grip_Left'), false);
  assert.equal(gd.includes('socket_grip_left'), false);
  assert.equal(gd.includes('mixamorig:'), false);
  assert.equal(gd.includes('runtime_outward_along_contact_normal'), false);

  // Known IEEE 802.3 CRC-32 test vector: CRC32("123456789") === 0xcbf43926
  const vec = new TextEncoder().encode('123456789');
  assert.equal(computeCrc32(vec), 0xcbf43926);

  const enc = new TextEncoder();
  const zip = buildStoreZip([
    { name: 'ak_47_classic/ak_47_classic.tscn', data: enc.encode(tscn) },
    { name: 'ak_47_classic/ak_47_classic.gd', data: enc.encode(gd) },
  ]);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(dv.getUint32(0, true), 0x04034b50, 'ZIP must start with Local File Header PK\\x03\\x04');
  assert.equal(dv.getUint32(zip.byteLength - 22, true), 0x06054b50, 'ZIP must end with EOCD PK\\x05\\x06');
  assert.equal(dv.getUint16(zip.byteLength - 12, true), 2, 'ZIP EOCD entry count must equal 2');
});

test('resolveMixamoHandRig emits mixamorig1_ axes (+Y distal, +Z palmar), BoneAttachment3D transform, and exact FK across all underbarrels', () => {
  const configs: Array<{
    label: string;
    mutate?: (cfg: ReturnType<typeof getInitialWeaponConfig>) => void;
  }> = [
    { label: 'ak_cradle' },
    {
      label: 'vertical_grip',
      mutate: (c) => {
        c.parts.handguard = 'tactical_mlok';
        c.parts.underbarrel = 'vertical_grip';
      },
    },
    {
      label: 'angled_grip',
      mutate: (c) => {
        c.parts.handguard = 'tactical_mlok';
        c.parts.underbarrel = 'angled_grip';
      },
    },
    {
      label: 'handstop_kit',
      mutate: (c) => {
        c.parts.handguard = 'tactical_mlok';
        c.parts.underbarrel = 'handstop_kit';
      },
    },
    {
      label: 'tactical_light',
      mutate: (c) => {
        c.parts.handguard = 'tactical_mlok';
        c.dimensions.handguardLength = 0.28;
        c.parts.underbarrel = 'tactical_light';
      },
    },
    {
      label: 'tactical_laser',
      mutate: (c) => {
        c.parts.handguard = 'tactical_mlok';
        c.dimensions.handguardLength = 0.28;
        c.parts.underbarrel = 'tactical_laser';
      },
    },
    {
      label: 'bipod',
      mutate: (c) => {
        c.parts.handguard = 'tactical_mlok';
        c.dimensions.handguardLength = 0.28;
        c.parts.underbarrel = 'bipod';
      },
    },
    {
      label: 'grenade_launcher',
      mutate: (c) => {
        c.parts.handguard = 'quad_rail';
        c.parts.underbarrel = 'grenade_launcher';
      },
    },
    {
      label: 'masterkey_shotgun',
      mutate: (c) => {
        c.parts.handguard = 'quad_rail';
        c.parts.underbarrel = 'masterkey_shotgun';
      },
    },
    {
      label: 'compact_shroud_laser_wrap',
      mutate: (c) => {
        c.parts.handguard = 'compact_shroud';
        c.dimensions.handguardLength = 0.11;
        c.parts.underbarrel = 'tactical_laser';
      },
    },
    {
      label: 'bare_barrel',
      mutate: (c) => {
        c.parts.handguard = 'none';
      },
    },
  ];

  for (const entry of configs) {
    const cfg = getInitialWeaponConfig();
    entry.mutate?.(cfg);
    const m = resolveMechanicalConstraints(cfg);
    const rig = resolveMixamoHandRig(cfg, m);

    assert.equal(rig.naming_convention, 'mixamo');
    assert.equal(rig.mixamo_prefix, 'mixamorig1_');
    assert.equal(rig.finger_axis, '+Y');
    assert.equal(rig.bone_longitudinal_axis, '+Y');
    assert.equal(rig.palmar_axis, '+Z');
    assert.equal(rig.bone_attach.attach_bone, 'mixamorig1_RightHand');
    assert.equal((rig as unknown as Record<string, unknown>).total_bones, undefined);
    assert.equal(rig.wrist_mixamo_names.right, 'mixamorig1_RightHand');
    assert.equal(rig.wrist_mixamo_names.left, 'mixamorig1_LeftHand');
    assert.equal(MIXAMO_RIGHT_BONE_NAMES.length, 21);
    assert.equal(MIXAMO_LEFT_BONE_NAMES.length, 21);
    assert.deepEqual(Object.keys(rig.bones).sort(), [...ALL_MIXAMO_HAND_BONE_NAMES].sort());

    for (const boneName of ALL_MIXAMO_HAND_BONE_NAMES) {
      assert.equal(rig.bones[boneName].mixamo_name, `mixamorig1_${boneName}`);
    }

    // Verify Mixamo bilateral axis convention on both wrists
    const rWristX = new THREE.Vector3(...rig.grips.right.hand_x_axis);
    const rIdxToPinky = new THREE.Vector3(...rig.bones.RightHandIndex1.world_position).sub(
      new THREE.Vector3(...rig.bones.RightHandPinky1.world_position)
    );
    assert.ok(rIdxToPinky.dot(rWristX) > 0, `${entry.label}: RightHand +X must point toward thumb/index`);

    const lWristQuat = new THREE.Quaternion(...rig.bones.LeftHand.world_quaternion);
    const lWristX = new THREE.Vector3(1, 0, 0).applyQuaternion(lWristQuat);
    const lPinkyFromIdx = new THREE.Vector3(...rig.bones.LeftHandPinky1.world_position).sub(
      new THREE.Vector3(...rig.bones.LeftHandIndex1.world_position)
    );
    assert.ok(lPinkyFromIdx.dot(lWristX) > 0, `${entry.label}: LeftHand +X must point toward pinky/ulnar`);

    const resolveWorldMat = (boneName: string): THREE.Matrix4 => {
      const b = rig.bones[boneName];
      assert.ok(b, `Missing bone ${boneName}`);
      const localMat = new THREE.Matrix4().compose(
        new THREE.Vector3(...b.position),
        new THREE.Quaternion(...b.quaternion),
        new THREE.Vector3(1, 1, 1)
      );
      if (b.parent === 'mixamorig1_RightForeArm' || b.parent === 'mixamorig1_LeftForeArm') {
        return localMat;
      }
      const parentShort = b.parent.replace(/^mixamorig1_/, '');
      return resolveWorldMat(parentShort).multiply(localMat);
    };

    const attachMat = new THREE.Matrix4().compose(
      new THREE.Vector3(...rig.bone_attach.weapon_offset_position),
      new THREE.Quaternion(...rig.bone_attach.weapon_offset_quaternion),
      new THREE.Vector3(1, 1, 1)
    );

    for (const boneName of ALL_MIXAMO_HAND_BONE_NAMES) {
      const b = rig.bones[boneName];
      for (const n of [
        ...b.position,
        ...b.rotation,
        ...b.rotation_deg,
        ...b.quaternion,
        ...b.world_position,
        ...b.world_rotation,
        ...b.world_rotation_deg,
        ...b.world_quaternion,
        ...b.right_hand_position,
        b.bone_length_m,
      ]) {
        assert.ok(Number.isFinite(n), `${entry.label}.${boneName} has non-finite transform component`);
      }
      const fkMat = resolveWorldMat(boneName);
      const fkPos = new THREE.Vector3().setFromMatrixPosition(fkMat);
      const expected = new THREE.Vector3(...b.world_position);
      assert.ok(
        fkPos.distanceTo(expected) < 0.001,
        `${entry.label}.${boneName} FK position mismatch: ${fkPos.distanceTo(expected)}`
      );
      const rhConverted = expected.clone().applyMatrix4(attachMat);
      assert.ok(
        rhConverted.distanceTo(new THREE.Vector3(...b.right_hand_position)) < 0.001,
        `${entry.label}.${boneName} right_hand_position mismatch`
      );
      const fkQuat = new THREE.Quaternion().setFromRotationMatrix(fkMat).normalize();
      const expectedQuat = new THREE.Quaternion(...b.world_quaternion).normalize();
      assert.ok(
        Math.abs(fkQuat.dot(expectedQuat)) > 0.999,
        `${entry.label}.${boneName} FK rotation mismatch: dot=${fkQuat.dot(expectedQuat)}`
      );
      for (let axisIdx = 0; axisIdx < 3; axisIdx++) {
        const expectedLocalDeg = (b.rotation[axisIdx] * 180) / Math.PI;
        assert.ok(
          Math.abs(b.rotation_deg[axisIdx] - expectedLocalDeg) < 0.05,
          `${entry.label}.${boneName} rotation_deg[${axisIdx}] mismatch`
        );
      }
    }

    for (const side of ['Right', 'Left'] as const) {
      const wristName = `${side}Hand`;
      assert.equal(rig.bones[wristName].phalanx, 0);
      assert.equal(rig.bones[wristName].parent, `mixamorig1_${side}ForeArm`);
      for (const finger of MIXAMO_FINGERS) {
        for (let p = 1; p <= 4; p++) {
          const name = `${wristName}${finger}${p}`;
          const bone = rig.bones[name];
          assert.equal(bone.phalanx, p);
          assert.equal(
            bone.parent,
            p === 1 ? `mixamorig1_${wristName}` : `mixamorig1_${wristName}${finger}${p - 1}`
          );
          if (p >= 2) {
            assert.ok(
              Math.abs(bone.position[0]) < 0.001 && Math.abs(bone.position[2]) < 0.001,
              `${entry.label}.${name} must extend along parent +Y axis, got ${JSON.stringify(bone.position)}`
            );
            assert.ok(
              bone.position[1] >= 0.011 && bone.position[1] <= 0.055,
              `${entry.label}.${name} phalanx length (${bone.position[1]}) out of human range`
            );
          }
        }
      }
    }

    const trigRel = new THREE.Vector3(
      m.triggerPivotPos.x - m.gripPivotPos.x,
      m.triggerPivotPos.y - m.gripPivotPos.y,
      m.triggerPivotPos.z - m.gripPivotPos.z
    );
    const idxTip = new THREE.Vector3(...rig.bones.RightHandIndex4.world_position);
    assert.ok(
      idxTip.distanceTo(trigRel) < 0.025,
      `${entry.label} RightHandIndex4 tip must reach trigger (${idxTip.distanceTo(trigRel).toFixed(4)}m)`
    );
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { cloneWeaponConfig, SLOT_SPECS, STARTER_PRESETS } from '../data/catalog';
import { parseGlbChunks } from '../utils/glbOptimizer';
import {
  buildGlbEmbeddedExtras,
  buildGlbSocketExtrasMap,
  buildGodotWeaponMetadata,
} from '../utils/godotExporter';
import { ALL_MIXAMO_HAND_BONE_NAMES, MIXAMO_FINGERS, resolveMixamoHandRig } from '../utils/handRig';
import { resolveMechanicalConstraints } from '../utils/weaponLogic';
import { buildWeaponSceneGraph, WeaponMaterials } from './geometryBuilders';

function createTestMaterials(): WeaponMaterials {
  const pbr = new THREE.MeshPhysicalMaterial();
  const std = new THREE.MeshStandardMaterial();
  return {
    bySlot: {
      receiver: pbr,
      barrel: pbr,
      handguard: pbr,
      stock: pbr,
      magazine: pbr,
      grip: pbr,
      muzzle: pbr,
      optic: pbr,
      underbarrel: pbr,
    },
    darkSteel: std,
    chromeSteel: std,
    brass: std,
    rubber: std,
    opticLens: std,
    emissiveAmber: std,
    emissiveCyan: std,
    emissiveRed: std,
  };
}

function inspectSolidGeometry(geo: THREE.BufferGeometry): {
  signedVolume: number;
  openEdges: number;
  hasNonFinite: boolean;
  triangleCount: number;
} {
  const pos = geo.attributes.position;
  assert.ok(pos, 'geometry must have position attribute');
  if (!geo.attributes.normal) {
    geo.computeVertexNormals();
  }
  const norm = geo.attributes.normal;
  let hasNonFinite = false;
  for (let i = 0; i < pos.count; i++) {
    if (!Number.isFinite(pos.getX(i)) || !Number.isFinite(pos.getY(i)) || !Number.isFinite(pos.getZ(i))) {
      hasNonFinite = true;
      break;
    }
    if (
      norm &&
      (!Number.isFinite(norm.getX(i)) || !Number.isFinite(norm.getY(i)) || !Number.isFinite(norm.getZ(i)))
    ) {
      hasNonFinite = true;
      break;
    }
  }

  const idx = geo.index;
  const triangleCount = idx ? idx.count / 3 : pos.count / 3;
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let signedVolume = 0;

  const edgeCounts = new Map<string, number>();
  const keyOf = (i: number) =>
    `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const addEdge = (a: string, b: string) => {
    if (a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    edgeCounts.set(k, (edgeCounts.get(k) || 0) + 1);
  };

  for (let t = 0; t < triangleCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    v0.fromBufferAttribute(pos, i0);
    v1.fromBufferAttribute(pos, i1);
    v2.fromBufferAttribute(pos, i2);
    cross.crossVectors(v1, v2);
    signedVolume += v0.dot(cross) / 6;

    const k0 = keyOf(i0);
    const k1 = keyOf(i1);
    const k2 = keyOf(i2);
    if (k0 !== k1 && k1 !== k2 && k2 !== k0) {
      addEdge(k0, k1);
      addEdge(k1, k2);
      addEdge(k2, k0);
    }
  }

  let openEdges = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) openEdges++;
  }
  return { signedVolume, openEdges, hasNonFinite, triangleCount };
}

test('all variants across all 9 slots have outward-facing watertight solid geometry with finite normals', () => {
  const mats = createTestMaterials();
  for (const spec of Object.values(SLOT_SPECS)) {
    for (const variant of spec.variants) {
      const cfg = cloneWeaponConfig(STARTER_PRESETS[0].config);
      (cfg.parts as unknown as Record<string, string>)[spec.id] = variant.id;
      if (spec.id === 'underbarrel') {
        cfg.parts.handguard = 'tactical_mlok';
      }
      if (spec.id === 'handguard') {
        cfg.dimensions.handguardOffset = 0.015;
      }
      const m = resolveMechanicalConstraints(cfg);
      const rig = buildWeaponSceneGraph(cfg, m, mats);
      const grp = rig.slotGroups[spec.id];

      let meshIdx = 0;
      grp.traverse((obj) => {
        if (!(obj as THREE.Mesh).isMesh) return;
        const mesh = obj as THREE.Mesh;
        const geo = mesh.geometry;
        const type = geo.type;
        const isIntentionalSheet =
          type === 'PlaneGeometry' ||
          type === 'CircleGeometry' ||
          (type === 'TorusGeometry' &&
            ((geo as THREE.TorusGeometry).parameters?.arc ?? Math.PI * 2) < Math.PI * 1.99);

        const stats = inspectSolidGeometry(geo);
        assert.equal(
          stats.hasNonFinite,
          false,
          `${spec.id}.${variant.id} mesh#${meshIdx} (${type}) has non-finite vertex or normal`
        );
        if (!isIntentionalSheet) {
          assert.ok(
            stats.signedVolume > 0,
            `${spec.id}.${variant.id} mesh#${meshIdx} (${type}) has inverted winding (vol=${stats.signedVolume})`
          );
          assert.equal(
            stats.openEdges,
            0,
            `${spec.id}.${variant.id} mesh#${meshIdx} (${type}) has ${stats.openEdges} open boundary edges`
          );
        }
        meshIdx++;
      });
    }
  }
});

test('thumbhole_sport remains watertight and outward-facing across extreme slider combinations', () => {
  const mats = createTestMaterials();
  const extremes = [
    { stockLength: 0.14, stockDrop: -0.02, stockButtHeight: 0.75, stockCheekHeight: 0 },
    { stockLength: 0.34, stockDrop: 0.05, stockButtHeight: 1.4, stockCheekHeight: 0.03 },
    { stockLength: 0.18, stockDrop: 0.04, stockButtHeight: 0.8, stockCheekHeight: 0.025 },
  ];

  for (const ext of extremes) {
    const cfg = cloneWeaponConfig(STARTER_PRESETS[0].config);
    cfg.parts.stock = 'thumbhole_sport';
    Object.assign(cfg.dimensions, ext);
    const m = resolveMechanicalConstraints(cfg);
    const rig = buildWeaponSceneGraph(cfg, m, mats);
    rig.slotGroups.stock.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const stats = inspectSolidGeometry((obj as THREE.Mesh).geometry);
      assert.equal(stats.hasNonFinite, false);
      assert.ok(stats.signedVolume > 0, `thumbhole_sport extreme ${JSON.stringify(ext)} inverted`);
      assert.equal(stats.openEdges, 0, `thumbhole_sport extreme ${JSON.stringify(ext)} has open edges`);
    });
  }
});

test('every receiver variant seals its rear stock edge cleanly up to receiverRearZ', () => {
  const mats = createTestMaterials();
  for (const variant of SLOT_SPECS.receiver.variants) {
    const cfg = cloneWeaponConfig(STARTER_PRESETS[0].config);
    cfg.parts.receiver = variant.id as typeof cfg.parts.receiver;
    cfg.parts.stock = 'none';
    const m = resolveMechanicalConstraints(cfg);
    const rig = buildWeaponSceneGraph(cfg, m, mats);
    rig.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(rig.slotGroups.receiver);
    assert.ok(
      box.max.z >= m.receiverRearZ - 0.001,
      `receiver.${variant.id} rear face (${box.max.z.toFixed(4)}) stops short of receiverRearZ (${m.receiverRearZ.toFixed(4)})`
    );
  }
});

test('twin_scifi couples cleanly with every muzzle variant and skeleton_cnc/muzzle bores stay watertight at slider extremes', () => {
  const mats = createTestMaterials();
  for (const muzzle of SLOT_SPECS.muzzle.variants) {
    const cfg = cloneWeaponConfig(STARTER_PRESETS[0].config);
    cfg.parts.barrel = 'twin_scifi';
    cfg.parts.muzzle = muzzle.id as typeof cfg.parts.muzzle;
    const m = resolveMechanicalConstraints(cfg);
    const rig = buildWeaponSceneGraph(cfg, m, mats);
    rig.slotGroups.muzzle.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const geo = (obj as THREE.Mesh).geometry;
      if (geo.type === 'CircleGeometry' || geo.type === 'PlaneGeometry') return;
      const stats = inspectSolidGeometry(geo);
      assert.equal(stats.hasNonFinite, false, `twin_scifi + ${muzzle.id} has non-finite data`);
      assert.ok(stats.signedVolume > 0, `twin_scifi + ${muzzle.id} inverted`);
      assert.equal(stats.openEdges, 0, `twin_scifi + ${muzzle.id} has open edges`);
    });
  }

  for (const ext of [
    { gripLength: 0.085, gripThickness: 0.75 },
    { gripLength: 0.14, gripThickness: 1.35 },
  ]) {
    const cfg = cloneWeaponConfig(STARTER_PRESETS[0].config);
    cfg.parts.grip = 'skeleton_cnc';
    Object.assign(cfg.dimensions, ext);
    const m = resolveMechanicalConstraints(cfg);
    const rig = buildWeaponSceneGraph(cfg, m, mats);
    rig.slotGroups.grip.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const stats = inspectSolidGeometry((obj as THREE.Mesh).geometry);
      assert.equal(stats.hasNonFinite, false);
      assert.ok(stats.signedVolume > 0, `skeleton_cnc extreme ${JSON.stringify(ext)} inverted`);
      assert.equal(stats.openEdges, 0, `skeleton_cnc extreme ${JSON.stringify(ext)} open edges`);
    });
  }
});

test('buildWeaponSceneGraph exposes standardized Godot 4.7.2 empty sockets and animatable Part_* children', () => {
  const mats = createTestMaterials();
  const cfg = cloneWeaponConfig(STARTER_PRESETS[0].config);
  const m = resolveMechanicalConstraints(cfg);
  const rig = buildWeaponSceneGraph(cfg, m, mats);

  assert.equal(rig.root.name, 'WeaponRoot');
  const directNames = new Set(rig.root.children.map((c) => c.name));

  for (const requiredPart of [
    'Part_Receiver',
    'Part_Bolt',
    'Part_Magazine',
    'Part_Trigger',
    'Part_Stock',
    'Part_Selector',
  ]) {
    assert.ok(directNames.has(requiredPart), `Missing direct animatable/body child ${requiredPart}`);
  }

  for (const requiredSocket of [
    'Socket_Muzzle',
    'Socket_Grip_Right',
    'Socket_Shoulder',
    'Socket_ADS',
    'Socket_Eject',
    'Socket_Mag',
    'Socket_Optic',
    'Socket_Underbarrel',
  ]) {
    const node = rig.root.children.find((c) => c.name === requiredSocket);
    assert.ok(node, `Missing empty socket ${requiredSocket}`);
    assert.equal(node.children.length, 0, `${requiredSocket} must be an empty Object3D marker`);
    assert.equal((node as THREE.Mesh).isMesh, undefined, `${requiredSocket} must not be a Mesh`);
  }
  assert.equal(rig.root.getObjectByName('Socket_Grip_Left'), undefined, 'Socket_Grip_Left must be removed');

  // Removing handguard omits Socket_Underbarrel; removing stock omits Socket_Shoulder
  const noHgCfg = cloneWeaponConfig(cfg);
  noHgCfg.parts.handguard = 'none';
  noHgCfg.parts.stock = 'none';
  const noHgRig = buildWeaponSceneGraph(noHgCfg, resolveMechanicalConstraints(noHgCfg), mats);
  assert.equal(noHgRig.socketUnderbarrel, null);
  assert.equal(noHgRig.socketShoulder, null);
  assert.equal(
    noHgRig.root.children.find((c) => c.name === 'Socket_Underbarrel'),
    undefined
  );
  assert.equal(
    noHgRig.root.children.find((c) => c.name === 'Socket_Shoulder'),
    undefined
  );

  // Verify Part_Stock hinge X matches -receiverWidth * 0.48
  assert.ok(
    Math.abs(rig.boneStock.position.x - -cfg.dimensions.receiverWidth * 0.48) < 1e-6,
    'Part_Stock pivot X must match left folding hinge'
  );
});

test('Socket_Grip_Right sits at grip centerline pivot and right palm contact sits flush on exterior pistol grip', () => {
  const mats = createTestMaterials();
  const raycaster = new THREE.Raycaster();

  const assertSurfaceContact = (
    label: string,
    targetGroup: THREE.Group,
    socketPos: THREE.Vector3,
    normal: { x: number; y: number; z: number }
  ) => {
    const nVec = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
    const rayDist = 0.08;
    const rayOrigin = socketPos.clone().addScaledVector(nVec, rayDist);
    raycaster.set(rayOrigin, nVec.clone().negate());
    const hits = raycaster.intersectObject(targetGroup, true);
    assert.ok(hits.length > 0, `${label}: ray along -contact_normal must hit target mesh`);

    const outsideGapMeters = hits[0].distance - rayDist;
    assert.ok(
      outsideGapMeters >= -0.0005 && outsideGapMeters <= 0.007,
      `${label}: surface point must sit flush on/outside exterior surface (-0.5mm..+7mm outside), got ${(outsideGapMeters * 1000).toFixed(2)}mm`
    );
  };

  // All 7 pistol grip variants: Socket_Grip_Right at gripPivotPos (relative [0,0,0]) and palm surface at rightGripSurfaceHalfW
  for (const grip of SLOT_SPECS.grip.variants) {
    const cfg = cloneWeaponConfig(STARTER_PRESETS[0].config);
    cfg.parts.grip = grip.id as typeof cfg.parts.grip;
    const m = resolveMechanicalConstraints(cfg);
    const rig = buildWeaponSceneGraph(cfg, m, mats);
    rig.root.updateMatrixWorld(true);
    assert.ok(rig.socketGripRight.position.distanceTo(new THREE.Vector3(m.gripPivotPos.x, m.gripPivotPos.y, m.gripPivotPos.z)) < 1e-6);
    assertSurfaceContact(
      `grip.${grip.id}`,
      rig.slotGroups.grip,
      new THREE.Vector3(m.rightGripSurfaceHalfW, m.gripPivotPos.y, m.gripPivotPos.z),
      m.socketHandRNormal
    );
  }
});

test('WeaponRoot embeds full Mixamo RightHand & LeftHand bone trees across all 9 underbarrel components without mesh clipping', () => {
  const mats = createTestMaterials();
  const doubleMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const raycaster = new THREE.Raycaster();

  const cases: Array<{ label: string; cfg: ReturnType<typeof cloneWeaponConfig> }> = [
    ...SLOT_SPECS.underbarrel.variants.map((ub) => {
      const c = cloneWeaponConfig(STARTER_PRESETS[1].config);
      c.parts.handguard = 'tactical_mlok';
      c.parts.underbarrel = ub.id as typeof c.parts.underbarrel;
      return { label: `m4_${ub.id}`, cfg: c };
    }),
    {
      label: 'ak_grenade_launcher',
      cfg: (() => {
        const c = cloneWeaponConfig(STARTER_PRESETS[0].config);
        c.parts.underbarrel = 'grenade_launcher';
        return c;
      })(),
    },
    {
      label: 'compact_shroud_light',
      cfg: (() => {
        const c = cloneWeaponConfig(STARTER_PRESETS[1].config);
        c.parts.handguard = 'compact_shroud';
        c.dimensions.handguardLength = 0.11;
        c.parts.underbarrel = 'tactical_light';
        return c;
      })(),
    },
    {
      label: 'compact_shroud_laser',
      cfg: (() => {
        const c = cloneWeaponConfig(STARTER_PRESETS[1].config);
        c.parts.handguard = 'compact_shroud';
        c.dimensions.handguardLength = 0.11;
        c.parts.underbarrel = 'tactical_laser';
        return c;
      })(),
    },
    {
      label: 'compact_shroud_bipod',
      cfg: (() => {
        const c = cloneWeaponConfig(STARTER_PRESETS[1].config);
        c.parts.handguard = 'compact_shroud';
        c.dimensions.handguardLength = 0.11;
        c.parts.underbarrel = 'bipod';
        return c;
      })(),
    },
    {
      label: 'bare_barrel',
      cfg: (() => {
        const c = cloneWeaponConfig(STARTER_PRESETS[1].config);
        c.parts.handguard = 'none';
        return c;
      })(),
    },
  ];

  const buildDoubleSidedProbeGroup = (src: THREE.Group): THREE.Group => {
    const g = new THREE.Group();
    src.updateMatrixWorld(true);
    src.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const clone = new THREE.Mesh(child.geometry, doubleMat);
        clone.applyMatrix4(child.matrixWorld);
        g.add(clone);
      }
    });
    g.updateMatrixWorld(true);
    return g;
  };

  const countMeshParity = (point: THREE.Vector3, probeGroup: THREE.Group): number => {
    let maxHits = 0;
    for (const mesh of probeGroup.children) {
      raycaster.set(point, new THREE.Vector3(1, 0.13, 0.07).normalize());
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length % 2 === 1) {
        maxHits++;
      }
    }
    return maxHits;
  };

  for (const { label, cfg } of cases) {
    const m = resolveMechanicalConstraints(cfg);
    const rig = buildWeaponSceneGraph(cfg, m, mats);
    const spec = resolveMixamoHandRig(cfg, m);
    rig.root.updateMatrixWorld(true);

    // 1. All 42 Mixamo bones exist as THREE.Bone children for live inspector with mixamorig1_ extras
    assert.equal(rig.handBones.size, 42);
    for (const boneName of ALL_MIXAMO_HAND_BONE_NAMES) {
      const bone = rig.root.getObjectByName(boneName) as THREE.Bone | undefined;
      assert.ok(bone && bone.isBone, `${label}: missing THREE.Bone ${boneName}`);
      const expectedParent =
        boneName === 'RightHand'
          ? 'HandRig_Right'
          : boneName === 'LeftHand'
            ? 'HandRig_Left'
            : spec.bones[boneName].parent.replace(/^mixamorig1_/, '');
      assert.equal(bone.parent?.name, expectedParent);
      assert.equal(bone.userData.mixamo_name, `mixamorig1_${boneName}`);
      assert.deepEqual(bone.userData.position, spec.bones[boneName].position);
      assert.deepEqual(bone.userData.world_position, spec.bones[boneName].world_position);
      assert.deepEqual(bone.userData.right_hand_position, spec.bones[boneName].right_hand_position);
      assert.equal(bone.userData.bone_length_m, spec.bones[boneName].bone_length_m);
      assert.deepEqual(bone.userData.rotation, spec.bones[boneName].rotation);
      assert.deepEqual(bone.userData.rotation_deg, spec.bones[boneName].rotation_deg);
      assert.deepEqual(bone.userData.quaternion, spec.bones[boneName].quaternion);
      assert.deepEqual(bone.userData.world_rotation_deg, spec.bones[boneName].world_rotation_deg);

      const worldPos = new THREE.Vector3();
      bone.getWorldPosition(worldPos);
      const rel = new THREE.Vector3(
        worldPos.x - m.gripPivotPos.x,
        worldPos.y - m.gripPivotPos.y,
        worldPos.z - m.gripPivotPos.z
      );
      const expected = new THREE.Vector3(...spec.bones[boneName].world_position);
      assert.ok(
        rel.distanceTo(expected) < 0.001,
        `${label}.${boneName} Three.js world position (${rel.toArray()}) !== spec (${expected.toArray()})`
      );
      const worldQuat = new THREE.Quaternion();
      bone.getWorldQuaternion(worldQuat);
      const expectedWorldQuat = new THREE.Quaternion(...spec.bones[boneName].world_quaternion).normalize();
      assert.ok(
        Math.abs(worldQuat.dot(expectedWorldQuat)) > 0.999,
        `${label}.${boneName} Three.js world quaternion mismatch`
      );
    }

    // 2. Odd-even inside-mesh raycast check: ZERO LeftHand bones may sit inside handguard, underbarrel, or barrel!
    const hgProbe = buildDoubleSidedProbeGroup(rig.slotGroups.handguard);
    const ubProbe = buildDoubleSidedProbeGroup(rig.slotGroups.underbarrel);
    const brlProbe = buildDoubleSidedProbeGroup(rig.slotGroups.barrel);
    const gripProbe = buildDoubleSidedProbeGroup(rig.slotGroups.grip);

    for (const boneName of ALL_MIXAMO_HAND_BONE_NAMES) {
      const bone = rig.handBones.get(boneName)!;
      const bWorld = new THREE.Vector3();
      bone.getWorldPosition(bWorld);
      if (boneName.startsWith('LeftHand')) {
        assert.equal(
          countMeshParity(bWorld, hgProbe),
          0,
          `${label}.${boneName}: joint lies inside handguard mesh`
        );
        assert.equal(
          countMeshParity(bWorld, ubProbe),
          0,
          `${label}.${boneName}: joint lies inside underbarrel mesh`
        );
        assert.equal(
          countMeshParity(bWorld, brlProbe),
          0,
          `${label}.${boneName}: joint lies inside barrel mesh`
        );
      } else {
        assert.equal(
          countMeshParity(bWorld, gripProbe),
          0,
          `${label}.${boneName}: joint lies inside pistol grip mesh`
        );
      }
    }
  }
});

test('exported binary GLB embeds metadata and 42 hand bone rotations in WeaponRoot and Socket_Grip_* extras with zero Bone nodes or disallowed extensions', async () => {
  if (typeof globalThis.FileReader === 'undefined') {
    (globalThis as unknown as { FileReader: unknown }).FileReader = class {
      result: ArrayBuffer | string | null = null;
      onloadend: (() => void) | null = null;
      onerror: ((err: unknown) => void) | null = null;
      readAsArrayBuffer(blob: Blob) {
        blob
          .arrayBuffer()
          .then((buf) => {
            this.result = buf;
            this.onloadend?.();
          })
          .catch((err) => this.onerror?.(err));
      }
      readAsDataURL(blob: Blob) {
        blob
          .arrayBuffer()
          .then((buf) => {
            this.result =
              `data:${blob.type || 'application/octet-stream'};base64,` +
              Buffer.from(buf).toString('base64');
            this.onloadend?.();
          })
          .catch((err) => this.onerror?.(err));
      }
    };
  }

  const phys = new THREE.MeshPhysicalMaterial({ color: '#444444', roughness: 0.5, metalness: 0.5 });
  const std = new THREE.MeshStandardMaterial({ color: '#444444', roughness: 0.5, metalness: 0.5 });
  const mats: WeaponMaterials = {
    bySlot: {
      receiver: phys,
      barrel: phys,
      handguard: phys,
      stock: phys,
      magazine: phys,
      grip: phys,
      muzzle: phys,
      optic: phys,
      underbarrel: phys,
    },
    darkSteel: std,
    chromeSteel: std,
    brass: std,
    rubber: std,
    opticLens: std,
    emissiveAmber: std,
    emissiveCyan: std,
    emissiveRed: std,
  };

  const cfg = cloneWeaponConfig(STARTER_PRESETS[0].config);
  const m = resolveMechanicalConstraints(cfg);
  const rig = buildWeaponSceneGraph(cfg, m, mats);
  const exportRoot = rig.root.clone(true);

  for (const name of ['HandRig_Right', 'HandRig_Left']) {
    const obj = exportRoot.getObjectByName(name);
    if (obj) exportRoot.remove(obj);
  }
  const gripOrigin = m.gripPivotPos;
  for (const child of exportRoot.children) {
    child.position.set(
      Math.round((child.position.x - gripOrigin.x) * 1e5) / 1e5,
      Math.round((child.position.y - gripOrigin.y) * 1e5) / 1e5,
      Math.round((child.position.z - gripOrigin.z) * 1e5) / 1e5
    );
  }
  exportRoot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(exportRoot);
  const size = new THREE.Vector3();
  box.getSize(size);
  const dims: [number, number, number] = [
    Math.round(size.x * 1e4) / 1e4,
    Math.round(size.y * 1e4) / 1e4,
    Math.round(size.z * 1e4) / 1e4,
  ];
  const meta = buildGodotWeaponMetadata(cfg, m, dims);

  exportRoot.traverse((o) => {
    o.userData = {};
  });
  exportRoot.userData = buildGlbEmbeddedExtras(meta, cfg, m);
  const socketExtrasMap = buildGlbSocketExtrasMap(meta, cfg, m);
  for (const [socketName, socketExtras] of Object.entries(socketExtrasMap)) {
    const node = exportRoot.getObjectByName(socketName);
    if (node) node.userData = socketExtras;
  }

  const exporter = new GLTFExporter();
  const glbBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      exportRoot,
      (res) => resolve(res as ArrayBuffer),
      reject,
      { binary: true, trs: true }
    );
  });
  const parsed = parseGlbChunks(glbBuffer);
  const gltf = parsed.json as {
    extensionsUsed?: string[];
    skins?: unknown[];
    cameras?: unknown[];
    animations?: unknown[];
    nodes?: Array<{ name?: string; extras?: Record<string, unknown> }>;
  };

  assert.equal((gltf.skins ?? []).length, 0);
  assert.equal((gltf.cameras ?? []).length, 0);
  assert.equal((gltf.animations ?? []).length, 0);
  for (const ext of gltf.extensionsUsed ?? []) {
    assert.equal(
      ['KHR_materials_clearcoat', 'KHR_materials_sheen', 'KHR_materials_transmission'].includes(ext),
      false,
      `Disallowed GLB extension ${ext}`
    );
  }

  const weaponRootNode = (gltf.nodes ?? []).find((n) => n.name === 'WeaponRoot');
  assert.ok(weaponRootNode?.extras, 'WeaponRoot must carry glTF extras');
  const boneAttach = weaponRootNode.extras.bone_attach as {
    attach_bone: string;
    weapon_offset_position: number[];
    weapon_offset_quaternion: number[];
  };
  assert.equal(boneAttach.attach_bone, 'mixamorig1_RightHand');
  assert.equal(boneAttach.weapon_offset_position.length, 3);
  assert.equal(boneAttach.weapon_offset_quaternion.length, 4);

  const handBoneRotations = weaponRootNode.extras.hand_bone_rotations as {
    mixamo_prefix: string;
    palmar_axis: string;
    rotation_order: string;
    right_wrist: {
      position: number[];
      world_position: number[];
      rotation: number[];
      rotation_deg: number[];
      quaternion: number[];
    };
    left_wrist: {
      position: number[];
      world_position: number[];
      rotation: number[];
      rotation_deg: number[];
      quaternion: number[];
    };
    bones: Record<
      string,
      {
        position: number[];
        world_position: number[];
        right_hand_position: number[];
        bone_length_m: number;
        rotation: number[];
        rotation_deg: number[];
        quaternion: number[];
      }
    >;
  };
  assert.equal(handBoneRotations.mixamo_prefix, 'mixamorig1_');
  assert.equal(handBoneRotations.palmar_axis, '+Z');
  assert.equal(handBoneRotations.rotation_order, 'XYZ');
  assert.equal(Object.keys(handBoneRotations.bones).length, 42);
  assert.equal(handBoneRotations.right_wrist.world_position.length, 3);
  assert.equal(handBoneRotations.left_wrist.world_position.length, 3);
  assert.equal(handBoneRotations.bones.LeftHandMiddle1.right_hand_position.length, 3);

  const gripRNode = (gltf.nodes ?? []).find((n) => n.name === 'Socket_Grip_Right');
  const gripLNode = (gltf.nodes ?? []).find((n) => n.name === 'Socket_Grip_Left');
  const shoulderNode = (gltf.nodes ?? []).find((n) => n.name === 'Socket_Shoulder');
  assert.equal(gripLNode, undefined, 'Socket_Grip_Left must not exist in exported GLB');
  assert.ok(gripRNode?.extras?.wrist_rotation_deg, 'Socket_Grip_Right node must embed wrist rotation');
  assert.ok(gripRNode?.extras?.wrist_world_position, 'Socket_Grip_Right node must embed wrist world position');
  assert.equal(Object.keys((gripRNode.extras.bones as Record<string, unknown>) ?? {}).length, 21);
  assert.ok(shoulderNode?.extras?.position, 'Socket_Shoulder node must embed position in extras');
});


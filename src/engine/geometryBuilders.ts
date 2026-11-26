import * as THREE from 'three';
import { ResolvedMechanics, SlotId, WeaponConfig } from '../types/weapon';
import { MIXAMO_FINGERS, resolveMixamoHandRig } from '../utils/handRig';

export interface WeaponMaterials {
  bySlot: Record<SlotId, THREE.MeshPhysicalMaterial>;
  darkSteel: THREE.MeshStandardMaterial;
  chromeSteel: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  opticLens: THREE.MeshStandardMaterial;
  emissiveAmber: THREE.MeshStandardMaterial;
  emissiveCyan: THREE.MeshStandardMaterial;
  emissiveRed: THREE.MeshStandardMaterial;
}

export interface BuiltWeaponRig {
  root: THREE.Group;
  bodyReceiver: THREE.Group;
  boneBolt: THREE.Group;
  boneTrigger: THREE.Group;
  boneSelector: THREE.Group;
  boneStock: THREE.Group;
  boneMagazine: THREE.Group;
  handRigRight: THREE.Group;
  handRigLeft: THREE.Group;
  handBones: Map<string, THREE.Bone>;
  socketMuzzle: THREE.Object3D;
  socketGripRight: THREE.Object3D;
  socketGripLeft: THREE.Object3D;
  socketAds: THREE.Object3D;
  socketEject: THREE.Object3D;
  socketMag: THREE.Object3D;
  socketOptic: THREE.Object3D;
  socketUnderbarrel: THREE.Object3D | null;
  slotGroups: Record<SlotId, THREE.Group>;
  interactables: THREE.Mesh[];
  triangleCount: number;
  partCount: number;
}

const BEVEL_DEFAULT = {
  bevelEnabled: true,
  bevelThickness: 0.0026,
  bevelSize: 0.0022,
  bevelSegments: 2,
  curveSegments: 7,
};

function tagSlot(obj: THREE.Object3D, slot: SlotId, interactables: THREE.Mesh[]): void {
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const m = child as THREE.Mesh;
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.slot = slot;
      interactables.push(m);
    }
  });
}

function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const hw = w * 0.5;
  const hh = h * 0.5;
  const cr = Math.min(r, hw * 0.45, hh * 0.45);
  const s = new THREE.Shape();
  s.moveTo(-hw + cr, -hh);
  s.lineTo(hw - cr, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + cr);
  s.lineTo(hw, hh - cr);
  s.quadraticCurveTo(hw, hh, hw - cr, hh);
  s.lineTo(-hw + cr, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - cr);
  s.lineTo(-hw, -hh + cr);
  s.quadraticCurveTo(-hw, -hh, -hw + cr, -hh);
  return s;
}

/**
 * Clockwise rounded quadrilateral cutout path for CNC billet lightening pockets.
 */
function roundedSlotHoleCW(
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number,
  slant = 0,
  r = 0.0024
): THREE.Path {
  const w = xMax - xMin;
  const h = yMax - yMin;
  const cr = Math.min(r, w * 0.28, h * 0.28);
  const p = new THREE.Path();
  // Strictly CW: left-bot -> left-top -> right-top -> right-bot
  p.moveTo(xMin, yMin + cr);
  p.lineTo(xMin, yMax + slant - cr);
  p.quadraticCurveTo(xMin, yMax + slant, xMin + cr, yMax + slant);
  p.lineTo(xMax - cr, yMax - slant);
  p.quadraticCurveTo(xMax, yMax - slant, xMax, yMax - slant - cr);
  p.lineTo(xMax, yMin + cr);
  p.quadraticCurveTo(xMax, yMin, xMax - cr, yMin);
  p.lineTo(xMin + cr, yMin);
  p.quadraticCurveTo(xMin, yMin, xMin, yMin + cr);
  return p;
}

/**
 * Projects clean, uniform world-scale UVs onto extruded hard-surface meshes
 * so wood grain, carbon weave, camo, and brushed steel run smoothly along the weapon's length (Z).
 */
function applyBoxUVs(geometry: THREE.BufferGeometry, uvScale = 3.2): void {
  geometry.computeVertexNormals();
  const pos = geometry.attributes.position;
  const norm = geometry.attributes.normal;
  if (!pos || !norm) return;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(norm.getX(i));
    const ay = Math.abs(norm.getY(i));
    const az = Math.abs(norm.getZ(i));

    if (ax >= ay && ax >= az) {
      uvs[i * 2] = z * uvScale;
      uvs[i * 2 + 1] = y * uvScale;
    } else if (ay >= ax && ay >= az) {
      uvs[i * 2] = z * uvScale;
      uvs[i * 2 + 1] = x * uvScale;
    } else {
      uvs[i * 2] = x * uvScale;
      uvs[i * 2 + 1] = y * uvScale;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

function extrudeCenteredZ(
  shape: THREE.Shape,
  depth: number,
  bevelSize = 0.0022,
  bevelThickness = 0.0025
): THREE.ExtrudeGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    ...BEVEL_DEFAULT,
    depth,
    bevelSize,
    bevelThickness,
  });
  geo.translate(0, 0, -depth * 0.5);
  applyBoxUVs(geo);
  return geo;
}

function extrudeProfileX(
  shape: THREE.Shape,
  width: number,
  bevelSize = 0.0022,
  bevelThickness = 0.0024
): THREE.ExtrudeGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    ...BEVEL_DEFAULT,
    depth: width,
    bevelSize,
    bevelThickness,
  });
  geo.translate(0, 0, -width * 0.5);
  geo.rotateY(Math.PI * 0.5);
  applyBoxUVs(geo);
  return geo;
}

function buildLatheAlongZ(
  points: Array<[number, number]>,
  segments = 36,
  uvScale = 3.2
): THREE.LatheGeometry {
  const vecs = points.map(([r, z]) => new THREE.Vector2(Math.max(0, r), z));
  const geo = new THREE.LatheGeometry(vecs, segments);
  geo.rotateX(-Math.PI * 0.5);

  // Project true physical arc-length world-scale UVs so steel brushing, carbon weave & wood grain never stretch
  const uv = geo.attributes.uv;
  if (uv && points.length >= 2) {
    let maxR = 0.008;
    const arcLen: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      maxR = Math.max(maxR, points[i][0], points[i - 1][0]);
      const dr = points[i][0] - points[i - 1][0];
      const dz = points[i][1] - points[i - 1][1];
      arcLen.push(arcLen[i - 1] + Math.hypot(dr, dz));
    }
    const circum = 2 * Math.PI * maxR;
    const pCount = points.length;
    for (let s = 0; s <= segments; s++) {
      const uVal = (s / segments) * circum * uvScale;
      for (let p = 0; p < pCount; p++) {
        const idx = s * pCount + p;
        if (idx < uv.count) {
          // Run U along axial length (Z) and V around circumference so brushed_steel & wood run lengthwise!
          uv.setXY(idx, arcLen[p] * uvScale, uVal);
        }
      }
    }
    uv.needsUpdate = true;
  }

  return geo;
}

/**
 * Machined MIL-STD-1913 Picatinny rail with 45° chamfered dovetail T-slot profile
 * whose top tooth surface sits at local y = 0, extending downward by `baseThickness`.
 */
function buildPicatinnyRailSeated(
  length: number,
  width: number,
  baseThickness: number,
  mat: THREE.Material
): THREE.Group {
  const g = new THREE.Group();
  const baseH = Math.max(0.0045, baseThickness);
  const hw = width * 0.5;
  const neckW = hw * 0.78;

  // Chamfered continuous dovetail spine base
  const spineShape = new THREE.Shape();
  spineShape.moveTo(-hw * 0.92, -0.003 - baseH);
  spineShape.lineTo(hw * 0.92, -0.003 - baseH);
  spineShape.lineTo(neckW, -0.0032);
  spineShape.lineTo(-neckW, -0.0032);
  spineShape.closePath();
  const spineGeo = extrudeCenteredZ(spineShape, length, 0.0005, 0.0005);
  g.add(new THREE.Mesh(spineGeo, mat));

  // Chamfered 45° MIL-STD-1913 recoil cross-lugs
  const lugShape = new THREE.Shape();
  const topW = hw * 1.04;
  const shoulderW = hw * 1.12;
  lugShape.moveTo(-neckW, -0.0036);
  lugShape.lineTo(neckW, -0.0036);
  lugShape.lineTo(shoulderW, -0.0017);
  lugShape.lineTo(topW, 0);
  lugShape.lineTo(-topW, 0);
  lugShape.lineTo(-shoulderW, -0.0017);
  lugShape.closePath();

  const pitch = 0.01;
  const count = Math.max(2, Math.floor(length / pitch));
  const toothGeo = extrudeCenteredZ(lugShape, 0.0052, 0.0004, 0.0004);
  const startZ = -length * 0.5 + pitch * 0.5;
  for (let i = 0; i < count; i++) {
    const tooth = new THREE.Mesh(toothGeo, mat);
    tooth.position.set(0, 0, startZ + i * pitch);
    g.add(tooth);
  }
  return g;
}

/**
 * Low-profile machined Picatinny clamp seated 2.5mm INTO the rail teeth (local y = -0.0025 to +0.008)
 * with cross-bolt thumb nut so optics & underbarrel mounts never show any gap.
 */
function buildRailClampBase(
  length: number,
  mat: THREE.Material,
  boltMat: THREE.Material
): THREE.Group {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(-0.012, -0.0025);
  shape.lineTo(0.012, -0.0025);
  shape.lineTo(0.014, 0.003);
  shape.lineTo(0.011, 0.0085);
  shape.lineTo(-0.011, 0.0085);
  shape.lineTo(-0.014, 0.003);
  shape.closePath();
  const clampGeo = extrudeCenteredZ(shape, length, 0.0009, 0.0009);
  g.add(new THREE.Mesh(clampGeo, mat));

  const boltGeo = new THREE.CylinderGeometry(0.0036, 0.0036, 0.03, 14);
  boltGeo.rotateZ(Math.PI * 0.5);
  const bolt = new THREE.Mesh(boltGeo, boltMat);
  bolt.position.set(0, 0.003, 0);
  g.add(bolt);
  return g;
}

/**
 * True spline-swept curved magazine mesh (lofted cross-section along quadratic Bezier curve).
 */
function buildSweptCurvedMagazine(
  length: number,
  depth: number,
  width: number,
  curveAmount: number,
  ribbed: boolean,
  mat: THREE.Material,
  rubberMat: THREE.Material
): THREE.Group {
  const g = new THREE.Group();
  const steps = 26;
  const ringPts = 20;

  // Authentic stamped/molded magazine cross-section with front/rear welded spine ridges & side stiffening channels
  const profile: Array<[number, number]> = [];
  for (let k = 0; k < ringPts; k++) {
    const a = (k / ringPts) * Math.PI * 2;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    let sx = Math.sign(cx) * Math.pow(Math.abs(cx), 0.56) * (width * 0.5);
    let sz = Math.sign(cz) * Math.pow(Math.abs(cz), 0.52) * (depth * 0.5);
    // Subtle recessed side fluting along flanks (|cx| > 0.7) for stamped steel / PMAG contour
    if (Math.abs(cx) > 0.72 && Math.abs(cz) < 0.55) {
      sx *= 0.94 + 0.05 * Math.cos(cz * Math.PI * 2.5);
    }
    // Pronounced welded rear & front magazine spine ridges
    if (Math.abs(cz) > 0.88 && Math.abs(cx) < 0.35) {
      sz *= 1.045;
    }
    profile.push([sx, sz]);
  }

  const p0 = new THREE.Vector3(0, 0.014, 0);
  const p1 = new THREE.Vector3(0, -length * 0.52, -curveAmount * length * 0.25);
  const p2 = new THREE.Vector3(0, -length, -curveAmount * length * 0.92);
  const curve = new THREE.QuadraticBezierCurve3(p0, p1, p2);

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const uvScale = 3.2;
  const perimApprox = 2 * (width + depth);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const center = curve.getPoint(t);
    const tangent = curve.getTangent(t).normalize();
    const forward = new THREE.Vector3(1, 0, 0).cross(tangent).normalize();
    // Crisp horizontal stamped reinforcement ribs along the lower 75% of ribbed magazines
    const isRib = ribbed && i > 3 && i < steps - 1 && i % 4 === 0;
    const ribPulseX = isRib ? 1.075 : 1.0;
    const ribPulseZ = isRib ? 1.03 : 1.0;

    for (let k = 0; k <= ringPts; k++) {
      const [px, pz] = profile[k % ringPts];
      positions.push(
        center.x + px * ribPulseX,
        center.y + forward.y * (pz * ribPulseZ),
        center.z + forward.z * (pz * ribPulseZ)
      );
      uvs.push(t * length * uvScale, (k / ringPts) * perimApprox * uvScale);
    }
  }

  const stride = ringPts + 1;
  for (let i = 0; i < steps; i++) {
    for (let k = 0; k < ringPts; k++) {
      const a = i * stride + k;
      const b = (i + 1) * stride + k;
      const c = (i + 1) * stride + (k + 1);
      const d = i * stride + (k + 1);
      indices.push(a, b, d, b, c, d);
    }
  }

  // Seal top & bottom magazine end caps for watertight manifold geometry
  const topCenterIdx = positions.length / 3;
  const topCenter = curve.getPoint(0);
  positions.push(topCenter.x, topCenter.y, topCenter.z);
  uvs.push(0.5, 0);
  for (let k = 0; k < ringPts; k++) {
    indices.push(topCenterIdx, k, k + 1);
  }

  const botCenterIdx = positions.length / 3;
  const botCenter = curve.getPoint(1);
  positions.push(botCenter.x, botCenter.y, botCenter.z);
  uvs.push(0.5, 1);
  const botRingStart = steps * stride;
  for (let k = 0; k < ringPts; k++) {
    indices.push(botCenterIdx, botRingStart + k + 1, botRingStart + k);
  }

  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  bodyGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  bodyGeo.setIndex(indices);
  bodyGeo.computeVertexNormals();
  g.add(new THREE.Mesh(bodyGeo, mat));

  // Beveled tactical floorplate with front lip & recessed spring retention button
  const endPt = curve.getPoint(1);
  const endTan = curve.getTangent(1).normalize();
  const plateGroup = new THREE.Group();
  plateGroup.position.copy(endPt);
  plateGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), endTan);

  const plateGeo = extrudeCenteredZ(
    roundedRectShape(width * 1.18, 0.012, 0.0032),
    depth * 1.18,
    0.0016,
    0.0016
  );
  plateGroup.add(new THREE.Mesh(plateGeo, rubberMat));

  const lockTab = new THREE.Mesh(
    extrudeCenteredZ(roundedRectShape(width * 0.52, 0.004, 0.0012), depth * 0.34, 0.0006, 0.0006),
    mat
  );
  lockTab.position.set(0, -0.0068, 0);
  plateGroup.add(lockTab);

  g.add(plateGroup);
  return g;
}

function buildReceiverSlot(
  config: WeaponConfig,
  m: ResolvedMechanics,
  mats: WeaponMaterials,
  interactables: THREE.Mesh[]
): {
  receiverGroup: THREE.Group;
  boltGroup: THREE.Group;
  triggerGroup: THREE.Group;
  selectorGroup: THREE.Group;
} {
  const { dimensions: d, parts } = config;
  const mat = mats.bySlot.receiver;
  const variant = parts.receiver;
  const g = new THREE.Group();
  g.name = 'slot_receiver';

  const midZ = (m.receiverFrontZ + m.receiverRearZ) * 0.5;
  const len = d.receiverLength;
  const h = d.receiverHeight;
  const w = d.receiverWidth;
  const railRise = d.receiverRailHeight;

  // Main extruded beveled lower receiver body
  const lowerH = h * 0.54;
  const lowerGeo = extrudeCenteredZ(roundedRectShape(w, lowerH, 0.0045), len, 0.0022, 0.0024);
  const lower = new THREE.Mesh(lowerGeo, mat);
  lower.position.set(0, m.receiverBottomY + lowerH * 0.5, midZ);
  g.add(lower);

  if (variant === 'ak_stamped' || variant === 'ak12_modern') {
    // Classic sloped ribbed AK dust cover extending flush to rear stock trunnion edge
    const dustShape = new THREE.Shape();
    const halfW = w * 0.46;
    dustShape.moveTo(-halfW, 0);
    dustShape.lineTo(halfW, 0);
    dustShape.quadraticCurveTo(halfW * 0.94, h * 0.44, halfW * 0.56, h * 0.52);
    dustShape.lineTo(-halfW * 0.56, h * 0.52);
    dustShape.quadraticCurveTo(-halfW * 0.94, h * 0.44, -halfW, 0);
    dustShape.closePath();
    const dustLen = len * 0.96;
    const dustGeo = extrudeCenteredZ(dustShape, dustLen, 0.002, 0.002);
    const dust = new THREE.Mesh(dustGeo, mat);
    dust.position.set(0, m.receiverBottomY + lowerH * 0.89, m.receiverRearZ - dustLen * 0.5);
    g.add(dust);

    // Machined stamped receiver rivets on both flanks (metallic detail breaking up flat sides)
    const rivetGeo = new THREE.CylinderGeometry(0.0026, 0.0026, w + 0.003, 10);
    rivetGeo.rotateZ(Math.PI * 0.5);
    for (const [ry, rz] of [
      [0.012, m.receiverFrontZ + 0.016],
      [0.025, m.receiverFrontZ + 0.024],
      [0.012, m.receiverFrontZ + 0.044],
      [0.018, m.receiverRearZ - 0.016],
      [0.028, m.receiverRearZ - 0.028],
    ]) {
      const rivet = new THREE.Mesh(rivetGeo, mats.chromeSteel);
      rivet.position.set(0, m.receiverBottomY + ry, rz);
      g.add(rivet);
    }

    // Authentic stamped AK oval magwell dimples on both receiver flanks
    const dimpleShape = roundedRectShape(0.032, 0.011, 0.005);
    const dimpleGeo = extrudeProfileX(dimpleShape, 0.0032, 0.0008, 0.0008);
    for (const side of [-1, 1]) {
      const dimple = new THREE.Mesh(dimpleGeo, mats.darkSteel);
      dimple.position.set(side * (w * 0.502), m.receiverBottomY + lowerH * 0.42, m.magwellPos.z);
      g.add(dimple);
    }

    // AK rear sight base block + tangent elevation leaf slider
    const sightBlockGeo = extrudeCenteredZ(
      roundedRectShape(w * 0.86, h * 0.48, 0.0032),
      0.038,
      0.0018,
      0.0018
    );
    const sightBlock = new THREE.Mesh(sightBlockGeo, mats.darkSteel);
    sightBlock.position.set(0, m.receiverBottomY + lowerH + h * 0.16, m.receiverFrontZ + 0.019);
    g.add(sightBlock);

    const sightLeaf = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(w * 0.36, 0.006, 0.0014), 0.034, 0.0008, 0.0008),
      mats.chromeSteel
    );
    sightLeaf.position.set(0, m.receiverTopY + 0.0035, m.receiverFrontZ + 0.022);
    sightLeaf.rotation.x = 0.09;
    g.add(sightLeaf);

    if (variant === 'ak_stamped') {
      // Beveled stamped dust-cover transverse stiffening ribs (sculpted, never raw boxes)
      const ribGeo = extrudeCenteredZ(
        roundedRectShape(w * 0.68, 0.0042, 0.0018),
        0.0065,
        0.001,
        0.001
      );
      for (let i = 0; i < 4; i++) {
        const rib = new THREE.Mesh(ribGeo, mat);
        rib.position.set(0, m.receiverTopY - 0.0018, midZ - len * 0.22 + i * 0.036);
        g.add(rib);
      }

      // Left-side chamfered AK dovetail optic rail
      const dovetailShape = new THREE.Shape();
      dovetailShape.moveTo(-0.003, -0.007);
      dovetailShape.lineTo(0.0035, -0.0052);
      dovetailShape.lineTo(0.0035, 0.0052);
      dovetailShape.lineTo(-0.003, 0.007);
      dovetailShape.closePath();
      const dovetail = new THREE.Mesh(extrudeCenteredZ(dovetailShape, 0.1, 0.0008, 0.0008), mats.darkSteel);
      dovetail.position.set(-w * 0.525, m.receiverCenterY, midZ + 0.01);
      g.add(dovetail);

      // Authentic AK side-mount optic bridge bracket whenever an optic is equipped (zero floating!)
      if (m.needsAkSideBridge) {
        const bridgeSpan = Math.min(len * 0.78, 0.175);
        const bridgeZ = m.opticMountPos.z;
        const armH = m.receiverRailTopY - m.receiverCenterY;

        // Side clamp clamping onto dovetail rail
        const sideClamp = new THREE.Mesh(
          extrudeCenteredZ(roundedRectShape(0.011, 0.02, 0.002), 0.072, 0.001, 0.001),
          mats.darkSteel
        );
        sideClamp.position.set(-w * 0.56, m.receiverCenterY, midZ + 0.01);
        g.add(sideClamp);

        // Quick-release throw lever on left clamp
        const lever = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.007, 0.034), mats.chromeSteel);
        lever.position.set(-w * 0.65, m.receiverCenterY - 0.002, midZ + 0.02);
        g.add(lever);

        // Vertical side arm rising up the left flank
        const sideArm = new THREE.Mesh(
          extrudeCenteredZ(roundedRectShape(0.008, armH + 0.006, 0.002), 0.048, 0.001, 0.001),
          mats.darkSteel
        );
        sideArm.position.set(-w * 0.55, m.receiverCenterY + armH * 0.5, (midZ + bridgeZ) * 0.5);
        g.add(sideArm);

        // Horizontal cantilever elbow bridging across to center X=0 under the top rail
        const elbowW = w * 0.58 + 0.012;
        const elbow = new THREE.Mesh(
          new THREE.BoxGeometry(elbowW, 0.007, 0.048),
          mats.darkSteel
        );
        elbow.position.set(-elbowW * 0.5 + 0.008, m.receiverRailTopY - 0.006, (midZ + bridgeZ) * 0.5);
        g.add(elbow);

        // Top Picatinny rail seated directly at receiverRailTopY
        const bridgeRail = buildPicatinnyRailSeated(bridgeSpan, 0.021, 0.0055, mats.darkSteel);
        bridgeRail.position.set(0, m.receiverRailTopY, bridgeZ);
        g.add(bridgeRail);
      }
    } else {
      // AK-12 modern continuous top rail seated flush on dust cover
      const rail = buildPicatinnyRailSeated(len * 0.94, 0.021, 0.006 + railRise, mats.darkSteel);
      rail.position.set(0, m.receiverRailTopY, midZ);
      g.add(rail);
    }
  } else if (variant === 'ar_flattop') {
    const upperShape = new THREE.Shape();
    const hw = w * 0.47;
    upperShape.moveTo(-hw, 0);
    upperShape.lineTo(hw, 0);
    upperShape.lineTo(hw * 0.84, h * 0.48);
    upperShape.lineTo(-hw * 0.84, h * 0.48);
    upperShape.closePath();
    const upperLen = len * 0.99;
    const upperGeo = extrudeCenteredZ(upperShape, upperLen, 0.002, 0.002);
    const upper = new THREE.Mesh(upperGeo, mat);
    upper.position.set(0, m.receiverBottomY + lowerH * 0.88, m.receiverRearZ - upperLen * 0.5);
    g.add(upper);

    // Rear AR-15 T-handle charging latch closing upper rear face cleanly
    const chargeT = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(w * 0.72, 0.009, 0.002), 0.012, 0.001, 0.001),
      mats.darkSteel
    );
    chargeT.position.set(0, m.receiverTopY - 0.012, m.receiverRearZ + 0.002);
    g.add(chargeT);

    // Sculpted forged 3D triangular brass deflector + hinged dust cover + knurled forward assist
    const deflShape = new THREE.Shape();
    deflShape.moveTo(0, -0.008);
    deflShape.lineTo(0.013, -0.005);
    deflShape.lineTo(0.013, 0.005);
    deflShape.lineTo(0, 0.0085);
    deflShape.closePath();
    const defl = new THREE.Mesh(extrudeCenteredZ(deflShape, 0.016, 0.0014, 0.0014), mat);
    defl.position.set(w * 0.45, m.receiverCenterY + 0.007, midZ + 0.025);
    defl.rotation.y = 0.22;
    g.add(defl);

    // Ejection port hinged dust cover flap + hinge pin below port
    const dustFlap = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.0032, 0.014, 0.0012), 0.068, 0.0006, 0.0006),
      mats.darkSteel
    );
    dustFlap.position.set(w * 0.506, m.boltRestPos.y - 0.015, m.boltRestPos.z);
    g.add(dustFlap);

    // Forged cylindrical forward-assist boss + angled chrome thumb plunger
    const assistHousing = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [0.009, 0],
          [0.0086, 0.018],
          [0.0076, 0.022],
          [0, 0.022],
        ],
        20
      ),
      mat
    );
    assistHousing.position.set(w * 0.41, m.receiverCenterY + 0.004, midZ + 0.034);
    assistHousing.rotation.y = 0.38;
    g.add(assistHousing);

    const assistGeo = buildLatheAlongZ(
      [
        [0, 0.014],
        [0.0056, 0.014],
        [0.0056, 0.025],
        [0.0072, 0.027],
        [0.0072, 0.032],
        [0.0058, 0.034],
        [0, 0.034],
      ],
      20
    );
    const assist = new THREE.Mesh(assistGeo, mats.chromeSteel);
    assist.position.set(w * 0.41, m.receiverCenterY + 0.004, midZ + 0.034);
    assist.rotation.y = 0.38;
    g.add(assist);

    // Left-flank forged AR bolt-catch ping-pong paddle & protective fence
    const boltCatch = new THREE.Mesh(
      extrudeProfileX(roundedRectShape(0.012, 0.026, 0.0025), 0.005, 0.001, 0.001),
      mats.darkSteel
    );
    boltCatch.position.set(-w * 0.515, m.receiverCenterY - 0.004, m.magwellPos.z + 0.01);
    g.add(boltCatch);

    // Takedown & pivot steel pins
    const pinGeo = new THREE.CylinderGeometry(0.0038, 0.0038, w + 0.0045, 16);
    pinGeo.rotateZ(Math.PI * 0.5);
    for (const pz of [m.receiverFrontZ + 0.032, m.receiverRearZ - 0.022]) {
      const pin = new THREE.Mesh(pinGeo, mats.chromeSteel);
      pin.position.set(0, m.receiverBottomY + 0.016, pz);
      g.add(pin);
    }

    // Continuous top Picatinny rail seated cleanly down into upper receiver
    const rail = buildPicatinnyRailSeated(len * 0.96, 0.021, 0.008 + railRise, mats.darkSteel);
    rail.position.set(0, m.receiverRailTopY, midZ);
    g.add(rail);
  } else if (variant === 'bullpup') {
    const hullShape = new THREE.Shape();
    const hw = w * 0.52;
    hullShape.moveTo(-hw, 0);
    hullShape.lineTo(hw, 0);
    hullShape.quadraticCurveTo(hw * 1.02, h * 0.45, hw * 0.72, h * 0.52);
    hullShape.lineTo(-hw * 0.72, h * 0.52);
    hullShape.quadraticCurveTo(-hw * 1.02, h * 0.45, -hw, 0);
    hullShape.closePath();
    const hullGeo = extrudeCenteredZ(hullShape, len, 0.0028, 0.0028);
    const hull = new THREE.Mesh(hullGeo, mat);
    hull.position.set(0, m.receiverBottomY + lowerH * 0.88, midZ);
    g.add(hull);

    // Rear tactile cheekrest pad
    const cheekGeo = extrudeCenteredZ(roundedRectShape(w * 0.9, 0.012, 0.005), len * 0.32, 0.002, 0.002);
    const cheek = new THREE.Mesh(cheekGeo, mats.rubber);
    cheek.position.set(0, m.receiverTopY - 0.001, m.receiverRearZ - len * 0.2);
    g.add(cheek);

    // Top Picatinny rail bridge seated cleanly into hull
    const rail = buildPicatinnyRailSeated(len * 0.68, 0.021, 0.008 + railRise, mats.darkSteel);
    rail.position.set(0, m.receiverRailTopY, m.receiverFrontZ + len * 0.36);
    g.add(rail);
  } else if (variant === 'scar_monolithic') {
    // Monolithic extruded aluminum SCAR upper with chamfered shoulders, side vents & Torx hardware
    const scarShape = new THREE.Shape();
    const hw = w * 0.49;
    scarShape.moveTo(-hw, 0);
    scarShape.lineTo(hw, 0);
    scarShape.lineTo(hw * 0.96, h * 0.34);
    scarShape.lineTo(hw * 0.72, h * 0.54);
    scarShape.lineTo(-hw * 0.72, h * 0.54);
    scarShape.lineTo(-hw * 0.96, h * 0.34);
    scarShape.closePath();
    const scarUpper = new THREE.Mesh(extrudeCenteredZ(scarShape, len * 1.02, 0.0022, 0.0022), mat);
    scarUpper.position.set(0, m.receiverBottomY + lowerH * 0.88, midZ - 0.002);
    g.add(scarUpper);

    // Side monolithic charging-handle track + recessed cooling slots + Torx bolts
    for (const side of [-1, 1]) {
      const slotTrack = new THREE.Mesh(
        new THREE.BoxGeometry(0.0035, 0.0085, len * 0.52),
        mats.rubber
      );
      slotTrack.position.set(side * (hw * 0.96), m.receiverCenterY + 0.008, midZ - len * 0.14);
      g.add(slotTrack);

      for (let i = 0; i < 3; i++) {
        const boltHead = new THREE.Mesh(
          new THREE.CylinderGeometry(0.0032, 0.0032, 0.003, 10),
          mats.chromeSteel
        );
        boltHead.rotation.z = Math.PI * 0.5;
        boltHead.position.set(side * (hw * 0.99), m.receiverCenterY - 0.006, m.receiverFrontZ + 0.025 + i * 0.036);
        g.add(boltHead);
      }
    }

    // Continuous top monolithic Picatinny rail seated cleanly at receiverRailTopY
    const rail = buildPicatinnyRailSeated(len * 1.0, 0.021, 0.008 + railRise, mats.darkSteel);
    rail.position.set(0, m.receiverRailTopY, midZ - 0.002);
    g.add(rail);
  } else if (variant === 'smg_mp5') {
    // Classic stamped tubular SMG upper (sealed watertight at both ends flush to rear trunnion) + forward cocking tube
    const tubeR = w * 0.44;
    const upperTube = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [tubeR * 0.92, 0],
          [tubeR, 0.012],
          [tubeR, len * 0.98],
          [tubeR * 0.9, len],
          [0, len],
        ],
        24
      ),
      mat
    );
    upperTube.position.set(0, m.receiverTopY - tubeR * 0.72, m.receiverRearZ + 0.001);
    g.add(upperTube);

    // Forward fluted cocking tube above barrel line (closed watertight) + left folding charging knob
    const cockTube = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [tubeR * 0.56, 0],
          [tubeR * 0.56, len * 0.45],
          [tubeR * 0.48, len * 0.47],
          [0, len * 0.47],
        ],
        20
      ),
      mats.darkSteel
    );
    cockTube.position.set(0, m.receiverTopY - tubeR * 0.16, m.receiverFrontZ + 0.028);
    g.add(cockTube);

    const cockKnob = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.005, 0.022, 12), mats.rubber);
    cockKnob.rotation.z = Math.PI * 0.5;
    cockKnob.position.set(-w * 0.54, m.receiverTopY - tubeR * 0.16, m.receiverFrontZ - 0.036);
    g.add(cockKnob);

    // Rear H&K diopter drum sight base
    const drumBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0095, 0.0105, 0.014, 18),
      mats.darkSteel
    );
    drumBase.position.set(0, m.receiverTopY + 0.004, m.receiverRearZ - 0.032);
    g.add(drumBase);

    // Stamped side stiffening flutes
    for (const side of [-1, 1]) {
      const flute = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.007, len * 0.74), mats.darkSteel);
      flute.position.set(side * (w * 0.5), m.receiverCenterY - 0.002, midZ);
      g.add(flute);
    }

    // Low-profile H&K claw Picatinny optic rail mount bridging cleanly onto tubular upper
    const clawRail = buildPicatinnyRailSeated(len * 0.68, 0.021, 0.009 + railRise, mats.darkSteel);
    clawRail.position.set(0, m.receiverRailTopY, midZ - 0.004);
    g.add(clawRail);
  } else if (variant === 'bolt_chassis') {
    // Precision CNC aluminum bolt-action chassis + watertight cylindrical forged steel action + 20-MOA rail
    const actionR = w * 0.43;
    const actionBody = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [actionR * 0.94, 0],
          [actionR, 0.01],
          [actionR, len * 0.93],
          [actionR * 0.92, len * 0.95],
          [0, len * 0.95],
        ],
        28
      ),
      mats.darkSteel
    );
    actionBody.position.set(0, m.receiverTopY - actionR * 0.74, m.receiverRearZ - 0.002);
    g.add(actionBody);

    // Watertight rear bolt shroud cap (strictly increasing y for outward normals!)
    const shroudCap = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, -0.022],
          [actionR * 0.52, -0.022],
          [actionR * 0.78, -0.016],
          [actionR * 0.78, 0.002],
          [0, 0.002],
        ],
        20
      ),
      mats.chromeSteel
    );
    shroudCap.position.set(0, m.receiverTopY - actionR * 0.74, m.receiverRearZ - 0.004);
    g.add(shroudCap);

    // Side CNC weight-relief chassis pockets + stainless action screws
    for (const side of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const pocket = new THREE.Mesh(
          new THREE.BoxGeometry(0.0032, lowerH * 0.44, len * 0.24),
          mats.darkSteel
        );
        pocket.position.set(side * (w * 0.495), m.receiverBottomY + lowerH * 0.48, midZ - 0.04 + i * 0.072);
        g.add(pocket);
      }
      const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.0034, 0.0034, 0.004, 12), mats.chromeSteel);
      screw.rotation.z = Math.PI * 0.5;
      screw.position.set(side * (w * 0.51), m.receiverBottomY + lowerH * 0.78, midZ);
      g.add(screw);
    }

    // Elevated 20-MOA precision Picatinny rail bridge seated solidly on the cylindrical action
    const rail = buildPicatinnyRailSeated(len * 0.84, 0.021, 0.01 + railRise, mats.darkSteel);
    rail.position.set(0, m.receiverRailTopY, midZ - 0.004);
    g.add(rail);
  } else {
    // scifi_rail: Chamfered armored chassis + machined ribs + recessed energy vents
    const sciShape = new THREE.Shape();
    const hw = w * 0.54;
    sciShape.moveTo(-hw, 0);
    sciShape.lineTo(hw, 0);
    sciShape.lineTo(hw * 0.76, h * 0.52);
    sciShape.lineTo(-hw * 0.76, h * 0.52);
    sciShape.closePath();
    const sciGeo = extrudeCenteredZ(sciShape, len, 0.0024, 0.0024);
    const sciUpper = new THREE.Mesh(sciGeo, mat);
    sciUpper.position.set(0, m.receiverBottomY + lowerH * 0.88, midZ);
    g.add(sciUpper);

    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const ventFrame = new THREE.Mesh(
          new THREE.BoxGeometry(0.004, 0.011, 0.032),
          mats.darkSteel
        );
        ventFrame.position.set(side * (w * 0.5), m.receiverCenterY + 0.006, midZ - 0.045 + i * 0.038);
        g.add(ventFrame);

        const vent = new THREE.Mesh(
          new THREE.BoxGeometry(0.0022, 0.0055, 0.024),
          mats.emissiveCyan
        );
        vent.position.set(side * (w * 0.52), m.receiverCenterY + 0.006, midZ - 0.045 + i * 0.038);
        g.add(vent);
      }
    }

    const rail = buildPicatinnyRailSeated(len * 0.94, 0.022, 0.008 + railRise, mats.darkSteel);
    rail.position.set(0, m.receiverRailTopY, midZ);
    g.add(rail);
  }

  // Transitional Hardware 1: Machined Front Barrel Trunnion Collar (watertight)
  const trunnionGeo = buildLatheAlongZ(
    [
      [0, -0.006],
      [Math.max(w * 0.45, d.handguardBulk * 0.92), -0.006],
      [Math.max(w * 0.48, d.handguardBulk * 0.96), 0.012],
      [Math.max(w * 0.44, d.handguardBulk * 0.9), 0.026],
      [0, 0.026],
    ],
    24
  );
  const trunnion = new THREE.Mesh(trunnionGeo, mats.darkSteel);
  trunnion.position.set(0, m.barrelAxisY, m.receiverFrontZ + 0.01);
  g.add(trunnion);

  // Transitional Hardware 2: Recessed Flared Magwell Collar
  const magCollarGeo = extrudeCenteredZ(
    roundedRectShape(w * 0.96, 0.024, 0.004),
    0.07,
    0.002,
    0.002
  );
  const magCollar = new THREE.Mesh(magCollarGeo, mat);
  magCollar.position.set(0, m.receiverBottomY - 0.004, m.magwellPos.z);
  g.add(magCollar);

  // Transitional Hardware 3: Full-Height Contoured Rear Receiver End-Cap Bulkhead (seals receiver-to-stock edge completely!)
  const rearBulkShape = new THREE.Shape();
  const rhw = w * 0.49;
  const isTubularRear = variant === 'smg_mp5' || variant === 'bolt_chassis';
  const rearTopH = isTubularRear ? h * 0.84 : h * 0.94;
  const rearTopW = variant === 'ar_flattop' || variant === 'scar_monolithic' || variant === 'scifi_rail'
    ? rhw * 0.76
    : rhw * 0.56;
  rearBulkShape.moveTo(-rhw, 0.002);
  rearBulkShape.lineTo(rhw, 0.002);
  rearBulkShape.lineTo(rhw, lowerH * 0.96);
  rearBulkShape.lineTo(rearTopW, rearTopH);
  rearBulkShape.lineTo(-rearTopW, rearTopH);
  rearBulkShape.lineTo(-rhw, lowerH * 0.96);
  rearBulkShape.closePath();
  const rearFlangeGeo = extrudeCenteredZ(rearBulkShape, 0.016, 0.0018, 0.0018);
  const rearFlange = new THREE.Mesh(rearFlangeGeo, mats.darkSteel);
  rearFlange.position.set(0, m.receiverBottomY, m.receiverRearZ - 0.004);
  g.add(rearFlange);

  // Transitional Hardware 4: Trigger Guard Loop
  const guardShape = new THREE.Shape();
  guardShape.moveTo(0.015, 0.004);
  guardShape.lineTo(0.022, -0.026);
  guardShape.quadraticCurveTo(0.022, -0.034, 0.012, -0.034);
  guardShape.lineTo(-0.028, -0.034);
  guardShape.quadraticCurveTo(-0.038, -0.034, -0.038, -0.024);
  guardShape.lineTo(-0.038, 0.004);
  guardShape.lineTo(-0.032, 0.004);
  guardShape.lineTo(-0.032, -0.024);
  guardShape.lineTo(0.014, -0.024);
  guardShape.lineTo(0.01, 0.004);
  guardShape.closePath();
  const guardGeo = extrudeProfileX(guardShape, 0.012, 0.0008, 0.0008);
  const guard = new THREE.Mesh(guardGeo, mats.darkSteel);
  guard.position.set(0, m.receiverBottomY, -0.035);
  g.add(guard);

  // Ejection port recess
  const port = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.016, 0.068), mats.rubber);
  port.position.set(w * 0.49, m.boltRestPos.y, m.boltRestPos.z);
  g.add(port);

  // Animated rig node: Part_Bolt (machined chrome-steel carrier + hooked charging handle or tactical teardrop bolt knob)
  const boltGroup = new THREE.Group();
  boltGroup.name = 'Part_Bolt';
  boltGroup.position.set(m.boltRestPos.x, m.boltRestPos.y, m.boltRestPos.z);
  if (variant === 'bolt_chassis') {
    const boltBody = new THREE.Mesh(
      buildLatheAlongZ([[0, -0.042], [0.0068, -0.042], [0.0068, 0.038], [0, 0.038]], 18),
      mats.chromeSteel
    );
    boltBody.position.set(-0.004, 0, 0);
    boltGroup.add(boltBody);

    const boltStem = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.0036, 0.028, 12), mats.chromeSteel);
    boltStem.rotation.z = Math.PI * 0.36;
    boltStem.position.set(0.014, -0.006, 0.024);
    boltGroup.add(boltStem);

    const boltKnob = new THREE.Mesh(new THREE.SphereGeometry(0.0082, 16, 14), mats.darkSteel);
    boltKnob.scale.set(0.9, 1.15, 0.9);
    boltKnob.position.set(0.026, -0.014, 0.024);
    boltGroup.add(boltKnob);
  } else {
    const carrier = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.0085, 0.0135, 0.002), 0.064, 0.001, 0.001),
      mats.chromeSteel
    );
    boltGroup.add(carrier);
    const handleGeo = new THREE.CylinderGeometry(0.0038, 0.0046, 0.024, 14);
    handleGeo.rotateZ(Math.PI * 0.5);
    const handle = new THREE.Mesh(handleGeo, mats.chromeSteel);
    handle.position.set(0.012, 0, -0.014);
    boltGroup.add(handle);
  }

  // Animated rig node: Part_Trigger (concave finger face oriented forward toward -Z muzzle)
  const triggerGroup = new THREE.Group();
  triggerGroup.name = 'Part_Trigger';
  triggerGroup.position.set(m.triggerPivotPos.x, m.triggerPivotPos.y, m.triggerPivotPos.z);
  const trigShape = new THREE.Shape();
  trigShape.moveTo(0.001, 0.002);
  trigShape.quadraticCurveTo(-0.0045, -0.012, 0.005, -0.024);
  trigShape.lineTo(0.0015, -0.0255);
  trigShape.quadraticCurveTo(-0.0085, -0.012, -0.0035, 0.002);
  trigShape.closePath();
  const trigGeo = extrudeProfileX(trigShape, 0.005, 0.0006, 0.0006);
  triggerGroup.add(new THREE.Mesh(trigGeo, mats.chromeSteel));

  // Animated rig node: Part_Selector (classic AK sheet-metal paddle on AK receivers; compact rotary thumb safety on modern platforms)
  const selectorGroup = new THREE.Group();
  selectorGroup.name = 'Part_Selector';
  selectorGroup.position.set(m.selectorPos.x, m.selectorPos.y, m.selectorPos.z);

  if (variant === 'ak_stamped' || variant === 'ak12_modern') {
    const selPivot = new THREE.Mesh(new THREE.CylinderGeometry(0.0058, 0.0058, 0.0052, 16), mats.darkSteel);
    selPivot.rotation.z = Math.PI * 0.5;
    selPivot.position.set(0.002, 0, 0);
    selectorGroup.add(selPivot);

    const selPaddleShape = new THREE.Shape();
    selPaddleShape.moveTo(0.005, 0.005);
    selPaddleShape.lineTo(-0.052, 0.0045);
    selPaddleShape.quadraticCurveTo(-0.057, 0.003, -0.056, -0.004);
    selPaddleShape.lineTo(-0.044, -0.0075);
    selPaddleShape.lineTo(0.005, -0.0045);
    selPaddleShape.closePath();
    const selArm = new THREE.Mesh(extrudeProfileX(selPaddleShape, 0.0036, 0.0008, 0.0008), mats.darkSteel);
    selArm.position.set(0.0028, 0, 0);
    selectorGroup.add(selArm);

    const selTab = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.0085, 0.0095, 0.002), 0.013, 0.0009, 0.0009),
      mats.chromeSteel
    );
    selTab.position.set(0.0058, -0.0015, -0.048);
    selectorGroup.add(selTab);
  } else {
    // Sleek compact CNC rotary ambidextrous safety selector lever
    const selDrum = new THREE.Mesh(new THREE.CylinderGeometry(0.0064, 0.0068, 0.0054, 18), mats.darkSteel);
    selDrum.rotation.z = Math.PI * 0.5;
    selDrum.position.set(0.0022, 0, 0);
    selectorGroup.add(selDrum);

    const leverShape = new THREE.Shape();
    leverShape.moveTo(0.0045, 0.0036);
    leverShape.lineTo(-0.016, 0.0026);
    leverShape.quadraticCurveTo(-0.019, 0.0012, -0.0185, -0.0024);
    leverShape.lineTo(-0.014, -0.0038);
    leverShape.lineTo(0.0045, -0.0036);
    leverShape.closePath();
    const lever = new THREE.Mesh(extrudeProfileX(leverShape, 0.0044, 0.0008, 0.0008), mats.darkSteel);
    lever.position.set(0.0032, 0, 0);
    selectorGroup.add(lever);

    const indicator = new THREE.Mesh(new THREE.BoxGeometry(0.0016, 0.002, 0.011), mats.chromeSteel);
    indicator.position.set(0.0056, 0, -0.0055);
    selectorGroup.add(indicator);
  }

  tagSlot(g, 'receiver', interactables);
  tagSlot(boltGroup, 'receiver', interactables);
  tagSlot(triggerGroup, 'receiver', interactables);
  tagSlot(selectorGroup, 'receiver', interactables);

  return { receiverGroup: g, boltGroup, triggerGroup, selectorGroup };
}

function buildBarrelSlot(
  config: WeaponConfig,
  m: ResolvedMechanics,
  mats: WeaponMaterials,
  interactables: THREE.Mesh[]
): THREE.Group {
  const { dimensions: d, parts } = config;
  const mat = mats.bySlot.barrel;
  const g = new THREE.Group();
  g.name = 'slot_barrel';
  // Span full distance from barrelStartZ (inside receiver) all the way to barrelEndZ so muzzle seats with zero gap
  const len = Math.max(0.08, Math.abs(m.barrelStartZ - m.barrelEndZ));
  const r = d.barrelThickness;

  if (parts.barrel === 'ak_gastube') {
    const lathe = buildLatheAlongZ(
      [
        [0, 0],
        [r * 1.48, 0],
        [r * 1.48, 0.04],
        [r * 1.12, 0.055],
        [r * 1.0, len * 0.72],
        [r * 0.92, len - 0.012],
        [r * 0.85, len],
        [r * 0.42, len],
        [r * 0.42, len - 0.02],
        [0, len - 0.02],
      ],
      28
    );
    const tube = new THREE.Mesh(lathe, mat);
    tube.position.set(0, m.barrelAxisY, m.barrelStartZ);
    g.add(tube);

    const gasLen = Math.min(len * 0.68, Math.max(0.14, m.effectiveHandguardLength + 0.05));
    const gasTube = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [r * 0.85, 0],
          [r * 0.85, gasLen],
          [r * 0.6, gasLen + 0.008],
          [0, gasLen + 0.008],
        ],
        20
      ),
      mat
    );
    gasTube.position.set(0, m.barrelAxisY + r * 2.15, m.barrelStartZ);
    g.add(gasTube);

    // Authentic 45° swept AK gas block collar bridging barrel to upper gas tube
    const gasBlockShape = new THREE.Shape();
    gasBlockShape.moveTo(-0.014, -r * 1.15);
    gasBlockShape.lineTo(0.013, -r * 1.15);
    gasBlockShape.lineTo(0.013, r * 0.7);
    gasBlockShape.lineTo(0.003, r * 2.85);
    gasBlockShape.lineTo(-0.011, r * 2.85);
    gasBlockShape.lineTo(-0.014, r * 1.0);
    gasBlockShape.closePath();
    const gasBlock = new THREE.Mesh(
      extrudeProfileX(gasBlockShape, r * 2.15, 0.0014, 0.0014),
      mats.darkSteel
    );
    gasBlock.position.set(0, m.barrelAxisY, m.barrelStartZ - gasLen);
    g.add(gasBlock);

    // Under-barrel cleaning rod + retention lug
    const rod = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [0.0024, 0],
          [0.0024, len - 0.036],
          [0.0038, len - 0.033],
          [0.0038, len - 0.028],
          [0, len - 0.028],
        ],
        16
      ),
      mats.chromeSteel
    );
    rod.position.set(0, m.barrelAxisY - r * 1.55, m.barrelStartZ);
    g.add(rod);

    // Tapered sculpted AK front sight tower + windage drum + protective hood
    const fsShape = new THREE.Shape();
    fsShape.moveTo(-0.014, -r * 1.15);
    fsShape.lineTo(0.014, -r * 1.15);
    fsShape.lineTo(0.011, 0.012);
    fsShape.lineTo(0.006, 0.034);
    fsShape.lineTo(-0.007, 0.034);
    fsShape.lineTo(-0.011, 0.012);
    fsShape.closePath();
    const fsBase = new THREE.Mesh(
      extrudeProfileX(fsShape, r * 1.95, 0.0014, 0.0014),
      mats.darkSteel
    );
    fsBase.position.set(0, m.barrelAxisY, m.barrelEndZ + 0.028);
    g.add(fsBase);

    // Transverse cylindrical windage drum housing at top of front sight tower
    const windDrum = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0046, 0.0046, r * 2.5, 16),
      mats.darkSteel
    );
    windDrum.rotation.z = Math.PI * 0.5;
    windDrum.position.set(0, m.barrelAxisY + 0.033, m.barrelEndZ + 0.028);
    g.add(windDrum);

    const hood = new THREE.Mesh(
      new THREE.TorusGeometry(0.0102, 0.0023, 12, 24, Math.PI * 1.6),
      mats.darkSteel
    );
    hood.position.set(0, m.barrelAxisY + 0.042, m.barrelEndZ + 0.028);
    hood.rotation.z = -Math.PI * 0.3;
    g.add(hood);

    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.0013, 0.0016, 0.013, 12), mats.chromeSteel);
    post.position.set(0, m.barrelAxisY + 0.04, m.barrelEndZ + 0.028);
    g.add(post);
  } else if (parts.barrel === 'heavy_sniper') {
    const lathe = buildLatheAlongZ(
      [
        [0, 0],
        [r * 1.88, 0],
        [r * 1.88, 0.068],
        [r * 1.44, 0.092],
        [r * 1.28, len - 0.016],
        [r * 1.15, len],
        [r * 0.45, len],
        [r * 0.45, len - 0.025],
        [0, len - 0.025],
      ],
      40
    );
    const tube = new THREE.Mesh(lathe, mat);
    tube.position.set(0, m.barrelAxisY, m.barrelStartZ);
    g.add(tube);

    // Precision stainless barrel lock-nut collar at breech
    const breechNut = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0.012],
          [r * 1.98, 0.012],
          [r * 2.04, 0.02],
          [r * 2.04, 0.042],
          [r * 1.96, 0.048],
          [0, 0.048],
        ],
        32
      ),
      mats.chromeSteel
    );
    breechNut.position.set(0, m.barrelAxisY, m.barrelStartZ);
    g.add(breechNut);

    // 8 deep CNC-milled precision barrel flutes with rounded ball-mill ends
    const fluteCount = 8;
    const fluteLen = Math.max(0.08, len * 0.58);
    for (let i = 0; i < fluteCount; i++) {
      const a = (i / fluteCount) * Math.PI * 2;
      const flute = new THREE.Mesh(
        new THREE.CapsuleGeometry(r * 0.19, fluteLen, 6, 12),
        mats.chromeSteel
      );
      flute.rotation.x = Math.PI * 0.5;
      flute.position.set(
        Math.cos(a) * r * 1.24,
        m.barrelAxisY + Math.sin(a) * r * 1.24,
        m.barrelStartZ - len * 0.55
      );
      g.add(flute);
    }
  } else if (parts.barrel === 'compact_smg') {
    const lathe = buildLatheAlongZ(
      [
        [0, 0],
        [r * 1.35, 0],
        [r * 1.35, 0.035],
        [r * 1.05, 0.048],
        [r * 1.02, len],
        [r * 0.44, len],
        [r * 0.44, len - 0.02],
        [0, len - 0.02],
      ],
      26
    );
    const tube = new THREE.Mesh(lathe, mat);
    tube.position.set(0, m.barrelAxisY, m.barrelStartZ);
    g.add(tube);

    const collar = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [r * 1.5, 0],
          [r * 1.5, 0.055],
          [r * 1.15, 0.062],
          [0, 0.062],
        ],
        24
      ),
      mats.darkSteel
    );
    collar.position.set(0, m.barrelAxisY, m.barrelEndZ + 0.072);
    g.add(collar);
  } else if (parts.barrel === 'integral_suppressed') {
    const sr = Math.max(r * 1.95, 0.019);
    const lathe = buildLatheAlongZ(
      [
        [0, 0],
        [sr * 0.92, 0],
        [sr, 0.014],
        [sr, len - 0.012],
        [sr * 0.88, len],
        [sr * 0.34, len],
        [sr * 0.34, len - 0.025],
        [0, len - 0.025],
      ],
      32
    );
    const shroud = new THREE.Mesh(lathe, mat);
    shroud.position.set(0, m.barrelAxisY, m.barrelStartZ);
    g.add(shroud);

    const rings = Math.max(3, Math.floor(len / 0.065));
    for (let i = 1; i < rings; i++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(sr * 1.01, 0.0018, 10, 28),
        mats.chromeSteel
      );
      ring.position.set(0, m.barrelAxisY, m.barrelStartZ - i * (len / rings));
      g.add(ring);
    }
  } else if (parts.barrel === 'carbon_wrapped') {
    // Thick match bull-contour carbon-wrapped barrel with stainless steel breech/muzzle collars
    const breechLen = Math.min(0.055, len * 0.2);
    const muzzleCollarStart = Math.max(breechLen + 0.02, len - 0.032);
    const breech = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [r * 1.62, 0],
          [r * 1.62, breechLen],
          [r * 1.48, breechLen + 0.006],
          [0, breechLen + 0.006],
        ],
        28
      ),
      mats.chromeSteel
    );
    breech.position.set(0, m.barrelAxisY, m.barrelStartZ);
    g.add(breech);

    const wrap = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, breechLen + 0.004],
          [r * 1.54, breechLen + 0.004],
          [r * 1.54, muzzleCollarStart],
          [r * 1.38, muzzleCollarStart + 0.005],
          [0, muzzleCollarStart + 0.005],
        ],
        32
      ),
      mat
    );
    wrap.position.set(0, m.barrelAxisY, m.barrelStartZ);
    g.add(wrap);

    const crown = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, muzzleCollarStart],
          [r * 1.44, muzzleCollarStart],
          [r * 1.44, len - 0.008],
          [r * 1.24, len],
          [r * 0.44, len],
          [r * 0.44, len - 0.022],
          [0, len - 0.022],
        ],
        28
      ),
      mats.chromeSteel
    );
    crown.position.set(0, m.barrelAxisY, m.barrelStartZ);
    g.add(crown);
  } else if (parts.barrel === 'finned_lmg') {
    // Heavy LMG barrel with radial machined cooling fins, gas regulator block & quick-change carry handle
    const tube = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [r * 1.72, 0],
          [r * 1.72, 0.055],
          [r * 1.34, 0.075],
          [r * 1.18, len - 0.014],
          [r * 1.05, len],
          [r * 0.44, len],
          [r * 0.44, len - 0.022],
          [0, len - 0.022],
        ],
        28
      ),
      mat
    );
    tube.position.set(0, m.barrelAxisY, m.barrelStartZ);
    g.add(tube);

    // 11 machined radial cooling fins along exposed mid-barrel
    const finStart = Math.max(0.08, m.effectiveHandguardLength * 0.42);
    const finEnd = Math.max(finStart + 0.06, len - 0.055);
    const finCount = 11;
    const finStep = (finEnd - finStart) / Math.max(1, finCount - 1);
    for (let i = 0; i < finCount; i++) {
      const fin = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.62, r * 1.62, 0.0038, 24),
        mats.darkSteel
      );
      fin.rotation.x = Math.PI * 0.5;
      fin.position.set(0, m.barrelAxisY, m.barrelStartZ - finStart - i * finStep);
      g.add(fin);
    }

    // Heavy front gas regulator block + stainless gas plug
    const regZ = m.barrelStartZ - Math.min(len - 0.042, finEnd + 0.018);
    const regBlock = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(r * 2.4, r * 3.8, 0.003), 0.032, 0.0014, 0.0014),
      mats.darkSteel
    );
    regBlock.position.set(0, m.barrelAxisY - r * 0.75, regZ);
    g.add(regBlock);

    const regPlug = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.78, r * 0.78, 0.016, 16),
      mats.chromeSteel
    );
    regPlug.rotation.x = Math.PI * 0.5;
    regPlug.position.set(0, m.barrelAxisY - r * 1.85, regZ - 0.016);
    g.add(regPlug);

    // Side-canted quick-change carry handle strut + ribbed handle grip
    const handleCollar = new THREE.Mesh(
      new THREE.TorusGeometry(r * 1.48, 0.0032, 10, 22),
      mats.darkSteel
    );
    handleCollar.position.set(0, m.barrelAxisY, m.barrelStartZ - Math.min(len * 0.35, 0.14));
    g.add(handleCollar);

    const handleArm = new THREE.Mesh(
      new THREE.BoxGeometry(0.005, 0.032, 0.008),
      mats.chromeSteel
    );
    handleArm.position.set(r * 1.4, m.barrelAxisY + 0.018, m.barrelStartZ - Math.min(len * 0.35, 0.14));
    handleArm.rotation.z = -0.35;
    g.add(handleArm);

    const handleGrip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0062, 0.0062, 0.072, 14),
      mats.rubber
    );
    handleGrip.rotation.x = Math.PI * 0.5;
    handleGrip.position.set(r * 1.95, m.barrelAxisY + 0.032, m.barrelStartZ - Math.min(len * 0.35, 0.14) - 0.034);
    g.add(handleGrip);
  } else {
    // twin_scifi: Dual over-under precision railgun barrels with machined gunmetal induction spine, coil ribs & front manifold
    for (const dy of [-r * 1.15, r * 1.15]) {
      const tube = new THREE.Mesh(
        buildLatheAlongZ(
          [
            [0, 0],
            [r * 0.92, 0],
            [r * 0.88, len],
            [r * 0.4, len],
            [r * 0.4, len - 0.02],
            [0, len - 0.02],
          ],
          24
        ),
        mat
      );
      tube.position.set(0, m.barrelAxisY + dy, m.barrelStartZ);
      g.add(tube);
    }

    // Machined dark gunmetal center accelerator spine bridging both over-under barrels (no blinding white block!)
    const spine = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(r * 0.95, r * 1.15, 0.002), len * 0.96, 0.001, 0.001),
      mats.darkSteel
    );
    spine.position.set(0, m.barrelAxisY, m.barrelStartZ - len * 0.48);
    g.add(spine);

    // Precision chrome-steel magnetic induction ribs & subtle recessed side cooling slits along exposed mid-spine
    const coilStart = Math.max(0.06, m.effectiveHandguardLength * 0.65);
    const coilEnd = Math.max(coilStart + 0.04, len - 0.036);
    const coilCount = 6;
    for (let i = 0; i < coilCount; i++) {
      const zPos = m.barrelStartZ - coilStart - (i / Math.max(1, coilCount - 1)) * (coilEnd - coilStart);
      const rib = new THREE.Mesh(
        new THREE.BoxGeometry(r * 1.24, r * 0.88, 0.0045),
        mats.chromeSteel
      );
      rib.position.set(0, m.barrelAxisY, zPos);
      g.add(rib);
    }

    // Heavy structural over-under barrel alignment clamp yokes (including front muzzle manifold collar)
    for (const frac of [0.35, 0.7, 0.96]) {
      const clamp = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(r * 2.45, r * 4.45, 0.004), 0.016, 0.0012, 0.0012),
        mats.darkSteel
      );
      clamp.position.set(0, m.barrelAxisY, m.barrelStartZ - len * frac);
      g.add(clamp);
    }
  }

  tagSlot(g, 'barrel', interactables);
  return g;
}

function buildHandguardSlot(
  config: WeaponConfig,
  m: ResolvedMechanics,
  mats: WeaponMaterials,
  interactables: THREE.Mesh[]
): THREE.Group {
  const g = new THREE.Group();
  g.name = 'slot_handguard';
  const variant = config.parts.handguard;
  if (variant === 'none' || m.effectiveHandguardLength <= 0.01) {
    return g;
  }

  const len = m.effectiveHandguardLength;
  const bulkW = config.dimensions.handguardBulk;
  const bulkH = bulkW * config.dimensions.handguardHeight;
  const mat = mats.bySlot.handguard;
  const midZ = m.handguardStartZ - len * 0.5;

  // Machined extension collar if user added forward offset (zero floating gap!)
  if (config.dimensions.handguardOffset > 0.002) {
    const extLen = config.dimensions.handguardOffset + 0.012;
    const extSleeve = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [config.dimensions.barrelThickness * 1.4, 0],
          [config.dimensions.barrelThickness * 1.55, extLen],
          [0, extLen],
        ],
        20
      ),
      mats.darkSteel
    );
    extSleeve.position.set(0, m.barrelAxisY, m.receiverFrontZ + 0.005);
    g.add(extSleeve);
  }

  // Front handguard retainer ferrule
  const ferrule = new THREE.Mesh(
    extrudeCenteredZ(roundedRectShape(bulkW * 1.92, bulkH * 2.02, 0.005), 0.014, 0.0014, 0.0014),
    mats.darkSteel
  );
  ferrule.position.set(0, m.barrelAxisY - 0.002, m.handguardEndZ + 0.005);
  g.add(ferrule);

  // Rear barrel-nut coupling ring hugging the receiver trunnion
  const rearRing = new THREE.Mesh(
    extrudeCenteredZ(roundedRectShape(bulkW * 2.0, bulkH * 2.1, 0.005), 0.016, 0.0014, 0.0014),
    mats.darkSteel
  );
  rearRing.position.set(0, m.barrelAxisY - 0.002, m.handguardStartZ - 0.006);
  g.add(rearRing);

  if (variant === 'ak_wood') {
    // Sculpted AK-47 palm-swell lower walnut forend + ergonomic side swell ribs + vented upper gas cover + front sling loop
    const lowerShape = new THREE.Shape();
    lowerShape.moveTo(-bulkW * 0.96, 0.002);
    lowerShape.lineTo(bulkW * 0.96, 0.002);
    lowerShape.quadraticCurveTo(bulkW * 1.22, -bulkH * 0.42, bulkW * 0.7, -bulkH * 1.06);
    lowerShape.lineTo(-bulkW * 0.7, -bulkH * 1.06);
    lowerShape.quadraticCurveTo(-bulkW * 1.22, -bulkH * 0.42, -bulkW * 0.96, 0.002);
    const lowerMesh = new THREE.Mesh(extrudeCenteredZ(lowerShape, len * 0.93, 0.0036, 0.0036), mat);
    lowerMesh.position.set(0, m.barrelAxisY, midZ);
    g.add(lowerMesh);

    // Authentic sculpted horizontal AK palm-swell ridges + recessed finger groove channels on both flanks
    const swellGeo = extrudeProfileX(roundedRectShape(len * 0.62, bulkH * 0.24, bulkH * 0.1), 0.0036, 0.0014, 0.0014);
    for (const side of [-1, 1]) {
      const swell = new THREE.Mesh(swellGeo, mat);
      swell.position.set(side * (bulkW * 1.04), m.barrelAxisY - bulkH * 0.46, midZ);
      g.add(swell);

      // Twin cooling ventilation slits between upper and lower walnut handguards
      for (const zOff of [-len * 0.18, len * 0.16]) {
        const vent = new THREE.Mesh(
          extrudeProfileX(roundedRectShape(len * 0.22, 0.0042, 0.0018), 0.004, 0.0006, 0.0006),
          mats.rubber
        );
        vent.position.set(side * (bulkW * 0.92), m.barrelAxisY + 0.0045, midZ + zOff);
        g.add(vent);
      }
    }

    const upperShape = new THREE.Shape();
    upperShape.moveTo(-bulkW * 0.88, 0.005);
    upperShape.lineTo(bulkW * 0.88, 0.005);
    upperShape.quadraticCurveTo(bulkW * 0.86, bulkH * 1.18, 0, bulkH * 1.28);
    upperShape.quadraticCurveTo(-bulkW * 0.86, bulkH * 1.18, -bulkW * 0.88, 0.005);
    const upperMesh = new THREE.Mesh(extrudeCenteredZ(upperShape, len * 0.84, 0.0032, 0.0032), mat);
    upperMesh.position.set(0, m.barrelAxisY + 0.005, midZ + 0.004);
    g.add(upperMesh);

    // Stamped steel front sling loop on left flank of handguard ferrule
    const slingLoop = new THREE.Mesh(
      new THREE.TorusGeometry(0.0082, 0.0019, 10, 20),
      mats.chromeSteel
    );
    slingLoop.rotation.y = Math.PI * 0.5;
    slingLoop.position.set(-bulkW * 1.04, m.barrelAxisY - 0.004, m.handguardEndZ + 0.005);
    g.add(slingLoop);
  } else if (variant === 'tactical_mlok') {
    const oct = new THREE.Shape();
    const rw = bulkW * 0.98;
    const rh = bulkH * 0.98;
    const cw = rw * 0.56;
    const ch = rh * 0.56;
    oct.moveTo(-cw, -rh);
    oct.lineTo(cw, -rh);
    oct.lineTo(rw, -ch);
    oct.lineTo(rw, ch);
    oct.lineTo(cw, rh);
    oct.lineTo(-cw, rh);
    oct.lineTo(-rw, ch);
    oct.lineTo(-rw, -ch);
    oct.closePath();
    const body = new THREE.Mesh(extrudeCenteredZ(oct, len * 0.95, 0.0022, 0.0022), mat);
    body.position.set(0, m.barrelAxisY, midZ);
    g.add(body);

    const slots = Math.max(2, Math.floor(len / 0.042));
    const slotGeo = extrudeProfileX(roundedRectShape(0.025, 0.0076, 0.0026), 0.0032, 0.0007, 0.0007);
    const diagSlotGeo = extrudeCenteredZ(roundedRectShape(0.0068, 0.0028, 0.001), 0.022, 0.0005, 0.0005);
    for (const side of [-1, 1]) {
      for (let i = 0; i < slots; i++) {
        const zPos = m.handguardStartZ - 0.028 - i * ((len - 0.048) / Math.max(1, slots - 1));
        const vent = new THREE.Mesh(slotGeo, mats.rubber);
        vent.position.set(side * (rw + 0.0008), m.barrelAxisY, zPos);
        g.add(vent);

        // 45° upper diagonal M-LOK cooling slots
        const upperVent = new THREE.Mesh(diagSlotGeo, mats.rubber);
        upperVent.position.set(side * ((rw + cw) * 0.505), m.barrelAxisY + (rh + ch) * 0.505, zPos);
        upperVent.rotation.z = side * -Math.PI * 0.25;
        g.add(upperVent);
      }
      // Anti-rotation barrel-nut clamp cross-bolts at rear base
      for (const bz of [-0.012, -0.028]) {
        const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0028, 0.004, 12), mats.chromeSteel);
        bolt.rotation.z = Math.PI * 0.5;
        bolt.position.set(side * (rw * 0.88), m.barrelAxisY - rh * 0.72, m.handguardStartZ + bz);
        g.add(bolt);
      }
    }

    const topRail = buildPicatinnyRailSeated(len * 0.94, 0.02, 0.005, mats.darkSteel);
    topRail.position.set(0, m.barrelAxisY + rh + 0.004, midZ);
    g.add(topRail);
  } else if (variant === 'quad_rail') {
    const body = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(bulkW * 1.85, bulkH * 1.85, 0.0048), len * 0.94, 0.002, 0.002),
      mat
    );
    body.position.set(0, m.barrelAxisY, midZ);
    g.add(body);

    // Knurled MIL-SPEC delta locking ring at receiver junction
    const deltaRing = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [Math.max(bulkW, bulkH) * 1.18, 0],
          [Math.max(bulkW, bulkH) * 1.18, 0.016],
          [Math.max(bulkW, bulkH) * 1.05, 0.022],
          [0, 0.022],
        ],
        32
      ),
      mats.darkSteel
    );
    deltaRing.position.set(0, m.barrelAxisY, m.handguardStartZ + 0.004);
    g.add(deltaRing);

    // Circular barrel cooling ports along 45° diagonal corners between the 4 Picatinny rails
    const portCount = Math.max(3, Math.floor(len / 0.03));
    const portGeo = new THREE.CylinderGeometry(0.0038, 0.0038, 0.0032, 14);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (let i = 0; i < portCount; i++) {
          const zPos = m.handguardStartZ - 0.028 - i * ((len - 0.052) / Math.max(1, portCount - 1));
          const hole = new THREE.Mesh(portGeo, mats.rubber);
          hole.position.set(sx * bulkW * 0.88, m.barrelAxisY + sy * bulkH * 0.88, zPos);
          hole.rotation.z = sx * sy * -Math.PI * 0.25;
          g.add(hole);
        }
      }
    }

    const offsets: Array<{ pos: [number, number, number]; rotZ: number }> = [
      { pos: [0, m.barrelAxisY + bulkH * 0.96 + 0.004, midZ], rotZ: 0 },
      { pos: [0, m.barrelAxisY - bulkH * 0.96 - 0.004, midZ], rotZ: Math.PI },
      { pos: [bulkW * 0.96 + 0.004, m.barrelAxisY, midZ], rotZ: -Math.PI * 0.5 },
      { pos: [-bulkW * 0.96 - 0.004, m.barrelAxisY, midZ], rotZ: Math.PI * 0.5 },
    ];
    for (const o of offsets) {
      const rail = buildPicatinnyRailSeated(len * 0.92, 0.019, 0.005, mats.darkSteel);
      rail.position.set(o.pos[0], o.pos[1], o.pos[2]);
      rail.rotation.z = o.rotZ;
      g.add(rail);
    }
  } else if (variant === 'compact_shroud') {
    const body = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(bulkW * 1.9, bulkH * 1.98, 0.008), len * 0.94, 0.0026, 0.0026),
      mat
    );
    body.position.set(0, m.barrelAxisY - 0.002, midZ);
    g.add(body);

    const stop = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(bulkW * 1.3, 0.024, 0.004), 0.014, 0.0014, 0.0014),
      mats.rubber
    );
    stop.position.set(0, m.barrelAxisY - bulkH * 1.22, m.handguardEndZ + 0.014);
    g.add(stop);
  } else if (variant === 'keymod_slim') {
    // Ultra-slim competition scalloped octagonal freefloat tube with weight-relief slots & split sight rails
    const rw = bulkW * 0.82;
    const rh = bulkH * 0.88;
    const cw = rw * 0.48;
    const ch = rh * 0.48;
    const oct = new THREE.Shape();
    oct.moveTo(-cw, -rh);
    oct.lineTo(cw, -rh);
    oct.lineTo(rw, -ch);
    oct.lineTo(rw, ch);
    oct.lineTo(cw, rh);
    oct.lineTo(-cw, rh);
    oct.lineTo(-rw, ch);
    oct.lineTo(-rw, -ch);
    oct.closePath();
    const body = new THREE.Mesh(extrudeCenteredZ(oct, len * 0.96, 0.0014, 0.0014), mat);
    body.position.set(0, m.barrelAxisY, midZ);
    g.add(body);

    // KeyMod keyhole slots along sides & 45-degree upper lightening ports
    const slots = Math.max(3, Math.floor(len / 0.032));
    for (const side of [-1, 1]) {
      for (let i = 0; i < slots; i++) {
        const zPos = m.handguardStartZ - 0.024 - i * ((len - 0.044) / Math.max(1, slots - 1));
        const slot = new THREE.Mesh(new THREE.BoxGeometry(0.0026, 0.0052, 0.017), mats.rubber);
        slot.position.set(side * (rw + 0.0008), m.barrelAxisY, zPos);
        g.add(slot);

        const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.0036, 0.0036, 0.0028, 10), mats.rubber);
        dot.rotation.z = Math.PI * 0.5;
        dot.position.set(side * (rw + 0.0008), m.barrelAxisY, zPos + 0.006);
        g.add(dot);
      }
      // Rear clamp tension screws
      const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.004, 10), mats.chromeSteel);
      screw.rotation.z = Math.PI * 0.5;
      screw.position.set(side * (rw * 0.96), m.barrelAxisY - rh * 0.55, m.handguardStartZ - 0.014);
      g.add(screw);
    }

    // Front & rear short Picatinny sight bridges (sleek scalloped middle top!)
    const rearRail = buildPicatinnyRailSeated(Math.min(0.048, len * 0.28), 0.019, 0.0045, mats.darkSteel);
    rearRail.position.set(0, m.barrelAxisY + rh + 0.0035, m.handguardStartZ - Math.min(0.026, len * 0.16));
    g.add(rearRail);

    const frontRail = buildPicatinnyRailSeated(Math.min(0.048, len * 0.28), 0.019, 0.0045, mats.darkSteel);
    frontRail.position.set(0, m.barrelAxisY + rh + 0.0035, m.handguardEndZ + Math.min(0.026, len * 0.16));
    g.add(frontRail);
  } else if (variant === 'heatshield_perforated') {
    // Tubular stamped-steel perforated barrel shroud (watertight capped) with staggered cooling ovals & twin clamp bands
    const rad = Math.max(bulkW, bulkH) * 0.96;
    const shroud = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [rad * 0.94, 0],
          [rad, 0.008],
          [rad, len * 0.94],
          [rad * 0.92, len * 0.96],
          [0, len * 0.96],
        ],
        28
      ),
      mat
    );
    shroud.position.set(0, m.barrelAxisY, m.handguardStartZ - 0.004);
    g.add(shroud);

    // Staggered dark oval cooling perforations around upper & side arcs
    const rows = Math.max(3, Math.floor(len / 0.028));
    const angles = [-Math.PI * 0.65, -Math.PI * 0.3, 0, Math.PI * 0.3, Math.PI * 0.65];
    for (let rIdx = 0; rIdx < rows; rIdx++) {
      const zPos = m.handguardStartZ - 0.024 - rIdx * ((len - 0.048) / Math.max(1, rows - 1));
      for (let aIdx = 0; aIdx < angles.length; aIdx++) {
        const a = angles[aIdx] + (rIdx % 2 === 0 ? 0 : 0.15);
        const hole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.0036, 0.0036, 0.0035, 10),
          mats.rubber
        );
        hole.position.set(Math.sin(a) * rad, m.barrelAxisY + Math.cos(a) * rad, zPos);
        hole.rotation.z = -a;
        g.add(hole);
      }
    }

    // Twin stamped steel clamp bands with chrome tension bolts
    for (const frac of [0.18, 0.82]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(rad * 1.02, 0.0026, 10, 28), mats.darkSteel);
      band.position.set(0, m.barrelAxisY, m.handguardStartZ - len * frac);
      g.add(band);

      const lug = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.009, 0.01), mats.chromeSteel);
      lug.position.set(0, m.barrelAxisY - rad * 1.05, m.handguardStartZ - len * frac);
      g.add(lug);
    }
  } else {
    // scifi_angled: Angular hexagonal sci-fi shroud with dual recessed plasma accent strips
    const shape = new THREE.Shape();
    const w = bulkW * 1.08;
    const h = bulkH * 1.05;
    shape.moveTo(-w * 0.72, -h);
    shape.lineTo(w * 0.72, -h);
    shape.lineTo(w, -h * 0.12);
    shape.lineTo(w * 0.75, h);
    shape.lineTo(-w * 0.75, h);
    shape.lineTo(-w, -h * 0.12);
    shape.closePath();
    const body = new THREE.Mesh(extrudeCenteredZ(shape, len * 0.95, 0.0022, 0.0022), mat);
    body.position.set(0, m.barrelAxisY, midZ);
    g.add(body);

    for (const side of [-1, 1]) {
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(0.0025, 0.004, len * 0.72),
        mats.emissiveCyan
      );
      strip.position.set(side * (w * 0.96), m.barrelAxisY + 0.002, midZ);
      g.add(strip);
    }
  }

  tagSlot(g, 'handguard', interactables);
  return g;
}

/**
 * Reusable high-detail ribbed rubber recoil pad with steel mounting backplate
 * so every shoulder stock has authentic grip texture and clean mechanical transitions.
 */
function buildRibbedRecoilPad(
  width: number,
  height: number,
  thickness: number,
  mats: WeaponMaterials
): THREE.Group {
  const g = new THREE.Group();
  const plateDepth = 0.0045;
  const backplate = new THREE.Mesh(
    extrudeCenteredZ(roundedRectShape(width * 0.98, height * 0.98, 0.0045), plateDepth, 0.001, 0.001),
    mats.darkSteel
  );
  backplate.position.z = plateDepth * 0.5;
  g.add(backplate);

  const rubberDepth = Math.max(0.008, thickness - plateDepth);
  const pad = new THREE.Mesh(
    extrudeCenteredZ(roundedRectShape(width, height, 0.0055), rubberDepth, 0.002, 0.002),
    mats.rubber
  );
  pad.position.z = plateDepth + rubberDepth * 0.5;
  g.add(pad);

  const ribCount = 6;
  const ribSpan = height * 0.76;
  for (let i = 0; i < ribCount; i++) {
    const t = i / (ribCount - 1);
    const rib = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.84, 0.0024, 0.0026),
      mats.darkSteel
    );
    rib.position.set(0, (t - 0.5) * ribSpan, plateDepth + rubberDepth + 0.0014);
    g.add(rib);
  }
  return g;
}

/**
 * Helper to connect two exact 3D points with a solid structural strut (zero floating gaps!).
 */
function buildStrutBetween(
  a: THREE.Vector3,
  b: THREE.Vector3,
  widthX: number,
  thicknessY: number,
  mat: THREE.Material
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const length = Math.max(0.005, dir.length());
  const geo = new THREE.BoxGeometry(widthX, length, thicknessY);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

function buildStockSlot(
  config: WeaponConfig,
  m: ResolvedMechanics,
  mats: WeaponMaterials,
  interactables: THREE.Mesh[]
): THREE.Group {
  const boneStock = new THREE.Group();
  boneStock.name = 'Part_Stock';
  const hingeX = -config.dimensions.receiverWidth * 0.48;
  boneStock.position.set(hingeX, m.stockAttachPos.y, m.stockAttachPos.z);

  const variant = config.parts.stock;
  const rw = config.dimensions.receiverWidth;
  const rh = config.dimensions.receiverHeight;
  const sw = config.dimensions.stockWidth;
  const stockW = rw * sw;

  if (variant === 'none') {
    const capGroup = new THREE.Group();
    capGroup.position.set(-hingeX, 0, 0);
    boneStock.add(capGroup);

    // Machined rear trunnion end-plate + hex cap bolts + recessed QD sling swivel loop
    const endPlate = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(rw * 0.94, rh * 0.68, 0.004), 0.01, 0.0015, 0.0015),
      mats.darkSteel
    );
    endPlate.position.set(0, 0, 0.005);
    capGroup.add(endPlate);

    for (const dy of [-rh * 0.2, rh * 0.2]) {
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.0032, 0.004, 12), mats.chromeSteel);
      bolt.rotation.x = Math.PI * 0.5;
      bolt.position.set(0, dy, 0.011);
      capGroup.add(bolt);
    }

    const qdCup = new THREE.Mesh(new THREE.CylinderGeometry(0.0068, 0.0068, 0.006, 16), mats.darkSteel);
    qdCup.rotation.x = Math.PI * 0.5;
    qdCup.position.set(0, 0, 0.011);
    capGroup.add(qdCup);

    const loop = new THREE.Mesh(new THREE.TorusGeometry(0.0095, 0.0022, 10, 20), mats.chromeSteel);
    loop.position.set(0, 0, 0.019);
    loop.rotation.y = Math.PI * 0.5;
    capGroup.add(loop);

    tagSlot(boneStock, 'stock', interactables);
    return boneStock;
  }

  const inner = new THREE.Group();
  inner.position.set(-hingeX, 0, 0);
  boneStock.add(inner);

  const mat = mats.bySlot.stock;
  const len = config.dimensions.stockLength;
  const drop = config.dimensions.stockDrop;
  const buttScale = config.dimensions.stockButtHeight;
  const cheekRaise = config.dimensions.stockCheekHeight;

  // Shared folding hinge knuckle for folding stock architectures
  if (variant === 'skeleton_folder' || variant === 'scar_boot') {
    const knuckle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0072, 0.0072, rh * 0.68, 16),
      mats.chromeSteel
    );
    knuckle.position.set(-rw * 0.46, 0, 0.004);
    inner.add(knuckle);
  }

  if (variant === 'ak_wood') {
    // 1. Stamped steel front receiver tang ferrule + mounting screws
    const ferrule = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(rw * 0.96, rh * 0.7, 0.004), 0.022, 0.0014, 0.0014),
      mats.darkSteel
    );
    ferrule.position.set(0, 0, 0.01);
    inner.add(ferrule);

    const tangStrip = new THREE.Mesh(new THREE.BoxGeometry(rw * 0.36, 0.004, 0.044), mats.darkSteel);
    tangStrip.position.set(0, rh * 0.33, 0.026);
    inner.add(tangStrip);

    const tangScrew = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.0032, 0.004, 10), mats.chromeSteel);
    tangScrew.position.set(0, rh * 0.35, 0.038);
    inner.add(tangScrew);

    // 2. Sculpted ergonomic wood stock core with graceful wrist neck & curved belly
    const buttTopY = rh * 0.25 - drop;
    const buttBotY = -rh * 1.12 * buttScale - drop;
    const shape = new THREE.Shape();
    shape.moveTo(-0.008, rh * 0.33);
    shape.quadraticCurveTo(-len * 0.16, rh * 0.24 - drop * 0.2, -len * 0.32, rh * 0.26 - drop * 0.42);
    shape.lineTo(-len, buttTopY);
    shape.lineTo(-len, buttBotY);
    shape.quadraticCurveTo(-len * 0.56, buttBotY * 0.58 - rh * 0.08, -len * 0.2, -rh * 0.32 - drop * 0.15);
    shape.lineTo(-0.008, -rh * 0.32);
    shape.closePath();
    inner.add(new THREE.Mesh(extrudeProfileX(shape, stockW * 0.84, 0.0045, 0.0045), mat));

    // 3. Sculpted cheek swell bolsters on both flanks for authentic 3D rounded contour (not a flat plank!)
    const swellShape = new THREE.Shape();
    swellShape.moveTo(-len * 0.26, rh * 0.16 - drop * 0.34);
    swellShape.lineTo(-len * 0.94, buttTopY - 0.008);
    swellShape.lineTo(-len * 0.94, buttBotY + 0.014);
    swellShape.quadraticCurveTo(-len * 0.56, buttBotY * 0.5, -len * 0.26, -rh * 0.22 - drop * 0.2);
    swellShape.closePath();
    inner.add(new THREE.Mesh(extrudeProfileX(swellShape, stockW * 0.98, 0.005, 0.005), mat));

    // 4. Contoured stamped steel buttplate with vertical serrations & cleaning-kit trapdoor
    const buttH = buttTopY - buttBotY;
    const buttMidY = (buttTopY + buttBotY) * 0.5;
    const buttPlate = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(stockW * 1.0, buttH + 0.006, 0.0055), 0.011, 0.0018, 0.0018),
      mats.darkSteel
    );
    buttPlate.position.set(0, buttMidY, len + 0.004);
    inner.add(buttPlate);

    const trapdoor = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.003, 16), mats.chromeSteel);
    trapdoor.rotation.x = Math.PI * 0.5;
    trapdoor.position.set(0, buttMidY + buttH * 0.08, len + 0.0105);
    inner.add(trapdoor);

    // 5. Lower rear steel sling swivel bracket + ring
    const slingBase = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.008, 0.022), mats.darkSteel);
    slingBase.position.set(0, buttBotY + 0.004, len * 0.82);
    inner.add(slingBase);

    const slingRing = new THREE.Mesh(new THREE.TorusGeometry(0.0085, 0.002, 10, 18), mats.chromeSteel);
    slingRing.rotation.y = Math.PI * 0.5;
    slingRing.position.set(0, buttBotY - 0.006, len * 0.82);
    inner.add(slingRing);

    // 6. Optional strapped tactical cheek pad when cheekRaise > 0
    if (cheekRaise > 0.001) {
      const padY = rh * 0.26 - drop * 0.55 + cheekRaise * 0.55;
      const cheek = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(stockW * 1.04, 0.012 + cheekRaise, 0.005), len * 0.44, 0.0022, 0.0022),
        mats.rubber
      );
      cheek.position.set(0, padY, len * 0.58);
      inner.add(cheek);

      for (const zFrac of [0.44, 0.72]) {
        const strap = new THREE.Mesh(
          new THREE.BoxGeometry(stockW * 1.08, buttH * 0.62, 0.008),
          mats.darkSteel
        );
        strap.position.set(0, padY - buttH * 0.28, len * zFrac);
        inner.add(strap);
      }
    }
  } else if (variant === 'tactical_carbine') {
    // SOPMOD / Crane Carbine Stock: Watertight outward-winding castle nut + 6-pos buffer tube + battery pods + latch + ribbed pad
    const tubeY = rh * 0.14;
    const endPlate = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(rw * 0.96, rh * 0.72, 0.004), 0.01, 0.0012, 0.0012),
      mats.darkSteel
    );
    endPlate.position.set(0, 0, 0.004);
    inner.add(endPlate);

    // Notched castle nut (strictly increasing y for outward-facing normals!)
    const castleNut = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, -0.019],
          [0.0168, -0.019],
          [0.0185, -0.016],
          [0.0185, -0.004],
          [0.0175, 0],
          [0, 0],
        ],
        22
      ),
      mats.chromeSteel
    );
    castleNut.position.set(0, tubeY, 0.006);
    inner.add(castleNut);

    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const notch = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.004, 0.006), mats.darkSteel);
      notch.position.set(Math.cos(a) * 0.0185, tubeY + Math.sin(a) * 0.0185, 0.016);
      inner.add(notch);
    }

    // 6-Position MIL-SPEC buffer tube (strictly increasing y + closed caps!) + lower locking rail
    const bufLen = Math.max(0.11, len * 0.88);
    const buffer = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, -bufLen],
          [0.0145, -bufLen],
          [0.0145, 0],
          [0, 0],
        ],
        26
      ),
      mats.darkSteel
    );
    buffer.position.set(0, tubeY, 0.012);
    inner.add(buffer);

    const lockTrack = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.007, bufLen * 0.92), mats.darkSteel);
    lockTrack.position.set(0, tubeY - 0.016, 0.012 + bufLen * 0.48);
    inner.add(lockTrack);

    // Sculpted SOPMOD main housing wrapping rear 70% of buffer tube
    const bodyStart = len * 0.28;
    const buttTopY = rh * 0.34 - drop * 0.3;
    const buttBotY = -rh * 0.98 * buttScale - drop * 0.48;
    const bodyShape = new THREE.Shape();
    bodyShape.moveTo(-bodyStart, rh * 0.36);
    bodyShape.lineTo(-len, buttTopY);
    bodyShape.lineTo(-len, buttBotY);
    bodyShape.lineTo(-len * 0.68, buttBotY * 0.92);
    bodyShape.quadraticCurveTo(-len * 0.44, -rh * 0.45 - drop * 0.2, -bodyStart, -rh * 0.14);
    bodyShape.closePath();
    inner.add(new THREE.Mesh(extrudeProfileX(bodyShape, stockW * 0.84, 0.0032, 0.0032), mat));

    // Iconic SOPMOD angled twin side battery storage pods (strictly increasing y + closed caps!) + rubber rear end-caps
    const podLen = len * 0.64;
    for (const side of [-1, 1]) {
      const pod = new THREE.Mesh(
        buildLatheAlongZ(
          [
            [0, -podLen],
            [0.012 * sw, -podLen],
            [0.0132 * sw, -podLen + 0.01],
            [0.0122 * sw, -0.014],
            [0.0085 * sw, 0],
            [0, 0],
          ],
          20
        ),
        mat
      );
      pod.position.set(side * (stockW * 0.38), rh * 0.12 - drop * 0.16, bodyStart + 0.012);
      inner.add(pod);

      const podCap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0112 * sw, 0.0112 * sw, 0.008, 16),
        mats.rubber
      );
      podCap.rotation.x = Math.PI * 0.5;
      podCap.position.set(side * (stockW * 0.38), rh * 0.12 - drop * 0.16, bodyStart + podLen + 0.012);
      inner.add(podCap);
    }

    // Recessed spring-loaded adjustment latch lever + stainless pivot pin
    const latch = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(stockW * 0.44, 0.012, 0.003), len * 0.28, 0.0012, 0.0012),
      mats.darkSteel
    );
    latch.position.set(0, -rh * 0.42 * buttScale - drop * 0.28, len * 0.56);
    latch.rotation.x = 0.24;
    inner.add(latch);

    const latchPin = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, stockW * 0.94, 12), mats.chromeSteel);
    latchPin.rotation.z = Math.PI * 0.5;
    latchPin.position.set(0, -rh * 0.34 * buttScale - drop * 0.24, len * 0.5);
    inner.add(latchPin);

    // Side QD sling swivel cup
    for (const side of [-1, 1]) {
      const qd = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, 0.0062, 0.004, 16), mats.chromeSteel);
      qd.rotation.z = Math.PI * 0.5;
      qd.position.set(side * (stockW * 0.46), -rh * 0.24 - drop * 0.32, len * 0.84);
      inner.add(qd);
    }

    // Optional snap-on cheek riser
    if (cheekRaise > 0.001) {
      const riser = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(stockW * 1.12, 0.01 + cheekRaise, 0.005), len * 0.44, 0.002, 0.002),
        mats.rubber
      );
      riser.position.set(0, rh * 0.36 + cheekRaise * 0.5 - drop * 0.2, len * 0.64);
      inner.add(riser);
    }

    // Thick ribbed rubber recoil pad
    const buttH = buttTopY - buttBotY;
    const pad = buildRibbedRecoilPad(stockW * 1.02, buttH + 0.004, 0.017, mats);
    pad.position.set(0, (buttTopY + buttBotY) * 0.5, len);
    inner.add(pad);
  } else if (variant === 'skeleton_folder') {
    // Heavy AKS-74 / Galil Tubular Folding Stock — mathematically connected struts, zero floating gaps!
    const hingeBlock = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(rw * 0.94, rh * 0.72, 0.004), 0.024, 0.0016, 0.0016),
      mats.darkSteel
    );
    hingeBlock.position.set(0, 0, 0.012);
    inner.add(hingeBlock);

    const releaseBtn = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.014, 0.014), mats.chromeSteel);
    releaseBtn.position.set(rw * 0.48, 0, 0.012);
    inner.add(releaseBtn);

    const buttTopY = rh * 0.22 - drop * 0.55;
    const buttBotY = -rh * 1.05 * buttScale - drop * 0.82;
    const buttMidY = (buttTopY + buttBotY) * 0.5;
    const buttH = buttTopY - buttBotY;

    const topStart = new THREE.Vector3(0, rh * 0.22, 0.018);
    const topEnd = new THREE.Vector3(0, buttTopY - 0.009, len - 0.004);
    const botStart = new THREE.Vector3(0, -rh * 0.22, 0.018);
    const botEnd = new THREE.Vector3(0, buttBotY + 0.01, len - 0.004);

    // Chamfered steel upper & lower struts + contrasting stamped side channel ribs
    const strutW = Math.max(0.011, stockW * 0.38);
    inner.add(buildStrutBetween(topStart, topEnd, strutW, 0.015, mat));
    inner.add(buildStrutBetween(botStart, botEnd, strutW * 0.92, 0.013, mat));

    // Mid-span diagonal reinforcement gusset + vertical rear brace
    const midTop = new THREE.Vector3().lerpVectors(topStart, topEnd, 0.56);
    const midBot = new THREE.Vector3().lerpVectors(botStart, botEnd, 0.42);
    inner.add(buildStrutBetween(midTop, midBot, strutW * 0.78, 0.009, mats.darkSteel));

    const rearTop = new THREE.Vector3(0, buttTopY - 0.01, len - 0.01);
    const rearBot = new THREE.Vector3(0, buttBotY + 0.01, len - 0.01);
    inner.add(buildStrutBetween(rearTop, rearBot, stockW * 0.72, 0.014, mat));

    // Integrated steel sling loop at rear lower junction
    const slingLoop = new THREE.Mesh(new THREE.TorusGeometry(0.008, 0.002, 10, 18), mats.chromeSteel);
    slingLoop.position.set(-stockW * 0.36, buttBotY + 0.024, len - 0.026);
    inner.add(slingLoop);

    // Optional clamped cheek sleeve on top bar
    if (cheekRaise > 0.001) {
      const sleeveCenter = new THREE.Vector3().lerpVectors(topStart, topEnd, 0.54);
      const cheek = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(stockW * 0.88, 0.014 + cheekRaise, 0.005), len * 0.42, 0.002, 0.002),
        mats.rubber
      );
      cheek.position.set(0, sleeveCenter.y + 0.008 + cheekRaise * 0.5, sleeveCenter.z);
      inner.add(cheek);
    }

    // Heavy ribbed rubber recoil pad
    const pad = buildRibbedRecoilPad(stockW * 0.9, buttH + 0.004, 0.015, mats);
    pad.position.set(0, buttMidY, len - 0.002);
    inner.add(pad);
  } else if (variant === 'precision_sniper') {
    // PRS / MPA Precision Match Chassis Stock: Open machined truss + twin guide rods + elevation/LOP dials + monopod rail
    const adapter = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(rw * 0.96, rh * 0.72, 0.004), 0.026, 0.0016, 0.0016),
      mats.darkSteel
    );
    adapter.position.set(0, 0, 0.012);
    inner.add(adapter);

    const chassisEndZ = len - 0.032;
    const topY = rh * 0.3 - drop * 0.22;
    const botY = -rh * 1.12 * buttScale - drop * 0.44;
    const midY = (topY + botY) * 0.5;
    const buttH = topY - botY;

    // Upper main CNC beam
    const upperBeam = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(stockW * 0.88, rh * 0.42, 0.004), chassisEndZ, 0.002, 0.002),
      mat
    );
    upperBeam.position.set(0, topY - rh * 0.14, chassisEndZ * 0.5 + 0.008);
    inner.add(upperBeam);

    // Angled front truss strut + horizontal lower bag-rider beam + rear housing column (true open truss window!)
    const fStart = new THREE.Vector3(0, -rh * 0.18, 0.02);
    const fEnd = new THREE.Vector3(0, botY + 0.014, chassisEndZ * 0.36);
    inner.add(buildStrutBetween(fStart, fEnd, stockW * 0.78, 0.016, mat));

    const lowerRider = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(stockW * 0.82, 0.018, 0.003), chassisEndZ * 0.66, 0.0016, 0.0016),
      mat
    );
    lowerRider.position.set(0, botY + 0.012, chassisEndZ * 0.67);
    inner.add(lowerRider);

    const rearCol = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(stockW * 0.9, buttH, 0.004), 0.032, 0.0018, 0.0018),
      mat
    );
    rearCol.position.set(0, midY, chassisEndZ - 0.008);
    inner.add(rearCol);

    // Underside Picatinny monopod rail
    const monoRail = buildPicatinnyRailSeated(Math.min(0.068, chassisEndZ * 0.42), 0.019, 0.005, mats.darkSteel);
    monoRail.rotation.z = Math.PI;
    monoRail.position.set(0, botY - 0.001, chassisEndZ * 0.72);
    inner.add(monoRail);

    // Adjustable rubberized cheek saddle riding on twin chrome steel guide posts + knurled dial wheel
    const saddleY = topY + 0.018 + cheekRaise;
    const saddle = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(stockW * 1.06, 0.016, 0.006), len * 0.42, 0.0022, 0.0022),
      mats.rubber
    );
    saddle.position.set(0, saddleY, len * 0.48);
    inner.add(saddle);

    const postH = 0.024 + cheekRaise;
    for (const zFrac of [0.36, 0.6]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0042, postH, 14), mats.chromeSteel);
      post.position.set(0, saddleY - postH * 0.5, len * zFrac);
      inner.add(post);
    }

    const cheekDial = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0125, 0.0125, stockW * 0.58, 20),
      mats.chromeSteel
    );
    cheekDial.rotation.z = Math.PI * 0.5;
    cheekDial.position.set(0, topY - rh * 0.42, len * 0.48);
    inner.add(cheekDial);

    // Rear LOP adjustment thumbwheel + twin horizontal chrome guide rods bridging to recoil pad
    const lopDial = new THREE.Mesh(
      new THREE.CylinderGeometry(0.013, 0.013, stockW * 0.62, 20),
      mats.chromeSteel
    );
    lopDial.rotation.z = Math.PI * 0.5;
    lopDial.position.set(0, midY, chassisEndZ - 0.008);
    inner.add(lopDial);

    for (const dy of [-buttH * 0.28, buttH * 0.28]) {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0042, 0.036, 14), mats.chromeSteel);
      rod.rotation.x = Math.PI * 0.5;
      rod.position.set(0, midY + dy, chassisEndZ + 0.014);
      inner.add(rod);
    }

    // Heavy match ribbed rubber recoil pad
    const pad = buildRibbedRecoilPad(stockW * 1.04, buttH + 0.006, 0.019, mats);
    pad.position.set(0, midY, len - 0.002);
    inner.add(pad);
  } else if (variant === 'scar_boot') {
    // SCAR-L/H Telescoping Side-Folding "Boot" Stock
    const hingeBlock = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(rw * 0.98, rh * 0.76, 0.004), 0.026, 0.0018, 0.0018),
      mats.darkSteel
    );
    hingeBlock.position.set(0, 0, 0.012);
    inner.add(hingeBlock);

    // Telescoping upper guide beam with machined detent slots
    const beamLen = len * 0.62;
    const beam = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(stockW * 0.72, rh * 0.44, 0.003), beamLen, 0.0018, 0.0018),
      mats.darkSteel
    );
    beam.position.set(0, rh * 0.08 - drop * 0.14, 0.02 + beamLen * 0.5);
    inner.add(beam);

    // Iconic angular stepped SCAR "boot" lower body
    const bootTopY = rh * 0.26 - drop * 0.24;
    const bootBotY = -rh * 1.16 * buttScale - drop * 0.45;
    const bootShape = new THREE.Shape();
    bootShape.moveTo(-len * 0.22, rh * 0.28 - drop * 0.1);
    bootShape.lineTo(-len, bootTopY);
    bootShape.lineTo(-len, bootBotY);
    bootShape.lineTo(-len * 0.68, bootBotY);
    bootShape.lineTo(-len * 0.56, bootBotY * 0.65);
    bootShape.lineTo(-len * 0.24, -rh * 0.26 - drop * 0.1);
    bootShape.closePath();
    inner.add(new THREE.Mesh(extrudeProfileX(bootShape, stockW * 0.92, 0.0032, 0.0032), mat));

    // Elevation-adjustable angular SCAR cheek rest piece
    const cheekShape = new THREE.Shape();
    cheekShape.moveTo(-len * 0.24, rh * 0.26 + cheekRaise - drop * 0.12);
    cheekShape.lineTo(-len * 0.84, rh * 0.34 + cheekRaise - drop * 0.22);
    cheekShape.lineTo(-len * 0.84, rh * 0.14 + cheekRaise - drop * 0.22);
    cheekShape.lineTo(-len * 0.24, rh * 0.12 + cheekRaise - drop * 0.12);
    cheekShape.closePath();
    inner.add(new THREE.Mesh(extrudeProfileX(cheekShape, stockW * 1.0, 0.003, 0.003), mat));

    // Side sling pass-through cutout & button latch
    for (const side of [-1, 1]) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.024, 0.01), mats.rubber);
      slot.position.set(side * (stockW * 0.47), -rh * 0.34 - drop * 0.3, len * 0.86);
      inner.add(slot);
    }

    const lockButton = new THREE.Mesh(new THREE.CylinderGeometry(0.0065, 0.0065, stockW * 0.98, 16), mats.chromeSteel);
    lockButton.rotation.z = Math.PI * 0.5;
    lockButton.position.set(0, -rh * 0.14 - drop * 0.18, len * 0.38);
    inner.add(lockButton);

    const buttH = bootTopY - bootBotY;
    const pad = buildRibbedRecoilPad(stockW * 0.98, buttH + 0.004, 0.017, mats);
    pad.position.set(0, (bootTopY + bootBotY) * 0.5, len);
    inner.add(pad);
  } else if (variant === 'pdw_wire') {
    // Collapsible Twin-Wire PDW Stock (MP5A3 / Honey Badger style)
    const railBlock = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(rw * 1.04, rh * 0.74, 0.004), 0.028, 0.0016, 0.0016),
      mats.darkSteel
    );
    railBlock.position.set(0, 0, 0.012);
    inner.add(railBlock);

    // Side release detent buttons
    for (const side of [-1, 1]) {
      const det = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.012, 0.016), mats.chromeSteel);
      det.position.set(side * (rw * 0.54), -rh * 0.14, 0.012);
      inner.add(det);
    }

    // Twin parallel chrome-steel telescoping guide rods running straight to the rear yoke
    const rodSpread = rw * 0.44 * sw;
    const rodY = rh * 0.04 - drop * 0.25;
    for (const side of [-1, 1]) {
      const rod = new THREE.Mesh(
        new THREE.BoxGeometry(0.0055, 0.011, len - 0.008),
        mats.chromeSteel
      );
      rod.position.set(side * rodSpread, rodY, len * 0.5);
      inner.add(rod);

      // Machined locking notches along bottom of rods
      for (let i = 1; i <= 4; i++) {
        const notch = new THREE.Mesh(new THREE.BoxGeometry(0.0062, 0.003, 0.004), mats.darkSteel);
        notch.position.set(side * rodSpread, rodY - 0.0055, len * (0.18 + i * 0.16));
        inner.add(notch);
      }
    }

    // Compact curved shoulder yoke seamlessly capping both guide rods
    const yokeH = rh * 1.18 * buttScale;
    const yokeW = Math.max(rodSpread * 2 + 0.014, stockW * 0.88);
    const yokeCenterY = rodY - yokeH * 0.22 - drop * 0.3;
    const yoke = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(yokeW, yokeH, 0.006), 0.018, 0.0022, 0.0022),
      mat
    );
    yoke.position.set(0, yokeCenterY, len - 0.006);
    inner.add(yoke);

    // Optional snap-on low cheek bridge if cheekRaise > 0
    if (cheekRaise > 0.001) {
      const cheek = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(yokeW * 0.94, 0.012 + cheekRaise, 0.004), len * 0.36, 0.0018, 0.0018),
        mats.rubber
      );
      cheek.position.set(0, rodY + 0.01 + cheekRaise * 0.5, len * 0.58);
      inner.add(cheek);
    }

    const pad = buildRibbedRecoilPad(yokeW * 0.98, yokeH * 0.98, 0.014, mats);
    pad.position.set(0, yokeCenterY, len + 0.003);
    inner.add(pad);
  } else if (variant === 'thumbhole_sport') {
    // Swept Thumbhole Pro Marksman Stock: Single watertight CCW outer silhouette + smooth CW elliptical thumbhole cutout!
    const collar = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(rw * 0.96, rh * 0.72, 0.004), 0.018, 0.0014, 0.0014),
      mats.darkSteel
    );
    collar.position.set(0, 0, 0.008);
    inner.add(collar);

    const buttTopY = rh * 0.3 - drop * 0.28;
    const buttBotY = -rh * 1.18 * buttScale - drop * 0.45;
    const buttH = buttTopY - buttBotY;

    // Single unified CCW outer silhouette (zero overlapping shapes, zero Z-fighting, zero miter flips!)
    const stockShape = new THREE.Shape();
    stockShape.moveTo(-0.006, rh * 0.34);
    stockShape.quadraticCurveTo(
      -len * 0.38,
      rh * 0.44 + cheekRaise - drop * 0.16,
      -len,
      buttTopY
    );
    stockShape.lineTo(-len, buttBotY);
    stockShape.lineTo(-len * 0.56, buttBotY + 0.005);
    stockShape.quadraticCurveTo(-len * 0.22, buttBotY * 0.94, -len * 0.08, -rh * 0.44 * buttScale - drop * 0.08);
    stockShape.lineTo(-0.006, -rh * 0.32);
    stockShape.closePath();

    // Smooth CW elliptical thumbhole cutout strictly inside outer walls across all slider extremes
    const hFrontX = -len * 0.16;
    const hRearX = -len * 0.54;
    const hCenterX = (hFrontX + hRearX) * 0.5;
    const hRx = Math.max(0.016, Math.abs(hFrontX - hRearX) * 0.46);
    const hTopLimit = Math.min(rh * 0.08, buttTopY - 0.022) - drop * 0.12;
    const hBotLimit = buttBotY * 0.64;
    const hCenterY = (hTopLimit + hBotLimit) * 0.5;
    const hRy = Math.max(0.011, Math.min(0.032, (hTopLimit - hBotLimit) * 0.44));

    const hole = new THREE.Path();
    hole.absellipse(hCenterX, hCenterY, hRx, hRy, 0, Math.PI * 2, true, 0.12);
    stockShape.holes.push(hole);

    inner.add(new THREE.Mesh(extrudeProfileX(stockShape, stockW * 0.94, 0.0024, 0.0024), mat));

    // Tactile Monte Carlo cheek pad inlay when cheekRaise > 0
    if (cheekRaise > 0.001) {
      const cheekPad = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(stockW * 0.98, 0.01 + cheekRaise * 0.4, 0.004), len * 0.36, 0.0016, 0.0016),
        mats.rubber
      );
      cheekPad.position.set(0, rh * 0.36 + cheekRaise * 0.65 - drop * 0.2, len * 0.62);
      inner.add(cheekPad);
    }

    // Rear sling slot accent
    const slot = new THREE.Mesh(new THREE.BoxGeometry(stockW * 1.0, 0.026, 0.012), mats.rubber);
    slot.position.set(0, (buttTopY + buttBotY) * 0.5 - 0.012, len * 0.86);
    inner.add(slot);

    const pad = buildRibbedRecoilPad(stockW * 1.0, buttH + 0.005, 0.018, mats);
    pad.position.set(0, (buttTopY + buttBotY) * 0.5, len);
    inner.add(pad);
  } else {
    // bullpup_buttpad: Sculpted ergonomic bullpup armored rear collar + deep contoured ribbed recoil pad
    const collarH = rh * 1.24 * buttScale;
    const collarY = -rh * 0.1 - drop * 0.2;
    const armorCollar = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(stockW * 1.06, collarH, 0.007), 0.032, 0.0032, 0.0032),
      mat
    );
    armorCollar.position.set(0, collarY, 0.016);
    inner.add(armorCollar);

    // Side beveled cheek transition plates + recessed sling slots + hex bolts
    for (const side of [-1, 1]) {
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.004, 12), mats.chromeSteel);
      bolt.rotation.z = Math.PI * 0.5;
      bolt.position.set(side * (stockW * 0.55), collarY + collarH * 0.22, 0.016);
      inner.add(bolt);

      const sling = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.022, 0.009), mats.darkSteel);
      sling.position.set(side * (stockW * 0.54), collarY - collarH * 0.22, 0.016);
      inner.add(sling);
    }

    if (cheekRaise > 0.001) {
      const cheek = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(stockW * 1.02, 0.01 + cheekRaise, 0.004), 0.044, 0.0018, 0.0018),
        mats.rubber
      );
      cheek.position.set(0, collarY + collarH * 0.5 + cheekRaise * 0.5, 0.012);
      inner.add(cheek);
    }

    const pad = buildRibbedRecoilPad(stockW * 1.04, collarH * 0.98, 0.022, mats);
    pad.position.set(0, collarY, 0.032);
    inner.add(pad);
  }

  tagSlot(boneStock, 'stock', interactables);
  return boneStock;
}

function buildMagazineSlot(
  config: WeaponConfig,
  m: ResolvedMechanics,
  mats: WeaponMaterials,
  interactables: THREE.Mesh[]
): THREE.Group {
  const boneMag = new THREE.Group();
  boneMag.name = 'Part_Magazine';
  boneMag.position.set(m.magwellPos.x, m.magwellPos.y, m.magwellPos.z);

  const variant = config.parts.magazine;
  if (variant === 'none') return boneMag;

  const tiltGroup = new THREE.Group();
  tiltGroup.rotation.x = THREE.MathUtils.degToRad(config.dimensions.magAngle);
  boneMag.add(tiltGroup);

  const mat = mats.bySlot.magazine;
  const len = config.dimensions.magLength;
  const curve = config.dimensions.magCurve;
  const wScale = config.dimensions.magWidth;

  if (variant === 'ak_curved') {
    tiltGroup.add(
      buildSweptCurvedMagazine(len, 0.056, 0.026 * wScale, Math.max(0.12, curve), true, mat, mats.rubber)
    );
  } else if (variant === 'ak_bakelite') {
    tiltGroup.add(
      buildSweptCurvedMagazine(len, 0.055, 0.025 * wScale, Math.max(0.12, curve), false, mat, mats.rubber)
    );
  } else if (variant === 'ar_stanag') {
    const mag = buildSweptCurvedMagazine(
      len * 0.94,
      0.056,
      0.024 * wScale,
      Math.min(0.18, curve * 0.65),
      true,
      mat,
      mats.rubber
    );
    // Smoked dark-steel witness window bezel + stacked polished metallic brass cartridges
    const winH = len * 0.34;
    const winZ = -Math.min(0.18, curve * 0.65) * len * 0.14;
    const bezel = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.0252 * wScale, winH + 0.008, 0.0022), 0.016, 0.0008, 0.0008),
      mats.darkSteel
    );
    bezel.position.set(0, -len * 0.45, winZ);
    mag.add(bezel);

    const roundCount = 5;
    for (let rIdx = 0; rIdx < roundCount; rIdx++) {
      const frac = (rIdx + 0.5) / roundCount - 0.5;
      const casing = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0036, 0.0036, 0.0282 * wScale, 12),
        mats.brass
      );
      casing.rotation.z = Math.PI * 0.5;
      casing.position.set(0, -len * 0.45 + frac * (winH - 0.006), winZ);
      mag.add(casing);
    }
    tiltGroup.add(mag);
  } else if (variant === 'smg_stick') {
    tiltGroup.add(
      buildSweptCurvedMagazine(len * 1.05, 0.032, 0.019 * wScale, curve * 0.25, false, mat, mats.rubber)
    );
  } else if (variant === 'drum_mag') {
    const tower = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.026 * wScale, 0.068, 0.003), 0.052, 0.0014, 0.0014),
      mats.darkSteel
    );
    tower.position.set(0, -0.024, 0);
    tiltGroup.add(tower);

    const drumR = 0.068 * (0.8 + len * 1.1);
    const drumDepth = 0.052 * wScale;
    const drumLathe = buildLatheAlongZ(
      [
        [0, -drumDepth * 0.5],
        [drumR * 0.95, -drumDepth * 0.5],
        [drumR, -drumDepth * 0.42],
        [drumR, drumDepth * 0.42],
        [drumR * 0.95, drumDepth * 0.5],
        [0, drumDepth * 0.5],
      ],
      32
    );
    const drum = new THREE.Mesh(drumLathe, mat);
    drum.position.set(0, -0.048 - drumR * 0.86, 0);
    tiltGroup.add(drum);

    for (const sideZ of [-drumDepth * 0.52, drumDepth * 0.52]) {
      const rib = new THREE.Mesh(
        new THREE.TorusGeometry(drumR * 0.62, 0.0024, 10, 28),
        mats.chromeSteel
      );
      rib.position.set(0, -0.048 - drumR * 0.86, sideZ);
      tiltGroup.add(rib);
    }
    const key = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.008, 0.012), mats.chromeSteel);
    key.position.set(0, -0.048 - drumR * 0.86, -drumDepth * 0.55);
    tiltGroup.add(key);
  } else if (variant === 'coupled_dual') {
    // Dual parallel tactical magazines joined by rigid steel/polymer coupler bridge clamps
    const sepX = 0.032 * wScale;
    const primary = buildSweptCurvedMagazine(
      len * 0.96,
      0.055,
      0.024 * wScale,
      Math.max(0.1, curve * 0.8),
      true,
      mat,
      mats.rubber
    );
    tiltGroup.add(primary);

    const secondary = buildSweptCurvedMagazine(
      len * 0.96,
      0.055,
      0.024 * wScale,
      Math.max(0.1, curve * 0.8),
      true,
      mat,
      mats.rubber
    );
    secondary.position.set(sepX, -0.014, 0);
    tiltGroup.add(secondary);

    // Top exposed polished metallic brass rifle cartridges seated in the secondary coupled mag feed lips
    for (const rOff of [-0.004 * wScale, 0.004 * wScale]) {
      const cartridge = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0038, 0.0044, 0.044, 14),
        mats.brass
      );
      cartridge.rotation.x = Math.PI * 0.5;
      cartridge.position.set(sepX + rOff, 0.0025 + (rOff > 0 ? 0.0015 : 0), -0.002);
      tiltGroup.add(cartridge);
    }

    // Twin rigid coupler bridge clamps + stainless cross-bolts locking both magazines
    for (const yFrac of [0.34, 0.62]) {
      const yPos = -len * yFrac;
      const zCurve = -Math.max(0.1, curve * 0.8) * len * (yFrac * yFrac * 0.65);
      const clamp = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(sepX + 0.03 * wScale, 0.018, 0.003), 0.064, 0.0014, 0.0014),
        mats.darkSteel
      );
      clamp.position.set(sepX * 0.5, yPos, zCurve);
      tiltGroup.add(clamp);

      const bolt = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0034, 0.0034, sepX + 0.034 * wScale, 12),
        mats.chromeSteel
      );
      bolt.rotation.z = Math.PI * 0.5;
      bolt.position.set(sepX * 0.5, yPos, zCurve + 0.022);
      tiltGroup.add(bolt);
    }
  } else if (variant === 'box_sniper') {
    // Heavy-walled precision AICS steel box magazine with side ribs, witness holes & extended bumper plate
    const boxH = len * 0.72;
    const boxW = 0.028 * wScale;
    const boxD = 0.072;
    const body = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(boxW, boxH, 0.003), boxD, 0.0016, 0.0016),
      mat
    );
    body.position.set(0, -boxH * 0.5 + 0.008, 0);
    tiltGroup.add(body);

    // Machined side strengthening grooves
    for (const side of [-1, 1]) {
      for (const zOff of [-0.018, 0.016]) {
        const rib = new THREE.Mesh(
          new THREE.BoxGeometry(0.0024, boxH * 0.76, 0.007),
          mats.darkSteel
        );
        rib.position.set(side * (boxW * 0.51), -boxH * 0.5 + 0.008, zOff);
        tiltGroup.add(rib);
      }
    }

    // Rear chrome round-count witness holes
    for (let i = 0; i < 4; i++) {
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0022, 0.003, 10), mats.chromeSteel);
      hole.rotation.x = Math.PI * 0.5;
      hole.position.set(0, -0.024 - i * (boxH * 0.17), boxD * 0.505);
      tiltGroup.add(hole);
    }

    // Oversized rubberized tactical bumper floorplate
    const bumper = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(boxW * 1.18, 0.015, 0.0035), boxD * 1.14, 0.0018, 0.0018),
      mats.rubber
    );
    bumper.position.set(0, -boxH + 0.004, -0.003);
    tiltGroup.add(bumper);
  } else {
    // scifi_cell: Armored plasma energy cell with dual recessed glowing charge bars
    const cell = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.032 * wScale, len * 0.82, 0.005), 0.064, 0.0022, 0.0022),
      mat
    );
    cell.position.set(0, -len * 0.38, 0);
    tiltGroup.add(cell);

    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.0024, 0.008, 0.028), mats.emissiveCyan);
        bar.position.set(side * (0.0175 * wScale), -0.03 - i * 0.018, 0);
        tiltGroup.add(bar);
      }
    }
  }

  tagSlot(boneMag, 'magazine', interactables);
  return boneMag;
}

function buildGripSlot(
  config: WeaponConfig,
  m: ResolvedMechanics,
  mats: WeaponMaterials,
  interactables: THREE.Mesh[]
): THREE.Group {
  const g = new THREE.Group();
  g.name = 'slot_grip';
  const mat = mats.bySlot.grip;
  const variant = config.parts.grip;
  const len = config.dimensions.gripLength;
  const angleRad = THREE.MathUtils.degToRad(config.dimensions.gripAngle);
  const thick = config.dimensions.gripThickness;

  const tang = new THREE.Mesh(
    extrudeCenteredZ(roundedRectShape(config.dimensions.receiverWidth * 0.78, 0.022, 0.005), 0.044, 0.002, 0.002),
    mats.darkSteel
  );
  tang.position.set(0, m.receiverBottomY - 0.005, 0.006);
  g.add(tang);

  const gripPivot = new THREE.Group();
  gripPivot.position.set(0, m.receiverBottomY - 0.004, 0.004);
  gripPivot.rotation.x = -angleRad;
  g.add(gripPivot);

  const effLen = variant === 'angled_pdw' ? len * 0.8 : len;
  const width = (variant === 'cqb_vertical' || variant === 'angled_pdw' ? 0.027 : 0.029) * thick;

  if (variant === 'skeleton_cnc') {
    // Sculpted 7075-T6 CNC Billet Skeletonized Grip: Single ergonomic silhouette with 3 precision-milled truss cutouts
    const billetShape = new THREE.Shape();
    billetShape.moveTo(0.014, 0.008);
    billetShape.lineTo(-0.022, 0.008);
    billetShape.quadraticCurveTo(-0.027, -effLen * 0.34, -0.02, -effLen);
    billetShape.lineTo(0.015, -effLen);
    billetShape.quadraticCurveTo(0.021, -effLen * 0.68, 0.016, -effLen * 0.42);
    billetShape.quadraticCurveTo(0.02, -effLen * 0.18, 0.014, 0.008);
    billetShape.closePath();

    // 3 precision-milled CW billet lightening pockets separated by angled CNC truss webs
    billetShape.holes.push(
      roundedSlotHoleCW(-0.009, 0.006, -effLen * 0.35, -effLen * 0.16, 0.0016, 0.0022),
      roundedSlotHoleCW(-0.009, 0.006, -effLen * 0.61, -effLen * 0.43, -0.0016, 0.0022),
      roundedSlotHoleCW(-0.0085, 0.006, -effLen * 0.85, -effLen * 0.69, 0.0012, 0.0022)
    );

    gripPivot.add(new THREE.Mesh(extrudeProfileX(billetShape, width, 0.0015, 0.0016), mat));

    // Textured dark-rubber ergonomic frontstrap & backstrap grip inserts (leaving billet cutouts 100% open!)
    const frontInsert = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(width * 0.86, effLen * 0.72, 0.0025), 0.005, 0.0008, 0.0008),
      mats.rubber
    );
    frontInsert.position.set(0, -effLen * 0.5, -0.0165);
    gripPivot.add(frontInsert);

    const backInsert = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(width * 0.84, effLen * 0.66, 0.0025), 0.005, 0.0008, 0.0008),
      mats.rubber
    );
    backInsert.position.set(0, -effLen * 0.5, 0.0215);
    gripPivot.add(backInsert);

    // Flared CNC competition billet baseplate + bottom hex grip-screw plug
    const basePlate = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(width * 1.18, 0.01, 0.0035), 0.042, 0.0014, 0.0014),
      mats.darkSteel
    );
    basePlate.position.set(0, -effLen - 0.003, 0.003);
    gripPivot.add(basePlate);

    const hexPlug = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0042, 0.004, 6), mats.chromeSteel);
    hexPlug.position.set(0, -effLen - 0.009, 0.003);
    gripPivot.add(hexPlug);

    // Flush machined Torx accent pins seated cleanly on the solid truss junctions between cutouts
    for (const frac of [0.39, 0.65]) {
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.0024, 0.0024, width + 0.0035, 12), mats.chromeSteel);
      pin.rotation.z = Math.PI * 0.5;
      pin.position.set(0, -effLen * frac, 0.0015);
      gripPivot.add(pin);
    }
  } else {
    const gripShape = new THREE.Shape();
    gripShape.moveTo(0.014, 0.006);
    gripShape.lineTo(variant === 'rubber_overmold' ? -0.022 : -0.016, 0.006);
    if (variant === 'rubber_overmold') {
      // Pronounced ergonomic beavertail backstrap swell
      gripShape.quadraticCurveTo(-0.028, -effLen * 0.34, -0.021, -effLen);
    } else {
      gripShape.quadraticCurveTo(-0.024, -effLen * 0.38, -0.019, -effLen);
    }
    gripShape.lineTo(0.014, -effLen);

    if (variant === 'tactical_ergo' || variant === 'precision_palm' || variant === 'rubber_overmold') {
      const groovePeak = variant === 'rubber_overmold' ? 0.0245 : 0.022;
      gripShape.quadraticCurveTo(groovePeak, -effLen * 0.78, 0.0145, -effLen * 0.62);
      gripShape.quadraticCurveTo(groovePeak, -effLen * 0.46, 0.0145, -effLen * 0.3);
      gripShape.quadraticCurveTo(groovePeak * 0.96, -effLen * 0.14, 0.014, 0.006);
    } else {
      gripShape.quadraticCurveTo(0.018, -effLen * 0.5, 0.014, 0.006);
    }
    gripShape.closePath();

    gripPivot.add(new THREE.Mesh(extrudeProfileX(gripShape, width, 0.0038, 0.0038), mat));

    // Contrasting ergonomic stippled side-panel scales on standard tactical/precision grips
    if (variant === 'tactical_ergo' || variant === 'precision_palm') {
      const panelGeo = extrudeProfileX(roundedRectShape(0.022, effLen * 0.62, 0.004), 0.0024, 0.0008, 0.0008);
      for (const side of [-1, 1]) {
        const panel = new THREE.Mesh(panelGeo, mats.rubber);
        panel.position.set(side * (width * 0.5 + 0.0022), -effLen * 0.5, 0.001);
        gripPivot.add(panel);
      }
    } else if (variant === 'ak_slanted') {
      // Recessed side checkering medallions + brass/steel bottom grip ferrule on classic AK wood/bakelite grip
      const inlayGeo = extrudeProfileX(roundedRectShape(0.017, effLen * 0.58, 0.004), 0.0018, 0.0007, 0.0007);
      for (const side of [-1, 1]) {
        const inlay = new THREE.Mesh(inlayGeo, mats.darkSteel);
        inlay.position.set(side * (width * 0.5 + 0.0019), -effLen * 0.5, 0.0015);
        gripPivot.add(inlay);
      }
    }

    if (variant === 'rubber_overmold') {
      // Contrasting textured rubberized overmold wrap sleeve hugging the grip flanks & backstrap
      const wrap = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(width * 1.07, effLen * 0.72, 0.005), 0.026, 0.0018, 0.0018),
        mats.rubber
      );
      wrap.position.set(0, -effLen * 0.52, 0.004);
      gripPivot.add(wrap);
    } else if (variant === 'angled_pdw') {
      // Compact horizontal front-strap traction serrations + pinky flare lip
      for (let i = 0; i < 4; i++) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(width * 0.96, 0.0035, 0.005), mats.rubber);
        rib.position.set(0, -effLen * (0.24 + i * 0.17), -0.016);
        gripPivot.add(rib);
      }
      const flare = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(width * 1.18, 0.01, 0.0035), 0.044, 0.0014, 0.0014),
        mats.darkSteel
      );
      flare.position.set(0, -effLen - 0.002, 0.001);
      gripPivot.add(flare);
    }

    if (variant === 'precision_palm') {
      const shelf = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(0.048 * thick, 0.011, 0.004), 0.056, 0.0018, 0.0018),
        mats.rubber
      );
      shelf.position.set(0.005, -effLen - 0.004, 0.002);
      gripPivot.add(shelf);
    } else if (variant === 'cqb_vertical') {
      const flare = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(0.036 * thick, 0.012, 0.004), 0.044, 0.0016, 0.0016),
        mats.darkSteel
      );
      flare.position.set(0, -effLen - 0.003, 0.002);
      gripPivot.add(flare);
    } else if (variant !== 'angled_pdw') {
      const cap = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(width * 0.96, 0.008, 0.003), 0.036, 0.0012, 0.0012),
        mats.darkSteel
      );
      cap.position.set(0, -effLen - 0.002, 0.002);
      gripPivot.add(cap);
    }
  }

  tagSlot(g, 'grip', interactables);
  return g;
}

function buildMuzzleSlot(
  config: WeaponConfig,
  m: ResolvedMechanics,
  mats: WeaponMaterials,
  interactables: THREE.Mesh[]
): THREE.Group {
  const g = new THREE.Group();
  g.name = 'slot_muzzle';
  const variant = config.parts.muzzle;
  if (variant === 'none') return g;

  const mat = mats.bySlot.muzzle;
  const sLen = config.dimensions.muzzleScale * config.dimensions.muzzleLengthScale;
  const sDia = config.dimensions.muzzleScale * config.dimensions.muzzleDiameterScale;
  const r = config.dimensions.barrelThickness;
  const isTwinBarrel = config.parts.barrel === 'twin_scifi';
  const boreOffsetsY = isTwinBarrel ? [-r * 1.15, r * 1.15] : [0];
  const twinRadScale = isTwinBarrel ? 0.72 : 1.0;

  // Seat 6mm back over the barrel tip threads so barrel & muzzle ALWAYS touch solidly with zero air gap
  g.position.set(0, m.barrelAxisY, m.barrelEndZ + 0.006);

  // Rear thread shoulder collar(s) — Twin-Rail gets a matched billet dual-bore manifold yoke embracing BOTH barrels!
  if (isTwinBarrel) {
    const twinManifold = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(r * 2.5, r * 4.5, 0.004), 0.014, 0.0012, 0.0012),
      mats.darkSteel
    );
    twinManifold.position.set(0, 0, -0.005);
    g.add(twinManifold);
  }
  for (const dy of boreOffsetsY) {
    const collarR = isTwinBarrel ? r * 0.98 : r * 1.18;
    const threadCollar = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [collarR, 0],
          [collarR, 0.012],
          [0, 0.012],
        ],
        20
      ),
      mats.darkSteel
    );
    threadCollar.position.set(0, dy, 0);
    g.add(threadCollar);
  }

  if (variant === 'slant_brake') {
    const dia = sDia * twinRadScale;
    for (const dy of boreOffsetsY) {
      const body = new THREE.Mesh(
        buildLatheAlongZ(
          [
            [0, 0],
            [r * 1.18 * dia, 0],
            [r * 1.26 * dia, 0.014 * sLen],
            [r * 1.16 * dia, 0.04 * sLen],
            [r * 0.5 * twinRadScale, 0.04 * sLen],
            [r * 0.5 * twinRadScale, 0.024 * sLen],
            [0, 0.024 * sLen],
          ],
          24
        ),
        mat
      );
      body.position.set(0, dy, 0);
      g.add(body);
    }
    if (isTwinBarrel) {
      const tieBar = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(r * 1.2, r * 2.2, 0.002), 0.016 * sLen, 0.0008, 0.0008),
        mats.darkSteel
      );
      tieBar.position.set(0, 0, -0.02 * sLen);
      g.add(tieBar);
    }
  } else if (variant === 'suppressor') {
    const sr = isTwinBarrel
      ? Math.min(r * 1.04, Math.max(r * 0.95, 0.0115) * Math.min(1.2, 0.78 + sDia * 0.22))
      : Math.max(r * 1.75, 0.0185) * Math.min(1.45, 0.72 + sDia * 0.28);
    const len = 0.175 * sLen;
    for (const dy of boreOffsetsY) {
      const body = new THREE.Mesh(
        buildLatheAlongZ(
          [
            [0, 0],
            [Math.min(sr, r * 1.22), 0],
            [sr * 1.04, 0.018],
            [sr * 1.04, 0.032],
            [sr, 0.036],
            [sr, len - 0.008],
            [sr * 0.84, len],
            [sr * 0.36, len],
            [sr * 0.36, len - 0.02],
            [0, len - 0.02],
          ],
          32
        ),
        mat
      );
      body.position.set(0, dy, 0);
      g.add(body);

      for (let i = 0; i < 4; i++) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(sr * 1.02, 0.0012, 8, 28),
          mats.chromeSteel
        );
        ring.position.set(0, dy, -(0.022 + i * 0.038 * sLen));
        g.add(ring);
      }
    }
    if (isTwinBarrel) {
      for (const zFrac of [0.35, 0.78]) {
        const bridge = new THREE.Mesh(
          extrudeCenteredZ(roundedRectShape(sr * 2.1, r * 3.8, 0.003), 0.012, 0.001, 0.001),
          mats.darkSteel
        );
        bridge.position.set(0, 0, -len * zFrac);
        g.add(bridge);
      }
    }
  } else if (variant === 'tank_brake') {
    // Authentic CNC 3-baffle heavy sniper brake with REAL open side blast chambers & REAL circular front bore hole(s)!
    const len = 0.072 * sLen;
    const bw = Math.max(0.036 * sDia, r * 3.0);
    const bh = isTwinBarrel ? Math.max(0.044 * sDia, r * 4.8 + 0.006) : Math.max(0.026 * sDia, r * 2.4);
    const boreR = isTwinBarrel
      ? Math.min(r * 0.56, Math.max(0.0032, (bh * 0.5 - r * 1.15) * 0.58))
      : Math.min(r * 0.68, bh * 0.32);

    const makeBaffleShape = () => {
      const s = roundedRectShape(bw, bh, 0.0038);
      for (const dy of boreOffsetsY) {
        const hole = new THREE.Path();
        hole.absarc(0, dy, boreR, 0, Math.PI * 2, true);
        s.holes.push(hole);
      }
      return s;
    };

    // 3 heavy machined transverse baffle walls with real circular bore holes all the way through
    const baffleDepth = 0.011 * sLen;
    for (const zPos of [-0.012 * sLen, -len * 0.5, -len + baffleDepth * 0.55]) {
      const baffle = new THREE.Mesh(
        extrudeCenteredZ(makeBaffleShape(), baffleDepth, 0.0011, 0.0011),
        mat
      );
      baffle.position.z = zPos;
      g.add(baffle);
    }

    // Solid beveled top & bottom structural bridge plates framing two REAL open side blast chambers
    const plateH = Math.max(0.0044, bh * 0.16);
    const plateY = bh * 0.5 - plateH * 0.5;
    for (const side of [-1, 1]) {
      const plate = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(bw * 0.96, plateH, 0.0018), len - 0.006 * sLen, 0.0009, 0.0009),
        mat
      );
      plate.position.set(0, side * plateY, -len * 0.5 - 0.001 * sLen);
      g.add(plate);
    }

    // Center divider web for Twin Rail + dark recessed rear throat discs inside the bore
    if (isTwinBarrel) {
      const midWeb = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(bw * 0.88, Math.max(0.004, r * 0.65), 0.0015), len - 0.008 * sLen, 0.0008, 0.0008),
        mats.darkSteel
      );
      midWeb.position.set(0, 0, -len * 0.5);
      g.add(midWeb);
    }

    for (const dy of boreOffsetsY) {
      const throat = new THREE.Mesh(new THREE.CircleGeometry(boreR * 0.98, 20), mats.rubber);
      throat.position.set(0, dy, -0.006 * sLen);
      throat.rotation.y = Math.PI;
      g.add(throat);

      const crownRing = new THREE.Mesh(
        new THREE.TorusGeometry(boreR + 0.0008, 0.0009, 8, 22),
        mats.darkSteel
      );
      crownRing.position.set(0, dy, -len - 0.0006);
      g.add(crownRing);
    }
  } else if (variant === 'flash_hider') {
    const len = 0.056 * sLen;
    const dia = sDia * twinRadScale;
    for (const dy of boreOffsetsY) {
      const collar = new THREE.Mesh(
        buildLatheAlongZ(
          [
            [0, 0],
            [r * 1.24 * dia, 0],
            [r * 1.24 * dia, 0.018 * sLen],
            [0, 0.018 * sLen],
          ],
          24
        ),
        mat
      );
      collar.position.set(0, dy, 0);
      g.add(collar);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
        const prong = new THREE.Mesh(
          new THREE.BoxGeometry(0.0042 * dia, 0.0042 * dia, len * 0.78),
          mat
        );
        prong.position.set(
          Math.cos(a) * r * 0.96 * dia,
          dy + Math.sin(a) * r * 0.96 * dia,
          -len * 0.56
        );
        g.add(prong);
      }
    }
  } else if (variant === 'osp_rectangular') {
    // Eccentric octagonal/rectangular Osprey low-profile suppressor with REAL recessed circular front bore hole(s)!
    const len = 0.168 * sLen;
    const ow = Math.max(0.034 * sDia, isTwinBarrel ? r * 2.8 : 0.024);
    const oh = isTwinBarrel ? Math.max(0.052 * sDia, r * 4.8 + 0.008) : 0.042 * sDia;
    const dropY = isTwinBarrel ? 0 : -0.0075 * sDia;
    const boreR = isTwinBarrel
      ? Math.min(r * 0.54, Math.max(0.0032, (oh * 0.5 - r * 1.15) * 0.58))
      : Math.min(r * 0.66, 0.0088 * sDia);

    // Rear cylindrical QD locking piston collar(s) centered on bore axis (watertight)
    for (const dy of boreOffsetsY) {
      const pDia = sDia * twinRadScale;
      const piston = new THREE.Mesh(
        buildLatheAlongZ(
          [[0, 0], [r * 1.24 * twinRadScale, 0], [r * 1.38 * pDia, 0.016], [r * 1.28 * pDia, 0.024], [0, 0.024]],
          24
        ),
        mats.chromeSteel
      );
      piston.position.set(0, dy, 0);
      g.add(piston);
    }

    // Chamfered octagonal Osprey suppressor cross-section
    const makeOctShape = (withBoreHoles: boolean) => {
      const oct = new THREE.Shape();
      const hw = ow * 0.5;
      const hh = oh * 0.5;
      const c = Math.min(0.0055 * sDia, hw * 0.35, hh * 0.35);
      oct.moveTo(-hw + c, -hh);
      oct.lineTo(hw - c, -hh);
      oct.lineTo(hw, -hh + c);
      oct.lineTo(hw, hh - c);
      oct.lineTo(hw - c, hh);
      oct.lineTo(-hw + c, hh);
      oct.lineTo(-hw, hh - c);
      oct.lineTo(-hw, -hh + c);
      oct.closePath();

      if (withBoreHoles) {
        for (const dy of boreOffsetsY) {
          const hole = new THREE.Path();
          hole.absarc(0, dy - dropY, boreR, 0, Math.PI * 2, true);
          oct.holes.push(hole);
        }
      }
      return oct;
    };

    // Main octagonal body stopping 16mm behind front tip to make room for deep recessed front bore cap
    const frontCapDepth = 0.016;
    const bodyLen = Math.max(0.04, len - 0.014 - frontCapDepth);
    const body = new THREE.Mesh(extrudeCenteredZ(makeOctShape(false), bodyLen, 0.0016, 0.0016), mat);
    body.position.set(0, dropY, -0.014 - bodyLen * 0.5);
    g.add(body);

    // Front recessed baffle end-cap with REAL circular bore hole(s) punched cleanly through!
    const frontCap = new THREE.Mesh(
      extrudeCenteredZ(makeOctShape(true), frontCapDepth, 0.0011, 0.0011),
      mats.darkSteel
    );
    frontCap.position.set(0, dropY, -len + frontCapDepth * 0.5);
    g.add(frontCap);

    // Deep recessed dark chamber backing disc + crisp stainless bore crown rim inside the front hole(s)
    for (const dy of boreOffsetsY) {
      const innerDark = new THREE.Mesh(new THREE.CircleGeometry(boreR * 0.99, 22), mats.rubber);
      innerDark.position.set(0, dy, -len + frontCapDepth - 0.002);
      innerDark.rotation.y = Math.PI;
      g.add(innerDark);

      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(boreR + 0.0008, 0.0009, 8, 24),
        mats.chromeSteel
      );
      rim.position.set(0, dy, -len - 0.0008);
      g.add(rim);
    }
  } else if (variant === 'breacher_spike') {
    // Heavy door-breaching standoff compensator with dual oval side blast ports & 6 serrated spikes
    const len = 0.064 * sLen;
    const dia = sDia * twinRadScale;
    const bodyR = isTwinBarrel
      ? Math.min(r * 1.02, Math.max(r * 0.96, 0.0105) * sDia)
      : Math.max(r * 1.48, 0.014) * sDia;

    for (const dy of boreOffsetsY) {
      const body = new THREE.Mesh(
        buildLatheAlongZ(
          [
            [0, 0],
            [Math.min(bodyR, r * 1.24 * dia), 0],
            [bodyR, 0.01 * sLen],
            [bodyR, len * 0.72],
            [bodyR * 0.84, len * 0.76],
            [r * 0.52 * twinRadScale, len * 0.76],
            [r * 0.52 * twinRadScale, len * 0.45],
            [0, len * 0.45],
          ],
          24
        ),
        mat
      );
      body.position.set(0, dy, 0);
      g.add(body);

      for (const zOff of [-len * 0.34, -len * 0.56]) {
        const port = new THREE.Mesh(
          new THREE.BoxGeometry(bodyR * 2.1, bodyR * 0.62, 0.009 * sLen),
          mats.rubber
        );
        port.position.set(0, dy, zOff);
        g.add(port);
      }

      const spikeLen = len * 0.3;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const spike = new THREE.Mesh(
          new THREE.ConeGeometry(0.0032 * dia, spikeLen, 4),
          mats.chromeSteel
        );
        spike.rotation.x = -Math.PI * 0.5;
        spike.position.set(
          Math.cos(a) * bodyR * 0.84,
          dy + Math.sin(a) * bodyR * 0.84,
          -len * 0.74 - spikeLen * 0.45
        );
        g.add(spike);
      }
    }
    if (isTwinBarrel) {
      const tie = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(bodyR * 1.7, r * 2.5, 0.002), 0.016 * sLen, 0.0008, 0.0008),
        mats.darkSteel
      );
      tie.position.set(0, 0, -len * 0.25);
      g.add(tie);
    }
  } else {
    // linear_comp: Heavy cylindrical blast-forwarding linear compensator
    const len = 0.068 * sLen;
    const dia = sDia * twinRadScale;
    const compR = isTwinBarrel ? Math.min(r * 1.04, r * 1.55 * dia) : r * 1.55 * sDia;
    for (const dy of boreOffsetsY) {
      const comp = new THREE.Mesh(
        buildLatheAlongZ(
          [
            [0, 0],
            [Math.min(compR, r * 1.25 * dia), 0],
            [compR, 0.01 * sLen],
            [compR, len - 0.008 * sLen],
            [compR * 0.89, len],
            [r * 0.45 * twinRadScale, len],
            [r * 0.45 * twinRadScale, len - 0.016 * sLen],
            [0, len - 0.016 * sLen],
          ],
          28
        ),
        mat
      );
      comp.position.set(0, dy, 0);
      g.add(comp);
    }
    if (isTwinBarrel) {
      const tie = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(compR * 1.8, r * 2.6, 0.0025), 0.014 * sLen, 0.0009, 0.0009),
        mats.darkSteel
      );
      tie.position.set(0, 0, -len * 0.42);
      g.add(tie);
    }
  }

  tagSlot(g, 'muzzle', interactables);
  return g;
}

/**
 * Optic slot builder with ZERO floating parts:
 * - Every clamp seats 2.5mm INTO the rail teeth
 * - Optional riser pedestal bridges `opticMountHeight` seamlessly
 * - Every optic housing/ring connects solidly to its clamp via machined stems/pedestals
 */
function buildOpticSlot(
  config: WeaponConfig,
  m: ResolvedMechanics,
  mats: WeaponMaterials,
  interactables: THREE.Mesh[]
): THREE.Group {
  const g = new THREE.Group();
  g.name = 'slot_optic';
  const variant = config.parts.optic;
  if (variant === 'none') return g;

  const mat = mats.bySlot.optic;
  const s = config.dimensions.opticScale;
  const rise = config.dimensions.opticMountHeight;
  const lensW = config.dimensions.opticLensScale;
  g.position.set(m.opticMountPos.x, m.opticMountPos.y, m.opticMountPos.z);

  const scaled = new THREE.Group();
  scaled.scale.setScalar(s);
  g.add(scaled);

  // Helper: adds a solid machined riser block from clamp top (y=0.007) up by `rise / s`
  const localRise = rise / s;
  const addRiserPedestal = (lenZ: number, widthX = 0.022, zOffset = 0) => {
    if (localRise <= 0.0005) return;
    const pedestal = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(widthX, localRise + 0.004, 0.002), lenZ, 0.0009, 0.0009),
      mats.darkSteel
    );
    pedestal.position.set(0, 0.006 + localRise * 0.5, zOffset);
    scaled.add(pedestal);
  };

  if (variant === 'iron_sights') {
    scaled.add(buildRailClampBase(0.034, mats.darkSteel, mats.chromeSteel));
    addRiserPedestal(0.03, 0.021);
    const baseY = 0.007 + localRise;

    // Solid deck bridging clamp & wings + central aperture stem (zero floating torus!)
    const deck = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.024 * lensW, 0.006, 0.0015), 0.024, 0.0008, 0.0008),
      mat
    );
    deck.position.set(0, baseY + 0.002, 0);
    scaled.add(deck);

    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(0.0042, 0.02, 0.001), 0.018, 0.0008, 0.0008),
        mat
      );
      wing.position.set(side * 0.01 * lensW, baseY + 0.012, 0);
      scaled.add(wing);
    }

    // Center stem holding the rear peep aperture ring directly onto the deck
    const stem = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.009, 0.006), mats.darkSteel);
    stem.position.set(0, baseY + 0.008, 0);
    scaled.add(stem);

    const aperture = new THREE.Mesh(new THREE.TorusGeometry(0.0052 * lensW, 0.0018, 10, 18), mat);
    aperture.position.set(0, baseY + 0.014, 0);
    scaled.add(aperture);
  } else if (variant === 'red_dot') {
    // Sculpted EOTech EXPS-style holographic sight: open-window trapezoidal roll-cage hood + transverse front battery housing
    scaled.add(buildRailClampBase(0.072, mats.darkSteel, mats.chromeSteel));
    addRiserPedestal(0.064, 0.024);
    const baseY = 0.007 + localRise;

    // Lower armored emitter & electronics deck seated flush onto QD rail clamp
    const deck = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.032 * lensW, 0.0105, 0.0026), 0.072, 0.0012, 0.0012),
      mats.darkSteel
    );
    deck.position.set(0, baseY + 0.0042, 0);
    scaled.add(deck);

    // Front transverse CR123 battery compartment housing + knurled right-side cap
    const batHousing = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.035 * lensW, 0.017, 0.0035), 0.024, 0.0014, 0.0014),
      mats.darkSteel
    );
    batHousing.position.set(0, baseY + 0.013, -0.024);
    scaled.add(batHousing);

    const batCap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0068, 0.0068, 0.007, 16),
      mats.chromeSteel
    );
    batCap.rotation.z = Math.PI * 0.5;
    batCap.position.set(0.0185 * lensW, baseY + 0.013, -0.024);
    scaled.add(batCap);

    // Open-window armored roll-cage hood: beveled twin angled side walls + thick protective roof arch
    const hoodZ = 0.011;
    const hoodLen = 0.042;
    const wallH = 0.025;
    const halfW = 0.0168 * lensW;
    for (const side of [-1, 1]) {
      const sideWall = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(0.0048, wallH, 0.0014), hoodLen, 0.001, 0.001),
        mat
      );
      sideWall.position.set(side * halfW, baseY + 0.0195, hoodZ);
      sideWall.rotation.z = side * 0.09;
      scaled.add(sideWall);

      // Inner dark-steel glass retention frame
      const innerRail = new THREE.Mesh(
        new THREE.BoxGeometry(0.0026, wallH * 0.84, hoodLen * 0.78),
        mats.darkSteel
      );
      innerRail.position.set(side * (halfW - 0.0032), baseY + 0.0195, hoodZ);
      scaled.add(innerRail);
    }

    // Beveled protective top bridge crowning the holographic window
    const hoodRoof = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.035 * lensW, 0.0056, 0.0018), hoodLen + 0.002, 0.0012, 0.0012),
      mat
    );
    hoodRoof.position.set(0, baseY + 0.032, hoodZ);
    scaled.add(hoodRoof);

    // Subtle side windage & elevation adjustment dial screws on right hood flank
    for (const dz of [-0.006, 0.006]) {
      const dial = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0032, 0.0032, 0.004, 12),
        mats.chromeSteel
      );
      dial.rotation.z = Math.PI * 0.5;
      dial.position.set(halfW + 0.002, baseY + 0.014, hoodZ + dz);
      scaled.add(dial);
    }

    // Rear tactile rubberized brightness/NV control buttons
    const btnPad = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.022 * lensW, 0.007, 0.0016), 0.006, 0.0006, 0.0006),
      mats.rubber
    );
    btnPad.position.set(0, baseY + 0.0065, 0.036);
    scaled.add(btnPad);

    // Front & rear recessed anti-reflective holographic lenses + crisp glowing red center reticle
    for (const lz of [hoodZ - 0.011, hoodZ + 0.011]) {
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.024 * lensW, 0.019), mats.opticLens);
      glass.position.set(0, baseY + 0.02, lz);
      scaled.add(glass);
    }

    const reticle = new THREE.Mesh(new THREE.SphereGeometry(0.0014, 10, 10), mats.emissiveRed);
    reticle.position.set(0, baseY + 0.02, hoodZ);
    scaled.add(reticle);
  } else if (variant === 'micro_reflex') {
    scaled.add(buildRailClampBase(0.04, mats.darkSteel, mats.chromeSteel));
    addRiserPedestal(0.034, 0.021);
    const baseY = 0.007 + localRise;

    const riser = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.024 * lensW, 0.013, 0.002), 0.036, 0.001, 0.001),
      mats.darkSteel
    );
    riser.position.set(0, baseY + 0.006, 0);
    scaled.add(riser);

    // Compact LED emitter shroud behind window
    const emitter = new THREE.Mesh(
      new THREE.BoxGeometry(0.005, 0.004, 0.006),
      mats.rubber
    );
    emitter.position.set(0, baseY + 0.013, 0.011);
    scaled.add(emitter);

    const frame = new THREE.Mesh(new THREE.TorusGeometry(0.0125 * lensW, 0.0026, 12, 24), mat);
    frame.position.set(0, baseY + 0.022, 0);
    scaled.add(frame);

    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.0108 * lensW, 20), mats.opticLens);
    lens.position.set(0, baseY + 0.022, 0);
    scaled.add(lens);

    // Glowing center red reflex dot visible from ADS & 3/4 angles
    const redDot = new THREE.Mesh(new THREE.SphereGeometry(0.00145, 12, 12), mats.emissiveRed);
    redDot.position.set(0, baseY + 0.022, 0.0012);
    scaled.add(redDot);
  } else if (variant === 'acog') {
    scaled.add(buildRailClampBase(0.078, mats.darkSteel, mats.chromeSteel));
    addRiserPedestal(0.068, 0.022);
    const baseY = 0.007 + localRise;

    // Solid sculpted ACOG mounting pedestal bridging clamp straight up into the prism body
    const pedestal = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.019, 0.02, 0.002), 0.062, 0.001, 0.001),
      mats.darkSteel
    );
    pedestal.position.set(0, baseY + 0.009, 0);
    scaled.add(pedestal);

    const tubeY = baseY + 0.026;
    // Watertight closed manifold lathe with thick recessed ocular & objective rims (zero hollow backface flicker!)
    const tube = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, -0.047],
          [0.012 * lensW, -0.047],
          [0.012 * lensW, -0.056],
          [0.0155 * lensW, -0.056],
          [0.0155 * lensW, -0.036],
          [0.0135 * lensW, -0.02],
          [0.0145 * lensW, 0.026],
          [0.0195 * lensW, 0.052],
          [0.0195 * lensW, 0.066],
          [0.016 * lensW, 0.066],
          [0.016 * lensW, 0.055],
          [0, 0.055],
        ],
        32
      ),
      mat
    );
    tube.position.set(0, tubeY, 0);
    scaled.add(tube);

    // Rubberized ocular eye-side bezel ring for clean visual edge definition
    const eyeRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.0142 * lensW, 0.0018, 10, 28),
      mats.rubber
    );
    eyeRing.position.set(0, tubeY, 0.0555);
    scaled.add(eyeRing);

    const fiber = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0026, 0.0026, 0.048, 12),
      mats.emissiveRed
    );
    fiber.rotation.x = Math.PI * 0.5;
    fiber.position.set(0, tubeY + 0.016 * lensW, -0.008);
    scaled.add(fiber);

    // Dark recessed optical chamber backings + coated lenses cleanly seated inside the bezels (zero Z-fighting)
    const eyeBack = new THREE.Mesh(new THREE.CircleGeometry(0.0118 * lensW, 20), mats.rubber);
    eyeBack.position.set(0, tubeY, 0.0485);
    scaled.add(eyeBack);

    const eyeLens = new THREE.Mesh(new THREE.CircleGeometry(0.0118 * lensW, 20), mats.opticLens);
    eyeLens.position.set(0, tubeY, 0.051);
    scaled.add(eyeLens);

    const frontBack = new THREE.Mesh(new THREE.CircleGeometry(0.0158 * lensW, 22), mats.rubber);
    frontBack.position.set(0, tubeY, -0.0565);
    frontBack.rotation.y = Math.PI;
    scaled.add(frontBack);

    const frontLens = new THREE.Mesh(new THREE.CircleGeometry(0.0158 * lensW, 22), mats.opticLens);
    frontLens.position.set(0, tubeY, -0.0595);
    frontLens.rotation.y = Math.PI;
    scaled.add(frontLens);
  } else if (variant === 'lpvo_tactical') {
    // 1-8x LPVO Tactical Scope: Forward cantilever 1-piece mount + straight 30mm tube + throw lever + watertight optics
    const baseY = 0.007 + localRise;
    const tubeCenterY = baseY + 0.025;

    const clamp = buildRailClampBase(0.082, mats.darkSteel, mats.chromeSteel);
    clamp.position.z = 0.004;
    scaled.add(clamp);
    addRiserPedestal(0.074, 0.021, 0.004);

    // Swept forward cantilever mount bridge linking base rail to twin rings
    const cantiShape = new THREE.Shape();
    cantiShape.moveTo(-0.036, 0);
    cantiShape.lineTo(0.036, 0);
    cantiShape.lineTo(0.056, 0.017);
    cantiShape.lineTo(-0.034, 0.017);
    cantiShape.closePath();
    const cantiBridge = new THREE.Mesh(extrudeProfileX(cantiShape, 0.019, 0.001, 0.001), mats.darkSteel);
    cantiBridge.position.set(0, baseY - 0.001, 0.004);
    scaled.add(cantiBridge);

    for (const zPos of [-0.044, 0.026]) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.0155 * lensW, 0.0038, 12, 24),
        mats.darkSteel
      );
      ring.position.set(0, tubeCenterY, zPos);
      scaled.add(ring);

      const capBolt = new THREE.Mesh(new THREE.BoxGeometry(0.037 * lensW, 0.0048, 0.0075), mats.chromeSteel);
      capBolt.position.set(0, tubeCenterY, zPos);
      scaled.add(capBolt);
    }

    // Watertight straight-tube 30mm LPVO optic body (clean low-drag profile!)
    const tube = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, -0.095],
          [0.0145 * lensW, -0.095],
          [0.0145 * lensW, -0.105],
          [0.0178 * lensW, -0.105],
          [0.0178 * lensW, -0.064],
          [0.0144 * lensW, -0.046],
          [0.0144 * lensW, 0.068],
          [0.0168 * lensW, 0.084],
          [0.0168 * lensW, 0.118],
          [0.0138 * lensW, 0.118],
          [0.0138 * lensW, 0.106],
          [0, 0.106],
        ],
        32
      ),
      mat
    );
    tube.position.set(0, tubeCenterY, 0);
    scaled.add(tube);

    // Knurled magnification ring + protruding throw-lever fin
    const magRing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0176 * lensW, 0.0176 * lensW, 0.012, 24),
      mats.darkSteel
    );
    magRing.rotation.x = Math.PI * 0.5;
    magRing.position.set(0, tubeCenterY, 0.062);
    scaled.add(magRing);

    const throwLever = new THREE.Mesh(new THREE.CylinderGeometry(0.0024, 0.0032, 0.018, 10), mats.chromeSteel);
    throwLever.rotation.z = -0.6;
    throwLever.position.set(0.016 * lensW, tubeCenterY + 0.015 * lensW, 0.062);
    scaled.add(throwLever);

    // Low-profile capped tactical turrets
    const elevCap = new THREE.Mesh(new THREE.CylinderGeometry(0.0072, 0.0076, 0.011, 18), mats.darkSteel);
    elevCap.position.set(0, tubeCenterY + 0.017 * lensW, -0.008);
    scaled.add(elevCap);

    const windCap = new THREE.Mesh(new THREE.CylinderGeometry(0.0068, 0.0072, 0.01, 18), mats.darkSteel);
    windCap.rotation.z = Math.PI * 0.5;
    windCap.position.set(0.017 * lensW, tubeCenterY, -0.008);
    scaled.add(windCap);

    // Rubberized eyepiece bezel + recessed dark chambers & coated lenses
    const eyeRing = new THREE.Mesh(new THREE.TorusGeometry(0.0162 * lensW, 0.0018, 10, 28), mats.rubber);
    eyeRing.position.set(0, tubeCenterY, 0.1045);
    scaled.add(eyeRing);

    const objBack = new THREE.Mesh(new THREE.CircleGeometry(0.0136 * lensW, 22), mats.rubber);
    objBack.position.set(0, tubeCenterY, -0.1075);
    objBack.rotation.y = Math.PI;
    scaled.add(objBack);

    const objLens = new THREE.Mesh(new THREE.CircleGeometry(0.0136 * lensW, 22), mats.opticLens);
    objLens.position.set(0, tubeCenterY, -0.111);
    objLens.rotation.y = Math.PI;
    scaled.add(objLens);

    const eyeBack = new THREE.Mesh(new THREE.CircleGeometry(0.0142 * lensW, 22), mats.rubber);
    eyeBack.position.set(0, tubeCenterY, 0.0965);
    scaled.add(eyeBack);

    const eyeLens = new THREE.Mesh(new THREE.CircleGeometry(0.0142 * lensW, 22), mats.opticLens);
    eyeLens.position.set(0, tubeCenterY, 0.0995);
    scaled.add(eyeLens);
  } else if (variant === 'thermal_holo') {
    // Armored Electro-Optical Thermal Sight: Dual-bolt QD base + armored chassis + Germanium bell + battery pod + eyecup
    scaled.add(buildRailClampBase(0.088, mats.darkSteel, mats.chromeSteel));
    addRiserPedestal(0.08, 0.024);
    const baseY = 0.007 + localRise;

    const neck = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.024, 0.012, 0.002), 0.082, 0.001, 0.001),
      mats.darkSteel
    );
    neck.position.set(0, baseY + 0.005, 0);
    scaled.add(neck);

    const bodyY = baseY + 0.026;
    // Chamfered armored thermal electronics housing
    const chassis = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.044 * lensW, 0.036, 0.0055), 0.094, 0.0022, 0.0022),
      mat
    );
    chassis.position.set(0, bodyY, 0);
    scaled.add(chassis);

    // Top 3-button tactile rubber control pad + glowing status dot
    const btnPad = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.026 * lensW, 0.004, 0.002), 0.042, 0.0008, 0.0008),
      mats.rubber
    );
    btnPad.position.set(0, bodyY + 0.019, 0.006);
    scaled.add(btnPad);

    const led = new THREE.Mesh(new THREE.SphereGeometry(0.0016, 8, 8), mats.emissiveAmber);
    led.position.set(0.008 * lensW, bodyY + 0.021, 0.02);
    scaled.add(led);

    // Right-side cylindrical CR123 battery compartment (watertight) with knurled chrome end-cap
    const batPod = new THREE.Mesh(
      buildLatheAlongZ([[0, -0.026], [0.0085, -0.026], [0.0085, 0.024], [0, 0.024]], 18),
      mats.darkSteel
    );
    batPod.position.set(0.026 * lensW, bodyY - 0.003, 0.008);
    scaled.add(batPod);

    const batCap = new THREE.Mesh(new THREE.CylinderGeometry(0.0092, 0.0092, 0.007, 16), mats.chromeSteel);
    batCap.rotation.x = Math.PI * 0.5;
    batCap.position.set(0.026 * lensW, bodyY - 0.003, -0.018);
    scaled.add(batCap);

    // Forward watertight stepped Germanium thermal objective lens shroud (outer wall UP, inner recess DOWN!)
    const objBell = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0.042],
          [0.0195 * lensW, 0.042],
          [0.0195 * lensW, 0.072],
          [0.016 * lensW, 0.072],
          [0.016 * lensW, 0.056],
          [0, 0.056],
        ],
        28
      ),
      mats.darkSteel
    );
    objBell.position.set(0, bodyY, 0);
    scaled.add(objBell);

    const germBack = new THREE.Mesh(new THREE.CircleGeometry(0.0156 * lensW, 22), mats.rubber);
    germBack.position.set(0, bodyY, -0.06);
    germBack.rotation.y = Math.PI;
    scaled.add(germBack);

    const germLens = new THREE.Mesh(new THREE.CircleGeometry(0.0156 * lensW, 22), mats.opticLens);
    germLens.position.set(0, bodyY, -0.063);
    germLens.rotation.y = Math.PI;
    scaled.add(germLens);

    // Rear watertight accordion rubber eyecup + recessed eyepiece lens
    const eyecup = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, -0.056],
          [0.0135 * lensW, -0.056],
          [0.0135 * lensW, -0.08],
          [0.017 * lensW, -0.08],
          [0.0155 * lensW, -0.068],
          [0.0172 * lensW, -0.058],
          [0.0155 * lensW, -0.046],
          [0, -0.046],
        ],
        24
      ),
      mats.rubber
    );
    eyecup.position.set(0, bodyY, 0);
    scaled.add(eyecup);

    const eyeLens = new THREE.Mesh(new THREE.CircleGeometry(0.013 * lensW, 20), mats.opticLens);
    eyeLens.position.set(0, bodyY, 0.059);
    scaled.add(eyeLens);
  } else {
    // sniper_scope: Dual rail clamps + SOLID machined ring pedestals + watertight scope tube + turrets
    const baseY = 0.007 + localRise;
    const tubeCenterY = baseY + 0.026;

    // Continuous cantilever scope base rail linking both clamps cleanly
    const baseBridge = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.021, 0.007, 0.002), 0.106, 0.0009, 0.0009),
      mats.darkSteel
    );
    baseBridge.position.set(0, 0.006 + localRise * 0.5, -0.002);
    scaled.add(baseBridge);

    for (const zPos of [-0.042, 0.038]) {
      const clamp = buildRailClampBase(0.024, mats.darkSteel, mats.chromeSteel);
      clamp.position.z = zPos;
      scaled.add(clamp);

      addRiserPedestal(0.02, 0.02, zPos);

      // Solid machined ring stem bridging baseY straight up into the bottom of the scope ring
      const stemH = tubeCenterY - baseY - 0.008;
      const ringStem = new THREE.Mesh(
        extrudeCenteredZ(roundedRectShape(0.018, stemH + 0.008, 0.002), 0.018, 0.0009, 0.0009),
        mats.darkSteel
      );
      ringStem.position.set(0, baseY + stemH * 0.5, zPos);
      scaled.add(ringStem);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.0165 * lensW, 0.004, 12, 24),
        mats.darkSteel
      );
      ring.position.set(0, tubeCenterY, zPos);
      scaled.add(ring);

      // Ring clamp cap screws
      const screw = new THREE.Mesh(new THREE.BoxGeometry(0.039 * lensW, 0.005, 0.008), mats.chromeSteel);
      screw.position.set(0, tubeCenterY, zPos);
      scaled.add(screw);
    }

    // Watertight closed manifold lathe with thick recessed ocular & objective sunshade walls (zero backface flicker!)
    const scopeTube = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, -0.103],
          [0.0155 * lensW, -0.103],
          [0.0155 * lensW, -0.115],
          [0.019 * lensW, -0.115],
          [0.019 * lensW, -0.075],
          [0.015 * lensW, -0.055],
          [0.015 * lensW, 0.048],
          [0.024 * lensW, 0.088],
          [0.024 * lensW, 0.145],
          [0.0205 * lensW, 0.145],
          [0.0205 * lensW, 0.13],
          [0, 0.13],
        ],
        32
      ),
      mat
    );
    scopeTube.position.set(0, tubeCenterY, 0);
    scaled.add(scopeTube);

    // Rubberized eyepiece diopter bezel ring on eye-side rim
    const eyeCup = new THREE.Mesh(
      new THREE.TorusGeometry(0.0176 * lensW, 0.002, 10, 28),
      mats.rubber
    );
    eyeCup.position.set(0, tubeCenterY, 0.1145);
    scaled.add(eyeCup);

    // Knurled precision elevation & windage turrets in contrasting chrome/dark steel
    const elev = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.009, 0.016, 18), mats.chromeSteel);
    elev.position.set(0, tubeCenterY + 0.019 * lensW, 0);
    scaled.add(elev);

    const wind = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.0085, 0.014, 18), mats.chromeSteel);
    wind.rotation.z = Math.PI * 0.5;
    wind.position.set(0.019 * lensW, tubeCenterY, 0);
    scaled.add(wind);

    // Recessed dark optical chamber backings + anti-reflective coated lenses cleanly inside both rims
    const objBack = new THREE.Mesh(new THREE.CircleGeometry(0.0202 * lensW, 24), mats.rubber);
    objBack.position.set(0, tubeCenterY, -0.1315);
    objBack.rotation.y = Math.PI;
    scaled.add(objBack);

    const objLens = new THREE.Mesh(new THREE.CircleGeometry(0.0202 * lensW, 24), mats.opticLens);
    objLens.position.set(0, tubeCenterY, -0.135);
    objLens.rotation.y = Math.PI;
    scaled.add(objLens);

    const eyeBack = new THREE.Mesh(new THREE.CircleGeometry(0.0153 * lensW, 22), mats.rubber);
    eyeBack.position.set(0, tubeCenterY, 0.1045);
    scaled.add(eyeBack);

    const eyeLens = new THREE.Mesh(new THREE.CircleGeometry(0.0153 * lensW, 22), mats.opticLens);
    eyeLens.position.set(0, tubeCenterY, 0.108);
    scaled.add(eyeLens);
  }

  tagSlot(g, 'optic', interactables);
  return g;
}

function buildUnderbarrelSlot(
  config: WeaponConfig,
  m: ResolvedMechanics,
  mats: WeaponMaterials,
  interactables: THREE.Mesh[]
): THREE.Group {
  const g = new THREE.Group();
  g.name = 'slot_underbarrel';
  const variant = m.effectiveUnderbarrel;
  if (variant === 'none') return g;

  const mat = mats.bySlot.underbarrel;
  const s = config.dimensions.underbarrelScale;
  const wScale = config.dimensions.underbarrelWidth;
  const drop = config.dimensions.underbarrelDrop;
  g.position.set(m.underbarrelMountPos.x, m.underbarrelMountPos.y, m.underbarrelMountPos.z);

  const scaled = new THREE.Group();
  scaled.scale.setScalar(s);
  g.add(scaled);

  const localDrop = drop / s;
  const isLongMount =
    variant === 'grenade_launcher' ||
    variant === 'masterkey_shotgun' ||
    variant === 'angled_grip' ||
    variant === 'handstop_kit';
  const clampLen =
    variant === 'grenade_launcher' || variant === 'masterkey_shotgun'
      ? 0.116
      : variant === 'angled_grip' || variant === 'handstop_kit'
        ? 0.088
        : variant === 'tactical_laser'
          ? 0.062
          : 0.044;

  // Flush Picatinny rail clamp base seated 2.5mm into handguard underside (zero gap!)
  const clamp = buildRailClampBase(clampLen, mats.darkSteel, mats.chromeSteel);
  clamp.rotation.z = Math.PI;
  clamp.position.y = 0.004;
  scaled.add(clamp);

  // Add twin cross-bolts on longer mounts for realistic tactical hardware detail
  if (isLongMount) {
    for (const zOff of [-clampLen * 0.34, clampLen * 0.34]) {
      const xBolt = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.0032, 0.029, 12), mats.chromeSteel);
      xBolt.rotation.z = Math.PI * 0.5;
      xBolt.position.set(0, 0.001, zOff);
      scaled.add(xBolt);
    }
  }

  // Seamless machined standoff riser if user increases underbarrelDrop
  if (localDrop > 0.0005) {
    const stem = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.02, localDrop + 0.006, 0.002), clampLen * 0.85, 0.0009, 0.0009),
      mats.darkSteel
    );
    stem.position.y = -0.004 - localDrop * 0.5;
    scaled.add(stem);
  }

  const bodyAnchor = new THREE.Group();
  bodyAnchor.position.y = -localDrop;
  scaled.add(bodyAnchor);

  if (variant === 'vertical_grip') {
    // Tactical Vertical Foregrip: Flared CNC heat-shield collar + contoured shaft + 5 traction rings + knurled end-cap
    const collar = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.028 * wScale, 0.011, 0.004), 0.036, 0.0014, 0.0014),
      mats.darkSteel
    );
    collar.position.set(0, -0.008, 0);
    bodyAnchor.add(collar);

    // Watertight contoured vertical grip shaft (strictly bottom-to-top increasing y for outward-facing normals!)
    const shaftLathe = new THREE.LatheGeometry(
      [
        new THREE.Vector2(0, -0.101),
        new THREE.Vector2(0.0118, -0.101),
        new THREE.Vector2(0.0138, -0.094),
        new THREE.Vector2(0.0148, -0.068),
        new THREE.Vector2(0.0142, -0.036),
        new THREE.Vector2(0.0115, -0.018),
        new THREE.Vector2(0.0125, -0.008),
        new THREE.Vector2(0, -0.008),
      ],
      28
    );
    const shaft = new THREE.Mesh(shaftLathe, mat);
    shaft.scale.set(wScale, 1, 1);
    bodyAnchor.add(shaft);

    // 5 recessed rubberized horizontal traction rings
    for (let i = 0; i < 5; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0144, 0.0014, 8, 24), mats.rubber);
      ring.rotation.x = Math.PI * 0.5;
      ring.scale.set(wScale, 1, 1);
      ring.position.set(0, -0.032 - i * 0.0125, 0);
      bodyAnchor.add(ring);
    }

    // Recessed side pressure-switch channel panel
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.048, 0.012), mats.rubber);
    panel.position.set(0.0142 * wScale, -0.056, 0);
    bodyAnchor.add(panel);

    // Threaded knurled storage end-cap
    const capRing = new THREE.Mesh(new THREE.CylinderGeometry(0.0134, 0.013, 0.009, 20), mats.chromeSteel);
    capRing.scale.set(wScale, 1, 1);
    capRing.position.set(0, -0.098, 0);
    bodyAnchor.add(capRing);

    const capBot = new THREE.Mesh(new THREE.CylinderGeometry(0.0122, 0.011, 0.005, 18), mats.darkSteel);
    capBot.scale.set(wScale, 1, 1);
    capBot.position.set(0, -0.103, 0);
    bodyAnchor.add(capBot);
  } else if (variant === 'angled_grip') {
    // Magpul AFG-2 Style Sculpted Angled Foregrip: Swept S-curve cradle + front barricade lip + rubber side bolsters
    const afgShape = new THREE.Shape();
    afgShape.moveTo(-0.048, 0); // rear (+Z)
    afgShape.lineTo(0.052, 0); // front (-Z)
    afgShape.lineTo(0.052, -0.014);
    afgShape.quadraticCurveTo(0.046, -0.029, 0.036, -0.028); // curved front finger stop hook
    afgShape.quadraticCurveTo(0.014, -0.022, -0.016, -0.04); // ergonomic angled palm ramp
    afgShape.quadraticCurveTo(-0.036, -0.044, -0.048, -0.022);
    afgShape.closePath();

    const core = new THREE.Mesh(extrudeProfileX(afgShape, 0.026 * wScale, 0.0028, 0.0028), mat);
    core.position.y = -0.004;
    bodyAnchor.add(core);

    // Pebbled rubberized side grip bolsters & central finger shelf insert
    const bolsterShape = new THREE.Shape();
    bolsterShape.moveTo(-0.038, -0.005);
    bolsterShape.lineTo(0.038, -0.005);
    bolsterShape.lineTo(0.026, -0.021);
    bolsterShape.lineTo(-0.018, -0.034);
    bolsterShape.lineTo(-0.038, -0.02);
    bolsterShape.closePath();
    const bolsters = new THREE.Mesh(extrudeProfileX(bolsterShape, 0.0295 * wScale, 0.0018, 0.0018), mats.rubber);
    bolsters.position.y = -0.004;
    bodyAnchor.add(bolsters);

    // Raised angled palm rib serrations along the sloped underside
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.022 * wScale, 0.003, 0.004), mats.darkSteel);
      rib.position.set(0, -0.027 - t * 0.013, -0.012 + t * 0.034);
      rib.rotation.x = 0.36;
      bodyAnchor.add(rib);
    }
  } else if (variant === 'handstop_kit') {
    // Minimalist CNC Low-Profile Handstop + Serrated Front Barricade Stop
    const railBar = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.024 * wScale, 0.008, 0.002), 0.096, 0.001, 0.001),
      mats.darkSteel
    );
    railBar.position.set(0, -0.007, 0);
    bodyAnchor.add(railBar);

    // Textured low-profile center rail cover insert
    const cover = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.0255 * wScale, 0.006, 0.002), 0.044, 0.001, 0.001),
      mats.rubber
    );
    cover.position.set(0, -0.01, -0.002);
    bodyAnchor.add(cover);

    // Swept rear index-finger retention hook
    const hookShape = new THREE.Shape();
    hookShape.moveTo(-0.046, 0);
    hookShape.lineTo(-0.018, 0);
    hookShape.quadraticCurveTo(-0.024, -0.02, -0.038, -0.038);
    hookShape.quadraticCurveTo(-0.048, -0.038, -0.048, -0.024);
    hookShape.closePath();
    const hook = new THREE.Mesh(extrudeProfileX(hookShape, 0.021 * wScale, 0.002, 0.002), mat);
    hook.position.y = -0.007;
    bodyAnchor.add(hook);

    // Compact front angled barricade stop with serrated chrome steel teeth
    const stopShape = new THREE.Shape();
    stopShape.moveTo(0.024, 0);
    stopShape.lineTo(0.048, 0);
    stopShape.lineTo(0.048, -0.022);
    stopShape.lineTo(0.032, -0.018);
    stopShape.closePath();
    const frontStop = new THREE.Mesh(extrudeProfileX(stopShape, 0.021 * wScale, 0.0016, 0.0016), mat);
    frontStop.position.y = -0.007;
    bodyAnchor.add(frontStop);

    for (let i = 0; i < 3; i++) {
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.016 * wScale, 0.0028, 0.0035), mats.chromeSteel);
      tooth.position.set(0, -0.013 - i * 0.0052, -0.0495);
      bodyAnchor.add(tooth);
    }
  } else if (variant === 'tactical_light') {
    // SureFire Scout Weapon Light + Offset Low-Profile Cantilever Mount + Crenellated Strike Bezel
    const lightX = 0.019 * wScale;
    const lightY = -0.018;

    // Angled offset Scout bracket arm bridging clamp to flashlight body
    const armStart = new THREE.Vector3(0, -0.006, 0);
    const armEnd = new THREE.Vector3(lightX, lightY, 0);
    bodyAnchor.add(buildStrutBetween(armStart, armEnd, 0.012, 0.032, mats.darkSteel));

    const mountRing = new THREE.Mesh(new THREE.TorusGeometry(0.0125, 0.0028, 10, 22), mats.darkSteel);
    mountRing.position.set(lightX, lightY, 0);
    bodyAnchor.add(mountRing);

    // Watertight machined aluminum flashlight body + cooling fins + stepped bezel head
    const body = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, -0.05],
          [0.0112, -0.05],
          [0.0118, -0.044],
          [0.0118, 0.022],
          [0.0155, 0.03],
          [0.0155, 0.06],
          [0.0126, 0.06],
          [0.0126, 0.051],
          [0, 0.044],
        ],
        28
      ),
      mat
    );
    body.position.set(lightX, lightY, 0);
    bodyAnchor.add(body);

    // 3 cooling fins behind bezel head
    for (let i = 0; i < 3; i++) {
      const fin = new THREE.Mesh(new THREE.TorusGeometry(0.0148, 0.0014, 8, 24), mats.darkSteel);
      fin.position.set(lightX, lightY, -0.032 - i * 0.0055);
      bodyAnchor.add(fin);
    }

    // Rear rubberized clicky tailcap switch + chrome shroud
    const tailSwitch = new THREE.Mesh(new THREE.CylinderGeometry(0.0072, 0.0078, 0.008, 16), mats.rubber);
    tailSwitch.rotation.x = Math.PI * 0.5;
    tailSwitch.position.set(lightX, lightY, 0.053);
    bodyAnchor.add(tailSwitch);

    // Crenellated strike bezel crown + parabolic chrome reflector + glowing warm LED emitter lens
    const bezelCrown = new THREE.Mesh(new THREE.TorusGeometry(0.0144, 0.0016, 8, 24), mats.chromeSteel);
    bezelCrown.position.set(lightX, lightY, -0.0605);
    bodyAnchor.add(bezelCrown);

    const reflector = new THREE.Mesh(new THREE.CircleGeometry(0.0122, 22), mats.chromeSteel);
    reflector.position.set(lightX, lightY, -0.0525);
    reflector.rotation.y = Math.PI;
    bodyAnchor.add(reflector);

    const ledCore = new THREE.Mesh(new THREE.SphereGeometry(0.0038, 12, 12), mats.emissiveAmber);
    ledCore.position.set(lightX, lightY, -0.053);
    bodyAnchor.add(ledCore);

    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.0124, 22), mats.opticLens);
    lens.position.set(lightX, lightY, -0.057);
    lens.rotation.y = Math.PI;
    bodyAnchor.add(lens);
  } else if (variant === 'tactical_laser') {
    // PEQ-15 / NGAL Armored Tactical Laser Aiming Module: Stepped body + hooded emitters + mode dial + battery pod
    const hw = 0.025 * wScale;
    const baseDeck = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(hw * 1.9, 0.019, 0.0035), 0.078, 0.0016, 0.0016),
      mat
    );
    baseDeck.position.set(0, -0.014, 0);
    bodyAnchor.add(baseDeck);

    // Asymmetric stepped emitter pods (classic PEQ-15 silhouette!)
    const leftPod = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(hw * 0.88, 0.024, 0.004), 0.068, 0.0018, 0.0018),
      mat
    );
    leftPod.position.set(-hw * 0.56, -0.017, -0.004);
    bodyAnchor.add(leftPod);

    const rightPod = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(hw * 0.82, 0.021, 0.0035), 0.058, 0.0016, 0.0016),
      mat
    );
    rightPod.position.set(hw * 0.56, -0.0155, -0.002);
    bodyAnchor.add(rightPod);

    // Dual hooded circular front emitter bezels (watertight): Left IR illuminator + Right visible red laser
    const irBezel = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [0.0082, 0],
          [0.0082, 0.012],
          [0.0064, 0.012],
          [0.0064, 0.004],
          [0, 0.004],
        ],
        20
      ),
      mats.darkSteel
    );
    irBezel.position.set(-hw * 0.56, -0.017, -0.036);
    bodyAnchor.add(irBezel);

    const irLens = new THREE.Mesh(new THREE.CircleGeometry(0.006, 18), mats.opticLens);
    irLens.position.set(-hw * 0.56, -0.017, -0.047);
    irLens.rotation.y = Math.PI;
    bodyAnchor.add(irLens);

    const visBezel = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [0.0068, 0],
          [0.0068, 0.011],
          [0.0052, 0.011],
          [0.0052, 0.004],
          [0, 0.004],
        ],
        20
      ),
      mats.darkSteel
    );
    visBezel.position.set(hw * 0.56, -0.0155, -0.031);
    bodyAnchor.add(visBezel);

    const redDiode = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0042, 0.005, 16), mats.emissiveRed);
    redDiode.rotation.x = Math.PI * 0.5;
    redDiode.position.set(hw * 0.56, -0.0155, -0.04);
    bodyAnchor.add(redDiode);

    // Bottom tactile fire button pad + knurled rear rotary mode-selector dial
    const firePad = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(hw * 0.72, 0.005, 0.002), 0.026, 0.0008, 0.0008),
      mats.rubber
    );
    firePad.position.set(0, -0.025, -0.012);
    bodyAnchor.add(firePad);

    const modeDial = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0082, 0.008, 18), mats.chromeSteel);
    modeDial.position.set(0, -0.026, 0.022);
    bodyAnchor.add(modeDial);

    // Threaded side battery cap
    const batCap = new THREE.Mesh(new THREE.CylinderGeometry(0.0072, 0.0072, 0.01, 16), mats.chromeSteel);
    batCap.rotation.x = Math.PI * 0.5;
    batCap.position.set(hw * 0.56, -0.0155, 0.031);
    bodyAnchor.add(batCap);
  } else if (variant === 'grenade_launcher') {
    // M203 / GP-25 40mm Underbarrel Grenade Launcher: Watertight closed-manifold 40mm barrel + breech + trigger guard + sight
    const tubeR = 0.0215 * Math.min(1.22, 0.55 + wScale * 0.45);
    const tubeY = -0.031;

    // Upper mounting spine hugging rail clamp cleanly
    const spine = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.026 * wScale, 0.014, 0.003), 0.14, 0.0014, 0.0014),
      mats.darkSteel
    );
    spine.position.set(0, -0.009, -0.012);
    bodyAnchor.add(spine);

    // Watertight closed-manifold 40mm launcher barrel with thick muzzle crown & deep dark bore chamber
    const barrel = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, -0.056],
          [tubeR * 0.96, -0.056],
          [tubeR, -0.048],
          [tubeR, 0.146],
          [tubeR * 0.92, 0.152],
          [tubeR * 0.78, 0.152],
          [tubeR * 0.78, 0.122],
          [0, 0.122],
        ],
        30
      ),
      mat
    );
    barrel.position.set(0, tubeY, 0);
    bodyAnchor.add(barrel);

    // Dark recessed 40mm muzzle throat interior disc
    const boreDark = new THREE.Mesh(new THREE.CircleGeometry(tubeR * 0.76, 24), mats.rubber);
    boreDark.position.set(0, tubeY, -0.132);
    boreDark.rotation.y = Math.PI;
    bodyAnchor.add(boreDark);

    // Ribbed sliding forend grip handguard sleeve (7 tactical ribs)
    for (let i = 0; i < 7; i++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(tubeR * 1.04, 0.0022, 10, 26), mats.rubber);
      rib.position.set(0, tubeY, -0.008 - i * 0.0175);
      bodyAnchor.add(rib);
    }

    // Machined rear breech receiver housing + chrome barrel-release latch
    const breech = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(tubeR * 2.15, 0.044, 0.004), 0.052, 0.0018, 0.0018),
      mats.darkSteel
    );
    breech.position.set(0, tubeY - 0.002, 0.048);
    bodyAnchor.add(breech);

    const latch = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.014, 0.022), mats.chromeSteel);
    latch.position.set(-tubeR * 1.12, tubeY + 0.002, 0.036);
    bodyAnchor.add(latch);

    // Curved steel trigger guard + forward-curved metallic 40mm trigger
    const tgShape = new THREE.Shape();
    tgShape.moveTo(0.016, 0.004);
    tgShape.lineTo(0.018, -0.022);
    tgShape.quadraticCurveTo(0.016, -0.028, 0.008, -0.028);
    tgShape.lineTo(-0.018, -0.028);
    tgShape.quadraticCurveTo(-0.024, -0.028, -0.024, -0.02);
    tgShape.lineTo(-0.024, 0.004);
    tgShape.lineTo(-0.019, 0.004);
    tgShape.lineTo(-0.019, -0.021);
    tgShape.lineTo(0.012, -0.021);
    tgShape.lineTo(0.011, 0.004);
    tgShape.closePath();
    const tg = new THREE.Mesh(extrudeProfileX(tgShape, 0.01, 0.0008, 0.0008), mats.darkSteel);
    tg.position.set(0, tubeY - 0.02, 0.052);
    bodyAnchor.add(tg);

    const glTrig = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.016, 0.005), mats.chromeSteel);
    glTrig.position.set(0, tubeY - 0.029, 0.05);
    glTrig.rotation.x = 0.25;
    bodyAnchor.add(glTrig);

    // Side-mounted folding leaf quadrant sight bracket
    const quadBase = new THREE.Mesh(new THREE.BoxGeometry(0.007, 0.016, 0.026), mats.darkSteel);
    quadBase.position.set(-tubeR * 1.16, tubeY + 0.018, 0.018);
    bodyAnchor.add(quadBase);

    const quadLeaf = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.022, 0.006), mats.chromeSteel);
    quadLeaf.position.set(-tubeR * 1.24, tubeY + 0.026, 0.018);
    bodyAnchor.add(quadLeaf);
  } else if (variant === 'masterkey_shotgun') {
    // Underbarrel 12-Gauge Breaching Shotgun (KAC Masterkey / M26 MASS)
    const recW = 0.032 * wScale;
    const recY = -0.028;

    // Upper mounting rail spine
    const spine = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.025 * wScale, 0.012, 0.0025), 0.14, 0.0012, 0.0012),
      mats.darkSteel
    );
    spine.position.set(0, -0.008, -0.006);
    bodyAnchor.add(spine);

    // Compact slab-sided 12ga receiver + ejection port + chrome bolt carrier
    const receiver = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(recW, 0.038, 0.0035), 0.105, 0.0018, 0.0018),
      mat
    );
    receiver.position.set(0, recY, 0.018);
    bodyAnchor.add(receiver);

    const ejectPort = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.014, 0.044), mats.chromeSteel);
    ejectPort.position.set(recW * 0.49, recY + 0.006, 0.014);
    bodyAnchor.add(ejectPort);

    // Heavy 12-gauge breaching barrel + crenellated standoff crown
    const brlY = recY + 0.008;
    const barrel = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [0.0128, 0],
          [0.0128, 0.142],
          [0.0142, 0.146],
          [0.0142, 0.158],
          [0.0102, 0.158],
          [0.0102, 0.136],
          [0, 0.136],
        ],
        26
      ),
      mats.darkSteel
    );
    barrel.position.set(0, brlY, -0.032);
    bodyAnchor.add(barrel);

    // Standoff door-breacher crown teeth
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const prong = new THREE.Mesh(new THREE.BoxGeometry(0.0026, 0.0026, 0.009), mats.chromeSteel);
      prong.position.set(Math.cos(a) * 0.0122, brlY + Math.sin(a) * 0.0122, -0.193);
      bodyAnchor.add(prong);
    }

    // Parallel lower 3-round tubular magazine (watertight) + knurled endcap + barrel clamp
    const magY = recY - 0.012;
    const magTube = new THREE.Mesh(
      buildLatheAlongZ(
        [
          [0, 0],
          [0.0102, 0],
          [0.0102, 0.125],
          [0.0112, 0.127],
          [0.0112, 0.136],
          [0.008, 0.138],
          [0, 0.138],
        ],
        22
      ),
      mats.darkSteel
    );
    magTube.position.set(0, magY, -0.032);
    bodyAnchor.add(magTube);

    const brlClamp = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.024, 0.042, 0.004), 0.012, 0.001, 0.001),
      mats.chromeSteel
    );
    brlClamp.position.set(0, recY - 0.002, -0.148);
    bodyAnchor.add(brlClamp);

    // Ribbed polymer pump-action forend slide
    const pump = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.03 * wScale, 0.025, 0.006), 0.072, 0.002, 0.002),
      mats.rubber
    );
    pump.position.set(0, magY - 0.001, -0.088);
    bodyAnchor.add(pump);

    for (let i = 0; i < 5; i++) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.032 * wScale, 0.0025, 0.0045), mats.darkSteel);
      rib.position.set(0, magY - 0.013, -0.062 - i * 0.013);
      bodyAnchor.add(rib);
    }

    // Rear trigger guard & metallic trigger
    const tg = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(0.012, 0.024, 0.003), 0.032, 0.001, 0.001),
      mats.darkSteel
    );
    tg.position.set(0, recY - 0.028, 0.048);
    bodyAnchor.add(tg);

    const sgTrig = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.015, 0.005), mats.chromeSteel);
    sgTrig.position.set(0, recY - 0.028, 0.046);
    sgTrig.rotation.x = 0.22;
    bodyAnchor.add(sgTrig);
  } else {
    // bipod: Harris / Atlas Precision Folding Bipod — pivoted leg groups so rubber feet are 100% locked with ZERO gap!
    const yokeW = 0.044 * wScale;
    const swivelCradle = new THREE.Mesh(
      extrudeCenteredZ(roundedRectShape(yokeW, 0.016, 0.0035), 0.042, 0.0016, 0.0016),
      mats.darkSteel
    );
    swivelCradle.position.set(0, -0.011, 0);
    bodyAnchor.add(swivelCradle);

    // Rear cant-tension adjustment throw lever + stainless pivot axle
    const cantLever = new THREE.Mesh(new THREE.CylinderGeometry(0.0038, 0.0044, 0.026, 12), mats.chromeSteel);
    cantLever.rotation.x = Math.PI * 0.42;
    cantLever.position.set(0, -0.018, 0.028);
    bodyAnchor.add(cantLever);

    const hingeAxle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0046, 0.0046, yokeW * 1.12, 16),
      mats.chromeSteel
    );
    hingeAxle.rotation.z = Math.PI * 0.5;
    hingeAxle.position.set(0, -0.017, -0.004);
    bodyAnchor.add(hingeAxle);

    for (const side of [-1, 1]) {
      // Pivoted leg assembly: outer tube, height notches, chrome locking collar, inner extension & rubber pod foot
      // ALL live in the exact same rotated local frame — mathematically impossible for feet to detach or float!
      const legPivot = new THREE.Group();
      legPivot.position.set(side * (0.018 * wScale), -0.017, -0.004);
      legPivot.rotation.z = side * 0.34;
      legPivot.rotation.x = -0.14;
      bodyAnchor.add(legPivot);

      // Upper hinge knuckle clevis
      const clevis = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0072, 0.0068, 0.018, 16),
        mats.darkSteel
      );
      clevis.position.y = -0.008;
      legPivot.add(clevis);

      // Outer steel bipod leg tube
      const outerTube = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0058, 0.0055, 0.095, 16),
        mat
      );
      outerTube.position.y = -0.062;
      legPivot.add(outerTube);

      // Machined height-indexing notch rings along outer tube
      for (let i = 0; i < 4; i++) {
        const notch = new THREE.Mesh(new THREE.TorusGeometry(0.0059, 0.0009, 8, 16), mats.darkSteel);
        notch.rotation.x = Math.PI * 0.5;
        notch.position.y = -0.032 - i * 0.018;
        legPivot.add(notch);
      }

      // Exposed external chrome return spring alongside upper leg
      const spring = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0026, 0.0026, 0.052, 10),
        mats.chromeSteel
      );
      spring.position.set(-side * 0.0085, -0.034, 0.004);
      spring.rotation.z = side * 0.08;
      legPivot.add(spring);

      // Spring-loaded knurled chrome leg-extension locking collar + release tab
      const lockCollar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0074, 0.0074, 0.013, 18),
        mats.chromeSteel
      );
      lockCollar.position.y = -0.112;
      legPivot.add(lockCollar);

      const relTab = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.008, 0.009), mats.darkSteel);
      relTab.position.set(side * 0.0075, -0.112, 0);
      legPivot.add(relTab);

      // Telescoping chrome stainless inner leg shaft
      const innerShaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0042, 0.0042, 0.054, 14),
        mats.chromeSteel
      );
      innerShaft.position.y = -0.142;
      legPivot.add(innerShaft);

      // Ribbed flared rubber pod foot locked squarely onto the exact bottom of innerShaft (y = -0.168)
      const footCollar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0062, 0.0086, 0.014, 18),
        mats.rubber
      );
      footCollar.position.y = -0.172;
      legPivot.add(footCollar);

      const footPad = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0094, 0.0104, 0.006, 18),
        mats.rubber
      );
      footPad.position.y = -0.181;
      legPivot.add(footPad);
    }
  }

  tagSlot(g, 'underbarrel', interactables);
  return g;
}

export function buildWeaponSceneGraph(
  config: WeaponConfig,
  m: ResolvedMechanics,
  mats: WeaponMaterials
): BuiltWeaponRig {
  const root = new THREE.Group();
  root.name = 'WeaponRoot';

  const bodyReceiver = new THREE.Group();
  bodyReceiver.name = 'Part_Receiver';
  root.add(bodyReceiver);

  const interactables: THREE.Mesh[] = [];

  const { receiverGroup, boltGroup, triggerGroup, selectorGroup } = buildReceiverSlot(
    config,
    m,
    mats,
    interactables
  );
  const barrelGroup = buildBarrelSlot(config, m, mats, interactables);
  const handguardGroup = buildHandguardSlot(config, m, mats, interactables);
  const stockGroup = buildStockSlot(config, m, mats, interactables);
  const magazineGroup = buildMagazineSlot(config, m, mats, interactables);
  const gripGroup = buildGripSlot(config, m, mats, interactables);
  const muzzleGroup = buildMuzzleSlot(config, m, mats, interactables);
  const opticGroup = buildOpticSlot(config, m, mats, interactables);
  const underbarrelGroup = buildUnderbarrelSlot(config, m, mats, interactables);

  // Static assemblies under Part_Receiver
  bodyReceiver.add(
    receiverGroup,
    barrelGroup,
    handguardGroup,
    gripGroup,
    muzzleGroup,
    opticGroup,
    underbarrelGroup
  );

  // Animatable assemblies directly under WeaponRoot for clean Godot 4 procedural control
  root.add(boltGroup, magazineGroup, triggerGroup, stockGroup, selectorGroup);

  // Standardized Godot 4.7.2 empty Object3D sockets directly under WeaponRoot
  const applySocketBasis = (
    socket: THREE.Object3D,
    forward: { x: number; y: number; z: number },
    upHint: { x: number; y: number; z: number }
  ) => {
    const fwd = new THREE.Vector3(forward.x, forward.y, forward.z).normalize();
    const upVec = new THREE.Vector3(upHint.x, upHint.y, upHint.z).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, upVec).normalize();
    const orthoUp = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const back = fwd.clone().negate();
    const basisMat = new THREE.Matrix4().makeBasis(right, orthoUp, back);
    socket.quaternion.setFromRotationMatrix(basisMat);
  };

  const socketMuzzle = new THREE.Object3D();
  socketMuzzle.name = 'Socket_Muzzle';
  socketMuzzle.position.set(m.socketMuzzlePos.x, m.socketMuzzlePos.y, m.socketMuzzlePos.z);

  const socketGripRight = new THREE.Object3D();
  socketGripRight.name = 'Socket_Grip_Right';
  socketGripRight.position.set(m.socketHandRPos.x, m.socketHandRPos.y, m.socketHandRPos.z);
  applySocketBasis(socketGripRight, m.socketHandRForward, m.socketHandRUp);

  const socketGripLeft = new THREE.Object3D();
  socketGripLeft.name = 'Socket_Grip_Left';
  socketGripLeft.position.set(m.socketHandLPos.x, m.socketHandLPos.y, m.socketHandLPos.z);
  applySocketBasis(socketGripLeft, m.socketHandLForward, m.socketHandLUp);

  const socketAds = new THREE.Object3D();
  socketAds.name = 'Socket_ADS';
  socketAds.position.set(m.socketAdsPos.x, m.socketAdsPos.y, m.socketAdsPos.z);

  const socketEject = new THREE.Object3D();
  socketEject.name = 'Socket_Eject';
  socketEject.position.set(m.socketEjectPos.x, m.socketEjectPos.y, m.socketEjectPos.z);

  const socketMag = new THREE.Object3D();
  socketMag.name = 'Socket_Mag';
  socketMag.position.set(m.magwellPos.x, m.magwellPos.y, m.magwellPos.z);

  const socketOptic = new THREE.Object3D();
  socketOptic.name = 'Socket_Optic';
  socketOptic.position.set(m.opticMountPos.x, m.opticMountPos.y, m.opticMountPos.z);

  root.add(
    socketMuzzle,
    socketGripRight,
    socketGripLeft,
    socketAds,
    socketEject,
    socketMag,
    socketOptic
  );

  let socketUnderbarrel: THREE.Object3D | null = null;
  if (config.parts.handguard !== 'none') {
    socketUnderbarrel = new THREE.Object3D();
    socketUnderbarrel.name = 'Socket_Underbarrel';
    socketUnderbarrel.position.set(
      m.underbarrelMountPos.x,
      m.underbarrelMountPos.y,
      m.underbarrelMountPos.z
    );
    root.add(socketUnderbarrel);
  }

  // Mixamo-standard gripping hand bone hierarchies (Wrist -> Thumb/Index/Middle/Ring/Pinky 1..4)
  const handRigSpec = resolveMixamoHandRig(config, m);
  const handBones = new Map<string, THREE.Bone>();

  const buildHandRigGroup = (side: 'Right' | 'Left', groupName: string): THREE.Group => {
    const grp = new THREE.Group();
    grp.name = groupName;
    grp.position.set(m.gripPivotPos.x, m.gripPivotPos.y, m.gripPivotPos.z);
    grp.userData = {
      naming_convention: 'mixamo',
      mixamo_prefix: 'mixamorig:',
      side: side.toLowerCase(),
      grip_style: side === 'Right' ? handRigSpec.right_grip_style : handRigSpec.left_grip_style,
      ...(side === 'Left'
        ? {
            underbarrel_variant: handRigSpec.underbarrel_variant,
            left_grip_placement: handRigSpec.left_grip_placement,
          }
        : {}),
    };

    const createBone = (boneName: string): THREE.Bone => {
      const spec = handRigSpec.bones[boneName];
      const bone = new THREE.Bone();
      bone.name = boneName;
      bone.userData = {
        mixamo_name: spec.mixamo_name,
        hand: spec.hand,
        finger: spec.finger,
        phalanx: spec.phalanx,
      };
      bone.position.set(spec.position[0], spec.position[1], spec.position[2]);
      bone.quaternion.set(
        spec.quaternion[0],
        spec.quaternion[1],
        spec.quaternion[2],
        spec.quaternion[3]
      );
      handBones.set(boneName, bone);
      return bone;
    };

    const wristName = `${side}Hand`;
    const wristBone = createBone(wristName);
    grp.add(wristBone);

    for (const finger of MIXAMO_FINGERS) {
      let parentBone: THREE.Bone = wristBone;
      for (let p = 1; p <= 4; p++) {
        const bone = createBone(`${wristName}${finger}${p}`);
        parentBone.add(bone);
        parentBone = bone;
      }
    }

    root.add(grp);
    return grp;
  };

  const handRigRight = buildHandRigGroup('Right', 'HandRig_Right');
  const handRigLeft = buildHandRigGroup('Left', 'HandRig_Left');

  // Normalize world-scale UVs on all BoxGeometry parts so zero panels suffer stretched textures
  const normalizedGeos = new Set<THREE.BufferGeometry>();
  let triangleCount = 0;
  for (const mesh of interactables) {
    const geo = mesh.geometry;
    if (geo.type === 'BoxGeometry' && !normalizedGeos.has(geo)) {
      applyBoxUVs(geo, 3.2);
      normalizedGeos.add(geo);
    }
    if (geo.index) {
      triangleCount += Math.floor(geo.index.count / 3);
    } else if (geo.attributes.position) {
      triangleCount += Math.floor(geo.attributes.position.count / 3);
    }
  }

  let partCount = 0;
  const slots: SlotId[] = [
    'receiver',
    'barrel',
    'handguard',
    'stock',
    'magazine',
    'grip',
    'muzzle',
    'optic',
    'underbarrel',
  ];
  for (const s of slots) {
    if (s === 'underbarrel') {
      if (m.effectiveUnderbarrel !== 'none') partCount++;
    } else if ((config.parts as unknown as Record<string, string>)[s] !== 'none') {
      partCount++;
    }
  }

  return {
    root,
    bodyReceiver,
    boneBolt: boltGroup,
    boneTrigger: triggerGroup,
    boneSelector: selectorGroup,
    boneStock: stockGroup,
    boneMagazine: magazineGroup,
    handRigRight,
    handRigLeft,
    handBones,
    socketMuzzle,
    socketGripRight,
    socketGripLeft,
    socketAds,
    socketEject,
    socketMag,
    socketOptic,
    socketUnderbarrel,
    slotGroups: {
      receiver: receiverGroup,
      barrel: barrelGroup,
      handguard: handguardGroup,
      stock: stockGroup,
      magazine: magazineGroup,
      grip: gripGroup,
      muzzle: muzzleGroup,
      optic: opticGroup,
      underbarrel: underbarrelGroup,
    },
    interactables,
    triangleCount,
    partCount,
  };
}

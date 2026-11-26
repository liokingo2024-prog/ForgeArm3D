import * as THREE from 'three';
import {
  GodotHandRigSpec,
  HandBoneNodeSpec,
  HandFingerName,
  HandSide,
  LeftGripStyle,
  ResolvedMechanics,
  WeaponConfig,
} from '../types/weapon';
import { clamp } from './weaponLogic';

export const MIXAMO_FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const;
export type MixamoFingerTitle = (typeof MIXAMO_FINGERS)[number];

export function getMixamoHandBoneNames(side: 'Right' | 'Left'): string[] {
  const wrist = `${side}Hand`;
  const names: string[] = [wrist];
  for (const finger of MIXAMO_FINGERS) {
    for (let p = 1; p <= 4; p++) {
      names.push(`${wrist}${finger}${p}`);
    }
  }
  return names;
}

export const MIXAMO_RIGHT_BONE_NAMES: string[] = getMixamoHandBoneNames('Right');
export const MIXAMO_LEFT_BONE_NAMES: string[] = getMixamoHandBoneNames('Left');
export const ALL_MIXAMO_HAND_BONE_NAMES: string[] = [
  ...MIXAMO_RIGHT_BONE_NAMES,
  ...MIXAMO_LEFT_BONE_NAMES,
];

function round4(v: number): number {
  const r = Math.round(v * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
}

interface JointChainInput {
  wrist: THREE.Vector3;
  wristDorsalHint: THREE.Vector3;
  fingers: Record<
    MixamoFingerTitle,
    {
      points: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
      hingeHint: THREE.Vector3;
    }
  >;
}

/**
 * Computes orthonormal world bone orientations following the Mixamo +Y longitudinal bone convention
 * (+Y points from parent joint to child joint; +Z points dorsal/outward; +X is the flexion hinge axis),
 * then derives exact parent-relative translation, quaternion, and XYZ Euler rotation.
 */
function buildHandBonesFromJoints(
  side: 'Right' | 'Left',
  rigRootName: string,
  input: JointChainInput
): Record<string, HandBoneNodeSpec> {
  const hand: HandSide = side === 'Right' ? 'right' : 'left';
  const wristName = `${side}Hand`;
  const bones: Record<string, HandBoneNodeSpec> = {};

  // Build orthonormal bone basis where +Y_local aligns strictly with yDir.
  const makeBoneQuat = (yDirRaw: THREE.Vector3, hingeHintRaw: THREE.Vector3): THREE.Quaternion => {
    const yAxis = yDirRaw.clone().normalize();
    let xAxis = hingeHintRaw
      .clone()
      .addScaledVector(yAxis, -hingeHintRaw.dot(yAxis));
    if (xAxis.lengthSq() < 1e-6) {
      const fallback = Math.abs(yAxis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      xAxis = new THREE.Vector3().crossVectors(yAxis, fallback);
    }
    xAxis.normalize();
    const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
    xAxis.crossVectors(yAxis, zAxis).normalize();
    const m = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
    return new THREE.Quaternion().setFromRotationMatrix(m);
  };

  // Wrist orientation: +Y toward Middle1 MCP knuckle, +Z dorsal outward hint
  const middleKnuckle = input.fingers.Middle.points[0];
  const wristY = middleKnuckle.clone().sub(input.wrist).normalize();
  const dorsal = input.wristDorsalHint.clone().normalize();
  let wristX = new THREE.Vector3().crossVectors(wristY, dorsal);
  if (wristX.lengthSq() < 1e-6) {
    wristX = new THREE.Vector3(0, 0, 1);
  }
  wristX.normalize();
  const wristZ = new THREE.Vector3().crossVectors(wristX, wristY).normalize();
  const wristQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(wristX, wristY, wristZ)
  );
  const wristEuler = new THREE.Euler().setFromQuaternion(wristQuat, 'XYZ');

  bones[wristName] = {
    name: wristName,
    mixamo_name: `mixamorig:${wristName}`,
    parent: rigRootName,
    hand,
    finger: 'wrist',
    phalanx: 0,
    position: [round4(input.wrist.x), round4(input.wrist.y), round4(input.wrist.z)],
    rotation: [round4(wristEuler.x), round4(wristEuler.y), round4(wristEuler.z)],
    quaternion: [round4(wristQuat.x), round4(wristQuat.y), round4(wristQuat.z), round4(wristQuat.w)],
    world_position: [round4(input.wrist.x), round4(input.wrist.y), round4(input.wrist.z)],
    bone_forward: [round4(wristY.x), round4(wristY.y), round4(wristY.z)],
    bone_normal: [round4(wristZ.x), round4(wristZ.y), round4(wristZ.z)],
  };

  for (const fingerTitle of MIXAMO_FINGERS) {
    const fingerKey = fingerTitle.toLowerCase() as HandFingerName;
    const { points, hingeHint } = input.fingers[fingerTitle];

    // Derive clean anatomical flexion axis from finger curl plane when non-collinear
    const seg12 = points[1].clone().sub(points[0]);
    const seg23 = points[2].clone().sub(points[1]);
    const planeCross = new THREE.Vector3().crossVectors(seg12, seg23);
    const baseHinge =
      planeCross.lengthSq() > 1e-7
        ? planeCross.dot(hingeHint) >= 0
          ? planeCross.normalize()
          : planeCross.negate().normalize()
        : hingeHint.clone().normalize();

    let parentName = wristName;
    let parentWorldPos = input.wrist;
    let parentWorldQuat = wristQuat;

    for (let idx = 0; idx < 4; idx++) {
      const phalanx = (idx + 1) as 1 | 2 | 3 | 4;
      const boneName = `${wristName}${fingerTitle}${phalanx}`;
      const worldPos = points[idx];
      const nextPos = idx < 3 ? points[idx + 1] : null;
      const dir = nextPos
        ? nextPos.clone().sub(worldPos).normalize()
        : worldPos.clone().sub(points[idx - 1]).normalize();

      const worldQuat =
        idx < 3 ? makeBoneQuat(dir, baseHinge) : parentWorldQuat.clone();

      const parentInv = parentWorldQuat.clone().invert();
      const localPos = worldPos.clone().sub(parentWorldPos).applyQuaternion(parentInv);
      const localQuat = parentInv.clone().multiply(worldQuat).normalize();
      const localEuler = new THREE.Euler().setFromQuaternion(localQuat, 'XYZ');

      const worldFwd = new THREE.Vector3(0, 1, 0).applyQuaternion(worldQuat).normalize();
      const worldNorm = new THREE.Vector3(0, 0, 1).applyQuaternion(worldQuat).normalize();

      bones[boneName] = {
        name: boneName,
        mixamo_name: `mixamorig:${boneName}`,
        parent: parentName,
        hand,
        finger: fingerKey,
        phalanx,
        position: [round4(localPos.x), round4(localPos.y), round4(localPos.z)],
        rotation: [round4(localEuler.x), round4(localEuler.y), round4(localEuler.z)],
        quaternion: [round4(localQuat.x), round4(localQuat.y), round4(localQuat.z), round4(localQuat.w)],
        world_position: [round4(worldPos.x), round4(worldPos.y), round4(worldPos.z)],
        bone_forward: [round4(worldFwd.x), round4(worldFwd.y), round4(worldFwd.z)],
        bone_normal: [round4(worldNorm.x), round4(worldNorm.y), round4(worldNorm.z)],
      };

      parentName = boneName;
      parentWorldPos = worldPos;
      parentWorldQuat = worldQuat;
    }
  }

  return bones;
}

/**
 * Resolves full Mixamo-standard 42-bone gripping hand hierarchies (RightHand + 5x4 fingers,
 * LeftHand + 5x4 fingers) in WeaponRoot coordinates (origin = gripPivotPos = (0,0,0), -Z forward, +Y up, meters).
 */
export function resolveMixamoHandRig(
  config: WeaponConfig,
  m: ResolvedMechanics
): GodotHandRigSpec {
  const { parts, dimensions: d } = config;
  const origin = new THREE.Vector3(m.gripPivotPos.x, m.gripPivotPos.y, m.gripPivotPos.z);

  // =========================================================================
  // 1. RIGHT HAND (Pistol Grip + Index Trigger Reach)
  // =========================================================================
  const rRight = new THREE.Vector3(m.socketHandRNormal.x, m.socketHandRNormal.y, m.socketHandRNormal.z).normalize();
  const rUp = new THREE.Vector3(m.socketHandRUp.x, m.socketHandRUp.y, m.socketHandRUp.z).normalize();
  const rFwd = new THREE.Vector3(m.socketHandRForward.x, m.socketHandRForward.y, m.socketHandRForward.z).normalize();

  const gripHalfW = Math.max(0.014, m.socketHandRPos.x);
  const gripLenScale = clamp(d.gripLength / 0.106, 0.84, 1.15);
  const gripPoint = (r: number, u: number, f: number): THREE.Vector3 =>
    new THREE.Vector3()
      .addScaledVector(rRight, r)
      .addScaledVector(rUp, u * gripLenScale)
      .addScaledVector(rFwd, f);

  // Outer clearances around grip mesh (frontstrap grooves peak ~0.0245m, backstrap ~0.028m)
  const rFrontClear = 0.0285;
  const rRightKnuckle = gripHalfW + 0.011;
  const rLeftWrap = -(gripHalfW + 0.007);

  const rightWrist = gripPoint(gripHalfW + 0.022, -0.021, -0.056);

  // Trigger pad world position relative to WeaponRoot origin (0,0,0)
  const trigOriginRel = new THREE.Vector3(
    m.triggerPivotPos.x - origin.x,
    m.triggerPivotPos.y - origin.y,
    m.triggerPivotPos.z - origin.z
  );
  const indexTargetTip = new THREE.Vector3(
    0.003,
    trigOriginRel.y - 0.014,
    trigOriginRel.z - 0.004
  );
  const indexDip = new THREE.Vector3(
    0.013,
    trigOriginRel.y - 0.013,
    trigOriginRel.z + 0.003
  );
  const indexMcp = gripPoint(gripHalfW + 0.0115, 0.030, 0.008);
  const indexPip = new THREE.Vector3(
    Math.max(gripHalfW + 0.010, d.receiverWidth * 0.5 + 0.0085),
    (indexMcp.y + indexDip.y) * 0.52,
    (indexMcp.z + indexDip.z) * 0.48
  );

  const rightJoints: JointChainInput = {
    wrist: rightWrist,
    wristDorsalHint: rRight,
    fingers: {
      Thumb: {
        points: [
          gripPoint(gripHalfW + 0.015, 0.004, -0.032),
          gripPoint(gripHalfW + 0.010, 0.029, -0.028),
          gripPoint(0.002, 0.037, -0.031),
          gripPoint(-(gripHalfW + 0.0055), 0.034, -0.017),
        ],
        hingeHint: rUp,
      },
      Index: {
        points: [indexMcp, indexPip, indexDip, indexTargetTip],
        hingeHint: rUp,
      },
      Middle: {
        points: [
          gripPoint(rRightKnuckle, 0.009, 0.008),
          gripPoint(-0.004, 0.009, rFrontClear),
          gripPoint(rLeftWrap, 0.008, 0.011),
          gripPoint(-(gripHalfW + 0.005), 0.007, -0.009),
        ],
        hingeHint: rUp,
      },
      Ring: {
        points: [
          gripPoint(rRightKnuckle - 0.001, -0.010, 0.006),
          gripPoint(-0.003, -0.010, rFrontClear - 0.001),
          gripPoint(rLeftWrap + 0.0005, -0.011, 0.010),
          gripPoint(-(gripHalfW + 0.0045), -0.011, -0.008),
        ],
        hingeHint: rUp,
      },
      Pinky: {
        points: [
          gripPoint(rRightKnuckle - 0.002, -0.028, 0.003),
          gripPoint(-0.001, -0.028, rFrontClear - 0.003),
          gripPoint(rLeftWrap + 0.0015, -0.029, 0.009),
          gripPoint(-(gripHalfW + 0.004), -0.029, -0.006),
        ],
        hingeHint: rUp,
      },
    },
  };

  // =========================================================================
  // 2. LEFT HAND (Support Foregrip / Handguard Cradle / Bare Barrel)
  // =========================================================================
  const effectiveUb = m.effectiveUnderbarrel;
  let leftGripStyle: LeftGripStyle = 'handguard_cradle';
  let leftJoints: JointChainInput;

  const handLRel = new THREE.Vector3(
    m.socketHandLPos.x - origin.x,
    m.socketHandLPos.y - origin.y,
    m.socketHandLPos.z - origin.z
  );

  if (effectiveUb === 'vertical_grip') {
    leftGripStyle = 'vertical_grip';
    const ubScale = d.underbarrelScale;
    const ubWScale = d.underbarrelWidth;
    const shaftR = 0.0158 * ubWScale * ubScale + 0.0025;
    const cy = handLRel.y;
    const cz = handLRel.z;
    const vLenScale = clamp(ubScale, 0.78, 1.25);

    const vPt = (x: number, dy: number, dz: number): THREE.Vector3 =>
      new THREE.Vector3(x, cy + dy * vLenScale, cz + dz);

    const vFrontClear = -(shaftR + 0.011);
    const vLeftK = -(shaftR + 0.010);
    const vRightWrap = shaftR + 0.0075;

    leftJoints = {
      wrist: new THREE.Vector3(-(shaftR + 0.023), cy - 0.021 * vLenScale, cz + 0.056),
      wristDorsalHint: new THREE.Vector3(-1, 0, 0),
      fingers: {
        Thumb: {
          points: [
            vPt(-(shaftR + 0.015), 0.006, 0.032),
            vPt(-(shaftR + 0.010), 0.029, 0.021),
            vPt(-(shaftR + 0.005), 0.038, 0.002),
            vPt(-shaftR * 0.35, 0.038, -0.016),
          ],
          hingeHint: new THREE.Vector3(0, 1, 0),
        },
        Index: {
          points: [
            vPt(vLeftK, 0.023, -0.008),
            vPt(0.002, 0.023, vFrontClear),
            vPt(vRightWrap, 0.022, -0.004),
            vPt(shaftR + 0.005, 0.021, 0.014),
          ],
          hingeHint: new THREE.Vector3(0, 1, 0),
        },
        Middle: {
          points: [
            vPt(vLeftK, 0.007, -0.008),
            vPt(0.003, 0.007, vFrontClear - 0.001),
            vPt(vRightWrap + 0.0005, 0.006, -0.003),
            vPt(shaftR + 0.0055, 0.005, 0.015),
          ],
          hingeHint: new THREE.Vector3(0, 1, 0),
        },
        Ring: {
          points: [
            vPt(vLeftK + 0.001, -0.010, -0.006),
            vPt(0.002, -0.010, vFrontClear),
            vPt(vRightWrap, -0.011, -0.002),
            vPt(shaftR + 0.005, -0.012, 0.014),
          ],
          hingeHint: new THREE.Vector3(0, 1, 0),
        },
        Pinky: {
          points: [
            vPt(vLeftK + 0.002, -0.025, -0.004),
            vPt(0.001, -0.025, vFrontClear + 0.002),
            vPt(vRightWrap - 0.001, -0.026, 0.000),
            vPt(shaftR + 0.004, -0.026, 0.012),
          ],
          hingeHint: new THREE.Vector3(0, 1, 0),
        },
      },
    };
  } else {
    // Horizontal / angled cradle / attachment-cleared wrap
    // (fingers curl around bottom onto +X flank; thumb climbs -X flank)
    const ubScale = d.underbarrelScale;
    const wrapHalfW = m.leftGripEnvelopeHalfW;
    const wrapRightHalfW = m.leftGripEnvelopeRightClearX;
    const wrapCenterY = m.leftGripEnvelopeCenterY - origin.y;
    const wrapBotY = m.leftGripEnvelopeBotY - origin.y;
    const centerZ = m.leftGripCenterZ - origin.z;
    let pitchRad = 0;

    if (parts.handguard === 'none') {
      leftGripStyle = 'bare_barrel';
    } else if (effectiveUb === 'angled_grip') {
      leftGripStyle = 'angled_grip';
      pitchRad = 0.28;
    } else if (
      effectiveUb === 'grenade_launcher' ||
      effectiveUb === 'masterkey_shotgun' ||
      effectiveUb === 'handstop_kit' ||
      m.leftGripPlacement === 'wrapped_attachment'
    ) {
      leftGripStyle = 'underbarrel_cradle';
    } else {
      leftGripStyle = 'handguard_cradle';
    }

    const sinP = Math.sin(pitchRad);
    const cosP = Math.cos(pitchRad);
    const cradlePt = (x: number, y: number, zOff: number): THREE.Vector3 => {
      const dy = y - wrapCenterY;
      // Rotate pitch around X axis so -Z goes up (+Y) when pitched
      const ry = dy * cosP - zOff * sinP;
      const rz = zOff * cosP + dy * sinP;
      return new THREE.Vector3(x, wrapCenterY + ry, centerZ + rz);
    };

    const hingeZ = new THREE.Vector3(0, sinP, -cosP).normalize();
    const rightFlank = wrapRightHalfW + 0.009;
    const leftFlank = -(wrapHalfW + 0.0085);
    const sideSpan = Math.max(0.018, wrapCenterY - wrapBotY);

    const makeCradleFinger = (
      zOff: number,
      fingerScale: number
    ): [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] => {
      const pipY = wrapBotY + sideSpan * 0.46;
      const dipY = pipY + 0.024 * fingerScale;
      const tipY = dipY + 0.018 * fingerScale;
      return [
        cradlePt(wrapRightHalfW * 0.34, wrapBotY - 0.010, zOff * 0.72),
        cradlePt(rightFlank, pipY, zOff),
        cradlePt(rightFlank - 0.001, dipY, zOff),
        cradlePt(wrapRightHalfW + 0.005, tipY, zOff),
      ];
    };

    // CNC Handstop: fit Index..Pinky cleanly inside the pocket between front barricade stop and rear hook
    const isHandstopPocket = m.leftGripPlacement === 'handstop_pocket';
    const pocketScale = isHandstopPocket ? clamp(ubScale, 0.78, 1.08) : 1.0;
    const zIndex = (isHandstopPocket ? -0.016 : -0.026) * pocketScale;
    const zMiddle = (isHandstopPocket ? -0.005 : -0.008) * pocketScale;
    const zRing = (isHandstopPocket ? 0.006 : 0.009) * pocketScale;
    const zPinky = (isHandstopPocket ? 0.016 : 0.025) * pocketScale;

    const wristZOff =
      effectiveUb === 'bipod' && m.leftGripPlacement === 'front_of_attachment'
        ? 0.036
        : 0.050;

    leftJoints = {
      wrist: cradlePt(-(wrapHalfW + 0.023), wrapBotY - 0.036, wristZOff),
      wristDorsalHint: new THREE.Vector3(-0.78, -0.62, 0).normalize(),
      fingers: {
        Thumb: {
          points: [
            cradlePt(leftFlank - 0.009, wrapBotY - 0.014, 0.026 * pocketScale),
            cradlePt(leftFlank - 0.003, wrapBotY + sideSpan * 0.35, 0.006 * pocketScale),
            cradlePt(leftFlank, wrapCenterY + 0.004, -0.016 * pocketScale),
            cradlePt(leftFlank + 0.002, wrapCenterY + 0.018, -0.036 * pocketScale),
          ],
          hingeHint: new THREE.Vector3(0, 1, 0),
        },
        Index: {
          points: makeCradleFinger(zIndex, 0.96),
          hingeHint: hingeZ,
        },
        Middle: {
          points: makeCradleFinger(zMiddle, 1.05),
          hingeHint: hingeZ,
        },
        Ring: {
          points: makeCradleFinger(zRing, 0.96),
          hingeHint: hingeZ,
        },
        Pinky: {
          points: makeCradleFinger(zPinky, 0.80),
          hingeHint: hingeZ,
        },
      },
    };
  }

  const rightBones = buildHandBonesFromJoints('Right', 'HandRig_Right', rightJoints);
  const leftBones = buildHandBonesFromJoints('Left', 'HandRig_Left', leftJoints);
  const bones: Record<string, HandBoneNodeSpec> = {
    ...rightBones,
    ...leftBones,
  };

  return {
    naming_convention: 'mixamo',
    mixamo_prefix: 'mixamorig:',
    bone_longitudinal_axis: '+Y',
    wrist_bones: {
      right: 'RightHand',
      left: 'LeftHand',
    },
    wrist_mixamo_names: {
      right: 'mixamorig:RightHand',
      left: 'mixamorig:LeftHand',
    },
    total_bones: Object.keys(bones).length,
    right_grip_style: 'pistol_grip',
    left_grip_style: leftGripStyle,
    left_grip_placement: m.leftGripPlacement,
    underbarrel_variant: effectiveUb,
    bones,
  };
}

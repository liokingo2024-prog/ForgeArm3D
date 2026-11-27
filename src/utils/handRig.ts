import * as THREE from 'three';
import {
  BoneAttachSpec,
  GodotHandRigSpec,
  GripSolveVectors,
  HandBoneNodeSpec,
  HandFingerName,
  HandSide,
  ResolvedMechanics,
  WeaponConfig,
} from '../types/weapon';
import { clamp } from './weaponLogic';

export const MIXAMO_FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const;
export type MixamoFingerTitle = (typeof MIXAMO_FINGERS)[number];

export const MIXAMO_BONE_PREFIX = 'mixamorig1_';

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

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

function eulerToDegTuple(e: THREE.Euler): [number, number, number] {
  const k = 180 / Math.PI;
  return [round2(e.x * k), round2(e.y * k), round2(e.z * k)];
}

interface JointChainInput {
  wrist: THREE.Vector3;
  wristPalmHint: THREE.Vector3;
  fingers: Record<
    MixamoFingerTitle,
    {
      points: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
      hingeHint: THREE.Vector3;
    }
  >;
}

interface BuiltHandResult {
  bones: Record<string, HandBoneNodeSpec>;
  wristPos: THREE.Vector3;
  wristQuat: THREE.Quaternion;
  gripSolve: GripSolveVectors;
}

/**
 * Computes orthonormal weapon-space bone orientations matching the Mixamo skeleton convention
 * verified on soldier_withskin.glb:
 *   +Y_bone = longitudinal (parent joint -> child joint; wrist -> Middle1 knuckle)
 *   +Z_bone = palmar (points out of the palm into the grip/handguard so +rx curls into palm)
 *   +X_bone = +Y_bone × +Z_bone (radial/thumbward on RightHand; ulnar/pinkyward on LeftHand)
 */
function buildHandBonesFromJoints(
  side: 'Right' | 'Left',
  forearmParentMixamoName: string,
  socketPosRelOrigin: THREE.Vector3,
  input: JointChainInput
): BuiltHandResult {
  const hand: HandSide = side === 'Right' ? 'right' : 'left';
  const wristName = `${side}Hand`;
  const bones: Record<string, HandBoneNodeSpec> = {};

  // Orthonormal bone basis where +Y_local aligns strictly with yDirRaw and +X_local aligns with hingeHintRaw.
  const makeBoneQuat = (yDirRaw: THREE.Vector3, hingeHintRaw: THREE.Vector3): THREE.Quaternion => {
    const yAxis = yDirRaw.clone().normalize();
    let xAxis = hingeHintRaw.clone().addScaledVector(yAxis, -hingeHintRaw.dot(yAxis));
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

  // Wrist orientation matching Mixamo soldier_withskin.glb:
  // +Y_hand = wrist -> Middle1 MCP knuckle (longitudinal axis, finger_axis: "+Y")
  // +Z_hand = palmar normal (out of palm into weapon surface)
  // +X_hand = +Y_hand × +Z_hand (toward thumb on RightHand, toward pinky on LeftHand)
  const middleKnuckle = input.fingers.Middle.points[0];
  const wristY = middleKnuckle.clone().sub(input.wrist).normalize();
  const palmHint = input.wristPalmHint.clone().normalize();

  let wristZ = palmHint.clone().addScaledVector(wristY, -palmHint.dot(wristY));
  if (wristZ.lengthSq() < 1e-6) {
    const fallback = Math.abs(wristY.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    wristZ = new THREE.Vector3().crossVectors(wristY, fallback);
  }
  wristZ.normalize();
  const wristX = new THREE.Vector3().crossVectors(wristY, wristZ).normalize();
  wristZ.crossVectors(wristX, wristY).normalize();

  const wristQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(wristX, wristY, wristZ)
  );
  const wristEuler = new THREE.Euler().setFromQuaternion(wristQuat, 'XYZ');

  const wristOffset = input.wrist.clone().sub(socketPosRelOrigin);
  const gripSolve: GripSolveVectors = {
    wrist_offset_weapon_space: [
      round4(wristOffset.x),
      round4(wristOffset.y),
      round4(wristOffset.z),
    ],
    hand_y_axis: [round4(wristY.x), round4(wristY.y), round4(wristY.z)],
    hand_x_axis: [round4(wristX.x), round4(wristX.y), round4(wristX.z)],
    hand_z_axis: [round4(wristZ.x), round4(wristZ.y), round4(wristZ.z)],
  };

  const wristRotRad: [number, number, number] = [
    round4(wristEuler.x),
    round4(wristEuler.y),
    round4(wristEuler.z),
  ];
  const wristRotDeg = eulerToDegTuple(wristEuler);
  const wristQuatArr: [number, number, number, number] = [
    round4(wristQuat.x),
    round4(wristQuat.y),
    round4(wristQuat.z),
    round4(wristQuat.w),
  ];

  const palmLengthM = round4(middleKnuckle.distanceTo(input.wrist));

  bones[wristName] = {
    name: wristName,
    mixamo_name: `${MIXAMO_BONE_PREFIX}${wristName}`,
    parent: forearmParentMixamoName,
    hand,
    finger: 'wrist',
    phalanx: 0,
    position: [round4(input.wrist.x), round4(input.wrist.y), round4(input.wrist.z)],
    rotation: wristRotRad,
    rotation_deg: wristRotDeg,
    quaternion: wristQuatArr,
    world_position: [round4(input.wrist.x), round4(input.wrist.y), round4(input.wrist.z)],
    world_rotation: wristRotRad,
    world_rotation_deg: wristRotDeg,
    world_quaternion: wristQuatArr,
    right_hand_position: [0, 0, 0],
    bone_length_m: palmLengthM,
    bone_forward: [round4(wristY.x), round4(wristY.y), round4(wristY.z)],
    bone_normal: [round4(wristZ.x), round4(wristZ.y), round4(wristZ.z)],
  };

  for (const fingerTitle of MIXAMO_FINGERS) {
    const fingerKey = fingerTitle.toLowerCase() as HandFingerName;
    const { points, hingeHint } = input.fingers[fingerTitle];

    // Derive anatomical flexion hinge axis from finger curl plane when non-collinear
    const seg12 = points[1].clone().sub(points[0]);
    const seg23 = points[2].clone().sub(points[1]);
    const planeCross = new THREE.Vector3().crossVectors(seg12, seg23);
    const baseHinge =
      planeCross.lengthSq() > 1e-7
        ? planeCross.dot(hingeHint) >= 0
          ? planeCross.normalize()
          : planeCross.negate().normalize()
        : hingeHint.clone().normalize();

    let parentShortName = wristName;
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

      const worldQuat = idx < 3 ? makeBoneQuat(dir, baseHinge) : parentWorldQuat.clone();

      const parentInv = parentWorldQuat.clone().invert();
      const localPos = worldPos.clone().sub(parentWorldPos).applyQuaternion(parentInv);
      const localQuat = parentInv.clone().multiply(worldQuat).normalize();
      const localEuler = new THREE.Euler().setFromQuaternion(localQuat, 'XYZ');
      const worldEuler = new THREE.Euler().setFromQuaternion(worldQuat, 'XYZ');

      const worldFwd = new THREE.Vector3(0, 1, 0).applyQuaternion(worldQuat).normalize();
      const worldPalmNorm = new THREE.Vector3(0, 0, 1).applyQuaternion(worldQuat).normalize();
      const segLenM = nextPos ? round4(nextPos.distanceTo(worldPos)) : 0;

      bones[boneName] = {
        name: boneName,
        mixamo_name: `${MIXAMO_BONE_PREFIX}${boneName}`,
        parent: `${MIXAMO_BONE_PREFIX}${parentShortName}`,
        hand,
        finger: fingerKey,
        phalanx,
        position: [round4(localPos.x), round4(localPos.y), round4(localPos.z)],
        rotation: [round4(localEuler.x), round4(localEuler.y), round4(localEuler.z)],
        rotation_deg: eulerToDegTuple(localEuler),
        quaternion: [round4(localQuat.x), round4(localQuat.y), round4(localQuat.z), round4(localQuat.w)],
        world_position: [round4(worldPos.x), round4(worldPos.y), round4(worldPos.z)],
        world_rotation: [round4(worldEuler.x), round4(worldEuler.y), round4(worldEuler.z)],
        world_rotation_deg: eulerToDegTuple(worldEuler),
        world_quaternion: [
          round4(worldQuat.x),
          round4(worldQuat.y),
          round4(worldQuat.z),
          round4(worldQuat.w),
        ],
        right_hand_position: [0, 0, 0],
        bone_length_m: segLenM,
        bone_forward: [round4(worldFwd.x), round4(worldFwd.y), round4(worldFwd.z)],
        bone_normal: [round4(worldPalmNorm.x), round4(worldPalmNorm.y), round4(worldPalmNorm.z)],
      };

      parentShortName = boneName;
      parentWorldPos = worldPos;
      parentWorldQuat = worldQuat;
    }
  }

  return {
    bones,
    wristPos: input.wrist.clone(),
    wristQuat,
    gripSolve,
  };
}

/**
 * Resolves Mixamo-standard gripping hand hierarchies and BoneAttachment3D offsets
 * in WeaponRoot coordinates (origin = gripPivotPos = (0,0,0), -Z forward, +Y up, meters).
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

  const gripHalfW = Math.max(0.014, m.rightGripSurfaceHalfW);
  const gripLenScale = clamp(d.gripLength / 0.106, 0.84, 1.15);
  const gripPoint = (r: number, u: number, f: number): THREE.Vector3 =>
    new THREE.Vector3()
      .addScaledVector(rRight, r)
      .addScaledVector(rUp, u * gripLenScale)
      .addScaledVector(rFwd, f);

  const rFrontClear = 0.0285;
  const rRightKnuckle = gripHalfW + 0.0095;
  const rLeftWrap = -(gripHalfW + 0.0065);

  // Anatomical right wrist behind-right of pistol grip (~7.7 cm palm to Middle1 MCP)
  const rightWrist = gripPoint(gripHalfW + 0.016, -0.025, -0.062);

  const trigOriginRel = new THREE.Vector3(
    m.triggerPivotPos.x - origin.x,
    m.triggerPivotPos.y - origin.y,
    m.triggerPivotPos.z - origin.z
  );
  const indexTargetTip = new THREE.Vector3(
    0.003,
    trigOriginRel.y - 0.013,
    trigOriginRel.z - 0.003
  );
  const indexDip = new THREE.Vector3(
    0.012,
    trigOriginRel.y - 0.012,
    trigOriginRel.z + 0.004
  );
  const indexMcp = gripPoint(gripHalfW + 0.009, 0.026, 0.007);
  const indexPip = new THREE.Vector3(
    Math.max(gripHalfW + 0.008, d.receiverWidth * 0.5 + 0.0065),
    indexMcp.y * 0.52 + indexDip.y * 0.48,
    (indexMcp.z + indexDip.z) * 0.5
  );

  const rightJoints: JointChainInput = {
    wrist: rightWrist,
    // Palmar normal (+Z_hand) points left (-rRight) into the right side of the pistol grip
    wristPalmHint: rRight.clone().negate(),
    fingers: {
      Thumb: {
        points: [
          gripPoint(gripHalfW + 0.012, -0.002, -0.036),
          gripPoint(gripHalfW + 0.007, 0.024, -0.030),
          gripPoint(-0.002, 0.034, -0.032),
          gripPoint(-(gripHalfW + 0.0055), 0.031, -0.015),
        ],
        hingeHint: rFwd.clone().negate(),
      },
      Index: {
        points: [indexMcp, indexPip, indexDip, indexTargetTip],
        hingeHint: rUp,
      },
      Middle: {
        points: [
          gripPoint(rRightKnuckle, 0.006, 0.008),
          gripPoint(-0.001, 0.006, rFrontClear),
          gripPoint(rLeftWrap, 0.005, 0.011),
          gripPoint(-(gripHalfW + 0.0048), 0.004, -0.008),
        ],
        hingeHint: rUp,
      },
      Ring: {
        points: [
          gripPoint(rRightKnuckle - 0.0008, -0.012, 0.006),
          gripPoint(-0.001, -0.012, rFrontClear - 0.001),
          gripPoint(rLeftWrap + 0.0005, -0.013, 0.010),
          gripPoint(-(gripHalfW + 0.0044), -0.013, -0.007),
        ],
        hingeHint: rUp,
      },
      Pinky: {
        points: [
          gripPoint(rRightKnuckle - 0.0016, -0.029, 0.003),
          gripPoint(0.0, -0.029, rFrontClear - 0.003),
          gripPoint(rLeftWrap + 0.0012, -0.030, 0.0085),
          gripPoint(-(gripHalfW + 0.004), -0.030, -0.006),
        ],
        hingeHint: rUp,
      },
    },
  };

  // =========================================================================
  // 2. LEFT HAND (Support Forend Cradle / Vertical Foregrip / Bare Barrel)
  // =========================================================================
  const effectiveUb = m.effectiveUnderbarrel;
  let leftJoints: JointChainInput;

  const handRRel = new THREE.Vector3(
    m.socketHandRPos.x - origin.x,
    m.socketHandRPos.y - origin.y,
    m.socketHandRPos.z - origin.z
  );
  const handLRel = new THREE.Vector3(
    m.socketHandLPos.x - origin.x,
    m.socketHandLPos.y - origin.y,
    m.socketHandLPos.z - origin.z
  );

  if (effectiveUb === 'vertical_grip') {
    const ubScale = d.underbarrelScale;
    const ubWScale = d.underbarrelWidth;
    const shaftR = 0.0158 * ubWScale * ubScale + 0.0025;
    const cy = handLRel.y;
    const cz = handLRel.z;
    const vLenScale = clamp(ubScale, 0.78, 1.25);

    const vPt = (x: number, dy: number, dz: number): THREE.Vector3 =>
      new THREE.Vector3(x, cy + dy * vLenScale, cz + dz);

    const vFrontClear = -(shaftR + 0.011);
    const vLeftK = -(shaftR + 0.0095);
    const vRightWrap = shaftR + 0.0068;

    leftJoints = {
      wrist: new THREE.Vector3(-(shaftR + 0.015), cy - 0.022 * vLenScale, cz + 0.064),
      // Left palm presses rightward (+X) into the left flank of the vertical foregrip
      wristPalmHint: new THREE.Vector3(1, 0, 0),
      fingers: {
        Thumb: {
          points: [
            vPt(-(shaftR + 0.012), -0.002, 0.034),
            vPt(-(shaftR + 0.007), 0.023, 0.022),
            vPt(0.001, 0.034, 0.020),
            vPt(shaftR + 0.004, 0.032, 0.004),
          ],
          hingeHint: new THREE.Vector3(0, 0, -1),
        },
        Index: {
          points: [
            vPt(vLeftK, 0.022, -0.012),
            vPt(0.002, 0.022, vFrontClear),
            vPt(vRightWrap, 0.021, -0.005),
            vPt(shaftR + 0.0048, 0.020, 0.012),
          ],
          hingeHint: new THREE.Vector3(0, -1, 0),
        },
        Middle: {
          points: [
            vPt(vLeftK, 0.005, -0.012),
            vPt(0.002, 0.005, vFrontClear - 0.001),
            vPt(vRightWrap + 0.0005, 0.004, -0.004),
            vPt(shaftR + 0.005, 0.003, 0.013),
          ],
          hingeHint: new THREE.Vector3(0, -1, 0),
        },
        Ring: {
          points: [
            vPt(vLeftK + 0.0008, -0.012, -0.010),
            vPt(0.002, -0.012, vFrontClear),
            vPt(vRightWrap, -0.013, -0.003),
            vPt(shaftR + 0.0046, -0.014, 0.012),
          ],
          hingeHint: new THREE.Vector3(0, -1, 0),
        },
        Pinky: {
          points: [
            vPt(vLeftK + 0.0016, -0.028, -0.007),
            vPt(0.001, -0.028, vFrontClear + 0.002),
            vPt(vRightWrap - 0.0008, -0.029, -0.001),
            vPt(shaftR + 0.004, -0.029, 0.010),
          ],
          hingeHint: new THREE.Vector3(0, -1, 0),
        },
      },
    };
  } else {
    // Horizontal / angled cradle / attachment-cleared wrap
    const ubScale = d.underbarrelScale;
    const wrapHalfW = m.leftGripEnvelopeHalfW;
    const wrapRightHalfW = m.leftGripEnvelopeRightClearX;
    const wrapCenterY = m.leftGripEnvelopeCenterY - origin.y;
    const wrapBotY = m.leftGripEnvelopeBotY - origin.y;
    const centerZ = m.leftGripCenterZ - origin.z;
    const pitchRad = effectiveUb === 'angled_grip' ? 0.28 : 0;

    const sinP = Math.sin(pitchRad);
    const cosP = Math.cos(pitchRad);
    const cradlePt = (x: number, y: number, zOff: number): THREE.Vector3 => {
      const dy = y - wrapCenterY;
      const ry = dy * cosP - zOff * sinP;
      const rz = zOff * cosP + dy * sinP;
      return new THREE.Vector3(x, wrapCenterY + ry, centerZ + rz);
    };

    // Flexion hinge points rearward (+Z rotated by pitch) toward Pinky so +Z_finger points into palm/handguard
    const hingeZ = new THREE.Vector3(0, -sinP, cosP).normalize();
    const rightFlank = wrapRightHalfW + 0.0085;
    const leftFlank = -(wrapHalfW + 0.008);
    const sideSpan = Math.max(0.018, wrapCenterY - wrapBotY);
    const botClearY = wrapBotY - 0.0085;

    // Anatomical knuckle ridge beneath the handguard/attachment envelope (~7.5 cm palm from wrist to Middle1)
    const mcpMiddleX = Math.max(-(wrapHalfW * 0.24), rightFlank - 0.032);
    const wristX = mcpMiddleX - 0.022;
    const wristY = botClearY - 0.019;
    const wristZOff = 0.064;

    const makeCradleFinger = (
      mcpX: number,
      mcpY: number,
      mcpZ: number,
      wrapZ: number,
      fingerScale: number
    ): [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] => {
      const pipY = wrapBotY + Math.min(0.014, sideSpan * 0.42);
      const dipY = pipY + 0.022 * fingerScale;
      const tipY = dipY + 0.016 * fingerScale;
      return [
        cradlePt(mcpX, mcpY, mcpZ),
        cradlePt(rightFlank, pipY, wrapZ),
        cradlePt(rightFlank - 0.0008, dipY, wrapZ),
        cradlePt(wrapRightHalfW + 0.0045, tipY, wrapZ),
      ];
    };

    const isHandstopPocket = m.leftGripPlacement === 'handstop_pocket';
    const pocketScale = isHandstopPocket ? clamp(ubScale, 0.78, 1.08) : 1.0;

    // Palmar normal (+Z_hand) cups upward-right into underside of handguard/forend
    const palmHint = new THREE.Vector3(0.42, 0.907 * cosP, 0.907 * sinP).normalize();

    leftJoints = {
      wrist: cradlePt(wristX, wristY, wristZOff),
      wristPalmHint: palmHint,
      fingers: {
        Thumb: {
          points: [
            cradlePt(leftFlank - 0.003, botClearY + 0.006, 0.030 * pocketScale),
            cradlePt(leftFlank - 0.001, botClearY + Math.min(0.024, Math.max(0.010, sideSpan * 0.45)), 0.008 * pocketScale),
            cradlePt(leftFlank + 0.0005, wrapCenterY - 0.002, -0.017 * pocketScale),
            cradlePt(leftFlank + 0.002, wrapCenterY + 0.008, -0.038 * pocketScale),
          ],
          hingeHint: new THREE.Vector3(0, -1, 0),
        },
        Index: {
          points: makeCradleFinger(
            mcpMiddleX - 0.004,
            botClearY + 0.002,
            -0.020 * pocketScale,
            -0.023 * pocketScale,
            0.96
          ),
          hingeHint: hingeZ,
        },
        Middle: {
          points: makeCradleFinger(
            mcpMiddleX,
            botClearY,
            -0.006 * pocketScale,
            -0.008 * pocketScale,
            1.04
          ),
          hingeHint: hingeZ,
        },
        Ring: {
          points: makeCradleFinger(
            mcpMiddleX + 0.004,
            botClearY - 0.001,
            0.007 * pocketScale,
            0.008 * pocketScale,
            0.96
          ),
          hingeHint: hingeZ,
        },
        Pinky: {
          points: makeCradleFinger(
            mcpMiddleX + 0.008,
            botClearY - 0.002,
            0.019 * pocketScale,
            0.022 * pocketScale,
            0.82
          ),
          hingeHint: hingeZ,
        },
      },
    };
  }

  const rightBuilt = buildHandBonesFromJoints(
    'Right',
    `${MIXAMO_BONE_PREFIX}RightForeArm`,
    handRRel,
    rightJoints
  );
  const leftBuilt = buildHandBonesFromJoints(
    'Left',
    `${MIXAMO_BONE_PREFIX}LeftForeArm`,
    handLRel,
    leftJoints
  );

  // Compute exact BoneAttachment3D transform: WeaponRoot expressed in mixamorig1_RightHand local space
  const rightWristWorldMat = new THREE.Matrix4().compose(
    rightBuilt.wristPos,
    rightBuilt.wristQuat,
    new THREE.Vector3(1, 1, 1)
  );
  const rightWristInvMat = rightWristWorldMat.clone().invert();
  const weaponOffsetPos = new THREE.Vector3();
  const weaponOffsetQuat = new THREE.Quaternion();
  const dummyScale = new THREE.Vector3();
  rightWristInvMat.decompose(weaponOffsetPos, weaponOffsetQuat, dummyScale);
  const weaponOffsetEuler = new THREE.Euler().setFromQuaternion(weaponOffsetQuat, 'XYZ');

  const bones: Record<string, HandBoneNodeSpec> = {
    ...rightBuilt.bones,
    ...leftBuilt.bones,
  };

  for (const bone of Object.values(bones)) {
    const rhPos = new THREE.Vector3(...bone.world_position).applyMatrix4(rightWristInvMat);
    bone.right_hand_position = [round4(rhPos.x), round4(rhPos.y), round4(rhPos.z)];
  }

  const bone_attach: BoneAttachSpec = {
    attach_bone: 'mixamorig1_RightHand',
    weapon_offset_position: [
      round4(weaponOffsetPos.x),
      round4(weaponOffsetPos.y),
      round4(weaponOffsetPos.z),
    ],
    weapon_offset_rotation: [
      round4(weaponOffsetEuler.x),
      round4(weaponOffsetEuler.y),
      round4(weaponOffsetEuler.z),
    ],
    weapon_offset_rotation_deg: eulerToDegTuple(weaponOffsetEuler),
    weapon_offset_quaternion: [
      round4(weaponOffsetQuat.x),
      round4(weaponOffsetQuat.y),
      round4(weaponOffsetQuat.z),
      round4(weaponOffsetQuat.w),
    ],
    right_wrist_weapon_position: rightBuilt.bones.RightHand.world_position,
    left_wrist_weapon_position: leftBuilt.bones.LeftHand.world_position,
  };

  return {
    naming_convention: 'mixamo',
    mixamo_prefix: MIXAMO_BONE_PREFIX,
    finger_axis: '+Y',
    bone_longitudinal_axis: '+Y',
    palmar_axis: '+Z',
    wrist_bones: {
      right: 'RightHand',
      left: 'LeftHand',
    },
    wrist_mixamo_names: {
      right: `${MIXAMO_BONE_PREFIX}RightHand`,
      left: `${MIXAMO_BONE_PREFIX}LeftHand`,
    },
    right_grip_style: 'pistol_grip',
    bone_attach,
    grips: {
      right: rightBuilt.gripSolve,
    },
    bones,
  };
}

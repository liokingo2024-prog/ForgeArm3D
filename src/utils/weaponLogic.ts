import {
  cloneWeaponConfig,
  DEFAULT_DIMENSIONS,
  SLOT_ORDER,
  SLOT_SPECS,
  STARTER_PRESETS,
  WEAPON_THEMES,
} from '../data/catalog';
import {
  GlbExportQuality,
  GlbExportQualitySpec,
  LeftGripPlacement,
  PaintGroup,
  PaintPattern,
  PartPaint,
  ResolvedMechanics,
  SlotId,
  UnderbarrelVariant,
  WeaponConfig,
  WeaponDimensions,
  WeaponParts,
} from '../types/weapon';

const MUZZLE_THREAD_CLEARANCE = 0.032;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Computes exact mechanical anchors & enforces automatic guardrails:
 * - Handguard-to-barrel guardrail (never protrudes past barrel tip minus muzzle clearance)
 * - True bullpup architecture (relocates magwell behind pistol grip +Z, shifts receiver forward)
 * - Smart underbarrel & handguard coupling (disables underbarrel when handguard === 'none', updates socket_hand_l)
 * - Canonical origin: (0,0,0) at pistol grip hand center, barrel points along -Z, up is +Y.
 */
export function resolveMechanicalConstraints(config: WeaponConfig): ResolvedMechanics {
  const { parts, dimensions: d } = config;
  const isBullpup = parts.receiver === 'bullpup';

  // Keep pistol grip hand center strictly at (0, 0, 0).
  const gripTopY = d.gripLength * 0.44;
  const receiverBottomY = gripTopY;
  const receiverCenterY = receiverBottomY + d.receiverHeight * 0.5;
  const receiverTopY = receiverBottomY + d.receiverHeight;

  const receiverRearZ = isBullpup ? d.receiverLength * 0.72 : 0.048;
  const receiverFrontZ = receiverRearZ - d.receiverLength;

  // Exact top surface of each receiver's optic rail so clamps ALWAYS seat flush (zero floating)
  const railRise = d.receiverRailHeight;
  let receiverRailTopY = receiverTopY + railRise;
  if (parts.receiver === 'ar_flattop') {
    receiverRailTopY = receiverBottomY + d.receiverHeight * 0.96 + railRise;
  } else if (parts.receiver === 'ak_stamped') {
    // Stamped AK has a curved dust cover; optics use a flush side-mount dovetail bridge sitting right above dust cover
    receiverRailTopY = receiverTopY + 0.004 + railRise;
  } else if (parts.receiver === 'ak12_modern') {
    receiverRailTopY = receiverTopY + 0.002 + railRise;
  } else if (parts.receiver === 'bullpup') {
    receiverRailTopY = receiverTopY + 0.003 + railRise;
  } else if (parts.receiver === 'scar_monolithic') {
    receiverRailTopY = receiverTopY + 0.004 + railRise;
  } else if (parts.receiver === 'smg_mp5') {
    receiverRailTopY = receiverTopY + 0.003 + railRise;
  } else if (parts.receiver === 'bolt_chassis') {
    receiverRailTopY = receiverTopY + 0.003 + railRise;
  } else if (parts.receiver === 'scifi_rail') {
    receiverRailTopY = receiverTopY + 0.002 + railRise;
  }

  const needsAkSideBridge =
    parts.receiver === 'ak_stamped' && parts.optic !== 'none';

  // Barrel bore axis with optional vertical bore offset
  const barrelAxisY = receiverBottomY + d.receiverHeight * 0.64 + d.barrelOffsetY;
  const barrelStartZ = receiverFrontZ + 0.008;
  const barrelEndZ = receiverFrontZ - d.barrelLength;

  // Handguard-to-barrel guardrail (accounts for forward offset too!)
  const hgOffset = Math.max(0, d.handguardOffset);
  const maxHandguardLen = Math.max(0.06, d.barrelLength - MUZZLE_THREAD_CLEARANCE - hgOffset);
  const rawHandguardLen = parts.handguard === 'none' ? 0 : d.handguardLength;
  const effectiveHandguardLength = parts.handguard === 'none' ? 0 : Math.min(rawHandguardLen, maxHandguardLen);
  const handguardClamped = parts.handguard !== 'none' && rawHandguardLen > maxHandguardLen + 0.0005;

  const handguardStartZ = receiverFrontZ + 0.004 - hgOffset;
  const handguardEndZ = handguardStartZ - effectiveHandguardLength;

  // Smart underbarrel coupling
  const underbarrelDisabledByHandguard = parts.handguard === 'none' && parts.underbarrel !== 'none';
  const effectiveUnderbarrel: UnderbarrelVariant =
    parts.handguard === 'none' ? 'none' : parts.underbarrel;

  // Magazine well anchor (tucked inside receiver cavity so rocking never reveals a gap)
  const magwellZ = isBullpup
    ? receiverRearZ - d.receiverLength * 0.24
    : receiverFrontZ + d.receiverLength * 0.31;
  const magwellY = receiverBottomY + 0.012;

  // Stock rear trunnion anchor
  const stockAttachPos = {
    x: 0,
    y: receiverCenterY + 0.002,
    z: receiverRearZ - 0.003,
  };

  // Optic mount seated strictly on receiverRailTopY (clamped within receiver rail span so it never hangs off the ends)
  const railMidZ = isBullpup
    ? receiverFrontZ + d.receiverLength * 0.36
    : (receiverFrontZ + receiverRearZ) * 0.5;
  const maxOpticShift = Math.max(0.02, d.receiverLength * 0.28);
  const opticZ = railMidZ + clamp(d.opticOffset, -maxOpticShift, maxOpticShift);
  const opticMountPos = {
    x: 0,
    y: receiverRailTopY,
    z: opticZ,
  };

  // Underbarrel mount along handguard underside (scaled by handguardHeight)
  const ubRatio = clamp(d.underbarrelOffset, 0.16, 0.86);
  const underbarrelZ =
    parts.handguard === 'none'
      ? receiverFrontZ - Math.min(0.11, d.barrelLength * 0.45)
      : handguardStartZ - effectiveHandguardLength * ubRatio;
  const underbarrelY = barrelAxisY - d.handguardBulk * d.handguardHeight * 0.94;
  const underbarrelMountPos = {
    x: 0,
    y: underbarrelY,
    z: underbarrelZ,
  };

  // Muzzle socket at tip of barrel + muzzle device length
  const muzzleExtraLen = getMuzzleLength(
    parts.muzzle,
    d.muzzleScale * d.muzzleLengthScale
  );
  const socketMuzzlePos = {
    x: 0,
    y: barrelAxisY,
    z: barrelEndZ - muzzleExtraLen,
  };

  // Right-hand pistol grip palm contact point:
  // WeaponRoot origin stays at grip centerline pivot (gripPivotPos, x=0) so barrel/ADS stay centered,
  // while Socket_Grip_Right sits on the exterior right-side (+X) palm surface of the grip mesh.
  const gripEffLen = parts.grip === 'angled_pdw' ? d.gripLength * 0.8 : d.gripLength;
  const gripAngleRad = (d.gripAngle * Math.PI) / 180;
  const palmDrop = gripEffLen * 0.4;
  const gripWidth =
    (parts.grip === 'cqb_vertical' || parts.grip === 'angled_pdw' ? 0.027 : 0.029) * d.gripThickness;
  let gripHalfSurfaceX = gripWidth * 0.5 + 0.0048;
  if (parts.grip === 'tactical_ergo' || parts.grip === 'precision_palm') {
    gripHalfSurfaceX = gripWidth * 0.5 + 0.0052;
  } else if (parts.grip === 'rubber_overmold') {
    gripHalfSurfaceX = Math.max(gripWidth * 0.5 + 0.0048, gripWidth * 0.535 + 0.0028);
  } else if (parts.grip === 'skeleton_cnc') {
    gripHalfSurfaceX = gripWidth * 0.5 + 0.0028;
  }

  const gripPivotPos = {
    x: 0,
    y: receiverBottomY - 0.004 - Math.cos(gripAngleRad) * palmDrop,
    z: 0.004 + Math.sin(gripAngleRad) * palmDrop,
  };
  const socketHandRPos = {
    x: gripHalfSurfaceX,
    y: gripPivotPos.y,
    z: gripPivotPos.z,
  };
  const socketHandRForward = {
    x: 0,
    y: -Math.sin(gripAngleRad),
    z: -Math.cos(gripAngleRad),
  };
  const socketHandRUp = {
    x: 0,
    y: Math.cos(gripAngleRad),
    z: -Math.sin(gripAngleRad),
  };
  const socketHandRNormal = {
    x: 1,
    y: 0,
    z: 0,
  };

  // Left-hand support grip contact point: strictly on exterior left/lower-left surface (-X), never inside mesh
  const bulkW = d.handguardBulk;
  const bulkH = bulkW * d.handguardHeight;
  let handLHalfW = bulkW * 0.98 + 0.0045;
  let handLCradleY = barrelAxisY - bulkH * 0.62;
  switch (parts.handguard) {
    case 'ak_wood':
      handLHalfW = bulkW * 1.06 + 0.0045;
      handLCradleY = barrelAxisY - bulkH * 0.58;
      break;
    case 'tactical_mlok':
      handLHalfW = bulkW * 0.98 + 0.0045;
      handLCradleY = barrelAxisY - bulkH * 0.62;
      break;
    case 'quad_rail':
      handLHalfW = bulkW * 0.96 + 0.0055;
      handLCradleY = barrelAxisY - bulkH * 0.44;
      break;
    case 'compact_shroud':
      handLHalfW = bulkW * 0.96 + 0.004;
      handLCradleY = barrelAxisY - bulkH * 0.62;
      break;
    case 'keymod_slim':
      handLHalfW = bulkW * 0.84 + 0.0045;
      handLCradleY = barrelAxisY - bulkH * 0.58;
      break;
    case 'heatshield_perforated': {
      const rad = Math.max(bulkW, bulkH) * 0.96;
      handLHalfW = rad * 0.88 + 0.004;
      handLCradleY = barrelAxisY - rad * 0.52;
      break;
    }
    case 'scifi_angled':
      handLHalfW = bulkW * 1.08 + 0.004;
      handLCradleY = barrelAxisY - bulkH * 0.55;
      break;
    case 'none':
      break;
  }

  // Standard horizontal handguard cradle orientation:
  // grip_forward = -Z (along barrel), grip_up = [-0.5736, +0.8192, 0] (thumb up-left),
  // contact_normal = [-0.8192, -0.5736, 0] (outward lower-left from handguard into left palm)
  const sinCradle = 0.5735764364; // sin(35 deg)
  const cosCradle = 0.8191520443; // cos(35 deg)
  let socketHandLPos = {
    x: -handLHalfW,
    y: handLCradleY,
    z: handguardStartZ - effectiveHandguardLength * 0.55,
  };
  let socketHandLForward = { x: 0, y: 0, z: -1 };
  let socketHandLUp = { x: -sinCradle, y: cosCradle, z: 0 };
  let socketHandLNormal = { x: -cosCradle, y: -sinCradle, z: 0 };

  const ubScale = d.underbarrelScale;
  const ubWScale = d.underbarrelWidth;
  const hgEnvelopeHalfW = handLHalfW + 0.0015;
  const hgEnvelopeCenterY = barrelAxisY - bulkH * 0.1;
  const hgEnvelopeBotY =
    barrelAxisY - (parts.handguard === 'quad_rail' ? bulkH * 0.96 + 0.011 : bulkH * 1.06 + 0.004);

  let leftGripPlacement: LeftGripPlacement = 'handguard_cradle';
  let leftGripCenterZ = socketHandLPos.z;
  let leftGripEnvelopeHalfW = hgEnvelopeHalfW;
  let leftGripEnvelopeRightClearX = hgEnvelopeHalfW;
  let leftGripEnvelopeCenterY = hgEnvelopeCenterY;
  let leftGripEnvelopeBotY = hgEnvelopeBotY;

  if (parts.handguard === 'none') {
    leftGripPlacement = 'bare_barrel';
    const rB = d.barrelThickness;
    const bareR =
      parts.barrel === 'integral_suppressed'
        ? Math.max(rB * 1.95, 0.019)
        : parts.barrel === 'heavy_sniper'
          ? rB * 1.55
          : parts.barrel === 'carbon_wrapped'
            ? rB * 1.54
            : parts.barrel === 'finned_lmg'
              ? rB * 1.5
              : parts.barrel === 'twin_scifi'
                ? rB * 1.24
                : rB * 1.22;
    leftGripCenterZ = receiverFrontZ - Math.min(0.07, d.barrelLength * 0.35);
    leftGripEnvelopeHalfW = bareR + 0.004;
    leftGripEnvelopeRightClearX = bareR + 0.004;
    leftGripEnvelopeCenterY = barrelAxisY;
    leftGripEnvelopeBotY = barrelAxisY - bareR - 0.004;
    socketHandLPos = {
      x: -(bareR * 0.86 + 0.003),
      y: barrelAxisY - bareR * 0.52,
      z: leftGripCenterZ,
    };
  } else if (effectiveUnderbarrel === 'vertical_grip') {
    leftGripPlacement = 'direct_grip';
    leftGripCenterZ = underbarrelZ;
    leftGripEnvelopeHalfW = 0.0158 * ubWScale * ubScale + 0.0025;
    leftGripEnvelopeRightClearX = leftGripEnvelopeHalfW;
    leftGripEnvelopeCenterY = underbarrelY - d.underbarrelDrop - 0.062 * ubScale;
    leftGripEnvelopeBotY = underbarrelY - d.underbarrelDrop - 0.104 * ubScale;
    socketHandLPos = {
      x: -(0.0158 * ubWScale * ubScale + 0.002),
      y: underbarrelY - d.underbarrelDrop - 0.062 * ubScale,
      z: underbarrelZ,
    };
    socketHandLForward = { x: 0, y: 0, z: -1 };
    socketHandLUp = { x: 0, y: 1, z: 0 };
    socketHandLNormal = { x: -1, y: 0, z: 0 };
  } else if (effectiveUnderbarrel === 'angled_grip') {
    leftGripPlacement = 'angled_cradle';
    // Tilted upward along the Magpul AFG palm ramp (~18 deg) while cradling from the left-bottom flank
    const pitch = 0.32;
    const sinP = Math.sin(pitch);
    const cosP = Math.cos(pitch);
    leftGripCenterZ = underbarrelZ - 0.010;
    leftGripEnvelopeHalfW = (0.0168 * ubWScale + 0.004) * ubScale;
    leftGripEnvelopeRightClearX = leftGripEnvelopeHalfW;
    leftGripEnvelopeCenterY = underbarrelY - d.underbarrelDrop - 0.018 * ubScale;
    leftGripEnvelopeBotY = underbarrelY - d.underbarrelDrop - 0.047 * ubScale;
    socketHandLPos = {
      x: -((0.0166 * ubWScale + 0.003) * ubScale),
      y: underbarrelY - d.underbarrelDrop - 0.034 * ubScale,
      z: underbarrelZ - 0.012,
    };
    socketHandLForward = { x: 0, y: sinP, z: -cosP };
    // Orthonormal to grip_forward and contact_normal:
    const nx = -cosCradle;
    const ny = -sinCradle * cosP;
    const nz = -sinCradle * sinP;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    socketHandLNormal = { x: nx / nLen, y: ny / nLen, z: nz / nLen };
    const ux = socketHandLForward.y * socketHandLNormal.z - socketHandLForward.z * socketHandLNormal.y;
    const uy = socketHandLForward.z * socketHandLNormal.x - socketHandLForward.x * socketHandLNormal.z;
    const uz = socketHandLForward.x * socketHandLNormal.y - socketHandLForward.y * socketHandLNormal.x;
    const uLen = Math.hypot(ux, uy, uz) || 1;
    socketHandLUp = { x: ux / uLen, y: uy / uLen, z: uz / uLen };
  } else if (effectiveUnderbarrel === 'grenade_launcher') {
    leftGripPlacement = 'direct_grip';
    const tubeR = 0.0215 * Math.min(1.22, 0.55 + ubWScale * 0.45);
    leftGripCenterZ = underbarrelZ - 0.056 * ubScale;
    leftGripEnvelopeHalfW = tubeR * 1.15 * ubScale + 0.004;
    leftGripEnvelopeRightClearX = leftGripEnvelopeHalfW;
    leftGripEnvelopeCenterY = underbarrelY - d.underbarrelDrop - 0.031 * ubScale;
    leftGripEnvelopeBotY = leftGripEnvelopeCenterY - tubeR * 1.15 * ubScale - 0.003;
    socketHandLPos = {
      x: -(tubeR * 0.88 * ubScale + 0.003),
      y: leftGripEnvelopeCenterY - tubeR * 0.56 * ubScale,
      z: leftGripCenterZ,
    };
  } else if (effectiveUnderbarrel === 'masterkey_shotgun') {
    leftGripPlacement = 'direct_grip';
    leftGripCenterZ = underbarrelZ - 0.088 * ubScale;
    leftGripEnvelopeHalfW = (0.0175 * ubWScale + 0.004) * ubScale;
    leftGripEnvelopeRightClearX = leftGripEnvelopeHalfW;
    leftGripEnvelopeCenterY = underbarrelY - d.underbarrelDrop - 0.036 * ubScale;
    leftGripEnvelopeBotY = underbarrelY - d.underbarrelDrop - 0.058 * ubScale;
    socketHandLPos = {
      x: -((0.0165 * ubWScale + 0.003) * ubScale),
      y: underbarrelY - d.underbarrelDrop - 0.046 * ubScale,
      z: leftGripCenterZ,
    };
  } else if (effectiveUnderbarrel === 'handstop_kit') {
    leftGripPlacement = 'handstop_pocket';
    // Pocket between front barricade stop (-0.024) and rear index hook (+0.018)
    leftGripCenterZ = underbarrelZ - 0.002 * ubScale;
    leftGripEnvelopeHalfW = Math.max(handLHalfW, (0.0145 * ubWScale + 0.004) * ubScale);
    leftGripEnvelopeRightClearX = leftGripEnvelopeHalfW;
    leftGripEnvelopeCenterY = barrelAxisY - bulkH * 0.22;
    leftGripEnvelopeBotY = Math.min(hgEnvelopeBotY, underbarrelY - d.underbarrelDrop - 0.018 * ubScale);
    socketHandLPos = {
      x: -handLHalfW,
      y: handLCradleY,
      z: leftGripCenterZ,
    };
  } else if (
    effectiveUnderbarrel === 'tactical_light' ||
    effectiveUnderbarrel === 'tactical_laser' ||
    effectiveUnderbarrel === 'bipod'
  ) {
    // Non-grip rail accessories: position support hand cleanly on clear handguard behind or ahead,
    // and expand wrap envelope if a short handguard prevents full Z clearance.
    const minSafeZ = Math.min(handguardStartZ - 0.020, handguardEndZ + 0.030);
    const maxSafeZ = Math.max(
      minSafeZ,
      handguardStartZ - (effectiveUnderbarrel === 'bipod' ? 0.018 : 0.024)
    );
    const defaultZ = clamp(handguardStartZ - effectiveHandguardLength * 0.55, minSafeZ, maxSafeZ);

    const attMinZ =
      effectiveUnderbarrel === 'tactical_light'
        ? underbarrelZ - 0.062 * ubScale
        : effectiveUnderbarrel === 'tactical_laser'
          ? underbarrelZ - 0.050 * ubScale
          : underbarrelZ - 0.036 * ubScale;
    const attMaxZ =
      effectiveUnderbarrel === 'tactical_light'
        ? underbarrelZ + 0.058 * ubScale
        : effectiveUnderbarrel === 'tactical_laser'
          ? underbarrelZ + 0.044 * ubScale
          : underbarrelZ + 0.044 * ubScale;

    const rearClearZ = attMaxZ + 0.030;
    const frontClearZ = attMinZ - (effectiveUnderbarrel === 'bipod' ? 0.054 : 0.028);

    let chosenZ = defaultZ;
    if (defaultZ >= rearClearZ) {
      leftGripPlacement = 'rear_of_attachment';
    } else if (defaultZ <= frontClearZ) {
      leftGripPlacement = 'front_of_attachment';
    } else if (rearClearZ <= maxSafeZ && (ubRatio >= 0.38 || frontClearZ < minSafeZ)) {
      chosenZ = rearClearZ;
      leftGripPlacement = 'rear_of_attachment';
    } else if (frontClearZ >= minSafeZ) {
      chosenZ = frontClearZ;
      leftGripPlacement = 'front_of_attachment';
    } else {
      const rearGap = maxSafeZ - attMaxZ;
      const frontGap = attMinZ - minSafeZ;
      if (effectiveUnderbarrel === 'bipod' || rearGap >= frontGap) {
        chosenZ = maxSafeZ;
        leftGripPlacement = 'rear_of_attachment';
      } else {
        chosenZ = minSafeZ;
        leftGripPlacement = 'front_of_attachment';
      }
    }

    leftGripCenterZ = chosenZ;
    const fingersOverlapZ = chosenZ - 0.027 < attMaxZ && chosenZ + 0.026 > attMinZ;

    if (fingersOverlapZ && effectiveUnderbarrel === 'tactical_light') {
      leftGripPlacement = 'wrapped_attachment';
      const lightRightX = (0.019 * ubWScale + 0.017) * ubScale + 0.002;
      const lightBotY = underbarrelY - d.underbarrelDrop - 0.036 * ubScale;
      leftGripEnvelopeRightClearX = Math.max(hgEnvelopeHalfW, lightRightX);
      leftGripEnvelopeBotY = Math.min(hgEnvelopeBotY, lightBotY);
      socketHandLPos = {
        x: -handLHalfW,
        y: handLCradleY,
        z: chosenZ,
      };
    } else if (fingersOverlapZ && effectiveUnderbarrel === 'tactical_laser') {
      leftGripPlacement = 'wrapped_attachment';
      const peqHalfW = (0.025 * ubWScale + 0.005) * ubScale;
      const peqBotY = underbarrelY - d.underbarrelDrop - 0.034 * ubScale;
      leftGripEnvelopeHalfW = Math.max(hgEnvelopeHalfW, peqHalfW);
      leftGripEnvelopeRightClearX = leftGripEnvelopeHalfW;
      leftGripEnvelopeBotY = Math.min(hgEnvelopeBotY, peqBotY);
      socketHandLPos = {
        x: -Math.max(handLHalfW, (0.024 * ubWScale + 0.003) * ubScale),
        y: Math.min(handLCradleY, underbarrelY - d.underbarrelDrop - 0.018 * ubScale),
        z: chosenZ,
      };
    } else if (fingersOverlapZ && effectiveUnderbarrel === 'bipod') {
      leftGripPlacement = 'wrapped_attachment';
      const yokeHalfW = (0.023 * ubWScale + 0.005) * ubScale;
      const yokeBotY = underbarrelY - d.underbarrelDrop - 0.029 * ubScale;
      leftGripEnvelopeHalfW = Math.max(hgEnvelopeHalfW, yokeHalfW);
      leftGripEnvelopeRightClearX = leftGripEnvelopeHalfW;
      leftGripEnvelopeBotY = Math.min(hgEnvelopeBotY, yokeBotY);
      socketHandLPos = {
        x: -handLHalfW,
        y: handLCradleY,
        z: chosenZ,
      };
    } else {
      socketHandLPos = {
        x: -handLHalfW,
        y: handLCradleY,
        z: chosenZ,
      };
    }
  }

  // Named rig bones
  const boltRestPos = {
    x: d.receiverWidth * 0.52,
    y: receiverCenterY + d.receiverHeight * 0.14,
    z: isBullpup ? receiverRearZ - d.receiverLength * 0.32 : receiverFrontZ + d.receiverLength * 0.38,
  };

  // Receiver right-side ejection port socket
  const socketEjectPos = {
    x: d.receiverWidth * 0.52,
    y: boltRestPos.y,
    z: boltRestPos.z,
  };

  // ADS camera eye-line alignment point right behind the active optic ocular lens (or rear iron sight)
  const opticS = d.opticScale;
  const opticRise = d.opticMountHeight;
  let adsLocalY = 0.018;
  let adsLocalZ = 0;
  switch (parts.optic) {
    case 'none':
      adsLocalY = 0.018;
      adsLocalZ = receiverRearZ - 0.02 - opticZ;
      break;
    case 'iron_sights':
      adsLocalY = 0.021 * opticS + opticRise;
      adsLocalZ = 0.024 * opticS;
      break;
    case 'red_dot':
      adsLocalY = 0.027 * opticS + opticRise;
      adsLocalZ = 0.044 * opticS;
      break;
    case 'micro_reflex':
      adsLocalY = 0.029 * opticS + opticRise;
      adsLocalZ = 0.026 * opticS;
      break;
    case 'acog':
      adsLocalY = 0.033 * opticS + opticRise;
      adsLocalZ = 0.068 * opticS;
      break;
    case 'lpvo_tactical':
      adsLocalY = 0.032 * opticS + opticRise;
      adsLocalZ = 0.118 * opticS;
      break;
    case 'thermal_holo':
      adsLocalY = 0.033 * opticS + opticRise;
      adsLocalZ = 0.076 * opticS;
      break;
    case 'sniper_scope':
      adsLocalY = 0.033 * opticS + opticRise;
      adsLocalZ = 0.125 * opticS;
      break;
  }
  const socketAdsPos = {
    x: 0,
    y: receiverRailTopY + adsLocalY,
    z: opticZ + adsLocalZ,
  };

  const triggerPivotPos = {
    x: 0,
    y: receiverBottomY + 0.002,
    z: -0.031,
  };

  const selectorPos = {
    x: d.receiverWidth * 0.52,
    y: receiverCenterY - d.receiverHeight * 0.08,
    z: isBullpup ? -0.02 : 0.005,
  };

  // Total estimated physical length in meters & cm
  const stockExtentZ =
    parts.stock === 'none'
      ? receiverRearZ + 0.01
      : parts.stock === 'bullpup_buttpad'
        ? receiverRearZ + 0.036
        : receiverRearZ + d.stockLength;
  const totalMeters = Math.abs(stockExtentZ - socketMuzzlePos.z);

  return {
    isBullpup,
    effectiveHandguardLength,
    handguardClamped,
    effectiveUnderbarrel,
    underbarrelDisabledByHandguard,
    receiverFrontZ,
    receiverRearZ,
    receiverCenterY,
    receiverTopY,
    receiverRailTopY,
    receiverBottomY,
    needsAkSideBridge,
    barrelAxisY,
    barrelStartZ,
    barrelEndZ,
    handguardStartZ,
    handguardEndZ,
    magwellPos: { x: 0, y: magwellY, z: magwellZ },
    stockAttachPos,
    opticMountPos,
    underbarrelMountPos,
    gripPivotPos,
    socketMuzzlePos,
    socketEjectPos,
    socketAdsPos,
    socketHandRPos,
    socketHandRForward,
    socketHandRUp,
    socketHandRNormal,
    socketHandLPos,
    socketHandLForward,
    socketHandLUp,
    socketHandLNormal,
    leftGripPlacement,
    leftGripCenterZ,
    leftGripEnvelopeHalfW,
    leftGripEnvelopeRightClearX,
    leftGripEnvelopeCenterY,
    leftGripEnvelopeBotY,
    boltRestPos,
    triggerPivotPos,
    selectorPos,
    exactLengthMeters: Math.round(totalMeters * 1000) / 1000,
    estimatedLengthCm: Math.round(totalMeters * 100),
  };
}

export function getMuzzleLength(muzzle: WeaponParts['muzzle'], scale: number): number {
  switch (muzzle) {
    case 'none':
      return 0;
    case 'slant_brake':
      return 0.04 * scale;
    case 'suppressor':
      return 0.175 * scale;
    case 'osp_rectangular':
      return 0.168 * scale;
    case 'tank_brake':
      return 0.072 * scale;
    case 'flash_hider':
      return 0.056 * scale;
    case 'linear_comp':
      return 0.068 * scale;
    case 'breacher_spike':
      return 0.064 * scale;
  }
}

export function harmonizeAccentColor(hex: string): string {
  const clean = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return '#1e2228';
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  // Darken brighter tones, lighten very dark tones slightly for rich pattern contrast
  const factor = lum > 0.25 ? 0.54 : 1.55;
  const nr = clamp(Math.round(r * factor + (lum <= 0.25 ? 14 : 0)), 12, 238);
  const ng = clamp(Math.round(g * factor + (lum <= 0.25 ? 14 : 0)), 12, 238);
  const nb = clamp(Math.round(b * factor + (lum <= 0.25 ? 14 : 0)), 12, 238);
  return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
}

export function getSlotsInPaintGroup(sourceSlot: SlotId, group: PaintGroup): SlotId[] {
  if (group === 'single') return [sourceSlot];
  if (group === 'all') return [...SLOT_ORDER];
  if (group === 'metal') return ['receiver', 'barrel', 'muzzle', 'optic'];
  if (group === 'furniture') return ['handguard', 'stock', 'grip'];
  if (group === 'attachments') return ['magazine', 'optic', 'underbarrel', 'muzzle'];
  return [sourceSlot];
}

export function applyPaintToGroup(
  config: WeaponConfig,
  sourceSlot: SlotId,
  patch: Partial<PartPaint>,
  group: PaintGroup
): WeaponConfig {
  const next = cloneWeaponConfig(config);
  const targets = getSlotsInPaintGroup(sourceSlot, group);
  const basePaint = next.paints[sourceSlot];
  const mergedPaint: PartPaint = {
    ...basePaint,
    ...patch,
  };
  for (const slot of targets) {
    next.paints[slot] = { ...mergedPaint };
  }
  return next;
}

export function applyWeaponTheme(config: WeaponConfig, themeId: string): WeaponConfig {
  const theme = WEAPON_THEMES.find((t) => t.id === themeId);
  if (!theme) return config;
  const next = cloneWeaponConfig(config);
  for (const slot of SLOT_ORDER) {
    next.paints[slot] = { ...theme.paints[slot] };
  }
  return next;
}

export function sanitizeWeaponConfig(raw: unknown, fallback: WeaponConfig): WeaponConfig {
  const next = cloneWeaponConfig(fallback);
  if (!raw || typeof raw !== 'object') return next;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name === 'string' && obj.name.trim()) {
    next.name = obj.name.trim().slice(0, 64);
  }

  if (obj.parts && typeof obj.parts === 'object') {
    const rawParts = obj.parts as Record<string, unknown>;
    for (const slot of SLOT_ORDER) {
      const val = rawParts[slot];
      if (typeof val === 'string') {
        const valid = SLOT_SPECS[slot].variants.some((v) => v.id === val);
        if (valid) {
          (next.parts as unknown as Record<string, string>)[slot] = val;
        }
      }
    }
  }

  if (obj.dimensions && typeof obj.dimensions === 'object') {
    const rawDims = obj.dimensions as Record<string, unknown>;
    for (const slot of SLOT_ORDER) {
      for (const slider of SLOT_SPECS[slot].sliders) {
        const val = rawDims[slider.key];
        if (typeof val === 'number' && Number.isFinite(val)) {
          next.dimensions[slider.key] = clamp(val, slider.min, slider.max);
        }
      }
    }
  }

  const validPatterns: PaintPattern[] = [
    'solid',
    'wood',
    'carbon',
    'digital_camo',
    'tiger_stripe',
    'hex_tech',
    'brushed_steel',
  ];

  if (obj.paints && typeof obj.paints === 'object') {
    const rawPaints = obj.paints as Record<string, unknown>;
    for (const slot of SLOT_ORDER) {
      const p = rawPaints[slot];
      if (p && typeof p === 'object') {
        const po = p as Record<string, unknown>;
        const target = next.paints[slot];
        if (typeof po.primaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(po.primaryColor)) {
          target.primaryColor = po.primaryColor;
        }
        if (typeof po.secondaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(po.secondaryColor)) {
          target.secondaryColor = po.secondaryColor;
        }
        if (typeof po.pattern === 'string' && validPatterns.includes(po.pattern as PaintPattern)) {
          target.pattern = po.pattern as PaintPattern;
        }
        if (typeof po.metalness === 'number' && Number.isFinite(po.metalness)) {
          target.metalness = clamp(po.metalness, 0, 1);
        }
        if (typeof po.roughness === 'number' && Number.isFinite(po.roughness)) {
          target.roughness = clamp(po.roughness, 0.05, 1);
        }
        if (typeof po.patternScale === 'number' && Number.isFinite(po.patternScale)) {
          target.patternScale = clamp(po.patternScale, 0.5, 3.0);
        }
        if (typeof po.wear === 'number' && Number.isFinite(po.wear)) {
          target.wear = clamp(po.wear, 0, 1);
        }
      }
    }
  }

  return next;
}

/**
 * Context-aware offline keyword gunsmith engine.
 * Preserves existing user build when prompt asks for targeted tweaks ("keep my parts", "just", "add", "swap"),
 * or builds a fresh cohesive configuration when describing a new platform.
 */
export function parseOfflineKeywordPrompt(
  prompt: string,
  currentConfig: WeaponConfig
): { config: WeaponConfig; summary: string } {
  const q = prompt.toLowerCase();
  const isPartialEdit =
    /\b(keep|just|only|add|swap|change|paint|make the|longer|shorter|remove|without)\b/.test(q) &&
    !/\b(build a|create a|new|from scratch)\b/.test(q);

  let next = cloneWeaponConfig(currentConfig);
  const notes: string[] = [];

  // Platform resets only when explicitly requested and not preserving existing receiver
  if (!isPartialEdit) {
    if (/\bbullpup\b/.test(q)) {
      next = cloneWeaponConfig(STARTER_PRESETS[2].config);
      notes.push('Bullpup chassis');
    } else if (/\b(sci-?fi|railgun|futuristic|cyber|plasma|laser rifle)\b/.test(q)) {
      next = cloneWeaponConfig(STARTER_PRESETS[3].config);
      notes.push('Sci-Fi railgun chassis');
    } else if (/\b(m4|ar-?15|ar15|carbine|spec-?ops|tactical rifle)\b/.test(q)) {
      next = cloneWeaponConfig(STARTER_PRESETS[1].config);
      notes.push('AR-15 flat-top platform');
    } else if (/\b(ak-?12|modern ak)\b/.test(q)) {
      next = cloneWeaponConfig(STARTER_PRESETS[0].config);
      next.parts.receiver = 'ak12_modern';
      next.parts.handguard = 'tactical_mlok';
      next.parts.stock = 'tactical_carbine';
      notes.push('AK-12 modernized receiver');
    } else if (/\b(ak|kalashnikov|soviet|draco)\b/.test(q)) {
      next = cloneWeaponConfig(STARTER_PRESETS[0].config);
      notes.push('AK stamped platform');
    } else if (/\b(sniper|dmr|marksman|precision)\b/.test(q)) {
      next.parts.receiver = 'ar_flattop';
      next.parts.barrel = 'heavy_sniper';
      next.parts.handguard = 'tactical_mlok';
      next.parts.stock = 'precision_sniper';
      next.parts.grip = 'precision_palm';
      next.parts.optic = 'sniper_scope';
      next.parts.muzzle = 'tank_brake';
      next.parts.underbarrel = 'bipod';
      next.dimensions.barrelLength = 0.56;
      next.dimensions.handguardLength = 0.31;
      notes.push('Long-range DMR configuration');
    } else if (/\b(smg|pdw|cqb|submachine)\b/.test(q)) {
      next.parts.barrel = 'compact_smg';
      next.parts.handguard = 'compact_shroud';
      next.parts.magazine = 'smg_stick';
      next.parts.stock = 'skeleton_folder';
      next.dimensions.barrelLength = 0.22;
      next.dimensions.handguardLength = 0.14;
      notes.push('Compact SMG setup');
    }
  } else {
    if (/\bbullpup\b/.test(q)) {
      next.parts.receiver = 'bullpup';
      next.parts.stock = 'bullpup_buttpad';
      notes.push('Bullpup receiver');
    } else if (/\b(ar-?15|m4|flat-?top)\b/.test(q)) {
      next.parts.receiver = 'ar_flattop';
      notes.push('AR flat-top receiver');
    } else if (/\bak-?12\b/.test(q)) {
      next.parts.receiver = 'ak12_modern';
      notes.push('AK-12 receiver');
    } else if (/\b(sci-?fi|rail)\b/.test(q)) {
      next.parts.receiver = 'scifi_rail';
      notes.push('Sci-Fi rail receiver');
    }
  }

  // Targeted part swaps
  if (/\b(scar)\b/.test(q)) {
    next.parts.receiver = 'scar_monolithic';
    next.parts.stock = 'scar_boot';
    notes.push('SCAR monolithic chassis & folding boot');
  } else if (/\b(mp5|roller)\b/.test(q)) {
    next.parts.receiver = 'smg_mp5';
    next.parts.stock = 'pdw_wire';
    notes.push('Roller-delayed SMG upper');
  } else if (/\b(bolt action|bolt chassis)\b/.test(q)) {
    next.parts.receiver = 'bolt_chassis';
    next.parts.magazine = 'box_sniper';
    notes.push('Precision bolt chassis');
  }

  if (/\b(draco|no stock|remove stock|pistol mode|without stock)\b/.test(q)) {
    next.parts.stock = 'none';
    notes.push('Removed stock');
  } else if (/\b(wire stock|pdw stock|collapsible)\b/.test(q)) {
    next.parts.stock = 'pdw_wire';
    notes.push('PDW twin-wire stock');
  } else if (/\b(thumbhole)\b/.test(q)) {
    next.parts.stock = 'thumbhole_sport';
    notes.push('Thumbhole sport stock');
  } else if (/\b(fold|folding|skeleton)\b/.test(q)) {
    next.parts.stock = 'skeleton_folder';
    notes.push('Skeleton folding stock');
  } else if (/\b(sniper stock|precision stock|cheek riser)\b/.test(q)) {
    next.parts.stock = 'precision_sniper';
    notes.push('Precision stock');
  }

  if (/\b(drum|75rd|75-round)\b/.test(q)) {
    next.parts.magazine = 'drum_mag';
    notes.push('75rd drum magazine');
  } else if (/\b(coupled|dual mag|jungle)\b/.test(q)) {
    next.parts.magazine = 'coupled_dual';
    notes.push('Coupled dual magazines');
  } else if (/\b(bakelite)\b/.test(q)) {
    next.parts.magazine = 'ak_bakelite';
    next.paints.magazine.primaryColor = '#a64d21';
    next.paints.magazine.secondaryColor = '#662b0f';
    next.paints.magazine.pattern = 'wood';
    notes.push('Bakelite magazine');
  } else if (/\b(stick mag|smg mag)\b/.test(q)) {
    next.parts.magazine = 'smg_stick';
    notes.push('SMG stick magazine');
  } else if (/\b(energy cell|battery mag)\b/.test(q)) {
    next.parts.magazine = 'scifi_cell';
    notes.push('Energy cell magazine');
  } else if (/\b(no mag|remove mag)\b/.test(q)) {
    next.parts.magazine = 'none';
    notes.push('Removed magazine');
  }

  if (/\b(osprey|box suppressor|rectangular)\b/.test(q)) {
    next.parts.muzzle = 'osp_rectangular';
    notes.push('Osprey box suppressor');
  } else if (/\b(breacher|spike|crown)\b/.test(q)) {
    next.parts.muzzle = 'breacher_spike';
    notes.push('Breacher crown muzzle');
  } else if (/\b(suppress|silenc|quiet|whisper)/.test(q)) {
    if (/\b(integral|as-?val|honey badger)\b/.test(q)) {
      next.parts.barrel = 'integral_suppressed';
      next.parts.muzzle = 'none';
      notes.push('Integral suppressed barrel');
    } else {
      next.parts.muzzle = 'suppressor';
      notes.push('QD suppressor');
    }
  } else if (/\b(tank brake|muzzle brake)\b/.test(q)) {
    next.parts.muzzle = 'tank_brake';
    notes.push('Tank muzzle brake');
  } else if (/\b(flash hider|birdcage)\b/.test(q)) {
    next.parts.muzzle = 'flash_hider';
    notes.push('Flash hider');
  }

  if (/\b(lpvo|1-6|1x6)\b/.test(q)) {
    next.parts.optic = 'lpvo_tactical';
    notes.push('1–6× LPVO scope');
  } else if (/\b(thermal|flir|night vision)\b/.test(q)) {
    next.parts.optic = 'thermal_holo';
    notes.push('Thermal smart optic');
  } else if (/\b(sniper scope|scope|long range optic)\b/.test(q)) {
    next.parts.optic = 'sniper_scope';
    notes.push('Variable sniper scope');
  } else if (/\b(acog|prism|4x)\b/.test(q)) {
    next.parts.optic = 'acog';
    notes.push('4× ACOG prism');
  } else if (/\b(red dot|holo|eotech)\b/.test(q)) {
    next.parts.optic = 'red_dot';
    notes.push('Holographic red dot');
  } else if (/\b(micro reflex|rmr|reflex)\b/.test(q)) {
    next.parts.optic = 'micro_reflex';
    notes.push('Micro reflex sight');
  } else if (/\b(iron sight|irons)\b/.test(q)) {
    next.parts.optic = 'iron_sights';
    notes.push('Iron sights');
  } else if (/\b(no optic|remove optic)\b/.test(q)) {
    next.parts.optic = 'none';
    notes.push('Removed optic');
  }

  if (/\b(masterkey|shotgun|12g)\b/.test(q)) {
    next.parts.underbarrel = 'masterkey_shotgun';
    notes.push('Masterkey 12G underbarrel');
  } else if (/\b(flashlight|scout light|weapon light)\b/.test(q)) {
    next.parts.underbarrel = 'tactical_light';
    notes.push('Scout weapon light');
  } else if (/\b(handstop)\b/.test(q)) {
    next.parts.underbarrel = 'handstop_kit';
    notes.push('CNC handstop');
  } else if (/\b(grenade|launcher|40mm|m203|gp-?25)\b/.test(q)) {
    next.parts.underbarrel = 'grenade_launcher';
    notes.push('40mm grenade launcher');
  } else if (/\b(bipod)\b/.test(q)) {
    next.parts.underbarrel = 'bipod';
    notes.push('Sniper bipod');
  } else if (/\b(vertical grip|foregrip)\b/.test(q)) {
    next.parts.underbarrel = 'vertical_grip';
    notes.push('Vertical foregrip');
  } else if (/\b(angled grip|afg)\b/.test(q)) {
    next.parts.underbarrel = 'angled_grip';
    notes.push('Angled foregrip');
  } else if (/\b(laser|peq)\b/.test(q)) {
    next.parts.underbarrel = 'tactical_laser';
    notes.push('PEQ tactical laser');
  }

  if (/\b(no handguard|remove handguard|bare barrel)\b/.test(q)) {
    next.parts.handguard = 'none';
    notes.push('Removed handguard');
  } else if (/\b(heatshield|perforated)\b/.test(q)) {
    next.parts.handguard = 'heatshield_perforated';
    notes.push('Perforated heatshield');
  } else if (/\b(quad rail)\b/.test(q)) {
    next.parts.handguard = 'quad_rail';
    notes.push('Quad rail handguard');
  } else if (/\b(m-?lok)\b/.test(q)) {
    next.parts.handguard = 'tactical_mlok';
    notes.push('Tactical M-LOK handguard');
  }

  // Proportions
  if (/\b(short|compact|stubby|cqb)\b/.test(q)) {
    next.dimensions.barrelLength = clamp(Math.min(next.dimensions.barrelLength, 0.25), 0.16, 0.62);
    next.dimensions.handguardLength = clamp(Math.min(next.dimensions.handguardLength, 0.17), 0.1, 0.38);
    notes.push('Compact barrel profile');
  } else if (/\b(long barrel|longer barrel|extended barrel|sniper barrel)\b/.test(q)) {
    next.dimensions.barrelLength = clamp(Math.max(next.dimensions.barrelLength, 0.52), 0.16, 0.62);
    notes.push('Extended barrel');
  }

  // Themes & Materials
  if (/\b(desert|fde|tan|sand)\b/.test(q)) {
    next = applyWeaponTheme(next, 'desert_fde');
    notes.push('Desert Operator FDE finish');
  } else if (/\b(od green|olive|woodland|forest|jungle)\b/.test(q)) {
    next = applyWeaponTheme(next, 'od_woodland');
    notes.push('OD Woodland finish');
  } else if (/\b(arctic|winter|snow|white)\b/.test(q)) {
    next = applyWeaponTheme(next, 'arctic_winter');
    notes.push('Arctic Winter camo');
  } else if (/\b(gold|titanium|cyber|luxury)\b/.test(q)) {
    next = applyWeaponTheme(next, 'cyber_titanium_gold');
    notes.push('Cyber Titanium & Gold finish');
  } else if (/\b(black|stealth|matte|spec-?ops|dark)\b/.test(q)) {
    next = applyWeaponTheme(next, 'specops_matte');
    notes.push('Spec-Ops Matte finish');
  }

  if (/\b(walnut|wood|wooden|timber)\b/.test(q)) {
    const woodPaint: PartPaint = {
      primaryColor: '#6f3719',
      secondaryColor: '#36180a',
      pattern: 'wood',
      metalness: 0.05,
      roughness: 0.36,
      patternScale: 1.1,
      wear: next.paints.handguard.wear,
    };
    next.paints.handguard = { ...woodPaint };
    next.paints.stock = { ...woodPaint };
    next.paints.grip = { ...woodPaint, roughness: 0.44 };
    notes.push('Walnut wood furniture');
  }

  if (/\b(carbon)\b/.test(q)) {
    for (const slot of ['handguard', 'stock', 'grip'] as SlotId[]) {
      next.paints[slot] = {
        ...next.paints[slot],
        primaryColor: '#252a32',
        secondaryColor: '#12151a',
        pattern: 'carbon',
        metalness: 0.3,
        roughness: 0.3,
      };
    }
    notes.push('Carbon fiber furniture');
  }

  if (/\b(digital camo)\b/.test(q)) {
    for (const slot of ['receiver', 'handguard', 'stock'] as SlotId[]) {
      next.paints[slot].pattern = 'digital_camo';
    }
    notes.push('Digital camo');
  } else if (/\b(tiger stripe|camo)\b/.test(q)) {
    for (const slot of ['receiver', 'handguard', 'stock'] as SlotId[]) {
      next.paints[slot].pattern = 'tiger_stripe';
    }
    notes.push('Tiger stripe camo');
  } else if (/\b(hex)\b/.test(q)) {
    for (const slot of ['receiver', 'handguard'] as SlotId[]) {
      next.paints[slot].pattern = 'hex_tech';
    }
    notes.push('Hex tech pattern');
  }

  if (/\b(worn|battle-?worn|weathered|scuffed|beat up|rusty|aged)\b/.test(q)) {
    for (const slot of SLOT_ORDER) {
      next.paints[slot].wear = 0.72;
    }
    notes.push('Heavy battle wear');
  } else if (/\b(factory new|pristine|clean|mint)\b/.test(q)) {
    for (const slot of SLOT_ORDER) {
      next.paints[slot].wear = 0.02;
    }
    notes.push('Factory-new finish');
  }

  const summary = notes.length > 0 ? notes.join(' · ') : 'Applied custom studio refinements';
  next.name = summary.slice(0, 42);
  return { config: sanitizeWeaponConfig(next, currentConfig), summary };
}

export interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
}

const MAX_HISTORY = 25;

export function createHistory<T>(initial: T): HistoryState<T> {
  return { past: [], present: initial, future: [] };
}

export function pushHistory<T>(state: HistoryState<T>, nextPresent: T): HistoryState<T> {
  const past = [...state.past, state.present];
  if (past.length > MAX_HISTORY) {
    past.shift();
  }
  return {
    past,
    present: nextPresent,
    future: [],
  };
}

export function undoHistory<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1];
  return {
    past: state.past.slice(0, -1),
    present: previous,
    future: [state.present, ...state.future].slice(0, MAX_HISTORY),
  };
}

export function redoHistory<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.future.length === 0) return state;
  const next = state.future[0];
  return {
    past: [...state.past, state.present].slice(-MAX_HISTORY),
    present: next,
    future: state.future.slice(1),
  };
}

export function resetSliderDimension(
  config: WeaponConfig,
  key: keyof WeaponDimensions
): WeaponConfig {
  const next = cloneWeaponConfig(config);
  next.dimensions[key] = DEFAULT_DIMENSIONS[key];
  return next;
}

export function resetSlotDimensions(config: WeaponConfig, slot: SlotId): WeaponConfig {
  const next = cloneWeaponConfig(config);
  for (const slider of SLOT_SPECS[slot].sliders) {
    next.dimensions[slider.key] = DEFAULT_DIMENSIONS[slider.key];
  }
  return next;
}

export function applyDimensionPatch(
  config: WeaponConfig,
  patch: Partial<WeaponDimensions>
): WeaponConfig {
  const next = cloneWeaponConfig(config);
  for (const slot of SLOT_ORDER) {
    for (const slider of SLOT_SPECS[slot].sliders) {
      const val = patch[slider.key];
      if (typeof val === 'number' && Number.isFinite(val)) {
        next.dimensions[slider.key] = clamp(val, slider.min, slider.max);
      }
    }
  }
  return next;
}

export function resetAllDimensions(config: WeaponConfig): WeaponConfig {
  const next = cloneWeaponConfig(config);
  next.dimensions = { ...DEFAULT_DIMENSIONS };
  return next;
}

export const GLB_EXPORT_QUALITIES: GlbExportQualitySpec[] = [
  {
    id: '500',
    label: '500',
    textureSize: 512,
    resolutionText: '512 × 512 px',
    tierHint: 'Lightweight · Fast web',
    filenameTag: '500',
  },
  {
    id: '1k',
    label: '1K',
    textureSize: 1024,
    resolutionText: '1024 × 1024 px',
    tierHint: 'Standard · Game ready',
    filenameTag: '1k',
  },
  {
    id: '2k',
    label: '2K',
    textureSize: 2048,
    resolutionText: '2048 × 2048 px',
    tierHint: 'High Detail · Showcase',
    filenameTag: '2k',
  },
  {
    id: '4k',
    label: '4K',
    textureSize: 4096,
    resolutionText: '4096 × 4096 px',
    tierHint: 'Ultra Studio · Cinematics',
    filenameTag: '4k',
  },
];

export function getGlbExportSpec(quality: GlbExportQuality): GlbExportQualitySpec {
  return (
    GLB_EXPORT_QUALITIES.find((q) => q.id === quality) ??
    GLB_EXPORT_QUALITIES[1]
  );
}

export function buildGlbExportFilename(weaponName: string, quality: GlbExportQuality): string {
  const slug =
    weaponName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'forgearm_weapon';
  const spec = getGlbExportSpec(quality);
  return `${slug}_${spec.filenameTag}.glb`;
}

export function formatExportByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

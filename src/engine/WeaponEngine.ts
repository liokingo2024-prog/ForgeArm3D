import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { SLOT_ORDER } from '../data/catalog';
import {
  CameraViewPreset,
  GlbExportQuality,
  GodotWeaponMetadata,
  HoveredPartInfo,
  HoveredRigBoneInfo,
  PartPaint,
  ProjectedRigNode,
  ResolvedMechanics,
  SlotId,
  ViewportTelemetry,
  WeaponConfig,
} from '../types/weapon';
import {
  buildMonochromeExportTint,
  quantizeExportWear,
  recompressGlbJpegs,
} from '../utils/glbOptimizer';
import { buildGodotWeaponMetadata } from '../utils/godotExporter';
import { MIXAMO_BONE_PREFIX, MIXAMO_FINGERS } from '../utils/handRig';
import { getGlbExportSpec, resolveMechanicalConstraints } from '../utils/weaponLogic';
import {
  buildWeaponSceneGraph,
  BuiltWeaponRig,
  WeaponMaterials,
} from './geometryBuilders';
import { TextureCache } from './textureGenerator';

export interface WeaponEngineCallbacks {
  onSelectSlot: (slot: SlotId) => void;
  onHoverSlot: (info: HoveredPartInfo | null) => void;
  onHoverBone?: (info: HoveredRigBoneInfo | null) => void;
  onTelemetry: (telemetry: ViewportTelemetry) => void;
  onProjectedRigNodes: (nodes: ProjectedRigNode[]) => void;
}

const DEFAULT_CAM_POS = new THREE.Vector3(1.08, 0.22, 0.34);
const DEFAULT_CAM_TARGET = new THREE.Vector3(0, 0.015, -0.09);

const _vec3 = new THREE.Vector3();
const _box3 = new THREE.Box3();
const _center = new THREE.Vector3();
const _size = new THREE.Vector3();
const _emissiveNone = new THREE.Color(0x000000);
const _emissiveHover = new THREE.Color(0x3a6a9c);
const _emissiveSelect = new THREE.Color(0xd97706);

function detectSoftwareWebGL(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

function getGeometryByteSize(geo: THREE.BufferGeometry): number {
  let bytes = geo.index ? geo.index.array.byteLength : 0;
  for (const attr of Object.values(geo.attributes)) {
    bytes += attr.array.byteLength;
  }
  return bytes;
}

function computeGeometryBucketKey(geo: THREE.BufferGeometry): string {
  const pos = geo.getAttribute('position');
  const norm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  const idx = geo.index;
  const pArr = pos?.array;
  const pLen = pArr ? pArr.length : 0;
  const s0 = pLen > 0 ? pArr![0].toFixed(4) : '0';
  const sMid = pLen > 2 ? pArr![Math.floor(pLen * 0.5)].toFixed(4) : '0';
  const sEnd = pLen > 0 ? pArr![pLen - 1].toFixed(4) : '0';
  return `${pos?.count ?? 0}|${norm?.count ?? 0}|${uv?.count ?? 0}|${idx?.count ?? 0}|${s0}|${sMid}|${sEnd}`;
}

function typedArraysEqual(a: THREE.TypedArray | undefined, b: THREE.TypedArray | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length || a.constructor !== b.constructor) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function geometriesIdentical(a: THREE.BufferGeometry, b: THREE.BufferGeometry): boolean {
  const aKeys = Object.keys(a.attributes);
  const bKeys = Object.keys(b.attributes);
  if (aKeys.length !== bKeys.length) return false;
  if (!typedArraysEqual(a.index?.array, b.index?.array)) return false;
  for (const k of aKeys) {
    if (!b.attributes[k]) return false;
    if (!typedArraysEqual(a.attributes[k].array, b.attributes[k].array)) return false;
  }
  return true;
}

function optimizeGeometryForExport(
  src: THREE.BufferGeometry,
  dedupBuckets: Map<string, THREE.BufferGeometry[]>,
  createdGeos: THREE.BufferGeometry[]
): THREE.BufferGeometry {
  let candidate: THREE.BufferGeometry = src;
  let ownsCandidate = false;

  if (!src.index && src.getAttribute('position')?.count > 0) {
    try {
      const welded = mergeVertices(src, 1e-4);
      if (getGeometryByteSize(welded) < getGeometryByteSize(src)) {
        candidate = welded;
        ownsCandidate = true;
      } else {
        welded.dispose();
      }
    } catch {
      // Keep original geometry if welding fails on an unusual primitive
    }
  }

  const key = computeGeometryBucketKey(candidate);
  const bucket = dedupBuckets.get(key);
  if (bucket) {
    for (const existing of bucket) {
      if (geometriesIdentical(existing, candidate)) {
        if (ownsCandidate) candidate.dispose();
        return existing;
      }
    }
    bucket.push(candidate);
  } else {
    dedupBuckets.set(key, [candidate]);
  }

  if (ownsCandidate) {
    createdGeos.push(candidate);
  }
  return candidate;
}

/**
 * Procedural Gunsmith Lightbox Environment for PMREM reflections:
 * Deep obsidian enclosure with crisp elongated overhead softboxes + warm/cool accent strips
 * so gunmetal bevels, flutes, and chamfers show realistic studio specular roll-off (never milky white).
 */
function createGunsmithStudioEnvironment(): THREE.Scene {
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color('#090c11');

  const addPanel = (
    w: number,
    h: number,
    pos: [number, number, number],
    lookAt: [number, number, number],
    colorHex: string,
    intensity: number
  ) => {
    const col = new THREE.Color(colorHex).multiplyScalar(intensity);
    const mat = new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.lookAt(lookAt[0], lookAt[1], lookAt[2]);
    envScene.add(mesh);
  };

  // Dark studio room walls (subtle cool-charcoal ambient tone)
  const roomMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#141923'),
    side: THREE.BackSide,
  });
  envScene.add(new THREE.Mesh(new THREE.BoxGeometry(12, 8, 12), roomMat));

  // Primary elongated overhead softbox strip running lengthwise along weapon Z axis
  addPanel(1.3, 6.2, [1.6, 3.6, 0.2], [0, 0, 0], '#fff6ea', 5.2);
  // Secondary crisp overhead accent softbox on opposite upper angle
  addPanel(0.95, 5.8, [-2.1, 3.2, -0.4], [0, 0, 0], '#dcebff', 3.4);
  // Warm right-front key card for clean side-flank bevel highlights
  addPanel(3.4, 1.3, [4.2, 0.7, 2.2], [0, 0, 0], '#ffe8cc', 2.4);
  // Cool rim-edge separation strip behind/left
  addPanel(3.8, 1.1, [-3.8, 0.9, -3.4], [0, 0, 0], '#a7cdfa', 3.2);
  // Low subtle workbench bounce band so undersides of barrels & trigger guards show metallic form
  addPanel(5.5, 5.5, [0, -3.4, 0], [0, 0, 0], '#2a3342', 1.15);

  return envScene;
}

function createStudioFloorGrid(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'studio_floor';

  // Radial-fade CAD floor grid drawn procedurally onto a high-res canvas
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 1024, 1024);

  const step = 32;
  ctx.strokeStyle = 'rgba(130, 150, 178, 0.14)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 1024; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 1024);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(1024, i);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(180, 198, 224, 0.24)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i <= 1024; i += step * 4) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 1024);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(1024, i);
    ctx.stroke();
  }

  // Radial fade mask
  ctx.globalCompositeOperation = 'destination-in';
  const grad = ctx.createRadialGradient(512, 512, 60, 512, 512, 500);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.62, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1024, 1024);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const gridMat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const gridMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), gridMat);
  gridMesh.rotation.x = -Math.PI * 0.5;
  gridMesh.position.set(0, -0.34, -0.15);
  group.add(gridMesh);

  // Soft studio contact shadow disc directly below the rifle
  const shCanvas = document.createElement('canvas');
  shCanvas.width = 256;
  shCanvas.height = 256;
  const sctx = shCanvas.getContext('2d')!;
  const sgrad = sctx.createRadialGradient(128, 128, 12, 128, 128, 124);
  sgrad.addColorStop(0, 'rgba(0,0,0,0.52)');
  sgrad.addColorStop(0.6, 'rgba(0,0,0,0.18)');
  sgrad.addColorStop(1, 'rgba(0,0,0,0)');
  sctx.fillStyle = sgrad;
  sctx.fillRect(0, 0, 256, 256);
  const shTex = new THREE.CanvasTexture(shCanvas);
  const shMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.55, 1.35),
    new THREE.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false })
  );
  shMesh.rotation.x = -Math.PI * 0.5;
  shMesh.position.set(0, -0.325, -0.15);
  group.add(shMesh);

  // Shadow-receiving matte studio floor plane
  const shadowFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(5, 5),
    new THREE.ShadowMaterial({ opacity: 0.32 })
  );
  shadowFloor.rotation.x = -Math.PI * 0.5;
  shadowFloor.position.set(0, -0.355, -0.15);
  shadowFloor.receiveShadow = true;
  group.add(shadowFloor);

  return group;
}

export class WeaponEngine {
  private container: HTMLElement;
  private callbacks: WeaponEngineCallbacks;
  private isSoftwareGl: boolean;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private envRenderTarget: THREE.WebGLRenderTarget;
  private textureCache: TextureCache;
  private materials: WeaponMaterials;
  private rig: BuiltWeaponRig | null = null;
  private currentMechanics: ResolvedMechanics | null = null;
  private currentConfig: WeaponConfig | null = null;

  // VFX & studio floor kept outside WeaponRoot so exports stay 100% clean
  private studioFloor: THREE.Group;
  private vfxGroup: THREE.Group;
  private muzzleFlashMesh: THREE.Mesh;
  private muzzleLight: THREE.PointLight;

  // Socket & Mixamo hand-bone gizmo overlay group (outside WeaponRoot)
  private rigGizmoGroup: THREE.Group;
  private handBoneLines: THREE.LineSegments | null = null;
  private handBonePairs: Array<[THREE.Bone, THREE.Bone]> = [];
  private handBoneGizmos: THREE.Mesh[] = [];
  private hoveredBoneAxisGizmo: THREE.LineSegments | null = null;
  private hoveredBoneName: string | null = null;
  private rigOverlayEnabled = false;
  private wireframeEnabled = false;

  // Selection & hover state
  private activeSlot: SlotId = 'receiver';
  private hovered3DSlot: SlotId | null = null;
  private hoveredUISlot: SlotId | null = null;
  private selectPulse = 0;

  // Animation states
  private fireTimer = 0;
  private reloadTimer = 0;
  private stockFoldTarget = 0;
  private stockFoldCurrent = 0;

  // Smooth camera transition
  private camGoalPos: THREE.Vector3 | null = null;
  private camGoalTarget: THREE.Vector3 | null = null;
  private activeViewPreset: CameraViewPreset = 'three_quarter';
  private userHasInteracted = false;

  // Input / raycasting
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private isOrbiting = false;
  private pointerDownPos = { x: 0, y: 0 };
  private lastRaycastTime = 0;

  // Render scheduling (on-demand + software-GL fence pacing)
  private frameId = 0;
  private renderBusy = false;
  private renderDirty = false;
  private lastFrameTime = performance.now();
  private disposed = false;
  private resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, callbacks: WeaponEngineCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.isSoftwareGl = detectSoftwareWebGL();

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0c0f14');
    this.scene.fog = new THREE.Fog('#0c0f14', 3.2, 7.8);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const studioEnv = createGunsmithStudioEnvironment();
    this.envRenderTarget = pmrem.fromScene(studioEnv, 0.032);
    this.scene.environment = this.envRenderTarget.texture;
    this.scene.environmentIntensity = 1.48;
    studioEnv.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const m = obj as THREE.Mesh;
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    pmrem.dispose();

    const aspect = w / h;
    this.camera = new THREE.PerspectiveCamera(aspect < 1 ? 46 : 34, aspect, 0.015, 24);
    this.camera.position.copy(DEFAULT_CAM_POS);
    if (aspect < 1) {
      this.camera.position.multiplyScalar(1.38);
    }

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(DEFAULT_CAM_TARGET);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.zoomSpeed = 1.15;
    this.controls.rotateSpeed = 0.85;
    this.controls.minDistance = 0.14;
    this.controls.maxDistance = 3.4;
    this.controls.minPolarAngle = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.92;
    this.controls.update();

    // 3-point studio lighting calibrated for crisp machined steel bevels & rich matte furniture
    const keyLight = new THREE.DirectionalLight('#fff5e8', 2.75);
    keyLight.position.set(1.5, 2.3, 1.3);
    keyLight.castShadow = !this.isSoftwareGl;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 0.2;
    keyLight.shadow.camera.far = 6;
    keyLight.shadow.camera.left = -1.0;
    keyLight.shadow.camera.right = 1.0;
    keyLight.shadow.camera.top = 1.0;
    keyLight.shadow.camera.bottom = -1.0;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.015;
    this.scene.add(keyLight);

    const hemiLight = new THREE.HemisphereLight('#b8d2f2', '#26201c', 0.95);
    this.scene.add(hemiLight);

    const rimLight = new THREE.DirectionalLight('#b4d4ff', 1.75);
    rimLight.position.set(-1.6, 1.35, -1.6);
    this.scene.add(rimLight);

    const bounceFill = new THREE.DirectionalLight('#f0c89a', 0.72);
    bounceFill.position.set(0.3, -1.0, 0.9);
    this.scene.add(bounceFill);

    this.studioFloor = createStudioFloorGrid();
    this.scene.add(this.studioFloor);

    // Muzzle flash VFX (kept outside root_weapon so GLB export stays pristine)
    this.vfxGroup = new THREE.Group();
    this.vfxGroup.name = 'vfx_external';
    const flashMat = new THREE.MeshBasicMaterial({
      color: '#ffbe55',
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const flashGeo = new THREE.ConeGeometry(0.032, 0.14, 7);
    flashGeo.rotateX(-Math.PI * 0.5);
    flashGeo.translate(0, 0, -0.07);
    this.muzzleFlashMesh = new THREE.Mesh(flashGeo, flashMat);
    this.muzzleFlashMesh.visible = false;
    this.vfxGroup.add(this.muzzleFlashMesh);

    this.muzzleLight = new THREE.PointLight('#ffaa38', 0, 1.8);
    this.vfxGroup.add(this.muzzleLight);
    this.scene.add(this.vfxGroup);

    // Rig gizmo overlay group (outside root_weapon)
    this.rigGizmoGroup = new THREE.Group();
    this.rigGizmoGroup.name = 'rig_gizmos';
    this.rigGizmoGroup.visible = false;
    this.scene.add(this.rigGizmoGroup);

    this.textureCache = new TextureCache(
      this.renderer.capabilities.getMaxAnisotropy(),
      this.isSoftwareGl ? 512 : 1024
    );
    this.materials = this.createBaseMaterials();

    this.bindEvents();

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
  }

  private static readonly AUX_PAINTS: Record<'darkSteel' | 'chromeSteel' | 'brass' | 'rubber', PartPaint> = {
    darkSteel: {
      primaryColor: '#2d3440',
      secondaryColor: '#1b2028',
      pattern: 'brushed_steel',
      metalness: 0.9,
      roughness: 0.36,
      patternScale: 1.4,
      wear: 0.14,
    },
    chromeSteel: {
      primaryColor: '#a2acb9',
      secondaryColor: '#76808f',
      pattern: 'brushed_steel',
      metalness: 0.95,
      roughness: 0.24,
      patternScale: 1.6,
      wear: 0.08,
    },
    brass: {
      primaryColor: '#cfa84e',
      secondaryColor: '#9c7830',
      pattern: 'brushed_steel',
      metalness: 0.94,
      roughness: 0.24,
      patternScale: 2.0,
      wear: 0.05,
    },
    rubber: {
      primaryColor: '#1b1e23',
      secondaryColor: '#121418',
      pattern: 'solid',
      metalness: 0.02,
      roughness: 0.94,
      patternScale: 2.0,
      wear: 0.06,
    },
  };

  private createBaseMaterials(): WeaponMaterials {
    const bySlot = {} as Record<SlotId, THREE.MeshPhysicalMaterial>;
    for (const slot of SLOT_ORDER) {
      bySlot[slot] = new THREE.MeshPhysicalMaterial({
        color: '#ffffff',
        metalness: 0.5,
        roughness: 0.4,
        normalScale: new THREE.Vector2(0.75, 0.75),
        clearcoat: 0,
        clearcoatRoughness: 0.4,
      });
    }

    // Shared micro-textured maps for auxiliary hardware (rails, bolts, triggers, gas blocks, butt-pads)
    const darkSteelMaps = this.textureCache.getMaps(WeaponEngine.AUX_PAINTS.darkSteel);
    const chromeMaps = this.textureCache.getMaps(WeaponEngine.AUX_PAINTS.chromeSteel);
    const brassMaps = this.textureCache.getMaps(WeaponEngine.AUX_PAINTS.brass);
    const rubberMaps = this.textureCache.getMaps(WeaponEngine.AUX_PAINTS.rubber);

    return {
      bySlot,
      darkSteel: new THREE.MeshStandardMaterial({
        color: '#ffffff',
        map: darkSteelMaps.map,
        normalMap: darkSteelMaps.normalMap,
        normalScale: new THREE.Vector2(0.46, 0.46),
        roughnessMap: darkSteelMaps.roughnessMap,
        metalnessMap: darkSteelMaps.metalnessMap,
        metalness: 0.9,
        roughness: 0.36,
        envMapIntensity: 1.45,
      }),
      chromeSteel: new THREE.MeshStandardMaterial({
        color: '#ffffff',
        map: chromeMaps.map,
        normalMap: chromeMaps.normalMap,
        normalScale: new THREE.Vector2(0.36, 0.36),
        roughnessMap: chromeMaps.roughnessMap,
        metalnessMap: chromeMaps.metalnessMap,
        metalness: 0.96,
        roughness: 0.22,
        envMapIntensity: 1.65,
      }),
      brass: new THREE.MeshStandardMaterial({
        color: '#ffffff',
        map: brassMaps.map,
        normalMap: brassMaps.normalMap,
        normalScale: new THREE.Vector2(0.26, 0.26),
        roughnessMap: brassMaps.roughnessMap,
        metalnessMap: brassMaps.metalnessMap,
        metalness: 0.95,
        roughness: 0.23,
        envMapIntensity: 1.7,
      }),
      rubber: new THREE.MeshStandardMaterial({
        color: '#ffffff',
        map: rubberMaps.map,
        normalMap: rubberMaps.normalMap,
        normalScale: new THREE.Vector2(0.52, 0.52),
        roughnessMap: rubberMaps.roughnessMap,
        metalnessMap: rubberMaps.metalnessMap,
        metalness: 0.02,
        roughness: 0.92,
        envMapIntensity: 0.48,
      }),
      opticLens: new THREE.MeshPhysicalMaterial({
        color: '#1f6ea8',
        metalness: 0.28,
        roughness: 0.05,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        ior: 1.52,
        envMapIntensity: 1.85,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      emissiveAmber: new THREE.MeshStandardMaterial({
        color: '#f59e0b',
        emissive: '#f59e0b',
        emissiveIntensity: 1.4,
        roughness: 0.25,
      }),
      emissiveCyan: new THREE.MeshStandardMaterial({
        color: '#38bdf8',
        emissive: '#0ea5e9',
        emissiveIntensity: 1.8,
        roughness: 0.2,
      }),
      emissiveRed: new THREE.MeshStandardMaterial({
        color: '#ef4444',
        emissive: '#ef4444',
        emissiveIntensity: 2.0,
        roughness: 0.2,
      }),
    };
  }

  private bindEvents(): void {
    const dom = this.renderer.domElement;

    this.controls.addEventListener('start', () => {
      this.isOrbiting = true;
      this.userHasInteracted = true;
      // Cancel any scripted camera transition immediately so user stays in control
      this.camGoalPos = null;
      this.camGoalTarget = null;
      if (this.hovered3DSlot) {
        this.hovered3DSlot = null;
        this.callbacks.onHoverSlot(null);
        this.applyHighlightEmissives();
      }
    });

    this.controls.addEventListener('end', () => {
      this.isOrbiting = false;
      this.requestRender();
    });

    this.controls.addEventListener('change', () => {
      this.requestRender();
    });

    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointerleave', this.onPointerLeave);
    dom.addEventListener('dblclick', this.onDoubleClick);
    dom.addEventListener('webglcontextlost', this.onContextLost);
  }

  private onContextLost = (e: Event): void => {
    e.preventDefault();
  };

  private updatePointerNDC(e: PointerEvent | MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private pickSlot(e: PointerEvent | MouseEvent): SlotId | null {
    if (!this.rig || this.rig.interactables.length === 0) return null;
    this.updatePointerNDC(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.rig.interactables, false);
    if (hits.length > 0) {
      return (hits[0].object.userData.slot as SlotId) ?? null;
    }
    return null;
  }

  private pickBoneGizmo(e: PointerEvent | MouseEvent): HoveredRigBoneInfo | null {
    if (!this.rigOverlayEnabled || !this.rig || this.handBoneGizmos.length === 0) return null;
    this.updatePointerNDC(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.handBoneGizmos, false);
    if (hits.length === 0) return null;
    const obj = hits[0].object;
    const name = obj.userData.boneName as string | undefined;
    const mixamoName = obj.userData.mixamoName as string | undefined;
    const hand = obj.userData.hand as 'left' | 'right' | undefined;
    if (!name || !mixamoName || !hand) return null;
    const bone = this.rig.handBones.get(name);
    const radToDeg = 180 / Math.PI;
    const round2 = (v: number) => {
      const r = Math.round(v * 100) / 100;
      return Object.is(r, -0) ? 0 : r;
    };
    const round4 = (v: number) => {
      const r = Math.round(v * 1e4) / 1e4;
      return Object.is(r, -0) ? 0 : r;
    };
    const rotationRad = (bone?.userData.rotation as [number, number, number] | undefined) ?? [
      round4(bone?.rotation.x ?? 0),
      round4(bone?.rotation.y ?? 0),
      round4(bone?.rotation.z ?? 0),
    ];
    const rotationDeg = (bone?.userData.rotation_deg as [number, number, number] | undefined) ?? [
      round2(rotationRad[0] * radToDeg),
      round2(rotationRad[1] * radToDeg),
      round2(rotationRad[2] * radToDeg),
    ];
    const worldRotationDeg =
      (bone?.userData.world_rotation_deg as [number, number, number] | undefined) ?? rotationDeg;
    const quaternion = (bone?.userData.quaternion as [number, number, number, number] | undefined) ?? [
      round4(bone?.quaternion.x ?? 0),
      round4(bone?.quaternion.y ?? 0),
      round4(bone?.quaternion.z ?? 0),
      round4(bone?.quaternion.w ?? 1),
    ];

    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      name,
      mixamoName,
      hand,
      screenX: e.clientX - rect.left,
      screenY: e.clientY - rect.top,
      rotationRad,
      rotationDeg,
      worldRotationDeg,
      quaternion,
    };
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.isOrbiting) return;
    const now = performance.now();
    if (now - this.lastRaycastTime < 35) return;
    this.lastRaycastTime = now;

    const hitBone = this.pickBoneGizmo(e);
    this.callbacks.onHoverBone?.(hitBone);

    const nextBoneName = hitBone?.name ?? null;
    if (nextBoneName !== this.hoveredBoneName) {
      this.hoveredBoneName = nextBoneName;
      if (this.hoveredBoneAxisGizmo) {
        const targetBone = nextBoneName ? this.rig?.handBones.get(nextBoneName) : undefined;
        if (targetBone) {
          this.hoveredBoneAxisGizmo.userData.trackTarget = targetBone;
          this.hoveredBoneAxisGizmo.visible = true;
        } else {
          this.hoveredBoneAxisGizmo.userData.trackTarget = undefined;
          this.hoveredBoneAxisGizmo.visible = false;
        }
        this.requestRender();
      }
    }

    const hitSlot = this.pickSlot(e);
    const dom = this.renderer.domElement;
    dom.style.cursor = hitBone || hitSlot ? 'pointer' : 'grab';

    if (hitSlot !== this.hovered3DSlot) {
      this.hovered3DSlot = hitSlot;
      this.applyHighlightEmissives();
      this.requestRender();
    }

    if (hitSlot && !hitBone) {
      const rect = dom.getBoundingClientRect();
      this.callbacks.onHoverSlot({
        slot: hitSlot,
        screenX: e.clientX - rect.left,
        screenY: e.clientY - rect.top,
      });
    } else {
      this.callbacks.onHoverSlot(null);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const dist = Math.hypot(
      e.clientX - this.pointerDownPos.x,
      e.clientY - this.pointerDownPos.y
    );
    if (dist > 5) return; // Was an orbit drag, not a click

    const hitSlot = this.pickSlot(e);
    if (hitSlot) {
      this.activeSlot = hitSlot;
      this.selectPulse = 1.0;
      this.callbacks.onSelectSlot(hitSlot);
      this.applyHighlightEmissives();
      this.requestRender();
    }
  };

  private onPointerLeave = (): void => {
    this.callbacks.onHoverBone?.(null);
    if (this.hoveredBoneName !== null) {
      this.hoveredBoneName = null;
      if (this.hoveredBoneAxisGizmo) {
        this.hoveredBoneAxisGizmo.userData.trackTarget = undefined;
        this.hoveredBoneAxisGizmo.visible = false;
        this.requestRender();
      }
    }
    if (this.hovered3DSlot) {
      this.hovered3DSlot = null;
      this.callbacks.onHoverSlot(null);
      this.applyHighlightEmissives();
      this.requestRender();
    }
  };

  private onDoubleClick = (e: MouseEvent): void => {
    const hitSlot = this.pickSlot(e);
    if (hitSlot) {
      this.activeSlot = hitSlot;
      this.callbacks.onSelectSlot(hitSlot);
      this.focusOnSlot(hitSlot);
    }
  };

  /**
   * Rebuilds procedural 3D weapon geometry cleanly (called on part or dimension changes).
   */
  public rebuildGeometry(config: WeaponConfig): void {
    const mechanics = resolveMechanicalConstraints(config);
    this.currentMechanics = mechanics;
    this.currentConfig = config;

    // Dispose old rig geometry cleanly
    if (this.rig) {
      this.disposeObjectGeometries(this.rig.root);
      this.scene.remove(this.rig.root);
      this.rig = null;
    }

    this.updateMaterials(config);
    this.rig = buildWeaponSceneGraph(config, mechanics, this.materials);
    this.scene.add(this.rig.root);

    // Preserve folded stock state if currently folded
    this.rig.boneStock.rotation.y = this.stockFoldCurrent;

    this.applyWireframeState();
    this.applyHighlightEmissives();
    this.rebuildRigGizmos();

    this.callbacks.onTelemetry({
      triangles: this.rig.triangleCount,
      partCount: this.rig.partCount,
      lengthCm: mechanics.estimatedLengthCm,
    });

    this.requestRender();
  }

  /**
   * Mutates PBR materials in place (zero geometry rebuild, 60 FPS slider responsiveness).
   */
  public updateMaterials(config: WeaponConfig): void {
    this.currentConfig = config;
    for (const slot of SLOT_ORDER) {
      const paint = config.paints[slot];
      const mat = this.materials.bySlot[slot];
      const maps = this.textureCache.getMaps(paint);

      mat.color.set('#ffffff');
      mat.map = maps.map;
      mat.normalMap = maps.normalMap;
      mat.roughnessMap = maps.roughnessMap;
      mat.metalnessMap = maps.metalnessMap;
      mat.metalness = paint.metalness;
      mat.roughness = paint.roughness;

      // Pattern-calibrated tangent-space normal depth, anisotropy & clearcoat physics
      let nScale = 0.52;
      let clearcoat = 0.0;
      let clearcoatRoughness = 0.38;
      let anisotropy = 0.0;
      switch (paint.pattern) {
        case 'wood':
          nScale = 0.62;
          clearcoat = 0.3 * (1 - paint.wear * 0.45);
          clearcoatRoughness = 0.32;
          break;
        case 'carbon':
          nScale = 0.78;
          clearcoat = 0.74 * (1 - paint.wear * 0.32);
          clearcoatRoughness = 0.12;
          break;
        case 'brushed_steel':
          nScale = 0.52 + paint.wear * 0.16;
          clearcoat = 0.12 * (1 - paint.wear * 0.45);
          clearcoatRoughness = 0.28;
          anisotropy = 0.52 * (1 - paint.wear * 0.35);
          break;
        case 'hex_tech':
          nScale = 0.76;
          clearcoat = 0.2 * (1 - paint.wear * 0.35);
          clearcoatRoughness = 0.24;
          anisotropy = 0.28;
          break;
        case 'digital_camo':
        case 'tiger_stripe':
          nScale = 0.44 + paint.wear * 0.18;
          clearcoat = 0.0;
          break;
        case 'solid':
        default:
          nScale = 0.46 + paint.wear * 0.2;
          clearcoat = 0.0;
          break;
      }

      mat.normalScale.set(nScale, nScale);
      mat.clearcoat = clearcoat;
      mat.clearcoatRoughness = clearcoatRoughness;
      mat.anisotropy = anisotropy;
      mat.envMapIntensity = 0.62 + paint.metalness * 1.08;
      mat.needsUpdate = true;
    }
    this.applyHighlightEmissives();
    this.requestRender();
  }

  public setActiveSlot(slot: SlotId, pulse = false): void {
    this.activeSlot = slot;
    if (pulse) this.selectPulse = 1.0;
    this.applyHighlightEmissives();
    this.requestRender();
  }

  public setHoveredUISlot(slot: SlotId | null): void {
    if (this.hoveredUISlot === slot) return;
    this.hoveredUISlot = slot;
    this.applyHighlightEmissives();
    this.requestRender();
  }

  private applyHighlightEmissives(): void {
    const hoverTarget = this.hovered3DSlot ?? this.hoveredUISlot;
    for (const slot of SLOT_ORDER) {
      const mat = this.materials.bySlot[slot];
      if (slot === this.activeSlot && this.selectPulse > 0.02) {
        mat.emissive.copy(_emissiveSelect);
        mat.emissiveIntensity = 0.18 * this.selectPulse;
      } else if (slot === hoverTarget) {
        mat.emissive.copy(_emissiveHover);
        mat.emissiveIntensity = 0.24;
      } else {
        mat.emissive.copy(_emissiveNone);
        mat.emissiveIntensity = 0;
      }
    }
  }

  public focusOnSlot(slot: SlotId): void {
    if (!this.rig) return;
    const grp = this.rig.slotGroups[slot];
    if (!grp) return;

    this.rig.root.updateMatrixWorld(true);
    _box3.setFromObject(grp);
    if (_box3.isEmpty()) {
      this.resetCamera();
      return;
    }

    _box3.getCenter(_center);
    _box3.getSize(_size);
    const radius = Math.max(0.09, _size.length() * 0.5);
    const dist = Math.max(0.32, radius * 2.55);

    this.camGoalTarget = _center.clone();
    this.camGoalPos = new THREE.Vector3(
      _center.x + dist * 0.88,
      _center.y + dist * 0.24,
      _center.z + dist * 0.42
    );
    this.requestRender();
  }

  public setCameraView(preset: CameraViewPreset, instant = false): void {
    this.activeViewPreset = preset;
    if (!this.rig) {
      this.camGoalTarget = DEFAULT_CAM_TARGET.clone();
      this.camGoalPos = DEFAULT_CAM_POS.clone();
      this.requestRender();
      return;
    }

    this.rig.root.updateMatrixWorld(true);
    _box3.setFromObject(this.rig.root);
    _box3.getCenter(_center);
    _box3.getSize(_size);

    const safeAspect = Math.max(0.65, Math.min(2.4, Number.isFinite(this.camera.aspect) ? this.camera.aspect : 1.3));
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * safeAspect);
    const spanHoriz = Math.max(0.45, Math.min(1.6, _size.z));
    const spanVert = Math.max(0.24, Math.min(0.8, _size.y));
    const distH = (spanHoriz * 0.6) / Math.tan(hFov * 0.5);
    const distV = (spanVert * 0.7) / Math.tan(vFov * 0.5);
    const fitDist = Math.min(2.15, Math.max(distH, distV, 0.78));

    const target = _center.clone();
    const pos = new THREE.Vector3();

    switch (preset) {
      case 'three_quarter':
        pos.set(target.x + fitDist * 0.94, target.y + fitDist * 0.17, target.z + fitDist * 0.34);
        break;
      case 'right':
        pos.set(target.x + fitDist * 1.02, target.y + 0.02, target.z);
        break;
      case 'left':
        pos.set(target.x - fitDist * 1.02, target.y + 0.02, target.z);
        break;
      case 'top':
        pos.set(target.x + 0.04, target.y + fitDist * 1.08, target.z + 0.02);
        break;
      case 'ads': {
        const m = this.currentMechanics;
        const aimY = m ? m.socketAdsPos.y : target.y + 0.08;
        const aimZ = m ? m.socketAdsPos.z + 0.22 : target.z + 0.45;
        target.set(0, aimY, m ? m.socketMuzzlePos.z : target.z - 0.5);
        pos.set(0.012, aimY + 0.006, aimZ);
        break;
      }
    }

    if (instant) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.camGoalPos = null;
      this.camGoalTarget = null;
    } else {
      this.camGoalTarget = target;
      this.camGoalPos = pos;
    }
    this.requestRender();
  }

  public resetCamera(): void {
    this.setCameraView('three_quarter', false);
  }

  public triggerFire(): void {
    this.fireTimer = 0.22;
    this.requestRender();
  }

  public triggerReload(): void {
    this.reloadTimer = 1.25;
    this.requestRender();
  }

  public toggleFoldStock(): boolean {
    const isFolding = this.stockFoldTarget === 0;
    this.stockFoldTarget = isFolding ? -THREE.MathUtils.degToRad(165) : 0;
    this.requestRender();
    return isFolding;
  }

  public setRigOverlay(enabled: boolean): void {
    this.rigOverlayEnabled = enabled;
    this.rigGizmoGroup.visible = enabled;
    if (!enabled) {
      this.callbacks.onHoverBone?.(null);
      this.callbacks.onProjectedRigNodes([]);
    }
    this.requestRender();
  }

  public setWireframe(enabled: boolean): void {
    this.wireframeEnabled = enabled;
    this.applyWireframeState();
    this.requestRender();
  }

  private applyWireframeState(): void {
    for (const slot of SLOT_ORDER) {
      this.materials.bySlot[slot].wireframe = this.wireframeEnabled;
    }
    this.materials.darkSteel.wireframe = this.wireframeEnabled;
    this.materials.chromeSteel.wireframe = this.wireframeEnabled;
    this.materials.brass.wireframe = this.wireframeEnabled;
    this.materials.rubber.wireframe = this.wireframeEnabled;
  }

  private getSocketOverlaySpecs(): Array<{
    obj: THREE.Object3D;
    shortLabel: string;
    color: string;
    axisDir?: 'forward' | 'eject' | 'grip_right' | 'grip_left';
  }> {
    if (!this.rig) return [];
    const list: Array<{
      obj: THREE.Object3D;
      shortLabel: string;
      color: string;
      axisDir?: 'forward' | 'eject' | 'grip_right' | 'grip_left';
    }> = [
      { obj: this.rig.socketMuzzle, shortLabel: 'Muzzle', color: '#f59e0b', axisDir: 'forward' },
      { obj: this.rig.socketGripRight, shortLabel: 'Grip_Right', color: '#10b981', axisDir: 'grip_right' },
      { obj: this.rig.socketGripLeft, shortLabel: 'Grip_Left', color: '#06b6d4', axisDir: 'grip_left' },
      { obj: this.rig.socketAds, shortLabel: 'ADS', color: '#a855f7', axisDir: 'forward' },
      { obj: this.rig.socketEject, shortLabel: 'Eject', color: '#f43f5e', axisDir: 'eject' },
      { obj: this.rig.socketMag, shortLabel: 'Mag', color: '#3b82f6' },
      { obj: this.rig.socketOptic, shortLabel: 'Optic', color: '#eab308' },
    ];
    if (this.rig.socketShoulder) {
      list.push({ obj: this.rig.socketShoulder, shortLabel: 'Shoulder', color: '#f97316' });
    }
    if (this.rig.socketUnderbarrel) {
      list.push({ obj: this.rig.socketUnderbarrel, shortLabel: 'Underbarrel', color: '#14b8a6' });
    }
    return list;
  }

  private buildSocketGizmoObject(
    color: string,
    axisDir?: 'forward' | 'eject' | 'grip_right' | 'grip_left'
  ): THREE.Group {
    const g = new THREE.Group();
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.0062, 12, 12),
      new THREE.MeshBasicMaterial({
        color,
        depthTest: false,
        transparent: true,
        opacity: 0.96,
      })
    );
    dot.renderOrder = 1000;
    g.add(dot);

    // Compact XYZ local orientation triad (+X / contact normal red, +Y grip_up green, -Z grip_forward cyan-blue)
    const len = 0.026;
    const xLen =
      axisDir === 'eject'
        ? 0.044
        : axisDir === 'grip_right'
          ? 0.042
          : axisDir === 'grip_left'
            ? -0.042
            : len;
    const upLen = axisDir === 'grip_right' || axisDir === 'grip_left' ? 0.036 : len;
    const fwdLen = axisDir === 'forward' ? 0.046 : axisDir === 'grip_right' || axisDir === 'grip_left' ? 0.036 : len;
    const positions = new Float32Array([
      0, 0, 0, xLen, 0, 0,
      0, 0, 0, 0, upLen, 0,
      0, 0, 0, 0, 0, -fwdLen,
    ]);
    const colors = new Float32Array([
      0.96, 0.28, 0.34, 0.96, 0.28, 0.34, // +X (or outward palm contact normal)
      0.22, 0.88, 0.48, 0.22, 0.88, 0.48, // +Y (grip_up)
      0.26, 0.68, 0.98, 0.26, 0.68, 0.98, // -Z (grip_forward)
    ]);
    const axisGeo = new THREE.BufferGeometry();
    axisGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    axisGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const axisLines = new THREE.LineSegments(
      axisGeo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        depthTest: false,
        transparent: true,
        opacity: 0.92,
      })
    );
    axisLines.renderOrder = 999;
    g.add(axisLines);
    return g;
  }

  private buildBoneAxisTriad(axisLen: number): THREE.LineSegments {
    const positions = new Float32Array([
      0, 0, 0, axisLen, 0, 0,
      0, 0, 0, 0, axisLen * 1.25, 0,
      0, 0, 0, 0, 0, axisLen,
    ]);
    const colors = new Float32Array([
      0.96, 0.28, 0.34, 0.96, 0.28, 0.34, // +X bone lateral
      0.22, 0.88, 0.48, 0.22, 0.88, 0.48, // +Y longitudinal bone axis
      0.26, 0.68, 0.98, 0.26, 0.68, 0.98, // +Z bone normal/hinge
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        depthTest: false,
        transparent: true,
        opacity: 0.92,
      })
    );
    lines.renderOrder = 1002;
    return lines;
  }

  private rebuildRigGizmos(): void {
    this.disposeObjectGeometries(this.rigGizmoGroup);
    this.rigGizmoGroup.clear();
    this.handBoneLines = null;
    this.handBonePairs = [];
    this.handBoneGizmos = [];
    this.hoveredBoneAxisGizmo = null;
    this.hoveredBoneName = null;
    if (!this.rig) return;

    for (const spec of this.getSocketOverlaySpecs()) {
      const gizmo = this.buildSocketGizmoObject(spec.color, spec.axisDir);
      gizmo.userData.trackTarget = spec.obj;
      this.rigGizmoGroup.add(gizmo);
    }

    // Articulated Mixamo hand bone joint spheres, local rotation triads, & connecting segments
    const wristMatR = new THREE.MeshBasicMaterial({
      color: '#34d399',
      depthTest: false,
      transparent: true,
      opacity: 0.96,
    });
    const jointMatR = new THREE.MeshBasicMaterial({
      color: '#10b981',
      depthTest: false,
      transparent: true,
      opacity: 0.94,
    });
    const wristMatL = new THREE.MeshBasicMaterial({
      color: '#22d3ee',
      depthTest: false,
      transparent: true,
      opacity: 0.96,
    });
    const jointMatL = new THREE.MeshBasicMaterial({
      color: '#06b6d4',
      depthTest: false,
      transparent: true,
      opacity: 0.94,
    });

    const wristGeo = new THREE.SphereGeometry(0.0052, 12, 12);
    const knuckleGeo = new THREE.SphereGeometry(0.0031, 10, 10);
    const tipGeo = new THREE.SphereGeometry(0.0024, 8, 8);

    const pairs: Array<[THREE.Bone, THREE.Bone]> = [];
    const lineColors: number[] = [];
    const colR = new THREE.Color('#34d399');
    const colL = new THREE.Color('#22d3ee');

    for (const side of ['Right', 'Left'] as const) {
      const wristName = `${side}Hand`;
      const wristBone = this.rig.handBones.get(wristName);
      if (!wristBone) continue;

      const wMesh = new THREE.Mesh(wristGeo, side === 'Right' ? wristMatR : wristMatL);
      wMesh.renderOrder = 1001;
      wMesh.userData.trackTarget = wristBone;
      wMesh.userData.boneName = wristName;
      wMesh.userData.mixamoName = `${MIXAMO_BONE_PREFIX}${wristName}`;
      wMesh.userData.hand = side.toLowerCase();
      wMesh.add(this.buildBoneAxisTriad(0.024));
      this.rigGizmoGroup.add(wMesh);
      this.handBoneGizmos.push(wMesh);

      const lineCol = side === 'Right' ? colR : colL;
      const jMat = side === 'Right' ? jointMatR : jointMatL;

      for (const finger of MIXAMO_FINGERS) {
        let prevBone: THREE.Bone = wristBone;
        for (let p = 1; p <= 4; p++) {
          const boneName = `${wristName}${finger}${p}`;
          const bone = this.rig.handBones.get(boneName);
          if (!bone) continue;
          const jMesh = new THREE.Mesh(p === 4 ? tipGeo : knuckleGeo, jMat);
          jMesh.renderOrder = 1001;
          jMesh.userData.trackTarget = bone;
          jMesh.userData.boneName = boneName;
          jMesh.userData.mixamoName = `${MIXAMO_BONE_PREFIX}${boneName}`;
          jMesh.userData.hand = side.toLowerCase();
          this.rigGizmoGroup.add(jMesh);
          this.handBoneGizmos.push(jMesh);

          pairs.push([prevBone, bone]);
          lineColors.push(lineCol.r, lineCol.g, lineCol.b, lineCol.r, lineCol.g, lineCol.b);
          prevBone = bone;
        }
      }
    }

    const hoverTriad = this.buildBoneAxisTriad(0.02);
    hoverTriad.visible = false;
    this.hoveredBoneAxisGizmo = hoverTriad;
    this.rigGizmoGroup.add(hoverTriad);

    if (pairs.length > 0) {
      this.handBonePairs = pairs;
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(pairs.length * 6), 3)
      );
      lineGeo.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array(lineColors), 3)
      );
      const lines = new THREE.LineSegments(
        lineGeo,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          depthTest: false,
          transparent: true,
          opacity: 0.9,
        })
      );
      lines.renderOrder = 1000;
      lines.frustumCulled = false;
      this.handBoneLines = lines;
      this.rigGizmoGroup.add(lines);
    }
  }

  private getLeftGripOverlayLabel(): string {
    const m = this.currentMechanics;
    if (!m) return 'Handguard';
    const placementTag =
      m.leftGripPlacement === 'rear_of_attachment'
        ? 'Rear'
        : m.leftGripPlacement === 'front_of_attachment'
          ? 'Front'
          : m.leftGripPlacement === 'wrapped_attachment'
            ? 'Clear'
            : null;
    switch (m.effectiveUnderbarrel) {
      case 'vertical_grip':
        return 'Vertical Grip';
      case 'angled_grip':
        return 'Angled AFG';
      case 'handstop_kit':
        return 'Handstop Pocket';
      case 'grenade_launcher':
        return '40mm M203';
      case 'masterkey_shotgun':
        return 'Masterkey Pump';
      case 'tactical_light':
        return `Scout Light (${placementTag ?? 'Clear'})`;
      case 'tactical_laser':
        return `PEQ-15 (${placementTag ?? 'Clear'})`;
      case 'bipod':
        return `Bipod (${placementTag ?? 'Clear'})`;
      case 'none':
        return m.leftGripPlacement === 'bare_barrel' ? 'Bare Barrel' : 'Handguard';
    }
  }

  private syncRigGizmosAndProject(): void {
    if (!this.rig || !this.rigOverlayEnabled) return;
    this.rig.root.updateMatrixWorld(true);
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;

    for (const child of this.rigGizmoGroup.children) {
      const target = child.userData.trackTarget as THREE.Object3D | undefined;
      if (target) {
        target.getWorldPosition(child.position);
        target.getWorldQuaternion(child.quaternion);
      }
    }

    if (this.handBoneLines && this.handBonePairs.length > 0) {
      const posAttr = this.handBoneLines.geometry.getAttribute('position') as THREE.BufferAttribute;
      const tmpA = new THREE.Vector3();
      const tmpB = new THREE.Vector3();
      for (let i = 0; i < this.handBonePairs.length; i++) {
        const [parentBone, childBone] = this.handBonePairs[i];
        parentBone.getWorldPosition(tmpA);
        childBone.getWorldPosition(tmpB);
        posAttr.setXYZ(i * 2, tmpA.x, tmpA.y, tmpA.z);
        posAttr.setXYZ(i * 2 + 1, tmpB.x, tmpB.y, tmpB.z);
      }
      posAttr.needsUpdate = true;
    }

    const projected: ProjectedRigNode[] = this.getSocketOverlaySpecs().map((spec) => {
      spec.obj.getWorldPosition(_vec3);
      _vec3.project(this.camera);
      return {
        name: spec.obj.name,
        shortLabel: spec.shortLabel,
        color: spec.color,
        kind: 'socket',
        x: ((_vec3.x + 1) * 0.5) * w,
        y: ((-_vec3.y + 1) * 0.5) * h,
        visible: _vec3.z >= -1 && _vec3.z <= 1,
      };
    });

    const leftModeLabel = this.getLeftGripOverlayLabel();
    for (const [wristName, label, color] of [
      ['RightHand', `${MIXAMO_BONE_PREFIX}RightHand`, '#34d399'],
      ['LeftHand', `${MIXAMO_BONE_PREFIX}LeftHand · ${leftModeLabel}`, '#22d3ee'],
    ] as const) {
      const wrist = this.rig.handBones.get(wristName);
      if (!wrist) continue;
      wrist.getWorldPosition(_vec3);
      _vec3.project(this.camera);
      projected.push({
        name: wristName,
        shortLabel: label,
        color,
        kind: 'bone',
        x: ((_vec3.x + 1) * 0.5) * w,
        y: ((-_vec3.y + 1) * 0.5) * h,
        visible: _vec3.z >= -1 && _vec3.z <= 1,
        rotationDeg: wrist.userData.rotation_deg as [number, number, number] | undefined,
      });
    }

    this.callbacks.onProjectedRigNodes(projected);
  }

  public getMeasuredDimensionsM(): [number, number, number] | undefined {
    if (!this.rig) return undefined;
    this.rig.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.rig.root);
    if (box.isEmpty()) return undefined;
    const size = new THREE.Vector3();
    box.getSize(size);
    return [
      Math.round(size.x * 1e4) / 1e4,
      Math.round(size.y * 1e4) / 1e4,
      Math.round(size.z * 1e4) / 1e4,
    ];
  }

  /**
   * Renders a clean transparent-background PNG thumbnail of the current weapon for Godot HUD loadouts.
   */
  public async renderTransparentThumbnail(width = 640, height = 360): Promise<Uint8Array> {
    if (!this.rig) {
      throw new Error('No weapon geometry available for preview thumbnail.');
    }

    // Preserve live scene state
    const prevBg = this.scene.background;
    const prevFog = this.scene.fog;
    const prevFloorVis = this.studioFloor.visible;
    const prevVfxVis = this.vfxGroup.visible;
    const prevGizmoVis = this.rigGizmoGroup.visible;
    const prevWire = this.wireframeEnabled;
    const prevStockRot = this.rig.boneStock.rotation.y;
    const prevClearColor = new THREE.Color();
    const prevClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(prevClearColor);

    try {
      this.scene.background = null;
      this.scene.fog = null;
      this.studioFloor.visible = false;
      this.vfxGroup.visible = false;
      this.rigGizmoGroup.visible = false;
      this.rig.boneStock.rotation.y = 0;

      if (prevWire) {
        this.wireframeEnabled = false;
        this.applyWireframeState();
      }
      for (const slot of SLOT_ORDER) {
        this.materials.bySlot[slot].emissive.copy(_emissiveNone);
        this.materials.bySlot[slot].emissiveIntensity = 0;
      }

      // Compute tight weapon bounds & frame a clean 3/4 side silhouette
      this.rig.root.updateMatrixWorld(true);
      _box3.setFromObject(this.rig.root);
      _box3.getCenter(_center);
      _box3.getSize(_size);

      const canvasEl = this.renderer.domElement;
      const canvasAspect = Math.max(0.25, canvasEl.clientWidth / Math.max(1, canvasEl.clientHeight));
      const thumbCam = new THREE.PerspectiveCamera(28, canvasAspect, 0.015, 24);
      const fovRad = THREE.MathUtils.degToRad(thumbCam.fov);
      const halfSpan = Math.max(_size.z * 0.56, _size.y * 0.72, 0.22);
      const horizFov = 2 * Math.atan(Math.tan(fovRad * 0.5) * Math.min(canvasAspect, width / height));
      const dist = (halfSpan / Math.tan(horizFov * 0.5)) * 1.18;

      thumbCam.position.set(_center.x + dist * 0.96, _center.y + dist * 0.12, _center.z + dist * 0.22);
      thumbCam.lookAt(_center);
      thumbCam.updateProjectionMatrix();

      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, thumbCam);

      // Copy & crop centered aspect ratio cleanly onto transparent 2D canvas
      const outCanvas = document.createElement('canvas');
      outCanvas.width = width;
      outCanvas.height = height;
      const ctx = outCanvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas unavailable for preview thumbnail.');
      ctx.clearRect(0, 0, width, height);

      const srcW = canvasEl.width;
      const srcH = canvasEl.height;
      const targetAspect = width / height;
      let sx = 0;
      let sy = 0;
      let sw = srcW;
      let sh = srcH;
      if (srcW / srcH > targetAspect) {
        sw = Math.round(srcH * targetAspect);
        sx = Math.round((srcW - sw) * 0.5);
      } else {
        sh = Math.round(srcW / targetAspect);
        sy = Math.round((srcH - sh) * 0.5);
      }
      ctx.drawImage(canvasEl, sx, sy, sw, sh, 0, 0, width, height);

      const pngBlob = await new Promise<Blob>((resolve, reject) => {
        outCanvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Failed to encode preview.png'))),
          'image/png'
        );
      });
      return new Uint8Array(await pngBlob.arrayBuffer());
    } finally {
      this.scene.background = prevBg;
      this.scene.fog = prevFog;
      this.studioFloor.visible = prevFloorVis;
      this.vfxGroup.visible = prevVfxVis;
      this.rigGizmoGroup.visible = prevGizmoVis;
      this.rig.boneStock.rotation.y = prevStockRot;
      if (prevWire) {
        this.wireframeEnabled = true;
        this.applyWireframeState();
      }
      this.applyHighlightEmissives();
      this.renderer.setClearColor(prevClearColor, prevClearAlpha);
      this.renderer.render(this.scene, this.camera);
    }
  }

  public async exportCleanGLB(
    quality: GlbExportQuality = '1k'
  ): Promise<{ blob: Blob; metadata: GodotWeaponMetadata }> {
    if (!this.rig || !this.currentMechanics || !this.currentConfig) {
      throw new Error('No weapon geometry available to export.');
    }

    const spec = getGlbExportSpec(quality);
    const targetRes = spec.textureSize;
    const auxRes = Math.min(targetRes, targetRes <= 1024 ? 512 : 1024);

    // Yield once so React renders the exporting spinner before baking PBR maps & optimizing meshes
    await new Promise<void>((resolve) => window.setTimeout(resolve, 24));

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const exportCache = new TextureCache(maxAniso, targetRes);
    const auxExportCache = auxRes === targetRes ? exportCache : new TextureCache(maxAniso, auxRes);

    // Non-destructive clone of WeaponRoot so live viewport pose, wireframe & materials stay untouched
    const exportRoot = this.rig.root.clone(true);
    exportRoot.name = 'WeaponRoot';
    exportRoot.position.set(0, 0, 0);
    exportRoot.rotation.set(0, 0, 0);
    exportRoot.scale.set(1, 1, 1);

    const partStock = exportRoot.getObjectByName('Part_Stock');
    const partBolt = exportRoot.getObjectByName('Part_Bolt');
    const partTrigger = exportRoot.getObjectByName('Part_Trigger');
    const partMagazine = exportRoot.getObjectByName('Part_Magazine');
    const handRigRight = exportRoot.getObjectByName('HandRig_Right');
    const handRigLeft = exportRoot.getObjectByName('HandRig_Left');
    if (handRigRight) exportRoot.remove(handRigRight);
    if (handRigLeft) exportRoot.remove(handRigLeft);

    // Strip any Bone / Light / Camera objects so GLB contains zero armature, camera, or light data
    const forbiddenNodes: THREE.Object3D[] = [];
    exportRoot.traverse((obj) => {
      if ((obj as THREE.Bone).isBone || (obj as THREE.Light).isLight || (obj as THREE.Camera).isCamera) {
        forbiddenNodes.push(obj);
      }
    });
    for (const node of forbiddenNodes) {
      node.parent?.remove(node);
    }

    if (partStock) partStock.rotation.set(0, 0, 0);
    if (partBolt) {
      partBolt.position.set(
        this.currentMechanics.boltRestPos.x,
        this.currentMechanics.boltRestPos.y,
        this.currentMechanics.boltRestPos.z
      );
    }
    if (partTrigger) partTrigger.rotation.set(0, 0, 0);
    if (partMagazine) {
      if (this.currentConfig.parts.magazine === 'none') {
        exportRoot.remove(partMagazine);
      } else {
        partMagazine.position.set(
          this.currentMechanics.magwellPos.x,
          this.currentMechanics.magwellPos.y,
          this.currentMechanics.magwellPos.z
        );
        partMagazine.rotation.set(0, 0, 0);
      }
    }

    // Shift all direct children by -gripPivotPos so WeaponRoot origin (0, 0, 0) stays centered
    // at the pistol grip centerline pivot in Godot 4.7.2 coordinates (1 unit = 1 meter, -Z forward, +Y up, +X right)
    const gripOrigin = this.currentMechanics.gripPivotPos;
    for (const child of exportRoot.children) {
      child.position.set(
        Math.round((child.position.x - gripOrigin.x) * 1e5) / 1e5,
        Math.round((child.position.y - gripOrigin.y) * 1e5) / 1e5,
        Math.round((child.position.z - gripOrigin.z) * 1e5) / 1e5
      );
    }

    // Measure exact real-world [width_x, height_y, length_z] in meters from shifted geometry
    exportRoot.updateMatrixWorld(true);
    const exportBox = new THREE.Box3().setFromObject(exportRoot);
    const exportSize = new THREE.Vector3();
    exportBox.getSize(exportSize);
    const exactDimensionsM: [number, number, number] = [
      Math.round(exportSize.x * 1e4) / 1e4,
      Math.round(exportSize.y * 1e4) / 1e4,
      Math.round(exportSize.z * 1e4) / 1e4,
    ];

    const metadata = buildGodotWeaponMetadata(
      this.currentConfig,
      this.currentMechanics,
      exactDimensionsM
    );

    const exportShoulder = exportRoot.getObjectByName('Socket_Shoulder');
    if (metadata.sockets.Socket_Shoulder) {
      if (exportShoulder) {
        exportShoulder.position.set(...metadata.sockets.Socket_Shoulder.position);
      }
    } else if (exportShoulder) {
      exportRoot.remove(exportShoulder);
    }

    const createdGeos: THREE.BufferGeometry[] = [];
    const clonedMaterials: THREE.Material[] = [];
    const materialMap = new Map<THREE.Material, THREE.Material>();

    try {
      // 1. Identify which materials are actually used by meshes in the exported weapon
      const usedMaterials = new Set<THREE.Material>();
      exportRoot.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mat = (obj as THREE.Mesh).material;
          if (Array.isArray(mat)) {
            for (const m of mat) usedMaterials.add(m);
          } else if (mat) {
            usedMaterials.add(mat);
          }
        }
      });

      // Track shared primary monochrome surface keys so matching aux hardware reuses them with 0 extra images
      const primaryMonoSignatures = new Set<string>();
      const monoSig = (p: PartPaint) =>
        `${p.pattern}|${p.wear.toFixed(2)}|${p.metalness >= 0.45 ? 'm' : 'd'}`;

      const cloneAndBakeMaterial = async (
        origMat: THREE.MeshStandardMaterial,
        paint: PartPaint,
        cache: TextureCache,
        isSlotMat: boolean
      ) => {
        if (!usedMaterials.has(origMat)) return;
        if (cache.getResolution() >= 2048) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }

        // Always emit pure core glTF 2.0 MeshStandardMaterial (never MeshPhysicalMaterial clearcoat/sheen/transmission/ior)
        const stdMat = new THREE.MeshStandardMaterial({
          name: origMat.name,
          color: origMat.color.clone(),
          metalness: origMat.metalness,
          roughness: origMat.roughness,
          normalScale: origMat.normalScale.clone(),
          envMapIntensity: origMat.envMapIntensity,
          transparent: origMat.transparent,
          opacity: origMat.opacity,
          depthWrite: origMat.depthWrite,
          side: origMat.side,
          wireframe: false,
        });

        if (!isSlotMat) {
          stdMat.emissive.copy(origMat.emissive);
          stdMat.emissiveIntensity = origMat.emissiveIntensity;
        }

        const monoTint = buildMonochromeExportTint(paint);
        if (monoTint) {
          const maps = cache.getMaps(monoTint.basePaint);
          stdMat.color.set(monoTint.tintHex);
          stdMat.map = maps.map;
          stdMat.normalMap = maps.normalMap;
          stdMat.roughnessMap = maps.roughnessMap;
          stdMat.metalnessMap = maps.metalnessMap;
          if (isSlotMat) {
            primaryMonoSignatures.add(monoSig(monoTint.basePaint));
          }
        } else {
          const exportPaint: PartPaint = {
            ...paint,
            wear: quantizeExportWear(paint.wear),
          };
          const maps = cache.getMaps(exportPaint);
          stdMat.color.set('#ffffff');
          stdMat.map = maps.map;
          stdMat.normalMap = maps.normalMap;
          stdMat.roughnessMap = maps.roughnessMap;
          stdMat.metalnessMap = maps.metalnessMap;
        }
        stdMat.needsUpdate = true;
        materialMap.set(origMat, stdMat);
        clonedMaterials.push(stdMat);
      };

      // Bake primary slot materials first
      for (const slot of SLOT_ORDER) {
        const paint = this.currentConfig.paints[slot];
        await cloneAndBakeMaterial(this.materials.bySlot[slot], paint, exportCache, true);
      }

      // Bake auxiliary hardware (share primary exportCache when matching monochrome signature already exists)
      const auxEntries: Array<[THREE.MeshStandardMaterial, PartPaint]> = [
        [this.materials.darkSteel, WeaponEngine.AUX_PAINTS.darkSteel],
        [this.materials.chromeSteel, WeaponEngine.AUX_PAINTS.chromeSteel],
        [this.materials.brass, WeaponEngine.AUX_PAINTS.brass],
        [this.materials.rubber, WeaponEngine.AUX_PAINTS.rubber],
      ];
      for (const [mat, auxPaint] of auxEntries) {
        const mono = buildMonochromeExportTint(auxPaint);
        const reusePrimary = mono !== null && primaryMonoSignatures.has(monoSig(mono.basePaint));
        await cloneAndBakeMaterial(
          mat,
          auxPaint,
          reusePrimary ? exportCache : auxExportCache,
          false
        );
      }

      // Convert opticLens from MeshPhysicalMaterial (clearcoat/ior) to pure MeshStandardMaterial
      if (usedMaterials.has(this.materials.opticLens)) {
        const src = this.materials.opticLens;
        const stdOptic = new THREE.MeshStandardMaterial({
          name: src.name,
          color: src.color.clone(),
          metalness: src.metalness,
          roughness: src.roughness,
          envMapIntensity: src.envMapIntensity,
          transparent: src.transparent,
          opacity: src.opacity,
          depthWrite: src.depthWrite,
          side: src.side,
        });
        materialMap.set(src, stdOptic);
        clonedMaterials.push(stdOptic);
      }

      // 2. Weld non-indexed vertices, deduplicate identical BufferGeometries, bind cloned materials,
      //    strip temporary editor userData, and locate the primary receiver mesh for glTF extras mirroring
      const dedupBuckets = new Map<string, THREE.BufferGeometry[]>();
      const partReceiver = exportRoot.getObjectByName('Part_Receiver') ?? exportRoot;
      let primaryMesh: THREE.Mesh | null = null;
      let primaryVertCount = -1;

      exportRoot.traverse((obj) => {
        obj.userData = {};
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          mesh.geometry = optimizeGeometryForExport(mesh.geometry, dedupBuckets, createdGeos);
          if (Array.isArray(mesh.material)) {
            mesh.material = mesh.material.map((m) => materialMap.get(m) ?? m);
          } else if (mesh.material) {
            mesh.material = materialMap.get(mesh.material) ?? mesh.material;
          }
        }
      });

      partReceiver.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          const vCount = mesh.geometry.attributes.position?.count ?? 0;
          if (vCount > primaryVertCount) {
            primaryVertCount = vCount;
            primaryMesh = mesh;
          }
        }
      });

      // Embed complete JSON-serializable Godot 4.7.2 metadata into glTF extras on WeaponRoot AND primary mesh
      const extrasPayload = JSON.parse(JSON.stringify(metadata));
      exportRoot.userData = { ...extrasPayload };
      if (primaryMesh) {
        (primaryMesh as THREE.Mesh).userData = { ...extrasPayload };
      }

      const exporter = new GLTFExporter();
      const rawGlbBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        exporter.parse(
          exportRoot,
          (result) => {
            if (result instanceof ArrayBuffer) {
              resolve(result);
            } else {
              reject(new Error('Expected binary GLB output.'));
            }
          },
          (err) => reject(err),
          { binary: true, trs: true, maxTextureSize: targetRes }
        );
      });

      // 3. Recompress embedded JPEGs at calibrated visual-lossless quality (core glTF 2.0)
      const optimizedBuffer = await recompressGlbJpegs(rawGlbBuffer, quality);
      return {
        blob: new Blob([optimizedBuffer], { type: 'model/gltf-binary' }),
        metadata,
      };
    } finally {
      for (const geo of createdGeos) geo.dispose();
      for (const mat of clonedMaterials) mat.dispose();
      exportCache.disposeAll();
      if (auxExportCache !== exportCache) {
        auxExportCache.disposeAll();
      }
    }
  }

  private stepAnimations(dt: number): boolean {
    let keepAnimating = false;
    const m = this.currentMechanics;

    // Selection confirmation pulse decay
    if (this.selectPulse > 0.01) {
      this.selectPulse = Math.max(0, this.selectPulse - dt * 4.5);
      this.applyHighlightEmissives();
      keepAnimating = true;
    }

    // Smooth camera focus / reset damping
    if (this.camGoalPos && this.camGoalTarget) {
      const alpha = 1 - Math.exp(-8.5 * dt);
      this.camera.position.lerp(this.camGoalPos, alpha);
      this.controls.target.lerp(this.camGoalTarget, alpha);
      if (
        this.camera.position.distanceTo(this.camGoalPos) < 0.002 &&
        this.controls.target.distanceTo(this.camGoalTarget) < 0.002
      ) {
        this.camera.position.copy(this.camGoalPos);
        this.controls.target.copy(this.camGoalTarget);
        this.camGoalPos = null;
        this.camGoalTarget = null;
      } else {
        keepAnimating = true;
      }
    }

    if (this.rig && m) {
      // Stock fold interpolation
      if (Math.abs(this.stockFoldCurrent - this.stockFoldTarget) > 0.003) {
        this.stockFoldCurrent = THREE.MathUtils.damp(
          this.stockFoldCurrent,
          this.stockFoldTarget,
          9,
          dt
        );
        this.rig.boneStock.rotation.y = this.stockFoldCurrent;
        keepAnimating = true;
      } else if (this.stockFoldCurrent !== this.stockFoldTarget) {
        this.stockFoldCurrent = this.stockFoldTarget;
        this.rig.boneStock.rotation.y = this.stockFoldCurrent;
      }

      // Fire cycle: bolt blowback, trigger pull, external muzzle flash
      if (this.fireTimer > 0) {
        this.fireTimer = Math.max(0, this.fireTimer - dt);
        const progress = 1 - this.fireTimer / 0.22;
        const blowback = Math.sin(progress * Math.PI);
        this.rig.boneBolt.position.z = m.boltRestPos.z + blowback * 0.055;
        this.rig.boneTrigger.rotation.x = -blowback * 0.42;

        const showFlash = progress < 0.32;
        this.muzzleFlashMesh.visible = showFlash;
        if (showFlash) {
          this.rig.socketMuzzle.getWorldPosition(_vec3);
          this.muzzleFlashMesh.position.copy(_vec3);
          this.muzzleFlashMesh.rotation.z = progress * 14;
          const sc = 0.75 + Math.sin(progress * 10) * 0.35;
          this.muzzleFlashMesh.scale.set(sc, sc, sc * 1.15);
          this.muzzleLight.position.copy(_vec3);
          this.muzzleLight.intensity = 4.2 * (1 - progress / 0.32);
        } else {
          this.muzzleLight.intensity = 0;
        }
        keepAnimating = true;
      } else {
        this.muzzleFlashMesh.visible = false;
        this.muzzleLight.intensity = 0;
        this.rig.boneTrigger.rotation.x = 0;
      }

      // Reload cycle: rock-and-lock detach/re-insert on bone_magazine + bolt rack
      if (this.reloadTimer > 0) {
        this.reloadTimer = Math.max(0, this.reloadTimer - dt);
        const p = 1 - this.reloadTimer / 1.25;
        if (p < 0.72) {
          const mp = p / 0.72;
          const dropCurve = Math.sin(mp * Math.PI);
          this.rig.boneMagazine.position.set(
            m.magwellPos.x,
            m.magwellPos.y - dropCurve * 0.16,
            m.magwellPos.z - dropCurve * 0.025
          );
          this.rig.boneMagazine.rotation.x = -dropCurve * 0.42;
          this.rig.boneBolt.position.z = m.boltRestPos.z;
        } else {
          this.rig.boneMagazine.position.set(m.magwellPos.x, m.magwellPos.y, m.magwellPos.z);
          this.rig.boneMagazine.rotation.x = 0;
          const bp = (p - 0.72) / 0.28;
          this.rig.boneBolt.position.z = m.boltRestPos.z + Math.sin(bp * Math.PI) * 0.058;
        }
        keepAnimating = true;
      } else if (this.fireTimer <= 0) {
        this.rig.boneBolt.position.z = m.boltRestPos.z;
        this.rig.boneMagazine.position.set(m.magwellPos.x, m.magwellPos.y, m.magwellPos.z);
        this.rig.boneMagazine.rotation.x = 0;
      }
    }

    return keepAnimating;
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync?.(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) return;
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 65);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  public renderImmediate(): void {
    if (this.disposed) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  public requestRender(): void {
    if (this.disposed) return;
    if (this.renderBusy) {
      this.renderDirty = true;
      return;
    }
    this.renderBusy = true;
    this.frameId = requestAnimationFrame(() => {
      if (this.disposed) return;
      this.renderDirty = false;
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) / 1000));
      this.lastFrameTime = now;

      const animActive = this.stepAnimations(dt);
      const controlsMoved = this.controls.update();

      if (this.rigOverlayEnabled) {
        this.syncRigGizmosAndProject();
      }

      this.renderer.render(this.scene, this.camera);

      const done = () => {
        this.renderBusy = false;
        if (this.renderDirty || animActive || (!this.isSoftwareGl && controlsMoved)) {
          this.requestRender();
        }
      };

      if (this.isSoftwareGl) {
        this.afterDraw(done);
      } else {
        done();
      }
    });
  }

  private handleResize(): void {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const aspect = w / h;
    this.camera.fov = aspect < 1 ? 48 : 34;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (!this.userHasInteracted && this.rig && w > 80 && h > 80) {
      this.setCameraView(this.activeViewPreset, true);
    }
    this.renderer.render(this.scene, this.camera);
    this.requestRender();
  }

  private disposeObjectGeometries(root: THREE.Object3D): void {
    const disposed = new Set<THREE.BufferGeometry>();
    root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry && !disposed.has(mesh.geometry)) {
          mesh.geometry.dispose();
          disposed.add(mesh.geometry);
        }
      }
    });
  }

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.resizeObserver.disconnect();

    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    dom.removeEventListener('pointermove', this.onPointerMove);
    dom.removeEventListener('pointerup', this.onPointerUp);
    dom.removeEventListener('pointerleave', this.onPointerLeave);
    dom.removeEventListener('dblclick', this.onDoubleClick);
    dom.removeEventListener('webglcontextlost', this.onContextLost);

    this.controls.dispose();
    if (this.rig) this.disposeObjectGeometries(this.rig.root);
    this.disposeObjectGeometries(this.rigGizmoGroup);
    this.disposeObjectGeometries(this.vfxGroup);

    this.textureCache.disposeAll();
    for (const slot of SLOT_ORDER) {
      this.materials.bySlot[slot].dispose();
    }
    this.materials.darkSteel.dispose();
    this.materials.chromeSteel.dispose();
    this.materials.brass.dispose();
    this.materials.rubber.dispose();
    this.materials.opticLens.dispose();
    this.materials.emissiveAmber.dispose();
    this.materials.emissiveCyan.dispose();
    this.materials.emissiveRed.dispose();

    this.envRenderTarget.dispose();
    this.renderer.dispose();
    if (dom.parentNode === this.container) {
      this.container.removeChild(dom);
    }
  }
}

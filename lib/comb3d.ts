/**
 * THE COMB — a Three.js renderer for the shared map.
 * Theme-driven: `theme.scene` picks the layout (hex comb or circular den) and
 * `theme.shape` picks the cell geometry (hex prism or cylinder). Every animation is
 * triggered by a SceneEvent that corresponds to one logged action.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { theme } from '@/themes';
import { axialToXY, ringXY, cellKey, spiralIndexOf } from './hex';
import { beeGeometry, wingGeometry, QueenModel } from './beeModel';
import { pickKey, type Cell, type CombPick, type Hive, type SceneEvent } from './types';

export type { CombPick } from './types';
export { pickKey } from './types';

/** Screen-space insets (px) covered by UI. Camera moves keep picked cells inside the rest. */
export interface SafeArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const MAX_CELLS = 400;
const MAX_BEES = 3200;
const MAX_RINGS = 96;
const MAX_SLOTS = 400;
const MAX_GHOSTS = 8;
const MAX_BEES_PER_CELL = 30;
const TILT = (30 * Math.PI) / 180; // from vertical
const CELL_R = 1;
const CELL_GAP = 1.08; // spacing multiplier

/** One worker bee hovering over its own cell. Positions are relative to the cell centre. */
interface Bee {
  x: number;
  z: number;
  h: number; // preferred hover height above the rim
  vx: number;
  vz: number;
  tx: number;
  tz: number;
  nextTarget: number;
  mode: 'fly' | 'rest';
  toRest: boolean; // current target is a landing spot on the rim
  restUntil: number;
  heading: number;
  phase: number;
  scale: number;
  speed: number;
  leaving: number; // 0 = no, else time started
  born: number;
}

interface Queen {
  a: number;
  phase: number;
  arrive: number; // time she descends into the cell (-1 = always been here)
}

interface Flight {
  from: THREE.Vector3;
  to: THREE.Vector3;
  start: number;
  dur: number;
  bees: { dx: number; dz: number; dy: number; phase: number }[];
  targetCa: string;
  kind: 'swarm' | 'found';
  done: boolean;
}

/** An empty cell on the edge of the comb where a new unit can be founded. */
interface Slot {
  q: number;
  r: number;
  key: string;
  pos: THREE.Vector3;
  born: number;
  hover: number;
  sel: number;
}

interface Ring {
  pos: THREE.Vector3;
  start: number;
  dur: number;
  from: number;
  to: number;
  color: THREE.Color;
  alive: boolean;
  y: number;
}

interface CellVis {
  ca: string;
  pos: THREE.Vector3;
  target: THREE.Vector3;
  height: number;
  targetHeight: number;
  fill: number;
  targetFill: number;
  wall: THREE.Color;
  targetWall: THREE.Color;
  liquid: THREE.Color;
  targetLiquid: THREE.Color;
  cap: number;
  targetCap: number;
  lift: number;
  flash: number; // red raid glow
  white: number; // harvest flash (biggest)
  pulse: number; // harvest wave glow
  dip: number; // seal depth dip
  bees: Bee[];
  queen: Queen;
  targetBees: number;
  nextLeave: number;
  state: Hive['state'];
  bornT: number; // time the founding sequence started (-1 = none)
  foundedFx: boolean;
  isBig: boolean;
  hive: Hive;
}

export interface CombOptions {
  mode: 'comb' | 'single';
  interactive?: boolean;
  /** Fired when the thing under the pointer changes (not every frame). */
  onHover?: (p: CombPick) => void;
  /** A click (not a drag) on a hive, an empty cell, or the background (null). */
  onSelect?: (p: CombPick) => void;
  /** Double-click on a hive. */
  onOpen?: (ca: string) => void;
  /** 'always': plain wheel zooms (full-screen comb). 'modifier': only ctrl/⌘ + wheel or a trackpad pinch zooms, so the page still scrolls. */
  wheelZoom?: 'always' | 'modifier';
  /** Called when the wheel was ignored because no modifier was held. */
  onWheelHint?: () => void;
  /** Let vertical one-finger swipes scroll the page instead of panning (home hero). */
  touchScroll?: boolean;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _ndc = new THREE.Vector2();

const smooth = (a: number, b: number, x: number) => {
  const u = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};

function hexShape(r: number) {
  const s = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 6) * (2 * i + 1); // pointy-top
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}
function circleShape(r: number) {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  return s;
}

/** Hex prism along +Y from 0..1 (scaled later). */
function prismGeometry(r: number, hole?: number) {
  const shape = theme.shape === 'hex' ? hexShape(r) : circleShape(r);
  if (hole) shape.holes.push(theme.shape === 'hex' ? hexShape(hole) : circleShape(hole));
  const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 24 });
  g.rotateX(-Math.PI / 2);
  return g;
}

function shadowGeometry() {
  const g = new THREE.CircleGeometry(0.11, 12);
  g.rotateX(-Math.PI / 2);
  g.deleteAttribute('uv');
  return g;
}

function layoutXZ(cell: Cell): [number, number] {
  if (theme.scene === 'den') {
    const [x, y] = ringXY(spiralIndexOf(cell), 2.25);
    return [x, y];
  }
  const [x, y] = axialToXY(cell, CELL_R * CELL_GAP);
  return [x, y];
}

const beeCount = (h: Hive, cap = MAX_BEES_PER_CELL) => (h.state === 'abandoned' ? 0 : Math.max(1, Math.min(cap, Math.round(h.bees / 90))));

export class CombRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private cells: CellVis[] = [];
  private byCa = new Map<string, CellVis>();
  private wallMesh: THREE.InstancedMesh;
  private liquidMesh: THREE.InstancedMesh;
  private floorMesh: THREE.InstancedMesh;
  private capMesh: THREE.InstancedMesh;
  private beeMesh: THREE.InstancedMesh;
  private wingMesh: THREE.InstancedMesh;
  private shadowMesh: THREE.InstancedMesh;
  private slotPlate: THREE.InstancedMesh;
  private slotRim: THREE.InstancedMesh;
  private ghostMesh: THREE.InstancedMesh;
  private selRing: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private slots: Slot[] = [];
  private slotByKey = new Map<string, Slot>();
  private scouts: Bee[] = [];
  private customQueens = new Map<string, QueenModel>();
  private hoverPick: CombPick = null;
  private selPick: CombPick = null;
  private safe: SafeArea = { left: 0, top: 0, right: 0, bottom: 0 };
  private tmpCam: THREE.OrthographicCamera;
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private pointerInside = false;
  private pointerDirty = false;
  private frame = 0;
  private down: { x: number; y: number; id: number; grab: THREE.Vector3 | null; moved: boolean; slop: number } | null = null;
  private lastClick = { key: '', time: 0, x: 0, y: 0, ca: '' };
  /** The pick a camera flight is heading to, so its goal can be recomputed when UI insets change. */
  private flyPick: CombPick = null;
  /** Hover only makes sense for a mouse; touch and pen never hover. */
  private lastPointerType = 'mouse';
  private day = false;
  private ringMesh: THREE.InstancedMesh;
  private pulseMesh: THREE.InstancedMesh;
  private rings: Ring[] = [];
  private pulses: Ring[] = [];
  private flights: Flight[] = [];
  private target = new THREE.Vector3();
  private goal = new THREE.Vector3();
  private zoom = 1;
  private zoomGoal = 1;
  private flying = false;
  private azimuth = 0;
  private raf = 0;
  private last = 0;
  private time = 0;
  private pointer = new THREE.Vector2(-10, -10);
  private raycaster = new THREE.Raycaster();
  private pinch = 0;
  private width = 1;
  private height = 1;
  private maxHoney = 1;
  private beeIdx = 0;
  private palette = {
    accent: new THREE.Color(theme.palette.accent),
    soft: new THREE.Color(theme.palette.accentSoft),
    royal: new THREE.Color(theme.palette.royal),
    grey: new THREE.Color(theme.palette.starving),
    raid: new THREE.Color(theme.palette.raid),
    waxWall: new THREE.Color(theme.palette.accent).multiplyScalar(0.42),
    greyWall: new THREE.Color(theme.palette.starving).multiplyScalar(0.55),
    deadWall: new THREE.Color(theme.palette.starving).multiplyScalar(0.3),
    deadLiquid: new THREE.Color(theme.palette.starving).multiplyScalar(0.45),
    worker: new THREE.Color(1, 1, 1),
    queen: new THREE.Color(1.25, 1.12, 0.92),
    royalQueen: new THREE.Color(1.45, 1.4, 1.3),
    greyBee: new THREE.Color(0.55, 0.55, 0.55),
  };
  private ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private opts: CombOptions;
  private disposed = false;
  private visible = true;
  private readonly isMobile: boolean;

  constructor(private canvas: HTMLCanvasElement, opts: CombOptions) {
    this.opts = opts;
    const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('gpu') : null;
    this.isMobile = q === 'desktop' ? false : q === 'mobile' ? true : typeof window !== 'undefined' && (window.innerWidth < 760 || /Mobi|Android/i.test(navigator.userAgent));
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.isMobile, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.isMobile ? 1.5 : 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
    this.tmpCam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
    this.zoom = 1;
    this.zoomGoal = 1;

    this.scene.background = new THREE.Color(theme.palette.base);

    // lights — warm key, cool rim, soft fill
    const hemi = new THREE.HemisphereLight(new THREE.Color(theme.palette.accentSoft), new THREE.Color(theme.palette.base), 0.55);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(new THREE.Color('#fff2d0'), 2.2);
    key.position.set(6, 14, 8);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(new THREE.Color(theme.palette.accent), 0.9);
    rim.position.set(-8, 6, -6);
    this.scene.add(rim);
    const amb = new THREE.AmbientLight(new THREE.Color(theme.palette.text), 0.15);
    this.scene.add(amb);

    // ground plate — slightly lighter than background so transmission has something to refract
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.palette.surface), roughness: 0.95, metalness: 0 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    this.scene.add(ground);
    this.ground = ground;

    // --- instanced geometry ---
    const wallGeo = prismGeometry(CELL_R, CELL_R * 0.84);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.08, emissive: new THREE.Color(theme.palette.accent), emissiveIntensity: 0.06 });
    this.wallMesh = new THREE.InstancedMesh(wallGeo, wallMat, MAX_CELLS);
    this.wallMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.wallMesh);

    const floorGeo = prismGeometry(CELL_R * 0.86);
    const floorMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.palette.surface).multiplyScalar(0.8), roughness: 0.9 });
    this.floorMesh = new THREE.InstancedMesh(floorGeo, floorMat, MAX_CELLS);
    this.scene.add(this.floorMesh);

    const liquidGeo = prismGeometry(CELL_R * 0.85);
    const liquidMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.14,
      metalness: 0,
      transmission: this.isMobile ? 0 : 0.55,
      thickness: 0.8,
      ior: 1.42,
      attenuationColor: new THREE.Color(theme.palette.accent),
      attenuationDistance: 1.4,
      clearcoat: 0.8,
      clearcoatRoughness: 0.2,
      transparent: this.isMobile,
      opacity: this.isMobile ? 0.9 : 1,
      emissive: new THREE.Color(theme.palette.accent),
      emissiveIntensity: 0.1,
    });
    this.liquidMesh = new THREE.InstancedMesh(liquidGeo, liquidMat, MAX_CELLS);
    this.liquidMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.liquidMesh);

    const capGeo = prismGeometry(CELL_R * 0.9);
    const capMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.palette.text).multiplyScalar(0.9), roughness: 0.55, metalness: 0, transparent: true, opacity: 0.92 });
    this.capMesh = new THREE.InstancedMesh(capGeo, capMat, MAX_CELLS);
    this.capMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.capMesh);

    // bees: body with baked stripe colours, tinted per instance (queen / grey)
    const beeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.12 });
    this.beeMesh = new THREE.InstancedMesh(beeGeometry(), beeMat, MAX_BEES);
    this.beeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beeMesh.frustumCulled = false;
    this.scene.add(this.beeMesh);
    const wingMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(theme.palette.accentSoft).lerp(new THREE.Color('#ffffff'), 0.5),
      transparent: true,
      opacity: 0.28,
      roughness: 0.15,
      metalness: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: true,
    });
    this.wingMesh = new THREE.InstancedMesh(wingGeometry(), wingMat, MAX_BEES);
    this.wingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wingMesh.frustumCulled = false;
    this.scene.add(this.wingMesh);
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.26, depthWrite: false });
    this.shadowMesh = new THREE.InstancedMesh(shadowGeometry(), shadowMat, MAX_BEES);
    this.shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadowMesh.frustumCulled = false;
    this.scene.add(this.shadowMesh);

    // empty cells: a shallow socket (plate + rim) at ground level, a translucent wax "ghost"
    // cell that rises over the hovered / selected one, and a glowing rim around the selection
    this.slotPlate = new THREE.InstancedMesh(prismGeometry(CELL_R * 0.97), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_SLOTS);
    this.slotPlate.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.slotPlate.count = 0;
    this.scene.add(this.slotPlate);
    this.slotRim = new THREE.InstancedMesh(prismGeometry(CELL_R, CELL_R * 0.9), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_SLOTS);
    this.slotRim.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.slotRim.count = 0;
    this.scene.add(this.slotRim);
    const ghostMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(theme.palette.accentSoft),
      transparent: true,
      opacity: 0.38,
      roughness: 0.35,
      metalness: 0.05,
      emissive: new THREE.Color(theme.palette.accent),
      emissiveIntensity: 0.35,
      depthWrite: false,
    });
    this.ghostMesh = new THREE.InstancedMesh(wallGeo, ghostMat, MAX_GHOSTS);
    this.ghostMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ghostMesh.count = 0;
    this.scene.add(this.ghostMesh);
    this.selRing = new THREE.Mesh(
      prismGeometry(CELL_R * 1.13, CELL_R * 0.99),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.palette.accentSoft), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.selRing.visible = false;
    this.scene.add(this.selRing);

    // Instanced meshes move every frame: never frustum-cull them on a stale bounding sphere.
    for (const m of [this.wallMesh, this.floorMesh, this.liquidMesh, this.capMesh, this.slotPlate, this.slotRim, this.ghostMesh]) m.frustumCulled = false;

    const ringGeo = new THREE.RingGeometry(0.86, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, MAX_RINGS);
    this.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ringMesh.frustumCulled = false;
    this.scene.add(this.ringMesh);
    for (let i = 0; i < MAX_RINGS; i++) this.rings.push({ pos: new THREE.Vector3(), start: 0, dur: 1, from: 0, to: 1, color: new THREE.Color(), alive: false, y: 0 });
    // thin rings for the big hub pulse (width stays thin at large scale)
    const pulseGeo = new THREE.RingGeometry(0.985, 1, 96);
    pulseGeo.rotateX(-Math.PI / 2);
    const pulseMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.pulseMesh = new THREE.InstancedMesh(pulseGeo, pulseMat, 8);
    this.pulseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pulseMesh.frustumCulled = false;
    this.scene.add(this.pulseMesh);
    for (let i = 0; i < 8; i++) this.pulses.push({ pos: new THREE.Vector3(), start: 0, dur: 1, from: 0, to: 1, color: new THREE.Color(), alive: false, y: 0 });

    // post
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), this.isMobile ? 0.22 : 0.3, 0.55, 0.84);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    if (typeof window !== 'undefined') (window as unknown as { __comb?: CombRenderer }).__comb = this;
    this.resize();
    this.goal.copy(this.target);
    this.bind();
    this.last = performance.now();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  /* ---------- public API ---------- */
  /** Night/day: background and ground plane follow the page. */
  setBackground(hex: string, day = false) {
    (this.scene.background as THREE.Color).set(hex);
    this.ground.material.color.set(day ? theme.palette.dayBase : theme.palette.surface).multiplyScalar(day ? 0.92 : 1);
    this.renderer.toneMappingExposure = day ? 1.25 : 1.05;
    this.day = day;
  }

  setVisible(v: boolean) {
    this.visible = v;
  }

  /** Sync cells to the latest hive data. */
  sync(hives: Hive[], biggestCa: string) {
    const list = hives;
    this.maxHoney = Math.max(1, ...list.map((h) => h.honey));
    const seen = new Set<string>();
    for (const h of list) {
      seen.add(h.ca);
      let c = this.byCa.get(h.ca);
      const [x, z] = this.opts.mode === 'single' ? [0, 0] : layoutXZ(h.cell);
      if (!c) {
        c = this.createCell(h, x, z);
        this.cells.push(c);
        this.byCa.set(h.ca, c);
      }
      c.hive = h;
      c.target.set(x, 0, z);
      c.state = h.state;
      c.targetHeight = this.heightFor(h);
      c.targetFill = this.fillFor(h);
      c.targetCap = h.sealed;
      c.targetBees = beeCount(h, this.opts.mode === 'single' ? 12 : MAX_BEES_PER_CELL);
      const isBig = h.ca === biggestCa && h.state !== 'abandoned';
      c.isBig = isBig;
      if (h.state === 'abandoned') {
        c.targetWall.copy(this.palette.deadWall);
        c.targetLiquid.copy(this.palette.deadLiquid);
        c.targetFill = 0.06;
      } else if (h.state === 'starving') {
        c.targetWall.copy(this.palette.greyWall);
        c.targetLiquid.copy(this.palette.grey);
      } else if (isBig) {
        c.targetWall.copy(this.palette.royal).multiplyScalar(0.8);
        c.targetLiquid.copy(this.palette.royal);
      } else {
        c.targetWall.copy(this.palette.waxWall).lerp(this.palette.soft, 0.25 * c.targetFill);
        c.targetLiquid.copy(this.palette.accent).lerp(this.palette.soft, 0.4);
      }
    }
    // remove cells no longer present (never happens in mock, but keep it correct)
    this.cells = this.cells.filter((c) => {
      if (seen.has(c.ca)) return true;
      this.byCa.delete(c.ca);
      this.dropQueen(c.ca);
      return false;
    });
  }

  /** Trigger animations for scene events. */
  handleEvent(e: SceneEvent) {
    const c = this.byCa.get(e.ca);
    switch (e.type) {
      case 'store':
        if (c) this.spawnRing(c.pos, 0.3, 0.95, 1.1, this.palette.soft, c.height * c.fill + 0.03);
        break;
      case 'seal':
        if (c) {
          c.dip = 1;
          this.spawnRing(c.pos, 0.9, 0.5, 0.9, this.palette.accent, c.height + 0.05);
        }
        break;
      case 'swarm': {
        const t = e.targetCa ? this.byCa.get(e.targetCa) : undefined;
        if (c && t) this.launchFlight(c, t, e.amount ?? 1);
        break;
      }
      case 'harvest': {
        const center = this.opts.mode === 'single' ? c?.pos ?? new THREE.Vector3() : new THREE.Vector3(0, 0, 0);
        this.spawnRing(center, 0.2, this.opts.mode === 'single' ? 2.6 : 46, 2.6, this.palette.accent, 0.08, true);
        this.spawnRing(center, 0.2, this.opts.mode === 'single' ? 2.6 : 46, 3.4, this.palette.soft, 0.3, true);
        for (const cell of this.cells) {
          const d = cell.pos.distanceTo(center);
          cell.pulse = Math.max(cell.pulse, 1 + d * 0.06); // decays; delay by distance
        }
        if (c) c.white = 1.6;
        break;
      }
      case 'jelly':
        if (c) {
          c.white = Math.max(c.white, 1.2);
          this.spawnRing(c.pos, 0.3, 1.4, 1.3, this.palette.royal, c.height * c.fill + 0.05);
        }
        break;
      case 'starve':
        if (c) c.nextLeave = this.time;
        break;
      case 'abandon':
        if (c) {
          c.nextLeave = this.time;
          this.spawnRing(c.pos, 1, 2.2, 1.6, this.palette.grey, 0.1);
        }
        break;
      case 'spawn':
        if (c) this.found(c);
        break;
    }
  }

  /**
   * The founding sequence for a new cell: the comb grows a cell at the edge (walls rise),
   * honey pours in, the queen descends, and a stream of bees arrives from off-screen.
   */
  private found(c: CellVis) {
    c.bornT = this.time;
    c.foundedFx = false;
    c.bees = [];
    c.queen.arrive = this.time + 1.5;
    c.pos.copy(c.target);
    this.spawnRing(c.pos, 0.2, 2.4, 1.6, this.palette.soft, 0.08);
    // bees arrive from outside the comb, along the outward direction of the cell
    const dir = c.target.clone().setY(0);
    if (dir.lengthSq() < 0.01) dir.set(1, 0, 0);
    dir.normalize();
    const from = c.target.clone().addScaledVector(dir, this.opts.mode === 'single' ? 4 : 13).setY(3);
    const to = c.target.clone().setY(c.targetHeight + 0.35);
    const bees: Flight['bees'] = [];
    for (let i = 0; i < 16; i++) bees.push({ dx: (Math.random() - 0.5) * 0.6, dz: (Math.random() - 0.5) * 0.6, dy: Math.random() * 0.4, phase: Math.random() * 0.35 });
    this.flights.push({ from, to, start: this.time + 0.6, dur: 2.6, bees, targetCa: c.ca, kind: 'found', done: false });
  }

  /** The empty cells to draw as clickable sockets (the comb's growth edge). */
  setEmpties(cells: Cell[]) {
    if (this.opts.mode !== 'comb') return;
    const keep = new Set<string>();
    for (const c of cells) {
      const key = cellKey(c);
      keep.add(key);
      if (this.slotByKey.has(key)) continue;
      const [x, z] = layoutXZ(c);
      const slot: Slot = { q: c.q, r: c.r, key, pos: new THREE.Vector3(x, 0, z), born: this.time, hover: 0, sel: 0 };
      this.slots.push(slot);
      this.slotByKey.set(key, slot);
    }
    this.slots = this.slots.filter((sl) => {
      if (keep.has(sl.key)) return true;
      this.slotByKey.delete(sl.key);
      return false;
    });
  }

  /** Highlight a hive (lift + glowing rim) or an empty cell (ghost cell + scouts), or clear. */
  select(p: CombPick) {
    const was = pickKey(this.selPick);
    this.selPick = p;
    if (pickKey(p) === was) return;
    this.scouts = [];
    if (p?.kind === 'empty') {
      for (let i = 0; i < 3; i++) this.scouts.push(this.makeBee());
      const sl = this.slotByKey.get(`${p.q},${p.r}`);
      if (sl) this.spawnRing(sl.pos, 0.3, 1.4, 0.9, this.palette.soft, 0.06);
    }
  }

  /** Screen insets covered by UI. With `recenter`, snaps the comb's centre into the visible area. */
  setSafeArea(a: SafeArea, recenter = false) {
    this.safe = { ...a };
    if (this.opts.mode !== 'comb') return;
    // a flight in progress keeps going, re-aimed for the new insets (don't cancel it with a recenter)
    if (this.flying && this.flyPick) {
      const pos = this.pickPos(this.flyPick);
      if (pos) this.goal.copy(this.goalFor(pos, this.zoomGoal));
      return;
    }
    if (recenter) {
      const g = this.goalFor(_v.set(0, 0, 0), this.zoom);
      this.target.copy(g);
      this.goal.copy(g);
      this.flying = false;
    }
  }

  /** Smoothly pan (and optionally zoom) so the pick sits in the middle of the safe area. */
  flyToPick(p: CombPick, zoom?: number) {
    if (this.opts.mode !== 'comb') return;
    const pos = this.pickPos(p);
    if (!pos) return;
    this.zoomGoal = THREE.MathUtils.clamp(zoom ?? this.zoom, 0.45, 4);
    this.goal.copy(this.goalFor(pos, this.zoomGoal));
    this.flying = true;
    this.flyPick = p;
  }

  flyTo(ca: string, zoom?: number) {
    this.flyToPick({ kind: 'hive', ca }, zoom);
  }

  /** Pan only if the pick is off-screen or hidden under UI. Keeps the cell under the cursor otherwise. */
  ensureVisible(p: CombPick) {
    this.updateCamera(); // the camera may not have been placed by a frame yet
    const s = this.projectPick(p);
    if (!s) return;
    const r = this.safeRect();
    const m = 48;
    if (s.x < r.left + m || s.x > r.right - m || s.y < r.top + m || s.y > r.bottom - m) this.flyToPick(p);
  }

  /** Screen position (px, relative to the canvas) just above a cell's rim, or null if unknown. */
  project(ca: string): { x: number; y: number } | null {
    return this.projectPick({ kind: 'hive', ca });
  }

  projectPick(p: CombPick): { x: number; y: number } | null {
    if (!p) return null;
    if (p.kind === 'hive') {
      const c = this.byCa.get(p.ca);
      if (!c) return null;
      _v.set(c.pos.x, c.lift * 0.08 + c.height + 0.95, c.pos.z);
    } else {
      const sl = this.slotByKey.get(`${p.q},${p.r}`);
      if (!sl) return null;
      _v.set(sl.pos.x, 0.9, sl.pos.z);
    }
    _v.project(this.camera);
    return { x: ((_v.x + 1) / 2) * this.width, y: ((1 - _v.y) / 2) * this.height };
  }

  getZoom() {
    return this.zoom;
  }

  private dropQueen(ca: string) {
    const q = this.customQueens.get(ca);
    if (!q) return;
    this.scene.remove(q.group);
    q.dispose();
    this.customQueens.delete(ca);
  }

  dispose() {
    for (const ca of [...this.customQueens.keys()]) this.dropQueen(ca);
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unbind();
    this.renderer.dispose();
    this.composer.dispose();
  }

  /* ---------- internals ---------- */
  private pickPos(p: CombPick): THREE.Vector3 | null {
    if (!p) return null;
    if (p.kind === 'hive') return this.byCa.get(p.ca)?.target.clone() ?? null;
    const sl = this.slotByKey.get(`${p.q},${p.r}`);
    if (sl) return sl.pos.clone();
    const [x, z] = layoutXZ({ q: p.q, r: p.r });
    return new THREE.Vector3(x, 0, z);
  }

  /** The visible rectangle (px) once UI insets are removed; falls back to the full canvas if too small. */
  private safeRect() {
    let { left, top, right, bottom } = this.safe;
    if (this.width - left - right < 160) left = right = 0;
    if (this.height - top - bottom < 140) top = bottom = 0;
    return { left, top, right: this.width - right, bottom: this.height - bottom };
  }

  private placeCamera(cam: THREE.OrthographicCamera, target: THREE.Vector3, zoom: number) {
    _dir.set(Math.sin(this.azimuth) * Math.sin(TILT), Math.cos(TILT), Math.cos(this.azimuth) * Math.sin(TILT));
    cam.position.copy(target).addScaledVector(_dir, 80);
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    cam.zoom = zoom;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /** Where the ray through `ndc` meets the plane y = `y`. */
  private groundAt(ndc: THREE.Vector2, cam: THREE.Camera = this.camera, y = 0): THREE.Vector3 | null {
    this.raycaster.setFromCamera(ndc, cam);
    this.plane.constant = -y;
    return this.raycaster.ray.intersectPlane(this.plane, new THREE.Vector3());
  }

  /** The camera target that puts world point `pos` at the centre of the safe area at `zoom`. */
  private goalFor(pos: THREE.Vector3, zoom: number) {
    const base = new THREE.Vector3(pos.x, 0, pos.z);
    this.placeCamera(this.tmpCam, base, zoom);
    const r = this.safeRect();
    const sx = ((r.left + r.right) / 2 / this.width) * 2 - 1;
    const sy = -(((r.top + r.bottom) / 2 / this.height) * 2 - 1);
    const gC = this.groundAt(_ndc.set(0, 0), this.tmpCam);
    const gS = this.groundAt(_ndc.set(sx, sy), this.tmpCam);
    if (gC && gS) base.add(gC.sub(gS));
    return base;
  }

  private ndcFromClient(x: number, y: number, out: THREE.Vector2) {
    const rect = this.canvas.getBoundingClientRect();
    return out.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  }

  /** What is under the given NDC point: the nearest hive cell or empty socket. */
  private pickNdc(ndc: THREE.Vector2): CombPick {
    if (this.opts.mode !== 'comb') return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects([this.wallMesh, this.liquidMesh, this.slotPlate], false);
    for (const h of hits) {
      if (h.instanceId === undefined) continue;
      if (h.object === this.slotPlate) {
        const sl = this.slots[h.instanceId];
        if (sl) return { kind: 'empty', q: sl.q, r: sl.r };
      } else {
        const c = this.cells[h.instanceId];
        if (c) return { kind: 'hive', ca: c.ca };
      }
    }
    return null;
  }

  private interactive() {
    return this.opts.mode === 'comb' && this.opts.interactive !== false;
  }

  private heightFor(h: Hive) {
    if (this.opts.mode === 'single') return 1.2;
    const t = Math.min(1, Math.log10(h.bees + 1) / 3.6);
    return 0.32 + 1.15 * t;
  }
  private fillFor(h: Hive) {
    if (h.state === 'abandoned') return 0.06;
    const t = Math.sqrt(Math.min(1, h.honey / this.maxHoney));
    return 0.08 + 0.88 * t;
  }

  private createCell(h: Hive, x: number, z: number): CellVis {
    const c: CellVis = {
      ca: h.ca,
      pos: new THREE.Vector3(x, 0, z),
      target: new THREE.Vector3(x, 0, z),
      height: this.heightFor(h),
      targetHeight: this.heightFor(h),
      fill: this.fillFor(h),
      targetFill: this.fillFor(h),
      wall: this.palette.waxWall.clone(),
      targetWall: this.palette.waxWall.clone(),
      liquid: this.palette.accent.clone(),
      targetLiquid: this.palette.accent.clone(),
      cap: h.sealed,
      targetCap: h.sealed,
      lift: 0,
      flash: 0,
      white: 0,
      pulse: 0,
      dip: 0,
      bees: [],
      queen: { a: Math.random() * Math.PI * 2, phase: Math.random() * Math.PI * 2, arrive: -1 },
      targetBees: 0,
      nextLeave: 0,
      state: h.state,
      bornT: -1,
      foundedFx: true,
      isBig: false,
      hive: h,
    };
    const n = beeCount(h, this.opts.mode === 'single' ? 12 : MAX_BEES_PER_CELL);
    for (let i = 0; i < n; i++) c.bees.push(this.makeBee(true));
    return c;
  }

  private makeBee(settled = false): Bee {
    const sz = this.opts.mode === 'single' ? 0.95 : 1;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 0.8;
    return {
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      h: 0.08 + Math.random() * 0.35,
      vx: 0,
      vz: 0,
      tx: Math.cos(a) * r,
      tz: Math.sin(a) * r,
      nextTarget: 0,
      mode: 'fly',
      toRest: false,
      restUntil: 0,
      heading: Math.random() * Math.PI * 2,
      phase: Math.random() * Math.PI * 2,
      scale: (0.85 + Math.random() * 0.3) * sz,
      speed: 0.55 + Math.random() * 0.7,
      leaving: 0,
      born: settled ? this.time - 2 : this.time,
    };
  }

  private spawnRing(pos: THREE.Vector3, from: number, to: number, dur: number, color: THREE.Color, y: number, pulse = false) {
    const pool = pulse ? this.pulses : this.rings;
    const r = pool.find((x) => !x.alive) ?? pool[0];
    r.alive = true;
    r.pos.copy(pos);
    r.start = this.time;
    r.dur = dur;
    r.from = from;
    r.to = to;
    r.color.copy(color);
    r.y = y;
  }

  private launchFlight(from: CellVis, to: CellVis, amount: number) {
    const n = Math.min(26, 8 + Math.round(amount * 6));
    const bees: Flight['bees'] = [];
    for (let i = 0; i < n; i++) bees.push({ dx: (Math.random() - 0.5) * 0.5, dz: (Math.random() - 0.5) * 0.5, dy: Math.random() * 0.3, phase: Math.random() * 0.25 });
    this.flights.push({ from: from.pos.clone().setY(from.height + 0.3), to: to.pos.clone().setY(to.height + 0.3), start: this.time, dur: 1.6 + Math.min(1.2, from.pos.distanceTo(to.pos) * 0.12), bees, targetCa: to.ca, kind: 'swarm', done: false });
    // some bees visibly leave the source
    let k = Math.min(from.bees.length - 1, 6);
    for (const b of from.bees) {
      if (k <= 0) break;
      if (!b.leaving) {
        b.leaving = this.time;
        k--;
      }
    }
  }

  private resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    const aspect = w / h;
    const view = this.opts.mode === 'single' ? 1.9 : this.width < 760 ? 15 : 12;
    for (const cam of [this.camera, this.tmpCam]) {
      cam.left = -view * aspect;
      cam.right = view * aspect;
      cam.top = view;
      cam.bottom = -view;
      cam.updateProjectionMatrix();
    }
  }

  private updateCamera() {
    this.placeCamera(this.camera, this.target, this.zoom);
  }

  /* ---------- input ---------- */
  private onPointerMove = (e: PointerEvent) => {
    this.lastPointerType = e.pointerType || 'mouse';
    this.ndcFromClient(e.clientX, e.clientY, this.pointer);
    this.pointerInside = true;
    this.pointerDirty = true;
    const d = this.down;
    if (!d || d.id !== e.pointerId || !this.interactive()) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > d.slop) {
      d.moved = true;
      if (this.hoverPick) {
        this.hoverPick = null;
        this.opts.onHover?.(null);
      }
    }
    if (d.moved && d.grab) {
      // grab-pan: keep the ground point that was under the pointer at pointerdown under it now
      const now = this.groundAt(this.pointer);
      if (now) {
        this.target.add(d.grab.clone().sub(now));
        this.goal.copy(this.target);
        this.flying = false;
        this.updateCamera();
      }
      this.canvas.style.cursor = 'grabbing';
    }
  };
  private onPointerDown = (e: PointerEvent) => {
    if (!this.interactive()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.lastPointerType = e.pointerType || 'mouse';
    this.ndcFromClient(e.clientX, e.clientY, this.pointer);
    this.pointerInside = true;
    this.pointerDirty = true;
    // grabbing the comb stops any camera flight, so the drag starts from where the view is now
    this.flying = false;
    this.flyPick = null;
    this.goal.copy(this.target);
    this.zoomGoal = this.zoom;
    this.updateCamera();
    // fingers drift: a touch or pen tap may move a little before it counts as a pan
    const slop = e.pointerType === 'mouse' ? 5 : 12;
    this.down = { x: e.clientX, y: e.clientY, id: e.pointerId, grab: this.groundAt(this.pointer), moved: false, slop };
    if (e.pointerType === 'mouse') this.canvas.setPointerCapture?.(e.pointerId);
  };
  private onPointerUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!d || d.id !== e.pointerId || !this.interactive()) return;
    if (d.moved) {
      this.canvas.style.cursor = this.hoverPick ? 'pointer' : 'grab';
      return;
    }
    // pick at the release point (touch has no hover, so never rely on the hover state)
    const now = performance.now();
    // double-click: judged against the first click's position, because the first click may have
    // opened the panel or started a camera move that changes what is under the pointer
    const lc = this.lastClick;
    if (lc.ca && now - lc.time < 380 && Math.hypot(e.clientX - lc.x, e.clientY - lc.y) < 10) {
      this.lastClick = { key: '', time: 0, x: 0, y: 0, ca: '' };
      this.opts.onOpen?.(lc.ca);
      return;
    }
    const p = this.pickNdc(this.ndcFromClient(e.clientX, e.clientY, _ndc));
    this.lastClick = { key: pickKey(p), time: now, x: e.clientX, y: e.clientY, ca: p?.kind === 'hive' ? p.ca : '' };
    this.opts.onSelect?.(p);
  };
  private onPointerCancel = () => {
    this.down = null;
  };
  private onPointerLeave = () => {
    this.pointerInside = false;
    this.pointer.set(-10, -10);
    if (this.hoverPick) {
      this.hoverPick = null;
      this.opts.onHover?.(null);
    }
    if (!this.down) this.canvas.style.cursor = this.interactive() ? 'grab' : 'default';
  };
  private zoomAt(clientX: number, clientY: number, factor: number) {
    const ndc = this.ndcFromClient(clientX, clientY, new THREE.Vector2());
    const before = this.groundAt(ndc);
    this.zoom = THREE.MathUtils.clamp(this.zoom * factor, 0.45, 4);
    this.zoomGoal = this.zoom;
    this.flying = false;
    this.updateCamera();
    const after = this.groundAt(ndc);
    if (before && after) {
      this.target.add(before.sub(after));
      this.goal.copy(this.target);
      this.updateCamera();
    }
  }
  private onWheel = (e: WheelEvent) => {
    if (!this.interactive()) return;
    if (this.opts.wheelZoom === 'modifier' && !e.ctrlKey && !e.metaKey) {
      this.opts.onWheelHint?.();
      return; // let the page scroll
    }
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * this.height : e.deltaY;
    // trackpad pinch arrives as ctrl+wheel with small deltas; a real wheel notch is ~100
    const pinch = e.ctrlKey && e.deltaMode === 0 && Math.abs(dy) < 50;
    const f = Math.exp(-dy * (pinch ? 0.01 : 0.0012));
    this.zoomAt(e.clientX, e.clientY, THREE.MathUtils.clamp(f, 0.8, 1.25));
  };
  private onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      this.down = null; // a pinch is not a pan or a tap
      this.pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  };
  private onTouchMove = (e: TouchEvent) => {
    if (e.touches.length === 2 && this.pinch && this.interactive()) {
      e.preventDefault();
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      this.zoomAt(mx, my, d / this.pinch);
      this.pinch = d;
    }
  };
  private onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) this.pinch = 0;
  };
  private ro?: ResizeObserver;
  private bind() {
    const c = this.canvas;
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerCancel);
    c.addEventListener('pointerleave', this.onPointerLeave);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('touchstart', this.onTouchStart, { passive: true });
    c.addEventListener('touchmove', this.onTouchMove, { passive: false });
    c.addEventListener('touchend', this.onTouchEnd, { passive: true });
    c.style.cursor = this.interactive() ? 'grab' : 'default';
    c.style.touchAction = this.interactive() ? (this.opts.touchScroll ? 'pan-y' : 'none') : 'auto';
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(c);
  }
  private unbind() {
    const c = this.canvas;
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerCancel);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('touchstart', this.onTouchStart);
    c.removeEventListener('touchmove', this.onTouchMove);
    c.removeEventListener('touchend', this.onTouchEnd);
    this.ro?.disconnect();
  }

  private drawRings(list: Ring[], mesh: THREE.InstancedMesh, t: number) {
    let n = 0;
    for (const r of list) {
      if (!r.alive) continue;
      const u = (t - r.start) / r.dur;
      if (u >= 1) {
        r.alive = false;
        continue;
      }
      const ease = 1 - Math.pow(1 - u, 3);
      const rad = r.from + (r.to - r.from) * ease;
      _p.set(r.pos.x, r.y + u * 0.05, r.pos.z);
      _s.set(rad, 1, rad);
      _q.identity();
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(n, _m);
      _c.copy(r.color).multiplyScalar(1 - u);
      mesh.setColorAt(n, _c);
      n++;
    }
    mesh.count = n;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Advance one bee's wander / land / rest behaviour. Positions are relative to the cell centre. */
  private stepBee(b: Bee, dt: number, t: number, active: boolean, canRest: boolean, radius: number) {
    if (b.mode === 'rest' && (t > b.restUntil || b.leaving)) {
      b.mode = 'fly';
      b.nextTarget = 0;
      b.toRest = false;
    }
    if (b.mode !== 'fly') return;
    if (t > b.nextTarget && !b.leaving) {
      const a = Math.random() * Math.PI * 2;
      if (canRest && Math.random() < 0.16) {
        b.tx = Math.cos(a) * 0.92;
        b.tz = Math.sin(a) * 0.92;
        b.toRest = true;
      } else {
        const r = Math.sqrt(Math.random()) * radius;
        b.tx = Math.cos(a) * r;
        b.tz = Math.sin(a) * r;
        b.toRest = false;
      }
      b.nextTarget = t + 0.9 + Math.random() * 2.2;
    }
    const dx = b.tx - b.x;
    const dz = b.tz - b.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05 && !b.leaving) {
      if (b.toRest) {
        b.mode = 'rest';
        b.restUntil = t + 1.5 + Math.random() * 3;
        b.vx = 0;
        b.vz = 0;
        b.heading = Math.atan2(-b.x, -b.z);
        return;
      }
      b.nextTarget = Math.min(b.nextTarget, t + 0.2);
    }
    const sp = b.speed * (active ? 1 : 0.45);
    const dvx = d > 0.001 ? (dx / d) * sp : 0;
    const dvz = d > 0.001 ? (dz / d) * sp : 0;
    const ka = Math.min(1, dt * 3.2);
    b.vx += (dvx - b.vx) * ka;
    b.vz += (dvz - b.vz) * ka;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    if (Math.hypot(b.vx, b.vz) > 0.05) {
      let diff = Math.atan2(b.vx, b.vz) - b.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      b.heading += diff * Math.min(1, dt * 7);
    }
  }

  /**
   * Write one bee instance: body, wings (flapping or folded) and a soft shadow on the
   * surface below. `flap` 0 = wings folded (resting).
   */
  private writeBee(x: number, y: number, z: number, heading: number, pitch: number, roll: number, scale: number, flap: number, tint: THREE.Color, surfaceY: number, t: number, phase: number) {
    const i = this.beeIdx;
    if (i >= MAX_BEES) return;
    _e.set(pitch, heading, roll);
    _q.setFromEuler(_e);
    _p.set(x, y, z);
    _s.setScalar(scale);
    _m.compose(_p, _q, _s);
    this.beeMesh.setMatrixAt(i, _m);
    this.beeMesh.setColorAt(i, tint);
    // wings: fast flap blurs them; folded when resting
    const f = flap > 0 ? 0.55 + Math.abs(Math.sin(t * 46 + phase)) * 0.75 : 0.35;
    _s.set(scale * (flap > 0 ? 1 : 0.85), scale, scale * f);
    _m.compose(_p, _q, _s);
    this.wingMesh.setMatrixAt(i, _m);
    // shadow
    const alt = Math.max(0, y - surfaceY);
    const sh = flap > 0 ? scale * Math.max(0.15, 1 - alt * 0.7) : 0.0001;
    _p.set(x, surfaceY + 0.012, z);
    _s.set(sh, 1, sh);
    _q.identity();
    _m.compose(_p, _q, _s);
    this.shadowMesh.setMatrixAt(i, _m);
    this.beeIdx++;
  }

  /* ---------- frame ---------- */
  private loop(now: number) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    if (!this.visible) return;

    if (this.opts.mode === 'single') this.azimuth += dt * 0.12;
    if (this.flying) {
      const kf = 1 - Math.exp(-dt * 2.2);
      this.target.lerp(this.goal, kf);
      this.zoom += (this.zoomGoal - this.zoom) * kf;
      if (this.target.distanceTo(this.goal) < 0.02 && Math.abs(this.zoom - this.zoomGoal) < 0.005) {
        this.flying = false;
        this.flyPick = null;
      }
    }
    this.updateCamera();

    // hover: re-pick when the pointer moved, and every few frames (cells lift and move)
    this.frame++;
    if (this.lastPointerType !== 'mouse' && this.hoverPick) {
      this.hoverPick = null;
      this.opts.onHover?.(null);
    }
    if (this.interactive() && this.lastPointerType === 'mouse' && this.pointerInside && !this.down?.moved && (this.pointerDirty || this.frame % 6 === 0)) {
      this.pointerDirty = false;
      const p = this.pickNdc(this.pointer);
      if (pickKey(p) !== pickKey(this.hoverPick)) {
        this.hoverPick = p;
        this.canvas.style.cursor = p ? 'pointer' : 'grab';
        this.opts.onHover?.(p);
      }
    }
    const selCa = this.selPick?.kind === 'hive' ? this.selPick.ca : null;
    const selSlot = this.selPick?.kind === 'empty' ? `${this.selPick.q},${this.selPick.r}` : null;
    const hoverCa = this.hoverPick?.kind === 'hive' ? this.hoverPick.ca : null;
    const hoverSlot = this.hoverPick?.kind === 'empty' ? `${this.hoverPick.q},${this.hoverPick.r}` : null;
    let ringOn = false;
    let ringScale = 1;

    // viscous easing: exponential approach, ~700 ms to settle
    const k = 1 - Math.exp(-dt * 4.2);
    const kSlow = 1 - Math.exp(-dt * 2.4);
    this.beeIdx = 0;
    const t = this.time;
    const single = this.opts.mode === 'single';

    for (let i = 0; i < this.cells.length && i < MAX_CELLS; i++) {
      const c = this.cells[i];
      c.pos.lerp(c.target, kSlow);
      c.height += (c.targetHeight - c.height) * k;
      c.fill += (c.targetFill - c.fill) * k;
      c.cap += (c.targetCap - c.cap) * k;
      c.lift += ((c.ca === selCa ? 1.8 : c.ca === hoverCa ? 1 : 0) - c.lift) * k;
      c.wall.lerp(c.targetWall, kSlow);
      c.liquid.lerp(c.targetLiquid, kSlow);
      c.flash = Math.max(0, c.flash - dt * 0.7);
      c.white = Math.max(0, c.white - dt * 0.9);
      c.pulse = Math.max(0, c.pulse - dt * 1.4);
      c.dip = Math.max(0, c.dip - dt * 1.1);

      // founding sequence: walls rise, then honey pours, then the colony arrives
      let grow = 1;
      let pour = 1;
      let settled = true;
      if (c.bornT >= 0) {
        const age = t - c.bornT;
        grow = smooth(0, 1.3, age);
        pour = smooth(1.1, 2.8, age);
        settled = age > 3.0;
        if (!c.foundedFx && age > 3.2) {
          c.foundedFx = true;
          c.white = 0.9;
          this.spawnRing(c.pos, 0.3, 1.5, 1.2, this.palette.royal, c.height + 0.05);
        }
        if (age > 6) c.bornT = -1;
      }
      const lift = c.lift * 0.08;
      const y = lift;
      const h = c.height * (1 - 0.1 * Math.sin(c.dip * Math.PI)) * grow;
      const pulseGlow = c.pulse > 0 && c.pulse < 1 ? Math.sin(c.pulse * Math.PI) : 0;
      if (c.ca === selCa) {
        ringOn = true;
        ringScale = Math.max(0.001, grow);
        this.selRing.position.set(c.pos.x, y + h - 0.01, c.pos.z);
        this.selRing.material.color.copy(c.isBig ? this.palette.royal : this.palette.soft);
      }

      // wall
      _q.identity();
      _p.set(c.pos.x, y, c.pos.z);
      _s.set(Math.max(0.001, grow), Math.max(0.02, h), Math.max(0.001, grow));
      _m.compose(_p, _q, _s);
      this.wallMesh.setMatrixAt(i, _m);
      _c.copy(c.wall).lerp(this.palette.raid, c.flash * 0.8).lerp(this.palette.royal, Math.min(1, Math.min(1, c.white) * 0.8 + pulseGlow * 0.12));
      if (c.lift > 0) _c.lerp(this.palette.soft, c.lift * 0.25);
      this.wallMesh.setColorAt(i, _c);

      // floor
      _p.set(c.pos.x, y, c.pos.z);
      _s.set(Math.max(0.001, grow), 0.08, Math.max(0.001, grow));
      _m.compose(_p, _q, _s);
      this.floorMesh.setMatrixAt(i, _m);

      // liquid
      const level = Math.max(0.03, h * c.fill * pour);
      const wobble = c.state === 'working' ? 1 + Math.sin(t * 1.3 + i) * 0.004 : 1;
      _p.set(c.pos.x, y + 0.08, c.pos.z);
      _s.set(Math.max(0.001, 0.995 * grow * wobble), level, Math.max(0.001, 0.995 * grow * wobble));
      _m.compose(_p, _q, _s);
      this.liquidMesh.setMatrixAt(i, _m);
      _c.copy(c.liquid).lerp(this.palette.raid, c.flash).lerp(this.palette.royal, Math.min(1, c.white)).lerp(this.palette.soft, pulseGlow * 0.3);
      if (c.lift > 0) _c.lerp(this.palette.royal, c.lift * 0.15);
      this.liquidMesh.setColorAt(i, _c);
      const surfaceY = y + 0.08 + level;

      // cap: a wax plate that closes the cell from the centre outward as supply is sealed
      const capF = Math.min(0.9, c.cap * 5) * grow;
      _p.set(c.pos.x, y + h - 0.02, c.pos.z);
      _s.set(capF > 0.01 ? capF : 0.0001, 0.06, capF > 0.01 ? capF : 0.0001);
      _m.compose(_p, _q, _s);
      this.capMesh.setMatrixAt(i, _m);

      /* ---- bees ---- */
      const beeTint = c.state === 'working' ? this.palette.worker : this.palette.greyBee;
      const rimY = y + h;
      const hoverBase = rimY + 0.16;

      // population management (new bees only once the colony has arrived)
      const alive = c.bees.filter((b) => !b.leaving).length;
      if (settled && alive < c.targetBees && Math.random() < dt * 3) c.bees.push(this.makeBee());
      if (alive > c.targetBees && t > c.nextLeave) {
        const b = c.bees.find((x) => !x.leaving);
        if (b) b.leaving = t;
        c.nextLeave = t + (c.state === 'working' ? 0.2 : 0.5);
      }

      for (let j = c.bees.length - 1; j >= 0; j--) {
        const b = c.bees[j];
        if (this.beeIdx >= MAX_BEES) break;
        let scale = b.scale;
        const age = t - b.born;
        if (age < 1) scale *= 0.2 + 0.8 * age;

        this.stepBee(b, dt, t, c.state === 'working', c.state === 'working', 0.82);

        let bx = c.pos.x + b.x;
        let bz = c.pos.z + b.z;
        let by: number;
        let flap = 1;
        let pitch = 0;
        let roll = 0;
        if (b.mode === 'rest') {
          by = rimY + 0.012;
          flap = 0;
        } else {
          by = hoverBase + b.h + Math.sin(t * 3.1 + b.phase) * 0.045;
          const v = Math.hypot(b.vx, b.vz);
          pitch = Math.min(0.35, v * 0.3);
          roll = Math.sin(t * 2.2 + b.phase) * 0.08;
        }
        if (b.leaving) {
          const lt = (t - b.leaving) / 1.8;
          if (lt >= 1) {
            c.bees.splice(j, 1);
            continue;
          }
          by += lt * lt * 2.6;
          bx += Math.cos(b.phase) * lt * 1.4;
          bz += Math.sin(b.phase) * lt * 1.4;
          scale *= 1 - lt * 0.8;
          flap = 1;
          pitch = -0.4;
        }
        this.writeBee(bx, by, bz, b.heading, pitch, roll, scale, flap, beeTint, surfaceY, t, b.phase);
      }

      // the queen: one per living cell, bigger, slow, near the centre; white for the biggest
      if (c.state !== 'abandoned' && c.queen.arrive <= t && this.beeIdx < MAX_BEES) {
        const q = c.queen;
        q.a += dt * (c.state === 'working' ? 0.4 : 0.15);
        const qr = single ? 0.3 : 0.2;
        const qx = c.pos.x + Math.cos(q.a) * qr;
        const qz = c.pos.z + Math.sin(q.a) * qr;
        let qy = rimY + 0.36 + Math.sin(t * 1.6 + q.phase) * 0.04;
        let qs = (single ? 1.7 : 1.75) * grow;
        if (q.arrive >= 0) {
          const u = smooth(0, 1.5, t - q.arrive);
          qy += (1 - u) * 5;
          qs *= 0.2 + 0.8 * u;
          if (u >= 1) q.arrive = -1;
        }
        const heading = Math.atan2(-Math.sin(q.a), Math.cos(q.a));
        const look = c.hive.look;
        if (look && c.state === 'working') {
          let m = this.customQueens.get(c.ca);
          if (!m) {
            m = new QueenModel(look, { glowSize: 0.6 });
            this.customQueens.set(c.ca, m);
            this.scene.add(m.group);
          }
          m.setLook(look);
          m.group.visible = true;
          m.group.position.set(qx, qy, qz);
          m.group.rotation.set(0.05, heading, 0);
          m.group.scale.setScalar(qs * 1.3);
          m.animate(t, q.phase);
        } else {
          const tint = c.state !== 'working' ? this.palette.greyBee : c.isBig ? this.palette.royalQueen : this.palette.queen;
          this.writeBee(qx, qy, qz, heading, 0.05, 0, qs, 1, tint, surfaceY, t, q.phase);
          const m = this.customQueens.get(c.ca);
          if (m) m.group.visible = false;
        }
      } else if (this.customQueens.has(c.ca)) {
        this.customQueens.get(c.ca)!.group.visible = false;
      }
    }

    // empty cells (the comb's edge)
    const plateBase = this.day ? _c.set(theme.palette.dayBase).multiplyScalar(0.84).clone() : new THREE.Color(theme.palette.surface).lerp(this.palette.accent, 0.1);
    const plateHot = this.day ? this.palette.soft.clone().lerp(new THREE.Color(theme.palette.dayBase), 0.35) : this.palette.accent.clone().multiplyScalar(0.42);
    const rimBase = this.palette.accent.clone().multiplyScalar(this.day ? 0.6 : 0.3);
    const rimHot = this.day ? this.palette.accent : this.palette.soft;
    const ghosts: { amt: number; prio: number; x: number; z: number; g: number; gh: number }[] = [];
    const nSlots = Math.min(this.slots.length, MAX_SLOTS);
    for (let i = 0; i < nSlots; i++) {
      const sl = this.slots[i];
      const isSel = sl.key === selSlot;
      sl.hover += ((sl.key === hoverSlot ? 1 : 0) - sl.hover) * k;
      sl.sel += ((isSel ? 1 : 0) - sl.sel) * k;
      const grow = smooth(0, 0.9, t - sl.born) * (1 - smooth(-0.2, 0.2, -1)); // fade in when the edge grows
      const amt = Math.max(sl.hover, sl.sel);
      const g = Math.max(0.001, grow);
      _q.identity();
      _p.set(sl.pos.x, 0, sl.pos.z);
      _s.set(0.97 * g, 0.025 + amt * 0.02, 0.97 * g);
      _m.compose(_p, _q, _s);
      this.slotPlate.setMatrixAt(i, _m);
      _c.copy(plateBase).lerp(plateHot, amt);
      this.slotPlate.setColorAt(i, _c);
      _s.set(g, 0.06 + amt * 0.05, g);
      _m.compose(_p, _q, _s);
      this.slotRim.setMatrixAt(i, _m);
      _c.copy(rimBase).lerp(rimHot, Math.min(1, amt + (isSel ? 0.25 * Math.sin(t * 3.2) : 0)));
      this.slotRim.setColorAt(i, _c);
      // ghost cell: a translucent wax preview of the hive that could live here
      const gh = 0.06 + 0.5 * amt + (isSel ? Math.sin(t * 2.4) * 0.03 : 0);
      if (amt > 0.02) ghosts.push({ amt, prio: isSel ? 2 : sl.key === hoverSlot ? 1 : 0, x: sl.pos.x, z: sl.pos.z, g, gh });
      if (isSel) {
        ringOn = true;
        ringScale = g;
        this.selRing.position.set(sl.pos.x, gh - 0.01, sl.pos.z);
        this.selRing.material.color.copy(this.palette.soft);
        // scouts: three bees checking out the empty cell
        for (const b of this.scouts) {
          this.stepBee(b, dt, t, true, false, 0.6);
          const by = gh + 0.28 + b.h * 0.6 + Math.sin(t * 3.1 + b.phase) * 0.045;
          this.writeBee(sl.pos.x + b.x, by, sl.pos.z + b.z, b.heading, Math.min(0.35, Math.hypot(b.vx, b.vz) * 0.3), Math.sin(t * 2.2 + b.phase) * 0.08, b.scale * Math.min(1, (t - b.born) * 1.5), 1, this.palette.worker, gh, t, b.phase);
        }
      }
    }
    ghosts.sort((a, b) => b.prio - a.prio || b.amt - a.amt);
    const ghostN = Math.min(ghosts.length, MAX_GHOSTS);
    _q.identity();
    for (let gi = 0; gi < ghostN; gi++) {
      const gs = ghosts[gi];
      _p.set(gs.x, 0, gs.z);
      _s.set(gs.g * (0.92 + 0.08 * gs.amt), gs.gh, gs.g * (0.92 + 0.08 * gs.amt));
      _m.compose(_p, _q, _s);
      this.ghostMesh.setMatrixAt(gi, _m);
    }
    this.slotPlate.count = nSlots;
    this.slotRim.count = nSlots;
    this.ghostMesh.count = ghostN;
    this.slotPlate.instanceMatrix.needsUpdate = true;
    this.slotRim.instanceMatrix.needsUpdate = true;
    this.ghostMesh.instanceMatrix.needsUpdate = true;
    if (this.slotPlate.instanceColor) this.slotPlate.instanceColor.needsUpdate = true;
    if (this.slotRim.instanceColor) this.slotRim.instanceColor.needsUpdate = true;
    this.slotPlate.computeBoundingSphere();

    // selection rim
    this.selRing.visible = ringOn;
    if (ringOn) {
      const pulse = 1 + Math.sin(t * 3.2) * 0.015;
      this.selRing.scale.set(ringScale * pulse, 0.06, ringScale * pulse);
      this.selRing.material.opacity = 0.5 + 0.3 * Math.sin(t * 3.2);
    }

    // flights (swarms + founding colonies)
    for (const f of this.flights) {
      const u = (t - f.start) / f.dur;
      if (u < 0) continue;
      if (u >= 1) {
        if (!f.done) {
          f.done = true;
          const target = this.byCa.get(f.targetCa);
          if (target) {
            if (f.kind === 'swarm') {
              target.flash = 1.2;
              this.spawnRing(target.pos, 0.3, 1.6, 1.1, this.palette.raid, target.height + 0.05);
            } else {
              this.spawnRing(target.pos, 0.3, 1.4, 1.0, this.palette.soft, target.height + 0.05);
            }
          }
        }
        continue;
      }
      const target = this.byCa.get(f.targetCa);
      const surface = target ? target.height * target.fill + 0.08 : 0;
      const apex = 1.6 + f.from.distanceTo(f.to) * 0.25;
      const dirx = f.to.x - f.from.x;
      const dirz = f.to.z - f.from.z;
      const heading = Math.atan2(dirx, dirz);
      for (const b of f.bees) {
        if (this.beeIdx >= MAX_BEES) break;
        const uu = THREE.MathUtils.clamp(u - b.phase * 0.4, 0, 1);
        if (uu <= 0 || uu >= 1) continue;
        const e = uu < 0.5 ? 2 * uu * uu : 1 - Math.pow(-2 * uu + 2, 2) / 2;
        _v.lerpVectors(f.from, f.to, e);
        const yy = _v.y + Math.sin(e * Math.PI) * apex + b.dy;
        this.writeBee(_v.x + b.dx, yy, _v.z + b.dz, heading, -Math.cos(e * Math.PI) * 0.5, Math.sin(t * 3 + b.phase * 20) * 0.1, 1.05, 1, this.palette.worker, surface, t, b.phase * 20);
      }
    }
    this.flights = this.flights.filter((f) => !f.done);

    // rings + pulses
    this.drawRings(this.rings, this.ringMesh, t);
    this.drawRings(this.pulses, this.pulseMesh, t);

    const n = Math.min(this.cells.length, MAX_CELLS);
    this.wallMesh.count = n;
    this.floorMesh.count = n;
    this.liquidMesh.count = n;
    this.capMesh.count = n;
    this.wallMesh.instanceMatrix.needsUpdate = true;
    this.floorMesh.instanceMatrix.needsUpdate = true;
    this.liquidMesh.instanceMatrix.needsUpdate = true;
    this.capMesh.instanceMatrix.needsUpdate = true;
    if (this.wallMesh.instanceColor) this.wallMesh.instanceColor.needsUpdate = true;
    if (this.liquidMesh.instanceColor) this.liquidMesh.instanceColor.needsUpdate = true;
    // keep the instanced bounding spheres current so ray picking reaches every cell
    this.wallMesh.computeBoundingSphere();
    this.liquidMesh.computeBoundingSphere();
    this.beeMesh.count = this.beeIdx;
    this.wingMesh.count = this.beeIdx;
    this.shadowMesh.count = this.beeIdx;
    this.beeMesh.instanceMatrix.needsUpdate = true;
    this.wingMesh.instanceMatrix.needsUpdate = true;
    this.shadowMesh.instanceMatrix.needsUpdate = true;
    if (this.beeMesh.instanceColor) this.beeMesh.instanceColor.needsUpdate = true;

    this.composer.render();
  }
}

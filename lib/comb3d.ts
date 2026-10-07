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
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { theme } from '@/themes';
import { axialToXY, ringXY, spiral, cellKey } from './hex';
import type { Hive, SceneEvent } from './types';

const MAX_CELLS = 400;
const MAX_BEES = 2600;
const MAX_RINGS = 96;
const MAX_BEES_PER_CELL = 30;
const TILT = (30 * Math.PI) / 180; // from vertical
const CELL_R = 1;
const CELL_GAP = 1.08; // spacing multiplier

interface Bee {
  a: number;
  r: number;
  h: number;
  speed: number;
  phase: number;
  scale: number;
  leaving: number; // 0 = no, else time started
  born: number;
}

interface Flight {
  from: THREE.Vector3;
  to: THREE.Vector3;
  start: number;
  dur: number;
  bees: { dx: number; dz: number; dy: number; phase: number }[];
  targetCa: string;
  done: boolean;
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
  targetLift: number;
  flash: number; // red raid glow
  white: number; // harvest flash (biggest)
  pulse: number; // harvest wave glow
  dip: number; // seal depth dip
  bees: Bee[];
  targetBees: number;
  nextLeave: number;
  state: Hive['state'];
  spawn: number; // 1 → 0 grow-in
  hive: Hive;
}

export interface CombOptions {
  mode: 'comb' | 'single';
  onHover?: (ca: string | null, x: number, y: number) => void;
  onSelect?: (ca: string) => void;
  interactive?: boolean;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _dummy = new THREE.Object3D();

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

/** Hex prism along +Y from 0..1 (scaled later). */
function prismGeometry(r: number, hole?: number) {
  const shape = theme.shape === 'hex' ? hexShape(r) : circleShape(r);
  if (hole) shape.holes.push(theme.shape === 'hex' ? hexShape(hole) : circleShape(hole));
  const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 24 });
  g.rotateX(-Math.PI / 2);
  return g;
}
function circleShape(r: number) {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  return s;
}

function beeGeometry() {
  const body = new THREE.SphereGeometry(1, 10, 8);
  body.scale(0.085, 0.07, 0.12);
  const head = new THREE.SphereGeometry(1, 8, 6);
  head.scale(0.048, 0.048, 0.048);
  head.translate(0, 0.016, 0.13);
  return mergeGeometries([body, head])!;
}
function wingGeometry() {
  const l = new THREE.PlaneGeometry(0.09, 0.17);
  l.rotateX(-Math.PI / 2);
  l.rotateZ(0.5);
  l.translate(-0.065, 0.06, 0);
  const r = new THREE.PlaneGeometry(0.09, 0.17);
  r.rotateX(-Math.PI / 2);
  r.rotateZ(-0.5);
  r.translate(0.065, 0.06, 0);
  return mergeGeometries([l, r])!;
}

const spiralIndex = new Map<string, number>();
spiral(600).forEach((c, i) => spiralIndex.set(cellKey(c), i));

function layoutXZ(h: Hive): [number, number] {
  if (theme.scene === 'den') {
    const i = spiralIndex.get(cellKey(h.cell)) ?? 0;
    const [x, y] = ringXY(i, 2.25);
    return [x, y];
  }
  const [x, y] = axialToXY(h.cell, CELL_R * CELL_GAP);
  return [x, y];
}

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
  private ringMesh: THREE.InstancedMesh;
  private pulseMesh: THREE.InstancedMesh;
  private rings: Ring[] = [];
  private pulses: Ring[] = [];
  private flights: Flight[] = [];
  private target = new THREE.Vector3();
  private zoom = 1;
  private azimuth = 0;
  private raf = 0;
  private last = 0;
  private time = 0;
  private hovered: CellVis | null = null;
  private pointer = new THREE.Vector2(-10, -10);
  private raycaster = new THREE.Raycaster();
  private dragging = false;
  private dragMoved = false;
  private lastPointer = { x: 0, y: 0 };
  private pinch = 0;
  private width = 1;
  private height = 1;
  private maxHoney = 1;
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
    this.zoom = opts.mode === 'single' ? 1.0 : 1;

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

    const beeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.palette.accent).multiplyScalar(0.75), roughness: 0.3, metalness: 0.2, emissive: new THREE.Color(theme.palette.accent), emissiveIntensity: 0.08 });
    this.beeMesh = new THREE.InstancedMesh(beeGeometry(), beeMat, MAX_BEES);
    this.beeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beeMesh.frustumCulled = false;
    this.scene.add(this.beeMesh);
    const wingMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.palette.text), transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false });
    this.wingMesh = new THREE.InstancedMesh(wingGeometry(), wingMat, MAX_BEES);
    this.wingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wingMesh.frustumCulled = false;
    this.scene.add(this.wingMesh);

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
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), this.isMobile ? 0.22 : 0.32, 0.55, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    if (typeof window !== 'undefined') (window as unknown as { __comb?: CombRenderer }).__comb = this;
    this.resize();
    if (opts.mode === 'comb' && this.width > 1000) this.target.set(-3.2, 0, 0.4);
    else if (opts.mode === 'comb' && this.width < 760) this.target.set(0, 0, 5);
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
  }

  setVisible(v: boolean) {
    this.visible = v;
  }

  /** Sync cells to the latest hive data. */
  sync(hives: Hive[], biggestCa: string) {
    const list = this.opts.mode === 'single' ? hives : hives;
    this.maxHoney = Math.max(1, ...list.map((h) => h.honey));
    const seen = new Set<string>();
    for (const h of list) {
      seen.add(h.ca);
      let c = this.byCa.get(h.ca);
      const [x, z] = this.opts.mode === 'single' ? [0, 0] : layoutXZ(h);
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
      c.targetBees = h.state === 'abandoned' ? 0 : Math.max(1, Math.min(MAX_BEES_PER_CELL, Math.round(h.bees / 60)));
      const isBig = h.ca === biggestCa && h.state !== 'abandoned';
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
        if (c) {
          c.spawn = 1;
          this.spawnRing(c.pos, 0.2, 2, 1.4, this.palette.soft, 0.1);
        }
        break;
    }
  }

  focus(ca: string) {
    const c = this.byCa.get(ca);
    if (c) this.target.copy(c.target);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unbind();
    this.renderer.dispose();
    this.composer.dispose();
  }

  /* ---------- internals ---------- */
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
      targetLift: 0,
      flash: 0,
      white: 0,
      pulse: 0,
      dip: 0,
      bees: [],
      targetBees: 0,
      nextLeave: 0,
      state: h.state,
      spawn: 0,
      hive: h,
    };
    const n = h.state === 'abandoned' ? 0 : Math.max(1, Math.min(MAX_BEES_PER_CELL, Math.round(h.bees / 60)));
    for (let i = 0; i < n; i++) c.bees.push(this.makeBee());
    return c;
  }

  private makeBee(): Bee {
    const sz = this.opts.mode === 'single' ? 1.6 : 1;
    return {
      a: Math.random() * Math.PI * 2,
      r: (0.15 + Math.random() * 0.75) * CELL_R * (this.opts.mode === 'single' ? 1.1 : 1),
      h: Math.random() * 0.35,
      speed: (0.6 + Math.random() * 1.2) * (Math.random() < 0.5 ? 1 : -1),
      phase: Math.random() * Math.PI * 2,
      scale: (0.8 + Math.random() * 0.4) * sz,
      leaving: 0,
      born: this.time,
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
    this.flights.push({ from: from.pos.clone().setY(from.height + 0.3), to: to.pos.clone().setY(to.height + 0.3), start: this.time, dur: 1.6 + Math.min(1.2, from.pos.distanceTo(to.pos) * 0.12), bees, targetCa: to.ca, done: false });
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
    const view = this.opts.mode === 'single' ? 1.75 : this.width < 760 ? 15 : 12;
    this.camera.left = -view * aspect;
    this.camera.right = view * aspect;
    this.camera.top = view;
    this.camera.bottom = -view;
    this.camera.updateProjectionMatrix();
  }

  private updateCamera() {
    const dist = 80;
    const dir = new THREE.Vector3(Math.sin(this.azimuth) * Math.sin(TILT), Math.cos(TILT), Math.cos(this.azimuth) * Math.sin(TILT));
    this.camera.position.copy(this.target).addScaledVector(dir, dist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();
  }

  /* ---------- input ---------- */
  private onPointerMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.lastPointer.x = e.clientX;
    this.lastPointer.y = e.clientY;
    if (this.dragging && this.opts.interactive !== false && this.opts.mode === 'comb') {
      const dx = e.movementX;
      const dy = e.movementY;
      if (Math.abs(dx) + Math.abs(dy) > 1) this.dragMoved = true;
      const unitsPerPx = (this.camera.right - this.camera.left) / this.zoom / this.width;
      const right = new THREE.Vector3(Math.cos(this.azimuth), 0, -Math.sin(this.azimuth));
      const up = new THREE.Vector3(-Math.sin(this.azimuth), 0, -Math.cos(this.azimuth));
      this.target.addScaledVector(right, -dx * unitsPerPx).addScaledVector(up, (-dy * unitsPerPx) / Math.cos(TILT));
      this.canvas.style.cursor = 'grabbing';
    }
  };
  private onPointerDown = (e: PointerEvent) => {
    this.dragging = true;
    this.dragMoved = false;
    this.canvas.setPointerCapture?.(e.pointerId);
  };
  private onPointerUp = (e: PointerEvent) => {
    this.dragging = false;
    this.canvas.style.cursor = this.hovered ? 'pointer' : 'grab';
    if (!this.dragMoved && this.hovered && this.opts.onSelect) this.opts.onSelect(this.hovered.ca);
    this.canvas.releasePointerCapture?.(e.pointerId);
  };
  private onPointerLeave = () => {
    this.pointer.set(-10, -10);
    this.dragging = false;
  };
  private onWheel = (e: WheelEvent) => {
    if (this.opts.mode !== 'comb' || this.opts.interactive === false) return;
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.0012);
    this.zoom = THREE.MathUtils.clamp(this.zoom * f, 0.45, 4);
  };
  private touches = new Map<number, { x: number; y: number }>();
  private onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      this.pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  };
  private onTouchMove = (e: TouchEvent) => {
    if (e.touches.length === 2 && this.pinch) {
      e.preventDefault();
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      this.zoom = THREE.MathUtils.clamp(this.zoom * (d / this.pinch), 0.45, 4);
      this.pinch = d;
    }
  };
  private ro?: ResizeObserver;
  private bind() {
    const c = this.canvas;
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointerleave', this.onPointerLeave);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('touchstart', this.onTouchStart, { passive: true });
    c.addEventListener('touchmove', this.onTouchMove, { passive: false });
    c.style.cursor = this.opts.mode === 'comb' ? 'grab' : 'default';
    c.style.touchAction = this.opts.mode === 'comb' ? 'none' : 'auto';
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(c);
  }
  private unbind() {
    const c = this.canvas;
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('touchstart', this.onTouchStart);
    c.removeEventListener('touchmove', this.onTouchMove);
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

  /* ---------- frame ---------- */
  private loop(now: number) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    if (!this.visible) return;

    if (this.opts.mode === 'single') this.azimuth += dt * 0.12;
    this.updateCamera();

    // hover
    if (this.opts.mode === 'comb' && this.opts.interactive !== false && !this.dragging) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.raycaster.intersectObject(this.wallMesh, false)[0] ?? this.raycaster.intersectObject(this.liquidMesh, false)[0];
      const cell = hit && hit.instanceId !== undefined ? this.cells[hit.instanceId] : null;
      if (cell !== this.hovered) {
        if (this.hovered) this.hovered.targetLift = 0;
        this.hovered = cell ?? null;
        if (cell) cell.targetLift = 1;
        this.canvas.style.cursor = cell ? 'pointer' : 'grab';
        this.opts.onHover?.(cell ? cell.ca : null, this.lastPointer.x, this.lastPointer.y);
      } else if (cell) {
        this.opts.onHover?.(cell.ca, this.lastPointer.x, this.lastPointer.y);
      }
    }

    // viscous easing: exponential approach, ~700 ms to settle
    const k = 1 - Math.exp(-dt * 4.2);
    const kSlow = 1 - Math.exp(-dt * 2.4);
    let beeIdx = 0;
    const t = this.time;

    for (let i = 0; i < this.cells.length && i < MAX_CELLS; i++) {
      const c = this.cells[i];
      c.pos.lerp(c.target, kSlow);
      c.height += (c.targetHeight - c.height) * k;
      c.fill += (c.targetFill - c.fill) * k;
      c.cap += (c.targetCap - c.cap) * k;
      c.lift += (c.targetLift - c.lift) * k;
      c.wall.lerp(c.targetWall, kSlow);
      c.liquid.lerp(c.targetLiquid, kSlow);
      c.flash = Math.max(0, c.flash - dt * 0.7);
      c.white = Math.max(0, c.white - dt * 0.9);
      c.pulse = Math.max(0, c.pulse - dt * 1.4);
      c.dip = Math.max(0, c.dip - dt * 1.1);
      c.spawn = Math.max(0, c.spawn - dt * 0.8);
      const grow = 1 - c.spawn * c.spawn;
      const lift = c.lift * 0.08;
      const y = lift;
      const h = c.height * (1 - 0.1 * Math.sin(c.dip * Math.PI)) * grow;
      const pulseGlow = c.pulse > 0 && c.pulse < 1 ? Math.sin(c.pulse * Math.PI) : 0;

      // wall
      _p.set(c.pos.x, y, c.pos.z);
      _s.set(grow, Math.max(0.02, h), grow);
      _m.compose(_p, _q.identity(), _s);
      this.wallMesh.setMatrixAt(i, _m);
      _c.copy(c.wall).lerp(this.palette.raid, c.flash * 0.8).lerp(this.palette.royal, Math.min(1, Math.min(1, c.white) * 0.8 + pulseGlow * 0.12));
      if (c.lift > 0) _c.lerp(this.palette.soft, c.lift * 0.25);
      this.wallMesh.setColorAt(i, _c);

      // floor
      _p.set(c.pos.x, y, c.pos.z);
      _s.set(grow, 0.08, grow);
      _m.compose(_p, _q, _s);
      this.floorMesh.setMatrixAt(i, _m);

      // liquid
      const level = Math.max(0.03, h * c.fill);
      const wobble = c.state === 'working' ? 1 + Math.sin(t * 1.3 + i) * 0.004 : 1;
      _p.set(c.pos.x, y + 0.08, c.pos.z);
      _s.set(0.995 * grow * wobble, level, 0.995 * grow * wobble);
      _m.compose(_p, _q, _s);
      this.liquidMesh.setMatrixAt(i, _m);
      _c.copy(c.liquid).lerp(this.palette.raid, c.flash).lerp(this.palette.royal, Math.min(1, c.white)).lerp(this.palette.soft, pulseGlow * 0.3);
      if (c.lift > 0) _c.lerp(this.palette.royal, c.lift * 0.15);
      this.liquidMesh.setColorAt(i, _c);

      // cap: a wax plate that closes the cell from the centre outward as supply is sealed
      const capF = Math.min(0.9, c.cap * 5) * grow;
      _p.set(c.pos.x, y + h - 0.02, c.pos.z);
      _s.set(capF > 0.01 ? capF : 0.0001, 0.06, capF > 0.01 ? capF : 0.0001);
      _m.compose(_p, _q, _s);
      this.capMesh.setMatrixAt(i, _m);

      // bees: population management
      const alive = c.bees.filter((b) => !b.leaving).length;
      if (alive < c.targetBees && Math.random() < dt * 3) c.bees.push(this.makeBee());
      if (alive > c.targetBees && t > c.nextLeave) {
        const b = c.bees.find((x) => !x.leaving);
        if (b) b.leaving = t;
        c.nextLeave = t + (c.state === 'working' ? 0.2 : 0.5);
      }
      for (let j = c.bees.length - 1; j >= 0; j--) {
        const b = c.bees[j];
        if (beeIdx >= MAX_BEES) break;
        b.a += b.speed * dt;
        let scale = b.scale;
        let by = y + h + 0.22 + b.h + Math.sin(t * 2.6 + b.phase) * 0.06;
        let bx = c.pos.x + Math.cos(b.a) * b.r;
        let bz = c.pos.z + Math.sin(b.a) * b.r;
        const age = t - b.born;
        if (age < 1) scale *= age;
        if (b.leaving) {
          const lt = (t - b.leaving) / 1.8;
          if (lt >= 1) {
            c.bees.splice(j, 1);
            continue;
          }
          by += lt * 2.2;
          bx += Math.cos(b.phase) * lt * 1.5;
          bz += Math.sin(b.phase) * lt * 1.5;
          scale *= 1 - lt;
        }
        const heading = -b.a + (b.speed > 0 ? Math.PI / 2 : -Math.PI / 2);
        _e.set(0, heading, Math.sin(t * 4 + b.phase) * 0.15);
        _q.setFromEuler(_e);
        _p.set(bx, by, bz);
        _s.setScalar(scale);
        _m.compose(_p, _q, _s);
        this.beeMesh.setMatrixAt(beeIdx, _m);
        const flap = 0.6 + Math.abs(Math.sin(t * 40 + b.phase)) * 0.8;
        _s.set(scale, scale, scale * flap);
        _m.compose(_p, _q, _s);
        this.wingMesh.setMatrixAt(beeIdx, _m);
        beeIdx++;
      }
    }
    _q.identity();

    // flights (swarms)
    for (const f of this.flights) {
      const u = (t - f.start) / f.dur;
      if (u >= 1) {
        if (!f.done) {
          f.done = true;
          const target = this.byCa.get(f.targetCa);
          if (target) {
            target.flash = 1.2;
            this.spawnRing(target.pos, 0.3, 1.6, 1.1, this.palette.raid, target.height + 0.05);
          }
        }
        continue;
      }
      const apex = 1.6 + f.from.distanceTo(f.to) * 0.25;
      for (const b of f.bees) {
        if (beeIdx >= MAX_BEES) break;
        const uu = THREE.MathUtils.clamp(u - b.phase * 0.4, 0, 1);
        const e = uu < 0.5 ? 2 * uu * uu : 1 - Math.pow(-2 * uu + 2, 2) / 2;
        _p.lerpVectors(f.from, f.to, e);
        _p.y += Math.sin(e * Math.PI) * apex + b.dy;
        _p.x += b.dx;
        _p.z += b.dz;
        const dirx = f.to.x - f.from.x;
        const dirz = f.to.z - f.from.z;
        _e.set(-Math.cos(e * Math.PI) * 0.6, Math.atan2(dirx, dirz), 0);
        _q.setFromEuler(_e);
        _s.setScalar(uu > 0 && uu < 1 ? 1.05 : 0.0001);
        _m.compose(_p, _q, _s);
        this.beeMesh.setMatrixAt(beeIdx, _m);
        _s.set(1.05, 1.05, 1.05 * (0.6 + Math.abs(Math.sin(t * 40 + b.phase * 10)) * 0.8));
        _m.compose(_p, _q, _s);
        this.wingMesh.setMatrixAt(beeIdx, _m);
        beeIdx++;
      }
    }
    this.flights = this.flights.filter((f) => !f.done);
    _q.identity();

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
    this.beeMesh.count = beeIdx;
    this.wingMesh.count = beeIdx;
    this.beeMesh.instanceMatrix.needsUpdate = true;
    this.wingMesh.instanceMatrix.needsUpdate = true;

    this.composer.render();
  }
}
void _dummy;

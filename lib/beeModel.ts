/**
 * Bee geometry shared by the comb and the launch wizard's live preview.
 * Forward is +Z; the body is ~0.31 units long. Colours are baked as vertex colours.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { theme } from '@/themes';
import { markColor, type QueenLook } from './queen';

function paint(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => THREE.Color) {
  const pos = g.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = fn(pos.getX(i), pos.getY(i), pos.getZ(i));
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Worker look: the theme's own colours with classic stripes. */
export const WORKER_LOOK: QueenLook = {
  body: theme.palette.accent,
  marking: 'stripes',
  fuzz: theme.palette.accentSoft,
  glow: theme.palette.accent,
  wings: theme.palette.text,
  crown: 'none',
};

/** Abdomen with the chosen marking, fuzzy thorax, dark head. */
export function beeGeometry(look: QueenLook = WORKER_LOOK) {
  const dark = new THREE.Color('#1c1207');
  const base = new THREE.Color(look.body);
  const mark = new THREE.Color(markColor(look.body));
  const light = base.clone().lerp(new THREE.Color('#ffffff'), 0.28);
  const fuzz = new THREE.Color(look.fuzz);

  const abdomen = new THREE.SphereGeometry(1, 16, 12);
  paint(abdomen, (x, y, z) => {
    const s = (z + 1) / 2; // 0 = tail, 1 = front
    if (s < 0.14) return mark;
    let on = false;
    switch (look.marking) {
      case 'stripes':
        on = Math.floor(s * 5.4) % 2 === 0;
        break;
      case 'bands':
        on = Math.floor(s * 3.2) % 2 === 0;
        break;
      case 'chevron':
        on = Math.floor((s + Math.abs(x) * 0.35) * 5) % 2 === 0;
        break;
      case 'spots':
        on = Math.sin(x * 9) * Math.sin(z * 11) * Math.sin(y * 7 + 1) > 0.35;
        break;
      case 'solid':
        on = false;
    }
    const c = (on ? mark : base).clone();
    if (y > 0.3) c.lerp(on ? mark.clone().lerp(light, 0.15) : light, on ? 0.1 : 0.35); // lit top
    return c;
  });
  abdomen.scale(0.072, 0.064, 0.105);
  abdomen.translate(0, 0, -0.058);

  const thorax = new THREE.SphereGeometry(1, 14, 10);
  paint(thorax, (_x, y) => (y > 0.2 ? fuzz.clone().lerp(new THREE.Color('#ffffff'), 0.14) : fuzz.clone().multiplyScalar(0.8)));
  thorax.scale(0.064, 0.06, 0.072);
  thorax.translate(0, 0.004, 0.052);

  const head = new THREE.SphereGeometry(1, 12, 8);
  paint(head, () => dark);
  head.scale(0.04, 0.04, 0.038);
  head.translate(0, 0.012, 0.118);

  return mergeGeometries([abdomen, thorax, head])!;
}

/** Four translucent wings: fore + hind on each side, swept back, lying nearly flat. */
export function wingGeometry() {
  const mk = (side: number, len: number, wid: number, dz: number, sweep: number) => {
    const g = new THREE.CircleGeometry(1, 12);
    g.scale(len, wid, 1);
    g.translate(len * 0.85, 0, 0); // hinge at the body
    g.rotateX(-Math.PI / 2);
    g.rotateY(-side * sweep);
    if (side < 0) g.scale(-1, 1, 1);
    g.translate(0, 0.056, dz);
    g.deleteAttribute('uv');
    return g;
  };
  return mergeGeometries([mk(1, 0.125, 0.048, 0.012, 0.5), mk(-1, 0.125, 0.048, 0.012, 0.5), mk(1, 0.085, 0.034, -0.03, 0.95), mk(-1, 0.085, 0.034, -0.03, 0.95)])!;
}

/** Crown, tiara or halo sitting on the head. Null for none. */
export function crownGeometry(look: QueenLook): THREE.BufferGeometry | null {
  const gold = new THREE.Color('#FFD45A');
  const gem = new THREE.Color(look.glow);
  const parts: THREE.BufferGeometry[] = [];
  if (look.crown === 'crown') {
    const band = new THREE.CylinderGeometry(0.03, 0.033, 0.014, 16, 1, true);
    band.translate(0, 0.055, 0.118);
    parts.push(paint(band, () => gold));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spike = new THREE.ConeGeometry(0.008, 0.024, 6);
      spike.translate(Math.cos(a) * 0.029, 0.072, 0.118 + Math.sin(a) * 0.029);
      parts.push(paint(spike, () => gold));
    }
  } else if (look.crown === 'tiara') {
    const arc = new THREE.TorusGeometry(0.036, 0.0045, 6, 20, Math.PI);
    arc.rotateY(Math.PI / 2);
    arc.translate(0, 0.03, 0.118);
    parts.push(paint(arc, () => gold));
    const g = new THREE.OctahedronGeometry(0.011);
    g.translate(0, 0.068, 0.118);
    parts.push(paint(g, () => gem));
  } else if (look.crown === 'halo') {
    const ring = new THREE.TorusGeometry(0.036, 0.004, 6, 28);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, 0.09, 0.112);
    parts.push(paint(ring, () => new THREE.Color('#FFF4C2')));
  } else return null;
  for (const p of parts) if (p.attributes.uv) p.deleteAttribute('uv');
  for (const p of parts) if (p.attributes.normal === undefined) p.computeVertexNormals();
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
}

/** A soft radial sprite texture used for glows. */
let glowTex: THREE.CanvasTexture | null = null;
export function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

/** A complete queen: body, wings, crown and glow. Call `animate` each frame. */
export class QueenModel {
  group = new THREE.Group();
  private body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private wings: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  private crown: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private glow: THREE.Sprite;
  private key = '';

  constructor(look: QueenLook, opts: { glowSize?: number } = {}) {
    this.body = new THREE.Mesh(beeGeometry(look), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.12 }));
    this.wings = new THREE.Mesh(
      wingGeometry(),
      new THREE.MeshPhysicalMaterial({ color: new THREE.Color(look.wings), transparent: true, opacity: 0.4, roughness: 0.15, metalness: 0.2, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(look.glow), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
    const gs = opts.glowSize ?? 0.55;
    this.glow.scale.set(gs, gs, gs);
    this.group.add(this.glow, this.body, this.wings);
    this.setLook(look);
  }

  setLook(look: QueenLook) {
    const key = JSON.stringify(look);
    if (key === this.key) return;
    this.key = key;
    this.body.geometry.dispose();
    this.body.geometry = beeGeometry(look);
    this.wings.material.color.set(look.wings);
    this.glow.material.color.set(look.glow);
    if (this.crown) {
      this.group.remove(this.crown);
      this.crown.geometry.dispose();
      this.crown.material.dispose();
      this.crown = null;
    }
    const cg = crownGeometry(look);
    if (cg) {
      this.crown = new THREE.Mesh(cg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.75, emissive: new THREE.Color(look.crown === 'halo' ? '#FFF4C2' : '#000000'), emissiveIntensity: look.crown === 'halo' ? 0.9 : 0 }));
      this.group.add(this.crown);
    }
  }

  /** Flap the wings and pulse the glow. */
  animate(t: number, phase = 0) {
    const f = 0.55 + Math.abs(Math.sin(t * 46 + phase)) * 0.75;
    this.wings.scale.set(1, 1, f);
    this.glow.material.opacity = 0.42 + Math.sin(t * 2.2 + phase) * 0.12;
  }

  dispose() {
    this.body.geometry.dispose();
    this.body.material.dispose();
    this.wings.geometry.dispose();
    this.wings.material.dispose();
    this.glow.material.dispose();
    if (this.crown) {
      this.crown.geometry.dispose();
      this.crown.material.dispose();
    }
  }
}

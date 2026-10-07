'use client';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { QueenModel } from '@/lib/beeModel';
import { theme } from '@/themes';
import type { QueenLook } from '@/lib/queen';

function hexShape(r: number) {
  const s = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 6) * (2 * i + 1);
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  return s;
}
function prism(r: number, depth: number, hole?: number) {
  const sh = theme.shape === 'hex' ? hexShape(r) : new THREE.Shape().absarc(0, 0, r, 0, Math.PI * 2, false);
  if (hole) sh.holes.push(theme.shape === 'hex' ? hexShape(hole) : new THREE.Path().absarc(0, 0, hole, 0, Math.PI * 2, true));
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 24 });
  g.rotateX(-Math.PI / 2);
  return g;
}

/** The wizard's live preview: your queen hovering over a honey cell. */
export default function QueenPreview({ look, className = '', speaking }: { look: QueenLook; className?: string; speaking?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef<QueenModel | null>(null);
  const lightRef = useRef<THREE.PointLight | null>(null);
  const lookRef = useRef(look);
  lookRef.current = look;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      return; // no WebGL: the CSS glow and the bubble still show
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    camera.position.set(0, 2.15, 4.4);
    camera.lookAt(0, 0.86, 0);
    scene.add(new THREE.HemisphereLight(new THREE.Color(theme.palette.accentSoft), new THREE.Color(theme.palette.base), 0.6));
    const key = new THREE.DirectionalLight(new THREE.Color('#fff2d0'), 1.7);
    key.position.set(2, 4, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(new THREE.Color(theme.palette.accent), 0.8);
    rim.position.set(-3, 2, -2);
    scene.add(rim);
    const glow = new THREE.PointLight(new THREE.Color(look.glow), 1.4, 2.6, 1.8);
    glow.position.set(0, 1.25, 0.35);
    scene.add(glow);
    lightRef.current = glow;

    // the cell: wax walls and honey
    const wall = new THREE.Mesh(prism(0.95, 0.42, 0.8), new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.palette.accent).multiplyScalar(0.55), roughness: 0.5, metalness: 0.05 }));
    const floor = new THREE.Mesh(prism(0.82, 0.04), new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.palette.surface), roughness: 0.9 }));
    const honey = new THREE.Mesh(
      prism(0.81, 0.3),
      new THREE.MeshPhysicalMaterial({ color: new THREE.Color(theme.palette.accent).multiplyScalar(0.85), roughness: 0.16, clearcoat: 0.8, clearcoatRoughness: 0.2, emissive: new THREE.Color(theme.palette.accent), emissiveIntensity: 0.05 }),
    );
    honey.position.y = 0.04;
    const cell = new THREE.Group();
    cell.add(floor, wall, honey);
    scene.add(cell);

    const model = new QueenModel(look, { glowSize: 0.7 });
    model.group.scale.setScalar(3.5);
    scene.add(model.group);
    modelRef.current = model;

    const resize = () => {
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    const start = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = (performance.now() - start) / 1000;
      model.setLook(lookRef.current);
      // hover over the honey, turning slowly so her side (and markings) faces the camera most of the time
      model.group.position.set(Math.sin(t * 0.7) * 0.08, 0.98 + Math.sin(t * 1.7) * 0.05, Math.cos(t * 0.7) * 0.05);
      model.group.rotation.set(0.08, Math.PI * 0.5 + Math.sin(t * 0.45) * 0.75, Math.sin(t * 1.3) * 0.06);
      model.animate(t);
      glow.color.set(lookRef.current.glow);
      glow.intensity = 1.3 + Math.sin(t * 2.2) * 0.3;
      cell.rotation.y = Math.sin(t * 0.25) * 0.15;
      renderer.render(scene, camera);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      model.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        }
      });
      renderer.dispose();
      renderer.forceContextLoss(); // dispose() alone keeps the WebGL context alive
      modelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`relative overflow-hidden ${className}`} style={{ background: `radial-gradient(60% 70% at 50% 45%, ${look.glow}38 0%, transparent 70%), radial-gradient(120% 100% at 50% 100%, rgb(var(--c-accent) / 0.12), transparent 60%)` }}>
      <canvas ref={canvasRef} className="block h-full w-full" aria-label={`Live preview of your ${theme.agent}`} />
      <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 flex-col items-center gap-1">
        {speaking && <div className="fade-up max-w-[260px] rounded-2xl bg-text px-3 py-1.5 text-center text-xs font-medium text-night shadow-lg">{speaking}</div>}
        <div className="shape-btn flex h-5 items-center bg-night/80 text-[10px] font-semibold uppercase tracking-wider text-accent">your {theme.agent}</div>
      </div>
    </div>
  );
}

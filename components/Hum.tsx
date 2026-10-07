'use client';
import { useEffect, useRef } from 'react';
import { useHive } from '@/lib/store';

/** Optional low ambient hum. Off by default; pitch and volume rise with the global fee rate. */
export default function Hum() {
  const sound = useHive((s) => s.sound);
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const oscRef = useRef<OscillatorNode[]>([]);
  useEffect(() => {
    if (!sound) {
      gainRef.current?.gain.setTargetAtTime(0, ctxRef.current?.currentTime ?? 0, 0.4);
      return;
    }
    if (!ctxRef.current) {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      gain.connect(filter).connect(ctx.destination);
      const oscs = [110, 112.5, 165].map((f, i) => {
        const o = ctx.createOscillator();
        o.type = i === 2 ? 'triangle' : 'sawtooth';
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = i === 2 ? 0.25 : 0.5;
        o.connect(g).connect(gain);
        o.start();
        return o;
      });
      ctxRef.current = ctx;
      gainRef.current = gain;
      oscRef.current = oscs;
    }
    ctxRef.current.resume();
    const tick = () => {
      const s = useHive.getState();
      let rate = 0;
      for (const ca of s.world.order) rate += s.world.hives[ca].feesHour;
      const v = Math.min(0.12, 0.03 + rate * 0.004);
      const t = ctxRef.current!.currentTime;
      gainRef.current!.gain.setTargetAtTime(v, t, 0.8);
      oscRef.current.forEach((o, i) => o.frequency.setTargetAtTime([110, 112.5, 165][i] * (1 + Math.min(0.3, rate * 0.01)), t, 1.2));
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [sound]);
  return null;
}

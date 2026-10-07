'use client';
import { useEffect, useRef, useState } from 'react';

/** Digits slide up like liquid when the value changes. */
export default function PourCounter({ value, className = '' }: { value: string; className?: string }) {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    if (value !== prev.current) {
      prev.current = value;
      setDisplay(value);
    }
  }, [value]);
  return (
    <span className={`pour font-heading tabular-nums ${className}`} aria-label={display}>
      {display.split('').map((ch, i) =>
        /\d/.test(ch) ? (
          <span className="d" key={i}>
            <span style={{ transform: `translateY(-${Number(ch)}em)` }}>
              {Array.from({ length: 10 }, (_, d) => (
                <b key={d}>{d}</b>
              ))}
            </span>
          </span>
        ) : (
          <span key={i} className="inline-block" style={{ height: '1em' }}>
            {ch === ' ' ? ' ' : ch}
          </span>
        ),
      )}
    </span>
  );
}

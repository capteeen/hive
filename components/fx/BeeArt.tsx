/**
 * The ambient bee, drawn in side view facing right, centred on its body in a 44 × 36 box (BEE_W ×
 * BEE_H): glossy striped abdomen, fuzzy golden thorax, dark head with a specular eye, two veined
 * translucent wings on a hinge, a soft "motion blur" fan behind the wings while flying, and legs
 * whose feet sit PERCH_LIFT below the centre (so a perched bee stands on the edge).
 *
 * The gradients and the abdomen clip live once in <BeeDefs /> (ids are document-wide).
 * Wing motion is CSS (`.fxb-wings`): fast flaps in flight, slow flicks while perched.
 */
export function BeeDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden focusable="false">
      <defs>
        <radialGradient id="fxb-abd" cx="38%" cy="28%" r="78%">
          <stop offset="0" stopColor="#FFE7A3" />
          <stop offset="0.38" stopColor="#FFC866" />
          <stop offset="0.7" stopColor="#F5A524" />
          <stop offset="1" stopColor="#B4690A" />
        </radialGradient>
        <radialGradient id="fxb-thx" cx="40%" cy="30%" r="75%">
          <stop offset="0" stopColor="#F7CF7A" />
          <stop offset="0.55" stopColor="#B87818" />
          <stop offset="1" stopColor="#5A3708" />
        </radialGradient>
        <radialGradient id="fxb-fan" cx="70%" cy="80%" r="80%">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.42" />
          <stop offset="0.6" stopColor="#FFF1D6" stopOpacity="0.16" />
          <stop offset="1" stopColor="#FFF1D6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="fxb-wing" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.75" />
          <stop offset="1" stopColor="#DDEBFF" stopOpacity="0.28" />
        </linearGradient>
        <clipPath id="fxb-clip">
          <ellipse cx="-5" cy="2" rx="12" ry="8.6" />
        </clipPath>
      </defs>
    </svg>
  );
}

const INK = '#22160A';

export function BeeArt() {
  return (
    <svg viewBox="-22 -18 44 36" aria-hidden focusable="false">
      {/* motion-blur fan of the beating wings (hidden while perched) */}
      <ellipse className="fxb-fan" cx="-4" cy="-9.5" rx="12.5" ry="7.5" fill="url(#fxb-fan)" />
      {/* hind wing behind the body */}
      <g className="fxb-wings back">
        <path d="M4 -5 C1 -10.5 -8 -13 -11.5 -10 C-13 -8 -6 -5 4 -5 Z" fill="url(#fxb-wing)" stroke="#7A5A2A" strokeOpacity="0.32" strokeWidth="0.5" />
      </g>
      {/* legs */}
      <path d="M3.5 5 l-2.4 5.6 M6.6 5.6 l0.4 5.2 M9.6 4.6 l3 5.8" fill="none" stroke={INK} strokeWidth="1.15" strokeLinecap="round" />
      {/* stinger */}
      <path d="M-16.6 2.4 L-21 4.1 L-16.4 5.4 Z" fill={INK} />
      {/* abdomen: glossy honey with curved dark bands */}
      <ellipse cx="-5" cy="2" rx="12" ry="8.6" fill="url(#fxb-abd)" />
      <g clipPath="url(#fxb-clip)" fill={INK}>
        <path d="M-13.6 -8 q-2 10 0 20 h3 q-2 -10 0 -20z" />
        <path d="M-7.6 -8 q-2 10 0 20 h3.2 q-2 -10 0 -20z" />
        <path d="M-1.6 -8 q-2 10 0 20 h3.2 q-2 -10 0 -20z" />
      </g>
      <ellipse cx="-6" cy="-3" rx="6.5" ry="2" fill="#FFFFFF" opacity="0.38" />
      {/* fuzzy thorax */}
      <circle cx="6" cy="-0.4" r="6.4" fill="url(#fxb-thx)" />
      <circle cx="6" cy="-0.4" r="6.4" fill="none" stroke="#FFD98A" strokeOpacity="0.55" strokeWidth="1.3" strokeDasharray="0.5 1.3" />
      {/* head, eye and its glint, antenna */}
      <circle cx="13.2" cy="1.3" r="4.6" fill={INK} />
      <ellipse cx="14.6" cy="0.2" rx="1.9" ry="2.5" fill="#3E2C17" />
      <circle cx="15.2" cy="-0.7" r="0.75" fill="#FFFFFF" opacity="0.85" />
      <path d="M14.6 -2.8 q1.6 -5 6 -6.6" fill="none" stroke={INK} strokeWidth="1.05" strokeLinecap="round" />
      {/* fore wing on top */}
      <g className="fxb-wings">
        <path d="M5 -5.5 C2 -12 -10 -16 -15 -12.5 C-17 -10.5 -7 -6.5 5 -5.5 Z" fill="url(#fxb-wing)" stroke="#7A5A2A" strokeOpacity="0.4" strokeWidth="0.55" />
        <path d="M5 -5.5 C-1 -9 -7 -11 -13 -12" fill="none" stroke="#FFFFFF" strokeOpacity="0.55" strokeWidth="0.45" />
      </g>
    </svg>
  );
}

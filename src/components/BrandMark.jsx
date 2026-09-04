import { useId } from "react";

// The "Field Numeral — Night" mark from the SideLines brand guide (sidelines-brand.html) —
// primary gradient variant. Gradient/glow ids are namespaced per-instance via useId() so two
// copies can render on screen at once without one silently overriding the other's <defs>.
export default function BrandMark({ size = 28, className }) {
  const uid = useId();
  const gradId = `sl-mark-grad-${uid}`;
  const glowId = `sl-mark-glow-${uid}`;

  return (
    <svg viewBox="0 0 200 200" width={size} height={size} className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#264a34" />
          <stop offset="55%" stopColor="#123320" />
          <stop offset="100%" stopColor="#08120d" />
        </linearGradient>
        <radialGradient id={glowId} cx="78%" cy="20%" r="55%">
          <stop offset="0%" stopColor="#f2c65c" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#f2c65c" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width="200" height="200" rx="44" fill={`url(#${gradId})`} />
      <rect x="0" y="0" width="200" height="200" rx="44" fill={`url(#${glowId})`} />
      <polygon points="38,128 60,114 60,142" fill="#f3ede1" />
      <text x="120" y="133" textAnchor="middle" fontFamily="'Archivo Black', sans-serif" fontSize="76" fill="#f3ede1">
        SL
      </text>
      <rect x="40" y="150" width="132" height="7" rx="3" fill="#e0b23e" />
    </svg>
  );
}

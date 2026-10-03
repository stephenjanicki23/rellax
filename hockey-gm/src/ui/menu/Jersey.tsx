/** Original hero artwork: a game jersey in a team's colours (no real-world branding). */
export function Jersey({ primary, secondary, number, abbr, className }: { primary: string; secondary: string; number: string; abbr: string; className?: string }) {
  const id = `j-${abbr}`;
  return (
    <svg className={className} viewBox="0 0 400 420" role="img" aria-label={`${abbr} jersey number ${number}`}>
      <defs>
        <linearGradient id={`${id}-shade`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.35" />
          <stop offset="0.35" stopColor="#000" stopOpacity="0" />
          <stop offset="0.7" stopColor="#fff" stopOpacity="0.08" />
          <stop offset="1" stopColor="#000" stopOpacity="0.4" />
        </linearGradient>
        <linearGradient id={`${id}-fold`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.12" />
          <stop offset="1" stopColor="#000" stopOpacity="0.25" />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <path d="M140 18 Q200 46 260 18 L338 44 Q370 58 380 92 L398 214 L330 232 L318 168 L320 400 Q200 418 80 400 L82 168 L70 232 L2 214 L20 92 Q30 58 62 44 Z" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <rect width="400" height="420" fill={primary} />
        {/* sleeve stripes */}
        <path d="M0 150 L80 136 L80 156 L0 172 Z M0 182 L80 166 L80 176 L0 192 Z" fill={secondary} />
        <path d="M400 150 L320 136 L320 156 L400 172 Z M400 182 L320 166 L320 176 L400 192 Z" fill={secondary} />
        {/* hem stripes */}
        <rect x="0" y="330" width="400" height="22" fill={secondary} />
        <rect x="0" y="360" width="400" height="9" fill={secondary} />
        {/* yoke */}
        <path d="M60 44 Q200 110 340 44 L340 70 Q200 132 60 70 Z" fill={secondary} opacity="0.9" />
        <rect width="400" height="420" fill={`url(#${id}-shade)`} />
        <path d="M200 120 L196 420 L204 420 Z" fill="#000" opacity="0.12" />
        <rect width="400" height="420" fill={`url(#${id}-fold)`} />
      </g>
      {/* collar */}
      <path d="M140 18 Q200 46 260 18 L250 10 Q200 34 150 10 Z" fill={secondary} />
      <path d="M176 36 L200 72 L224 36" fill="none" stroke={secondary} strokeWidth="7" strokeLinejoin="round" />
      {/* crest */}
      <g transform="translate(200 214)">
        <path d="M0 -62 L54 -40 L48 18 Q38 50 0 64 Q-38 50 -48 18 L-54 -40 Z" fill={secondary} stroke={primary} strokeWidth="5" />
        <text y="12" textAnchor="middle" fontSize="38" fontWeight="800" fill={primary} fontFamily="'Barlow Condensed', 'Arial Narrow', sans-serif" letterSpacing="1">
          {abbr}
        </text>
      </g>
      {/* shoulder numbers */}
      <text x="96" y="122" textAnchor="middle" fontSize="34" fontWeight="800" fill={secondary} fontFamily="'Barlow Condensed', 'Arial Narrow', sans-serif" transform="rotate(-14 96 122)">
        {number}
      </text>
      <text x="304" y="122" textAnchor="middle" fontSize="34" fontWeight="800" fill={secondary} fontFamily="'Barlow Condensed', 'Arial Narrow', sans-serif" transform="rotate(14 304 122)">
        {number}
      </text>
    </svg>
  );
}

/** Circular emblem in the spirit of a console-era publisher ring, with original lettering. */
export function Emblem({ size = 96 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className="mm-emblem" aria-label="Hockey GM">
      <defs>
        <linearGradient id="emb-ring" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#9aa1aa" />
          <stop offset="0.55" stopColor="#e8ebee" />
          <stop offset="1" stopColor="#6b727c" />
        </linearGradient>
        <radialGradient id="emb-core" cx="0.4" cy="0.35" r="0.8">
          <stop offset="0" stopColor="#3a3e45" />
          <stop offset="1" stopColor="#0f1012" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="45" fill="url(#emb-core)" stroke="url(#emb-ring)" strokeWidth="7" />
      <circle cx="50" cy="50" r="36" fill="none" stroke="#ffffff" strokeOpacity="0.18" strokeWidth="1.2" />
      <text x="50" y="47" textAnchor="middle" fontSize="15" fontWeight="800" fontStyle="italic" fill="#f3f5f7" fontFamily="'Barlow Condensed', 'Arial Narrow', sans-serif" letterSpacing="1">
        HOCKEY
      </text>
      <text x="50" y="66" textAnchor="middle" fontSize="20" fontWeight="800" fontStyle="italic" fill="#f3f5f7" fontFamily="'Barlow Condensed', 'Arial Narrow', sans-serif">
        GM
      </text>
      <ellipse cx="50" cy="76" rx="11" ry="3" fill="#cfd4da" />
    </svg>
  );
}

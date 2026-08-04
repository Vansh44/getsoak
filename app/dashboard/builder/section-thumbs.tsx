"use client";

import type { HomepageSectionType } from "@/lib/homepage/section-types";

// Hand-drawn SVG mini-previews for the section library — deterministic
// abstractions of each block type (no screenshot infra, no staleness, crisp
// at any DPI). Colors ride on two CSS vars so the library can theme them:
// --thumb-muted (shapes) and --thumb-accent (the "highlight" of each block).

const VB = "0 0 120 80";
const M = "var(--thumb-muted, #e2e5ea)"; // muted shape
const S = "var(--thumb-soft, #eef0f4)"; // softer fill / background
const A = "var(--thumb-accent, #4f46e5)"; // accent

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox={VB}
      xmlns="http://www.w3.org/2000/svg"
      className="sm-builder-thumb-svg"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const THUMBS: Record<HomepageSectionType, React.ReactNode> = {
  hero: (
    <Svg>
      <rect x="6" y="8" width="108" height="64" rx="6" fill={S} />
      <rect x="16" y="24" width="52" height="8" rx="3" fill={M} />
      <rect x="16" y="37" width="38" height="5" rx="2.5" fill={M} />
      <rect x="16" y="49" width="24" height="9" rx="4.5" fill={A} />
      <circle cx="92" cy="40" r="16" fill={M} />
    </Svg>
  ),
  hero_carousel: (
    <Svg>
      <rect x="14" y="10" width="92" height="56" rx="6" fill={M} />
      {/* play triangle — the video/slideshow hint */}
      <path d="M 55 30 l 14 8 l -14 8 z" fill="#fff" opacity="0.9" />
      {/* prev/next arrows */}
      <path
        d="M 22 34 l -4 4 l 4 4 M 98 34 l 4 4 l -4 4"
        stroke="#fff"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
      {/* dots */}
      <circle cx="52" cy="72" r="3" fill={A} />
      <circle cx="62" cy="72" r="3" fill={M} />
      <circle cx="72" cy="72" r="3" fill={M} />
    </Svg>
  ),
  featured_products: (
    <Svg>
      {[8, 46, 84].map((x) => (
        <g key={x}>
          <rect x={x} y="14" width="28" height="34" rx="4" fill={S} />
          <rect x={x + 4} y="18" width="20" height="18" rx="3" fill={M} />
          <rect x={x + 4} y="40" width="16" height="4" rx="2" fill={M} />
          <rect x={x + 4} y="52" width="20" height="5" rx="2.5" fill={A} />
        </g>
      ))}
    </Svg>
  ),
  shop_by_category: (
    <Svg>
      {[22, 54, 86].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="34" r="13" fill={M} />
          <rect x={cx - 10} y="54" width="20" height="4" rx="2" fill={S} />
        </g>
      ))}
      <circle cx="22" cy="34" r="13" fill={A} opacity="0.85" />
    </Svg>
  ),
  promo_banner: (
    <Svg>
      <rect x="6" y="14" width="108" height="52" rx="6" fill={M} />
      <rect
        x="30"
        y="30"
        width="60"
        height="7"
        rx="3.5"
        fill="#fff"
        opacity="0.9"
      />
      <rect x="42" y="44" width="36" height="8" rx="4" fill={A} />
    </Svg>
  ),
  tile_grid: (
    <Svg>
      <rect
        x="8"
        y="10"
        width="50"
        height="28"
        rx="5"
        fill={A}
        opacity="0.85"
      />
      <rect x="62" y="10" width="50" height="28" rx="5" fill={M} />
      <rect x="8" y="42" width="50" height="28" rx="5" fill={S} />
      <rect x="62" y="42" width="50" height="28" rx="5" fill={M} />
    </Svg>
  ),
  media_text: (
    <Svg>
      <rect x="8" y="10" width="50" height="60" rx="5" fill={M} />
      <rect x="68" y="20" width="34" height="6" rx="3" fill={A} />
      <rect x="68" y="32" width="42" height="4" rx="2" fill={M} />
      <rect x="68" y="41" width="36" height="4" rx="2" fill={S} />
      <rect x="68" y="54" width="24" height="8" rx="4" fill={M} />
    </Svg>
  ),
  gallery: (
    <Svg>
      <rect x="8" y="10" width="58" height="60" rx="5" fill={A} opacity="0.8" />
      <rect x="72" y="10" width="40" height="27" rx="5" fill={M} />
      <rect x="72" y="43" width="40" height="27" rx="5" fill={S} />
    </Svg>
  ),
  testimonials: (
    <Svg>
      {[8, 46, 84].map((x, index) => (
        <g key={x}>
          <rect x={x} y="14" width="28" height="50" rx="5" fill={S} />
          <circle cx={x + 8} cy="25" r="4" fill={index === 1 ? A : M} />
          <rect x={x + 5} y="35" width="18" height="3" rx="1.5" fill={M} />
          <rect x={x + 5} y="42" width="15" height="3" rx="1.5" fill={M} />
          <rect x={x + 5} y="54" width="11" height="3" rx="1.5" fill={A} />
        </g>
      ))}
    </Svg>
  ),
  usp_bar: (
    <Svg>
      <rect x="6" y="28" width="108" height="24" rx="6" fill={S} />
      {[20, 56, 92].map((cx, i) => (
        <g key={cx}>
          <circle cx={cx} cy="37" r="4" fill={i === 0 ? A : M} />
          <rect x={cx - 8} y="44" width="16" height="3" rx="1.5" fill={M} />
        </g>
      ))}
    </Svg>
  ),
  ticker: (
    <Svg>
      {/* a band with short "words" marching across — a scrolling strip */}
      <rect x="6" y="31" width="108" height="18" rx="4" fill={S} />
      {[12, 42, 72, 102].map((x, i) => (
        <rect
          key={x}
          x={x}
          y="37"
          width="18"
          height="6"
          rx="3"
          fill={i === 0 ? A : M}
        />
      ))}
    </Svg>
  ),
  faq_accordion: (
    <Svg>
      {[12, 34, 56].map((y, i) => (
        <g key={y}>
          <rect
            x="10"
            y={y}
            width="100"
            height="16"
            rx="4"
            fill={i === 0 ? M : S}
          />
          <rect
            x="16"
            y={y + 6}
            width="46"
            height="4"
            rx="2"
            fill={i === 0 ? "#fff" : M}
            opacity={i === 0 ? 0.9 : 1}
          />
          <path
            d={`M ${99} ${y + 5} v 6 M ${96} ${y + 8} h 6`}
            stroke={i === 0 ? "#fff" : M}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </g>
      ))}
    </Svg>
  ),
  latest_blogs: (
    <Svg>
      {[8, 46, 84].map((x, i) => (
        <g key={x}>
          <rect x={x} y="14" width="28" height="46" rx="4" fill={S} />
          <rect
            x={x}
            y="14"
            width="28"
            height="20"
            rx="4"
            fill={i === 1 ? A : M}
            opacity={i === 1 ? 0.8 : 1}
          />
          <rect x={x + 4} y="40" width="20" height="4" rx="2" fill={M} />
          <rect x={x + 4} y="48" width="14" height="4" rx="2" fill={M} />
        </g>
      ))}
    </Svg>
  ),
  rich_text: (
    <Svg>
      <rect x="14" y="14" width="56" height="8" rx="3" fill={M} />
      {[30, 39, 48, 57].map((y, i) => (
        <rect
          key={y}
          x="14"
          y={y}
          width={i === 3 ? 60 : 92}
          height="4"
          rx="2"
          fill={S}
        />
      ))}
      <rect x="14" y="30" width="18" height="4" rx="2" fill={A} opacity="0.7" />
    </Svg>
  ),
  custom_code: (
    <Svg>
      <rect x="6" y="10" width="108" height="60" rx="6" fill="#1f2430" />
      <path
        d="M 42 30 l -10 10 l 10 10 M 78 30 l 10 10 l -10 10"
        stroke={A}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M 66 26 l -12 28"
        stroke={M}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </Svg>
  ),
};

export function SectionThumb({ type }: { type: HomepageSectionType }) {
  return <span className="sm-builder-thumb">{THUMBS[type]}</span>;
}

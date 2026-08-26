"use client";

import { useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** One-row theme rail: touch/trackpad scroll stays native, while the two
 * buttons move exactly one card and wrap at either end. */
export function ThemeCatalogCarousel({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const move = (direction: -1 | 1) => {
    const track = trackRef.current;
    if (!track) return;

    const firstCard = track.querySelector<HTMLElement>(".theme-card");
    const styles = window.getComputedStyle(track);
    const gap = Number.parseFloat(styles.columnGap || styles.gap) || 0;
    const cardWidth =
      firstCard?.getBoundingClientRect().width ||
      Math.min(390, Math.max(280, track.clientWidth * 0.86));
    const step = cardWidth + gap;
    const maxLeft = Math.max(0, track.scrollWidth - track.clientWidth);
    const atStart = track.scrollLeft <= 2;
    const atEnd = track.scrollLeft >= maxLeft - 2;
    const nextLeft =
      direction === -1 && atStart
        ? maxLeft
        : direction === 1 && atEnd
          ? 0
          : Math.min(maxLeft, Math.max(0, track.scrollLeft + direction * step));

    track.scrollTo({
      left: nextLeft,
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  };

  return (
    <div className="themes-carousel">
      <div className="themes-carousel-toolbar">
        <p>
          <strong>{count}</strong> {count === 1 ? "theme" : "themes"} · swipe or
          use the arrows
        </p>
        <div className="themes-carousel-controls" aria-label="Browse themes">
          <button
            type="button"
            onClick={() => move(-1)}
            aria-label="Previous theme"
            aria-controls="theme-catalog-track"
          >
            <ChevronLeft size={20} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => move(1)}
            aria-label="Next theme"
            aria-controls="theme-catalog-track"
          >
            <ChevronRight size={20} aria-hidden />
          </button>
        </div>
      </div>
      <div
        className="themes-grid"
        id="theme-catalog-track"
        ref={trackRef}
        role="region"
        tabIndex={0}
        aria-label="Theme collection"
      >
        {children}
      </div>
    </div>
  );
}

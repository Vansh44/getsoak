"use client";

import Image from "next/image";
import { ArrowRight } from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type FocusEvent,
} from "react";

export interface ShowcaseTheme {
  id: string;
  name: string;
  industry: string;
  previewImage: string;
  previewAlt: string;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
  mediaQuery.addEventListener("change", onChange);
  return () => mediaQuery.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot() {
  return window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
}

function getServerReducedMotionSnapshot() {
  return true;
}

function useRotatingIndex(length: number, delay: number, initialIndex = 0) {
  const [activeIndex, setActiveIndex] = useState(
    length > 0 ? initialIndex % length : 0,
  );
  const [interactionPaused, setInteractionPaused] = useState(false);
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getServerReducedMotionSnapshot,
  );

  const showNext = useCallback(() => {
    setActiveIndex((current) => (length > 0 ? (current + 1) % length : 0));
  }, [length]);

  useEffect(() => {
    if (length < 2 || interactionPaused || reducedMotion) return;

    const timer = window.setInterval(() => {
      if (!document.hidden) showNext();
    }, delay);

    return () => window.clearInterval(timer);
  }, [delay, interactionPaused, length, reducedMotion, showNext]);

  return {
    activeIndex,
    setActiveIndex,
    setInteractionPaused,
    showNext,
  };
}

function pauseOnFocus(
  event: FocusEvent<HTMLElement>,
  setPaused: (paused: boolean) => void,
) {
  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
    setPaused(false);
  }
}

export function ThemeHeroStage({ themes }: { themes: ShowcaseTheme[] }) {
  const { activeIndex, setActiveIndex, setInteractionPaused } =
    useRotatingIndex(themes.length, 5200);

  if (themes.length === 0) return null;

  return (
    <div
      className="themes-hero-stage"
      role="group"
      aria-label="Rotating StoreMink theme previews"
      onMouseEnter={() => setInteractionPaused(true)}
      onMouseLeave={() => setInteractionPaused(false)}
      onFocusCapture={() => setInteractionPaused(true)}
      onBlurCapture={(event) => pauseOnFocus(event, setInteractionPaused)}
    >
      {themes.map((theme, index) => {
        const slot = (index - activeIndex + themes.length) % themes.length;
        const isVisible = slot < 3;

        return (
          <figure
            className={`themes-hero-card ${
              isVisible
                ? `themes-hero-card-${slot + 1}`
                : "themes-hero-card-hidden"
            }`}
            aria-hidden={!isVisible}
            key={theme.id}
          >
            <Image
              src={theme.previewImage}
              alt={theme.previewAlt}
              fill
              sizes="(max-width: 900px) 78vw, 38vw"
              loading={index === 0 ? "eager" : "lazy"}
              fetchPriority={index === 0 ? "high" : "auto"}
            />
            <figcaption>
              <span>{theme.name}</span>
              <small>{theme.industry}</small>
            </figcaption>
          </figure>
        );
      })}

      <div className="themes-stage-note">
        <span>{String(themes.length).padStart(2, "0")}</span>
        <p>
          Distinct directions.
          <br />
          Endless ways to make them yours.
        </p>
      </div>

      {themes.length > 1 && (
        <div
          className="themes-stage-controls"
          aria-label="Choose a theme preview"
        >
          {themes.map((theme, index) => (
            <button
              type="button"
              aria-label={`Show ${theme.name} theme`}
              aria-pressed={activeIndex === index}
              key={theme.id}
              onClick={() => setActiveIndex(index)}
            >
              <span>{theme.name}</span>
              <i aria-hidden />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ThemeClosingArt({ themes }: { themes: ShowcaseTheme[] }) {
  const { activeIndex, setInteractionPaused, showNext } = useRotatingIndex(
    themes.length,
    6400,
    1,
  );

  if (themes.length === 0) return null;

  const frontTheme = themes[activeIndex];
  const backTheme = themes[(activeIndex + 1) % themes.length];

  return (
    <div
      className="themes-closing-art"
      role="group"
      aria-label="Rotating StoreMink theme gallery"
      onMouseEnter={() => setInteractionPaused(true)}
      onMouseLeave={() => setInteractionPaused(false)}
      onFocusCapture={() => setInteractionPaused(true)}
      onBlurCapture={(event) => pauseOnFocus(event, setInteractionPaused)}
    >
      {themes.length > 1 && (
        <div
          className="themes-closing-image themes-closing-image-back themes-closing-image-enter"
          key={`${backTheme.id}-back`}
        >
          <Image src={backTheme.previewImage} alt="" fill sizes="420px" />
        </div>
      )}
      <div
        className="themes-closing-image themes-closing-image-front themes-closing-image-enter"
        key={`${frontTheme.id}-front`}
      >
        <Image
          src={frontTheme.previewImage}
          alt={`${frontTheme.name} theme preview`}
          fill
          sizes="460px"
        />
      </div>
      {themes.length > 1 && (
        <button
          type="button"
          className="themes-closing-switcher"
          onClick={showNext}
          aria-label={`Showing ${frontTheme.name}. Show next theme`}
        >
          <span>{frontTheme.name}</span>
          Next theme <ArrowRight size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}

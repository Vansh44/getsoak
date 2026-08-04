"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { VideoConfig } from "@/lib/homepage/section-types";
import { videoEmbedUrl } from "@/lib/homepage/video-embed";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void) {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => undefined;
  }
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function reducedMotionSnapshot() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

export function VideoPlayer({ config }: { config: VideoConfig }) {
  // Render autoplay off on the server. After hydration, enable it only when
  // the visitor has not requested reduced motion. If controls were disabled,
  // reduced-motion visitors still receive a way to start the paused film.
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => true,
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const wasAutoplaying = useRef(false);

  const autoplay = config.autoplay && !reducedMotion;
  const controls = config.controls || reducedMotion;
  const embedUrl = videoEmbedUrl(config.video_url, {
    autoplay,
    loop: config.loop,
    controls,
  });

  useEffect(() => {
    const player = videoRef.current;
    if (!player) return;
    if (!autoplay && wasAutoplaying.current) {
      player.pause();
    } else if (autoplay && !wasAutoplaying.current) {
      try {
        void player.play()?.catch(() => {
          // Browser autoplay policy is allowed to win; controls remain available.
        });
      } catch {
        // Older engines may throw synchronously when autoplay is disallowed.
      }
    }
    wasAutoplaying.current = autoplay;
  }, [autoplay]);

  return (
    <div className={`home-video-player ratio-${config.aspect_ratio}`}>
      {embedUrl ? (
        <iframe
          src={embedUrl}
          title={config.heading || "Store video"}
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          loading="lazy"
          className="home-video-frame"
        />
      ) : (
        <video
          ref={videoRef}
          src={config.video_url}
          poster={config.poster_url || undefined}
          aria-label={config.poster_alt || config.heading || "Store video"}
          autoPlay={autoplay}
          muted={autoplay}
          loop={config.loop}
          controls={controls}
          playsInline
          preload="metadata"
          className="home-video-element"
        />
      )}
    </div>
  );
}

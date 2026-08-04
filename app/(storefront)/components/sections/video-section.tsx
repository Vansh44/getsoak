import type { SectionStyle, VideoConfig } from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";
import { VideoPlayer } from "./video-player";

export function VideoSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: VideoConfig;
}) {
  if (!config.video_url) return null;
  return (
    <SectionShell
      sectionId={sectionId}
      style={style}
      className={config.width === "full" ? "home-video-full" : undefined}
    >
      {(config.eyebrow || config.heading || config.subheading) && (
        <div className="home-section-head">
          {config.eyebrow && (
            <p className="home-section-eyebrow">{config.eyebrow}</p>
          )}
          {config.heading && (
            <h2 className="home-section-title">{config.heading}</h2>
          )}
          {config.subheading && (
            <p className="home-section-sub">{config.subheading}</p>
          )}
        </div>
      )}
      <VideoPlayer config={config} />
    </SectionShell>
  );
}

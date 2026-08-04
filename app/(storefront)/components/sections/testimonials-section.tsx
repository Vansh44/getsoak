import Image from "next/image";
import type {
  SectionStyle,
  TestimonialsConfig,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

export function TestimonialsSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: TestimonialsConfig;
}) {
  if (config.items.length === 0) return null;

  return (
    <SectionShell sectionId={sectionId} style={style}>
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
      <div
        className={`home-testimonials layout-${config.layout} cols-${config.columns}`}
      >
        {config.items.map((item, index) => (
          <blockquote
            className="home-testimonial"
            key={`${item.author}-${index}`}
          >
            {item.logo_url && (
              <span className="home-testimonial-logo">
                <Image
                  src={item.logo_url}
                  alt={item.logo_alt || item.author}
                  fill
                  sizes="180px"
                  className="home-testimonial-logo-image"
                />
              </span>
            )}
            {item.quote && (
              <p className="home-testimonial-quote">{item.quote}</p>
            )}
            {(item.author || item.detail) && (
              <footer className="home-testimonial-attribution">
                {item.author && <cite>{item.author}</cite>}
                {item.detail && <span>{item.detail}</span>}
              </footer>
            )}
          </blockquote>
        ))}
      </div>
    </SectionShell>
  );
}

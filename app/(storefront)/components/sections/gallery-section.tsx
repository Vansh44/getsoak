import Image from "next/image";
import Link from "next/link";
import type {
  GalleryConfig,
  GalleryItem,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

function GalleryCard({
  item,
  index,
  imageRatio,
}: {
  item: GalleryItem;
  index: number;
  imageRatio: GalleryConfig["image_ratio"];
}) {
  const content = (
    <>
      <span className={`home-gallery-media ratio-${imageRatio}`}>
        <Image
          src={item.image_url}
          alt={item.image_alt || item.caption}
          fill
          sizes={
            index === 0
              ? "(max-width: 760px) 100vw, 60vw"
              : "(max-width: 760px) 50vw, 33vw"
          }
          className="home-gallery-image"
        />
      </span>
      {item.caption && (
        <span className="home-gallery-caption">{item.caption}</span>
      )}
    </>
  );
  const className = "home-gallery-card";
  if (/^https?:\/\//i.test(item.href)) {
    return (
      <a
        className={className}
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {content}
      </a>
    );
  }
  if (item.href) {
    return (
      <Link className={className} href={item.href}>
        {content}
      </Link>
    );
  }
  return <div className={className}>{content}</div>;
}

export function GallerySection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: GalleryConfig;
}) {
  const items = config.items.filter((item) => item.image_url);
  if (items.length === 0) return null;

  return (
    <SectionShell sectionId={sectionId} style={style}>
      {(config.heading || config.subheading) && (
        <div className="home-section-head">
          {config.heading && (
            <h2 className="home-section-title">{config.heading}</h2>
          )}
          {config.subheading && (
            <p className="home-section-sub">{config.subheading}</p>
          )}
        </div>
      )}
      <div
        className={`home-gallery layout-${config.layout} cols-${config.columns}`}
      >
        {items.map((item, index) => (
          <GalleryCard
            key={`${item.image_url}-${index}`}
            item={item}
            index={index}
            imageRatio={config.image_ratio}
          />
        ))}
      </div>
    </SectionShell>
  );
}

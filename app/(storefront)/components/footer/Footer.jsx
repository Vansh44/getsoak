/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { STOREMINK_MARK } from "@/lib/brand-assets";
import styles from "./Footer.module.css";
import { useBrand } from "@/app/(storefront)/components/brand-provider";
import { useChrome } from "@/app/(storefront)/components/chrome-provider";
import { useRouter, usePathname } from "next/navigation";
import { NewsletterForm } from "@/app/(storefront)/components/newsletter-form";

// All icons are local inline SVG (mail/phone/clock + the social brand marks
// below) — no external image host. Only the social LINK URLs are per-store
// (from brand.social); a platform with no configured link renders nothing.

function InstagramIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width="20"
      height="20"
      aria-hidden="true"
    >
      <path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 3.68A6.16 6.16 0 1 0 18.16 12 6.16 6.16 0 0 0 12 5.84zm0 10.16A4 4 0 1 1 16 12a4 4 0 0 1-4 4zm6.4-10.4a1.44 1.44 0 1 0 1.44 1.44 1.44 1.44 0 0 0-1.44-1.44z" />
    </svg>
  );
}

function YoutubeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width="20"
      height="20"
      aria-hidden="true"
    >
      <path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.55 15.57V8.43L15.82 12z" />
    </svg>
  );
}

function WhatsappIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width="20"
      height="20"
      aria-hidden="true"
    >
      <path d="M17.5 14.38c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35zM12 2a10 10 0 0 0-8.6 15.06L2 22l5.06-1.33A10 10 0 1 0 12 2z" />
    </svg>
  );
}

export default function Footer() {
  const currentYear = new Date().getFullYear();
  const router = useRouter();
  const pathname = usePathname();
  const brand = useBrand();
  // The footer config the merchant edits in the website builder. `groups` and
  // `legal` are their link columns; the block toggles decide whether the
  // newsletter, contact strip, social row and trust badges render at all.
  //
  // The VALUES for contact/social/badges still come from `brand` — an email
  // address is store identity, not layout — but whether they appear is a
  // website decision and now lives with the rest of the website.
  const { footer: footerCfg } = useChrome();
  const footerGroups = footerCfg.groups;
  const footerLegal = footerCfg.legal;

  // Social links: render only the platforms this store has configured.
  const socialLinks = [
    { name: "Instagram", href: brand.social.instagram, Icon: InstagramIcon },
    { name: "YouTube", href: brand.social.youtube, Icon: YoutubeIcon },
    { name: "WhatsApp", href: brand.social.whatsapp, Icon: WhatsappIcon },
  ].filter((s) => s.href);

  const legalName = brand.legalName || brand.name;
  const creditLine = brand.creditLine || "Powered by StoreMink";

  const handleLogoClick = (e) => {
    e.preventDefault();
    if (pathname === "/") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      router.push("/");
    }
  };

  return (
    <footer className={styles.footer}>
      {/* Newsletter Bar */}
      {footerCfg.newsletter.enabled && (
        <div className={styles.newsletterBar}>
          <div className={styles.newsletterInner}>
            <div className={styles.newsletterText}>
              <span className={styles.newsletterLabel}>
                {footerCfg.newsletter.heading}
              </span>
              <p className={styles.newsletterSub}>
                {footerCfg.newsletter.subtext}
              </p>
            </div>
            <NewsletterForm
              source="footer"
              buttonLabel={footerCfg.newsletter.buttonLabel}
              consentText={footerCfg.newsletter.consentText}
              classes={{
                form: styles.newsletterForm,
                fields: styles.newsletterFields,
                input: styles.newsletterInput,
                button: styles.newsletterBtn,
                consent: styles.newsletterConsent,
                message: styles.newsletterMessage,
              }}
            />
          </div>
        </div>
      )}

      <div className={styles.footerMain}>
        {/* Trust Badges — only when the store has configured any */}
        {footerCfg.badges.enabled && brand.badges.length > 0 && (
          <div className={styles.trustBar}>
            <div className={styles.trustInner}>
              {brand.badges.map((b) => (
                <div key={b.label} className={styles.trustBadge}>
                  <span className={styles.trustIcon}>{b.icon}</span>
                  <span>{b.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Main Grid */}
        <div className={styles.mainGrid}>
          {/* Brand Column */}
          <div className={styles.brandCol}>
            <Link href="/" className={styles.logo} onClick={handleLogoClick}>
              {brand.logoUrl && (
                <img
                  src={brand.logoUrl}
                  alt={`${brand.name} logo`}
                  style={{
                    height: "32px",
                    width: "auto",
                    maxWidth: "160px",
                    objectFit: "contain",
                  }}
                />
              )}
              <span className={styles.brandNameText}>{brand.name}</span>
            </Link>
            {brand.blurb && <p className={styles.tagline}>{brand.blurb}</p>}

            {/* Contact Info */}
            {footerCfg.contact.enabled &&
              (brand.email || brand.phone || brand.hours) && (
                <div className={styles.contactBlock}>
                  {brand.email && (
                    <a
                      href={`mailto:${brand.email}`}
                      className={styles.contactLine}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                        <polyline points="22,6 12,13 2,6" />
                      </svg>
                      {brand.email}
                    </a>
                  )}
                  {brand.phone && (
                    <a
                      href={`tel:${brand.phone.replace(/\s/g, "")}`}
                      className={styles.contactLine}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.13 6.13l.95-.95a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
                      </svg>
                      {brand.phone}
                    </a>
                  )}
                  {brand.hours && (
                    <span className={styles.contactLine}>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      {brand.hours}
                    </span>
                  )}
                </div>
              )}

            {/* Social Links */}
            {footerCfg.social.enabled && socialLinks.length > 0 && (
              <div className={styles.socials}>
                {socialLinks.map((s) => (
                  <a
                    key={s.name}
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.socialIcon}
                    aria-label={s.name}
                  >
                    <s.Icon />
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* Link columns (per-store, from the navigation menu builder) */}
          {footerGroups.map((group, gi) => (
            <div key={`${group.title}|${gi}`} className={styles.linkCol}>
              <h2 className={styles.columnTitle}>{group.title}</h2>
              <nav className={styles.linkList}>
                {group.links.map((link) => (
                  <Link key={`${link.href}|${link.label}`} href={link.href}>
                    {link.label}
                  </Link>
                ))}
              </nav>
            </div>
          ))}
        </div>

        {/* Bottom Row */}
        <div className={styles.bottomSection}>
          <div className={styles.legalRow}>
            <p className={styles.copyright}>
              &copy; {currentYear} {legalName}. All rights reserved.
            </p>
            <div className={styles.legalLinks}>
              {footerLegal.map((link, i) => (
                <span key={`${link.href}|${link.label}`}>
                  {i > 0 && <span className={styles.legalDivider}>·</span>}
                  <Link href={link.href}>{link.label}</Link>
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className={styles.credit}>
          {creditLine === "Powered by StoreMink" ? (
            <>
              <strong>Powered by</strong>
              <img
                src={STOREMINK_MARK}
                alt="StoreMink"
                width={18}
                height={18}
                loading="lazy"
                className={styles.creditLogo}
                aria-hidden="true"
              />
              <strong>StoreMink</strong>
            </>
          ) : (
            <strong>{creditLine}</strong>
          )}
        </div>
      </div>
    </footer>
  );
}

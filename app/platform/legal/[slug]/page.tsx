import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getLegalDocBySlug, LEGAL_DOCS } from "@/lib/legal/documents";
import { getCurrentDoc } from "@/lib/legal/store";
import { sanitizeBlogContent } from "@/lib/sanitize";
import { PLATFORM_URL } from "@/lib/site";
import styles from "../legal.module.css";

// One published policy. Served on the platform host at /legal/{slug} (the proxy
// rewrites into /platform/*).
//
// Deliberately renders the version in the DATABASE, not the content in
// lib/legal/content.ts: once published, the row is immutable and is the exact
// text people have accepted. Editing the source file changes what the NEXT
// version will say, never what this one says.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const def = getLegalDocBySlug(slug);
  if (!def) return { title: "Not found" };
  return {
    title: `${def.title} · StoreMink`,
    description: def.summary,
    alternates: { canonical: `${PLATFORM_URL}/legal/${def.slug}` },
  };
}

export function generateStaticParams() {
  return LEGAL_DOCS.map((d) => ({ slug: d.slug }));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
}

export default async function LegalDocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const def = getLegalDocBySlug(slug);
  if (!def) notFound();

  const doc = await getCurrentDoc(def.kind);

  return (
    <div className={styles.page}>
      <article className={styles.doc}>
        <Link href="/legal" className={styles.back}>
          ← All policies
        </Link>

        <h1 className={styles.title}>{doc?.title ?? def.title}</h1>

        {doc ? (
          <>
            {/* The version and date ARE the point: an acceptance references a
                version, so the reader must be able to see which one this is. */}
            <p className={styles.meta}>
              Version {doc.version} · In effect from{" "}
              {formatDate(doc.effectiveAt)}
            </p>
            <div
              className={styles.body}
              dangerouslySetInnerHTML={{
                __html: sanitizeBlogContent(doc.body),
              }}
            />
          </>
        ) : (
          // Not yet seeded. Say so plainly rather than showing an empty page
          // that looks like the policy is "nothing".
          <p className={styles.meta}>
            This policy hasn&apos;t been published yet. Please check back, or
            write to{" "}
            <a href="mailto:support@storemink.com">support@storemink.com</a>.
          </p>
        )}
      </article>
    </div>
  );
}

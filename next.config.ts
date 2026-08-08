import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone) for the Cloud Run container
  // (GCP migration Phase 4). Copies only the traced node_modules + a minimal
  // server.js, so the runtime image stays small. Ignored by Vercel (which uses
  // its own build adapter), so this is safe to keep on during the transition.
  output: "standalone",
  // The AI copy actions read brand/tasks/*.md at runtime via fs. On serverless
  // hosts (e.g. Vercel) a function only bundles files Next.js traces, and a
  // runtime readFile path isn't traced automatically — so force the brand task
  // prompts into every server trace. Also ensures they land in .next/standalone
  // for the container. Harmless on Node hosts.
  outputFileTracingIncludes: {
    "/**": ["./brand/tasks/**"],
  },
  images: {
    // Serve modern formats — AVIF (~50% smaller than JPEG) with WebP fallback.
    // Next negotiates per request via the Accept header.
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      // Google Cloud Storage (media backend, GCP migration Phase 3).
      {
        protocol: "https",
        hostname: "storage.googleapis.com",
        port: "",
        pathname: "/**",
      },
    ],
    // DEV ONLY: on DNS64/NAT64 networks (common on Indian ISPs) public hosts
    // resolve to 64:ff9b::/96 addresses, which Next 16's image-optimizer SSRF
    // guard classifies as private and blocks — every remote (GCS) image
    // 400s locally. Relax the check in development only; production keeps the
    // full SSRF protection.
    dangerouslyAllowLocalIP: process.env.NODE_ENV === "development",
  },
  experimental: {
    // Tree-shake barrel imports to per-export modules. lucide-react is already
    // optimized by default; these heavy ones are not. (They're also lazily
    // loaded via next/dynamic, so this trims what lands in their split chunks.)
    optimizePackageImports: [
      "recharts",
      "@tiptap/react",
      "@tiptap/starter-kit",
    ],
    // CSV import posts rows to a server action in chunks (CODEBASE §31). The
    // 1 MB default is comfortably enough for the 200-row chunks the importer
    // sends, but a product row carries a full description, so a chunk of long
    // ones can approach it — and the failure mode is an opaque request error
    // mid-import. Raised to leave real headroom; the chunk size, not this, is
    // what actually bounds a request.
    serverActions: { bodySizeLimit: "4mb" },
  },
  // Non-production environments serve `X-Robots-Tag: noindex` on EVERY response.
  //
  // robots.txt was doing this job alone, and it cannot finish it: `Disallow: /`
  // stops Google FETCHING a URL, but a URL that is linked from anywhere can
  // still be indexed without being fetched — it appears in results with no
  // snippet. Worse, the Disallow guarantees Google never sees a `noindex` in the
  // HTML, because it never loads the HTML. An HTTP header is the one signal that
  // survives that, and it covers non-HTML responses (JSON, XML, images) too.
  //
  // Gated on the same SEARCH_INDEXABLE rule as robots.ts / sitemap.ts, derived
  // from the baked NEXT_PUBLIC_ROOT_DOMAIN — so staging, `*.staging`, Cloud Run
  // preview URLs and localhost all get it, production never does, and there is
  // no per-deploy flag anyone can forget. Duplicated here rather than imported
  // because next.config.ts is evaluated outside the app's module graph.
  async headers() {
    const indexable =
      (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "storemink.com").toLowerCase() ===
        "storemink.com" && process.env.NEXT_PUBLIC_NOINDEX !== "1";
    if (indexable) return [];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

export default nextConfig;

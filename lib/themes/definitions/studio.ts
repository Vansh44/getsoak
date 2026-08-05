import { THEME_META } from "../meta";
import type { ThemeDefinition, ThemePreset } from "../types";

// ---------------------------------------------------------------------------
// STUDIO — an editorial home-and-design preset for independent furniture,
// lighting and object shops. Gallery-like spacing, assertive cobalt accents,
// restrained geometry and image-led storytelling distinguish it from Basket.
// ---------------------------------------------------------------------------

const img = (name: string) => `/themes/studio/${name}.webp`;

const preset: ThemePreset = {
  brand: {
    primaryColor: "#2542c7",
    tagline: "Objects with a point of view",
    blurb:
      "A considered collection of furniture, lighting and everyday objects chosen for lasting form, honest materials and useful beauty.",
  },

  design: {
    palette: {
      cream: "#f3f0e8",
      creamDeep: "#e9e4d9",
      surface: "#fffdf7",
      ink: "#171715",
      inkSoft: "#666259",
      inkFaint: "#9d988d",
      taupe: "#d8d0c1",
      sand: "#e6e0d4",
      butter: "#f1c66a",
      border: "#cec7bb",
      tile: "#ece7dc",
      accentWarm: "#ad4e3b",
      onAccent: "#ffffff",
      onInk: "#ffffff",
      shadowRgb: "23, 23, 21",
      success: "#31684b",
      successSoft: "#e3eee7",
      error: "#a43e35",
      errorSoft: "#f5e5e1",
      star: "#ad4e3b",
      highlight: "#ad4e3b",
      accent: "#2542c7",
      accentDeep: "#172c92",
    },
    fonts: {
      body: "var(--font-inter)",
      display: "var(--font-fraunces)",
    },
    shape: {
      card: "2px",
      control: "2px",
      sm: "2px",
      pill: "2px",
    },
    layout: {
      header: "centered",
      headerBackground: "#f3f0e8",
      headerForeground: "#171715",
      card: "framed",
      productDetail: "editorial",
      cart: "compact",
      footer: "minimal",
      storefront: "classic",
    },
  },

  pages: [
    {
      slug: "",
      title: "Home",
      seo_description:
        "Contemporary furniture, lighting and objects selected for useful, lasting homes.",
      sections: [
        {
          id: "hero",
          type: "hero",
          enabled: true,
          config: {
            variant: "minimal",
            heading: "Live with fewer, better things",
            subheading:
              "Independent furniture, lighting and objects with a clear point of view.",
            cta_label: "View the collection",
            cta_href: "/shop",
            image_url: img("hero"),
            video_url: "",
            badge_text: "New collection · Edition 01",
            background: "#f3f0e8",
            theme: "light",
            alignment: "left",
          },
        },
        {
          id: "dispatch",
          type: "ticker",
          enabled: true,
          style: { background: "#2542c7", width: "full", padding_y: "sm" },
          config: {
            messages: [
              "Small-batch design",
              "Complimentary delivery over ₹15,000",
              "Material-led, never trend-led",
            ],
            theme: "light",
            speed: "slow",
          },
        },
        {
          id: "departments",
          type: "shop_by_category",
          enabled: true,
          config: {
            heading: "Shop by room, object or impulse",
            subheading: "An edited collection, not an endless aisle.",
            source: "all",
            category_ids: [],
            layout: "grid",
            display: "cards",
          },
        },
        {
          id: "new-objects",
          type: "featured_products",
          enabled: true,
          config: {
            heading: "New objects",
            subheading: "Fresh forms for thoughtful rooms.",
            source: "featured",
            product_ids: [],
            category_id: null,
            limit: 8,
          },
        },
        {
          id: "material-story",
          type: "media_text",
          enabled: true,
          style: { background: "#dfe4ff", width: "full", padding_y: "lg" },
          config: {
            eyebrow: "The material edit",
            heading: "Texture before trend",
            body: "Boucle that wears in, not out. Clay that keeps the maker's hand visible. Timber and steel chosen for structure, not decoration. We select pieces that become more personal with use.",
            cta_label: "Read our approach",
            cta_href: "/our-approach",
            image_url: img("vase"),
            image_alt:
              "Speckled hand-thrown stoneware vase on a warm studio backdrop",
            media_position: "right",
            media_ratio: "portrait",
            alignment: "left",
          },
        },
        {
          id: "lookbook",
          type: "gallery",
          enabled: true,
          config: {
            heading: "The Studio edit",
            subheading:
              "Strong silhouettes, quiet materials, one electric blue.",
            layout: "editorial",
            columns: 4,
            image_ratio: "portrait",
            items: [
              {
                image_url: img("chair"),
                image_alt: "Cobalt upholstered lounge chair",
                caption: "The Cobalt Chair",
                href: "/shop",
              },
              {
                image_url: img("lamp"),
                image_alt: "Terracotta ceramic table lamp with linen shade",
                caption: "Earth Table Lamp",
                href: "/shop",
              },
              {
                image_url: img("side-table"),
                image_alt: "Sculptural near-black side table",
                caption: "Arc Side Table",
                href: "/shop",
              },
              {
                image_url: img("art-print"),
                image_alt: "Framed cobalt and terracotta geometric art print",
                caption: "Form No. 03",
                href: "/shop",
              },
            ],
          },
        },
        {
          id: "principles",
          type: "testimonials",
          enabled: true,
          config: {
            eyebrow: "Our curation principles",
            heading: "Every object earns its place",
            subheading:
              "Three questions guide every addition to the collection.",
            layout: "editorial",
            columns: 3,
            items: [
              {
                quote: "Does the form remain compelling when the trend passes?",
                author: "01 · Form",
                detail: "A silhouette with staying power",
                logo_url: "",
                logo_alt: "",
              },
              {
                quote: "Will the material grow richer through touch and time?",
                author: "02 · Material",
                detail: "Honest surfaces and visible craft",
                logo_url: "",
                logo_alt: "",
              },
              {
                quote:
                  "Does it make an everyday ritual simpler or more joyful?",
                author: "03 · Use",
                detail: "Beauty with a job to do",
                logo_url: "",
                logo_alt: "",
              },
            ],
          },
        },
        {
          id: "newsletter",
          type: "newsletter",
          enabled: true,
          style: { background: "#ad4e3b", width: "full", padding_y: "lg" },
          config: {
            eyebrow: "Studio letters",
            heading: "A considered note, occasionally",
            subheading:
              "New editions, material stories and rooms worth saving.",
            button_label: "Join the list",
            success_message: "You're in the Studio notebook — welcome.",
            consent_text:
              "I agree to receive Studio product news and editorial emails.",
            theme: "dark",
            alignment: "center",
          },
        },
      ],
    },
    {
      slug: "our-approach",
      title: "Our Approach",
      seo_description:
        "How Studio selects independent furniture, lighting and objects for lasting homes.",
      sections: [
        {
          id: "approach-intro",
          type: "media_text",
          enabled: true,
          config: {
            eyebrow: "Inside Studio",
            heading: "A shop shaped like an exhibition",
            body: "We work with small workshops and independent makers, then edit deliberately. Every release balances an expressive focal point with quieter pieces that leave a room space to breathe.",
            cta_label: "Shop the latest edit",
            cta_href: "/shop",
            image_url: img("hero"),
            image_alt:
              "Gallery-like interior with cobalt chair and sculptural objects",
            media_position: "left",
            media_ratio: "landscape",
            alignment: "left",
          },
        },
        {
          id: "approach-copy",
          type: "rich_text",
          enabled: true,
          config: {
            html: "<h2>Buy slowly. Keep for longer.</h2><p>We favour repairable construction, tactile natural materials and forms that can move between rooms and uses. Limited editions are disclosed clearly; core pieces return because good design should remain available beyond a season.</p><h3>Independent by design</h3><p>Our collection brings together small studios rather than one house style. The common thread is clarity: a strong idea, resolved proportions and materials that do not pretend to be something else.</p>",
            width: "contained",
          },
        },
        {
          id: "approach-values",
          type: "usp_bar",
          enabled: true,
          style: { background: "#2542c7", width: "full", padding_y: "md" },
          config: {
            theme: "light",
            items: [
              { icon: "sparkles", title: "Edited", subtitle: "Never endless" },
              {
                icon: "badge-check",
                title: "Vetted",
                subtitle: "Material first",
              },
              {
                icon: "refresh",
                title: "Repairable",
                subtitle: "Made to stay",
              },
              {
                icon: "truck",
                title: "Delivered",
                subtitle: "Handled with care",
              },
            ],
          },
        },
      ],
    },
    {
      slug: "care-guide",
      title: "Care Guide",
      seo_description:
        "Simple care guidance for Studio textiles, ceramics, timber and upholstered pieces.",
      sections: [
        {
          id: "care",
          type: "faq_accordion",
          enabled: true,
          config: {
            heading: "Care, without complication",
            subheading:
              "A few useful habits keep honest materials looking their best.",
            show_filters: true,
            items: [
              {
                question: "How should I clean upholstered furniture?",
                answer:
                  "Vacuum gently with an upholstery attachment and blot spills immediately with a clean undyed cloth. Test any cleaner on a hidden area first.",
                category: "Textiles",
              },
              {
                question: "Can stoneware go in the dishwasher?",
                answer:
                  "Our glazed stoneware is dishwasher safe, though hand washing reduces thermal stress and helps handmade finishes stay vivid for longer.",
                category: "Ceramics",
              },
              {
                question: "How do I protect timber surfaces?",
                answer:
                  "Use coasters, wipe moisture promptly and avoid direct heat. A soft dry cloth is enough for regular dusting.",
                category: "Furniture",
              },
              {
                question: "Will handmade finishes vary?",
                answer:
                  "Yes. Small shifts in glaze, grain and texture are part of the process and make each object individual rather than defective.",
                category: "Ceramics",
              },
            ],
          },
        },
      ],
    },
  ],

  menus: {
    header: [
      { label: "New Objects", href: "/shop" },
      { label: "Our Approach", href: "/our-approach" },
      { label: "Care Guide", href: "/care-guide" },
      { label: "Journal", href: "/blogs" },
    ],
    footerGroups: [
      {
        title: "Collection",
        links: [
          { label: "All Objects", href: "/shop" },
          { label: "New Objects", href: "/shop" },
        ],
      },
      {
        title: "Studio",
        links: [
          { label: "Our Approach", href: "/our-approach" },
          { label: "Journal", href: "/blogs" },
        ],
      },
      {
        title: "Service",
        links: [
          { label: "Care Guide", href: "/care-guide" },
          { label: "Enquiries", href: "/enquiries" },
        ],
      },
    ],
    footerLegal: [],
  },

  sampleData: {
    categories: [
      {
        name: "Seating",
        slug: "seating",
        description: "Expressive chairs and stools for slow rooms.",
        image_url: img("chair"),
        sort_order: 0,
      },
      {
        name: "Lighting",
        slug: "lighting",
        description: "Sculptural light for tables, corners and evenings.",
        image_url: img("lamp"),
        sort_order: 1,
      },
      {
        name: "Objects",
        slug: "objects",
        description: "Useful forms in clay, stone and metal.",
        image_url: img("vase"),
        sort_order: 2,
      },
      {
        name: "Textiles & Art",
        slug: "textiles-art",
        description: "Colour, warmth and graphic rhythm for the room.",
        image_url: img("throw"),
        sort_order: 3,
      },
    ],
    products: [
      {
        name: "Cobalt Lounge Chair",
        slug: "cobalt-lounge-chair",
        description:
          "A low, enveloping lounge chair upholstered in dense cobalt weave, with solid walnut feet and a generously sprung seat.",
        category_slug: "seating",
        base_price: 48900,
        selling_price: 44900,
        image_url: img("chair"),
        images: [img("chair"), img("hero")],
        featured: true,
        sort_order: 0,
        card_color: "#e7e2d7",
        variants: [
          { name: "Cobalt", base_price: 48900, selling_price: 44900, stock: 6 },
          { name: "Bone", base_price: 48900, selling_price: 44900, stock: 4 },
        ],
      },
      {
        name: "Earth Table Lamp",
        slug: "earth-table-lamp",
        description:
          "A hand-finished terracotta base paired with a softly textured linen shade for warm, diffused light.",
        category_slug: "lighting",
        base_price: 12900,
        selling_price: 11600,
        image_url: img("lamp"),
        featured: true,
        sort_order: 1,
        card_color: "#eee7dc",
      },
      {
        name: "Contour Bookends",
        slug: "contour-bookends",
        description:
          "Two weighty cast-stone forms that hold a shelf together while leaving a strong graphic silhouette.",
        category_slug: "objects",
        base_price: 5200,
        selling_price: 4600,
        image_url: img("bookends"),
        featured: true,
        sort_order: 2,
        card_color: "#ece7dc",
      },
      {
        name: "Field Stoneware Vase",
        slug: "field-stoneware-vase",
        description:
          "A rounded, wheel-thrown vase with a speckled glaze that shifts subtly from piece to piece.",
        category_slug: "objects",
        base_price: 6800,
        selling_price: 6100,
        image_url: img("vase"),
        featured: true,
        sort_order: 3,
        card_color: "#ebe5d9",
      },
      {
        name: "Arc Side Table",
        slug: "arc-side-table",
        description:
          "A slim steel side table with a curved folded base and raised tray top, finished in soft near-black.",
        category_slug: "seating",
        base_price: 18900,
        selling_price: 17200,
        image_url: img("side-table"),
        featured: true,
        sort_order: 4,
        card_color: "#e8e3d8",
      },
      {
        name: "Grid Wool Throw",
        slug: "grid-wool-throw",
        description:
          "A weighty woven throw in cobalt and undyed ivory wool, finished with hand-knotted fringe.",
        category_slug: "textiles-art",
        base_price: 8900,
        selling_price: 7900,
        image_url: img("throw"),
        featured: true,
        sort_order: 5,
        card_color: "#e9e4d9",
      },
      {
        name: "Form No. 03 Art Print",
        slug: "form-no-03-art-print",
        description:
          "A museum-grade geometric print balancing cobalt, rust and black, supplied in a dark walnut frame.",
        category_slug: "textiles-art",
        base_price: 7400,
        selling_price: 6600,
        image_url: img("art-print"),
        featured: false,
        sort_order: 6,
        card_color: "#ece7dc",
        variants: [
          { name: "A3", base_price: 7400, selling_price: 6600, stock: 14 },
          { name: "A2", base_price: 9800, selling_price: 8800, stock: 8 },
        ],
      },
      {
        name: "Mesa Serving Bowl",
        slug: "mesa-serving-bowl",
        description:
          "A broad low bowl in iron-rich terracotta clay, suited to shared salads, fruit or a quiet tabletop centrepiece.",
        category_slug: "objects",
        base_price: 4900,
        selling_price: 4400,
        image_url: img("serving-bowl"),
        featured: false,
        sort_order: 7,
        card_color: "#eee6da",
      },
    ],
  },
};

export const studio: ThemeDefinition = {
  ...THEME_META.find((theme) => theme.id === "studio")!,
  preset,
};

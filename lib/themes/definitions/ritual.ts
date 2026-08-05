import { THEME_META } from "../meta";
import type { ThemeDefinition, ThemePreset } from "../types";

// RITUAL — a sensorial editorial preset for botanical skincare, body care and
// slow-wellness stores. Plum, dusty rose and botanical green replace generic
// clinical beauty cues; product routines shape discovery and storytelling.

const img = (name: string) => `/themes/ritual/${name}.webp`;

const preset: ThemePreset = {
  brand: {
    primaryColor: "#5b1735",
    tagline: "Care, returned to ritual",
    blurb:
      "Botanical skin, body and home formulas designed for slower mornings, quieter evenings and the useful pause between them.",
  },
  design: {
    palette: {
      cream: "#f3dfda",
      creamDeep: "#e9cbc5",
      surface: "#fff8f3",
      ink: "#321421",
      inkSoft: "#72515b",
      inkFaint: "#a47d85",
      taupe: "#d8b3ad",
      sand: "#ead1cb",
      butter: "#dfe6a0",
      border: "#d8b8b2",
      tile: "#e7c8c2",
      accentWarm: "#bd6d4e",
      onAccent: "#fff8f3",
      onInk: "#fff8f3",
      shadowRgb: "50, 20, 33",
      success: "#55704a",
      successSoft: "#e2ead8",
      error: "#a33f4f",
      errorSoft: "#f5dde0",
      star: "#bd6d4e",
      highlight: "#dfe6a0",
      accent: "#5b1735",
      accentDeep: "#3c0d24",
    },
    fonts: {
      body: "var(--font-inter)",
      display: "var(--font-fraunces)",
    },
    shape: {
      card: "22px",
      control: "999px",
      sm: "12px",
      pill: "999px",
    },
    layout: {
      header: "minimal",
      headerBackground: "#f3dfda",
      headerForeground: "#321421",
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
        "Botanical skincare, body care and home rituals for slower daily moments.",
      sections: [
        {
          id: "hero",
          type: "hero",
          enabled: true,
          config: {
            variant: "banner",
            heading: "Make time feel like yours again",
            subheading:
              "Botanical care for skin, body and the rooms where you exhale.",
            cta_label: "Begin your ritual",
            cta_href: "/shop",
            image_url: img("hero"),
            video_url: "",
            badge_text: "Formulated for the everyday pause",
            background: "#d69c94",
            theme: "light",
            alignment: "left",
          },
        },
        {
          id: "promises",
          type: "usp_bar",
          enabled: true,
          style: { background: "#5b1735", width: "full", padding_y: "sm" },
          config: {
            theme: "light",
            items: [
              {
                icon: "leaf",
                title: "Botanical",
                subtitle: "Purposeful formulas",
              },
              {
                icon: "sparkles",
                title: "Sensorial",
                subtitle: "Texture matters",
              },
              {
                icon: "badge-check",
                title: "Considered",
                subtitle: "Nothing extra",
              },
              {
                icon: "refresh",
                title: "Refill-minded",
                subtitle: "Less waste",
              },
            ],
          },
        },
        {
          id: "rituals",
          type: "shop_by_category",
          enabled: true,
          config: {
            heading: "Choose your ritual",
            subheading: "Start with the moment you want to change.",
            source: "all",
            category_ids: [],
            layout: "grid",
            display: "cards",
          },
        },
        {
          id: "daily-care",
          type: "featured_products",
          enabled: true,
          config: {
            heading: "Daily care, quietly effective",
            subheading: "Eight objects for a slower rhythm.",
            source: "featured",
            product_ids: [],
            category_id: null,
            limit: 8,
          },
        },
        {
          id: "evening-story",
          type: "media_text",
          enabled: true,
          style: { background: "#dfe6a0", width: "full", padding_y: "lg" },
          config: {
            eyebrow: "The evening reset",
            heading: "Three minutes. Warm water. One deep breath.",
            body: "Ritual is not about adding more steps. It is about making the steps already in your day feel deliberate—cleanse slowly, press in oil, let scent mark the shift from doing to resting.",
            cta_label: "Read our philosophy",
            cta_href: "/our-ritual",
            image_url: img("serum"),
            image_alt:
              "Deep plum botanical serum bottle on a dusty rose backdrop",
            media_position: "left",
            media_ratio: "portrait",
            alignment: "left",
          },
        },
        {
          id: "shelf",
          type: "gallery",
          enabled: true,
          config: {
            heading: "On the shelf",
            subheading:
              "Tactile formulas and useful objects, made to stay visible.",
            layout: "editorial",
            columns: 4,
            image_ratio: "portrait",
            items: [
              {
                image_url: img("cleanser"),
                image_alt: "Amber botanical cleanser bottle",
                caption: "Dawn Cleanser",
                href: "/shop",
              },
              {
                image_url: img("body-oil"),
                image_alt: "Amber botanical body oil bottle",
                caption: "Afterlight Body Oil",
                href: "/shop",
              },
              {
                image_url: img("candle"),
                image_alt: "Plum fluted ceramic candle",
                caption: "Quiet Hour Candle",
                href: "/shop",
              },
              {
                image_url: img("massage-stone"),
                image_alt: "Pale green facial massage stone",
                caption: "Meadow Massage Stone",
                href: "/shop",
              },
            ],
          },
        },
        {
          id: "notes",
          type: "testimonials",
          enabled: true,
          config: {
            eyebrow: "Ritual notes",
            heading: "A routine you can return to",
            subheading:
              "Not promises of perfection—small cues for consistent care.",
            layout: "cards",
            columns: 3,
            items: [
              {
                quote:
                  "Begin with touch: warm the formula between your hands before it meets the skin.",
                author: "Morning",
                detail: "Wake gently",
                logo_url: "",
                logo_alt: "",
              },
              {
                quote:
                  "Let one scent become the boundary between the working day and your own time.",
                author: "Evening",
                detail: "Mark the transition",
                logo_url: "",
                logo_alt: "",
              },
              {
                quote:
                  "Consistency can be soft. A short ritual repeated is enough.",
                author: "Always",
                detail: "Keep it possible",
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
          style: { background: "#5b1735", width: "full", padding_y: "lg" },
          config: {
            eyebrow: "The quiet letter",
            heading: "Care notes for slower days",
            subheading:
              "New formulas, ingredient stories and rituals worth keeping.",
            button_label: "Receive the letter",
            success_message: "You're on the Ritual list — welcome.",
            consent_text:
              "I agree to receive Ritual product news and care emails.",
            theme: "light",
            alignment: "center",
          },
        },
      ],
    },
    {
      slug: "our-ritual",
      title: "Our Ritual",
      seo_description:
        "The principles behind Ritual botanical skin, body and home care.",
      sections: [
        {
          id: "philosophy",
          type: "media_text",
          enabled: true,
          config: {
            eyebrow: "Why Ritual",
            heading: "Care should create space, not pressure",
            body: "We formulate around familiar daily moments rather than complicated routines. Every texture, scent and vessel is considered together so the product is effective, intuitive and a pleasure to reach for.",
            cta_label: "Explore the collection",
            cta_href: "/shop",
            image_url: img("hero"),
            image_alt: "Botanical skincare ritual beside a plum stone basin",
            media_position: "right",
            media_ratio: "landscape",
            alignment: "left",
          },
        },
        {
          id: "principles",
          type: "rich_text",
          enabled: true,
          config: {
            html: "<h2>Fewer formulas, clearer purpose</h2><p>Each product begins with the job it needs to do and the moment it belongs to. We favour recognizable botanical oils, mineral-rich clays and comforting textures, then explain how to use them in plain language.</p><h3>Made for real routines</h3><p>Our care is designed to work on hurried mornings as well as unhurried Sundays. There is no perfect sequence and no guilt for missing a day.</p>",
            width: "contained",
          },
        },
      ],
    },
    {
      slug: "care-notes",
      title: "Care Notes",
      seo_description:
        "Straightforward guidance for using and storing Ritual skincare and body-care products.",
      sections: [
        {
          id: "care-faq",
          type: "faq_accordion",
          enabled: true,
          config: {
            heading: "Care notes",
            subheading:
              "Simple answers for keeping your ritual useful and fresh.",
            show_filters: true,
            items: [
              {
                question: "How should I introduce a new facial formula?",
                answer:
                  "Patch test first, then add one new product at a time. Begin every other day so you can notice how your skin responds.",
                category: "Skin",
              },
              {
                question: "Where should I store botanical oils?",
                answer:
                  "Keep them upright, tightly closed and away from direct sun or heat. A cool cabinet is better than a bright bathroom shelf.",
                category: "Storage",
              },
              {
                question: "How do I use the massage stone?",
                answer:
                  "Apply a small amount of facial oil, then glide the stone gently from the centre of the face outward. Pressure should always feel comfortable.",
                category: "Tools",
              },
              {
                question: "Can I reuse the candle vessel?",
                answer:
                  "Yes. Once finished, remove the wick base, wash with warm soapy water and reuse the ceramic vessel for small objects.",
                category: "Home",
              },
            ],
          },
        },
      ],
    },
  ],
  menus: {
    header: [
      { label: "Shop Rituals", href: "/shop" },
      { label: "Our Ritual", href: "/our-ritual" },
      { label: "Care Notes", href: "/care-notes" },
      { label: "Journal", href: "/blogs" },
    ],
    footerGroups: [
      {
        title: "Rituals",
        links: [
          { label: "All Care", href: "/shop" },
          { label: "Daily Essentials", href: "/shop" },
        ],
      },
      {
        title: "About",
        links: [
          { label: "Our Ritual", href: "/our-ritual" },
          { label: "Journal", href: "/blogs" },
        ],
      },
      {
        title: "Help",
        links: [
          { label: "Care Notes", href: "/care-notes" },
          { label: "Enquiries", href: "/enquiries" },
        ],
      },
    ],
    footerLegal: [],
  },
  sampleData: {
    categories: [
      {
        name: "Face",
        slug: "face",
        description: "Gentle daily formulas for cleansing, hydration and care.",
        image_url: img("serum"),
        sort_order: 0,
      },
      {
        name: "Body",
        slug: "body",
        description: "Tactile oils and bathing care for unhurried skin.",
        image_url: img("body-oil"),
        sort_order: 1,
      },
      {
        name: "Home",
        slug: "home",
        description: "Scent and atmosphere for the rooms where you rest.",
        image_url: img("candle"),
        sort_order: 2,
      },
      {
        name: "Tools",
        slug: "tools",
        description: "Simple companions for touch, massage and recovery.",
        image_url: img("massage-stone"),
        sort_order: 3,
      },
    ],
    products: [
      {
        name: "Dawn Botanical Cleanser",
        slug: "dawn-botanical-cleanser",
        description:
          "A low-foam botanical cleanser with oat, calendula and glycerin for a comfortable morning rinse.",
        category_slug: "face",
        base_price: 1650,
        selling_price: 1480,
        image_url: img("cleanser"),
        images: [img("cleanser"), img("hero")],
        featured: true,
        sort_order: 0,
        card_color: "#e3c0ba",
        variants: [
          { name: "100 ml", base_price: 1650, selling_price: 1480, stock: 30 },
          { name: "200 ml", base_price: 2650, selling_price: 2380, stock: 18 },
        ],
      },
      {
        name: "Stillwater Facial Serum",
        slug: "stillwater-facial-serum",
        description:
          "A silky hydration serum with tremella, beta-glucan and panthenol that layers without heaviness.",
        category_slug: "face",
        base_price: 2450,
        selling_price: 2190,
        image_url: img("serum"),
        featured: true,
        sort_order: 1,
        card_color: "#dfbbb6",
      },
      {
        name: "Cloud Barrier Cream",
        slug: "cloud-barrier-cream",
        description:
          "A cushiony moisturizer with squalane and oat lipids for soft, supported skin day or night.",
        category_slug: "face",
        base_price: 2250,
        selling_price: 1990,
        image_url: img("moisturizer"),
        featured: true,
        sort_order: 2,
        card_color: "#e8cbc5",
      },
      {
        name: "Afterlight Body Oil",
        slug: "afterlight-body-oil",
        description:
          "A fast-settling blend of sesame, apricot and jojoba oils with a quiet woody botanical scent.",
        category_slug: "body",
        base_price: 1950,
        selling_price: 1750,
        image_url: img("body-oil"),
        featured: true,
        sort_order: 3,
        card_color: "#dfbbb5",
      },
      {
        name: "Quiet Hour Candle",
        slug: "quiet-hour-candle",
        description:
          "A coconut-wax candle with cedar leaf, dry rose and warm resin in a reusable fluted ceramic vessel.",
        category_slug: "home",
        base_price: 2100,
        selling_price: 1890,
        image_url: img("candle"),
        featured: true,
        sort_order: 4,
        card_color: "#ddb7b2",
      },
      {
        name: "Meadow Massage Stone",
        slug: "meadow-massage-stone",
        description:
          "A smooth pale-green stone shaped for comfortable facial and neck massage with rounded edges.",
        category_slug: "tools",
        base_price: 1350,
        selling_price: 1190,
        image_url: img("massage-stone"),
        featured: true,
        sort_order: 5,
        card_color: "#dfe1bd",
      },
      {
        name: "Mineral Evening Soak",
        slug: "mineral-evening-soak",
        description:
          "Magnesium-rich bath salts with ground oat and a restrained lavender and vetiver aroma.",
        category_slug: "body",
        base_price: 1450,
        selling_price: 1290,
        image_url: img("bath-soak"),
        featured: false,
        sort_order: 6,
        card_color: "#e9d0ca",
        variants: [
          { name: "250 g", base_price: 1450, selling_price: 1290, stock: 24 },
          { name: "500 g", base_price: 2350, selling_price: 2090, stock: 14 },
        ],
      },
      {
        name: "Soft Earth Botanical Scent",
        slug: "soft-earth-botanical-scent",
        description:
          "A close-wearing botanical perfume with green stem, orris, cedar and a soft mineral finish.",
        category_slug: "home",
        base_price: 3200,
        selling_price: 2890,
        image_url: img("perfume"),
        featured: false,
        sort_order: 7,
        card_color: "#dfbbb6",
      },
    ],
  },
};

export const ritual: ThemeDefinition = {
  ...THEME_META.find((theme) => theme.id === "ritual")!,
  preset,
};

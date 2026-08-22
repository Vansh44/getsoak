import { THEME_META } from "../meta";
import type { ThemeDefinition, ThemePreset } from "../types";

// ---------------------------------------------------------------------------
// VITRINE — a fashion preset for footwear, bags and accessories shops.
//
// A "vitrine" is a shop window, which is what the preset builds: square
// photographs held in a 1px grid. Where Studio is warm, editorial and
// image-led, Vitrine is monochrome and typographic — zero corner radius
// everywhere, hairline rules instead of cards, a geometric sans (Jost) doing
// almost all the work, and exactly one hue reserved for markdown.
//
// Registered but NOT yet catalog-visible: `catalog.visibility` is "hidden" and
// `release.status` is "draft" until demo-vitrine is seeded and the scored
// design/accessibility pass in docs/theme-acceptance.md is done. themes.test.ts
// enforces that pairing (public => published + a healthy demo), so flip all
// three together, never one at a time.
//
// Imagery is bundled under public/themes/vitrine/ and is rebuilt from three
// authored sources with `node scripts/build-theme-assets.mjs --theme vitrine`;
// provenance and the source prompts are in docs/theme-assets.md.
// ---------------------------------------------------------------------------

const img = (name: string) => `/themes/vitrine/${name}.webp`;

const preset: ThemePreset = {
  brand: {
    primaryColor: "#2a211f",
    tagline: "Shoes, bags and the season's edit",
    blurb:
      "A seasonal edit of footwear, bags and accessories — clean silhouettes, wearable heel heights and materials chosen to age well rather than photograph well.",
  },

  design: {
    palette: {
      cream: "#fbfaf8",
      creamDeep: "#f1eeea",
      surface: "#ffffff",
      ink: "#2a211f",
      inkSoft: "#6e635e",
      inkFaint: "#9c928b",
      taupe: "#e4ded6",
      sand: "#efebe6",
      butter: "#e8dcc8",
      border: "#ddd6cf",
      tile: "#efebe6",
      accentWarm: "#8c6f63",
      onAccent: "#ffffff",
      onInk: "#ffffff",
      shadowRgb: "42, 33, 31",
      success: "#2f6b4f",
      successSoft: "#e6f0ea",
      error: "#b80f27",
      errorSoft: "#faebee",
      star: "#2a211f",
      highlight: "#b80f27",
      // `accent` is deliberately OMITTED so --brand-primary (the merchant's own
      // colour, seeded above as the warm ink) drives every CTA. Setting it here
      // would reproduce the source reference exactly and override a merchant's
      // brand colour on every button in their store.
    },
    fonts: {
      body: "var(--font-jost)",
      display: "var(--font-instrument-serif)",
    },
    // Zero, not "small". Every corner in this preset is square: cards, chips,
    // swatches, inputs and buttons alike.
    shape: {
      card: "0px",
      control: "0px",
      sm: "0px",
      pill: "0px",
    },
    layout: {
      header: "minimal",
      card: "classic",
      // The one piece of motion in the whole preset: cards cross-fade to the
      // product's second photograph on hover, which is what makes a grid of
      // shoes read as a fashion grid rather than a catalogue.
      cardHoverImage: true,
      productDetail: "editorial",
      cart: "compact",
      footer: "rich",
      storefront: "classic",
    },
  },

  pages: [
    {
      slug: "",
      title: "Home",
      seo_description:
        "Footwear, handbags and accessories in clean silhouettes — a seasonal edit built to be worn, not just photographed.",
      sections: [
        {
          id: "announce",
          type: "ticker",
          enabled: true,
          style: { background: "#2a211f", width: "full", padding_y: "sm" },
          config: {
            messages: [
              "Complimentary delivery over ₹2,999",
              "Free 14-day exchanges",
              "New season — now in store",
            ],
            theme: "light",
            speed: "slow",
          },
        },
        {
          id: "hero",
          type: "hero_carousel",
          enabled: true,
          config: {
            slides: [
              {
                heading: "The new season, in full",
                subheading:
                  "Low-tops, block heels and structured bags for the months ahead.",
                cta_label: "Shop new in",
                cta_href: "/shop",
                image_url: img("hero"),
                video_url: "",
                background: "#efebe6",
                theme: "dark",
              },
              {
                heading: "Built for the long walk home",
                subheading:
                  "Cushioned footbeds and stacked heels under 60mm, in every core shape.",
                cta_label: "Shop footwear",
                cta_href: "/shop",
                image_url: img("boot"),
                video_url: "",
                background: "#e4ded6",
                theme: "dark",
              },
            ],
            autoplay: true,
            interval_seconds: 6,
          },
        },
        {
          id: "departments",
          type: "shop_by_category",
          enabled: true,
          config: {
            heading: "Shop by category",
            subheading: "Four rooms, one wardrobe.",
            source: "all",
            category_ids: [],
            layout: "grid",
            display: "cards",
          },
        },
        {
          id: "new-in",
          type: "featured_products",
          enabled: true,
          config: {
            heading: "New in",
            subheading: "This week's arrivals, before they move.",
            source: "featured",
            product_ids: [],
            category_id: null,
            limit: 8,
          },
        },
        // Three interchangeable editorial splits. Alternating media_position is
        // the whole pattern: a merchant re-merchandises each slot every season
        // without touching layout.
        {
          id: "edit-comfort",
          type: "media_text",
          enabled: true,
          config: {
            eyebrow: "The comfort edit",
            heading: "Padded where it matters",
            body: "Dual-density footbeds, leather linings and a heel height you can actually stand in. The shoes we return to are the ones that stop asking for attention by four o'clock.",
            cta_label: "Shop the comfort edit",
            cta_href: "/shop",
            image_url: img("sneaker"),
            image_alt: "White leather low-top sneaker on a pale grey backdrop",
            media_position: "left",
            media_ratio: "landscape",
            alignment: "left",
          },
        },
        {
          id: "edit-occasion",
          type: "media_text",
          enabled: true,
          style: { background: "#f1eeea", width: "full", padding_y: "lg" },
          config: {
            eyebrow: "Occasion",
            heading: "For the evening it turns into",
            body: "A block heel that carries a dinner, a clutch that holds more than it looks like it should, and finishes that read well under low light.",
            cta_label: "Shop occasion",
            cta_href: "/shop",
            image_url: img("heel"),
            image_alt: "Black suede block-heel sandal photographed side-on",
            media_position: "right",
            media_ratio: "landscape",
            alignment: "left",
          },
        },
        {
          id: "edit-carry",
          type: "media_text",
          enabled: true,
          config: {
            eyebrow: "Carry",
            heading: "Structure that holds its shape",
            body: "Bags cut from firm-grain leather with a base that stays flat when you set it down. Built around a laptop, a paperback and the things you actually carry.",
            cta_label: "Shop handbags",
            cta_href: "/shop?category=handbags",
            image_url: img("tote"),
            image_alt: "Structured tan leather tote bag standing upright",
            media_position: "left",
            media_ratio: "landscape",
            alignment: "left",
          },
        },
        {
          id: "price-points",
          type: "tile_grid",
          enabled: true,
          config: {
            heading: "Shop by price",
            subheading: "Good shoes at every level.",
            columns: 3,
            height: "md",
            tiles: [
              {
                title: "Under ₹2,999",
                subtitle: "Accessories & belts",
                href: "/shop",
                image_url: "",
                background: "#efebe6",
                theme: "dark",
              },
              {
                title: "Under ₹4,999",
                subtitle: "Everyday footwear",
                href: "/shop",
                image_url: "",
                background: "#e4ded6",
                theme: "dark",
              },
              {
                title: "Under ₹8,999",
                subtitle: "Leather & occasion",
                href: "/shop",
                image_url: "",
                background: "#2a211f",
                theme: "light",
              },
            ],
          },
        },
        {
          id: "worn-by",
          type: "gallery",
          enabled: true,
          config: {
            heading: "Worn in",
            subheading: "The edit, out in the world.",
            layout: "editorial",
            columns: 4,
            image_ratio: "portrait",
            items: [
              {
                image_url: img("loafer"),
                image_alt: "Brown leather penny loafer worn with cropped denim",
                caption: "Marlowe Loafer",
                href: "/shop/marlowe-leather-loafer",
              },
              {
                image_url: img("crossbody"),
                image_alt: "Quilted black crossbody bag worn over the shoulder",
                caption: "Nyla Crossbody",
                href: "/shop/nyla-quilted-crossbody",
              },
              {
                image_url: img("boot"),
                image_alt: "Black leather ankle boot with a stacked heel",
                caption: "Rowan Boot",
                href: "/shop/rowan-ankle-boot",
              },
              {
                image_url: img("sunglasses"),
                image_alt:
                  "Angular tortoiseshell sunglasses on a stone surface",
                caption: "Halden Sunglasses",
                href: "/shop/halden-angular-sunglasses",
              },
            ],
          },
        },
        {
          id: "service",
          type: "usp_bar",
          enabled: true,
          style: { background: "#2a211f", width: "full", padding_y: "md" },
          config: {
            theme: "light",
            items: [
              {
                icon: "truck",
                title: "Free delivery",
                subtitle: "On orders over ₹2,999",
              },
              {
                icon: "refresh",
                title: "14-day exchanges",
                subtitle: "Sizes swapped free",
              },
              {
                icon: "badge-check",
                title: "True to size",
                subtitle: "UK and India sizing",
              },
              {
                icon: "lock",
                title: "Secure checkout",
                subtitle: "Every major method",
              },
            ],
          },
        },
        {
          id: "newsletter",
          type: "newsletter",
          enabled: true,
          style: { background: "#f1eeea", width: "full", padding_y: "lg" },
          config: {
            eyebrow: "The list",
            heading: "First look, first sizes",
            subheading:
              "New arrivals and restocks, before the good sizes go. Roughly twice a month.",
            button_label: "Join the list",
            success_message: "You're on the list — see you at the next drop.",
            consent_text:
              "I agree to receive new-arrival and offer emails from this store.",
            theme: "light",
            alignment: "center",
          },
        },
      ],
    },
    {
      slug: "size-guide",
      title: "Size Guide",
      seo_description:
        "UK, India, EU and US shoe size conversions, plus how to measure your foot and choose between half sizes.",
      sections: [
        {
          id: "size-intro",
          type: "media_text",
          enabled: true,
          config: {
            eyebrow: "Sizing",
            heading: "Measure once, order once",
            body: "Our footwear runs true to UK sizing. Measure late in the day, when your feet are at their largest, and size up if you are between two.",
            cta_label: "Shop footwear",
            cta_href: "/shop",
            image_url: img("loafer"),
            image_alt: "Brown leather penny loafer photographed from above",
            media_position: "right",
            media_ratio: "landscape",
            alignment: "left",
          },
        },
        {
          id: "size-table",
          type: "rich_text",
          enabled: true,
          config: {
            html: "<h2>How to measure your foot</h2><p>Stand on a sheet of paper with your heel against a wall. Mark the tip of your longest toe, then measure from the wall to the mark in centimetres. Do both feet and use the larger measurement.</p><h3>Between sizes?</h3><p>Take the larger size in boots and closed shoes, and the smaller in sandals and mules. Leather relaxes about half a size with wear; textile and recycled uppers do not.</p><h3>Width</h3><p>Our lasts are cut to a standard D width. If you usually need a wide fit, our round-toe and square-toe shapes have noticeably more room across the ball of the foot than the pointed ones.</p>",
            width: "contained",
          },
        },
        {
          id: "size-faq",
          type: "faq_accordion",
          enabled: true,
          config: {
            heading: "Sizing questions",
            subheading: "The five we are asked most often.",
            show_filters: false,
            items: [
              {
                question: "Do your shoes run true to size?",
                answer:
                  "Yes, to UK sizing. If you normally wear a UK 8, order a UK 8. Our pointed-toe styles are the one exception and run about a half size small.",
                category: "",
              },
              {
                question: "What is the difference between UK and India sizing?",
                answer:
                  "They are the same for adult footwear, which is why the product page shows them together. The toggle switches to US sizing if you shop that scale.",
                category: "",
              },
              {
                question: "Can I exchange for a different size?",
                answer:
                  "Yes, free within 14 days of delivery, as long as the shoes are unworn and the box is intact. Start the exchange from your order history.",
                category: "",
              },
              {
                question: "How do I know if a size is back in stock?",
                answer:
                  "Sold-out sizes stay visible on the product page with a diagonal strike so you can tell the size exists. Join the list for restock notices.",
                category: "",
              },
              {
                question: "Do the bags have a size guide too?",
                answer:
                  "Every bag lists its height, width, depth and strap drop in centimetres, along with whether a 13-inch laptop fits.",
                category: "",
              },
            ],
          },
        },
      ],
    },
    {
      slug: "our-edit",
      title: "Our Edit",
      seo_description:
        "How this shop chooses footwear and bags — the last, the leather and the heel height that make a shoe worth keeping.",
      sections: [
        {
          id: "edit-intro",
          type: "media_text",
          enabled: true,
          config: {
            eyebrow: "Inside the edit",
            heading: "Fewer shapes, better made",
            body: "We carry a small number of silhouettes and rework them each season rather than chasing a new shape every drop. It means the fit you liked last year is still the fit this year.",
            cta_label: "Shop the collection",
            cta_href: "/shop",
            image_url: img("hero"),
            image_alt:
              "Editorial still life of leather footwear and bags on a pale backdrop",
            media_position: "left",
            media_ratio: "landscape",
            alignment: "left",
          },
        },
        {
          id: "edit-copy",
          type: "rich_text",
          enabled: true,
          config: {
            html: "<h2>What we look for</h2><p>A last that leaves room across the toes, a footbed with real cushioning rather than a printed logo, and an upper that creases instead of cracking. Leather is full or corrected grain, never bonded.</p><h3>Heel heights you can walk in</h3><p>Almost everything we carry sits under 60mm, on a block, stacked or flared heel. A stiletto is a lovely object and a poor commute, so we keep those to the occasion edit and say so clearly.</p><h3>Made to be repaired</h3><p>Where a style can be resoled, we say so on the product page. A shoe you can take to a cobbler twice is worth more than three you cannot.</p>",
            width: "contained",
          },
        },
        {
          id: "edit-principles",
          type: "testimonials",
          enabled: true,
          config: {
            eyebrow: "Three questions",
            heading: "What earns a place in the edit",
            subheading: "Every style has to answer all three.",
            layout: "editorial",
            columns: 3,
            items: [
              {
                quote:
                  "Would you wear it on a day with a lot of walking in it?",
                author: "Fit",
                detail: "Cushioned, roomy, under 60mm",
                logo_url: "",
                logo_alt: "",
              },
              {
                quote: "Will the material look better creased than it did new?",
                author: "Material",
                detail: "Full-grain leather and honest textiles",
                logo_url: "",
                logo_alt: "",
              },
              {
                quote: "Does it still work with what you already own?",
                author: "Range",
                detail: "Shapes that outlast the season",
                logo_url: "",
                logo_alt: "",
              },
            ],
          },
        },
      ],
    },
    {
      slug: "shipping-and-returns",
      title: "Shipping & Returns",
      seo_description:
        "Delivery timelines, free-shipping thresholds and how free 14-day size exchanges and returns work.",
      sections: [
        {
          id: "ship-faq",
          type: "faq_accordion",
          enabled: true,
          config: {
            heading: "Shipping and returns",
            subheading: "Delivery, exchanges and everything in between.",
            show_filters: true,
            items: [
              {
                question: "How long does delivery take?",
                answer:
                  "Two to four working days to metro cities and four to seven elsewhere. You will get a tracking link as soon as the parcel is collected.",
                category: "Shipping",
              },
              {
                question: "Is delivery free?",
                answer:
                  "Free on orders over ₹2,999. Below that a flat charge applies and is shown at checkout before you pay.",
                category: "Shipping",
              },
              {
                question: "Can I collect my order in store?",
                answer:
                  "Yes, where a shop near you carries the size. Choose collection at checkout and we will hold the parcel for you.",
                category: "Shipping",
              },
              {
                question: "How do exchanges work?",
                answer:
                  "Free within 14 days for a different size in the same style. Request it from your order history and we will send the replacement once the original is on its way back.",
                category: "Returns",
              },
              {
                question: "What condition do returns need to be in?",
                answer:
                  "Unworn, with the original box and any dust bag. Try shoes on carpet rather than a hard floor so the soles stay unmarked.",
                category: "Returns",
              },
              {
                question: "When is my refund processed?",
                answer:
                  "Within three working days of the parcel reaching us. It goes back to the method you paid with, and you will get an email when it leaves our side.",
                category: "Returns",
              },
            ],
          },
        },
        {
          id: "ship-service",
          type: "usp_bar",
          enabled: true,
          style: { background: "#f1eeea", width: "full", padding_y: "md" },
          config: {
            theme: "dark",
            items: [
              {
                icon: "truck",
                title: "2-4 days",
                subtitle: "To metro cities",
              },
              {
                icon: "refresh",
                title: "Free exchanges",
                subtitle: "14 days, any size",
              },
              {
                icon: "shield",
                title: "Tracked",
                subtitle: "Every parcel",
              },
            ],
          },
        },
      ],
    },
  ],

  menus: {
    // ⚠ A nav item that NAMES a category must carry `?category=<slug>`, or it
    // lands on /shop with the "All" tab selected and silently ignores the word
    // the shopper clicked. The slugs here must match sampleData.categories.
    header: [
      { label: "Women", href: "/shop?category=womens-shoes" },
      { label: "Men", href: "/shop?category=mens-shoes" },
      { label: "Handbags", href: "/shop?category=handbags" },
      { label: "Accessories", href: "/shop?category=accessories" },
      { label: "Size Guide", href: "/size-guide" },
    ],
    footerGroups: [
      {
        title: "Shop",
        links: [
          { label: "Women's Shoes", href: "/shop?category=womens-shoes" },
          { label: "Men's Shoes", href: "/shop?category=mens-shoes" },
          { label: "Handbags", href: "/shop?category=handbags" },
          { label: "Accessories", href: "/shop?category=accessories" },
        ],
      },
      {
        title: "Help",
        links: [
          { label: "Size Guide", href: "/size-guide" },
          { label: "Shipping & Returns", href: "/shipping-and-returns" },
          { label: "Enquiries", href: "/enquiries" },
        ],
      },
      {
        title: "About",
        links: [{ label: "Our Edit", href: "/our-edit" }],
      },
    ],
    footerLegal: [],
  },

  sampleData: {
    categories: [
      {
        name: "Women's Shoes",
        slug: "womens-shoes",
        description: "Block heels, boots and flats built for real distances.",
        image_url: img("heel"),
        sort_order: 0,
      },
      {
        name: "Men's Shoes",
        slug: "mens-shoes",
        description: "Low-tops, loafers and derbies in full-grain leather.",
        image_url: img("loafer"),
        sort_order: 1,
      },
      {
        name: "Handbags",
        slug: "handbags",
        description: "Totes, crossbodies and clutches that hold their shape.",
        image_url: img("tote"),
        sort_order: 2,
      },
      {
        name: "Accessories",
        slug: "accessories",
        description: "Belts, eyewear and the small things that finish a look.",
        image_url: img("sunglasses"),
        sort_order: 3,
      },
    ],
    products: [
      {
        name: "Aveny Low-Top Sneaker",
        slug: "aveny-low-top-sneaker",
        description:
          "A clean white low-top in soft full-grain leather, built on a cushioned dual-density footbed with a tonal rubber cupsole.",
        category_slug: "mens-shoes",
        base_price: 8999,
        selling_price: 8999,
        image_url: img("sneaker"),
        images: [img("sneaker"), img("hero")],
        featured: true,
        sort_order: 0,
        card_color: "#efebe6",
        variants: [
          { name: "UK 6", base_price: 8999, selling_price: 8999, stock: 6 },
          { name: "UK 7", base_price: 8999, selling_price: 8999, stock: 9 },
          { name: "UK 8", base_price: 8999, selling_price: 8999, stock: 12 },
          { name: "UK 9", base_price: 8999, selling_price: 8999, stock: 8 },
          { name: "UK 10", base_price: 8999, selling_price: 8999, stock: 4 },
        ],
      },
      {
        name: "Marlowe Leather Loafer",
        slug: "marlowe-leather-loafer",
        description:
          "A slim penny loafer in polished calf leather with a stacked 25mm heel, leather lining and a resolable welted sole.",
        category_slug: "mens-shoes",
        base_price: 11999,
        selling_price: 9599,
        image_url: img("loafer"),
        featured: true,
        sort_order: 1,
        card_color: "#eae5df",
        variants: [
          { name: "UK 7", base_price: 11999, selling_price: 9599, stock: 5 },
          { name: "UK 8", base_price: 11999, selling_price: 9599, stock: 7 },
          { name: "UK 9", base_price: 11999, selling_price: 9599, stock: 6 },
          { name: "UK 10", base_price: 11999, selling_price: 9599, stock: 3 },
        ],
      },
      {
        name: "Selene Block Heel Sandal",
        slug: "selene-block-heel-sandal",
        description:
          "A squared-toe sandal on a 55mm block heel, with a padded footbed and an adjustable ankle strap in matte suede.",
        category_slug: "womens-shoes",
        base_price: 7999,
        selling_price: 7999,
        image_url: img("heel"),
        featured: true,
        sort_order: 2,
        card_color: "#efebe6",
        variants: [
          { name: "UK 3", base_price: 7999, selling_price: 7999, stock: 5 },
          { name: "UK 4", base_price: 7999, selling_price: 7999, stock: 8 },
          { name: "UK 5", base_price: 7999, selling_price: 7999, stock: 10 },
          { name: "UK 6", base_price: 7999, selling_price: 7999, stock: 7 },
        ],
      },
      {
        name: "Rowan Ankle Boot",
        slug: "rowan-ankle-boot",
        description:
          "A clean-lined ankle boot in supple black leather on a 50mm stacked heel, with an inside zip and a lightly squared toe.",
        category_slug: "womens-shoes",
        base_price: 12999,
        selling_price: 10399,
        image_url: img("boot"),
        images: [img("boot"), img("hero")],
        featured: true,
        sort_order: 3,
        card_color: "#e8e3dd",
        variants: [
          { name: "UK 4", base_price: 12999, selling_price: 10399, stock: 4 },
          { name: "UK 5", base_price: 12999, selling_price: 10399, stock: 6 },
          { name: "UK 6", base_price: 12999, selling_price: 10399, stock: 5 },
        ],
      },
      {
        name: "Astrid Structured Tote",
        slug: "astrid-structured-tote",
        description:
          "A firm-grain leather tote with a flat base that stays upright, an interior laptop sleeve sized for 13 inches and a magnetic top closure.",
        category_slug: "handbags",
        base_price: 8999,
        selling_price: 8999,
        image_url: img("tote"),
        featured: true,
        sort_order: 4,
        card_color: "#efebe6",
        variants: [
          { name: "Tan", base_price: 8999, selling_price: 8999, stock: 9 },
          { name: "Black", base_price: 8999, selling_price: 8999, stock: 11 },
        ],
      },
      {
        name: "Nyla Quilted Crossbody",
        slug: "nyla-quilted-crossbody",
        description:
          "A compact quilted crossbody on an adjustable 55cm chain-and-leather strap, with a card slip inside and a magnetic flap.",
        category_slug: "handbags",
        base_price: 5499,
        selling_price: 4399,
        image_url: img("crossbody"),
        featured: true,
        sort_order: 5,
        card_color: "#eae5df",
      },
      {
        name: "Corbin Reversible Belt",
        slug: "corbin-reversible-belt",
        description:
          "A 30mm reversible belt in black and tan full-grain leather, with a brushed square buckle that turns to switch sides.",
        category_slug: "accessories",
        base_price: 3499,
        selling_price: 3499,
        image_url: img("belt"),
        featured: false,
        sort_order: 6,
        card_color: "#efebe6",
        variants: [
          { name: "85cm", base_price: 3499, selling_price: 3499, stock: 12 },
          { name: "95cm", base_price: 3499, selling_price: 3499, stock: 10 },
          { name: "105cm", base_price: 3499, selling_price: 3499, stock: 6 },
        ],
      },
      {
        name: "Halden Angular Sunglasses",
        slug: "halden-angular-sunglasses",
        description:
          "An angular acetate frame in warm tortoiseshell with gradient lenses, full UV400 protection and a hard case included.",
        category_slug: "accessories",
        base_price: 4999,
        selling_price: 3999,
        image_url: img("sunglasses"),
        featured: false,
        sort_order: 7,
        card_color: "#eae5df",
      },
    ],
  },
};

export const vitrine: ThemeDefinition = {
  ...THEME_META.find((theme) => theme.id === "vitrine")!,
  preset,
};

import type { ThemeDefinition, ThemePreset } from "../types";
import { THEME_META } from "../meta";

// ---------------------------------------------------------------------------
// BASKET — bright grocery-market theme (the Food & Beverage reference
// vertical, per docs/vertical-templates-plan.md §9.1). Deep pine "market"
// header with a working search box, peach hero banner, category circles,
// coloured offer tiles, quick-add product cards and a dark USP strip.
// ---------------------------------------------------------------------------

const img = (name: string) => `/themes/basket/${name}.webp`;

const preset: ThemePreset = {
  brand: {
    primaryColor: "#ef5a2a",
    tagline: "Fresh groceries, delivered fast",
    blurb:
      "Everything your kitchen needs — farm-fresh produce, daily staples and pantry favourites, delivered to your door.",
  },

  // Grocery-pop skin: white canvas, pine ink, tangerine accent, friendly
  // 12–16px radii and full-pill controls. Plus Jakarta headings / Inter body.
  design: {
    palette: {
      cream: "#ffffff",
      creamDeep: "#f2f5f2",
      surface: "#ffffff",
      ink: "#1e2b28",
      inkSoft: "#5c6b66",
      inkFaint: "#9aa8a2",
      taupe: "#eef3ee",
      sand: "#f2f5f2",
      butter: "#fdf3d8",
      border: "#e4e9e5",
      tile: "#f6f8f6",
      accentWarm: "#ef5a2a",
      onAccent: "#ffffff",
      onInk: "#ffffff",
      shadowRgb: "16, 43, 36",
      success: "#2e7d32",
      successSoft: "#e8f5e9",
      error: "#c0392b",
      errorSoft: "#fdeeec",
      star: "#f2a900",
      highlight: "#ef5a2a",
    },
    fonts: {
      body: "var(--font-inter)",
      display: "var(--font-jakarta)",
    },
    shape: {
      card: "16px",
      control: "12px",
      sm: "10px",
      pill: "999px",
    },
    layout: {
      header: "market",
      headerBackground: "#0f3e38",
      headerForeground: "#ffffff",
      card: "quick_add",
      storefront: "grocery",
    },
  },

  pages: [
    {
      slug: "",
      title: "Home",
      seo_description:
        "Farm-fresh produce, daily staples and pantry favourites — delivered fast.",
      sections: [
        {
          id: "hero",
          type: "hero",
          enabled: true,
          config: {
            variant: "banner",
            heading: "From farm to your kitchen",
            subheading:
              "The freshest groceries, delivered quickly and conveniently.",
            cta_label: "Shop now",
            cta_href: "/shop",
            image_url: img("hero"),
            video_url: "",
            badge_text: "Fresh deals every week",
            background: "#fae3c1",
            theme: "dark",
            alignment: "left",
          },
        },
        {
          id: "categories",
          type: "shop_by_category",
          enabled: true,
          config: {
            heading: "Shop by category",
            subheading: "",
            source: "all",
            category_ids: [],
            layout: "scroll",
            display: "circles",
          },
        },
        {
          id: "offers",
          type: "tile_grid",
          enabled: true,
          config: {
            heading: "Top offers this week",
            subheading: "",
            columns: 4,
            height: "sm",
            tiles: [
              {
                title: "Fresh produce",
                subtitle: "from ₹39",
                href: "/shop?category=fruits-vegetables",
                image_url: "",
                background: "#e1f5ee",
                theme: "dark",
              },
              {
                title: "Snacks & juices",
                subtitle: "up to 20% off",
                href: "/shop?category=snacks-beverages",
                image_url: "",
                background: "#fdf3d8",
                theme: "dark",
              },
              {
                title: "Dairy & eggs",
                subtitle: "farm fresh daily",
                href: "/shop?category=dairy-eggs",
                image_url: "",
                background: "#e6f1fb",
                theme: "dark",
              },
              {
                title: "Household",
                subtitle: "weekly essentials",
                href: "/shop?category=household",
                image_url: "",
                background: "#fbeaf0",
                theme: "dark",
              },
            ],
          },
        },
        {
          id: "featured",
          type: "featured_products",
          enabled: true,
          config: {
            heading: "Fresh picks",
            subheading: "Hand-checked every morning",
            source: "featured",
            product_ids: [],
            category_id: null,
            limit: 8,
          },
        },
        {
          id: "banners",
          type: "tile_grid",
          enabled: true,
          config: {
            heading: "",
            subheading: "",
            columns: 2,
            height: "md",
            tiles: [
              {
                title: "Crispy cookies",
                subtitle: "Fresh-baked range in stock",
                href: "/shop?category=snacks-beverages",
                image_url: img("banner-cookies"),
                background: "",
                theme: "light",
              },
              {
                title: "Delicious noodles",
                subtitle: "Stir-fry night, sorted",
                href: "/shop?category=snacks-beverages",
                image_url: img("banner-noodles"),
                background: "",
                theme: "light",
              },
            ],
          },
        },
        {
          id: "promises",
          type: "usp_bar",
          enabled: true,
          style: { background: "#101b33", width: "full", padding_y: "sm" },
          config: {
            theme: "light",
            items: [
              {
                icon: "badge-check",
                title: "Assured satisfaction",
                subtitle: "Best in class",
              },
              {
                icon: "sparkles",
                title: "Premium quality",
                subtitle: "Quality guaranteed",
              },
              {
                icon: "refresh",
                title: "Easy returns",
                subtitle: "As per brand policy",
              },
              {
                icon: "lock",
                title: "Secure checkout",
                subtitle: "100% protected",
              },
            ],
          },
        },
      ],
    },
    {
      slug: "our-story",
      title: "Our Story",
      seo_description: "Why we started delivering groceries.",
      sections: [
        {
          id: "hero",
          type: "hero",
          enabled: true,
          config: {
            variant: "banner",
            heading: "Groceries, minus the queue",
            subheading:
              "We do the market run for you — sourced this morning, at your door by dinner.",
            cta_label: "Shop fresh",
            cta_href: "/shop",
            image_url: img("hero"),
            video_url: "",
            badge_text: "Our story",
            background: "#fae3c1",
            theme: "dark",
            alignment: "left",
          },
        },
        {
          id: "story",
          type: "rich_text",
          enabled: true,
          style: { padding_y: "sm" },
          config: {
            html: "<h2>It started with a bad tomato</h2><p>Fresh food shouldn't cost you an hour of your evening — or arrive tired and bruised. So we built a store that shops the way we'd want someone to shop for us: straight from local farms and mills every morning, hand-checked, and delivered before dinner.</p><p>No warehouses full of week-old produce. No mystery supply chains. Just good food, moving fast.</p><p><strong>If it isn't fresh enough for our own kitchens, it doesn't go in yours.</strong></p>",
            width: "contained",
          },
        },
        {
          id: "values",
          type: "usp_bar",
          enabled: true,
          style: { background: "#101b33", width: "full", padding_y: "md" },
          config: {
            theme: "light",
            items: [
              {
                icon: "leaf",
                title: "Sourced daily",
                subtitle: "From local farms & mills",
              },
              {
                icon: "truck",
                title: "Delivered fast",
                subtitle: "At your door by dinner",
              },
              {
                icon: "badge-check",
                title: "Hand-checked",
                subtitle: "Every single order",
              },
              {
                icon: "heart",
                title: "Kitchen-tested",
                subtitle: "We eat what we sell",
              },
            ],
          },
        },
        {
          id: "closing",
          type: "hero",
          enabled: true,
          config: {
            variant: "minimal",
            heading: "Come taste the difference",
            subheading: "Thousands of fresh products, restocked every morning.",
            cta_label: "Start shopping",
            cta_href: "/shop",
            image_url: img("cat-fruits-veg"),
            video_url: "",
            badge_text: "",
            background: "",
            theme: "light",
            alignment: "center",
          },
        },
      ],
    },
    {
      slug: "faqs",
      title: "FAQs",
      seo_description: "Answers to common questions.",
      sections: [
        {
          id: "faqs",
          type: "faq_accordion",
          enabled: true,
          style: { padding_y: "md" },
          config: {
            heading: "Frequently asked questions",
            subheading:
              "Delivery, returns, freshness — everything you might wonder about.",
            show_filters: true,
            items: [
              {
                question: "How fresh is the produce, really?",
                answer:
                  "We source from local farms and mills every morning, so most produce reaches you within a day of harvest. If anything isn't up to standard, we'll replace it free.",
                category: "Orders",
              },
              {
                question: "What are your delivery times?",
                answer:
                  "We deliver every day, 8am–9pm. Orders placed before 4pm arrive the same day; everything else arrives the next morning.",
                category: "Delivery",
              },
              {
                question: "What if something arrives damaged?",
                answer:
                  "Tell us within 24 hours and we'll refund or replace it — no photos, no forms.",
                category: "Returns",
              },
              {
                question: "Is there a minimum order value?",
                answer:
                  "No minimum. Orders over ₹499 ship free; below that a flat ₹29 delivery fee applies.",
                category: "Orders",
              },
              {
                question: "Which payment methods do you accept?",
                answer:
                  "Cards, UPI, net banking and cash on delivery — pick whatever's easiest at checkout.",
                category: "Payments",
              },
              {
                question: "Can I return packaged goods?",
                answer:
                  "Unopened packaged items can be returned within 7 days. Fresh items can be handed back at the doorstep on delivery.",
                category: "Returns",
              },
            ],
          },
        },
      ],
    },
    {
      slug: "delivery-returns",
      title: "Delivery & Returns",
      seo_description: "Delivery slots, coverage and our returns promise.",
      sections: [
        {
          id: "delivery",
          type: "rich_text",
          enabled: true,
          config: {
            html: "<h2>Delivery & returns</h2><h3>Delivery</h3><p>We deliver every day, 8am–9pm. Orders placed before 4pm arrive the same day; everything else arrives next morning.</p><h3>Returns</h3><p>Fresh items can be returned at the doorstep. Packaged goods can be returned unopened within 7 days.</p>",
            width: "contained",
          },
        },
      ],
    },
  ],

  menus: {
    header: [
      { label: "Shop", href: "/shop" },
      { label: "Our Story", href: "/our-story" },
      { label: "FAQs", href: "/faqs" },
      { label: "Blogs", href: "/blogs" },
    ],
    footerGroups: [
      {
        title: "Shop",
        links: [{ label: "All Products", href: "/shop" }],
      },
      {
        title: "Company",
        links: [
          { label: "Our Story", href: "/our-story" },
          { label: "Blog", href: "/blogs" },
        ],
      },
      {
        title: "Support",
        links: [
          { label: "FAQs", href: "/faqs" },
          { label: "Delivery & Returns", href: "/delivery-returns" },
          { label: "Enquiries", href: "/enquiries" },
        ],
      },
    ],
    footerLegal: [],
  },

  sampleData: {
    categories: [
      {
        name: "Fruits & Vegetables",
        slug: "fruits-vegetables",
        description: "Farm-fresh produce, restocked every morning.",
        image_url: img("cat-fruits-veg"),
        sort_order: 0,
      },
      {
        name: "Staples",
        slug: "staples",
        description: "Rice, atta, bread and everyday basics.",
        image_url: img("cat-staples"),
        sort_order: 1,
      },
      {
        name: "Dairy & Eggs",
        slug: "dairy-eggs",
        description: "Milk, curd, paneer and farm eggs.",
        image_url: img("cat-dairy"),
        sort_order: 2,
      },
      {
        name: "Snacks & Beverages",
        slug: "snacks-beverages",
        description: "Biscuits, noodles, juices and treats.",
        image_url: img("cat-snacks"),
        sort_order: 3,
      },
      {
        name: "Household",
        slug: "household",
        description: "Cleaning and home essentials.",
        image_url: img("cat-household"),
        sort_order: 4,
      },
    ],
    products: [
      {
        name: "Tomatoes (500 g) (Sample)",
        slug: "tomatoes",
        description:
          "Vine-ripened, firm and bright red. Sample product — replace it with your own.",
        category_slug: "fruits-vegetables",
        base_price: 55,
        selling_price: 45,
        image_url: img("p-tomato"),
        featured: true,
        sort_order: 0,
        card_color: "#fdeeea",
      },
      {
        name: "Baby Spinach (250 g) (Sample)",
        slug: "baby-spinach",
        description: "Tender leaves, washed and ready to cook. Sample product.",
        category_slug: "fruits-vegetables",
        base_price: 60,
        selling_price: 49,
        image_url: img("p-spinach"),
        featured: true,
        sort_order: 1,
        card_color: "#eaf5ec",
      },
      {
        name: "Carrots (1 kg) (Sample)",
        slug: "carrots",
        description: "Sweet, crunchy and great for juicing. Sample product.",
        category_slug: "fruits-vegetables",
        base_price: 80,
        selling_price: 64,
        image_url: img("p-carrot"),
        featured: true,
        sort_order: 2,
        card_color: "#fdf3e0",
      },
      {
        name: "Bananas (6 pc) (Sample)",
        slug: "bananas",
        description: "Naturally ripened, no carbide. Sample product.",
        category_slug: "fruits-vegetables",
        base_price: 49,
        selling_price: 39,
        image_url: img("p-banana"),
        featured: true,
        sort_order: 3,
        card_color: "#fdf7d8",
      },
      {
        name: "Royal Gala Apples (4 pc) (Sample)",
        slug: "royal-gala-apples",
        description: "Crisp, juicy and lightly sweet. Sample product.",
        category_slug: "fruits-vegetables",
        base_price: 220,
        selling_price: 189,
        image_url: img("p-apple"),
        featured: false,
        sort_order: 4,
        card_color: "#fdecef",
      },
      {
        name: "Potatoes (2 kg) (Sample)",
        slug: "potatoes",
        description: "All-rounder potatoes for every dish. Sample product.",
        category_slug: "fruits-vegetables",
        base_price: 98,
        selling_price: 79,
        image_url: img("p-potato"),
        featured: false,
        sort_order: 5,
        card_color: "#f4efe2",
      },
      {
        name: "Basmati Rice (Sample)",
        slug: "basmati-rice",
        description:
          "Aged long-grain basmati, aromatic and fluffy. Sample product.",
        category_slug: "staples",
        base_price: 160,
        selling_price: 145,
        image_url: img("p-rice"),
        featured: true,
        sort_order: 6,
        card_color: "#f3f0e7",
        variants: [
          { name: "1 kg", base_price: 160, selling_price: 145, stock: 40 },
          {
            name: "5 kg",
            base_price: 720,
            selling_price: 645,
            special_price: 599,
            stock: 18,
          },
        ],
      },
      {
        name: "Multigrain Bread (Sample)",
        slug: "multigrain-bread",
        description: "Baked daily with seven whole grains. Sample product.",
        category_slug: "staples",
        base_price: 60,
        selling_price: 52,
        image_url: img("p-bread"),
        featured: true,
        sort_order: 7,
        card_color: "#f6ead9",
      },
      {
        name: "Farm Eggs (12 pc) (Sample)",
        slug: "farm-eggs",
        description: "Free-range brown eggs, collected daily. Sample product.",
        category_slug: "dairy-eggs",
        base_price: 120,
        selling_price: 96,
        image_url: img("p-eggs"),
        featured: true,
        sort_order: 8,
        card_color: "#fdf3e0",
      },
      {
        name: "Toned Milk (Sample)",
        slug: "toned-milk",
        description: "Pasteurised toned milk, farm to fridge. Sample product.",
        category_slug: "dairy-eggs",
        base_price: 34,
        selling_price: 32,
        image_url: img("p-milk"),
        featured: false,
        sort_order: 9,
        card_color: "#eef4f8",
        variants: [
          { name: "500 ml", base_price: 34, selling_price: 32, stock: 60 },
          { name: "1 L", base_price: 66, selling_price: 60, stock: 45 },
        ],
      },
      {
        name: "Choco-Chip Cookies (Sample)",
        slug: "choco-chip-cookies",
        description:
          "Chunky dark-chocolate cookies, baked this week. Sample product.",
        category_slug: "snacks-beverages",
        base_price: 149,
        selling_price: 119,
        image_url: img("p-cookies"),
        featured: true,
        sort_order: 10,
        card_color: "#f7ede2",
      },
      {
        name: "Hakka Noodles — Pack of 4 (Sample)",
        slug: "hakka-noodles",
        description:
          "Perfect for stir-fries, soups and Indo-Chinese classics. Sample product.",
        category_slug: "snacks-beverages",
        base_price: 120,
        selling_price: 99,
        image_url: img("p-noodles"),
        featured: false,
        sort_order: 11,
        card_color: "#fdeeea",
      },
      {
        name: "Fresh Orange Juice (1 L) (Sample)",
        slug: "orange-juice",
        description: "Cold-pressed oranges, no added sugar. Sample product.",
        category_slug: "snacks-beverages",
        base_price: 150,
        selling_price: 129,
        image_url: img("p-juice"),
        featured: true,
        sort_order: 12,
        card_color: "#fdf3d8",
      },
    ],
  },
};

export const basket: ThemeDefinition = {
  ...THEME_META.find((t) => t.id === "basket")!,
  preset,
};

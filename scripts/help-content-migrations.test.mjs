import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, test } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const migrationDirectory = path.join(
  repositoryRoot,
  "drizzle",
  "migrations",
  "sql",
);

const expectedMigrations = [
  "20260826_0019_getting_started_account_help.sql",
  "20260826_0020_storefront_domains_help.sql",
  "20260826_0021_products_customers_help.sql",
  "20260826_0022_payments_tax_help.sql",
  "20260826_0023_orders_shipping_help.sql",
  "20260826_0024_marketing_communications_help.sql",
];

const expectedCategories = new Map([
  [expectedMigrations[0], ["account", "getting-started"]],
  [expectedMigrations[1], ["domains", "storefront"]],
  [expectedMigrations[2], ["customers", "products"]],
  [expectedMigrations[3], ["payments"]],
  [expectedMigrations[4], ["orders"]],
  [expectedMigrations[5], ["marketing"]],
]);
const expectedArticleCounts = new Map([
  [expectedMigrations[0], 14],
  [expectedMigrations[1], 17],
  [expectedMigrations[2], 18],
  [expectedMigrations[3], 8],
  [expectedMigrations[4], 12],
  [expectedMigrations[5], 12],
]);

// These migrations predate this coverage sweep, but their published articles
// remain valid link targets for new guides.
const existingCorpusMigrations = [
  "20260820_0007_platform_analytics_controls.sql",
  "20260820_0008_analytics_help_documents.sql",
  "20260820_0011_storefront_conversion.sql",
  "20260820_0012_gross_margin.sql",
  "20260825_0015_pos_help_documents.sql",
];

// The Mink AI guide is a scalar SELECT rather than a VALUES article tuple, so
// it is intentionally recognized here instead of making the VALUES parser
// understand every possible SQL statement in the migration history.
const explicitlyRecognizedExistingArticles = new Set([
  "getting-started/use-storemink-help-assistant",
  // These enrolled analytics rows use scalar SELECTs or ordinary quoted
  // bodies rather than the $article$ VALUES shape parsed below.
  "analytics/understand-analytics-dashboard",
  "analytics/connect-google-analytics-4",
  "analytics/connect-meta-pixel",
  "analytics/understand-storefront-conversion-analytics",
  "analytics/understand-gross-margin-analytics",
  // This legacy row predates the checksummed incremental corpus; 0020
  // intentionally upgrades it in place rather than creating a second guide.
  "domains/how-to-add-custom-domain",
]);

function lexSql(source, file) {
  const tokens = [];
  let cursor = 0;

  while (cursor < source.length) {
    const start = cursor;
    const character = source[cursor];

    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }

    if (source.startsWith("--", cursor)) {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }

    if (source.startsWith("/*", cursor)) {
      const close = source.indexOf("*/", cursor + 2);
      assert.notEqual(close, -1, `${file}: unterminated block comment`);
      cursor = close + 2;
      continue;
    }

    if (character === "'") {
      let value = "";
      cursor += 1;
      let closed = false;

      while (cursor < source.length) {
        if (source[cursor] !== "'") {
          value += source[cursor];
          cursor += 1;
          continue;
        }
        if (source[cursor + 1] === "'") {
          value += "'";
          cursor += 2;
          continue;
        }
        cursor += 1;
        closed = true;
        break;
      }

      assert.ok(closed, `${file}: unterminated SQL string`);
      tokens.push({ type: "string", value, start, end: cursor });
      continue;
    }

    if (character === "$") {
      const opening = source
        .slice(cursor)
        .match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (opening) {
        const bodyStart = cursor + opening.length;
        const close = source.indexOf(opening, bodyStart);
        assert.notEqual(
          close,
          -1,
          `${file}: unterminated ${opening} dollar quote`,
        );
        tokens.push({
          type: "dollar",
          tag: opening.slice(1, -1).toLowerCase(),
          value: source.slice(bodyStart, close),
          start,
          end: close + opening.length,
        });
        cursor = close + opening.length;
        continue;
      }
    }

    if (/[A-Za-z_]/.test(character)) {
      cursor += 1;
      while (cursor < source.length && /[A-Za-z0-9_$]/.test(source[cursor])) {
        cursor += 1;
      }
      tokens.push({
        type: "word",
        value: source.slice(start, cursor),
        start,
        end: cursor,
      });
      continue;
    }

    if (/[0-9]/.test(character)) {
      cursor += 1;
      while (cursor < source.length && /[0-9.]/.test(source[cursor])) {
        cursor += 1;
      }
      tokens.push({
        type: "number",
        value: source.slice(start, cursor),
        start,
        end: cursor,
      });
      continue;
    }

    tokens.push({ type: "symbol", value: character, start, end: cursor + 1 });
    cursor += 1;
  }

  return tokens;
}

function isSymbol(token, symbol) {
  return token?.type === "symbol" && token.value === symbol;
}

function parseValuesTuples(tokens, valuesIndex, file) {
  const tuples = [];
  let cursor = valuesIndex + 1;

  if (!isSymbol(tokens[cursor], "(")) return tuples;

  while (isSymbol(tokens[cursor], "(")) {
    const fields = [[]];
    let depth = 1;
    cursor += 1;

    while (cursor < tokens.length && depth > 0) {
      const token = tokens[cursor];
      if (isSymbol(token, "(")) {
        depth += 1;
        fields.at(-1).push(token);
      } else if (isSymbol(token, ")")) {
        depth -= 1;
        if (depth > 0) fields.at(-1).push(token);
      } else if (isSymbol(token, ",") && depth === 1) {
        fields.push([]);
      } else {
        fields.at(-1).push(token);
      }
      cursor += 1;
    }

    assert.equal(depth, 0, `${file}: unterminated VALUES tuple`);
    tuples.push(fields);

    if (isSymbol(tokens[cursor], ",") && isSymbol(tokens[cursor + 1], "(")) {
      cursor += 1;
      continue;
    }
    break;
  }

  return tuples;
}

function scalarField(field, type, context) {
  assert.equal(field.length, 1, `${context}: expected one scalar SQL value`);
  assert.equal(field[0].type, type, `${context}: expected a ${type} SQL value`);
  return field[0].value;
}

function inferSingleCategory(source, valuesOffset, context) {
  const nearbySource = source.slice(
    Math.max(0, valuesOffset - 4_000),
    valuesOffset,
  );
  const matches = [
    ...nearbySource.matchAll(
      /WHERE\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?slug\s*=\s*'([^']+)'/gi,
    ),
  ];
  assert.ok(matches.length > 0, `${context}: could not infer article category`);
  return matches.at(-1)[1];
}

function parseArticleTuples(source, file) {
  const tokens = lexSql(source, file);
  const articles = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "word" || token.value.toUpperCase() !== "VALUES") {
      continue;
    }

    for (const fields of parseValuesTuples(tokens, index, file)) {
      const bodyIndex = fields.findIndex(
        (field) =>
          field.length === 1 &&
          field[0].type === "dollar" &&
          field[0].tag === "article",
      );
      if (bodyIndex === -1) continue;

      const slugIndex = bodyIndex - 3;
      const context = `${file}: article tuple near byte ${token.start}`;
      assert.ok(
        slugIndex === 0 || slugIndex === 1,
        `${context}: unsupported article tuple shape`,
      );

      const slug = scalarField(fields[slugIndex], "string", `${context} slug`);
      const title = scalarField(
        fields[slugIndex + 1],
        "string",
        `${context} title`,
      );
      const excerpt = scalarField(
        fields[slugIndex + 2],
        "string",
        `${context} excerpt`,
      );
      const body = scalarField(fields[bodyIndex], "dollar", `${context} body`);

      let metadataIndex = bodyIndex + 1;
      const possibleStatus = fields[metadataIndex]?.[0];
      if (
        fields[metadataIndex]?.length === 1 &&
        possibleStatus?.type === "string" &&
        ["draft", "published"].includes(possibleStatus.value)
      ) {
        metadataIndex += 1;
      }

      const seoTitle = scalarField(
        fields[metadataIndex],
        "string",
        `${context} SEO title`,
      );
      const seoDescription = scalarField(
        fields[metadataIndex + 1],
        "string",
        `${context} SEO description`,
      );
      const category =
        slugIndex === 1
          ? scalarField(fields[0], "string", `${context} category`)
          : inferSingleCategory(source, token.start, context);

      articles.push({
        file,
        category,
        slug,
        title,
        excerpt,
        body,
        seoTitle,
        seoDescription,
      });
    }
  }

  return articles;
}

function visibleText(html) {
  return html
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<script\b[^>]*>[^]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[^]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function articleLinks(article) {
  const links = [];
  const pattern = /href\s*=\s*(["'])(\/help\/[^"'<>\s]+)\1/gi;
  for (const match of article.body.matchAll(pattern)) links.push(match[2]);
  return links;
}

async function readMigration(file) {
  return readFile(path.join(migrationDirectory, file), "utf8");
}

const expectedSources = new Map(
  await Promise.all(
    expectedMigrations.map(async (file) => [file, await readMigration(file)]),
  ),
);
const newArticles = expectedMigrations.flatMap((file) =>
  parseArticleTuples(expectedSources.get(file), file),
);

describe("Help Centre content migrations 0019 through 0024", () => {
  test("discovers the exact migration files in ledger order", async () => {
    const discovered = (await readdir(migrationDirectory))
      .filter((file) =>
        /^20260826_(?:0019|0020|0021|0022|0023|0024)_.+\.sql$/.test(file),
      )
      .sort();

    assert.deepEqual(discovered, expectedMigrations);
    assert.deepEqual(
      discovered.map((file) => Number(file.match(/_(\d{4})_/)[1])),
      [19, 20, 21, 22, 23, 24],
    );
  });

  test("seeds the intended categories with unique article slugs", () => {
    assert.ok(
      newArticles.length > 0,
      "no Help Centre article tuples were found",
    );
    const slugs = new Map();

    for (const article of newArticles) {
      const previous = slugs.get(article.slug);
      assert.equal(
        previous,
        undefined,
        `duplicate article slug ${article.slug} in ${previous} and ${article.file}`,
      );
      slugs.set(article.slug, article.file);
    }

    for (const file of expectedMigrations) {
      const fileArticles = newArticles.filter(
        (article) => article.file === file,
      );
      const categories = [
        ...new Set(fileArticles.map((article) => article.category)),
      ].sort();
      assert.equal(fileArticles.length, expectedArticleCounts.get(file), file);
      assert.deepEqual(categories, expectedCategories.get(file), file);
    }
  });

  test("keeps every seeded guide complete and substantial", () => {
    for (const article of newArticles) {
      const label = `${article.file}: ${article.category}/${article.slug}`;
      assert.match(article.category, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, label);
      assert.match(article.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, label);

      for (const [field, value] of [
        ["title", article.title],
        ["excerpt", article.excerpt],
        ["body", article.body],
        ["SEO title", article.seoTitle],
        ["SEO description", article.seoDescription],
      ]) {
        assert.ok(value.trim(), `${label} has a blank ${field}`);
      }

      assert.match(
        article.body,
        /<h2(?:\s[^>]*)?>[^]*?<\/h2>/i,
        `${label} needs at least one h2 section`,
      );
      const text = visibleText(article.body);
      const words = text.match(/[\p{L}\p{N}]+(?:['’/-][\p{L}\p{N}]+)*/gu) ?? [];
      assert.ok(
        text.length >= 500,
        `${label} has only ${text.length} visible characters`,
      );
      assert.ok(words.length >= 75, `${label} has only ${words.length} words`);
    }
  });

  test("overwrites only the one intentional legacy article slug", async () => {
    const existingArticles = (
      await Promise.all(
        existingCorpusMigrations.map(async (file) =>
          parseArticleTuples(await readMigration(file), file),
        ),
      )
    ).flat();
    const existingSlugs = new Set([
      ...existingArticles.map((article) => article.slug),
      ...[...explicitlyRecognizedExistingArticles].map(
        (target) => target.split("/")[1],
      ),
    ]);
    const collisions = [
      ...new Set(
        newArticles
          .map((article) => article.slug)
          .filter((slug) => existingSlugs.has(slug)),
      ),
    ].sort();

    assert.deepEqual(collisions, ["how-to-add-custom-domain"]);
  });

  test("resolves every internal Help Centre article link", async () => {
    const existingArticles = (
      await Promise.all(
        existingCorpusMigrations.map(async (file) =>
          parseArticleTuples(await readMigration(file), file),
        ),
      )
    ).flat();
    const validTargets = new Set(explicitlyRecognizedExistingArticles);
    for (const article of [...existingArticles, ...newArticles]) {
      validTargets.add(`${article.category}/${article.slug}`);
    }
    const validCategories = new Set(
      [...validTargets].map((target) => target.split("/")[0]),
    );

    for (const article of newArticles) {
      for (const href of articleLinks(article)) {
        const url = new URL(href, "https://help.storemink.com");
        const segments = url.pathname.split("/").filter(Boolean);
        const label = `${article.file}: ${article.category}/${article.slug}`;

        assert.ok(
          segments.length === 2 || segments.length === 3,
          `${label} has malformed Help Centre link ${href}`,
        );
        assert.equal(
          segments[0],
          "help",
          `${label} has malformed link ${href}`,
        );
        if (segments.length === 2) {
          assert.ok(
            validCategories.has(segments[1]),
            `${label} links to unknown category ${href}`,
          );
          continue;
        }

        const target = `${segments[1]}/${segments[2]}`;
        assert.ok(
          validTargets.has(target),
          `${label} links to unknown ${href}`,
        );
      }
    }
  });

  test("does not publish links to known stale surfaces", () => {
    const combinedSql = [...expectedSources.values()].join("\n");
    assert.doesNotMatch(
      combinedSql,
      /\/dashboard\/promotions(?:[/#?'"\s<)]|$)/i,
      "Promotions is not a shipped dashboard route",
    );
    assert.doesNotMatch(
      combinedSql,
      /\/dashboard\/settings\/returns?(?:[/#?'"\s<)]|$)/i,
      "Returns does not have a shipped dashboard Settings route",
    );

    for (const article of newArticles) {
      for (const href of articleLinks(article)) {
        assert.doesNotMatch(
          new URL(href, "https://help.storemink.com").pathname,
          /^\/help\/[^/]+\/(?:returns?-settings|set-up-returns?-settings|configure-returns?-settings)\/?$/i,
          `${article.file}: ${article.slug} links to an unsupported Returns settings guide`,
        );
      }
    }
  });

  test("keeps release-gated and provider-dependent guidance truthful", () => {
    const gettingStarted = expectedSources.get(expectedMigrations[0]);
    const storefront = expectedSources.get(expectedMigrations[1]);
    const products = expectedSources.get(expectedMigrations[2]);
    const payments = expectedSources.get(expectedMigrations[3]);
    const orders = expectedSources.get(expectedMigrations[4]);
    const communications = expectedSources.get(expectedMigrations[5]);

    assert.match(
      gettingStarted,
      /cannot be changed by you or a store superadmin from the dashboard/i,
    );
    assert.match(
      gettingStarted,
      /does not prove a final carrier charge or handset delivery/i,
    );
    assert.match(
      gettingStarted,
      /Cost per unit appears only when the store is on Pro.*enabled gross-margin analytics/i,
    );
    assert.match(
      gettingStarted,
      /restricted staff member can open an order or cancellation.*contact StoreMink support/i,
    );
    assert.match(
      gettingStarted,
      /not narrowed to the staff member's assigned locations/i,
    );
    assert.doesNotMatch(gettingStarted, /quiet-hour behaviour/i);
    assert.match(products, /Logs → Import logs/);
    assert.match(products, /Logs → Export logs/);
    assert.match(
      products,
      /These resource pages provide both import and export/i,
    );
    assert.doesNotMatch(
      storefront,
      /image or video|images and videos|50 MB video/i,
    );
    assert.match(storefront, /best-effort cleanup/i);
    assert.match(storefront, /cannot edit DNS at the old provider/i);
    assert.match(
      products,
      /product-creation action does not yet enforce the published cap automatically/i,
    );
    assert.match(products, /does not provide a control to rearrange them/i);
    assert.match(
      products,
      /does not expose variant-specific shipping, weight, or dimension fields/i,
    );
    assert.match(products, /sold product cannot be deleted/i);
    assert.match(
      products,
      /Adding, selecting, or using a later address at checkout does not make it the default/i,
    );
    assert.match(
      products,
      /coupon's last selected group.*coupon becomes public/i,
    );
    assert.match(payments, /Verify &amp; save/);
    assert.match(payments, /Generate a webhook secret/);
    assert.match(
      payments,
      /Website checkout does not currently preserve the same split facts/i,
    );
    assert.match(
      payments,
      /current A4 reprint also reads the store's latest invoice template and business identity/i,
    );
    assert.match(payments, /Before the first live Razorpay refund/i);
    assert.match(
      payments,
      /does not automatically reinstate previously spent credit/i,
    );
    assert.match(
      orders,
      /Returns settings group that controls the store-wide policy is not currently rendered/i,
    );
    assert.match(
      orders,
      /POS return flow does not offer store credit as a refund destination/i,
    );
    assert.match(
      orders,
      /restricted staff can open an order or cancellation.*contact StoreMink support/i,
    );
    assert.match(
      orders,
      /current export carries the selected status and channel/i,
    );
    assert.match(
      orders,
      /current routing resolver does not subtract active reservations/i,
    );
    assert.match(orders, /substitutes 500 g and 10 × 10 × 5 cm defaults/i);
    assert.match(orders, /Before the first live Razorpay refund/i);
    assert.equal(
      newArticles.filter(
        (article) =>
          article.file === expectedMigrations[4] &&
          article.body.includes(
            "<strong>Controlled live verification required:</strong>",
          ),
      ).length,
      5,
    );
    assert.match(communications, /initial send result/i);
    assert.match(communications, /Current group-targeting safeguard/i);
    assert.match(
      communications,
      /does not rewrite the earlier Email log or campaign result/i,
    );
    assert.match(communications, /midnight UTC/i);
    assert.match(
      communications,
      /does not confirm delivery to the customer's phone/i,
    );
    assert.doesNotMatch(
      communications,
      /pending delivery report|delivery callback/i,
    );
    const communicationSlugs = newArticles
      .filter((article) => article.file === expectedMigrations[5])
      .map((article) => article.slug);
    assert.ok(!communicationSlugs.includes("read-sms-delivery-logs"));
    assert.ok(communicationSlugs.includes("read-sms-send-attempt-logs"));
    assert.equal(
      newArticles.filter(
        (article) =>
          article.file === expectedMigrations[5] &&
          article.body.includes(
            "<strong>Controlled live verification required:</strong>",
          ),
      ).length,
      4,
    );
  });
});

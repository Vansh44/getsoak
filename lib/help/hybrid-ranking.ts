/**
 * The minimum identity carried by either side of Help Centre retrieval.
 *
 * Article ids are the strongest alias, while slugs let an article-level
 * catalogue hit and a vector chunk still meet when one side did not select the
 * id. A candidate without either identity is ignored.
 */
export interface HelpRankCandidate {
  articleId?: string | null;
  articleSlug?: string | null;
  chunkId?: string | null;
}

export interface FuseHelpRankingsOptions {
  /** Reciprocal-rank constant. Sixty is the conventional RRF default. */
  rrfK?: number;
  /** Maximum articles to return. Lexical matches keep their places first. */
  limit?: number;
}

export interface FusedHelpArticle<
  Lexical extends HelpRankCandidate,
  Vector extends HelpRankCandidate,
> {
  articleId: string | null;
  articleSlug: string | null;
  score: number;
  lexicalRank: number | null;
  vectorRank: number | null;
  /** Highest-ranked catalogue/full-text evidence for this article. */
  bestLexical: Lexical | null;
  /** Highest-ranked semantic chunk for this article. */
  bestVector: Vector | null;
  /** Semantic chunks in rank order, deduplicated without losing evidence. */
  vectorChunks: Vector[];
}

type Source = "lexical" | "vector";

interface Occurrence<Candidate extends HelpRankCandidate> {
  source: Source;
  rank: number;
  sequence: number;
  candidate: Candidate;
  articleId: string | null;
  articleSlug: string | null;
  normalizedSlug: string | null;
  chunkId: string | null;
}

interface RankedGroup<
  Lexical extends HelpRankCandidate,
  Vector extends HelpRankCandidate,
> extends FusedHelpArticle<Lexical, Vector> {
  firstSeen: number;
  stableIdentity: string;
}

const DEFAULT_RRF_K = 60;

function cleanIdentity(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean || null;
}

function candidateOccurrence<Candidate extends HelpRankCandidate>(
  candidate: Candidate,
  source: Source,
  rank: number,
  sequence: number,
): Occurrence<Candidate> | null {
  const articleId = cleanIdentity(candidate.articleId);
  const articleSlug = cleanIdentity(candidate.articleSlug);
  if (!articleId && !articleSlug) return null;
  return {
    source,
    rank,
    sequence,
    candidate,
    articleId,
    articleSlug,
    normalizedSlug: articleSlug?.toLocaleLowerCase("en-US") ?? null,
    chunkId: cleanIdentity(candidate.chunkId),
  };
}

function compareRanks(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function compareGroups<
  Lexical extends HelpRankCandidate,
  Vector extends HelpRankCandidate,
>(
  left: RankedGroup<Lexical, Vector>,
  right: RankedGroup<Lexical, Vector>,
): number {
  if (left.score !== right.score) return right.score - left.score;

  const lexical = compareRanks(left.lexicalRank, right.lexicalRank);
  if (lexical !== 0) return lexical;

  const vector = compareRanks(left.vectorRank, right.vectorRank);
  if (vector !== 0) return vector;

  if (left.firstSeen !== right.firstSeen) {
    return left.firstSeen - right.firstSeen;
  }
  return left.stableIdentity.localeCompare(right.stableIdentity, "en-US");
}

function boundedLimit(limit: number | undefined, available: number): number {
  if (limit === undefined) return available;
  if (!Number.isFinite(limit)) return available;
  return Math.min(available, Math.max(0, Math.floor(limit)));
}

/**
 * Fuse ordered lexical/catalogue articles and ordered vector chunks with RRF.
 *
 * Each source contributes at most once per article, so an article split into
 * many vector chunks cannot win merely by repetition. All of its distinct
 * chunks are nevertheless retained for downstream grounding. When `limit` is
 * set, existing lexical matches are selected before vector-only additions;
 * semantic retrieval can reinforce and reorder them, but cannot silently
 * evict a lexical result.
 */
export function fuseHelpRankings<
  Lexical extends HelpRankCandidate,
  Vector extends HelpRankCandidate,
>(
  lexical: readonly Lexical[],
  vector: readonly Vector[],
  options: FuseHelpRankingsOptions = {},
): FusedHelpArticle<Lexical, Vector>[] {
  const occurrences: Occurrence<Lexical | Vector>[] = [];

  lexical.forEach((candidate, index) => {
    const occurrence = candidateOccurrence(
      candidate,
      "lexical",
      index + 1,
      occurrences.length,
    );
    if (occurrence) occurrences.push(occurrence);
  });
  vector.forEach((candidate, index) => {
    const occurrence = candidateOccurrence(
      candidate,
      "vector",
      index + 1,
      occurrences.length,
    );
    if (occurrence) occurrences.push(occurrence);
  });

  if (occurrences.length === 0) return [];

  // Union aliases rather than choosing only id OR slug as the key. This joins
  // `id only` -> `id + slug` -> `slug only` candidates into one article.
  const parent = occurrences.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    // The lower sequence is always the root, giving ties a stable input-order
    // identity even when a later bridge candidate joins two alias groups.
    if (leftRoot < rightRoot) parent[rightRoot] = leftRoot;
    else parent[leftRoot] = rightRoot;
  };

  const articleIds = new Map<string, number>();
  const articleSlugs = new Map<string, number>();
  occurrences.forEach((occurrence, index) => {
    if (occurrence.articleId) {
      const previous = articleIds.get(occurrence.articleId);
      if (previous !== undefined) union(index, previous);
      else articleIds.set(occurrence.articleId, index);
    }
    if (occurrence.normalizedSlug) {
      const previous = articleSlugs.get(occurrence.normalizedSlug);
      if (previous !== undefined) union(index, previous);
      else articleSlugs.set(occurrence.normalizedSlug, index);
    }
  });

  const grouped = new Map<number, Occurrence<Lexical | Vector>[]>();
  occurrences.forEach((occurrence, index) => {
    const root = find(index);
    const group = grouped.get(root);
    if (group) group.push(occurrence);
    else grouped.set(root, [occurrence]);
  });

  const configuredK = options.rrfK;
  const rrfK =
    configuredK !== undefined &&
    Number.isFinite(configuredK) &&
    configuredK >= 0
      ? configuredK
      : DEFAULT_RRF_K;

  const ranked: RankedGroup<Lexical, Vector>[] = [];
  for (const group of grouped.values()) {
    const first = group[0];
    const lexicalOccurrences = group.filter(
      (occurrence) => occurrence.source === "lexical",
    ) as Occurrence<Lexical>[];
    const vectorOccurrences = group.filter(
      (occurrence) => occurrence.source === "vector",
    ) as Occurrence<Vector>[];
    const lexicalRank = lexicalOccurrences[0]?.rank ?? null;
    const vectorRank = vectorOccurrences[0]?.rank ?? null;

    const vectorChunks: Vector[] = [];
    const seenChunkIds = new Set<string>();
    const seenUnkeyedChunks = new Set<Vector>();
    for (const occurrence of vectorOccurrences) {
      if (occurrence.chunkId) {
        if (seenChunkIds.has(occurrence.chunkId)) continue;
        seenChunkIds.add(occurrence.chunkId);
      } else {
        // A vector adapter should normally expose chunkId. When it cannot, do
        // not throw away distinct objects, but still collapse the exact same
        // candidate if an upstream ranker accidentally repeats it.
        if (seenUnkeyedChunks.has(occurrence.candidate)) continue;
        seenUnkeyedChunks.add(occurrence.candidate);
      }
      vectorChunks.push(occurrence.candidate);
    }

    const articleId =
      group.find((occurrence) => occurrence.articleId)?.articleId ?? null;
    const articleSlug =
      group.find((occurrence) => occurrence.articleSlug)?.articleSlug ?? null;
    const score =
      (lexicalRank === null ? 0 : 1 / (rrfK + lexicalRank)) +
      (vectorRank === null ? 0 : 1 / (rrfK + vectorRank));
    const stableIdentity = articleSlug
      ? `slug:${articleSlug.toLocaleLowerCase("en-US")}`
      : `id:${articleId ?? first.sequence}`;

    ranked.push({
      articleId,
      articleSlug,
      score,
      lexicalRank,
      vectorRank,
      bestLexical: lexicalOccurrences[0]?.candidate ?? null,
      bestVector: vectorChunks[0] ?? null,
      vectorChunks,
      firstSeen: first.sequence,
      stableIdentity,
    });
  }

  ranked.sort(compareGroups);
  const limit = boundedLimit(options.limit, ranked.length);
  if (limit === ranked.length) return ranked;
  if (limit === 0) return [];

  // Reserve the bounded result set for lexical matches first. Vector-only
  // articles then fill spare capacity in fused order. Sorting the selected set
  // by fused score still lets semantic agreement improve the final ordering.
  const selected = new Set<RankedGroup<Lexical, Vector>>();
  ranked
    .filter((article) => article.lexicalRank !== null)
    .sort(
      (left, right) =>
        compareRanks(left.lexicalRank, right.lexicalRank) ||
        left.firstSeen - right.firstSeen,
    )
    .slice(0, limit)
    .forEach((article) => selected.add(article));

  for (const article of ranked) {
    if (selected.size >= limit) break;
    selected.add(article);
  }

  return ranked.filter((article) => selected.has(article));
}

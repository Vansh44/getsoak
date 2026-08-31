import { Fragment, type ReactNode } from "react";

/**
 * Render Mink's safe, presentation-focused Markdown subset without accepting
 * raw HTML. React escapes all model text; links pass a narrow StoreMink
 * allowlist before they become anchors.
 */
export function MinkAnswer({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words text-[14px] leading-6 text-[#202123]">
      {renderMinkBlocks(text)}
    </div>
  );
}

function renderMinkBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([\w-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(
        <div
          key={`code-${index}`}
          className="my-3 overflow-hidden rounded-xl border border-[#dedfe2] bg-[#202123]"
        >
          {fence[1] ? (
            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] text-white/60">
              {fence[1]}
            </div>
          ) : null}
          <pre className="overflow-x-auto p-3 text-xs leading-5 text-[#f7f7f8]">
            <code>{body.join("\n")}</code>
          </pre>
        </div>,
      );
      continue;
    }

    const heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const className =
        level === 1
          ? "mb-2 mt-5 text-lg font-semibold"
          : level === 2
            ? "mb-1.5 mt-4 text-base font-semibold"
            : "mb-1 mt-3 text-sm font-semibold";
      nodes.push(
        <div key={`heading-${index}`} className={className}>
          {renderMinkInlineMarkdown(heading[2], `heading-${index}`)}
        </div>,
      );
      index += 1;
      continue;
    }

    if (/^\s*(---+|___+)\s*$/.test(line)) {
      nodes.push(
        <hr
          key={`rule-${index}`}
          className="my-4 border-0 border-t border-[#e5e5e7]"
        />,
      );
      index += 1;
      continue;
    }

    if (isTableHeader(lines, index)) {
      const headers = tableCells(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|")) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      nodes.push(
        <div
          key={`table-${index}`}
          className="my-3 overflow-x-auto rounded-xl border border-[#dedfe2]"
        >
          <table className="w-full min-w-[420px] border-collapse text-left text-xs">
            <thead className="bg-[#f7f7f8]">
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th
                    key={cellIndex}
                    className="border-b border-[#dedfe2] px-3 py-2 font-semibold text-[#343438]"
                  >
                    {renderMinkInlineMarkdown(cell, `th-${index}-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#eeeeef]">
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_header, cellIndex) => (
                    <td key={cellIndex} className="px-3 py-2 align-top">
                      {renderMinkInlineMarkdown(
                        row[cellIndex] ?? "",
                        `td-${index}-${rowIndex}-${cellIndex}`,
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const list = line.match(/^\s*([-*+]|\d+\.)\s+(.+)$/);
    if (list) {
      const ordered = /\d+\./.test(list[1]);
      const items: Array<{ text: string; details: string[] }> = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-*+]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[1]) !== ordered) break;
        const current = { text: item[2], details: [] as string[] };
        index += 1;
        while (
          index < lines.length &&
          /^\s{2,}([-*+]\s+)?\S/.test(lines[index])
        ) {
          current.details.push(
            lines[index].replace(/^\s+[-*+]?\s*/, "").trim(),
          );
          index += 1;
        }
        items.push(current);
      }
      const List = ordered ? "ol" : "ul";
      nodes.push(
        <List
          key={`list-${index}`}
          className={`my-2 space-y-1 pl-6 ${ordered ? "list-decimal" : "list-disc"}`}
        >
          {items.map((item, itemIndex) => (
            <li key={itemIndex} className="pl-1 marker:text-[#8c9196]">
              {renderMinkInlineMarkdown(item.text, `li-${index}-${itemIndex}`)}
              {item.details.length ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[#4b4b50]">
                  {item.details.map((detail, detailIndex) => (
                    <li key={detailIndex}>
                      {renderMinkInlineMarkdown(
                        detail,
                        `detail-${index}-${itemIndex}-${detailIndex}`,
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </List>,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      nodes.push(
        <blockquote
          key={`quote-${index}`}
          className="my-3 border-l-2 border-[#cfc4ff] pl-3 text-[#57575d]"
        >
          {renderMinkInlineMarkdown(quote.join(" "), `quote-${index}`)}
        </blockquote>,
      );
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !startsMinkBlock(lines, index)
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    nodes.push(
      <p key={`paragraph-${index}`} className="my-2 first:mt-0 last:mb-0">
        {renderMinkInlineMarkdown(paragraph.join(" "), `p-${index}`)}
      </p>,
    );
  }

  return nodes;
}

export function renderMinkInlineMarkdown(
  text: string,
  keyPrefix = "inline",
): ReactNode[] {
  const pattern =
    /(\[[^\]\n]+\]\([^\n)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let tokenIndex = 0;

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(
        <Fragment key={`${keyPrefix}-text-${tokenIndex}`}>
          {text.slice(cursor, match.index)}
        </Fragment>,
      );
    }
    const token = match[0];
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = safeMinkAnswerHref(link[2]);
      nodes.push(
        href ? (
          <a
            key={`${keyPrefix}-link-${tokenIndex}`}
            href={href}
            {...(href.startsWith("/")
              ? {}
              : { target: "_blank", rel: "noopener noreferrer" })}
            className="font-medium text-[#5b3fd0] underline decoration-[#cfc4ff] underline-offset-2 hover:decoration-[#5b3fd0]"
          >
            {renderMinkInlineMarkdown(
              link[1],
              `${keyPrefix}-label-${tokenIndex}`,
            )}
          </a>
        ) : (
          <Fragment key={`${keyPrefix}-unsafe-link-${tokenIndex}`}>
            {link[1]}
          </Fragment>
        ),
      );
    } else if (
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"))
    ) {
      nodes.push(
        <strong
          key={`${keyPrefix}-strong-${tokenIndex}`}
          className="font-semibold"
        >
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <code
          key={`${keyPrefix}-code-${tokenIndex}`}
          className="rounded-md bg-[#ececef] px-1.5 py-0.5 font-mono text-[0.9em] text-[#303034]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    cursor = match.index + token.length;
    tokenIndex += 1;
  }
  if (cursor < text.length) {
    nodes.push(
      <Fragment key={`${keyPrefix}-tail`}>{text.slice(cursor)}</Fragment>,
    );
  }
  return nodes;
}

function startsMinkBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  return (
    /^\s*```/.test(line) ||
    /^\s*#{1,3}\s+/.test(line) ||
    /^\s*(---+|___+)\s*$/.test(line) ||
    /^\s*([-*+]|\d+\.)\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    isTableHeader(lines, index)
  );
}

function isTableHeader(lines: string[], index: number): boolean {
  if (!lines[index]?.includes("|") || !lines[index + 1]?.includes("|")) {
    return false;
  }
  const separators = tableCells(lines[index + 1]);
  return (
    separators.length > 0 &&
    separators.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function safeMinkAnswerHref(value: string): string | null {
  const href = value.trim();
  if (!href || href.includes("\\") || /[\u0000-\u001F\u007F]/.test(href)) {
    return null;
  }
  if (href.startsWith("/")) {
    if (href.startsWith("//")) return null;
    try {
      const url = new URL(href, "https://dashboard.storemink.invalid");
      return url.pathname === "/dashboard" ||
        url.pathname.startsWith("/dashboard/")
        ? `${url.pathname}${url.search}${url.hash}`
        : null;
    } catch {
      return null;
    }
  }
  try {
    const url = new URL(href);
    const helpHost =
      url.hostname === "help.storemink.com" ||
      (url.hostname.startsWith("help.") &&
        url.hostname.endsWith(".storemink.com"));
    return url.protocol === "https:" && helpHost ? url.toString() : null;
  } catch {
    return null;
  }
}

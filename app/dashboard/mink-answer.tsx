import { Fragment, type ReactNode } from "react";

/**
 * Render the small safe Markdown subset Mink currently emits. React owns every
 * node, so model text can never become raw HTML. Whitespace remains intact for
 * short paragraphs/lists while bold/code markers render instead of leaking.
 */
export function MinkAnswer({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap break-words leading-relaxed">
      {renderMinkInlineMarkdown(text)}
    </div>
  );
}

export function renderMinkInlineMarkdown(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`)/g);
  return tokens.filter(Boolean).map((token, index) => {
    if (
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"))
    ) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return (
        <code
          key={index}
          className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[0.92em]"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={index}>{token}</Fragment>;
  });
}

import { describe, expect, it } from "vitest";
import { peopleHref } from "./people-links";

describe("peopleHref", () => {
  it("returns the bare path when nothing is filtered", () => {
    expect(peopleHref({})).toBe("/dashboard/people");
    expect(peopleHref({ q: "", kind: "", store: "", page: 1 })).toBe(
      "/dashboard/people",
    );
  });

  // The bug this whole module exists to prevent: a page link that forgets the
  // search turns a filtered list into an unfiltered one that still looks
  // filtered.
  it("carries every other filter through a page change", () => {
    const href = peopleHref(
      { q: "asha", kind: "pos", store: "store-1", page: 1 },
      { page: 3 },
    );
    expect(href).toContain("q=asha");
    expect(href).toContain("kind=pos");
    expect(href).toContain("store=store-1");
    expect(href).toContain("page=3");
  });

  it("carries the search and store through a kind change", () => {
    const href = peopleHref(
      { q: "asha", kind: "admin", store: "store-1", page: 4 },
      { kind: "pos", page: 1 },
    );
    expect(href).toContain("q=asha");
    expect(href).toContain("store=store-1");
    expect(href).toContain("kind=pos");
    // Switching filter must reset paging — a term matching four people has no
    // page 4, and landing on an empty screen reads as "no results".
    expect(href).not.toContain("page=");
  });

  it("omits page 1 rather than serialising a default", () => {
    expect(peopleHref({ q: "a", page: 1 })).toBe("/dashboard/people?q=a");
  });

  it("clears a filter when overridden with an empty string", () => {
    // How the "Everyone" chip drops `kind`.
    const href = peopleHref({ q: "a", kind: "pos" }, { kind: "" });
    expect(href).toBe("/dashboard/people?q=a");
  });

  it("escapes terms that would otherwise break the query string", () => {
    const href = peopleHref({ q: "a&b=c d" });
    expect(href).toBe("/dashboard/people?q=a%26b%3Dc+d");
    // Round-trips: the page reads it back with the same term.
    const parsed = new URLSearchParams(href.split("?")[1]);
    expect(parsed.get("q")).toBe("a&b=c d");
  });
});

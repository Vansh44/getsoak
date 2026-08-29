import { describe, expect, it } from "vitest";
import {
  clampMinkPanelWidth,
  minkComposerHeight,
  shouldSubmitMinkComposer,
} from "./dashboard-chat";

describe("clampMinkPanelWidth", () => {
  it("keeps desktop resizing within the usable dashboard range", () => {
    expect(clampMinkPanelWidth(100, 1920)).toBe(320);
    expect(clampMinkPanelWidth(900, 1920)).toBe(720);
    expect(clampMinkPanelWidth(512, 1920)).toBe(512);
  });

  it("keeps the overlay inside a small viewport", () => {
    expect(clampMinkPanelWidth(720, 390)).toBe(358);
    expect(clampMinkPanelWidth(100, 300)).toBe(276);
  });
});

describe("Mink composer", () => {
  it("grows with wrapped content and caps before becoming scrollable", () => {
    expect(minkComposerHeight(8)).toBe(24);
    expect(minkComposerHeight(96.2)).toBe(97);
    expect(minkComposerHeight(400)).toBe(160);
  });

  it("submits on Enter while preserving Shift+Enter and IME composition", () => {
    expect(
      shouldSubmitMinkComposer({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
      }),
    ).toBe(true);
    expect(
      shouldSubmitMinkComposer({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
      }),
    ).toBe(false);
    expect(
      shouldSubmitMinkComposer({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
      }),
    ).toBe(false);
  });
});

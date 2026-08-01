import { describe, it, expect, vi, afterEach } from "vitest";
import { createScanGate } from "./barcode-camera";

afterEach(() => vi.useRealTimers());

// The camera sees the same barcode ~10×/second. Without the gate, holding one
// item in front of the lens would ring it up dozens of times.
describe("createScanGate", () => {
  it("accepts the first sighting of a code", () => {
    const gate = createScanGate();
    expect(gate("890123456789")).toBe(true);
  });

  it("suppresses the same code inside the cooldown", () => {
    const gate = createScanGate(1500);
    expect(gate("A")).toBe(true);
    expect(gate("A")).toBe(false);
    expect(gate("A")).toBe(false);
  });

  it("lets a DIFFERENT code through immediately", () => {
    const gate = createScanGate(1500);
    expect(gate("A")).toBe(true);
    // Scanning a second item must not wait out the first item's cooldown.
    expect(gate("B")).toBe(true);
    expect(gate("B")).toBe(false);
  });

  it("re-accepts the same code once the cooldown lapses", () => {
    vi.useFakeTimers();
    const gate = createScanGate(1500);
    expect(gate("A")).toBe(true);
    vi.advanceTimersByTime(1600);
    // Deliberate: scanning the same item twice means the customer has two.
    expect(gate("A")).toBe(true);
  });
});

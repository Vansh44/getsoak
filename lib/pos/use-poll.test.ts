import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePoll, POS_POLL_MS } from "./use-poll";

// ---------------------------------------------------------------------------
// The register's refresh mechanism, used by four screens (the pickup badge, the
// pickup queue, the stock list and the catalog sync). What is pinned here is
// the behaviour that makes it dependable rather than merely periodic: it stops
// when the till is not being looked at, stops when the network is gone, and
// CATCHES UP the instant either comes back.
// ---------------------------------------------------------------------------

let visibility: DocumentVisibilityState = "visible";
let online = true;

function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}
function setOnline(v: boolean) {
  online = v;
  window.dispatchEvent(new Event(v ? "online" : "offline"));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePoll", () => {
  // ★ MOUNT IS NOT A CATCH-UP. The server has just rendered this screen, so
  // firing immediately would be a wasted round-trip on every navigation.
  it("does not fire on mount", () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn, 1000));
    expect(fn).not.toHaveBeenCalled();
  });

  it("fires on the interval", () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn, 1000));
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("defaults to the shared POS interval", () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn));
    vi.advanceTimersByTime(POS_POLL_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops entirely when disabled, and resumes when re-enabled", () => {
    const fn = vi.fn();
    const { rerender } = renderHook(
      ({ on }: { on: boolean }) => usePoll(fn, 1000, on),
      { initialProps: { on: false } },
    );
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();

    rerender({ on: true });
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ★ A till is left open all night and browsers keep background timers
  // running. Without this every closed shop spends the small hours making
  // requests nobody will read.
  describe("visibility", () => {
    it("stops while the tab is hidden", () => {
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      setVisibility("hidden");
      vi.advanceTimersByTime(5000);
      expect(fn).not.toHaveBeenCalled();
    });

    it("★ catches up the moment the tab is visible again", () => {
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      setVisibility("hidden");
      vi.advanceTimersByTime(5000);
      setVisibility("visible");
      // Immediately, not after another full interval: someone walking back to
      // the till expects the screen to be true now.
      expect(fn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("never starts while mounted hidden", () => {
      visibility = "hidden";
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      vi.advanceTimersByTime(5000);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // ★ Shop wifi drops. A bare interval keeps firing into a dead network, each
  // call failing silently — and the first attempt after it returns is up to a
  // full interval away, so the screen stays wrong long after the connection is
  // back.
  describe("network", () => {
    it("stops while offline", () => {
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      setOnline(false);
      vi.advanceTimersByTime(5000);
      expect(fn).not.toHaveBeenCalled();
    });

    it("★ catches up the moment the network returns", () => {
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      setOnline(false);
      vi.advanceTimersByTime(5000);
      setOnline(true);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    // ★★ THESE TWO ARE WHAT `navigator.onLine` IS FOR, and they are the only
    // ones that catch its removal. "Stops while offline" above passes either
    // way, because the `offline` EVENT clears the timer directly — so without
    // these the gate could be deleted and the suite would stay green.
    it("never starts when mounted while already offline", () => {
      online = false;
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      vi.advanceTimersByTime(5000);
      expect(fn).not.toHaveBeenCalled();
    });

    it("does not start on becoming visible while still offline", () => {
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      online = false;
      setVisibility("hidden");
      setVisibility("visible");
      // No catch-up and no timer: the tab is being looked at, but a request
      // could only fail.
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);
      expect(fn).not.toHaveBeenCalled();
    });

    it("stays stopped if the tab is hidden when the network returns", () => {
      const fn = vi.fn();
      renderHook(() => usePoll(fn, 1000));
      setVisibility("hidden");
      setOnline(false);
      setOnline(true);
      vi.advanceTimersByTime(5000);
      // Both gates have to be open. Coming back online in a background tab is
      // not a reason to start making requests.
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // ★ A flapping connection must not leave two timers running against one
  // screen — that is how a poll silently doubles its request rate.
  it("never stacks intervals", () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn, 1000));
    for (let i = 0; i < 5; i++) {
      setOnline(false);
      setOnline(true);
    }
    fn.mockClear();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops on unmount", () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => usePoll(fn, 1000));
    unmount();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  // ★ The latest callback runs WITHOUT restarting the timer. A poll that resets
  // whenever its closure changes is a poll that may never fire — and these
  // callbacks close over search text and filters, which change constantly.
  it("uses the latest callback without resetting the interval", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ fn }: { fn: () => void }) => usePoll(fn, 1000),
      { initialProps: { fn: first } },
    );
    vi.advanceTimersByTime(900);
    rerender({ fn: second });
    vi.advanceTimersByTime(100);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

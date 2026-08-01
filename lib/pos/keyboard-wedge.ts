// A hardware barcode scanner IS a keyboard: it types the code, then presses
// Enter. The register's default way in is therefore a focused search box
// (§22) — but that cannot be the ONLY way in, because on a touch device it is
// actively harmful. Returning focus to the box after every tap is what makes
// iPadOS re-open the software keyboard over half the till: tap a product, get a
// keyboard.
//
// So a scan must also land with NOTHING focused. This is the pure state machine
// behind that: feed it keys, get a code back when a burst of characters ends in
// Enter. No DOM and no timers, so the timing rules are testable.
//
// It is not a heuristic for telling a scanner apart from a human — the caller
// only feeds it keys that arrived while no editable element had focus, and in
// that state a human cannot type anything anyway. The gap rule exists so stray
// keypresses minutes apart can't accumulate into one nonsense "barcode".

export interface WedgeOptions {
  /** Shorter bursts are ignored — a one-character stray + Enter is not a scan. */
  minLength?: number;
  /** A fresh burst starts when this long has passed since the last character.
   *  HID scanners emit characters a few ms apart; Bluetooth ones are slower but
   *  nowhere near this. */
  gapMs?: number;
  /** Hard cap so a stuck key can't grow the buffer without bound. */
  maxLength?: number;
}

export type WedgeResult =
  /** Not part of a scan — the caller should let the key through untouched. */
  | { type: "ignored" }
  /** Part of a burst in progress. */
  | { type: "buffered" }
  /** A complete code. */
  | { type: "scan"; code: string };

export interface KeyboardWedge {
  handleKey(key: string, at: number): WedgeResult;
  reset(): void;
}

export function createKeyboardWedge(opts: WedgeOptions = {}): KeyboardWedge {
  const minLength = opts.minLength ?? 3;
  const gapMs = opts.gapMs ?? 250;
  const maxLength = opts.maxLength ?? 64;

  let buffer = "";
  let lastAt = 0;
  let started = false;

  const reset = () => {
    buffer = "";
    started = false;
  };

  return {
    reset,
    handleKey(key, at) {
      if (key === "Enter") {
        const code = buffer;
        reset();
        return code.length >= minLength
          ? { type: "scan", code }
          : { type: "ignored" };
      }
      // Anything that isn't a single printable character (Escape, Tab, Shift,
      // an arrow key) means whatever was being typed wasn't a barcode.
      if (key.length !== 1) {
        reset();
        return { type: "ignored" };
      }
      if (!started || at - lastAt > gapMs) buffer = "";
      started = true;
      lastAt = at;
      if (buffer.length < maxLength) buffer += key;
      return { type: "buffered" };
    },
  };
}

/**
 * Would this key have gone somewhere the user can see? When it would, the wedge
 * must keep out of the way: on a desktop the search box holds focus and IS the
 * scan target, and swallowing its keystrokes would break typing a search.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable === true
  );
}

/**
 * A touch-primary device — an iPad on the counter, not a laptop with a
 * touchscreen. `pointer: coarse` alone is true of a touch-capable laptop whose
 * cashier is using a mouse; pairing it with `hover: none` keeps sticky focus
 * (and its zero-click scanning) on every device that has a real keyboard.
 */
export const TOUCH_PRIMARY_QUERY = "(hover: none) and (pointer: coarse)";

export function isTouchPrimary(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(TOUCH_PRIMARY_QUERY).matches;
}

/** Subscribe shape for `useSyncExternalStore` — a tablet can gain a keyboard. */
export function subscribeTouchPrimary(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(TOUCH_PRIMARY_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

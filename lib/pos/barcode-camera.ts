// Camera barcode scanning for the register (phones + tablets without a
// hardware scanner).
//
// ENGINE SEAM: detection is abstracted behind `createBarcodeReader()` so the
// engine can change without touching the UI. Today that's the browser-native
// BarcodeDetector — zero bundle cost, hardware-accelerated. It is NOT universal:
//
//   Android Chrome / Edge   ✅
//   Desktop Chrome          ✅ (recent versions)
//   Safari (iOS + iPadOS)   ❌  ← an iPad shop device cannot scan by camera
//   Firefox                 ❌
//
// A WASM fallback (e.g. lazy-loaded @zxing/browser) slots in behind this same
// interface when that coverage isn't enough — see docs/pos-plan.md.
//
// Client-only: everything here touches browser APIs.

/** Symbologies a retail POS actually meets: EAN/UPC on packaging, Code128 on
 *  shelf/warehouse labels, plus QR for the odd promo. */
const FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "itf",
  "qr_code",
] as const;

interface NativeBarcodeDetector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: readonly string[] }): NativeBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

function nativeCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const C = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
    .BarcodeDetector;
  return typeof C === "function" ? C : null;
}

/**
 * Can this browser scan by camera? Only a camera is required — decoding always
 * has an engine, native or the WASM fallback below. Safari/iPadOS answers YES
 * here even though it has no BarcodeDetector.
 */
export function isCameraScanSupported(): boolean {
  return (
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia
  );
}

/** Why scanning is unavailable, phrased for a cashier rather than a developer. */
export function cameraScanUnavailableReason(): string | null {
  if (typeof window === "undefined") return null;
  if (!navigator.mediaDevices?.getUserMedia) {
    // getUserMedia is gated on a secure context — plain http:// on a LAN IP is
    // the usual culprit when testing on a phone.
    return window.isSecureContext
      ? "This browser can't use the camera. Use a USB/Bluetooth scanner, or search by name."
      : "Camera scanning needs a secure (https) connection.";
  }
  return null;
}

export interface BarcodeReader {
  /** One frame → a barcode value, or null. */
  detect(source: CanvasImageSource): Promise<string | null>;
  /** Which engine served this session — surfaced for diagnostics. */
  engine: "native" | "wasm";
}

/**
 * Only the CENTRE BAND of the frame is decoded, matching the on-screen aiming
 * rectangle. Two wins: the JS decoder does ~6× less work (it runs on the main
 * thread, so full-frame decoding janks an older iPad), and background clutter
 * can't produce a stray read.
 */
const CROP = { widthFraction: 0.8, heightFraction: 0.35 };

function cropFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): HTMLCanvasElement | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const cw = Math.round(vw * CROP.widthFraction);
  const ch = Math.round(vh * CROP.heightFraction);
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(
    video,
    Math.round((vw - cw) / 2),
    Math.round((vh - ch) / 2),
    cw,
    ch,
    0,
    0,
    cw,
    ch,
  );
  return canvas;
}

/**
 * Build a reader for this browser. Native BarcodeDetector when present (zero
 * bundle, hardware-accelerated); otherwise the zxing WASM decoder is imported
 * ON DEMAND — Safari/iPadOS has no BarcodeDetector, and every iOS browser
 * (including Chrome) is WebKit underneath, so without this an iPad simply
 * couldn't scan. The dynamic import keeps that cost off the register's initial
 * load: it's paid only when a cashier actually opens the camera.
 */
export async function createBarcodeReader(): Promise<BarcodeReader | null> {
  const C = nativeCtor();
  if (C) {
    const detector = new C({ formats: FORMATS });
    return {
      engine: "native",
      async detect(source) {
        try {
          const found = await detector.detect(source);
          const value = found?.[0]?.rawValue?.trim();
          return value ? value : null;
        } catch {
          // A transient decode failure is normal between frames — never throw
          // into the scan loop.
          return null;
        }
      },
    };
  }

  try {
    const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] =
      await Promise.all([import("@zxing/browser"), import("@zxing/library")]);

    // Restricting the symbology set materially speeds up the JS decoder.
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.ITF,
      BarcodeFormat.QR_CODE,
    ]);
    const reader = new BrowserMultiFormatReader(hints);
    const canvas = document.createElement("canvas");

    return {
      engine: "wasm",
      async detect(source) {
        const frame = cropFrame(source as HTMLVideoElement, canvas);
        if (!frame) return null;
        try {
          const result = reader.decodeFromCanvas(frame);
          const value = result?.getText()?.trim();
          return value ? value : null;
        } catch {
          // zxing throws NotFoundException on every frame WITHOUT a barcode —
          // that's the normal case, not an error.
          return null;
        }
      },
    };
  } catch {
    return null;
  }
}

/** Rear camera at a resolution high enough to resolve a barcode's bars. */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
  audio: false,
};

/**
 * Suppress repeats: a camera sees the same barcode many times a second, so
 * without this one physical item would be rung up dozens of times. Distinct
 * codes still scan back-to-back with no wait.
 */
export function createScanGate(cooldownMs = 1500) {
  let lastValue: string | null = null;
  let lastAt = 0;
  return (value: string): boolean => {
    const now = Date.now();
    if (value === lastValue && now - lastAt < cooldownMs) return false;
    lastValue = value;
    lastAt = now;
    return true;
  };
}

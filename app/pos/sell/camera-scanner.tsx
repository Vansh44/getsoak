"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Camera, Loader2, X, Zap, ZapOff } from "lucide-react";
import {
  CAMERA_CONSTRAINTS,
  cameraScanUnavailableReason,
  createBarcodeReader,
  createScanGate,
} from "@/lib/pos/barcode-camera";

// Camera scanning for phones/tablets with no hardware scanner.
//
// Stays OPEN after a hit so the cashier can scan a whole basket without
// reopening; each accepted scan flashes and (where supported) vibrates, because
// on a phone there's no scanner "beep" to confirm the read.

/** Capability is fixed for the life of the page — nothing to subscribe to. */
const subscribeNever = () => () => {};

const SCAN_INTERVAL_MS = 100; // ~10 fps — plenty for barcodes, easy on battery
/** zxing decodes in JS on the main thread; ~4 fps keeps the preview smooth. */
const WASM_SCAN_INTERVAL_MS = 250;

export function CameraScanner({
  onScan,
  onClose,
}: {
  onScan: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [torchable, setTorchable] = useState(false);
  const [lastCode, setLastCode] = useState<string | null>(null);

  // Derived during render, not set from inside the effect: capability is a
  // pure client fact, and setting it synchronously in an effect would trigger a
  // cascading render. `() => null` is the server snapshot so hydration matches.
  const unavailable = useSyncExternalStore(
    subscribeNever,
    cameraScanUnavailableReason,
    () => null,
  );

  useEffect(() => {
    if (unavailable) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const gate = createScanGate();

    const tick = async (
      reader: Awaited<ReturnType<typeof createBarcodeReader>>,
      intervalMs: number,
    ) => {
      const video = videoRef.current;
      if (cancelled || !reader) return;
      if (!video || video.readyState < 2) {
        timer = setTimeout(() => void tick(reader, intervalMs), intervalMs);
        return;
      }
      const code = await reader.detect(video);
      if (cancelled) return;
      if (code && gate(code)) {
        setLastCode(code);
        setFlash(true);
        setTimeout(() => setFlash(false), 180);
        // A phone has no scanner beep — a short buzz is the confirmation.
        navigator.vibrate?.(40);
        onScan(code);
      }
      timer = setTimeout(() => void tick(reader, intervalMs), intervalMs);
    };

    void (async () => {
      try {
        // Resolve the engine BEFORE asking for the camera, so the zxing chunk
        // downloads while the permission prompt is on screen rather than after.
        const reader = await createBarcodeReader();
        if (cancelled) return;
        if (!reader) {
          setStarting(false);
          setError("This browser can't scan barcodes with the camera.");
          return;
        }

        const stream =
          await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        const track = stream.getVideoTracks()[0];
        const caps = track?.getCapabilities?.() as
          | { torch?: boolean }
          | undefined;
        setTorchable(!!caps?.torch);
        setStarting(false);
        // The WASM decoder runs on the main thread, so scan it less often —
        // hammering it at 10fps janks the video preview on older tablets.
        // Native detection is hardware-accelerated and can keep up.
        void tick(
          reader,
          reader.engine === "native" ? SCAN_INTERVAL_MS : WASM_SCAN_INTERVAL_MS,
        );
      } catch (err) {
        if (cancelled) return;
        setStarting(false);
        const name = (err as { name?: string })?.name;
        setError(
          name === "NotAllowedError"
            ? "Camera access was blocked. Allow it in your browser settings to scan."
            : name === "NotFoundError"
              ? "No camera found on this device."
              : "Couldn't start the camera.",
        );
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // Always release the camera — a live track keeps the indicator on and
      // drains the battery.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [onScan, unavailable]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        advanced: [{ torch: !torchOn } as MediaTrackConstraintSet],
      });
      setTorchOn((t) => !t);
    } catch {
      setTorchable(false);
    }
  };

  return (
    // Full-bleed on a phone (how every scanning app behaves, and the camera is
    // the whole task there); a contained card from `sm` up, where swallowing a
    // 27" display to show a webcam is absurd and hides the cart behind it.
    <div className="fixed inset-0 z-50 flex flex-col bg-black sm:items-center sm:justify-center sm:bg-black/80 sm:p-6">
      <div className="flex h-full w-full flex-col overflow-hidden bg-black sm:h-[560px] sm:max-h-[90vh] sm:max-w-md sm:rounded-2xl sm:border sm:border-[var(--pos-border)] sm:shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 text-[var(--pos-ink)]">
          <div className="flex items-center gap-2 font-semibold">
            <Camera className="h-5 w-5" strokeWidth={2} />
            Scan barcode
          </div>
          <div className="flex items-center gap-2">
            {torchable && (
              <button
                type="button"
                onClick={toggleTorch}
                className="rounded-lg bg-[var(--pos-surface-2)] p-2 hover:bg-[var(--pos-surface-3)]"
                aria-label={torchOn ? "Turn off light" : "Turn on light"}
              >
                {torchOn ? (
                  <Zap className="h-5 w-5" />
                ) : (
                  <ZapOff className="h-5 w-5" />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-[var(--pos-surface-2)] p-2 hover:bg-[var(--pos-surface-3)]"
              aria-label="Close scanner"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Takes whatever height is left. Deliberately NOT a fixed aspect
            ratio: on a short window that pushed the footer off-screen, and the
            footer is where the "Added · code" scan confirmation appears. */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="h-full w-full object-cover"
          />

          {/* Aiming guide — only while there is actually a picture to aim.
              Left up during the error state it shows through the message and
              reads as a broken layout. */}
          {!starting && !error && !unavailable && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className={`h-28 w-[78%] max-w-sm rounded-2xl border-4 transition-colors sm:h-24 ${
                  flash
                    ? "border-emerald-400 bg-emerald-400/20"
                    : "border-white/70"
                }`}
              />
            </div>
          )}

          {starting && !unavailable && !error && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-[var(--pos-ink)]">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}

          {(error || unavailable) && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-6 text-center">
              <div className="max-w-sm">
                <p className="text-[var(--pos-ink)]">{error ?? unavailable}</p>
                <button
                  type="button"
                  onClick={onClose}
                  className="mt-4 rounded-lg bg-[var(--pos-accent)] px-4 py-2 text-sm font-semibold text-black"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-4 text-center text-sm text-[var(--pos-ink-2)]">
          {lastCode ? (
            <span className="text-emerald-400">Added · {lastCode}</span>
          ) : (
            "Point the camera at the barcode"
          )}
        </div>
      </div>
    </div>
  );
}

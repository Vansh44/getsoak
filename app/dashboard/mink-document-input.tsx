"use client";
import { useRef, useState } from "react";
import {
  decodeMinkDocument,
  addReviewedMinkDocument,
  DOCUMENT_BYTES,
} from "@/lib/mink/document-input";
export function MinkDocumentInput({
  message,
  onAdd,
  disabled,
}: {
  message: string;
  onAdd: (value: string) => void;
  disabled: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(false);
  return (
    <div className="mb-2 space-y-2 text-xs">
      <input
        ref={fileRef}
        type="file"
        accept=".txt,.md,text/plain,text/markdown"
        aria-label="Choose text document"
        className="sr-only"
        disabled={disabled || reading}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setReading(true);
          setError("");
          setConfirmed(false);
          setText(null);
          try {
            if (file.size > DOCUMENT_BYTES)
              throw new Error("Choose a file up to 8 KiB.");
            setText(decodeMinkDocument(file.name, await file.arrayBuffer()));
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Could not read the file.",
            );
          } finally {
            setReading(false);
          }
        }}
      />
      <button
        type="button"
        disabled={disabled || reading}
        onClick={() => fileRef.current?.click()}
        className="rounded-lg border px-2 py-1"
      >
        {reading ? "Reading locally…" : "Add text document"}
      </button>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {text !== null && (
        <div className="space-y-2 rounded-lg border p-3">
          <p>
            Review before adding. Only this text will be sent to Vertex when you
            send the message and retained in conversation history. It is not
            saved as a memory or media file. Remove secrets and customer details
            first.
          </p>
          <label className="block">
            Document text
            <textarea
              rows={5}
              maxLength={3000}
              className="block w-full rounded border p-2"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I reviewed this text and want to include it in my message.
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={disabled || !confirmed}
              className="rounded border px-2 py-1 disabled:opacity-40"
              onClick={() => {
                try {
                  onAdd(addReviewedMinkDocument(message, text));
                  setText(null);
                  setConfirmed(false);
                  setError("");
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : "Could not add the document.",
                  );
                }
              }}
            >
              Add reviewed text to message
            </button>
            <button
              type="button"
              onClick={() => {
                setText(null);
                setConfirmed(false);
                setError("");
              }}
            >
              Discard document
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

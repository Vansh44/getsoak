/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  value: number;
  /** `raw` distinguishes an explicit zero from an empty optional field. */
  onValueChange: (n: number, raw: string) => void;
  allowDecimal?: boolean;
  className?: string;
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
  disabled?: boolean;
};

// A numeric input that stores its own editable text, so it behaves like a
// normal field: it can be cleared to empty, accepts in-progress values like
// "1." while typing decimals, and never shows a sticky leading "0".
//
// It uses type="text" (with inputMode) on purpose — native type="number"
// fights controlled state (drops trailing dots, snaps empty back to 0, and
// mutates on scroll). It emits a parsed number; empty parses to 0.
export function NumberField({
  value,
  onValueChange,
  allowDecimal = true,
  className,
  placeholder,
  ...rest
}: Props) {
  const [text, setText] = useState(value === 0 ? "" : String(value));
  // Tracks the last number we emitted so we only resync the text when `value`
  // changes from the outside (e.g. the dialog opening with existing data),
  // not as an echo of the user's own typing.
  const lastEmitted = useRef<number>(value);

  useEffect(() => {
    if (value !== lastEmitted.current) {
      setText(value === 0 ? "" : String(value));
      lastEmitted.current = value;
    }
  }, [value]);

  const pattern = allowDecimal ? /^\d*\.?\d*$/ : /^\d*$/;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (!pattern.test(raw)) return; // reject letters / extra dots
    setText(raw);
    const n = raw === "" || raw === "." ? 0 : Number(raw);
    if (!Number.isNaN(n)) {
      lastEmitted.current = n;
      onValueChange(n, raw);
    }
  };

  return (
    <input
      type="text"
      inputMode={allowDecimal ? "decimal" : "numeric"}
      className={className}
      placeholder={placeholder ?? "0"}
      value={text}
      onChange={handleChange}
      {...rest}
    />
  );
}

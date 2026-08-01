"use client";

import { BrandMark } from "../brand-mark";
import { useState } from "react";
import Link from "next/link";

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "storemink.com";

// Turn whatever the user types ("mystore", "mystore.storemink.com",
// "https://mystore.storemink.com/") into a bare store slug.
function extractSlug(input: string): string {
  let v = input.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  v = v.replace(`.${ROOT_DOMAIN}`, "").replace(".localhost", "");
  v = v.replace(/[^a-z0-9-]/g, "");
  return v;
}

export default function StoreLoginPage() {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  function go(e: React.FormEvent) {
    e.preventDefault();
    const slug = extractSlug(value);
    if (slug.length < 3) {
      setError("Enter your store address.");
      return;
    }
    const { hostname, protocol, port } = window.location;
    const isLocal = hostname.endsWith("localhost");
    const base = isLocal
      ? `${protocol}//${slug}.localhost${port ? ":" + port : ""}`
      : `https://${slug}.${ROOT_DOMAIN}`;
    window.location.href = `${base}/auth/login`;
  }

  return (
    <div className="stq-auth-wrap">
      <form className="stq-auth" onSubmit={go}>
        <Link href="/" className="stq-logo" style={{ fontSize: 20 }}>
          <BrandMark size={22} priority />
          <em>
            Store<span>Mink</span>
          </em>
        </Link>
        <h1 style={{ marginTop: 18 }}>Log in to your store</h1>
        <p className="sub">Enter your store address to continue.</p>

        <div className="stq-field">
          <label className="stq-label" htmlFor="store">
            Store address
          </label>
          <div className="stq-input-row">
            <input
              id="store"
              className="stq-input"
              placeholder="your-store"
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError("");
              }}
            />
            <span className="stq-suffix">.{ROOT_DOMAIN}</span>
          </div>
          <div className={`stq-hint ${error ? "bad" : "neutral"}`}>
            {error || "e.g. your-store.storemink.com"}
          </div>
        </div>

        <button type="submit" className="stq-btn stq-btn-primary stq-btn-block">
          Continue
        </button>

        <p className="stq-alt">
          New to StoreMink? <Link href="/signup">Sign up</Link>
        </p>
      </form>
    </div>
  );
}

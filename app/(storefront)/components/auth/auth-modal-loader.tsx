"use client";

import dynamic from "next/dynamic";
import { useAuth } from "./AuthProvider";

// Phone auth brings Firebase's reCAPTCHA flow, the international phone input,
// and country metadata. None of that belongs in an anonymous storefront's
// initial bundle, so load the modal only after the account control is used.
const AuthModal = dynamic(() => import("./AuthModal"), { ssr: false });

export default function AuthModalLoader() {
  const { isAuthModalOpen } = useAuth();
  return isAuthModalOpen ? <AuthModal /> : null;
}

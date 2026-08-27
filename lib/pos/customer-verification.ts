import "server-only";

import { cookies } from "next/headers";
import type { PosOperator } from "@/lib/pos/operator";
import { signToken, verifyToken, type BaseClaims } from "@/lib/pos/session";

export type PosCustomerVerificationPurpose = "pickup" | "return";

export const POS_CUSTOMER_VERIFICATION_COOKIE = "pos_customer_verified";
export const POS_CUSTOMER_VERIFICATION_MAX_AGE_S = 30 * 60;

interface CustomerVerificationClaims extends BaseClaims {
  t: "customer_phone";
  purpose: PosCustomerVerificationPurpose;
  orderId: string;
  storeId: string;
  locationId: string;
  actor: string;
  phone: string;
}

function actorKey(op: PosOperator): string {
  return `${op.source}:${op.staffId ?? "owner"}:${op.name}`;
}

export function signCustomerVerification(input: {
  purpose: PosCustomerVerificationPurpose;
  orderId: string;
  phone: string;
  op: PosOperator;
  now?: number;
}): string {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  return signToken({
    t: "customer_phone",
    purpose: input.purpose,
    orderId: input.orderId,
    storeId: input.op.storeId,
    locationId: input.op.locationId,
    actor: actorKey(input.op),
    phone: input.phone,
    iat: now,
    exp: now + POS_CUSTOMER_VERIFICATION_MAX_AGE_S,
  });
}

export function verificationMatches(
  token: string | null | undefined,
  input: {
    purpose: PosCustomerVerificationPurpose;
    orderId: string;
    op: PosOperator;
  },
): boolean {
  const claims = verifyToken<CustomerVerificationClaims>(
    token,
    "customer_phone",
  );
  return !!(
    claims &&
    claims.purpose === input.purpose &&
    claims.orderId === input.orderId &&
    claims.storeId === input.op.storeId &&
    claims.locationId === input.op.locationId &&
    claims.actor === actorKey(input.op)
  );
}

export async function hasCustomerVerification(
  purpose: PosCustomerVerificationPurpose,
  orderId: string,
  op: PosOperator,
): Promise<boolean> {
  const token = (await cookies()).get(POS_CUSTOMER_VERIFICATION_COOKIE)?.value;
  return verificationMatches(token, { purpose, orderId, op });
}

export async function saveCustomerVerification(token: string): Promise<void> {
  (await cookies()).set(POS_CUSTOMER_VERIFICATION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/pos",
    maxAge: POS_CUSTOMER_VERIFICATION_MAX_AGE_S,
    priority: "high",
  });
}

export async function clearCustomerVerification(): Promise<void> {
  (await cookies()).set(POS_CUSTOMER_VERIFICATION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/pos",
    maxAge: 0,
  });
}

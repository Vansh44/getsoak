import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  begin: vi.fn(),
  confirm: vi.fn(),
}));
const firebase = vi.hoisted(() => ({
  signIn: vi.fn(),
  confirmCode: vi.fn(),
  signOut: vi.fn(),
  deleteUser: vi.fn(),
  verifierClears: vi.fn(),
}));

vi.mock("@/app/actions/pos-customer-verification-actions", () => ({
  beginCustomerPhoneVerification: actions.begin,
  confirmCustomerPhoneVerification: actions.confirm,
}));
vi.mock("firebase/auth", () => ({
  RecaptchaVerifier: class {
    clear() {
      firebase.verifierClears();
    }
  },
  signInWithPhoneNumber: firebase.signIn,
  getAdditionalUserInfo: vi.fn(() => ({ isNewUser: false })),
}));
vi.mock("@/lib/auth/firebase-client", () => ({
  getSecondaryFirebaseAuth: vi.fn(() => ({ signOut: firebase.signOut })),
  firebaseAuthErrorMessage: vi.fn(() => "Phone verification failed."),
}));

import { CustomerPhoneVerification } from "./customer-phone-verification";

describe("CustomerPhoneVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actions.begin.mockResolvedValue({
      phone: "+919876543210",
      maskedPhone: "••••••3210",
    });
    actions.confirm.mockResolvedValue({ verified: true });
    firebase.confirmCode.mockResolvedValue({
      user: {
        getIdToken: vi.fn(async () => "firebase-id-token"),
        delete: firebase.deleteUser,
      },
    });
    firebase.signIn.mockResolvedValue({ confirm: firebase.confirmCode });
    firebase.signOut.mockResolvedValue(undefined);
  });

  it("sends to the server-owned phone and verifies automatically at six digits", async () => {
    const verified = vi.fn();
    render(
      <CustomerPhoneVerification
        orderId="order-1"
        purpose="pickup"
        onVerified={verified}
        onCancel={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/code sent to \+91 ••••••3210/i),
    ).toBeVisible();
    expect(actions.begin).toHaveBeenCalledWith("order-1", "pickup");
    expect(firebase.signIn).toHaveBeenCalledWith(
      expect.anything(),
      "+919876543210",
      expect.anything(),
    );

    fireEvent.change(screen.getByLabelText("6-digit code"), {
      target: { value: "12a34567" },
    });

    await waitFor(() => expect(verified).toHaveBeenCalledTimes(1));
    expect(firebase.confirmCode).toHaveBeenCalledWith("123456");
    expect(actions.confirm).toHaveBeenCalledWith({
      orderId: "order-1",
      purpose: "pickup",
      idToken: "firebase-id-token",
      cleanupCreatedAuthUser: false,
    });
    expect(firebase.signOut).toHaveBeenCalled();
  });

  it("shows a retry when the initial send cannot start", async () => {
    actions.begin.mockResolvedValue({
      error: "This order has no valid mobile.",
    });
    render(
      <CustomerPhoneVerification
        orderId="order-2"
        purpose="return"
        onVerified={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This order has no valid mobile.",
    );
    expect(
      screen.getByRole("button", { name: /try sending again/i }),
    ).toBeVisible();
    expect(firebase.signIn).not.toHaveBeenCalled();
  });
});

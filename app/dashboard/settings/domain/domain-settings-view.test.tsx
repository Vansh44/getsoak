import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/store-domain", () => ({
  updateCustomDomain: vi.fn(),
  verifyDomain: vi.fn(),
  disconnectDomain: vi.fn(),
  getDomainConnectionState: vi.fn(),
}));

import { DomainSettingsView } from "./domain-settings-view";

afterEach(cleanup);

describe("DomainSettingsView", () => {
  it("shows registrar-relative names and the fully-qualified result", () => {
    const { container } = render(
      <DomainSettingsView
        rootDomain="staging.storemink.com"
        initial={{
          domain: "storiq.in",
          verified: false,
          allowed: true,
          available: true,
          certificateState: "PROVISIONING",
          records: [
            {
              type: "A",
              name: "@",
              fqdn: "storiq.in",
              value: "136.69.75.127",
              purpose: "routing",
            },
            {
              type: "CNAME",
              name: "_acme-challenge",
              fqdn: "_acme-challenge.storiq.in",
              value: "token.authorize.certificatemanager.goog",
              purpose: "certificate",
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByText("Creates _acme-challenge.storiq.in"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/GoDaddy and most DNS providers/),
    ).toBeInTheDocument();

    const copyValues = [...container.querySelectorAll("code")].map(
      (node) => node.textContent,
    );
    expect(copyValues).toEqual([
      "@",
      "136.69.75.127",
      "_acme-challenge",
      "token.authorize.certificatemanager.goog",
    ]);
  });
});

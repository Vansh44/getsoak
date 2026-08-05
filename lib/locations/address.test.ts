import { describe, it, expect } from "vitest";
import { formatAddressLine, locationAddressLines } from "./address";

// What the location editor actually writes.
const SHOP = {
  line1: "hostel D, Thapar University",
  line2: "",
  city: "Patiala",
  state: "Punjab",
  postalCode: "147004",
};

describe("locationAddressLines", () => {
  it("groups town, state and postcode onto one line", () => {
    expect(locationAddressLines(SHOP)).toEqual([
      "hostel D, Thapar University",
      "Patiala, Punjab, 147004",
    ]);
  });

  it("keeps a second line when there is one", () => {
    expect(locationAddressLines({ ...SHOP, line2: "Unit 4" })).toEqual([
      "hostel D, Thapar University",
      "Unit 4",
      "Patiala, Punjab, 147004",
    ]);
  });

  // ★ THE BUG: the pickup card read this with the CUSTOMER address shape
  // (`addressLine1`), so every key came back undefined and the street simply
  // never rendered — no error, nothing in a log, just a missing line.
  it("returns nothing for a customer-shaped address", () => {
    expect(
      locationAddressLines({
        addressLine1: "12 Radial Road",
        country: "India",
      }),
    ).toEqual([]);
  });

  it("handles a shop with only a city, and no address at all", () => {
    expect(locationAddressLines({ city: "Patiala" })).toEqual(["Patiala"]);
    expect(locationAddressLines(null)).toEqual([]);
    expect(locationAddressLines(undefined)).toEqual([]);
  });
});

describe("formatAddressLine", () => {
  // One line, for an email row or an event payload — no markup to break on.
  it("joins every field it has", () => {
    expect(formatAddressLine(SHOP)).toBe(
      "hostel D, Thapar University, Patiala, Punjab, 147004",
    );
  });

  it("is empty rather than a string of commas", () => {
    expect(formatAddressLine(null)).toBe("");
    expect(formatAddressLine({})).toBe("");
    expect(formatAddressLine({ line1: "  " })).toBe("");
  });
});

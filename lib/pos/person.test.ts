import { describe, it, expect } from "vitest";
import { personLabel } from "./person";

describe("personLabel", () => {
  it("leaves a real name alone", () => {
    expect(personLabel("Vansh Gupta")).toBe("Vansh Gupta");
    expect(personLabel("ram")).toBe("ram");
  });

  it("★ never prints a customer someone's full email address", () => {
    expect(personLabel("iamvanshgupta608@gmail.com")).toBe("iamvanshgupta608");
    expect(personLabel("vansh.gupta@storemink.com")).toBe("vansh gupta");
  });

  it("treats an @ without a dotted domain as part of a name", () => {
    expect(personLabel("DJ @ Night")).toBe("DJ @ Night");
  });

  it("returns null for nothing, rather than an empty label", () => {
    expect(personLabel(null)).toBeNull();
    expect(personLabel("   ")).toBeNull();
    expect(personLabel("@example.com")).toBeNull();
  });
});

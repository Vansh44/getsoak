import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MinkAnswer } from "./mink-answer";

describe("MinkAnswer", () => {
  it("renders model emphasis without exposing Markdown markers", () => {
    const { container } = render(
      <MinkAnswer text="Your store (**echos**) is on the **Pro** plan." />,
    );

    expect(screen.getByText("echos").tagName).toBe("STRONG");
    expect(screen.getByText("Pro").tagName).toBe("STRONG");
    expect(container.textContent).toBe(
      "Your store (echos) is on the Pro plan.",
    );
    expect(container.textContent).not.toContain("**");
  });

  it("renders inline code as text without accepting raw HTML", () => {
    const { container } = render(
      <MinkAnswer text={'Find `<script>alert("x")</script>`'} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("code")?.textContent).toContain("<script>");
  });
});

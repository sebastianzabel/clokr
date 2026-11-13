// Issue #855 (D-855-01) - the sign-in frame: one heading, the logo, the body and the optional footer.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import AuthFrame from "../AuthFrame.svelte";

afterEach(() => cleanup());

const children = createRawSnippet(() => ({ render: () => `<p data-testid="body">Inhalt</p>` }));
const footer = createRawSnippet(() => ({
  render: () => `<a href="/login" data-testid="foot">Zurück zur Anmeldung</a>`,
}));

describe("AuthFrame", () => {
  it("renders exactly one h1 with the title and the subtitle under it", () => {
    renderWithTheme(AuthFrame, {
      title: "Anmelden",
      subtitle: "Schön, dass du da bist.",
      children,
    });
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe("Anmelden");
    expect(screen.getByText("Schön, dass du da bist.")).toBeInTheDocument();
  });

  it("names its surface by the title and shows the logo", () => {
    const { container } = renderWithTheme(AuthFrame, { title: "Code eingeben", children });
    expect(screen.getByRole("region", { name: "Code eingeben" })).toBeInTheDocument();
    expect(container.querySelector('.auth-logo [role="img"]')).not.toBeNull();
  });

  it("renders the body, and the footer only when given", () => {
    const { container } = renderWithTheme(AuthFrame, { title: "Anmelden", children });
    expect(screen.getByTestId("body")).toBeInTheDocument();
    expect(container.querySelector(".auth-footer")).toBeNull();
    cleanup();
    renderWithTheme(AuthFrame, { title: "Anmelden", children, footer });
    expect(screen.getByTestId("foot")).toBeInTheDocument();
  });

  it("has no subtitle element without a subtitle", () => {
    const { container } = renderWithTheme(AuthFrame, { title: "Anmelden", children });
    expect(container.querySelector(".auth-subtitle")).toBeNull();
  });
});

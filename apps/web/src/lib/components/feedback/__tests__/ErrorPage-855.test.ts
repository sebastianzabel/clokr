// Issue #855 (D-855-06) - the error page: status → title, sentence and actions; never the raw message.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import ErrorPage from "../ErrorPage.svelte";
import { errorCopy } from "../error-copy";

afterEach(() => cleanup());

describe("errorCopy", () => {
  it("404 names the missing page and offers back", () => {
    const c = errorCopy(404);
    expect(c.title).toBe("Diese Seite gibt es nicht.");
    expect(c.secondary).toBe("back");
    expect(c.documentTitle).toBe("Seite nicht gefunden");
  });

  it("401 and 403 name the missing permission", () => {
    expect(errorCopy(403).title).toBe("Dafür fehlt dir die Berechtigung.");
    expect(errorCopy(401).title).toBe("Dafür fehlt dir die Berechtigung.");
  });

  it.each([500, 502, 503, 418])("%i is a generic failure with a reload", (status) => {
    const c = errorCopy(status);
    expect(c.title).toBe("Da ist etwas schiefgelaufen.");
    expect(c.secondary).toBe("reload");
  });
});

describe("ErrorPage", () => {
  it("unframed: one h1, the status chip and both actions", () => {
    renderWithTheme(ErrorPage, { status: 404 });
    const h1 = screen.getAllByRole("heading", { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toBe("Diese Seite gibt es nicht.");
    expect(screen.getByText("Fehler 404")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zur Startseite" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("button", { name: "Zurück" })).toBeInTheDocument();
  });

  it("framed: stands in the sign-in frame with the logo", () => {
    const { container } = renderWithTheme(ErrorPage, { status: 500, framed: true });
    expect(container.querySelector(".auth-logo")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Da ist etwas schiefgelaufen.",
    );
    expect(screen.getByRole("button", { name: "Seite neu laden" })).toBeInTheDocument();
  });

  it("never renders a raw error message (no prop for it)", async () => {
    const src = (await import("../ErrorPage.svelte?raw")).default as string;
    expect(src).not.toMatch(/error\.message|page\.error/);
  });
});

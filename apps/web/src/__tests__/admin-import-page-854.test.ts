// Issue #854 (plan 854-25, D-854-10, T-854-65) - the CSV import page, mounted: each mode is offered only
// with its own import permission, the import posts the pasted text to the mode's endpoint unchanged,
// the result is a KpiStrip plus a table of the refused rows (text only, never markup), and every
// outcome ends in a toast.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const post = vi.fn();
const success = vi.fn();
const error = vi.fn();
const permissions = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock("$stores/auth", async () => {
  const { readable } = await import("svelte/store");
  return {
    authStore: {
      subscribe: (run: (value: unknown) => void) =>
        readable({
          user: { id: "u-admin", tenantId: "t1", permissions: permissions.list },
        }).subscribe(run),
    },
  };
});
vi.mock("$api/client", () => ({
  api: { post: (...a: unknown[]) => post(...a) },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import Page from "../routes/(app)/admin/import/+page.svelte";

const BOTH = ["employee:import:ZUGEWIESEN", "time-entry:import:ZUGEWIESEN"];

async function typeCsv(text: string) {
  await fireEvent.input(screen.getByRole("textbox", { name: /CSV-Inhalt/ }), {
    target: { value: text },
  });
}

describe("CSV-Import page (#854)", () => {
  beforeEach(() => {
    post.mockReset();
    success.mockReset();
    error.mockReset();
    permissions.list = BOTH;
  });

  it("offers both modes to a holder of both permissions and starts with Personen", () => {
    renderWithTheme(Page, {});
    expect(screen.getByRole("radio", { name: "Personen" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Zeiten" })).toBeTruthy();
  });

  it("offers no choice to a holder of one permission and imports that mode", async () => {
    permissions.list = ["time-entry:import:ZUGEWIESEN"];
    post.mockResolvedValue({ total: 1, imported: 1, errors: 0, details: [] });
    renderWithTheme(Page, {});
    expect(screen.queryByRole("radio")).toBeNull();
    await typeCsv("employeeNumber;date\n1001;01.03.2024");
    await fireEvent.click(screen.getByRole("button", { name: "Importieren" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/imports/time-entries", {
      csv: "employeeNumber;date\n1001;01.03.2024",
    });
  });

  it("posts the pasted text to /imports/employees, shows the KPIs and one toast", async () => {
    post.mockResolvedValue({ total: 2, imported: 2, errors: 0, details: [] });
    renderWithTheme(Page, {});
    await typeCsv("email;firstName\na@b.de;A");
    await fireEvent.click(screen.getByRole("button", { name: "Importieren" }));
    await waitFor(() => expect(screen.getByTestId("import-result")).toBeTruthy());
    expect(post).toHaveBeenCalledWith("/imports/employees", { csv: "email;firstName\na@b.de;A" });
    const result = screen.getByTestId("import-result");
    expect(within(result).getByText("Zeilen gesamt")).toBeTruthy();
    expect(within(result).getByText("Alle Zeilen wurden übernommen.")).toBeTruthy();
    expect(success).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("lists only the refused rows with the server's reason, as text", async () => {
    post.mockResolvedValue({
      total: 3,
      imported: 1,
      errors: 2,
      details: [
        { row: 1, status: "ok", email: "ok@b.de" },
        { row: 2, status: "error", email: "x@b.de", error: "<img src=x onerror=alert(1)>" },
        { row: 3, status: "error", email: "y@b.de", error: "E-Mail ist bereits vergeben." },
      ],
    });
    const { container } = renderWithTheme(Page, {});
    await typeCsv("email\nx");
    await fireEvent.click(screen.getByRole("button", { name: "Importieren" }));
    await waitFor(() => expect(screen.getByTestId("import-result")).toBeTruthy());
    const table = within(screen.getByTestId("import-result")).getByRole("table");
    expect(within(table).queryByText("ok@b.de")).toBeNull();
    expect(within(table).getByText("E-Mail ist bereits vergeben.")).toBeTruthy();
    expect(within(table).getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(success).toHaveBeenCalledWith("1 von 3 Zeilen übernommen, 2 abgelehnt.");
  });

  it("shows the unknown-column warnings of the server", async () => {
    post.mockResolvedValue({
      total: 1,
      imported: 1,
      errors: 0,
      warnings: ["Spalte „foo“ wurde nicht erkannt."],
      details: [],
    });
    renderWithTheme(Page, {});
    await typeCsv("email;foo\na@b.de;x");
    await fireEvent.click(screen.getByRole("button", { name: "Importieren" }));
    await waitFor(() => expect(screen.getByText("Spalte „foo“ wurde nicht erkannt.")).toBeTruthy());
  });

  it("says so in a toast when nothing was taken over, and when the request fails", async () => {
    post.mockResolvedValueOnce({
      total: 1,
      imported: 0,
      errors: 1,
      details: [{ row: 1, status: "error", error: "Pflichtfeld fehlt." }],
    });
    renderWithTheme(Page, {});
    await typeCsv("email\nx");
    await fireEvent.click(screen.getByRole("button", { name: "Importieren" }));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    post.mockRejectedValueOnce(new Error("Keine Berechtigung."));
    await fireEvent.click(screen.getByRole("button", { name: "Importieren" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Keine Berechtigung."));
  });

  it("previews the recognised rows without posting anything", async () => {
    renderWithTheme(Page, {});
    await typeCsv("email;firstName\na@b.de;Anna\nc@d.de;Carl");
    await fireEvent.click(screen.getByRole("button", { name: "Vorschau" }));
    expect(screen.getByText(/2 Zeilen erkannt/)).toBeTruthy();
    expect(screen.getByText("Anna")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps the import button disabled for a blank text and sends no request", async () => {
    renderWithTheme(Page, {});
    await typeCsv("   ");
    expect(screen.getByRole("button", { name: "Importieren" }).hasAttribute("disabled")).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
});

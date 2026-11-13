// Issue #854 (plan 854-20, tracer) - the Person tab of the employee detail, mounted: three groups
// with their own SaveBar, a save sends exactly the keys of its group, the exemption toggle writes
// only after the confirm dialog, and a person without employee:update gets no save controls.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const patch = vi.fn();
const success = vi.fn();
const error = vi.fn();
const warning = vi.fn();

vi.mock("$api/client", () => ({
  api: { patch: (...a: unknown[]) => patch(...a) },
}));
vi.mock("$stores/toast", () => ({
  toasts: {
    success: (m: string) => success(m),
    error: (m: string) => error(m),
    warning: (m: string) => warning(m),
    info: vi.fn(),
  },
}));

import { renderWithTheme } from "$tests/test-utils";
import PersonTab from "../PersonTab.svelte";
import type { PersonEmployee } from "$lib/employees/person-form";

const EMPLOYEE: PersonEmployee = {
  id: "emp-1",
  firstName: "Lena",
  lastName: "Muster",
  employeeNumber: "042",
  nfcCardId: null,
  exitDate: null,
  birthDate: "1999-05-17T00:00:00.000Z",
  classification: "VOLLZEIT",
  coverageWeight: 1,
  requiresSupervision: false,
  annualVacationDays: null,
  isTimeTrackingExempt: false,
};

function mount(props: Partial<{ canEdit: boolean; employee: PersonEmployee }> = {}) {
  const onSaved = vi.fn();
  const view = renderWithTheme(PersonTab, {
    employee: EMPLOYEE,
    canEdit: true,
    tenantDefaultVacationDays: 30,
    tenantDefaultApprenticeVacationDays: 20,
    onSaved,
    ...props,
  });
  return { ...view, onSaved };
}

beforeEach(() => {
  vi.clearAllMocks();
  patch.mockResolvedValue({});
});

describe("PersonTab", () => {
  it("shows the groups and no SaveBar before an edit", () => {
    mount();
    for (const name of [
      "Persönliche Daten",
      "Personalstruktur",
      "Austritt und Urlaubsbasis",
      "Zeiterfassungs-Pflicht",
    ]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
  });

  it("a name edit counts 1 change and saves only the identity keys", async () => {
    const { onSaved } = mount();
    await fireEvent.input(screen.getByLabelText(/^Vorname/), { target: { value: " Lenka " } });
    const bar = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(bar.textContent).toContain("1 Änderung");
    await fireEvent.click(within(bar).getByRole("button", { name: "Persönliche Daten speichern" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [url, body] = patch.mock.calls[0];
    expect(url).toBe("/employees/emp-1");
    expect(Object.keys(body as object).sort()).toEqual(
      ["birthDate", "employeeNumber", "firstName", "lastName", "nfcCardId"].sort(),
    );
    expect(body).toMatchObject({ firstName: "Lenka", nfcCardId: null });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Persönliche Daten gespeichert."));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ firstName: "Lenka" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull(),
    );
  });

  it("an empty first name blocks the save with the field message", async () => {
    mount();
    await fireEvent.input(screen.getByLabelText(/^Vorname/), { target: { value: "" } });
    expect(await screen.findByText("Gib den Vornamen ein.")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Persönliche Daten speichern" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("changing the classification resets weight and supervision to its defaults and saves one PATCH of the structure keys", async () => {
    mount();
    await fireEvent.change(screen.getByLabelText("Personalkategorie"), {
      target: { value: "AZUBI" },
    });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Personalstruktur speichern" }),
    );
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).toEqual({
      classification: "AZUBI",
      coverageWeight: 0,
      requiresSupervision: true,
    });
  });

  it("the exit group warns about the pro-rata result of the server", async () => {
    patch.mockResolvedValue({ proRataWarning: { message: "Anteiliger Urlaub geändert." } });
    mount();
    await fireEvent.input(screen.getByLabelText(/^Urlaubstage pro Jahr/), {
      target: { value: "28" },
    });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Austritt und Urlaubsbasis speichern" }),
    );
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(Object.keys(patch.mock.calls[0][1] as object).sort()).toEqual([
      "annualVacationDays",
      "exitDate",
    ]);
    await waitFor(() => expect(warning).toHaveBeenCalledWith("Anteiliger Urlaub geändert."));
  });

  it("a refused save toasts the server text and keeps the SaveBar", async () => {
    patch.mockRejectedValue(new Error("Mitarbeiter-Nr. bereits vergeben."));
    mount();
    await fireEvent.input(screen.getByLabelText(/^Mitarbeiter-Nr\./), { target: { value: "7" } });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Persönliche Daten speichern" }),
    );
    await waitFor(() => expect(error).toHaveBeenCalledWith("Mitarbeiter-Nr. bereits vergeben."));
    expect(screen.getByRole("region", { name: "Speicherleiste" })).toBeTruthy();
  });

  it("the exemption writes only after the confirm dialog; cancel reverts the box", async () => {
    mount();
    const toggle = screen.getByTestId("exemption-toggle") as HTMLInputElement;
    await fireEvent.click(toggle);
    expect(patch).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(patch).not.toHaveBeenCalled();

    await fireEvent.click(toggle);
    const again = await screen.findByRole("dialog");
    await fireEvent.click(within(again).getByRole("button", { name: "Bestätigen" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith("/employees/emp-1", { isTimeTrackingExempt: true });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Befreiung aktualisiert."));
    expect(toggle.checked).toBe(true);
  });

  it("without employee:update the fields are read-only and nothing offers a save", async () => {
    mount({ canEdit: false });
    expect((screen.getByLabelText(/^Vorname/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId("exemption-toggle")).toBeNull();
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
  });
});

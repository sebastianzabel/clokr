// Issue #854 (plan 854-22) - the per-person override groups of the Vertrag tab, mounted: each group
// has its own SaveBar and sends only its own keys, the under-18 hint and suggestion (#574), the
// server's refusal as text, read-only without employee:update.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const apiPatch = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({
  api: { patch: (...a: unknown[]) => apiPatch(...a) },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import VertragOverrides from "../VertragOverrides.svelte";
import type { OverrideEmployee, OverrideTenant } from "$lib/employees/overrides-form";

const TENANT: OverrideTenant = {
  defaultBreakOver6h: 30,
  defaultBreakOver9h: 45,
  phorestPrepMinutes: 5,
  phorestWrapupMinutes: 10,
};

type Props = Partial<{
  employee: OverrideEmployee & { id: string };
  tenant: OverrideTenant | null;
  canEdit: boolean;
  onSaved: (written: Partial<OverrideEmployee>) => void;
  changes: number;
}>;

function mount(props: Props = {}) {
  return renderWithTheme(VertragOverrides, {
    employee: { id: "emp-1", birthDate: "1990-04-02T00:00:00.000Z" },
    tenant: TENANT,
    canEdit: true,
    ...props,
  });
}

const over6 = () => screen.getByTestId("pausendauer-over6h") as HTMLInputElement;
const over9 = () => screen.getByTestId("pausendauer-over9h") as HTMLInputElement;
const prep = () => screen.getByTestId("phorest-puffer-prep") as HTMLInputElement;
const wrapup = () => screen.getByTestId("phorest-puffer-wrapup") as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  apiPatch.mockResolvedValue({});
});

describe("VertragOverrides - the groups", () => {
  it("renders two groups with their company defaults and no SaveBar", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Pausendauer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Phorest Vor- und Nachbereitung" })).toBeTruthy();
    expect(screen.getByText(/Leer = Standard \(30\/45 Min\)/)).toBeTruthy();
    expect(screen.getByText(/Leer = Standard \(5\/10 Min\)/)).toBeTruthy();
    expect(over6().placeholder).toBe("Standard: 30 Min");
    expect(prep().placeholder).toBe("Standard: 5 Min");
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
  });

  it("shows the stored overrides, a stored 0 included", () => {
    mount({
      employee: {
        id: "emp-1",
        breakOver6hOverride: 45,
        phorestPrepMinutesOverride: 0,
      },
    });
    expect(over6().value).toBe("45");
    expect(over9().value).toBe("");
    expect(prep().value).toBe("0");
  });

  it("falls back to the built-in defaults when the company config could not be read", () => {
    mount({ tenant: null });
    expect(screen.getByText(/Leer = Standard \(30\/45 Min\)/)).toBeTruthy();
    expect(wrapup().placeholder).toBe("Standard: 0 Min");
  });
});

describe("VertragOverrides - Pausendauer", () => {
  it("an edit opens the group's own SaveBar and the PATCH carries only its two keys", async () => {
    const onSaved = vi.fn();
    mount({ onSaved });
    await fireEvent.input(over6(), { target: { value: "45" } });
    const bar = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(bar.textContent).toContain("1 Änderung");
    await fireEvent.click(within(bar).getByRole("button", { name: "Pausendauer speichern" }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledWith("/employees/emp-1", {
      breakOver6hOverride: 45,
      breakOver9hOverride: null,
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Pausendauer gespeichert."));
    expect(onSaved).toHaveBeenCalledWith({ breakOver6hOverride: 45, breakOver9hOverride: null });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull(),
    );
  });

  it("clearing a stored override sends an explicit null (back to the company standard)", async () => {
    mount({ employee: { id: "emp-1", breakOver6hOverride: 45, breakOver9hOverride: 60 } });
    await fireEvent.input(over6(), { target: { value: "" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Pausendauer speichern" }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    expect(apiPatch).toHaveBeenCalledWith("/employees/emp-1", {
      breakOver6hOverride: null,
      breakOver9hOverride: 60,
    });
  });

  it("the two groups are independent: editing Pausendauer never sends a Phorest key", async () => {
    mount();
    await fireEvent.input(over9(), { target: { value: "60" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Pausendauer speichern" }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    const body = apiPatch.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["breakOver6hOverride", "breakOver9hOverride"]);
  });

  it("a value below the ArbZG floor is named at the field and blocks the save", async () => {
    mount();
    await fireEvent.input(over6(), { target: { value: "20" } });
    await screen.findByText("Der Wert muss zwischen 30 und 120 Minuten liegen.");
    const save = screen.getByRole("button", { name: "Pausendauer speichern" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it("shows the server's refusal as text, keeps the SaveBar and the typed value", async () => {
    apiPatch.mockRejectedValueOnce(
      new Error("Pausendauer für Arbeitstage über 6 Stunden zu kurz."),
    );
    mount();
    await fireEvent.input(over6(), { target: { value: "35" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Pausendauer speichern" }));
    const alert = await screen.findByTestId("pausendauer-error");
    expect(alert.textContent).toContain("zu kurz");
    expect(screen.getByRole("region", { name: "Speicherleiste" })).toBeTruthy();
    expect(over6().value).toBe("35");
    expect(success).not.toHaveBeenCalled();
  });

  it("Verwerfen restores the saved value", async () => {
    mount({ employee: { id: "emp-1", breakOver6hOverride: 45 } });
    await fireEvent.input(over6(), { target: { value: "50" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Verwerfen" }));
    await waitFor(() => expect(over6().value).toBe("45"));
  });
});

describe("VertragOverrides - under 18 (§ 11 JArbSchG)", () => {
  const MINOR = { id: "emp-1", birthDate: "2015-01-01T00:00:00.000Z" };

  it("shows the hint, the 60-minute placeholders and the suggestion for any minor", () => {
    mount({ employee: MINOR });
    expect(screen.getByTestId("pausendauer-azubi-pill").textContent).toContain(
      "Unter 18 — Pausen nach § 11 JArbSchG",
    );
    expect(over6().placeholder).toBe("60 Min — nach § 11 JArbSchG");
    expect(over9().placeholder).toBe("60 Min — nach § 11 JArbSchG");
    expect(screen.getByTestId("pausendauer-azubi-apply")).toBeTruthy();
  });

  it("the suggestion fills both fields with 60 and counts as an unsaved change", async () => {
    mount({ employee: MINOR });
    await fireEvent.click(screen.getByTestId("pausendauer-azubi-apply"));
    expect(over6().value).toBe("60");
    expect(over9().value).toBe("60");
    await screen.findByRole("region", { name: "Speicherleiste" });
    expect(screen.queryByTestId("pausendauer-azubi-apply")).toBeNull();
  });

  it("no hint for an adult, none without a birth date, no suggestion once a value is set", () => {
    mount();
    expect(screen.queryByTestId("pausendauer-azubi-pill")).toBeNull();
    expect(screen.queryByTestId("pausendauer-azubi-apply")).toBeNull();
  });

  it("no suggestion button without employee:update", () => {
    mount({ employee: MINOR, canEdit: false });
    expect(screen.getByTestId("pausendauer-azubi-pill")).toBeTruthy();
    expect(screen.queryByTestId("pausendauer-azubi-apply")).toBeNull();
  });
});

describe("VertragOverrides - Phorest Vor- und Nachbereitung", () => {
  it("an edit sends only the two Phorest keys; an explicit 0 stays 0", async () => {
    mount();
    await fireEvent.input(prep(), { target: { value: "0" } });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Vor- und Nachbereitung speichern" }),
    );
    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    expect(apiPatch).toHaveBeenCalledWith("/employees/emp-1", {
      phorestPrepMinutesOverride: 0,
      phorestWrapupMinutesOverride: null,
    });
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Vor- und Nachbereitungszeit gespeichert."),
    );
  });

  it("more than 30 minutes is named at the field", async () => {
    mount();
    await fireEvent.input(wrapup(), { target: { value: "31" } });
    await screen.findByText("Der Wert muss zwischen 0 und 30 Minuten liegen.");
  });

  it("shows the server's refusal as text", async () => {
    apiPatch.mockRejectedValueOnce(
      new Error("Vorbereitungszeit darf 30 Minuten nicht überschreiten."),
    );
    mount();
    await fireEvent.input(prep(), { target: { value: "25" } });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Vor- und Nachbereitung speichern" }),
    );
    expect((await screen.findByTestId("phorest-puffer-error")).textContent).toContain("30 Minuten");
  });
});

describe("VertragOverrides - read-only", () => {
  it("disables every field and offers no SaveBar without employee:update", () => {
    mount({ canEdit: false });
    for (const field of [over6(), over9(), prep(), wrapup()]) expect(field.disabled).toBe(true);
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
  });
});

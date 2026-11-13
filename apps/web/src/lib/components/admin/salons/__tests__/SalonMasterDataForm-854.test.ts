// Issue #854 (tracer) - the Stammdaten section of a salon, mounted: one change makes the SaveBar
// count 1, the save sends exactly the master keys (nothing of the opening hours), the success
// toast and the salon-context reload follow, and a refused Bundesland change restores the stored
// value, shows the server's text and locks the field. The create form posts once with an explicit
// Bundesland.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";

const patch = vi.fn();
const post = vi.fn();
const success = vi.fn();
const error = vi.fn();
const loadContext = vi.fn();

vi.mock("$api/client", () => ({
  api: {
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
  },
  ApiError: class ApiError extends Error {
    status: number;
    data?: unknown;
    constructor(status: number, message: string, data?: unknown) {
      super(message);
      this.status = status;
      this.data = data;
    }
  },
}));
vi.mock("$stores/auth", () => ({
  authStore: {
    subscribe: (run: (value: unknown) => void) => {
      run({ user: { id: "user-1" } });
      return () => {};
    },
  },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));
vi.mock("$stores/salon-context", () => ({
  salonContext: { load: (...a: unknown[]) => loadContext(...a) },
}));

import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import type { SalonDto } from "$lib/salons/salon-form";
import SalonMasterDataForm from "../SalonMasterDataForm.svelte";

// The keys of the section (SALON_MASTER_KEYS in the component): the PATCH carries exactly these.
const MASTER_KEYS = ["name", "street", "postalCode", "city", "federalState"];

const SALON: SalonDto = {
  id: "salon-1",
  name: "Salon Mitte",
  street: "Hauptstraße 1",
  postalCode: "10115",
  city: "Berlin",
  federalState: "BERLIN",
  openingHours: null,
  isActive: true,
  deactivatedAt: null,
};

function mount(props: Partial<{ salon: SalonDto | null; canEdit: boolean }> = {}) {
  const onSaved = vi.fn();
  const onCreated = vi.fn();
  const view = renderWithTheme(SalonMasterDataForm, {
    salon: SALON,
    canEdit: true,
    onSaved,
    onCreated,
    ...props,
  });
  return { ...view, onSaved, onCreated };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadContext.mockResolvedValue(undefined);
});

describe("SalonMasterDataForm - edit", () => {
  it("shows no SaveBar until something changed, then counts 1 change", async () => {
    mount();
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
    await fireEvent.input(screen.getByLabelText(/^Name/), { target: { value: "Salon Nord" } });
    const bar = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(bar.textContent).toContain("1 Änderung");
  });

  it("saves exactly the master keys, then toasts and reloads the salon context", async () => {
    const { onSaved } = mount();
    const updated = { ...SALON, name: "Salon Nord" };
    patch.mockResolvedValue(updated);
    await fireEvent.input(screen.getByLabelText(/^Name/), { target: { value: " Salon Nord " } });
    await fireEvent.click(await screen.findByRole("button", { name: "Salon speichern" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [url, body] = patch.mock.calls[0];
    expect(url).toBe("/salons/salon-1");
    expect(Object.keys(body as object).sort()).toEqual([...MASTER_KEYS].sort());
    expect(body).toEqual({
      name: "Salon Nord",
      street: "Hauptstraße 1",
      postalCode: "10115",
      city: "Berlin",
      federalState: "BERLIN",
    });
    expect(body).not.toHaveProperty("openingHours");
    await waitFor(() => expect(success).toHaveBeenCalledWith("Stammdaten gespeichert."));
    expect(loadContext).toHaveBeenCalledWith("user-1", { force: true });
    expect(onSaved).toHaveBeenCalledWith(updated);
    // The answer is the new baseline: the bar is gone again.
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull(),
    );
  });

  it("a blank address part is sent as null", async () => {
    mount();
    patch.mockResolvedValue({ ...SALON, street: null });
    await fireEvent.input(screen.getByLabelText(/^Straße/), { target: { value: "  " } });
    await fireEvent.click(await screen.findByRole("button", { name: "Salon speichern" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).toMatchObject({ street: null });
  });

  it("blocks the save for an empty name and names the field", async () => {
    mount();
    await fireEvent.input(screen.getByLabelText(/^Name/), { target: { value: "" } });
    expect(await screen.findByText("Bitte einen Namen angeben.")).toBeTruthy();
    const save = await screen.findByRole("button", { name: "Salon speichern" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("Verwerfen puts the stored values back", async () => {
    mount();
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    await fireEvent.input(name, { target: { value: "Etwas anderes" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Verwerfen" }));
    expect(name.value).toBe("Salon Mitte");
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
  });

  it("a refused Bundesland change restores the stored value, shows the server text and locks the field", async () => {
    mount();
    patch.mockRejectedValue(
      new ApiError(409, "Das Bundesland kann nicht mehr geändert werden.", {
        code: "FEDERAL_STATE_IN_USE",
      }),
    );
    const select = screen.getByLabelText(/^Bundesland/) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: "BAYERN" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Salon speichern" }));
    expect(await screen.findByText("Das Bundesland kann nicht mehr geändert werden.")).toBeTruthy();
    await waitFor(() => expect(select.value).toBe("BERLIN"));
    expect(select.disabled).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it("any other refusal is a toast with the server's text", async () => {
    mount();
    patch.mockRejectedValue(new ApiError(500, "Interner Serverfehler"));
    await fireEvent.input(screen.getByLabelText(/^Name/), { target: { value: "Neu" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Salon speichern" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Interner Serverfehler"));
  });

  it("without the manage right the fields are read-only and there is no SaveBar", () => {
    mount({ canEdit: false });
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/^Bundesland/) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Salon speichern" })).toBeNull();
  });
});

describe("SalonMasterDataForm - create", () => {
  it("needs an explicit Bundesland and posts once with the created body", async () => {
    const { onCreated } = mount({ salon: null });
    const created = { ...SALON, id: "salon-2", name: "Salon Süd" };
    post.mockResolvedValue(created);
    await fireEvent.input(screen.getByLabelText(/^Name/), { target: { value: "Salon Süd" } });
    // No Bundesland chosen yet: the field names it and the save stays blocked.
    expect(await screen.findByText("Bitte ein Bundesland wählen.")).toBeTruthy();
    expect(
      ((await screen.findByRole("button", { name: "Salon anlegen" })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await fireEvent.change(screen.getByLabelText(/^Bundesland/), { target: { value: "BAYERN" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Salon anlegen" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe("/salons");
    expect(post.mock.calls[0][1]).toMatchObject({ name: "Salon Süd", federalState: "BAYERN" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(success).toHaveBeenCalledWith("Salon angelegt.");
    expect(loadContext).toHaveBeenCalledWith("user-1", { force: true });
  });
});

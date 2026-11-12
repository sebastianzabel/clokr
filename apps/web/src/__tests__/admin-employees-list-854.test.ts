// Issue #854 (plan 854-18, D-854-09, AC-2/AC-5) - the Personen list, mounted: selecting rows opens
// the bulk bar, „Einladung erneut senden“ shows a preview that names exactly who is touched (and who
// is skipped) BEFORE any request, the confirm runs the existing per-person endpoint once per listed
// person and ends in ONE toast, the failed row stays selected, and a holder without
// employee:manage-access gets no bulk invitation action. The CSV export is proven in
// `csv-export-854`; this file proves the wiring on the real page.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const get = vi.fn();
const post = vi.fn();
const success = vi.fn();
const error = vi.fn();
const permissions = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  afterNavigate: vi.fn(),
  replaceState: vi.fn(),
}));
vi.mock("$app/stores", async () => {
  const { readable } = await import("svelte/store");
  return {
    page: readable({
      url: new URL("http://localhost/admin/employees"),
      params: {},
      state: {},
    }),
  };
});
vi.mock("$app/state", () => ({
  page: { url: new URL("http://localhost/admin/employees"), params: {}, state: {} },
}));
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
vi.mock("$stores/salon-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$stores/salon-context")>();
  const { readable } = await import("svelte/store");
  return {
    ...actual,
    salonContext: readable({
      loaded: true,
      tenant: { id: "t1", name: "Test" },
      salons: [],
      isMultiSalon: false,
      homeSalonId: null,
      selection: null,
      packages: null,
      roles: [],
    }),
  };
});
vi.mock("$api/client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import Page from "../routes/(app)/admin/employees/+page.svelte";

function person(id: string, lastName: string, over: Record<string, unknown> = {}) {
  return {
    id,
    employeeNumber: `N-${id}`,
    firstName: "Test",
    lastName,
    hireDate: "2026-01-01T00:00:00.000Z",
    exitDate: null,
    nfcCardId: null,
    birthDate: null,
    classification: "VOLLZEIT",
    coverageWeight: 1,
    requiresSupervision: false,
    userId: `user-${id}`,
    user: { email: `${id}@beispiel.test`, isActive: true, lastLoginAt: null },
    invitationStatus: "ACCEPTED",
    workSchedule: { type: "FIXED_SCHEDULE" },
    ...over,
  };
}

const PEOPLE = [
  person("e1", "Eins", {
    user: { email: "e1@beispiel.test", isActive: false, lastLoginAt: null },
    invitationStatus: "PENDING",
  }),
  person("e2", "Zwei", {
    user: { email: "e2@beispiel.test", isActive: false, lastLoginAt: null },
    invitationStatus: "EXPIRED",
  }),
  person("e3", "Drei"),
];

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  success.mockReset();
  error.mockReset();
  permissions.list = ["employee:manage-access:ZUGEWIESEN", "employee:read:ZUGEWIESEN"];
  get.mockImplementation(async (path: string) => {
    if (path.startsWith("/employees")) return PEOPLE;
    return {};
  });
});

async function mountList() {
  renderWithTheme(Page, {});
  await screen.findByRole("checkbox", { name: "Eins, Test auswählen" });
}

describe("Personen list - selection and bulk invitation", () => {
  it("shows the bulk bar only once a row is selected and offers the invitation action to the holder", async () => {
    await mountList();
    expect(screen.queryByTestId("admin-employees-bulk-bar")).toBeNull();
    await fireEvent.click(screen.getByRole("checkbox", { name: "Eins, Test auswählen" }));
    const bar = await screen.findByTestId("admin-employees-bulk-bar");
    expect(within(bar).getByText("1 ausgewählt")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Als CSV exportieren" })).toBeInTheDocument();
    expect(
      within(bar).getByRole("button", { name: "Einladung erneut senden" }),
    ).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Rolle zuweisen" })).toBeNull();
  });

  it("offers no bulk invitation without employee:manage-access", async () => {
    permissions.list = ["employee:read:ZUGEWIESEN"];
    await mountList();
    await fireEvent.click(screen.getByRole("checkbox", { name: "Eins, Test auswählen" }));
    const bar = await screen.findByTestId("admin-employees-bulk-bar");
    expect(within(bar).queryByRole("button", { name: "Einladung erneut senden" })).toBeNull();
  });

  it("previews who is touched and who is skipped before any request, then runs once per person and toasts once", async () => {
    post.mockImplementation(async (path: string) => {
      if (path === "/employees/e2/resend-invitation") {
        throw new ApiError(502, "Die E-Mail konnte nicht gesendet werden.");
      }
      return {};
    });
    await mountList();
    // e1 (open invitation), e2 (open invitation) and e3 (already active -> skipped)
    for (const name of ["Eins", "Zwei", "Drei"]) {
      await fireEvent.click(screen.getByRole("checkbox", { name: `${name}, Test auswählen` }));
    }
    await fireEvent.click(await screen.findByRole("button", { name: "Einladung erneut senden" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Betrifft 2 Personen")).toBeInTheDocument();
    const list = within(dialog).getByTestId("admin-employees-bulk-preview-list");
    expect(within(list).getByText("Eins, Test")).toBeInTheDocument();
    expect(within(list).getByText("Zwei, Test")).toBeInTheDocument();
    expect(within(list).queryByText("Drei, Test")).toBeNull();
    expect(within(dialog).getByText(/ohne offene Einladung\): Drei, Test/)).toBeInTheDocument();
    // AC-2: nothing was written while the preview is open.
    expect(post).not.toHaveBeenCalled();

    await fireEvent.click(within(dialog).getByRole("button", { name: "Einladungen senden" }));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      "/employees/e1/resend-invitation",
      "/employees/e2/resend-invitation",
    ]);
    expect(success).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toBe(
      "1 Einladung gesendet, 1 nicht: Zwei, Test (Die E-Mail konnte nicht gesendet werden.).",
    );
    // The failed row stays selected, the rest is released.
    await waitFor(() => expect(screen.getByText("1 ausgewählt")).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Zwei, Test auswählen" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Eins, Test auswählen" })).not.toBeChecked();
  });

  it("filters through the toolbar search and keeps the count in step", async () => {
    await mountList();
    expect(screen.getByText("3 von 3")).toBeInTheDocument();
    await fireEvent.input(screen.getByRole("searchbox", { name: "Personen suchen" }), {
      target: { value: "drei" },
    });
    await waitFor(() => expect(screen.getByText("1 von 3")).toBeInTheDocument());
    expect(screen.queryByRole("checkbox", { name: "Eins, Test auswählen" })).toBeNull();
  });
});

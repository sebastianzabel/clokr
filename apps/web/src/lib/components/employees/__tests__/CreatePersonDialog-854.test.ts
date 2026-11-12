// Issue #854 (D-854-06, AC-5) - the guided create dialog, mounted: four steps, a step with an error
// does not advance, ONE POST /employees with the unchanged body (no `role`), the role drafts are
// posted only after it, a refused draft keeps the person and hands over to the tab „Berechtigungen“,
// and the Minijob hint appears before saving without blocking.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const get = vi.fn();
const post = vi.fn();
const goto = vi.fn();
const success = vi.fn();
const error = vi.fn();
const permissions = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock("$app/navigation", () => ({ goto: (...a: unknown[]) => goto(...a) }));
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
vi.mock("$stores/salon-context", async () => {
  const { readable } = await import("svelte/store");
  return {
    salonContext: readable({
      loaded: true,
      salons: [{ id: "s-1", name: "Salon Nord" }],
    }),
  };
});
vi.mock("$api/client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
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
import CreatePersonDialog from "../CreatePersonDialog.svelte";

const ROLE = {
  id: "r-probe",
  name: "Probe-Rolle",
  permissions: ["employee:read:ZUGEWIESEN"],
  isSystem: false,
  createdAt: "",
  updatedAt: "",
};

const SALONS = [
  { id: "s-1", name: "Salon Nord", isActive: true },
  { id: "s-2", name: "Salon Süd", isActive: true },
];

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  goto.mockReset();
  success.mockReset();
  error.mockReset();
  permissions.list = [];
  get.mockImplementation(async (path: string) => {
    if (path === "/salons") return { salons: [SALONS[0]] };
    if (path === "/settings/work") {
      return { defaultVacationDays: 30, defaultApprenticeVacationDays: 28 };
    }
    return {};
  });
  post.mockImplementation(async (path: string) =>
    path === "/employees" ? { id: "e-new", userId: "u-new" } : {},
  );
});

function mount(onCreated = vi.fn()) {
  renderWithTheme(CreatePersonDialog, {
    open: true,
    onCreated,
    roles: [ROLE],
    mandantRoleIds: [],
    people: [],
    roleChoicesFailed: false,
  });
  return onCreated;
}

const dialog = () => screen.getByRole("dialog", { name: "Person anlegen" });

async function fillPerson() {
  const d = within(dialog());
  await fireEvent.input(d.getByLabelText(/^Vorname/), { target: { value: "Mia" } });
  await fireEvent.input(d.getByLabelText(/^Nachname/), { target: { value: "Muster" } });
  await fireEvent.input(d.getByLabelText(/^E-Mail-Adresse/), {
    target: { value: "mia.muster@example.invalid" },
  });
  await fireEvent.input(d.getByLabelText(/^Personalnummer/), { target: { value: "E-100" } });
}

async function clickIn(name: string) {
  await fireEvent.click(within(dialog()).getByRole("button", { name }));
}

describe("CreatePersonDialog - the steps", () => {
  it("shows four labelled steps with the current one marked", async () => {
    mount();
    const steps = within(dialog()).getByRole("list", { name: "Schritte" });
    const items = within(steps).getAllByRole("listitem");
    expect(items.map((li) => li.textContent?.replace(/\d/, "").trim())).toEqual([
      "Person",
      "Salon & Rolle",
      "Vertrag",
      "Einladung",
    ]);
    expect(items[0]).toHaveAttribute("aria-current", "step");
    expect(items[1]).not.toHaveAttribute("aria-current");
  });

  it("does not advance while a field of the step has an error, and names it", async () => {
    mount();
    await clickIn("Weiter");
    const d = within(dialog());
    expect(d.getByText("Gib den Vornamen ein.")).toBeInTheDocument();
    expect(d.getByText("Gib den Nachnamen ein.")).toBeInTheDocument();
    expect(d.getByText("Gib eine E-Mail-Adresse ein.")).toBeInTheDocument();
    expect(d.getByText("Gib die Personalnummer ein.")).toBeInTheDocument();
    // still the first step
    expect(d.getByLabelText(/^Vorname/)).toBeInTheDocument();
    expect(d.queryByRole("button", { name: "Zurück" })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("walks Person -> Salon & Rolle -> Vertrag -> Einladung and back", async () => {
    mount();
    await fillPerson();
    await clickIn("Weiter");
    const d = within(dialog());
    expect(await d.findByText("Rollen")).toBeInTheDocument();
    await clickIn("Weiter");
    expect(await d.findByLabelText(/^Wochenstunden/)).toBeInTheDocument();
    await clickIn("Weiter");
    expect(await d.findByRole("button", { name: "Person anlegen" })).toBeInTheDocument();
    await clickIn("Zurück");
    expect(await d.findByLabelText(/^Wochenstunden/)).toBeInTheDocument();
  });
});

describe("CreatePersonDialog - Vertrag", () => {
  async function toVertrag() {
    mount();
    await fillPerson();
    await clickIn("Weiter");
    await within(dialog()).findByText("Rollen");
    await clickIn("Weiter");
    await within(dialog()).findByLabelText(/^Wochenstunden/);
  }

  it("says the contract starts on the Eintrittsdatum", async () => {
    await toVertrag();
    expect(
      within(dialog()).getByText(/Der Vertrag beginnt am Eintrittsdatum\./),
    ).toBeInTheDocument();
  });

  it("shows the Minijob hint for Minijob with 11 weekly hours, and does not block the step", async () => {
    await toVertrag();
    const d = within(dialog());
    expect(d.queryByText(/Prüfe die Minijob-Grenze/)).toBeNull();
    await fireEvent.change(d.getByLabelText(/^Personalkategorie/), {
      target: { value: "MINIJOB" },
    });
    await fireEvent.input(d.getByLabelText(/^Wochenstunden/), { target: { value: "11" } });
    expect(await d.findByText(/Prüfe die Minijob-Grenze/)).toBeInTheDocument();
    await clickIn("Weiter");
    expect(await d.findByRole("button", { name: "Person anlegen" })).toBeInTheDocument();
  });

  it("keeps a SHIFT_BASED contract on the step until the usual workdays are ticked", async () => {
    await toVertrag();
    const d = within(dialog());
    await fireEvent.change(d.getByLabelText(/^Arbeitszeitmodell/), {
      target: { value: "SHIFT_BASED" },
    });
    await clickIn("Weiter");
    expect(await d.findByText(/bei Schichtbetrieb Pflicht/)).toBeInTheDocument();
    expect(d.queryByRole("button", { name: "Person anlegen" })).toBeNull();
  });
});

describe("CreatePersonDialog - creating", () => {
  async function toLastStep() {
    await fillPerson();
    await clickIn("Weiter");
    await within(dialog()).findByText("Rollen");
    await clickIn("Weiter");
    await within(dialog()).findByLabelText(/^Wochenstunden/);
    await clickIn("Weiter");
    await within(dialog()).findByRole("button", { name: "Person anlegen" });
  }

  it("posts ONE /employees with the unchanged body and no role, then reports the id", async () => {
    const onCreated = mount();
    await toLastStep();
    await clickIn("Person anlegen");
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("e-new"));
    const employeePosts = post.mock.calls.filter((c) => c[0] === "/employees");
    expect(employeePosts).toHaveLength(1);
    const body = employeePosts[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({
      email: "mia.muster@example.invalid",
      firstName: "Mia",
      lastName: "Muster",
      employeeNumber: "E-100",
      scheduleType: "FIXED_SCHEDULE",
      weeklyHours: 40,
      classification: "VOLLZEIT",
    });
    expect(body.hireDate).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    expect(body).not.toHaveProperty("role");
    expect(body).not.toHaveProperty("password");
    expect(post.mock.calls.map((c) => c[0])).toEqual(["/employees"]);
    expect(success).toHaveBeenCalledWith("Person angelegt.");
    expect(goto).not.toHaveBeenCalled();
  });

  it("sends a typed initial password (and only then)", async () => {
    mount();
    await toLastStep();
    await fireEvent.click(within(dialog()).getByRole("radio", { name: "Passwort setzen" }));
    const field = within(dialog()).getByLabelText(/^Passwort/, { selector: "input" });
    expect(field).toHaveAttribute("type", "password");
    await clickIn("Person anlegen");
    expect(
      await within(dialog()).findByText("Das Passwort braucht mindestens 8 Zeichen."),
    ).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    await fireEvent.input(field, { target: { value: "geheim-1234" } });
    await clickIn("Person anlegen");
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ password: "geheim-1234" });
  });

  it("shows the server's message and keeps the dialog open when the person is refused", async () => {
    post.mockRejectedValueOnce(new ApiError(409, "Diese Personalnummer ist bereits vergeben."));
    const onCreated = mount();
    await toLastStep();
    await clickIn("Person anlegen");
    expect(
      await within(dialog()).findByText("Diese Personalnummer ist bereits vergeben."),
    ).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(within(dialog()).getByRole("button", { name: "Person anlegen" })).toBeEnabled();
  });

  it("requires the Stammsalon in a tenant with several active salons", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "/salons") return { salons: SALONS };
      return { defaultVacationDays: 30 };
    });
    permissions.list = ["salon:read:ZUGEWIESEN"];
    mount();
    await fillPerson();
    await clickIn("Weiter");
    const d = within(dialog());
    const select = await d.findByLabelText("Stammsalon");
    await clickIn("Weiter");
    expect(await d.findByText("Wähle den Stammsalon.")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    await fireEvent.change(select, { target: { value: "s-2" } });
    await clickIn("Weiter");
    await d.findByLabelText(/^Wochenstunden/);
    await clickIn("Weiter");
    await clickIn("Person anlegen");
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ homeSalonId: "s-2" });
  });
});

describe("CreatePersonDialog - role drafts (Issue #580)", () => {
  beforeEach(() => {
    permissions.list = ["role-assignment:manage:ZUGEWIESEN", "role:read:ZUGEWIESEN"];
  });

  async function draftRoleAndGoToEnd() {
    await fillPerson();
    await clickIn("Weiter");
    await within(dialog()).findByText("Rollen");
    await clickIn("Rolle zuweisen");
    const nested = (await screen.findAllByRole("dialog", { name: "Rolle zuweisen" }))[0];
    await fireEvent.change(within(nested).getByLabelText("Rolle"), {
      target: { value: "r-probe" },
    });
    await fireEvent.click(within(nested).getByRole("button", { name: "Übernehmen" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Rolle zuweisen" })).toBeNull(),
    );
    await clickIn("Weiter");
    await within(dialog()).findByLabelText(/^Wochenstunden/);
    await clickIn("Weiter");
    await within(dialog()).findByRole("button", { name: "Person anlegen" });
  }

  it("posts the drafts only after POST /employees, one per role, for the new user", async () => {
    mount();
    await draftRoleAndGoToEnd();
    await clickIn("Person anlegen");
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[0][0]).toBe("/employees");
    expect(post.mock.calls[1]).toEqual([
      "/role-assignments",
      { userId: "u-new", accessRoleId: "r-probe", scope: { type: "TENANT" } },
    ]);
    await waitFor(() => expect(success).toHaveBeenCalledWith("Person angelegt. Rolle zugewiesen."));
    expect(goto).not.toHaveBeenCalled();
  });

  it("keeps the person when a draft is refused and opens its tab „Berechtigungen“", async () => {
    post.mockImplementation(async (path: string) => {
      if (path === "/employees") return { id: "e-new", userId: "u-new" };
      throw new ApiError(409, "Paket nicht gebucht");
    });
    const onCreated = mount();
    await draftRoleAndGoToEnd();
    await clickIn("Person anlegen");
    await waitFor(() => expect(goto).toHaveBeenCalledWith("/admin/employees/e-new#zugang"));
    expect(onCreated).toHaveBeenCalledWith("e-new");
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("Die Person ist angelegt.");
    expect(String(error.mock.calls[0][0])).toContain("Paket nicht gebucht");
    expect(success).not.toHaveBeenCalled();
  });

  it("without role-assignment:manage it only explains that roles are assigned later", async () => {
    permissions.list = [];
    mount();
    await fillPerson();
    await clickIn("Weiter");
    const d = within(dialog());
    expect(await d.findByText(/Weitere Rollen weist du nach dem Anlegen/)).toBeInTheDocument();
    expect(d.queryByRole("button", { name: "Rolle zuweisen" })).toBeNull();
  });
});

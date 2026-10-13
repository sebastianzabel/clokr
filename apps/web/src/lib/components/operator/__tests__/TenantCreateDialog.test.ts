// Issue #89 (AC-89-01, D-07a, D-13) - the create-tenant dialog, mounted.
//
// The dialog takes onCreate / onOpen / onCreated as props, so it is driven without the operator
// client or SvelteKit. Pinned here: nothing preselected for the Bundesland, a submit that stays
// disabled until the form is valid, the exact request body, the slug that follows the name until
// it is edited by hand, server problems attached to their field by CODE with the dialog still
// open, and the result view with the invitation outcome.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import { OperatorApiError } from "$lib/operator/client";
import type { CreateTenantBody, CreateTenantResult } from "$lib/operator/types";
import TenantCreateDialog from "../TenantCreateDialog.svelte";

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function el<T extends HTMLElement = HTMLInputElement>(id: string): T {
  const found = byId<T>(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

async function typeInto(id: string, value: string) {
  const input = el<HTMLInputElement>(id);
  input.value = value;
  await fireEvent.input(input);
}

async function blur(id: string) {
  await fireEvent.blur(el(id));
}

async function choose(id: string, value: string) {
  const select = el<HTMLSelectElement>(id);
  select.value = value;
  await fireEvent.change(select);
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
}

/** Fill every required field with valid values. */
async function fillValid() {
  await typeInto("op-tenant-create-name", "Beispiel Friseure GmbH");
  await choose("op-tenant-create-federal-state", "NIEDERSACHSEN");
  await typeInto("op-tenant-create-admin-email", "Admin@Example.INVALID");
  await typeInto("op-tenant-create-admin-first-name", "Vorname");
  await typeInto("op-tenant-create-admin-last-name", "Nachname");
}

async function submit() {
  await fireEvent.click(el("op-tenant-create-submit"));
  await settle();
}

function created(mailSent: boolean): CreateTenantResult {
  return {
    tenant: {
      id: "tenant-new",
      name: "Beispiel Friseure GmbH",
      slug: "beispiel-friseure-gmbh",
      federalState: "NIEDERSACHSEN",
      createdAt: "2026-10-13T08:00:00.000Z",
      deactivatedAt: null,
      deactivatedReason: null,
    },
    defaultSalonId: "salon-1",
    adminEmployeeId: "employee-1",
    invitationMailSent: mailSent,
  };
}

function mount(onCreate = vi.fn().mockResolvedValue(created(true))) {
  const onOpen = vi.fn();
  const onCreated = vi.fn();
  renderWithTheme(TenantCreateDialog, { open: true, onCreate, onOpen, onCreated }, "nacht");
  return { onCreate, onOpen, onCreated };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TenantCreateDialog - initial state", () => {
  it("opens as a dialog with the eyebrow and the title", () => {
    mount();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveTextContent("Neuer Mandant");
    expect(dialog?.querySelector("h3")).toHaveTextContent("Mandant anlegen");
    expect(byId("op-tenant-create-dialog")).not.toBeNull();
  });

  it("preselects no Bundesland (nothing is fixed by accident)", () => {
    mount();
    const select = el<HTMLSelectElement>("op-tenant-create-federal-state");
    expect(select.value).toBe("");
    expect(select.selectedOptions[0]).toHaveTextContent("Bundesland wählen");
    expect(select.options).toHaveLength(17);
  });

  it("states that the Bundesland is fixed for the default salon", () => {
    mount();
    expect(document.body).toHaveTextContent(
      "Gilt für den Standardsalon und bestimmt dessen Feiertage. Nach dem Anlegen nicht mehr änderbar.",
    );
  });

  it("offers the three timezones as suggestions and the system default as placeholder", () => {
    mount();
    const timezone = el<HTMLInputElement>("op-tenant-create-timezone");
    expect(timezone.placeholder).toBe("Standard des Systems");
    const options = [...document.querySelectorAll("datalist option")].map((o) =>
      o.getAttribute("value"),
    );
    expect(options).toEqual(["Europe/Berlin", "Europe/Vienna", "Europe/Zurich"]);
  });

  it("has the first-administration group with its four fields", () => {
    mount();
    expect(document.body).toHaveTextContent("Erste Administration");
    for (const id of [
      "admin-email",
      "admin-first-name",
      "admin-last-name",
      "admin-employee-number",
    ]) {
      expect(byId(`op-tenant-create-${id}`), id).not.toBeNull();
    }
  });

  it("keeps the submit disabled while the form is empty", () => {
    mount();
    expect(el<HTMLButtonElement>("op-tenant-create-submit")).toBeDisabled();
  });
});

describe("TenantCreateDialog - validation", () => {
  it("keeps the submit disabled while the Bundesland is unchosen", async () => {
    mount();
    await fillValid();
    await choose("op-tenant-create-federal-state", "");
    expect(el<HTMLButtonElement>("op-tenant-create-submit")).toBeDisabled();
    await choose("op-tenant-create-federal-state", "BAYERN");
    expect(el<HTMLButtonElement>("op-tenant-create-submit")).toBeEnabled();
  });

  it("shows a field problem only after blur, with aria-invalid and a described-by link", async () => {
    mount();
    expect(byId("op-tenant-create-field-error-name")).toBeNull();
    await blur("op-tenant-create-name");
    const message = el("op-tenant-create-field-error-name");
    expect(message).toHaveTextContent("Name ist erforderlich.");
    expect(message).toHaveAttribute("data-code", "NAME_REQUIRED");
    const input = el("op-tenant-create-name");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toContain(message.id);
  });

  it("shows the Bundesland and e-mail texts after blur", async () => {
    mount();
    await blur("op-tenant-create-federal-state");
    expect(el("op-tenant-create-field-error-federal-state")).toHaveTextContent(
      "Bundesland auswählen.",
    );
    await typeInto("op-tenant-create-admin-email", "kein-mail");
    await blur("op-tenant-create-admin-email");
    expect(el("op-tenant-create-field-error-admin-email")).toHaveTextContent(
      "Gültige E-Mail-Adresse eingeben.",
    );
  });

  it("clears the problem once the field is valid", async () => {
    mount();
    await blur("op-tenant-create-name");
    expect(byId("op-tenant-create-field-error-name")).not.toBeNull();
    await typeInto("op-tenant-create-name", "Salon");
    expect(byId("op-tenant-create-field-error-name")).toBeNull();
    expect(el("op-tenant-create-name")).not.toHaveAttribute("aria-invalid");
  });

  it("submitting the form (Enter) with an invalid form shows every problem and sends nothing", async () => {
    const { onCreate } = mount();
    await fireEvent.submit(document.getElementById("op-tenant-create-form") as HTMLFormElement);
    await settle();
    expect(onCreate).not.toHaveBeenCalled();
    for (const key of [
      "name",
      "slug",
      "federal-state",
      "admin-email",
      "admin-first-name",
      "admin-last-name",
    ]) {
      expect(byId(`op-tenant-create-field-error-${key}`), key).not.toBeNull();
    }
    expect(document.activeElement).toBe(el("op-tenant-create-name"));
  });
});

describe("TenantCreateDialog - slug suggestion", () => {
  it("suggests the Kurzname from the name", async () => {
    mount();
    await typeInto("op-tenant-create-name", "Müller Friseure GmbH");
    expect(el<HTMLInputElement>("op-tenant-create-slug").value).toBe("mueller-friseure-gmbh");
  });

  it("stops following the name once the Kurzname was edited by hand", async () => {
    mount();
    await typeInto("op-tenant-create-name", "Erster Name");
    await typeInto("op-tenant-create-slug", "mein-kurzname");
    await typeInto("op-tenant-create-name", "Ganz Anderer Name");
    expect(el<HTMLInputElement>("op-tenant-create-slug").value).toBe("mein-kurzname");
  });
});

describe("TenantCreateDialog - create", () => {
  it("passes the exact API body to onCreate (optional keys omitted, e-mail lower-cased)", async () => {
    const { onCreate } = mount();
    await fillValid();
    await submit();

    expect(onCreate).toHaveBeenCalledTimes(1);
    const body = onCreate.mock.calls[0][0] as CreateTenantBody;
    expect(body).toEqual({
      name: "Beispiel Friseure GmbH",
      slug: "beispiel-friseure-gmbh",
      federalState: "NIEDERSACHSEN",
      admin: { email: "admin@example.invalid", firstName: "Vorname", lastName: "Nachname" },
    });
    expect("timezone" in body).toBe(false);
    expect("employeeNumber" in body.admin).toBe(false);
  });

  it("sends the optional timezone and employee number when filled", async () => {
    const { onCreate } = mount();
    await fillValid();
    await typeInto("op-tenant-create-timezone", "Europe/Vienna");
    await typeInto("op-tenant-create-admin-employee-number", "P-1");
    await submit();

    const body = onCreate.mock.calls[0][0] as CreateTenantBody;
    expect(body.timezone).toBe("Europe/Vienna");
    expect(body.admin.employeeNumber).toBe("P-1");
  });

  it("cannot be submitted twice while the request is pending", async () => {
    let finish: (value: CreateTenantResult) => void = () => undefined;
    const onCreate = vi.fn().mockReturnValue(
      new Promise<CreateTenantResult>((resolve) => {
        finish = resolve;
      }),
    );
    mount(onCreate);
    await fillValid();
    await fireEvent.click(el("op-tenant-create-submit"));
    await settle();

    const submitButton = el<HTMLButtonElement>("op-tenant-create-submit");
    expect(submitButton).toBeDisabled();
    expect(submitButton).toHaveTextContent("Wird angelegt …");
    expect(el<HTMLButtonElement>("op-tenant-create-cancel")).toBeDisabled();
    await fireEvent.submit(document.getElementById("op-tenant-create-form") as HTMLFormElement);
    await settle();
    expect(onCreate).toHaveBeenCalledTimes(1);

    finish(created(true));
    await settle();
    expect(byId("op-tenant-create-result")).not.toBeNull();
  });

  it("replaces the form with the result view, names the tenant and the default salon", async () => {
    const { onCreated } = mount();
    await fillValid();
    await submit();

    expect(byId("op-tenant-create-form")).toBeNull();
    expect(document.getElementById("op-tenant-create-form")).toBeNull();
    const resultView = el("op-tenant-create-result");
    expect(resultView).toHaveTextContent(
      "Der Mandant „Beispiel Friseure GmbH“ wurde mit einem Standardsalon angelegt.",
    );
    expect(document.querySelector("h3")).toHaveTextContent("Mandant angelegt");
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("reports a sent invitation with the e-mail address", async () => {
    mount();
    await fillValid();
    await submit();

    const mail = el("op-tenant-create-result-mail");
    expect(mail).toHaveAttribute("data-state", "sent");
    expect(mail).toHaveTextContent("Die Einladung wurde an admin@example.invalid gesendet.");
  });

  it("reports an invitation that could not be sent and the resend hint", async () => {
    mount(vi.fn().mockResolvedValue(created(false)));
    await fillValid();
    await submit();

    const mail = el("op-tenant-create-result-mail");
    expect(mail).toHaveAttribute("data-state", "not-sent");
    expect(mail).toHaveTextContent("Auf der Mandantenseite lässt sie sich erneut senden.");
  });

  it("opens the created tenant from the result view", async () => {
    const { onOpen } = mount();
    await fillValid();
    await submit();

    await fireEvent.click(el("op-tenant-create-result-open"));
    expect(onOpen).toHaveBeenCalledWith("tenant-new");
  });

  it("closes from the result view", async () => {
    mount();
    await fillValid();
    await submit();

    await fireEvent.click(el("op-tenant-create-result-close"));
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("TenantCreateDialog - server problems (by code)", () => {
  it("attaches SLUG_TAKEN to the Kurzname field and keeps the dialog open", async () => {
    mount(
      vi
        .fn()
        .mockRejectedValue(
          new OperatorApiError(409, "SLUG_TAKEN", "Dieser Kurzname ist bereits vergeben."),
        ),
    );
    await fillValid();
    await submit();

    const message = el("op-tenant-create-field-error-slug");
    expect(message).toHaveAttribute("data-code", "SLUG_TAKEN");
    expect(message).toHaveTextContent("Dieser Kurzname ist bereits vergeben.");
    const slug = el("op-tenant-create-slug");
    expect(slug).toHaveAttribute("aria-invalid", "true");
    expect(slug.getAttribute("aria-describedby")).toContain(message.id);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(byId("op-tenant-create-result")).toBeNull();
    expect(document.activeElement).toBe(slug);
  });

  it("attaches EMAIL_TAKEN to the e-mail field", async () => {
    mount(vi.fn().mockRejectedValue(new OperatorApiError(409, "EMAIL_TAKEN", "x")));
    await fillValid();
    await submit();

    const message = el("op-tenant-create-field-error-admin-email");
    expect(message).toHaveAttribute("data-code", "EMAIL_TAKEN");
    expect(message).toHaveTextContent("Diese E-Mail-Adresse wird bereits verwendet.");
    expect(el("op-tenant-create-admin-email")).toHaveAttribute("aria-invalid", "true");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("attaches a timezone 400 to the Zeitzone field", async () => {
    mount(
      vi.fn().mockRejectedValue(
        new OperatorApiError(400, undefined, "Validierungsfehler", {
          error: "Validierungsfehler",
          details: [{ path: ["timezone"], message: "Ungültige Zeitzone" }],
        }),
      ),
    );
    await fillValid();
    await typeInto("op-tenant-create-timezone", "Mars/Olympus");
    await submit();

    const message = el("op-tenant-create-field-error-timezone");
    expect(message).toHaveAttribute("data-code", "TIMEZONE_INVALID");
    expect(message).toHaveTextContent("Ungültige Zeitzone.");
    expect(el("op-tenant-create-timezone")).toHaveAttribute("aria-invalid", "true");
  });

  it("clears a server problem when the field is edited and allows a new try", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new OperatorApiError(409, "SLUG_TAKEN", "x"))
      .mockResolvedValueOnce(created(true));
    mount(onCreate);
    await fillValid();
    await submit();
    expect(byId("op-tenant-create-field-error-slug")).not.toBeNull();

    await typeInto("op-tenant-create-slug", "anderer-kurzname");
    expect(byId("op-tenant-create-field-error-slug")).toBeNull();
    await submit();

    expect(onCreate).toHaveBeenCalledTimes(2);
    expect((onCreate.mock.calls[1][0] as CreateTenantBody).slug).toBe("anderer-kurzname");
    expect(byId("op-tenant-create-result")).not.toBeNull();
  });

  it("shows any other failure as a dialog-level alert and keeps the dialog open", async () => {
    mount(vi.fn().mockRejectedValue(new OperatorApiError(500, undefined, "Fehler")));
    await fillValid();
    await submit();

    const alert = el("op-tenant-create-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(
      "Der Server hat einen Fehler gemeldet. Bitte erneut versuchen.",
    );
    expect(document.activeElement).toBe(alert);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(el<HTMLButtonElement>("op-tenant-create-submit")).toBeEnabled();
  });

  it("names a lost connection", async () => {
    mount(vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await fillValid();
    await submit();
    expect(el("op-tenant-create-error")).toHaveTextContent(
      "Keine Verbindung zum Server. Bitte erneut versuchen.",
    );
  });

  it("does not treat a matching German text under another code as a field problem", async () => {
    mount(
      vi
        .fn()
        .mockRejectedValue(
          new OperatorApiError(409, "SOMETHING_ELSE", "Dieser Kurzname ist bereits vergeben."),
        ),
    );
    await fillValid();
    await submit();
    expect(byId("op-tenant-create-field-error-slug")).toBeNull();
    expect(byId("op-tenant-create-error")).not.toBeNull();
  });
});

// Issue #854 (plan 854-08) - the three sections of Regeln › Benachrichtigungen & E-Mail, mounted: each saves
// exactly the keys of its registry section through its own SaveBar to its own endpoint, the SMTP password is
// write-only (never shown, sent only when typed), the test mail is an action of its own, and a failed save
// keeps the edit.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";

const put = vi.fn();
const post = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({
  api: { put: (...a: unknown[]) => put(...a), post: (...a: unknown[]) => post(...a) },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import { settingsSection } from "$lib/settings/settings-pages";
import EmailSection from "../EmailSection.svelte";
import RemindersSection from "../RemindersSection.svelte";
import SmtpSection from "../SmtpSection.svelte";

const keysOf = (id: string) => [...settingsSection(id).keys].sort();
const bar = () => screen.queryByRole("region", { name: "Speicherleiste" });
/** The request body as the server receives it (undefined values are dropped by JSON). */
const sentBody = (call = 0) => JSON.parse(JSON.stringify(put.mock.calls[call][1]));

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({});
  post.mockResolvedValue({});
});

const SMTP = {
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpUser: "mailer",
  smtpPasswordSet: true,
  smtpFromEmail: "noreply@example.com",
  smtpFromName: "Clokr",
  smtpSecure: false,
};

describe("SmtpSection", () => {
  const password = () => screen.getByLabelText(/^Passwort/) as HTMLInputElement;

  it("never shows a stored password, only that one is stored", () => {
    renderWithTheme(SmtpSection, { config: SMTP });
    expect(password().value).toBe("");
    expect(screen.getByText("Passwort (gespeichert)")).toBeTruthy();
    expect(bar()).toBeNull();
  });

  it("an edit without a typed password sends the six other keys and NO smtpPassword", async () => {
    renderWithTheme(SmtpSection, { config: SMTP });
    await fireEvent.input(screen.getByLabelText("Server"), {
      target: { value: "mail.example.org" },
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Server speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toBe("/settings/smtp");
    const body = sentBody();
    expect(body.smtpHost).toBe("mail.example.org");
    expect("smtpPassword" in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(
      keysOf("benachrichtigungen-smtp").filter((k) => k !== "smtpPassword"),
    );
  });

  it("a typed password is sent, then the field is empty again and the section is clean", async () => {
    renderWithTheme(SmtpSection, { config: { ...SMTP, smtpPasswordSet: false } });
    expect(screen.getByText("Passwort")).toBeTruthy();
    await fireEvent.input(password(), { target: { value: "geheim-123" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Server speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(sentBody().smtpPassword).toBe("geheim-123");
    expect(Object.keys(sentBody()).sort()).toEqual(keysOf("benachrichtigungen-smtp"));
    await waitFor(() => expect(bar()).toBeNull());
    expect(password().value).toBe("");
    expect(screen.getByText("Passwort (gespeichert)")).toBeTruthy();
  });

  it("blocks an invalid port and a malformed sender address", async () => {
    renderWithTheme(SmtpSection, { config: SMTP });
    await fireEvent.input(screen.getByLabelText("Port"), { target: { value: "70000" } });
    await fireEvent.input(screen.getByLabelText("Absenderadresse"), { target: { value: "nope" } });
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("2 Fehler");
    expect(
      (screen.getByRole("button", { name: "Server speichern" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("the test mail is its own request and needs an address", async () => {
    renderWithTheme(SmtpSection, { config: SMTP });
    const send = screen.getByRole("button", { name: "Test-E-Mail senden" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await fireEvent.input(screen.getByLabelText("Test-E-Mail senden an"), {
      target: { value: "me@example.com" },
    });
    await fireEvent.click(send);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/settings/smtp/test", { email: "me@example.com" });
    expect(put).not.toHaveBeenCalled();
    await waitFor(() => expect(success).toHaveBeenCalledWith("Test-E-Mail wurde gesendet."));
  });

  it("shows the server's text when the test mail fails", async () => {
    post.mockRejectedValue(new Error("SMTP-Fehler: Verbindung abgelehnt"));
    renderWithTheme(SmtpSection, { config: SMTP });
    await fireEvent.input(screen.getByLabelText("Test-E-Mail senden an"), {
      target: { value: "me@example.com" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Test-E-Mail senden" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("SMTP-Fehler: Verbindung abgelehnt"));
  });

  it("keeps the edit and shows the server text when the save fails", async () => {
    put.mockRejectedValue(new Error("Ungültiger Server."));
    renderWithTheme(SmtpSection, { config: SMTP });
    await fireEvent.input(screen.getByLabelText("Server"), { target: { value: "x.example.org" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Server speichern" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Ungültiger Server."));
    expect((screen.getByLabelText("Server") as HTMLInputElement).value).toBe("x.example.org");
    expect(bar()).not.toBeNull();
  });
});

describe("EmailSection", () => {
  it("sends exactly the eight keys of its section to /settings/security", async () => {
    renderWithTheme(EmailSection, {
      config: { emailNotificationsEnabled: false, emailOnMonthClose: true },
    });
    await fireEvent.click(screen.getByLabelText("E-Mail-Benachrichtigungen aktivieren"));
    await fireEvent.click(screen.getByLabelText("Fehlende Zeiteinträge"));
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("2 Änderungen");
    await fireEvent.click(screen.getByRole("button", { name: "Benachrichtigungen speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toBe("/settings/security");
    expect(Object.keys(sentBody()).sort()).toEqual(keysOf("benachrichtigungen-email"));
    expect(sentBody()).toMatchObject({
      emailNotificationsEnabled: true,
      emailOnMissingEntries: true,
      emailOnMonthClose: true,
    });
  });

  it("the types are shown but disabled while the master switch is off", async () => {
    renderWithTheme(EmailSection, { config: { emailNotificationsEnabled: false } });
    const type = screen.getByLabelText("Neuer Urlaubsantrag") as HTMLInputElement;
    expect(type.disabled).toBe(true);
    await fireEvent.click(screen.getByLabelText("E-Mail-Benachrichtigungen aktivieren"));
    expect(type.disabled).toBe(false);
  });

  it("keeps the edit when the save fails", async () => {
    put.mockRejectedValue(new Error("Keine Berechtigung."));
    renderWithTheme(EmailSection, { config: { emailNotificationsEnabled: false } });
    await fireEvent.click(screen.getByLabelText("E-Mail-Benachrichtigungen aktivieren"));
    await fireEvent.click(
      await screen.findByRole("button", { name: "Benachrichtigungen speichern" }),
    );
    await waitFor(() => expect(error).toHaveBeenCalledWith("Keine Berechtigung."));
    expect(
      (screen.getByLabelText("E-Mail-Benachrichtigungen aktivieren") as HTMLInputElement).checked,
    ).toBe(true);
    expect(bar()).not.toBeNull();
  });
});

describe("RemindersSection", () => {
  const CONFIG = {
    clockOutReminderHours: 10,
    missingEntriesDays: 7,
    reminderPendingLeaveEnabled: true,
    reminderPendingLeaveHours: 48,
    reminderUpcomingAbsenceEnabled: true,
    reminderUpcomingAbsenceDays: 3,
  };

  it("sends exactly the six keys of its section to /settings/work, whole numbers", async () => {
    renderWithTheme(RemindersSection, { config: CONFIG });
    await fireEvent.input(
      screen.getByLabelText("Erinnerung bei fehlenden Einträgen nach (Tagen)"),
      {
        target: { value: "14" },
      },
    );
    await fireEvent.click(await screen.findByRole("button", { name: "Erinnerungen speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toBe("/settings/work");
    expect(Object.keys(sentBody()).sort()).toEqual(keysOf("benachrichtigungen-erinnerungen"));
    expect(sentBody()).toMatchObject({ ...CONFIG, missingEntriesDays: 14 });
  });

  it("hides the threshold of a switched-off reminder and still sends a valid number for it", async () => {
    renderWithTheme(RemindersSection, { config: CONFIG });
    await fireEvent.click(screen.getByLabelText("Offene Urlaubsanträge: Vorgesetzte erinnern"));
    expect(screen.queryByLabelText("Erinnern nach (Stunden)")).toBeNull();
    await fireEvent.click(await screen.findByRole("button", { name: "Erinnerungen speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      reminderPendingLeaveEnabled: false,
      reminderPendingLeaveHours: 48,
    });
  });

  it("blocks a value outside the server's bounds", async () => {
    renderWithTheme(RemindersSection, { config: CONFIG });
    await fireEvent.input(
      screen.getByLabelText("Erinnerung bei offener Stempelung nach (Stunden)"),
      {
        target: { value: "49" },
      },
    );
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("1 Fehler");
    expect(put).not.toHaveBeenCalled();
  });
});

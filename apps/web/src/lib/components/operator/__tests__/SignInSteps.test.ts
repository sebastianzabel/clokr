// Issue #89 (D-03, D-04, T-89-08, T-89-09) - the operator sign-in in two steps, mounted.
//
// The component takes its three callbacks as props, so it is driven here without the operator
// client, the session store or SvelteKit navigation. What is pinned: the generic error handling,
// that the sixth digit never submits (a pasted wrong code must not burn one of five attempts), the
// recovery path, challenge expiry, and that the password is never refilled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import SignInSteps from "../SignInSteps.svelte";

class FakeApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function input(id: string): HTMLInputElement {
  const el = byId<HTMLInputElement>(id);
  if (!el) throw new Error(`missing test id ${id}`);
  return el;
}

function button(id: string): HTMLButtonElement {
  const el = byId<HTMLButtonElement>(id);
  if (!el) throw new Error(`missing test id ${id}`);
  return el;
}

async function typeInto(id: string, value: string) {
  const el = input(id);
  el.value = value;
  await fireEvent.input(el);
}

/** Let pending promise callbacks and Svelte's microtask updates settle. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
}

const CHALLENGE = { challengeToken: "challenge-1", expiresIn: 300 };
const ACCESS = { accessToken: "access-1", expiresIn: 900 };

function mount(overrides: Record<string, unknown> = {}) {
  const onLogin = vi.fn().mockResolvedValue(CHALLENGE);
  const onVerify = vi.fn().mockResolvedValue(ACCESS);
  const onSuccess = vi.fn();
  renderWithTheme(SignInSteps, { onLogin, onVerify, onSuccess, ...overrides }, "nacht");
  return { onLogin, onVerify, onSuccess };
}

async function reachStepTwo(handlers: ReturnType<typeof mount>) {
  await typeInto("op-signin-email", "op@example.invalid");
  await typeInto("op-signin-password", "correct horse");
  await fireEvent.submit(byId("op-signin-step-password") as HTMLFormElement);
  await settle();
  expect(handlers.onLogin).toHaveBeenCalledTimes(1);
}

describe("SignInSteps - step 1", () => {
  it("renders email, password and the confirm button", () => {
    mount();
    expect(byId("op-signin-step-password")).not.toBeNull();
    expect(input("op-signin-email").type).toBe("email");
    expect(input("op-signin-password").type).toBe("password");
    expect(button("op-signin-next")).toHaveTextContent("Passwort bestätigen");
    expect(byId("op-signin-step-code")).toBeNull();
  });

  it("focuses the email field on load", async () => {
    mount();
    await settle();
    expect(document.activeElement).toBe(input("op-signin-email"));
  });

  it("toggles the password visibility with a labelled button", async () => {
    mount();
    const toggle = button("op-signin-password-toggle");
    expect(toggle).toHaveAttribute("aria-label", "Passwort anzeigen");
    await fireEvent.click(toggle);
    expect(input("op-signin-password").type).toBe("text");
    expect(toggle).toHaveAttribute("aria-label", "Passwort verbergen");
  });

  it("passes email and password to onLogin and switches to step 2 with the code focused", async () => {
    const h = mount();
    await reachStepTwo(h);

    expect(h.onLogin).toHaveBeenCalledWith("op@example.invalid", "correct horse");
    expect(byId("op-signin-step-code")).not.toBeNull();
    expect(byId("op-signin-step-password")).toBeNull();
    expect(document.activeElement).toBe(input("op-signin-code"));
  });

  it("shows the server text on a 401, keeps email and password, and stays on step 1", async () => {
    const onLogin = vi.fn().mockRejectedValue(new FakeApiError(401, "Anmeldung fehlgeschlagen"));
    mount({ onLogin });
    await typeInto("op-signin-email", "op@example.invalid");
    await typeInto("op-signin-password", "wrong");
    await fireEvent.submit(byId("op-signin-step-password") as HTMLFormElement);
    await settle();

    const error = byId("op-signin-error") as HTMLElement;
    expect(error).toHaveTextContent("Anmeldung fehlgeschlagen");
    expect(error).toHaveAttribute("role", "alert");
    expect(input("op-signin-email").value).toBe("op@example.invalid");
    expect(input("op-signin-password").value).toBe("wrong");
    expect(byId("op-signin-step-code")).toBeNull();
  });

  it("shows the rate-limit text on a 429", async () => {
    const onLogin = vi.fn().mockRejectedValue(new FakeApiError(429, "Too Many Requests"));
    mount({ onLogin });
    await typeInto("op-signin-email", "op@example.invalid");
    await typeInto("op-signin-password", "x");
    await fireEvent.submit(byId("op-signin-step-password") as HTMLFormElement);
    await settle();

    expect(byId("op-signin-error")).toHaveTextContent(
      "Zu viele Versuche. Bitte später erneut versuchen.",
    );
  });

  it("shows the connection text when the call fails without a status", async () => {
    const onLogin = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    mount({ onLogin });
    await typeInto("op-signin-email", "op@example.invalid");
    await typeInto("op-signin-password", "x");
    await fireEvent.submit(byId("op-signin-step-password") as HTMLFormElement);
    await settle();

    expect(byId("op-signin-error")).toHaveTextContent(
      "Keine Verbindung zum Server. Bitte erneut versuchen.",
    );
  });

  it("treats a 404 on step 1 as the surface being off", async () => {
    const onLogin = vi.fn().mockRejectedValue(new FakeApiError(404, "Nicht gefunden"));
    mount({ onLogin });
    await typeInto("op-signin-email", "op@example.invalid");
    await typeInto("op-signin-password", "x");
    await fireEvent.submit(byId("op-signin-step-password") as HTMLFormElement);
    await settle();

    expect(byId("op-surface-off")).toHaveTextContent(
      "Der Betreiberzugang ist auf dieser Instanz nicht eingerichtet.",
    );
    expect(byId("op-signin-email")).toBeNull();
    expect(byId("op-signin-error")).toBeNull();
  });

  it("renders only the surface-off sentence when told the surface is off", () => {
    mount({ surfaceOff: true });
    expect(byId("op-surface-off")).toHaveTextContent(
      "Der Betreiberzugang ist auf dieser Instanz nicht eingerichtet.",
    );
    expect(byId("op-signin-email")).toBeNull();
    expect(byId("op-signin-error")).toBeNull();
    expect(byId("op-signin-notice")).toBeNull();
  });

  it("shows the session-expired notice with its client-side code", () => {
    mount({ notice: "SESSION_EXPIRED" });
    const notice = byId("op-signin-notice") as HTMLElement;
    expect(notice).toHaveAttribute("data-code", "SESSION_EXPIRED");
    expect(notice).toHaveTextContent("Die Sitzung ist abgelaufen. Bitte erneut anmelden.");
  });
});

describe("SignInSteps - step 2", () => {
  it("strips non-digits and caps the code at six", async () => {
    const h = mount();
    await reachStepTwo(h);

    await typeInto("op-signin-code", "12a3-45 6789");
    expect(input("op-signin-code").value).toBe("123456");
    expect(input("op-signin-code")).toHaveAttribute("maxlength", "6");
    expect(input("op-signin-code")).toHaveAttribute("inputmode", "numeric");
    expect(input("op-signin-code")).toHaveAttribute("autocomplete", "one-time-code");
  });

  it("uses the shared otp-input recipe class", async () => {
    const h = mount();
    await reachStepTwo(h);
    const classes = input("op-signin-code").className.split(/\s+/);
    expect(classes).toContain("form-input");
    expect(classes).toContain("otp-input");
  });

  it("keeps the submit button disabled below six digits", async () => {
    const h = mount();
    await reachStepTwo(h);

    expect(button("op-signin-submit")).toBeDisabled();
    await typeInto("op-signin-code", "12345");
    expect(button("op-signin-submit")).toBeDisabled();
    await typeInto("op-signin-code", "123456");
    expect(button("op-signin-submit")).not.toBeDisabled();
  });

  it("does NOT call onVerify when the sixth digit is typed, only on explicit submit", async () => {
    const h = mount();
    await reachStepTwo(h);

    await typeInto("op-signin-code", "123456");
    await settle();
    expect(h.onVerify).not.toHaveBeenCalled();

    await fireEvent.click(button("op-signin-submit"));
    await settle();
    expect(h.onVerify).toHaveBeenCalledTimes(1);
    expect(h.onVerify).toHaveBeenCalledWith("challenge-1", { code: "123456" });
  });

  it("does not submit a short code even when the form is submitted directly", async () => {
    const h = mount();
    await reachStepTwo(h);

    await typeInto("op-signin-code", "123");
    await fireEvent.submit(byId("op-signin-step-code") as HTMLFormElement);
    await settle();
    expect(h.onVerify).not.toHaveBeenCalled();
  });

  it("hands the token to onSuccess after a good code", async () => {
    const h = mount();
    await reachStepTwo(h);

    await typeInto("op-signin-code", "123456");
    await fireEvent.submit(byId("op-signin-step-code") as HTMLFormElement);
    await settle();

    expect(h.onSuccess).toHaveBeenCalledWith("access-1", 900);
  });

  it("shows the generic error on a 401, empties the code and refocuses it", async () => {
    const onVerify = vi.fn().mockRejectedValue(new FakeApiError(401, "Anmeldung fehlgeschlagen"));
    const h = mount({ onVerify });
    await reachStepTwo(h);

    await typeInto("op-signin-code", "123456");
    await fireEvent.submit(byId("op-signin-step-code") as HTMLFormElement);
    await settle();

    expect(byId("op-signin-error")).toHaveTextContent("Anmeldung fehlgeschlagen");
    expect(input("op-signin-code").value).toBe("");
    expect(document.activeElement).toBe(input("op-signin-code"));
    expect(h.onSuccess).not.toHaveBeenCalled();
  });

  it("swaps to the recovery field and back; onVerify gets exactly one factor", async () => {
    const h = mount();
    await reachStepTwo(h);

    await fireEvent.click(button("op-signin-recovery-toggle"));
    expect(byId("op-signin-code")).toBeNull();
    const recovery = input("op-signin-recovery");
    expect(recovery).toHaveAttribute("maxlength", "64");
    expect(recovery).toHaveAttribute("autocapitalize", "characters");
    expect(recovery).toHaveAttribute("autocomplete", "off");
    expect(recovery).toHaveAttribute("spellcheck", "false");
    expect(button("op-signin-submit")).toBeDisabled();

    await typeInto("op-signin-recovery", "AAAA-BBBB-CCCC-DDDD");
    expect(button("op-signin-submit")).not.toBeDisabled();
    await fireEvent.submit(byId("op-signin-step-code") as HTMLFormElement);
    await settle();

    expect(h.onVerify).toHaveBeenCalledTimes(1);
    expect(h.onVerify).toHaveBeenCalledWith("challenge-1", { recoveryCode: "AAAA-BBBB-CCCC-DDDD" });
  });

  it("the recovery toggle returns to the code field", async () => {
    const h = mount();
    await reachStepTwo(h);

    await fireEvent.click(button("op-signin-recovery-toggle"));
    await fireEvent.click(button("op-signin-recovery-toggle"));
    await settle();
    expect(byId("op-signin-recovery")).toBeNull();
    expect(byId("op-signin-code")).not.toBeNull();
  });

  it("the back button returns to step 1 with an empty password", async () => {
    const h = mount();
    await reachStepTwo(h);

    await fireEvent.click(button("op-signin-back"));
    await settle();

    expect(byId("op-signin-step-password")).not.toBeNull();
    expect(input("op-signin-email").value).toBe("op@example.invalid");
    expect(input("op-signin-password").value).toBe("");
  });
});

describe("SignInSteps - challenge expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns to step 1 with the expired notice after expiresIn seconds, password empty", async () => {
    const h = mount();
    await reachStepTwo(h);
    await typeInto("op-signin-code", "12");

    await vi.advanceTimersByTimeAsync(299_000);
    await settle();
    expect(byId("op-signin-step-code")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_500);
    await settle();

    expect(byId("op-signin-step-password")).not.toBeNull();
    expect(byId("op-signin-step-code")).toBeNull();
    const notice = byId("op-signin-notice") as HTMLElement;
    expect(notice).toHaveAttribute("data-code", "CHALLENGE_EXPIRED");
    expect(notice).toHaveTextContent(
      "Die Eingabe ist abgelaufen. Bitte mit dem Passwort neu beginnen.",
    );
    expect(input("op-signin-password").value).toBe("");
    expect(h.onVerify).not.toHaveBeenCalled();
  });

  it("a successful verify cancels the timer", async () => {
    const h = mount();
    await reachStepTwo(h);
    await typeInto("op-signin-code", "123456");
    await fireEvent.submit(byId("op-signin-step-code") as HTMLFormElement);
    await settle();
    expect(h.onSuccess).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(400_000);
    await settle();
    expect(byId("op-signin-notice")).toBeNull();
  });
});

describe("SignInSteps - copy", () => {
  it("addresses the operator neutrally (no Sie, no du)", async () => {
    const h = mount();
    await reachStepTwo(h);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\b(Sie|Ihr|Ihre|Ihnen|du|dein|deine)\b/);
  });
});

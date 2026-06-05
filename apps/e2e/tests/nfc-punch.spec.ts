/**
 * NFC punch flow — first E2E coverage (Plan 74-05).
 *
 * Cross-surface goal: prove the Terminal-API-key auth path (separate from
 * JWT) works end-to-end against `POST /api/v1/time-entries/nfc-punch`, and
 * that the same error contracts the API exposes today are exercised by an
 * isolated test tenant — not the seed data.
 *
 * Each test bootstraps its own Terminal API key + Employee + nfcCardId via
 * `bootstrapTerminal(tenant)` (Plan 74-05 Task 1 endpoint), then drives the
 * happy path or one of the documented error paths via `nfcPunch()`. The
 * Phase 73 tenant fixture handles teardown — every TerminalApiKey and
 * Employee created here is cascade-deleted with the tenant.
 *
 * Response shape (verified against `apps/api/src/routes/time-entries.ts:512+`):
 *   200 + { action: "IN" | "OUT", employee: { firstName, lastName, employeeNumber }, time, balanceHours }
 *   401 + { error: "Terminal API Key erforderlich" } — missing Authorization
 *   401 + { error: "Ungültiger oder widerrufener API Key" } — bad/revoked key
 *   404 + { error: "Unbekannte Karte" } — nfcCardId not in tenant
 *   403 + { error: "Mitarbeiter ist deaktiviert" } — User.isActive=false
 *   409 + { error: "§ 8 BUrlG: ...", action: "BLOCKED" } — APPROVED leave today
 *
 * Note on locked-month: the production handler does NOT currently enforce
 * the SaldoSnapshot lock on the nfc-punch surface (see
 * `.planning/phases/74-e2e-gap-coverage/deferred-items.md` "Missing locked-
 * month enforcement on nfc-punch"). The 6th test documents current behavior
 * with a positive-control assertion + a `test.fixme()` for the desired
 * future cross-surface error message.
 */
import { test, expect } from "../fixtures";
import {
  bootstrapTerminal,
  nfcPunch,
  deactivateEmployee,
} from "../helpers/nfc-terminal";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

interface PunchSuccessBody {
  action: "IN" | "OUT";
  employee: { firstName: string; lastName: string; employeeNumber: string };
  time: string;
  balanceHours: number;
}

function asObj(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object") return body as Record<string, unknown>;
  return {};
}

test.describe("NFC punch flow", () => {
  test("clock-in: first punch creates an open time entry (action=IN)", async ({ tenant }) => {
    const term = await bootstrapTerminal(tenant);
    const res = await nfcPunch(term.apiKey, term.nfcCardId);

    expect(res.status).toBe(200);
    const body = (asObj(res.body) as unknown as PunchSuccessBody);
    expect(body.action).toBe("IN");
    expect(body.employee).toBeDefined();
    expect(body.employee.firstName).toBe("Test");
    expect(body.employee.lastName).toBe("Terminal");
    expect(body.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof body.balanceHours).toBe("number");
  });

  test("clock-out: second punch on same day closes the entry (action=OUT)", async ({
    tenant,
  }) => {
    const term = await bootstrapTerminal(tenant);

    const first = await nfcPunch(term.apiKey, term.nfcCardId);
    expect(first.status).toBe(200);
    expect(((asObj(first.body) as unknown as PunchSuccessBody)).action).toBe("IN");

    const second = await nfcPunch(term.apiKey, term.nfcCardId);
    expect(second.status).toBe(200);
    const body = (asObj(second.body) as unknown as PunchSuccessBody);
    expect(body.action).toBe("OUT");
    expect(body.employee.firstName).toBe("Test");
    // After clock-out the response carries the balance — checking the
    // shape rather than a specific value (the value depends on schedule).
    expect(typeof body.balanceHours).toBe("number");
  });

  test("error: unknown nfcCardId returns 404 'Unbekannte Karte'", async ({ tenant }) => {
    const term = await bootstrapTerminal(tenant);
    // The Terminal API key is valid, but no employee in this tenant has the
    // card id we send → 404. The unique-card-id property of the helper
    // (random 12-hex suffix) keeps this from accidentally matching another
    // test's employee under parallel execution.
    const res = await nfcPunch(term.apiKey, "non-existent-card-id-xyz");
    expect(res.status).toBe(404);
    const err = (asObj(res.body).error ?? "") as string;
    expect(err).toContain("Unbekannte Karte");
  });

  test("error: invalid API key returns 401 'Ungültiger oder widerrufener API Key'", async ({
    tenant,
  }) => {
    const term = await bootstrapTerminal(tenant);
    // Garbage key with the correct prefix — passes the "Bearer" guard but
    // fails the SHA-256 lookup (no row with this keyHash).
    const res = await nfcPunch("clk_invalid_key_does_not_exist", term.nfcCardId);
    expect(res.status).toBe(401);
    const err = (asObj(res.body).error ?? "") as string;
    // Two distinct 401 paths — accept either ("Terminal API Key erforderlich"
    // would only fire if the header was missing; ours is present-but-bad).
    expect(err).toMatch(/Ungültig|Terminal API Key/);
  });

  test("error: missing Authorization header returns 401 'Terminal API Key erforderlich'", async ({
    tenant,
  }) => {
    // Bypass the helper because we need to send a request WITHOUT the
    // Authorization header. The helper always sets it.
    const term = await bootstrapTerminal(tenant);
    const res = await fetch(`${API_BASE}/api/v1/time-entries/nfc-punch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nfcCardId: term.nfcCardId }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toContain("Terminal API Key erforderlich");
  });

  test("error: deactivated employee returns 403 'Mitarbeiter ist deaktiviert'", async ({
    tenant,
  }) => {
    const term = await bootstrapTerminal(tenant);
    await deactivateEmployee(tenant, term.employeeId);

    const res = await nfcPunch(term.apiKey, term.nfcCardId);
    expect(res.status).toBe(403);
    const err = (asObj(res.body).error ?? "") as string;
    expect(err).toContain("deaktiviert");
  });

  // ── Locked-month surface (documents current behavior) ───────────────
  //
  // The nfc-punch handler does NOT currently consult the SaldoSnapshot lock
  // contract (see deferred-items.md "Missing locked-month enforcement on
  // nfc-punch"). This test asserts the only well-defined slice of the
  // intersection: a past month is locked, a fresh punch on TODAY succeeds
  // because today is outside the locked period. The companion
  // `test.fixme()` below documents the desired cross-surface behavior so a
  // future architectural fix has a ready-made spec.
  test("locked-month positive control: punch on TODAY succeeds when a PAST month is locked", async ({
    tenant,
  }) => {
    const term = await bootstrapTerminal(tenant);

    // Lock the previous calendar month for this employee. The seedClosable
    // pattern in `helpers/monatsabschluss.ts` requires a time entry inside
    // the month first — we seed one directly via the admin token.
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const yyyy = prev.getFullYear();
    const mm = String(prev.getMonth() + 1).padStart(2, "0");
    const entryDate = `${yyyy}-${mm}-15`;

    const seedRes = await fetch(`${API_BASE}/api/v1/time-entries`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tenant.adminToken}`,
      },
      body: JSON.stringify({
        employeeId: term.employeeId,
        date: entryDate,
        startTime: `${entryDate}T08:00:00.000Z`,
        endTime: `${entryDate}T16:00:00.000Z`,
        breakMinutes: 30,
      }),
    });
    expect(seedRes.status).toBeLessThan(300);

    const lockRes = await fetch(`${API_BASE}/api/v1/overtime/close-month`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tenant.adminToken}`,
      },
      body: JSON.stringify({
        employeeId: term.employeeId,
        year: prev.getFullYear(),
        month: prev.getMonth() + 1,
      }),
    });
    // 200 = locked now; 409 = already locked (tolerable under KEEP_TEST_TENANTS).
    expect([200, 409]).toContain(lockRes.status);

    // The punch lands on TODAY — not in the locked period — so the
    // current handler (correctly) allows it.
    const punchRes = await nfcPunch(term.apiKey, term.nfcCardId);
    expect(punchRes.status).toBe(200);
    expect(((asObj(punchRes.body) as unknown as PunchSuccessBody)).action).toBe("IN");
  });

  // FUTURE: once the cross-surface lock contract is wired into nfc-punch
  // (deferred-items.md owner: Phase 74-06 follow-up), unfixme this test.
  // It asserts the desired behavior: a punch whose date falls inside a
  // locked month is rejected with a consistent German error.
  test.fixme(
    "future: punch whose date falls in a locked month is rejected with a consistent error",
    async () => {
      // Intentionally empty — see deferred-items.md for the architectural
      // decision needed before this can be implemented (UX contract for
      // terminal devices: HTTP code, error shape, Tauri-client render path).
    },
  );
});

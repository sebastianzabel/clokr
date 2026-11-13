// Issue #854 (D-854-09, AC-2) - runPerPerson and the one summary sentence of a bulk change, and the
// "already holds this assignment" check that keeps a predictable 409 out of the run.
import { describe, expect, it, vi } from "vitest";

// The real client pulls in the auth store (localStorage); only the error class matters here.
vi.mock("$api/client", () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError };
});

import { ApiError } from "$api/client";
import { alreadyHoldsAssignment, bulkSummaryText, runPerPerson, sameScope } from "../bulk-actions";

const names: Record<string, string> = { a: "Muster, Max", b: "Beispiel, Eva", c: "Probe, Jo" };
const nameOf = (id: string) => names[id] ?? id;

describe("runPerPerson", () => {
  it("runs every person one after the other in the given order (all ok)", async () => {
    const calls: string[] = [];
    let running = 0;
    let overlap = false;
    const action = vi.fn(async (id: string) => {
      running += 1;
      if (running > 1) overlap = true;
      await Promise.resolve();
      calls.push(id);
      running -= 1;
    });
    const result = await runPerPerson(["a", "b", "c"], action);
    expect(result).toEqual({ ok: ["a", "b", "c"], failed: [] });
    expect(calls).toEqual(["a", "b", "c"]);
    expect(overlap).toBe(false);
  });

  it("keeps going after a refusal and returns the server's text per failed person", async () => {
    const action = async (id: string) => {
      if (id === "b") throw new ApiError(409, "Diese Rolle ist bereits zugewiesen.");
      if (id === "c") throw new Error("Netzwerk");
    };
    const result = await runPerPerson(["a", "b", "c"], action);
    expect(result.ok).toEqual(["a"]);
    expect(result.failed).toEqual([
      { id: "b", message: "Diese Rolle ist bereits zugewiesen." },
      { id: "c", message: "Netzwerk" },
    ]);
  });

  it("falls back to a neutral text for a thrown non-error", async () => {
    const result = await runPerPerson(["a"], () => Promise.reject("boom"));
    expect(result.failed).toEqual([{ id: "a", message: "Die Anfrage ist fehlgeschlagen." }]);
  });

  it("does nothing for an empty selection", async () => {
    const action = vi.fn();
    expect(await runPerPerson([], action)).toEqual({ ok: [], failed: [] });
    expect(action).not.toHaveBeenCalled();
  });
});

describe("bulkSummaryText", () => {
  it("says what was sent when all went through", () => {
    expect(bulkSummaryText("invitation", { ok: ["a", "b", "c"], failed: [] }, nameOf)).toBe(
      "3 Einladungen gesendet.",
    );
    expect(bulkSummaryText("invitation", { ok: ["a"], failed: [] }, nameOf)).toBe(
      "1 Einladung gesendet.",
    );
    expect(bulkSummaryText("role", { ok: ["a", "b"], failed: [] }, nameOf)).toBe(
      "Rolle bei 2 Personen zugewiesen.",
    );
    expect(bulkSummaryText("role", { ok: ["a"], failed: [] }, nameOf)).toBe(
      "Rolle bei 1 Person zugewiesen.",
    );
  });

  it("names the persons that failed, with the reason, after the count of the successes", () => {
    const text = bulkSummaryText(
      "invitation",
      {
        ok: ["a", "b", "c"],
        failed: [{ id: "x", message: "Einladung konnte nicht gesendet werden." }],
      },
      nameOf,
    );
    expect(text).toBe(
      "3 Einladungen gesendet, 1 nicht: x (Einladung konnte nicht gesendet werden.).",
    );
  });

  it("lists several refused persons and handles a run where nothing worked", () => {
    const failed = [
      { id: "a", message: "Nicht erlaubt." },
      { id: "b", message: "Bereits zugewiesen." },
    ];
    expect(bulkSummaryText("role", { ok: [], failed }, nameOf)).toBe(
      "Die Rolle wurde niemandem zugewiesen: Muster, Max (Nicht erlaubt.); Beispiel, Eva (Bereits zugewiesen.).",
    );
    expect(bulkSummaryText("invitation", { ok: ["c"], failed }, nameOf)).toBe(
      "1 Einladung gesendet, 2 nicht: Muster, Max (Nicht erlaubt.); Beispiel, Eva (Bereits zugewiesen.).",
    );
  });

  it("answers an empty selection with its own sentence", () => {
    expect(bulkSummaryText("invitation", { ok: [], failed: [] }, nameOf)).toBe(
      "Keine Person ausgewählt.",
    );
  });
});

describe("sameScope / alreadyHoldsAssignment", () => {
  it("compares salon and person lists as sets and the type first", () => {
    expect(sameScope({ type: "TENANT" }, { type: "TENANT" })).toBe(true);
    expect(sameScope({ type: "TENANT" }, { type: "SALONS", salonIds: ["s"] })).toBe(false);
    expect(
      sameScope(
        { type: "SALONS", salonIds: ["s1", "s2"] },
        { type: "SALONS", salonIds: ["s2", "s1"] },
      ),
    ).toBe(true);
    expect(
      sameScope({ type: "PERSONS", employeeIds: ["e1"] }, { type: "PERSONS", employeeIds: ["e2"] }),
    ).toBe(false);
    expect(
      sameScope({ type: "SALONS", salonIds: ["s1"] }, { type: "PERSONS", employeeIds: ["s1"] }),
    ).toBe(false);
  });

  it("finds an identical role and scope among the held assignments only", () => {
    const held = [{ accessRoleId: "r1", scope: { type: "TENANT" as const } }];
    expect(alreadyHoldsAssignment(held, { accessRoleId: "r1", scope: { type: "TENANT" } })).toBe(
      true,
    );
    expect(alreadyHoldsAssignment(held, { accessRoleId: "r2", scope: { type: "TENANT" } })).toBe(
      false,
    );
    expect(
      alreadyHoldsAssignment(held, {
        accessRoleId: "r1",
        scope: { type: "SALONS", salonIds: ["s"] },
      }),
    ).toBe(false);
  });
});

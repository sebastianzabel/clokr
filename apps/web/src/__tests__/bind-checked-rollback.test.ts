// Phase 109 / WR-02 — mounted behaviour test for the instant-toggle rollback contract.
//
// The eight instant checkbox toggles on admin/system were converted from one-way
// `checked={state}` (which cannot roll back: the browser flips the DOM, the state never
// changes, so Svelte's template effect never re-runs and `set_checked` early-returns) to
// `bind:checked` plus an explicit revert.
//
// That conversion rests on one assumption the source-read pins in
// admin-system-save-wiring.test.ts cannot check: **bind:checked writes the new value into the
// state BEFORE the onchange handler runs**, so `const previous = !state` really is the pre-flip
// value. If Svelte ever ran onchange first, every one of those eight handlers would capture the
// wrong `previous` and "roll back" to the value the user just asked for — silently re-breaking
// exactly what WR-02 fixed. This test pins the ordering and the resulting DOM state.
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

import BindCheckedToggle from "$tests/fixtures/BindCheckedToggle.svelte";

describe("WR-02 — bind:checked rollback contract", () => {
  it("bind:checked applies the new value BEFORE onchange runs", async () => {
    type Result = { previous: boolean; atHandler: boolean };
    const results: Result[] = [];
    render(BindCheckedToggle, {
      enabled: false,
      shouldFail: false,
      onresult: (r: Result) => results.push(r),
    });

    await fireEvent.click(screen.getByLabelText("Testschalter"));

    expect(results).toHaveLength(1);
    // The handler observes the NEW value...
    expect(results[0].atHandler).toBe(true);
    // ...so `!state` correctly recovers the pre-flip value.
    expect(results[0].previous).toBe(false);
  });

  it("a failed save puts the checkbox back — the defect WR-02 fixed", async () => {
    render(BindCheckedToggle, { enabled: false, shouldFail: true, onresult: () => {} });
    const box = screen.getByLabelText("Testschalter") as HTMLInputElement;

    await fireEvent.click(box);
    // Let the rejected promise's catch run and Svelte flush the revert.
    await new Promise((r) => setTimeout(r, 0));

    expect(box.checked).toBe(false);
  });

  it("a successful save leaves the new value in place", async () => {
    render(BindCheckedToggle, { enabled: false, shouldFail: false, onresult: () => {} });
    const box = screen.getByLabelText("Testschalter") as HTMLInputElement;

    await fireEvent.click(box);
    await new Promise((r) => setTimeout(r, 0));

    expect(box.checked).toBe(true);
  });
});

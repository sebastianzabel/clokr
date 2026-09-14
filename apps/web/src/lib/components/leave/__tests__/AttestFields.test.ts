// Phase 201 (GitHub issue #201) — AttestFields is the extracted, mount-testable component that
// backs BOTH the review modal's Attest block and the new standalone Attest dialog on
// `team/leave/+page.svelte`. It holds no submit control and makes no API call (Test 5) — the
// owning dialog decides what to do with the bindable values.

import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import AttestFields from "../AttestFields.svelte";

describe("AttestFields", () => {
  it("Test 1: present=false renders the title and checkbox but no date inputs", () => {
    renderWithTheme(AttestFields, {
      present: false,
      validFrom: "",
      validTo: "",
      idPrefix: "r",
    });
    expect(screen.getByText("Attest / Arbeitsunfähigkeitsbescheinigung")).toBeTruthy();
    expect(screen.getByTestId("attest-present")).toBeTruthy();
    expect(screen.queryByTestId("attest-valid-from")).toBeNull();
    expect(screen.queryByTestId("attest-valid-to")).toBeNull();
  });

  it("Test 2: present=true renders both date inputs carrying the passed values", () => {
    renderWithTheme(AttestFields, {
      present: true,
      validFrom: "2026-08-01",
      validTo: "2026-08-05",
      idPrefix: "r",
    });
    const from = screen.getByTestId("attest-valid-from") as HTMLInputElement;
    const to = screen.getByTestId("attest-valid-to") as HTMLInputElement;
    expect(from.value).toBe("2026-08-01");
    expect(to.value).toBe("2026-08-05");
  });

  it("Test 3: clicking the checkbox when present=false reveals the date inputs", async () => {
    renderWithTheme(AttestFields, {
      present: false,
      validFrom: "",
      validTo: "",
      idPrefix: "r",
    });
    expect(screen.queryByTestId("attest-valid-from")).toBeNull();
    await fireEvent.click(screen.getByTestId("attest-present"));
    expect(screen.getByTestId("attest-valid-from")).toBeTruthy();
    expect(screen.getByTestId("attest-valid-to")).toBeTruthy();
  });

  it("Test 4: idPrefix drives id/for pairing so two instances stay uniquely associated", () => {
    renderWithTheme(AttestFields, {
      present: true,
      validFrom: "",
      validTo: "",
      idPrefix: "r",
    });
    expect(screen.getByLabelText("Gültig von")).toBeTruthy();
    expect(screen.getByLabelText("Gültig bis")).toBeTruthy();
  });

  it("Test 5: renders no submit control of any kind — fields only", () => {
    renderWithTheme(AttestFields, {
      present: true,
      validFrom: "",
      validTo: "",
      idPrefix: "r",
    });
    expect(screen.queryByRole("button")).toBeNull();
  });
});

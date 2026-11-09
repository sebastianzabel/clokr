// Issue #539 (D-10, D-14) - the employee screen's role rules. The server derives the role from
// stored assignments and sends null for a person without one; the form must neither invent a
// role for that person nor send one the admin did not choose.
import { describe, expect, it } from "vitest";
import { NO_ROLE_HINT, hasNoRole } from "../form-role";

// Issue #580 (D-580-04): initialFormRole and roleForSave were retired with the role select.

describe("hasNoRole", () => {
  it("is true only for an account whose server-derived role is null", () => {
    expect(hasNoRole({ role: null })).toBe(true);
  });

  it("is false for an account that holds a role", () => {
    expect(hasNoRole({ role: "EMPLOYEE" })).toBe(false);
    expect(hasNoRole({ role: "ADMIN" })).toBe(false);
  });

  it("is false without a user account - nothing to hint at", () => {
    expect(hasNoRole(undefined)).toBe(false);
    expect(hasNoRole(null)).toBe(false);
  });
});

describe("NO_ROLE_HINT", () => {
  it("tells the admin that the person cannot sign in until a role is assigned", () => {
    expect(NO_ROLE_HINT).toBe(
      "Dieser Person ist keine Rolle zugewiesen. Eine Anmeldung ist erst möglich, nachdem ihr eine Rolle zugewiesen wurde.",
    );
  });
});

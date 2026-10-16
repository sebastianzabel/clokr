// Issue #539 (D-10, D-14) - the employee screen's role rules. The server derives the role from
// stored assignments and sends null for a person without one; the form must neither invent a
// role for that person nor send one the admin did not choose.
import { describe, expect, it } from "vitest";
import { NO_ROLE_HINT, hasNoRole, initialFormRole, roleForSave } from "../form-role";

describe("initialFormRole", () => {
  it("a person without a role starts on the empty choice, not on a default role", () => {
    expect(initialFormRole(null)).toBe("");
    expect(initialFormRole(undefined)).toBe("");
  });

  it("keeps the role the server derived", () => {
    expect(initialFormRole("MANAGER")).toBe("MANAGER");
    expect(initialFormRole("ADMIN")).toBe("ADMIN");
    expect(initialFormRole("EMPLOYEE")).toBe("EMPLOYEE");
  });
});

describe("roleForSave", () => {
  it("sends no role without a choice (T-539-42)", () => {
    expect(roleForSave(true, "")).toEqual({});
  });

  it("sends the chosen role to a caller who may assign roles", () => {
    expect(roleForSave(true, "ADMIN")).toEqual({ role: "ADMIN" });
    expect(roleForSave(true, "EMPLOYEE")).toEqual({ role: "EMPLOYEE" });
  });

  it("sends no role for a caller who may not assign roles, whatever the state", () => {
    expect(roleForSave(false, "ADMIN")).toEqual({});
    expect(roleForSave(false, "")).toEqual({});
  });

  it("the empty choice yields no role key at all, not role: undefined", () => {
    expect("role" in roleForSave(true, "")).toBe(false);
  });
});

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
  it("tells the admin that the person cannot sign in until a role is chosen and saved", () => {
    expect(NO_ROLE_HINT).toBe(
      "Dieser Person ist keine Rolle zugewiesen. Eine Anmeldung ist erst möglich, nachdem eine Rolle gewählt und gespeichert wurde.",
    );
  });
});

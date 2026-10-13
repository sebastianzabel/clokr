import { describe, it, expect } from "vitest";
import { auditActorLabel } from "../actor-label";

describe("auditActorLabel", () => {
  it("shows the e-mail of a user row", () => {
    expect(auditActorLabel({ user: { email: "a@example.invalid" }, newValue: null })).toEqual({
      kind: "user",
      text: "a@example.invalid",
    });
  });

  it("keeps the user label even if the row also carries an operator actor", () => {
    expect(
      auditActorLabel({
        user: { email: "a@example.invalid" },
        newValue: { actor: { type: "OPERATOR" } },
      }),
    ).toEqual({ kind: "user", text: "a@example.invalid" });
  });

  it("labels a userless row stamped with the operator actor as Betreiber", () => {
    expect(
      auditActorLabel({
        user: null,
        newValue: { name: "x", actor: { type: "OPERATOR", operatorId: "o", tenantId: "t" } },
      }),
    ).toEqual({ kind: "operator", text: "Betreiber" });
  });

  it("falls back to System for everything else", () => {
    expect(auditActorLabel({ user: null, newValue: null })).toEqual({
      kind: "system",
      text: "System",
    });
    expect(auditActorLabel({ user: null, newValue: "text" })).toEqual({
      kind: "system",
      text: "System",
    });
    expect(auditActorLabel({ user: null, newValue: { actor: "OPERATOR" } })).toEqual({
      kind: "system",
      text: "System",
    });
    expect(auditActorLabel({ user: null, newValue: { actor: { type: "API_KEY" } } })).toEqual({
      kind: "system",
      text: "System",
    });
    expect(auditActorLabel({ user: null, newValue: { actor: null } })).toEqual({
      kind: "system",
      text: "System",
    });
  });

  it("decides by the type code, not by a display string", () => {
    expect(auditActorLabel({ user: null, newValue: { actor: { type: "Betreiber" } } }).kind).toBe(
      "system",
    );
  });
});

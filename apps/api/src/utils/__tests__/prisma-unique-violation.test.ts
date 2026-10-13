/**
 * Unit tests for `uniqueViolationTarget` (Issue #567, quick 261013-smt, D-02/D-04) — DB-free, the
 * errors are plain object literals shaped like the measured Prisma 7.6 + @prisma/adapter-pg error.
 * The real-database proof lives in `contexts/platform/__tests__/tenant-provisioning-88.test.ts`
 * and `contexts/scheduling/__tests__/facade-couplings.test.ts`.
 *
 * Mutations, recorded here, not re-run by CI (quick 261013-smt, 2026-10-13), each run red then
 * restored from a `cp` backup:
 * - M6: add the error's message property as a fifth joined part -> red: "ignores the message
 *   property" here and the tenant-provisioning "(h) ... message mentions slug" case.
 */
import { describe, it, expect } from "vitest";
import { uniqueViolationTarget } from "../prisma-unique-violation";

/** A P2002 shaped like the driver-adapter error, with a message that echoes the invocation. */
function adapterError(opts: {
  index?: string;
  fields?: string[];
  originalMessage?: string;
  target?: unknown;
  message?: string;
}) {
  return Object.assign(new Error(opts.message ?? "Unique constraint failed"), {
    code: "P2002",
    meta: {
      ...(opts.target === undefined ? {} : { target: opts.target }),
      driverAdapterError: {
        cause: {
          constraint: { index: opts.index, fields: opts.fields },
          originalMessage: opts.originalMessage,
        },
      },
    },
  });
}

describe("uniqueViolationTarget (Issue #567)", () => {
  it("returns null for everything that is not a Prisma P2002", () => {
    expect(uniqueViolationTarget(null)).toBeNull();
    expect(uniqueViolationTarget(undefined)).toBeNull();
    expect(uniqueViolationTarget("P2002")).toBeNull();
    expect(uniqueViolationTarget(new Error("plain"))).toBeNull();
    expect(
      uniqueViolationTarget({
        code: "P2003",
        meta: { driverAdapterError: { cause: { constraint: { index: "User_email_key" } } } },
      }),
    ).toBeNull();
  });

  it("includes meta.target as a string", () => {
    expect(uniqueViolationTarget({ code: "P2002", meta: { target: "Tenant_slug_key" } })).toContain(
      "Tenant_slug_key",
    );
  });

  it("includes meta.target as an array", () => {
    const target = uniqueViolationTarget({
      code: "P2002",
      meta: { target: ["tenantId", "provider", "externalBranchId"] },
    });
    expect(target).toContain("externalBranchId");
    expect(target).toContain("tenantId");
  });

  it("includes the driver-adapter constraint index", () => {
    expect(uniqueViolationTarget(adapterError({ index: "User_email_key" }))).toContain(
      "User_email_key",
    );
  });

  it("includes the driver-adapter constraint fields", () => {
    expect(uniqueViolationTarget(adapterError({ fields: ["email"] }))).toContain("email");
  });

  it("includes the database's own original message", () => {
    expect(
      uniqueViolationTarget(
        adapterError({
          originalMessage:
            'duplicate key value violates unique constraint "SalonCoupling_salonId_key"',
        }),
      ),
    ).toContain("SalonCoupling_salonId_key");
  });

  it("ignores the message property: a message that says slug does not make the target slug", () => {
    const target = uniqueViolationTarget(
      adapterError({
        index: "User_email_key",
        message: "Invalid `tx.tenant.create()` invocation ... slug: 'acme' ...",
      }),
    );
    expect(target).toContain("User_email_key");
    expect(target).not.toContain("slug");
  });

  it("returns a blank string, never null, for a P2002 without any metadata", () => {
    const target = uniqueViolationTarget({ code: "P2002" });
    expect(target).not.toBeNull();
    expect(target?.replace(/\s+/g, "")).toBe("");
    expect(target).not.toMatch(/[A-Za-z0-9]/);
  });
});

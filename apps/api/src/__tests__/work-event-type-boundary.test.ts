// Phase 79 Plan 05 — TypeScript boundary test for /work-events/mine vs /work-events.
//
// Variant B (per 79-05-PLAN.md): `.test.ts` extension (instead of `.test-d.ts`)
// so vitest's `include: ["src/**/*.test.ts"]` pattern picks it up. The
// substantive validation happens at `tsc --noEmit` time via the
// `@ts-expect-error` directives below — vitest just executes the file's
// trivial bodies (expectTypeOf calls + assignment statements that are
// type-erased at runtime).
//
// REVISION (W5): the boundary is BIDIRECTIONAL. We assert FOUR distinct
// failure modes via `@ts-expect-error`:
//   1. Mine → Tenant item   (missing `employee` field)
//   2. Tenant → Mine item   (W5 brand mismatch)
//   3. Mine → Tenant list   (missing `employee` at the list-element level)
//   4. Tenant → Mine list   (W5 brand mismatch at the list-element level)
//
// Plus three positive assertions:
//   - Mine item type has NO `employee` property
//   - Tenant item type HAS `employee` sub-object with the expected shape
//   - WorkEventType union is the closed set of 5 known types
//   - Runtime payloads (no `__brand` field) satisfy BOTH types
//
// If any `@ts-expect-error` line stops suppressing an error (because the
// boundary regresses), tsc will report it as "Unused @ts-expect-error directive"
// — that's the inverse-check guard the plan calls out.

import { expectTypeOf, test } from "vitest";
import type {
  WorkEventBase,
  WorkEventListMine,
  WorkEventListMineItem,
  WorkEventListTenant,
  WorkEventListTenantItem,
  WorkEventSource,
  WorkEventType,
} from "@clokr/types";

test("WorkEventListMineItem has NO `employee` field", () => {
  expectTypeOf<WorkEventListMineItem>().not.toHaveProperty("employee");
});

test("WorkEventListTenantItem HAS `employee` sub-object with the expected shape", () => {
  expectTypeOf<WorkEventListTenantItem>().toHaveProperty("employee");
  expectTypeOf<WorkEventListTenantItem["employee"]>().toEqualTypeOf<{
    firstName: string;
    lastName: string;
    employeeNumber: string;
  }>();
});

test("WorkEventListMineItem is NOT assignable to WorkEventListTenantItem (Mine → Tenant: missing `employee` field)", () => {
  // A Mine item is missing `employee` → can't be passed where a Tenant item is expected.
  const mineItem: WorkEventListMineItem = {} as never;
  // @ts-expect-error — assigning Mine to Tenant must fail; Tenant requires `employee`.
  const tenantItem: WorkEventListTenantItem = mineItem;
  void tenantItem;
});

test("REVISION (W5) — WorkEventListTenantItem is NOT assignable to WorkEventListMineItem (Tenant → Mine: brand mismatch tenant→mine)", () => {
  // Previously: this direction COMPILED because Tenant has all of Mine's required
  // fields plus more — structural typing allows the upcast. The optional `__brand?`
  // discriminant closes the gap: 'tenant' is not assignable to 'mine' | undefined.
  const tenantItem: WorkEventListTenantItem = {} as never;
  // @ts-expect-error — REVISION (W5): Tenant brand 'tenant' clashes with Mine brand 'mine' | undefined.
  const mineItem: WorkEventListMineItem = tenantItem;
  void mineItem;
});

test("List aliases are distinct: WorkEventListMine ↛ WorkEventListTenant (missing `employee` at element level)", () => {
  const mineList: WorkEventListMine = [];
  // @ts-expect-error — WorkEventListMineItem[] cannot be a WorkEventListTenantItem[] (element missing `employee`).
  const tenantList: WorkEventListTenant = mineList;
  void tenantList;
});

test("REVISION (W5) — List aliases are distinct: WorkEventListTenant ↛ WorkEventListMine (brand mismatch tenant→mine at element level)", () => {
  const tenantList: WorkEventListTenant = [];
  // @ts-expect-error — REVISION (W5): WorkEventListTenantItem[] cannot be a WorkEventListMineItem[] (brand mismatch).
  const mineList: WorkEventListMine = tenantList;
  void mineList;
});

test("WorkEventType union is the closed set of 5 known types", () => {
  expectTypeOf<WorkEventType>().toEqualTypeOf<
    "VOCATIONAL_SCHOOL" | "FIELD_SERVICE" | "BUSINESS_TRIP" | "TRAINING" | "OTHER"
  >();
});

test("WorkEventSource union is the closed set of 3 known sources", () => {
  expectTypeOf<WorkEventSource>().toEqualTypeOf<"PATTERN" | "MANUAL" | "AUTO">();
});

test("WorkEventBase is shared between Mine and Tenant items (Mine/Tenant items extend Base)", () => {
  // Mine and Tenant items must include every required field of WorkEventBase.
  // We check this by asserting the Item types are assignable TO Base (i.e. the
  // Item is at least as wide as Base, including all Base fields).
  expectTypeOf<WorkEventListMineItem>().toMatchTypeOf<WorkEventBase>();
  expectTypeOf<WorkEventListTenantItem>().toMatchTypeOf<WorkEventBase>();
});

test("REVISION (W5) — runtime payloads (no `__brand` field) still satisfy BOTH types because the brand is optional", () => {
  // The brand is OPTIONAL so a payload without a brand field is assignable to BOTH
  // named types. This is essential: the API never serialises a `__brand` field,
  // and we don't want to force a runtime decoder.
  const payloadFromMine: WorkEventListMineItem = {
    id: "x",
    employeeId: "e",
    type: "VOCATIONAL_SCHOOL",
    source: "MANUAL",
    date: "2026-06-15",
    workedMinutes: 480,
    expectedMinutes: 480,
    payload: null,
    note: null,
  };
  void payloadFromMine;
  // The same bare object (no `__brand`) also satisfies the Tenant item, provided
  // it includes the `employee` sub-object.
  const payloadFromTenant: WorkEventListTenantItem = {
    id: "x",
    employeeId: "e",
    type: "VOCATIONAL_SCHOOL",
    source: "MANUAL",
    date: "2026-06-15",
    workedMinutes: 480,
    expectedMinutes: 480,
    payload: null,
    note: null,
    employee: { firstName: "A", lastName: "B", employeeNumber: "1" },
  };
  void payloadFromTenant;
});

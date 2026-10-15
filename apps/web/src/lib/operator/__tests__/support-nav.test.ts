// Issue #93 - the support area paths, one place. Ids are encoded; the leave path carries only a code.
import { describe, expect, it } from "vitest";

import {
  supportBasePath,
  supportContractsPath,
  supportLeavePath,
  supportMonthPath,
  supportProtocolPath,
  tenantPagePath,
} from "../support-nav";

describe("support paths", () => {
  it("builds the tenant page and the area paths with encoded ids", () => {
    expect(tenantPagePath("t/1")).toBe("/betreiber/mandanten/t%2F1");
    expect(supportBasePath("t1")).toBe("/betreiber/mandanten/t1/support");
    expect(supportProtocolPath("t1")).toBe("/betreiber/mandanten/t1/support/protokoll");
    expect(supportContractsPath("t1", "e 1")).toBe(
      "/betreiber/mandanten/t1/support/mitarbeitende/e%201/vertraege",
    );
  });

  it("builds the month path with or without a month", () => {
    expect(supportMonthPath("t1", "e1")).toBe("/betreiber/mandanten/t1/support/mitarbeitende/e1");
    expect(supportMonthPath("t1", "e1", "2026-09")).toBe(
      "/betreiber/mandanten/t1/support/mitarbeitende/e1?monat=2026-09",
    );
  });

  it("builds the leave path with the notice code", () => {
    expect(supportLeavePath("t1", "SUPPORT_ACCESS_REQUIRED")).toBe(
      "/betreiber/mandanten/t1?hinweis=SUPPORT_ACCESS_REQUIRED",
    );
    expect(supportLeavePath("t1", "A&B")).toBe("/betreiber/mandanten/t1?hinweis=A%26B");
  });
});

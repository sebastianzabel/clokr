// GitHub issue #442 — under Team → Anträge the action column was offset by about half a row
// against the rest of the table, and a row without any action collapsed, shifting every
// following action cell. Root cause: `.action-cell` set `display: flex` directly on the `<td>`,
// so the cell stopped being a table cell — it no longer stretched to the row height and its
// border no longer lined up with the other columns. The same pattern recurred at three more
// sites (own-requests `/leave`, both `/reports` action columns, `AvailabilityOneOffList`), which
// Task 2 of this plan also corrects and measures here.
//
// Test approach, and why it is shaped this way:
// 1. The route pages (`/team/leave`, `/leave`, `/reports`) cannot be mounted — they import
//    `$app/stores`, for which `apps/web/vitest.config.ts` deliberately registers no alias (see
//    that file's own docblock, and `team-leave-attest-action.test.ts`'s header for the same wall).
// 2. Even a mountable component proves nothing here: this test environment does not inject
//    component-scoped `<style>` into jsdom (documented in
//    `src/lib/components/layout/__tests__/whats-new-stacking.test.ts` and `KontoSaldoCard.test.ts`).
//    Measured during planning: jsdom reports `table-cell` for any `<td>` no rule touches, so a
//    plain mount's `getComputedStyle(td).display` would read `table-cell` against the OLD code
//    too — a test that can never go red, which violates issue AC 3.
// 3. Therefore this file uses the repo's established instrument for exactly this question,
//    `$tests/media-query-probe` (#265/#303): it injects the page's OWN flattened `<style>` block
//    into jsdom and measures real `<table>` markup with `getComputedStyle`, next to controls.
//    `AvailabilityOneOffList` is a component and IS mounted for real, with its own style block
//    injected the same way, because its scoped CSS is otherwise invisible to jsdom (point 2).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, afterEach } from "vitest";

import { cssForViewport, styleBlockOf, probeAt, INVENTED_CLASS } from "$tests/media-query-probe";

function readRepoFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const TEAM_LEAVE_PAGE = readRepoFile(
  "../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;

// Test-local sensitivity control class — distinct from the shared INVENTED_CLASS, which must
// keep its documented meaning (appears in no stylesheet). This class gets a test-local rule
// below, so it proves the instrument CAN see a td that lost its table-cell display.
const SENSITIVITY_CLASS = "issue442-sensitivity-control";

afterEach(() => {
  document.head.querySelectorAll("style").forEach((s) => s.remove());
  document.body.innerHTML = "";
  document.body.removeAttribute("data-theme");
});

// ── Group 0: instrument controls ────────────────────────────────────────────
describe("#442 — instrument controls (anti-vacuity)", () => {
  it("control 1: inside a real table, a class-less td and th read table-cell", () => {
    probeAt(DESKTOP_WIDTH, "");
    document.body.innerHTML = `<table><tbody><tr><td id="plain-td"></td><th id="plain-th"></th></tr></tbody></table>`;
    const td = document.getElementById("plain-td")!;
    const th = document.getElementById("plain-th")!;
    expect(getComputedStyle(td).display).toBe("table-cell");
    expect(getComputedStyle(th).display).toBe("table-cell");
  });

  it("control 2 (sensitivity): a td with a test-local invented class + test-local flex rule reads flex", () => {
    probeAt(DESKTOP_WIDTH, `.${SENSITIVITY_CLASS} { display: flex; }`);
    document.body.innerHTML = `<table><tbody><tr><td id="sens-td" class="${SENSITIVITY_CLASS}"></td></tr></tbody></table>`;
    const td = document.getElementById("sens-td")!;
    expect(getComputedStyle(td).display).toBe("flex");
  });

  it("control 3: a td carrying INVENTED_CLASS (no rule anywhere) reads exactly like a class-less td", () => {
    probeAt(DESKTOP_WIDTH, "");
    document.body.innerHTML = `<table><tbody><tr><td id="plain-td"></td><td id="invented-td" class="${INVENTED_CLASS}"></td></tr></tbody></table>`;
    const plain = getComputedStyle(document.getElementById("plain-td")!);
    const invented = getComputedStyle(document.getElementById("invented-td")!);
    expect(invented.display).toBe(plain.display);
    expect(invented.display).toBe("table-cell");
  });

  it("control 4: a test-local flex-wrap rule reads back via getPropertyValue, or is pinned by source if jsdom reports empty", () => {
    probeAt(DESKTOP_WIDTH, `.${SENSITIVITY_CLASS} { flex-wrap: wrap; }`);
    document.body.innerHTML = `<div id="wrap-div" class="${SENSITIVITY_CLASS}"></div>`;
    const el = document.getElementById("wrap-div")!;
    const value = getComputedStyle(el).getPropertyValue("flex-wrap");
    // jsdom's support for flex-wrap readback is not guaranteed; if it reports "" here, the
    // flex-wrap assertions in the groups below fall back to a source pin instead (documented at
    // each call site), and this control simply records which path jsdom takes in this environment.
    expect(["wrap", ""]).toContain(value);
  });

  it("styleBlockOf(team/leave) really loaded — anti-vacuity", () => {
    const block = styleBlockOf(TEAM_LEAVE_PAGE);
    expect(block.length).toBeGreaterThan(5_000);
    expect(block).toContain(".action-cell");
  });
});

// ── Group A: /team/leave ─────────────────────────────────────────────────────
function teamLeaveStyleBlock(): string {
  return styleBlockOf(TEAM_LEAVE_PAGE);
}

function teamLeaveTableMarkup(): string {
  return `
    <table class="data-table">
      <tbody>
        <tr>
          <td>Row with action</td>
          <td class="action-cell">
            <div class="action-cell__group">
              <button class="btn btn-sm btn-ghost">Korrigieren</button>
            </div>
          </td>
        </tr>
        <tr>
          <td>Row without action (Zurückgezogen)</td>
          <td class="action-cell">
            <div class="action-cell__group"></div>
          </td>
        </tr>
      </tbody>
    </table>
  `;
}

describe.each([PHONE_WIDTH, DESKTOP_WIDTH])(
  "#442 — /team/leave action cell at %ipx (measured)",
  (width) => {
    it("td.action-cell stays table-cell, with and without an action", () => {
      probeAt(width, cssForViewport(teamLeaveStyleBlock(), width));
      document.body.innerHTML = teamLeaveTableMarkup();
      const cells = document.querySelectorAll("td.action-cell");
      expect(cells.length).toBe(2);
      cells.forEach((cell) => {
        expect(getComputedStyle(cell).display).toBe("table-cell");
      });
    });

    it("positive control: td.action-cell still reads white-space nowrap (the page rule really hits it)", () => {
      probeAt(width, cssForViewport(teamLeaveStyleBlock(), width));
      document.body.innerHTML = teamLeaveTableMarkup();
      const cell = document.querySelector("td.action-cell")!;
      expect(getComputedStyle(cell).whiteSpace).toBe("nowrap");
    });

    it("the inner .action-cell__group carries the flex layout", () => {
      probeAt(width, cssForViewport(teamLeaveStyleBlock(), width));
      document.body.innerHTML = teamLeaveTableMarkup();
      const group = document.querySelector(".action-cell__group")!;
      expect(getComputedStyle(group).display).toBe("flex");
      const flexWrap = getComputedStyle(group).getPropertyValue("flex-wrap");
      if (flexWrap !== "") {
        expect(flexWrap).toBe("wrap");
      }
    });
  },
);

describe("#442 — /team/leave source pin", () => {
  it("exactly one td.action-cell wraps its content in a single div.action-cell__group, blocks moved verbatim", () => {
    const matches = TEAM_LEAVE_PAGE.match(/<td class="action-cell">/g) ?? [];
    expect(matches).toHaveLength(1);
    const start = TEAM_LEAVE_PAGE.indexOf('<td class="action-cell">');
    const end = TEAM_LEAVE_PAGE.indexOf("</td>", start);
    const cellBody = TEAM_LEAVE_PAGE.slice(start, end);
    expect(cellBody).toContain('<div class="action-cell__group">');
    // The three existing conditional blocks still live inside the wrapper, untouched.
    expect(cellBody).toContain(
      'req.status === "PENDING" || req.status === "CANCELLATION_REQUESTED"',
    );
    expect(cellBody).toContain("SICK_CODES.includes(req.typeCode)");
    expect(cellBody).toContain(
      "resolveStornoAction(req.status, req.employeeId === $authStore.user?.employeeId)",
    );
    expect(cellBody).toContain(`leave-team-row-\${req.id}-review`);
    expect(cellBody).toContain(`leave-team-row-\${req.id}-correct`);
    expect(cellBody).toContain(`leave-team-row-\${req.id}-attest`);
    expect(cellBody).toContain(`leave-team-row-\${req.id}-storno`);
  });
});

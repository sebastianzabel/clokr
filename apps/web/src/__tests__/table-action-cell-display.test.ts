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

import { renderWithTheme } from "$tests/test-utils";
import AvailabilityOneOffList from "$lib/components/availability/AvailabilityOneOffList.svelte";
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
const LEAVE_PAGE = readRepoFile(
  "../routes/(app)/leave/+page.svelte",
  "src/routes/(app)/leave/+page.svelte",
);
const REPORTS_PAGE = readRepoFile(
  "../routes/(app)/reports/+page.svelte",
  "src/routes/(app)/reports/+page.svelte",
);
// Issue #612 (pin ledger row 10): the last action cell of /reports - the Verfall cell with its
// „Hinweis senden“ button - lives in the vacation tab component now, no longer in the page.
const VACATION_TAB = readRepoFile(
  "../lib/components/reports/VacationAbsenceTab.svelte",
  "src/lib/components/reports/VacationAbsenceTab.svelte",
);
const AVAILABILITY_COMPONENT = readRepoFile(
  "../lib/components/availability/AvailabilityOneOffList.svelte",
  "src/lib/components/availability/AvailabilityOneOffList.svelte",
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

  // Issue #442: reports/+page.svelte has a CSS comment mentioning the literal `<style>` tag text.
  // A naive `lastIndexOf` (the old implementation) picked that up instead of the real opening
  // tag and silently dropped every rule above it — making the reports measurement vacuous.
  it("styleBlockOf survives a CSS comment that contains the literal style-tag text", () => {
    const synthetic = [
      "<div>markup</div>",
      "<style>",
      ".declared-before-the-comment { color: red; }",
      "/* a comment mentioning <style> and </style> as plain text, like reports/+page.svelte */",
      ".declared-after-the-comment { color: blue; }",
      "</style>",
    ].join("\n");
    const block = styleBlockOf(synthetic);
    expect(block).toContain(".declared-before-the-comment");
    expect(block).toContain(".declared-after-the-comment");
  });

  it("styleBlockOf throws on zero line-anchored opening tags", () => {
    expect(() => styleBlockOf("<div>no style tag here, just the word style</div>")).toThrow(
      /no <style> block found/,
    );
  });

  it("styleBlockOf throws on more than one line-anchored opening tag (ambiguous)", () => {
    const synthetic = ["<style>", ".a {}", "</style>", "<style>", ".b {}", "</style>"].join("\n");
    expect(() => styleBlockOf(synthetic)).toThrow(/ambiguous/);
  });

  it("styleBlockOf(reports) really loaded the page rules — anti-vacuity", () => {
    const block = styleBlockOf(REPORTS_PAGE);
    expect(block).toContain(".attendance-actions {");
    expect(block).toContain(".row-actions__group {");
  });

  it("styleBlockOf(vacation tab) really loaded the Verfall cell rules — anti-vacuity", () => {
    const block = styleBlockOf(VACATION_TAB);
    expect(block).toContain(".vac-verfall {");
    expect(block).toContain(".verfall-cell {");
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

// ── Group B: /leave (own requests) ──────────────────────────────────────────
function leaveStyleBlock(): string {
  return styleBlockOf(LEAVE_PAGE);
}

function leaveTableMarkup(): string {
  return `
    <table class="data-table">
      <tbody>
        <tr>
          <td>Row with action</td>
          <td class="action-cell">
            <div class="action-cell__group">
              <button class="btn btn-sm btn-ghost">Bearbeiten</button>
            </div>
          </td>
        </tr>
        <tr>
          <td>Row without action</td>
          <td class="action-cell">
            <div class="action-cell__group"></div>
          </td>
        </tr>
      </tbody>
    </table>
  `;
}

describe.each([PHONE_WIDTH, DESKTOP_WIDTH])(
  "#442 — /leave action cell at %ipx (measured)",
  (width) => {
    it("td.action-cell stays table-cell, with and without an action", () => {
      probeAt(width, cssForViewport(leaveStyleBlock(), width));
      document.body.innerHTML = leaveTableMarkup();
      const cells = document.querySelectorAll("td.action-cell");
      expect(cells.length).toBe(2);
      cells.forEach((cell) => {
        expect(getComputedStyle(cell).display).toBe("table-cell");
      });
    });

    it("positive control: td.action-cell still reads white-space nowrap", () => {
      probeAt(width, cssForViewport(leaveStyleBlock(), width));
      document.body.innerHTML = leaveTableMarkup();
      const cell = document.querySelector("td.action-cell")!;
      expect(getComputedStyle(cell).whiteSpace).toBe("nowrap");
    });

    it("the inner .action-cell__group carries the flex layout", () => {
      probeAt(width, cssForViewport(leaveStyleBlock(), width));
      document.body.innerHTML = leaveTableMarkup();
      const group = document.querySelector(".action-cell__group")!;
      expect(getComputedStyle(group).display).toBe("flex");
    });
  },
);

describe("#442 — /leave source pin", () => {
  it("exactly one td.action-cell wraps its content in a single div.action-cell__group", () => {
    const matches = LEAVE_PAGE.match(/<td class="action-cell">/g) ?? [];
    expect(matches).toHaveLength(1);
    const start = LEAVE_PAGE.indexOf('<td class="action-cell">');
    const end = LEAVE_PAGE.indexOf("</td>", start);
    const cellBody = LEAVE_PAGE.slice(start, end);
    expect(cellBody).toContain('<div class="action-cell__group">');
    expect(cellBody).toContain(`leave-mine-row-\${req.id}-edit`);
    expect(cellBody).toContain(`leave-mine-row-\${req.id}-withdraw`);
    expect(cellBody).toContain(`leave-mine-row-\${req.id}-cancel`);
  });
});

// ── Group C: /reports ────────────────────────────────────────────────────────
function reportsStyleBlock(): string {
  return styleBlockOf(VACATION_TAB);
}

// Issue #612 (pin ledger row 10): the Überstunden-Übersicht with its per-row PDF/DATEV action
// column is gone (the person documents moved into the drill-down) and so is the Verfall-Warnungen
// table (its column and its button are part of the vacation table now). The property is unchanged:
// an action cell stays a table cell, its flex layout lives on the inner wrapper.
function reportsTableMarkup(): string {
  return `
    <table class="data-table vac-table">
      <thead>
        <tr>
          <th scope="col">Verfall</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="vac-verfall">
            <div class="verfall-cell">
              <span class="verfall-line">3 T. bis 31.03.2027</span>
              <button class="btn btn-ghost xs">Hinweis senden</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  `;
}

describe("#442 — /reports action cells at 1280px (measured)", () => {
  it("td.vac-verfall and its header stay table-cell", () => {
    probeAt(DESKTOP_WIDTH, cssForViewport(reportsStyleBlock(), DESKTOP_WIDTH));
    document.body.innerHTML = reportsTableMarkup();
    document.querySelectorAll("td.vac-verfall, th").forEach((cell) => {
      expect(getComputedStyle(cell).display).toBe("table-cell");
    });
  });

  it("positive control: td.vac-verfall still reads its min-width (the component rule really hits it)", () => {
    // The injected sheet must reach this cell, otherwise the table-cell assertions above would pass
    // against a sheet that never applied. min-width is untouched by the table-level rules.
    probeAt(DESKTOP_WIDTH, cssForViewport(reportsStyleBlock(), DESKTOP_WIDTH));
    document.body.innerHTML = reportsTableMarkup();
    const cell = document.querySelector("td.vac-verfall")!;
    expect(getComputedStyle(cell).minWidth).toBe("170px");
  });

  it("the inner .verfall-cell carries the flex layout", () => {
    probeAt(DESKTOP_WIDTH, cssForViewport(reportsStyleBlock(), DESKTOP_WIDTH));
    document.body.innerHTML = reportsTableMarkup();
    document.querySelectorAll(".verfall-cell").forEach((group) => {
      expect(getComputedStyle(group).display).toBe("flex");
    });
  });
});

// The former mobile-hide rule (`display: none` below 720px) belonged to the old layout. Below 960px
// the vacation tab renders an ApprovalRow list instead of this table (ADD-6), so the table cell is
// never squeezed: at 390px the cell must still be a table cell, never turned into a flex box.
describe("#442 — /reports action cell at 390px (the cell is never flexed)", () => {
  it("td.vac-verfall computes table-cell at 390px", () => {
    probeAt(PHONE_WIDTH, cssForViewport(reportsStyleBlock(), PHONE_WIDTH));
    document.body.innerHTML = reportsTableMarkup();
    document.querySelectorAll("td.vac-verfall").forEach((cell) => {
      expect(getComputedStyle(cell).display).toBe("table-cell");
    });
  });
});

describe("#442 — /reports source pin", () => {
  it("exactly one td.vac-verfall (the Verfall cell), wrapping a div.verfall-cell", () => {
    const matches = VACATION_TAB.match(/<td class="vac-verfall">/g) ?? [];
    expect(matches).toHaveLength(1);
    const start = VACATION_TAB.indexOf('<td class="vac-verfall">');
    const end = VACATION_TAB.indexOf("</td>", start);
    expect(VACATION_TAB.slice(start, end)).toContain('<div class="verfall-cell">');
    // No td in the page carries a flex rule, and the removed tables leave no trace.
    expect(REPORTS_PAGE).not.toContain("overtime-table");
    expect(REPORTS_PAGE).not.toContain("carryover-table");
    expect(REPORTS_PAGE).not.toContain("btn-icon");
    expect(REPORTS_PAGE).not.toContain('<td class="row-actions">');
  });
});

// ── Group D: AvailabilityOneOffList (real mount) ────────────────────────────
function availabilityStyleBlock(): string {
  return styleBlockOf(AVAILABILITY_COMPONENT);
}

function futureDateISO(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

describe("#442 — AvailabilityOneOffList action cell (real mount, measured)", () => {
  it("th.av-col-action and td.av-col-action stay table-cell, wrapper carries flex", () => {
    const { container } = renderWithTheme(AvailabilityOneOffList, {
      entries: [
        {
          date: futureDateISO(5),
          status: "AVAILABLE",
          validFrom: futureDateISO(0),
        },
      ],
      disabled: false,
    });
    probeAt(DESKTOP_WIDTH, cssForViewport(availabilityStyleBlock(), DESKTOP_WIDTH));

    const th = container.querySelector("th.av-col-action");
    const td = container.querySelector("td.av-col-action");
    expect(th).not.toBeNull();
    expect(td).not.toBeNull();
    expect(getComputedStyle(th!).display).toBe("table-cell");
    expect(getComputedStyle(td!).display).toBe("table-cell");

    // Positive control: the page rule really hits the td.
    expect(getComputedStyle(td!).whiteSpace).toBe("nowrap");

    const group = td!.firstElementChild;
    expect(group).not.toBeNull();
    // Svelte appends its own scoped hash class (e.g. "svelte-xxxxx") to every element matched by
    // the component's scoped <style> block — classList.contains() ignores that, a bare
    // className equality check would not.
    expect(group!.classList.contains("av-col-action__group")).toBe(true);
    expect(getComputedStyle(group as Element).display).toBe("flex");
  });
});

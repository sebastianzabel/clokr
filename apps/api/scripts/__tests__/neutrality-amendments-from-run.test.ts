/**
 * Issue #539 (D-15) — DB-free tests of scripts/neutrality-amendments-from-run.ts.
 *
 * Synthetic recordings, registers and dumps in a temporary directory; the real register layouts
 * (pretty-printed matrix, one-line recipients/activity-auth) are reproduced so the append path is
 * proven against both.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, appendLinks, type RegisterName } from "../neutrality-amendments-from-run";

const REASON = "Entfernen des Altrollen-Rueckfalls (Issue #539), gemessen";
const OK = 0;
const REFUSED = 1;

let dir: string;
let infoLines: string[];
let errorLines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "neutrality-generator-"));
  infoLines = [];
  errorLines = [];
  vi.spyOn(console, "info").mockImplementation(
    (...a: unknown[]) => void infoLines.push(a.map(String).join(" ")),
  );
  vi.spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => void errorLines.push(a.map(String).join(" ")),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function put(name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

const matrixRecording = {
  "FALLBACK_ADMIN | GET /a | own": { status: 200, ids: [] },
  "FALLBACK_MANAGER | GET /a | own": { status: 200, ids: [] },
  "ADMIN | GET /a | own": { status: 200, ids: [] },
};

function matrixFiles(amendments = "[]") {
  const recording = put("matrix.json", JSON.stringify({ cells: matrixRecording }));
  const register = put("matrix-amendments.json", `{\n  "amendments": ${amendments}\n}\n`);
  return { recording, amendments: register };
}

function dumpOf(mapKey: string, map: Record<string, unknown>): string {
  return put(`${mapKey}.actual.json`, JSON.stringify({ [mapKey]: map }));
}

function run(
  register: RegisterName,
  files: { recording: string; amendments: string },
  actual: string,
  extra: string[] = [],
) {
  return main(
    [
      "--register",
      register,
      "--actual",
      actual,
      "--issue",
      "539",
      "--date",
      "2026-10-15",
      "--reason",
      REASON,
      ...extra,
    ],
    { [register]: files },
  );
}

describe("neutrality-amendments-from-run (Issue #539, D-15)", () => {
  it("no difference: 0 links, exit 0, nothing written", () => {
    const files = matrixFiles();
    const before = readFileSync(files.amendments, "utf8");
    const actual = dumpOf("cells", matrixRecording);
    expect(run("matrix", files, actual, ["--only", "^FALLBACK_", "--write"])).toBe(OK);
    expect(infoLines[0]).toBe("differing=0");
    expect(infoLines).toContain("appended=0");
    expect(readFileSync(files.amendments, "utf8")).toBe(before);
  });

  it("a differing key inside --only becomes one link from the effective value to the measured one", () => {
    const files = matrixFiles();
    const actual = dumpOf("cells", {
      ...matrixRecording,
      "FALLBACK_ADMIN | GET /a | own": { status: 403, ids: [] },
    });
    expect(run("matrix", files, actual, ["--only", "^FALLBACK_ADMIN \\|"])).toBe(OK);
    expect(infoLines[0]).toBe("differing=1");
    expect(infoLines[1]).toContain("FALLBACK_ADMIN | GET /a | own");
    expect(readFileSync(files.amendments, "utf8")).toBe('{\n  "amendments": []\n}\n');
  });

  it("--write appends the link; for an already amended key 'from' is the previous link's 'to'", () => {
    const existing = JSON.stringify(
      [
        {
          date: "2026-09-25",
          from: { status: 200, ids: [] },
          issue: 333,
          key: "FALLBACK_ADMIN | GET /a | own",
          reason: "an earlier reason of well over twenty characters",
          to: { status: 201, ids: [] },
        },
      ],
      null,
      2,
    ).replace(/\n/g, "\n  ");
    const files = matrixFiles(existing);
    const before = readFileSync(files.amendments, "utf8");
    const actual = dumpOf("cells", {
      ...matrixRecording,
      "FALLBACK_ADMIN | GET /a | own": { status: 403, ids: [] },
    });
    expect(run("matrix", files, actual, ["--only", "^FALLBACK_ADMIN \\|", "--write"])).toBe(OK);
    expect(infoLines).toContain("appended=1");
    const text = readFileSync(files.amendments, "utf8");
    expect(text.startsWith(before.slice(0, before.length - "\n  ]\n}\n".length))).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    const links = (JSON.parse(text) as { amendments: Array<Record<string, unknown>> }).amendments;
    expect(links).toHaveLength(2);
    expect(links[1]).toEqual({
      date: "2026-10-15",
      from: { status: 201, ids: [] },
      issue: 539,
      key: "FALLBACK_ADMIN | GET /a | own",
      reason: REASON,
      to: { status: 403, ids: [] },
    });
  });

  it("new links are appended in code-point key order after the existing ones", () => {
    const files = matrixFiles();
    const actual = dumpOf("cells", {
      ...matrixRecording,
      "FALLBACK_MANAGER | GET /a | own": { status: 403, ids: [] },
      "FALLBACK_ADMIN | GET /a | own": { status: 403, ids: [] },
    });
    expect(run("matrix", files, actual, ["--only", "^FALLBACK_", "--write"])).toBe(OK);
    const links = (
      JSON.parse(readFileSync(files.amendments, "utf8")) as { amendments: Array<{ key: string }> }
    ).amendments;
    expect(links.map((l) => l.key)).toEqual([
      "FALLBACK_ADMIN | GET /a | own",
      "FALLBACK_MANAGER | GET /a | own",
    ]);
  });

  it("a differing key NOT matching --only refuses with exit 1, names the key and writes nothing", () => {
    const files = matrixFiles();
    const before = readFileSync(files.amendments, "utf8");
    const actual = dumpOf("cells", {
      ...matrixRecording,
      "ADMIN | GET /a | own": { status: 403, ids: [] },
      "FALLBACK_ADMIN | GET /a | own": { status: 403, ids: [] },
    });
    expect(run("matrix", files, actual, ["--only", "^FALLBACK_", "--write"])).toBe(REFUSED);
    expect(errorLines.join("\n")).toContain("ADMIN | GET /a | own");
    expect(readFileSync(files.amendments, "utf8")).toBe(before);
  });

  it("a recorded key missing from the dump refuses (incomplete run)", () => {
    const files = matrixFiles();
    const { "ADMIN | GET /a | own": _dropped, ...rest } = matrixRecording;
    void _dropped;
    const actual = dumpOf("cells", rest);
    expect(run("matrix", files, actual, ["--only", "^FALLBACK_"])).toBe(REFUSED);
    expect(errorLines.join("\n")).toContain("misses this recorded key");
  });

  it("a key in the dump that the recording lacks refuses", () => {
    const files = matrixFiles();
    const actual = dumpOf("cells", {
      ...matrixRecording,
      "FALLBACK_ADMIN | GET /new | own": { status: 200, ids: [] },
    });
    expect(run("matrix", files, actual, ["--only", "^FALLBACK_"])).toBe(REFUSED);
  });

  it("a broken existing chain is a refusal", () => {
    const stale = JSON.stringify([
      {
        date: "2026-09-25",
        from: { status: 500, ids: [] },
        issue: 333,
        key: "FALLBACK_ADMIN | GET /a | own",
        reason: "an earlier reason of well over twenty characters",
        to: { status: 201, ids: [] },
      },
    ]);
    const files = matrixFiles(stale);
    const actual = dumpOf("cells", {
      ...matrixRecording,
      "FALLBACK_ADMIN | GET /a | own": { status: 201, ids: [] },
    });
    expect(run("matrix", files, actual, ["--only", "^FALLBACK_"])).toBe(REFUSED);
    expect(errorLines.join("\n")).toContain("stale against the recording");
  });

  it("--reason shorter than 20 characters, a malformed --date and an unknown --register exit 1", () => {
    const files = matrixFiles();
    const actual = dumpOf("cells", matrixRecording);
    const base = ["--actual", actual, "--only", "x", "--issue", "539"];
    expect(
      main(["--register", "matrix", ...base, "--date", "2026-10-15", "--reason", "short"], {
        matrix: files,
      }),
    ).toBe(REFUSED);
    expect(
      main(["--register", "matrix", ...base, "--date", "15.10.2026", "--reason", REASON], {
        matrix: files,
      }),
    ).toBe(REFUSED);
    expect(
      main(["--register", "matrix", ...base, "--date", "2026-02-30", "--reason", REASON], {
        matrix: files,
      }),
    ).toBe(REFUSED);
    expect(
      main(["--register", "nope", ...base, "--date", "2026-10-15", "--reason", REASON], {
        matrix: files,
      }),
    ).toBe(REFUSED);
  });

  it("--only is required, and --expect-removed is refused outside the recipients register", () => {
    const files = matrixFiles();
    const actual = dumpOf("cells", matrixRecording);
    expect(
      main(
        [
          "--register",
          "matrix",
          "--actual",
          actual,
          "--issue",
          "539",
          "--date",
          "2026-10-15",
          "--reason",
          REASON,
        ],
        { matrix: files },
      ),
    ).toBe(REFUSED);
    expect(run("matrix", files, actual, ["--only", "x", "--expect-removed", "y"])).toBe(REFUSED);
  });

  it("never writes the recording or the dump", () => {
    const files = matrixFiles();
    const actual = dumpOf("cells", {
      ...matrixRecording,
      "FALLBACK_ADMIN | GET /a | own": { status: 403, ids: [] },
    });
    const recordingBefore = readFileSync(files.recording, "utf8");
    const dumpBefore = readFileSync(actual, "utf8");
    expect(run("matrix", files, actual, ["--only", "^FALLBACK_", "--write"])).toBe(OK);
    expect(readFileSync(files.recording, "utf8")).toBe(recordingBefore);
    expect(readFileSync(actual, "utf8")).toBe(dumpBefore);
  });

  describe("recipients register", () => {
    const site = (recipients: string[], extra: Record<string, unknown> = {}) => ({
      type: "LEAVE_REQUEST",
      actor: "R.employee",
      recipients,
      subjectRows: [],
      tenantS: [],
      ...extra,
    });
    const recording = {
      "#01 leave.ts POST /leave/requests": site([
        "R.admin",
        "R.fallback.admin",
        "R.fallback.manager",
        "R.manager",
      ]),
      "#02 other": site(["R.admin"]),
    };
    function recipientFiles() {
      return {
        recording: put("recipients.json", JSON.stringify({ sites: recording })),
        amendments: put(
          "recipients-amendments.json",
          '{\n  "amendments": [\n' +
            '    {"date": "2026-09-25", "from": ["R.admin", "R.exited"], "issue": 355, "key": "#02 other", "reason": "an earlier reason of well over twenty characters", "to": ["R.admin"]}\n' +
            "  ]\n}\n",
        ),
      };
    }
    const removed = ["--only", "^#01 ", "--expect-removed", "^R\\.fallback\\."];

    it("accepts exactly the removal of the named labels and appends a one-line link", () => {
      // #02's chain starts at a recording that already equals its link's 'from'? It does not, so use #01 only:
      const files = recipientFiles();
      writeFileSync(files.amendments, '{\n  "amendments": []\n}\n');
      const actual = dumpOf("sites", {
        ...recording,
        "#01 leave.ts POST /leave/requests": site(["R.admin", "R.manager"]),
      });
      expect(run("recipients", files, actual, [...removed, "--write"])).toBe(OK);
      expect(infoLines[0]).toBe("differing=1");
      const text = readFileSync(files.amendments, "utf8");
      expect(text).toContain(
        '{"date": "2026-10-15", "from": ["R.admin", "R.fallback.admin", "R.fallback.manager", "R.manager"]',
      );
      const links = (JSON.parse(text) as { amendments: Array<{ to: string[] }> }).amendments;
      expect(links).toHaveLength(1);
      expect(links[0].to).toEqual(["R.admin", "R.manager"]);
    });

    it("refuses a change that is more than the named removal", () => {
      const files = recipientFiles();
      writeFileSync(files.amendments, '{\n  "amendments": []\n}\n');
      const actual = dumpOf("sites", {
        ...recording,
        "#01 leave.ts POST /leave/requests": site(["R.admin"]),
      });
      expect(run("recipients", files, actual, removed)).toBe(REFUSED);
    });

    it("refuses a change without --expect-removed", () => {
      const files = recipientFiles();
      writeFileSync(files.amendments, '{\n  "amendments": []\n}\n');
      const actual = dumpOf("sites", {
        ...recording,
        "#01 leave.ts POST /leave/requests": site(["R.admin", "R.manager"]),
      });
      expect(run("recipients", files, actual, ["--only", "^#01 "])).toBe(REFUSED);
    });

    it("refuses when any other site field differs from the recording", () => {
      const files = recipientFiles();
      writeFileSync(files.amendments, '{\n  "amendments": []\n}\n');
      const actual = dumpOf("sites", {
        ...recording,
        "#01 leave.ts POST /leave/requests": site(["R.admin", "R.manager"], {
          subjectRows: ["R.employee"],
        }),
      });
      expect(run("recipients", files, actual, [...removed])).toBe(REFUSED);
    });

    it("compares against the effective recipients of an existing chain (0 differences when the dump equals it)", () => {
      const files = recipientFiles();
      const actual = dumpOf("sites", { ...recording, "#02 other": site(["R.admin"]) });
      // #02's register link starts at ["R.admin","R.exited"] while the recording says ["R.admin"]: stale.
      expect(run("recipients", files, actual, ["--only", "^#01 "])).toBe(REFUSED);
      const ok = {
        recording: put(
          "recipients2.json",
          JSON.stringify({ sites: { "#02 other": site(["R.admin", "R.exited"]) } }),
        ),
        amendments: files.amendments,
      };
      const dump = dumpOf("sites", { "#02 other": site(["R.admin"]) });
      expect(run("recipients", ok, dump, ["--only", "^__none__$"])).toBe(OK);
      expect(infoLines.at(-1)).toBe("differing=0");
    });
  });

  describe("activity-auth register", () => {
    it("treats the whole entry as the value", () => {
      const rec = { "auth | A.x | login": { status: 200, bodyRole: "ADMIN" } };
      const files = {
        recording: put("activity-auth.json", JSON.stringify({ entries: rec })),
        amendments: put("activity-auth-amendments.json", '{\n  "amendments": []\n}\n'),
      };
      const actual = dumpOf("entries", { "auth | A.x | login": { status: 403 } });
      expect(run("activity-auth", files, actual, ["--only", "^auth \\| A\\.x ", "--write"])).toBe(
        OK,
      );
      const links = (
        JSON.parse(readFileSync(files.amendments, "utf8")) as {
          amendments: Array<{ from: unknown; to: unknown }>;
        }
      ).amendments;
      expect(links).toEqual([
        expect.objectContaining({ from: { status: 200, bodyRole: "ADMIN" }, to: { status: 403 } }),
      ]);
    });
  });

  describe("appendLinks", () => {
    it("keeps the existing text byte-identical and refuses an unknown file layout", () => {
      const text = '{\n  "amendments": [\n    {"a": 1}\n  ]\n}\n';
      const link = { key: "k", from: ["x"], to: [], issue: 1, reason: REASON, date: "2026-10-15" };
      const out = appendLinks("recipients", text, [link]);
      expect(out.startsWith('{\n  "amendments": [\n    {"a": 1},\n')).toBe(true);
      expect(() => appendLinks("recipients", "[]", [link])).toThrow();
      expect(existsSync(dir)).toBe(true);
    });
  });
});

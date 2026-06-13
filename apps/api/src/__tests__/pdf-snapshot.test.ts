// Phase 84 Plan 01 — Stundennachweis PDF byte-equivalence snapshot (DATEV-V19-01)
//
// Mirrors datev-snapshot.test.ts (Phase 78 Plan 04) for the PDF Stundennachweis,
// closing PITFALLS.md L-1/L-3 (silent layout/shape drift in the monthly PDF).
//
// The fixture is a deterministic Azubi + 8 TimeEntries May W2+W3 scenario,
// identical to datev-snapshot's seed scenario. The 2 BS days are reflected as
// otherAbsenceDays in the summary box (this is the simplest invariant for the
// baseline; later phases may revise if BS hours start contributing to the
// worked-row of the table).
//
// Determinism: PDFKit normally embeds `new Date()` in the page footer.
// Phase 84 Task 1 adds `options?.createdAt` to `generateMonthlyReportPdf`; we
// pin "01.06.2026" so the rendered bytes are 100% reproducible.
//
// PITFALL A3 from RESEARCH — empirically verified 2026-06-13:
// PDFKit embeds TWO sources of non-determinism per invocation:
//   1. /ID [<hex> <hex>] in the PDF trailer — random per invocation.
//      Format: /ID [<797f9f0ab543cb0db22af98a408cd9db> <797f9f0ab543cb0db22af98a408cd9db>]
//   2. (D:YYYYMMDDHHmmssZ) CreationDate stored as a standalone PDF Info object —
//      live timestamp at generation time.
//      Format: (D:20260613212828Z)
// Both are scrubbed by normalizePdfBytes() before hashing. The user-visible
// footer date ("Erstellt am 01.06.2026") is pinned via options?.createdAt (Task 1)
// and does NOT require scrubbing.
//
// WHY this test exists:
// Stundennachweis is a payroll-relevant PDF (employees sign it, tax advisors
// review it). A silent layout change (reordered columns, dropped row, font swap,
// column width change) corrupts the audit trail without anyone noticing until the
// next audit. The SHA-256 snapshot is the cheapest possible byte-equivalence
// guard: any rendering drift surfaces as a `.snap` diff in PR review, forcing
// explicit reviewer approval of layout changes.
//
// WHAT is covered (DATEV-V19-01):
//   - Byte-length stability: layout/pagination must not shift silently
//   - SHA-256 stability after metadata scrubbing: content must not drift
//   - Cross-invocation determinism: same inputs → same output
//   - PDF magic bytes: output must be a well-formed PDF
//   - Footer date pinning: options?.createdAt is reflected in the binary output
//
// NOTE: No DB setup needed — generateMonthlyReportPdf is a pure rendering
// function. Test cost: ~300ms (PDFKit buffer generation, no DB IO).

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { generateMonthlyReportPdf, type MonthlyReportData } from "../utils/pdf";

// ── Pinned fixture ─────────────────────────────────────────────────────────────
//
// Single Azubi: FIXED_SCHEDULE 40h Mo-Fr, hireDate=2024-01-01
// May 2026: 2 BS-Tage (Mon 2026-05-04 + Mon 2026-05-11) shown as otherAbsenceDays
// 8 TimeEntries: Tue-Fri of weeks 2+3 (May 5/6/7/8 and May 12/13/14/15), each 8h
// Matches datev-snapshot.test.ts scenario exactly for cross-test consistency.
// No PII — initials only (memory feedback_no_pii_in_github).
//
const PINNED_CREATED_AT = "01.06.2026";

const data: MonthlyReportData = {
  tenantName: "DS pdf-snap",
  employeeName: "A. Z.",
  employeeNumber: "AZ-001",
  month: "Mai 2026",
  workedHours: 64.0, // 8 days × 8h
  targetHours: 80.0, // 10 workdays × 8h (Mo-Fr weeks 2+3)
  overtimeHours: -16.0, // 64 - 80 (2 BS days absent from schedule)
  sickDays: 0,
  sickDaysWithAttest: 0,
  vacationDays: 0,
  otherAbsenceDays: 2, // 2 Berufsschultage (Mon 2026-05-04 + Mon 2026-05-11)
  entries: [
    // Tue-Fri Week 2 of May 2026: 07:00–15:00 UTC, no breaks = 8h net each
    { date: "05.05.2026", start: "07:00", end: "15:00", breakMin: 0, netHours: 8.0, note: "" },
    { date: "06.05.2026", start: "07:00", end: "15:00", breakMin: 0, netHours: 8.0, note: "" },
    { date: "07.05.2026", start: "07:00", end: "15:00", breakMin: 0, netHours: 8.0, note: "" },
    { date: "08.05.2026", start: "07:00", end: "15:00", breakMin: 0, netHours: 8.0, note: "" },
    // Tue-Fri Week 3 of May 2026: same pattern
    { date: "12.05.2026", start: "07:00", end: "15:00", breakMin: 0, netHours: 8.0, note: "" },
    { date: "13.05.2026", start: "07:00", end: "15:00", breakMin: 0, netHours: 8.0, note: "" },
    { date: "14.05.2026", start: "07:00", end: "15:00", breakMin: 0, netHours: 8.0, note: "" },
    { date: "15.05.2026", start: "07:00", end: "15:00", breakMin: 0, netHours: 8.0, note: "" },
  ],
};

// ── PDF metadata scrubber ──────────────────────────────────────────────────────
//
// Empirically verified 2026-06-13: PDFKit embeds two non-deterministic fields.
//
// Field 1 — /ID trailer entry (random hex per invocation):
//   /ID [<797f9f0ab543cb0db22af98a408cd9db> <797f9f0ab543cb0db22af98a408cd9db>]
//   PDF_ID_RE matches the full bracket expression with two hex strings.
//
// Field 2 — Info CreationDate as standalone PDF object (live timestamp):
//   Object 16 in Info dict: endobj\n16 0 obj\n(D:20260613212828Z)\nendobj
//   PDF_DATE_RE covers UTC (Z), positive (+HH'mm') and negative (-HH'mm') offsets.
//
// The user-visible footer date is already pinned via options?.createdAt — no
// regex scrubbing needed for that user-facing field.
//
// NOTE on binary encoding: Buffer.toString("binary") is an alias for latin1.
// It preserves every byte as a single code point (0x00–0xFF), which is safe
// for regex substitution of ASCII-range metadata in PDF binary files.
//
const PDF_ID_RE = /\/ID \[<[0-9a-f]+> <[0-9a-f]+>\]/gi;
const PDF_ID_FIXED = "/ID [<00000000000000000000000000000000> <00000000000000000000000000000000>]";

// Matches D: + 14 digits + timezone offset (Z, +HH'mm', or -HH'mm')
const PDF_DATE_RE = /\(D:\d{14}[Z+-][^)]*\)/g;
const PDF_DATE_FIXED = "(D:20260601000000Z)";

function normalizePdfBytes(buf: Buffer): Buffer {
  const str = buf.toString("binary");
  const scrubbed = str.replace(PDF_ID_RE, PDF_ID_FIXED).replace(PDF_DATE_RE, PDF_DATE_FIXED);
  return Buffer.from(scrubbed, "binary");
}

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Stundennachweis PDF snapshot (Phase 84 Plan 01) — DATEV-V19-01", () => {
  // Test 1: Core snapshot — any layout/font/column-width change surfaces here.
  // Pinned to Linux (CI canonical) — PDFKit produces platform-specific bytes
  // due to font fallback differences (macOS vs Linux glyph metrics, ~15 bytes).
  // On non-Linux, the byte snapshot is skipped; determinism (Test 2) + backward
  // compat (Test 3) still run on all platforms so the contract retains teeth.
  it.skipIf(process.platform !== "linux")(
    "Stundennachweis PDF bytes match snapshot for Azubi+BS May 2026 scenario",
    async () => {
      const pdfBuffer = await generateMonthlyReportPdf(data, { createdAt: PINNED_CREATED_AT });

      // Sanity: PDFKit must produce a non-trivial buffer (valid PDFs are at minimum ~1KB)
      expect(pdfBuffer.length).toBeGreaterThan(1000);

      // Well-formed PDF starts with the magic header bytes
      const header = pdfBuffer.subarray(0, 5).toString("ascii");
      expect(header).toBe("%PDF-");

      // Normalize metadata (/ID + CreationDate) before hashing.
      // byteLength is preserved post-normalization (scrubbed strings are same length).
      const normalized = normalizePdfBytes(pdfBuffer);
      const digest = sha256hex(normalized);

      expect({ byteLength: normalized.length, sha256: digest }).toMatchSnapshot();
    },
  );

  // Test 2: Determinism — proves createdAt injection + metadata normalization
  // eliminates ALL sources of non-determinism in the rendered PDF
  it("determinism: two consecutive calls with same fixture produce identical SHA-256", async () => {
    const buf1 = await generateMonthlyReportPdf(data, { createdAt: PINNED_CREATED_AT });
    const buf2 = await generateMonthlyReportPdf(data, { createdAt: PINNED_CREATED_AT });

    const h1 = sha256hex(normalizePdfBytes(buf1));
    const h2 = sha256hex(normalizePdfBytes(buf2));

    // If this fails: normalizePdfBytes() needs to cover additional metadata fields.
    // Check the output with: buf.toString("binary").match(/\/ID.{0,100}/) etc.
    expect(h1).toBe(h2);
  });

  // Test 3: Backward-compatibility — calling without options must still work
  it("backward-compat: generateMonthlyReportPdf(data) without options produces valid PDF", async () => {
    // No second argument — must not throw; falls back to new Date()
    const pdfBuffer = await generateMonthlyReportPdf(data);
    expect(pdfBuffer.length).toBeGreaterThan(1000);
    const header = pdfBuffer.subarray(0, 5).toString("ascii");
    expect(header).toBe("%PDF-");
  });
});

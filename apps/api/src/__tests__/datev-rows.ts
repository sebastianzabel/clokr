/**
 * Issue #304: shared parser of the DATEV LODAS file for tests. It reads the [Bewegungsdaten]
 * block into typed rows. The layout it assumes is the one declared in the file's own
 * [Satzbeschreibung] (Satz 20 = u_lod_bwd_buchung_stunden, Satz 21 = u_lod_bwd_buchung_tage);
 * the independent proof of that layout against the official field list is
 * datev-lodas-feldliste-304.test.ts.
 */
import iconv from "iconv-lite";

export interface DatevRow {
  satzId: string;
  pnr: string;
  zeitraum: string;
  lohnart: string;
  /** The quantity as written (decimal comma) in the stunden OR tage column of the row. */
  menge: string;
  kind: "stunden" | "tage";
  raw: string;
}

export function decodeDatev(rawPayload: Buffer): string {
  return iconv.decode(rawPayload, "win1252");
}

/** Non-empty lines of one section of the file. */
export function datevSectionLines(text: string, section: string): string[] {
  const after = text.split(`[${section}]`)[1] ?? "";
  const next = after.indexOf("\r\n[");
  return (next === -1 ? after : after.slice(0, next)).split("\r\n").filter((l) => l.trim() !== "");
}

export function parseDatevRows(text: string): DatevRow[] {
  return datevSectionLines(text, "Bewegungsdaten").map((raw) => {
    const f = raw.split(";");
    return {
      satzId: f[0]!,
      pnr: f[1]!,
      zeitraum: f[2]!,
      lohnart: f[3]!,
      menge: f[4]!,
      kind: f[0] === "21" ? "tage" : "stunden",
      raw,
    };
  });
}

export const rowsOf = (rawPayload: Buffer): DatevRow[] => parseDatevRows(decodeDatev(rawPayload));

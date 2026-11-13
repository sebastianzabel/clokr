// Issue #610 (D-12, P-610-21): how the profile words a coupled device. Pure; the component presents.

const DATE_TIME = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** How the mapping was made: by the QR pairing or typed in by hand. */
export function pairedViaLabel(via: "MANUAL" | "QR"): string {
  return via === "QR" ? "über QR-Code gekoppelt" : "manuell eingetragen";
}

/**
 * When the device was last recognised in the salon WLAN. `format` is injectable so a test does not
 * depend on the machine's time zone.
 */
export function lastSeenLabel(
  lastSeenAt: string | null,
  format: (date: Date) => string = (date) => DATE_TIME.format(date),
): string {
  if (lastSeenAt === null) return "noch nicht erkannt";
  const date = new Date(lastSeenAt);
  if (Number.isNaN(date.getTime())) return "noch nicht erkannt";
  return `zuletzt erkannt am ${format(date)}`;
}

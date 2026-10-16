/**
 * The instant of a wall-clock time ("2026-10-15", "08:00") in a given IANA zone, independent of the
 * zone of the process running the spec.
 *
 * `new Date("2026-10-15T08:00:00")` reads the string in the PROCESS zone: UTC on a CI runner, the
 * developer's zone locally. The browser of these specs runs in the tenant's zone, so a row recorded
 * through the API with the process-zone instant lands two hours away from the time the browser form
 * types (CI: 08:00 became 10:00 Berlin and collided with a 12:00 entry typed in the form).
 */
export function zonedInstant(day: string, time: string, timeZone: string): Date {
  const [y, mo, d] = day.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  // Offset of the zone at (about) that instant, read from Intl; iterate once to settle across a DST edge.
  let instant = asUtc;
  for (let i = 0; i < 2; i += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(instant));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    instant += asUtc - shown;
  }
  return new Date(instant);
}

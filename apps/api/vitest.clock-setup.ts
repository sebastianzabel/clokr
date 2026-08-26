/**
 * Opt-in, process-level `Date` shift for reproducing tenant-timezone date bugs
 * (issue #34) on demand, at any real hour.
 *
 * Why not `vi.useFakeTimers()`: it intercepts timers (setTimeout/setInterval),
 * which breaks the live Postgres connection this suite depends on
 * (`pg`/Prisma schedule keep-alives, connection-pool timers, etc.).
 *
 * Why not `TZ=Europe/Berlin` alone: `Date`'s ISO-8601 string rendering always
 * formats in UTC regardless of the `TZ` environment variable — it cannot
 * reproduce a bug caused by "local arithmetic, then UTC-formatted output"
 * diverging from tenant-TZ day boundaries. The shift must happen at the
 * `Date` level, not the process locale level.
 *
 * Activation: set `CLOKR_TEST_FAKE_CLOCK="HH:MM"` to pin `Date.now()` (and the
 * zero-arg `new Date()` constructor) to today's date at that wall-clock time
 * in `CLOKR_TEST_FAKE_CLOCK_TZ` (default `Europe/Berlin`). Absent the env var,
 * this file is a complete no-op — zero effect on CI and on normal local runs.
 *
 * This is a test-only harness, loaded exclusively via `vitest.config.ts`
 * `setupFiles`. It is never imported by `src/index.ts` / `src/app.ts` and is
 * excluded from the runtime image by the `pnpm deploy --prod` prune (no
 * `vitest.*` files are copied into any Docker image).
 */
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

const spec = process.env.CLOKR_TEST_FAKE_CLOCK;
const g = globalThis as typeof globalThis & { __clokrFakeClockInstalled?: boolean };

if (spec && !g.__clokrFakeClockInstalled) {
  const tz = process.env.CLOKR_TEST_FAKE_CLOCK_TZ ?? "Europe/Berlin";
  const RealDate = Date; // captured BEFORE patching
  const realNow = () => RealDate.now();
  const today = formatInTimeZone(new RealDate(), tz, "yyyy-MM-dd");
  const offset = fromZonedTime(`${today}T${spec}:00`, tz).getTime() - realNow();

  // Proxy, NOT a subclass: `new Date()` instances keep RealDate.prototype, so
  // `x instanceof Date` and Prisma's/pg's internal Date checks are unaffected.
  // Only the zero-arg constructor and `Date.now` are shifted; `Date.parse`/
  // `Date.UTC` and every explicit-argument constructor pass straight through.
  // Timers are NOT touched — that is what makes this safe with a live
  // Postgres connection.
  g.Date = new Proxy(RealDate, {
    construct: (t, args, nt) =>
      args.length === 0
        ? Reflect.construct(t, [realNow() + offset], nt)
        : Reflect.construct(t, args, nt),
    get: (t, p, r) => (p === "now" ? () => realNow() + offset : Reflect.get(t, p, r)),
  }) as DateConstructor;

  g.__clokrFakeClockInstalled = true;
  console.warn(`[clokr] FAKE CLOCK ACTIVE — now = ${new Date().toISOString()} (${spec} ${tz})`);
}

# BUrlG Vacation Carry-Over & Cross-Year Booking Rules

Implementation rules for vacation/leave carry-over logic. See GitHub issue #58. Linked from `CLAUDE.md`.

These rules MUST be followed when implementing or modifying vacation/leave carry-over logic.

## BUrlG (Bundesurlaubsgesetz) Rules

- **§ 3 Gesetzlicher Mindesturlaub**: `Arbeitstage/Woche × 4` (5-day week = 20 days, 6-day week = 24 days)
- **§ 7 Abs. 3 Übertragung**: Vacation MUST be taken in the current calendar year. Carry-over to the next year ONLY with valid reason (illness, operational necessity). Carried-over days expire by **March 31** of the following year (configurable per tenant).
- **Langzeitkrankheit**: Carry-over up to 15 months (EuGH C-214/10 "KHS")
- **Hinweispflicht** (EuGH C-684/16): Employer must proactively warn employees about expiring vacation. Without warning, vacation does NOT expire automatically.

## Cross-Year Booking

- Vacation spanning Dec 30 → Jan 5 MUST be split across both years (2 days from year 1, 3 days from year 2)
- Each year's entitlement is checked and booked separately
- Cancellation reverses both years

## Dynamic Carry-Over

- Carry-over is recalculated on every booking/cancellation
- Advance booking into next year: uses projected carry-over first, then new year entitlement
- New booking in current year after advance booking: carry-over to next year is reduced, next year's entitlement adjusted
- **Carry-over priority**: Always use carried-over days before new entitlement (FIFO)

## Carry-Over Validation

- If employee has not taken the statutory minimum (§ 3 BUrlG) in the current year, carry-over beyond `totalDays - statutoryMinimum` requires a documented reason (ILLNESS, OPERATIONAL, OTHER)
- Reminders starting in October (configurable) when vacation is at risk of expiring
- Escalation to manager in November, final warning in December

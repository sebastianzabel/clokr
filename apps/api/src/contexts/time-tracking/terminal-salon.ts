/**
 * Issue #541 — the binding of an NFC terminal key to a salon.
 *
 * A `TerminalApiKey` may carry an optional `salonId`. The clock resolver
 * (`services/clock/resolver.ts`) never reads that binding: the `/nfc-punch` adapter turns it into
 * the existing `ClockEvent.salonId`, which the resolver has honoured since #70 (an explicitly
 * named active salon starts or re-opens the entry in that salon). An unbound key contributes no
 * `salonId` key at all, so its event is byte-identical to the one built before #541.
 *
 * This file is the ONE place of the rule. It holds the punch-side pre-check
 * ({@link terminalPunchSalon}) and the deactivation-race retry ({@link resolveTerminalPunch}); a
 * later plan of #541 adds the write-side check here. It reads the Unterbau only through `contexts/platform/index.ts`.
 */
import type { Prisma, TerminalApiKey } from "@clokr/db";
import type { FastifyBaseLogger } from "fastify";
import { findSalon } from "../platform";
import type { ClockEvent, ClockResolution } from "../../services/clock/types";

/**
 * The salon the punch at `apiKey` must start its entry in, as a spreadable fragment of the
 * `ClockEvent`: `{ salonId }` for a key bound to an ACTIVE salon of its tenant, `{}` otherwise.
 *
 * A bound salon that cannot be used (deactivated, or not found in the key's tenant — a foreign or
 * unknown id takes the same tenant-scoped path) never blocks the punch (§ 16 Abs. 2 ArbZG): the
 * binding is ignored with one warn line and the entry follows today's rule (weekly pattern, then
 * the tenant's default salon).
 */
export async function terminalPunchSalon(
  db: Prisma.TransactionClient,
  log: Pick<FastifyBaseLogger, "warn">,
  apiKey: Pick<TerminalApiKey, "id" | "tenantId" | "salonId">,
): Promise<{ salonId?: string }> {
  if (apiKey.salonId === null) return {};

  const salon = await findSalon(db, apiKey.tenantId, apiKey.salonId);
  if (salon?.isActive) return { salonId: salon.id };

  log.warn(
    {
      terminalApiKeyId: apiKey.id,
      salonId: apiKey.salonId,
      reason: salon ? "TERMINAL_SALON_INACTIVE" : "TERMINAL_SALON_NOT_FOUND",
    },
    "terminal_salon_binding_ignored",
  );
  return {};
}

/**
 * Resolves a terminal punch, retrying ONCE without the terminal's salon when the resolver refuses
 * that salon as deactivated (Issue #541, D-09).
 *
 * The adapter's pre-check ({@link terminalPunchSalon}) runs outside the resolver's transaction, so a
 * salon deactivated in between would otherwise turn a punch into a lost 409 — and a punch must
 * never be lost (§ 16 Abs. 2 ArbZG). The retry event carries no `salonId` key at all, so the
 * resolver applies today's rule (weekly pattern, then the tenant's default salon) and cannot answer
 * SALON_INACTIVE again. Only SALON_INACTIVE is retried: a deleted salon cannot occur (salons are
 * never deleted, FK Restrict), so SALON_NOT_FOUND is deliberately not retried, and every other
 * refusal (LEAVE_APPROVED, MONTH_LOCKED, RETRO_PENDING, ENTRY_OVERLAP) stands unchanged. At most
 * two resolver calls happen. An event without a salon (an unbound key) is resolved exactly once.
 */
export async function resolveTerminalPunch(
  event: ClockEvent,
  resolve: (event: ClockEvent) => Promise<ClockResolution>,
  log: Pick<FastifyBaseLogger, "warn">,
  terminalApiKeyId: string,
): Promise<ClockResolution> {
  const first = await resolve(event);
  if (
    event.salonId === undefined ||
    first.kind !== "CONFLICT" ||
    first.reason !== "SALON_INACTIVE"
  ) {
    return first;
  }

  log.warn(
    { terminalApiKeyId, salonId: event.salonId, reason: "SALON_INACTIVE" },
    "terminal_salon_retry_without_salon",
  );
  // Destructure the salon away: the retry event must have no `salonId` key, never `undefined`.
  const { salonId: _terminalSalon, ...withoutSalon } = event;
  return resolve(withoutSalon);
}

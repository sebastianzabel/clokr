/**
 * Issue #541 — the binding of an NFC terminal key to a salon.
 *
 * A `TerminalApiKey` may carry an optional `salonId`. The clock resolver
 * (`services/clock/resolver.ts`) never reads that binding: the `/nfc-punch` adapter turns it into
 * the existing `ClockEvent.salonId`, which the resolver has honoured since #70 (an explicitly
 * named active salon starts or re-opens the entry in that salon). An unbound key contributes no
 * `salonId` key at all, so its event is byte-identical to the one built before #541.
 *
 * This file is the ONE place of the rule. Later plans of #541 add the deactivation retry and the
 * write-side check here. It reads the Unterbau only through `contexts/platform/index.ts`.
 */
import type { Prisma, TerminalApiKey } from "@clokr/db";
import type { FastifyBaseLogger } from "fastify";
import { findSalon } from "../platform";

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

import { z } from "zod";

/**
 * Shared German validation message for a mandatory Korrektur/Storno Begründung.
 * Reuses the exact wording already established in `retro-entry-requests.ts` so the
 * Revisionssicherheit language stays consistent across every "why" field in the app.
 */
export const AUDIT_REASON_REQUIRED = "Begründung ist erforderlich (revisionssicherheitspflichtig).";

/**
 * Zod rule for a mandatory audit-trail reason. `.trim()` runs before `.min()` so a
 * whitespace-only string is rejected, not silently accepted as "non-empty".
 * `.max(500)` mirrors the existing `breakStatusSchema` ceiling — never `.optional()`
 * here; callers that need conditional requirement (e.g. PUT /time-entries/:id) parse
 * this as a plain optional string at the Zod layer and enforce it in the handler instead.
 */
export const auditReasonSchema = z.string().trim().min(3, AUDIT_REASON_REQUIRED).max(500);

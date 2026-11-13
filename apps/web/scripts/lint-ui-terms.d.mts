// Types of lint-ui-terms.mjs: read by the web tests and by the API sibling gate
// `apps/api/scripts/lint-api-terms.ts` (Issue #861), which imports FORBIDDEN_TERMS instead of
// copying it. Keep in step with the module's exports.
export interface ForbiddenTerm {
  id: string;
  re: RegExp;
  reason: string;
  where?: (file: string) => boolean;
}
export interface Finding {
  file: string;
  line: number;
  term: string;
  text: string;
  reason: string;
}
export const FORBIDDEN_TERMS: ForbiddenTerm[];
export const ALLOWED: { file: string; term: string; text: string }[];
export function listScannedFiles(): string[];
export function scanSource(file: string, source: string): Finding[];
export function scan(files?: string[]): Finding[];

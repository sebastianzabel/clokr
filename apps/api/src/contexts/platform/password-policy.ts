/**
 * BSI TR-02102-1 compliant password policy validation.
 * Policy is configurable per tenant via TenantConfig.
 */
import type { FastifyInstance } from "fastify";

export interface PasswordPolicy {
  passwordMinLength: number;
  passwordRequireUpper: boolean;
  passwordRequireLower: boolean;
  passwordRequireDigit: boolean;
  passwordRequireSpecial: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  passwordMinLength: 12,
  passwordRequireUpper: true,
  passwordRequireLower: true,
  passwordRequireDigit: true,
  passwordRequireSpecial: true,
};

/** Common German + English passwords that should always be rejected. */
const BLOCKED_PASSWORDS = new Set([
  "passwort123",
  "passwort1!",
  "password123",
  "password1!",
  "hallo12345",
  "willkommen1",
  "qwertz1234",
  "qwerty1234",
  "12345678ab",
  "abcdefgh1!",
  "changeme123",
  "letmein1234",
]);

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePassword(
  password: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): PasswordValidationResult {
  const errors: string[] = [];

  if (password.length < policy.passwordMinLength) {
    errors.push(`Mindestens ${policy.passwordMinLength} Zeichen erforderlich`);
  }

  if (policy.passwordRequireUpper && !/[A-Z]/.test(password)) {
    errors.push("Mindestens ein Großbuchstabe erforderlich");
  }

  if (policy.passwordRequireLower && !/[a-z]/.test(password)) {
    errors.push("Mindestens ein Kleinbuchstabe erforderlich");
  }

  if (policy.passwordRequireDigit && !/\d/.test(password)) {
    errors.push("Mindestens eine Ziffer erforderlich");
  }

  if (policy.passwordRequireSpecial && !/[^A-Za-z0-9]/.test(password)) {
    errors.push("Mindestens ein Sonderzeichen erforderlich");
  }

  if (BLOCKED_PASSWORDS.has(password.toLowerCase())) {
    errors.push("Dieses Passwort ist zu häufig und nicht erlaubt");
  }

  return { valid: errors.length === 0, errors };
}

/** Load the password policy for a tenant from DB, falling back to defaults. */
export async function loadPasswordPolicy(
  app: FastifyInstance,
  tenantId: string,
): Promise<PasswordPolicy> {
  const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
  if (!cfg) return DEFAULT_PASSWORD_POLICY;
  return {
    passwordMinLength: cfg.passwordMinLength ?? 12,
    passwordRequireUpper: cfg.passwordRequireUpper ?? true,
    passwordRequireLower: cfg.passwordRequireLower ?? true,
    passwordRequireDigit: cfg.passwordRequireDigit ?? true,
    passwordRequireSpecial: cfg.passwordRequireSpecial ?? true,
  };
}

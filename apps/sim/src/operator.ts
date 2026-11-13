/** Operator principal: password plus TOTP, exactly like a human operator signs in (Issue #88). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as OTPAuth from "otpauth";
import type { ApiClient } from "./http";

export interface OperatorCredentials {
  email: string;
  password: string;
  totpSecret: string;
}

export function loadOperatorCredentials(stateDir: string): OperatorCredentials {
  return JSON.parse(readFileSync(join(stateDir, "operator.json"), "utf8")) as OperatorCredentials;
}

export function totpCode(secretBase32: string, at: number = Date.now()): string {
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.generate({ timestamp: at });
}

/** Signs in and returns the short-lived (15 minute) operator access token. */
export async function operatorLogin(api: ApiClient, creds: OperatorCredentials): Promise<string> {
  const step1 = await api.post<{ challengeToken?: string }>("/api/v1/operator/auth/login", {
    email: creds.email,
    password: creds.password,
  });
  if (step1.status !== 200 || !step1.body.challengeToken) {
    throw new Error(`Operator login (password) refused with status ${step1.status}`);
  }
  // A TOTP step can only be used once; if the previous code of this account is still in its step,
  // wait for the next one rather than failing.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const step2 = await api.post<{ accessToken?: string }>("/api/v1/operator/auth/verify", {
      challengeToken: step1.body.challengeToken,
      code: totpCode(creds.totpSecret),
    });
    if (step2.status === 200 && step2.body.accessToken) return step2.body.accessToken;
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 31_000));
  }
  throw new Error("Operator login (second factor) refused");
}

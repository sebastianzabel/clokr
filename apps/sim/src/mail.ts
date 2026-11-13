/**
 * Reads the invitation mail of a tenant admin from the mail catcher (mailpit) of the simulation
 * instance. This is the real path a human admin takes: the link in the mail sets the password.
 */

export interface MailClient {
  fetchJson(path: string): Promise<unknown>;
}

export function mailpitClient(baseUrl: string): MailClient {
  return {
    fetchJson: async (path) => {
      const res = await fetch(`${baseUrl}${path}`);
      if (!res.ok) throw new Error(`Mail catcher answered ${res.status} for ${path}`);
      return res.json();
    },
  };
}

interface MessageSummary {
  ID: string;
  To?: { Address: string }[];
}

/** Extracts the `token` query parameter of the invitation link in a mail body. */
export function invitationTokenFrom(body: string): string | null {
  const match = /invitation\?token=([A-Za-z0-9_-]+)/.exec(body);
  return match ? match[1] : null;
}

/** Polls the catcher until an invitation for the address arrives. */
export async function waitForInvitationToken(
  mail: MailClient,
  address: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  for (;;) {
    const list = (await mail.fetchJson(`/api/v1/messages?limit=200`)) as {
      messages?: MessageSummary[];
    };
    const hit = (list.messages ?? []).find((m) =>
      (m.To ?? []).some((to) => to.Address.toLowerCase() === address.toLowerCase()),
    );
    if (hit) {
      const full = (await mail.fetchJson(`/api/v1/message/${hit.ID}`)) as {
        HTML?: string;
        Text?: string;
      };
      const token = invitationTokenFrom(`${full.HTML ?? ""}\n${full.Text ?? ""}`);
      if (token) return token;
    }
    if (Date.now() > deadline) throw new Error("No invitation mail arrived in time");
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1000));
  }
}

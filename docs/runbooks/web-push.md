# Web-Push — Operator Runbook

**Audience:** the operator of a Clokr instance (whoever manages the stage's secret store and restarts the API).
**Related script:** `apps/api/scripts/generate-vapid-keys.ts` (Issue #608)
**Related code:** `apps/api/src/config.ts` (boot check), `apps/api/src/contexts/platform/push-sender.ts`,
`push-endpoint-guard.ts`, `notification-push-policy.ts`

Web-Push is a **second delivery channel for notifications that already exist** (the bell, and e-mail where
the tenant has it on). A person opts in **per device** on the profile page (Einstellungen, section „Push-Benachrichtigungen“) and then
gets a short, **neutral** text on the lock screen — for example „Es gibt etwas Neues in Clokr.“ — never a name,
a date, a figure or a reason. Details open only after sign-in, when the person taps the notification.
Notification types that touch health data (§ 9 BUrlG cases) never push at all.

Push is an **operator decision per instance**: it is on only when a VAPID key set is configured. Without it
nothing is sent and the profile page offers nothing.

## Prerequisites

- Access to the stage's secret store (compose `.env` on the server, ArgoCD parameters for int/demo) and the
  ability to restart the API.
- A contact for the push services (the VAPID subject): `mailto:<address>` or an `https:` URL. **Never
  `localhost`** — Apple refuses it, and the API refuses to start with it.
- The instance is served over HTTPS (browsers offer push only in a secure context).

## Switch push ON

1. Generate a pair (prints to the terminal only; nothing is written to a file):

   ```bash
   pnpm --filter @clokr/api exec tsx scripts/generate-vapid-keys.ts --subject mailto:<contact>
   ```

   In the API container (working directory `/app`):
   `docker exec -w /app/apps/api <container> pnpm tsx scripts/generate-vapid-keys.ts --subject mailto:<contact>`.

   Output (three lines — the values below are placeholders, run the command for real ones):

   ```text
   VAPID_PUBLIC_KEY=<87 characters, base64url>
   VAPID_PRIVATE_KEY=<43 characters, base64url>
   VAPID_SUBJECT=mailto:<contact>
   ```

2. Put **all three** into the stage's secret store:
   - prod / compose: `/opt/awh-infra/.env` (read by `docker-compose.prod.yml`)
   - int / demo (Helm chart): ArgoCD parameters `secrets.vapidPublicKey`, `secrets.vapidPrivateKey`,
     `secrets.vapidSubject` in `k8s-homelab/argocd-apps/clokr-app.yaml`
   - dev: the untracked env file next to `docker-compose.yml`

   **The private key is a secret. Never commit it, never paste it into an issue, a PR or a chat.** Use a
   different pair for every stage — a dev pair must never reach prod.

3. Restart the API. The boot check refuses an incomplete or inconsistent set with a message naming the
   variable (never the value): all three or none, public key 87 / private key 43 base64url characters, the
   public key must belong to the private key, the subject must be usable. The generator checks the subject
   with a short local rule only — **the API's boot check is authoritative.**

4. Check: `GET /api/v1/me/push/config` reports `enabled: true`, and the profile page now shows the
   „Push-Benachrichtigungen“ section. People enable push themselves, per device.

CI, the vitest suites and the e2e test stack run **without** keys on purpose (push off); do not add them there.

## Switch push OFF

Remove **all three** variables and restart the API.

- The profile section disappears, the registration and test routes answer 404, and nothing is sent.
- Existing device rows stay in the database but dormant; they work again when a pair is configured and (for a
  new pair, see below) people re-enable.
- Anonymizing an employee deletes that person's devices whether push is on or off.

## Rotation

A **new pair invalidates every browser subscription**: a subscription is bound to the public key it was created
with. After rotating:

- every person has to enable push again on each device (profile page, „Push aktivieren“ — the enable flow drops
  the browser subscription made with the old key and creates a new one; the browser permission is kept, so it is
  one tap);
- old rows disappear on the first send that the push service answers with 404/410, or when the device is
  re-enabled.

A push service answering **401/403** (typical right after a rotation, for every older subscription) never deletes
the row, on purpose: a wrong server key would otherwise wipe every device. Such a device keeps showing „Auf diesem
Gerät: an“ while nothing arrives; the person switches push off and on again on that device (review IN-03).

Rotate only on suspected key exposure. Do not rotate between stages' secret stores as a routine.

## Subject rule

`VAPID_SUBJECT` is `mailto:<address>` (with a real-looking `user@host.tld`) or an `https:` URL. `localhost`,
`127.0.0.1`, `*.localhost` and plain `http:` are refused at boot. Push services use the subject to contact the
operator about misbehaving senders, so use an address someone reads.

## Supported push services

The server sends only to the push services of the supported browsers. An endpoint must be `https`, port 443,
and its host must be one of these four families (or a sub-domain of one):

| Browser family                   | Host suffix                 |
| -------------------------------- | --------------------------- |
| Chrome, Edge, Android Chrome     | `fcm.googleapis.com`        |
| Firefox                          | `push.services.mozilla.com` |
| Windows notification service     | `notify.windows.com`        |
| Safari / iOS / iPadOS (Web Push) | `push.apple.com`            |

Everything else is refused when a device registers (SSRF protection): the person sees „Dieser Push-Dienst wird
nicht unterstützt.“, the API answers 400 `PUSH_ENDPOINT_NOT_ALLOWED`, and the log carries a warning
**„Push endpoint refused“ with the refused `host`** (never the full URL — it is a capability). If a legitimate
browser shows up there, the host belongs in `PUSH_SERVICE_HOST_SUFFIXES`
(`apps/api/src/contexts/platform/push-endpoint-guard.ts`) — a code change with a review, not a configuration
switch.

## iOS / iPadOS

- Requires **iOS / iPadOS 16.4 or newer**.
- Only the **installed Home-Screen app** receives push: in Safari choose „Zum Home-Bildschirm“, open Clokr from
  the new icon, then enable push on the profile page. In a normal Safari tab the section shows these steps instead
  of the switch.
- The permission prompt appears only after a tap on „Aktivieren“ (iOS refuses any other trigger).
- If the person denies the prompt, only the system settings (Einstellungen → Mitteilungen → Clokr) can undo it;
  the profile section then says the notifications are blocked in the browser settings.

## Android

Chrome (and Chromium-based browsers) work in a normal tab and as an installed app. Installing is optional but
makes the notification open the app window. Battery savers that kill the browser in the background can delay
delivery; that is a device setting, not a Clokr fault.

## Logout and session behaviour

- An **explicit logout** (Sidebar or Topbar „Abmelden“) removes this device's registration first (it waits at
  most about 3 seconds if the push service or API hangs, then logs out anyway).
- The **inactivity timeout** and a **forced re-login after an expired session (401)** do **not** remove the
  device: there is no valid token at that moment. The device keeps receiving neutral pushes until the person
  signs in again and disables push, or logs out explicitly. The texts are neutral, so nothing confidential shows
  on a lock screen of a signed-out browser, but tell people on shared devices to log out explicitly.
- A person can see and remove all their devices on the profile page, and send themselves a test.

## Known limitation (D-16)

Two code paths insert notifications **directly** instead of through `notify()` and therefore **never push**:
the Berufsschul leave correction (`bs-leave-correction.ts`) and the vocational-school cleanup
(`vocational-school-generator.ts`). Those notifications appear in the bell (and wherever their e-mail path
applies) but not on the lock screen. Routing them through `notify()` is a separate change.

## Troubleshooting

| Symptom                                                        | Check                                                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No „Push-Benachrichtigungen“ section on the profile page       | `GET /api/v1/me/push/config` → `enabled`? All three variables set and the API restarted?                                                                    |
| API does not start after setting the variables                 | Read the boot error: it names the variable. Typical: only one or two of three set; public key not matching the private key; subject `http:` or `localhost`. |
| Section says notifications are blocked in the browser settings | The browser permission is denied for this site; allow it in the browser's site settings, then enable again.                                                 |
| No notification on iPhone                                      | iOS ≥ 16.4? Clokr opened from the **Home-Screen icon**? Permission granted in Einstellungen → Mitteilungen? Focus mode off?                                 |
| Log shows „Push endpoint refused“                              | The registering browser's push host is outside the four families — see „Supported push services“.                                                           |
| Log shows „Push delivery failed“ with `statusCode` 403         | The push service rejects the VAPID signature: key/subject problem, or devices were registered with an older pair (rotate-and-re-enable).                    |
| Log shows `statusCode` 404 / 410                               | The browser dropped the subscription (uninstalled, permission revoked). The row is deleted automatically; no action.                                        |
| Nothing arrives for one notification type                      | The type may be `never` in the push policy (health data) or missing from the registry — the log then says „Notification push suppressed“ (fail-closed).     |
| After an int refresh nobody receives push                      | Intended: the refresh deletes every push device (see `docs/data-refresh-process.md`); people re-enable on int.                                              |

# @clokr/fritzbox-adapter

A small Node service that sits in the salon LAN next to a FRITZ!Box. It does two things:

1. **Presence poll.** Every `POLL_INTERVAL_SECONDS` it reads the box's host list over TR-064 and posts connect/disconnect events
   for known devices to the Clokr API (`POST /api/v1/presence/events`), authenticated with a presence key.
2. **QR pairing (Issue #610, opt-in).** A second listener serves `GET /koppeln`, so a person can couple their phone by scanning a
   QR code. Off unless `PAIRING_ENABLED=true`. Operator guide: [`docs/runbooks/wlan-qr-kopplung.md`](../../docs/runbooks/wlan-qr-kopplung.md).

## Environment

| Variable                | Required             | Default     | Meaning                                                                                         |
| ----------------------- | -------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `FRITZBOX_URL`          | yes                  |             | TR-064 base URL of the box, e.g. `http://fritz.box:49000`                                       |
| `FRITZBOX_USER`         | yes                  |             | box user with the TR-064 right to read the host list                                            |
| `FRITZBOX_PASS`         | yes                  |             | its password                                                                                    |
| `CLOKR_API_URL`         | yes                  |             | Clokr API base URL (`http://api:4000` in compose)                                               |
| `CLOKR_PRESENCE_KEY`    | yes                  |             | presence-source key; sent as Bearer token, **never logged**                                     |
| `POLL_INTERVAL_SECONDS` | no                   | `60`        | poll interval, at least 10                                                                      |
| `DEVICES_PORT`          | no                   | `8765`      | port of the `/devices` endpoint                                                                 |
| `DEVICES_BIND`          | no                   | `127.0.0.1` | bind address of the `/devices` endpoint                                                         |
| `PAIRING_ENABLED`       | no                   | `false`     | `true` switches the pairing listener on                                                         |
| `PAIRING_PORT`          | no                   | `8766`      | port of the pairing listener                                                                    |
| `PAIRING_BIND`          | no                   | `0.0.0.0`   | bind address of the pairing listener (inside the container; compose publishes the host side)    |
| `CLOKR_APP_URL`         | with pairing enabled |             | https origin of the Clokr web app; the redirect target. `http` only for `localhost`/`127.0.0.1` |

A wrong pairing value stops the adapter at startup with a message that names the variable, never its value.
Compose also takes `PAIRING_HOST_BIND` (host side of the pairing port, default `127.0.0.1`).

## Endpoints

- `GET /devices` — on `DEVICES_BIND` (loopback by default), `Authorization: Bearer <presence key>`. Lists the currently
  known hosts for the admin UI. Unchanged by #610.
- `GET /koppeln` — on the pairing listener only. Takes **no input** except the TCP peer address of the connection: it asks
  the box (`X_AVM-DE_GetSpecificHostEntryByIP`, the live answer is the only source: no cached host list) which device holds that address, registers a one-time
  code at `POST {CLOKR_API_URL}/api/v1/presence/pairing-codes` and answers `302` to
  `{CLOKR_APP_URL}/settings/geraet-koppeln?code=<code>`. Failures show a small German page (no stack, no full MAC). Requests
  from the adapter's own, a loopback or a link-local address are refused; a per-address rate limit applies.
  `X-Forwarded-For` and every query or body parameter are ignored.

## Tests

```bash
pnpm --filter @clokr/fritzbox-adapter test
```

The adapter has its own `vitest.config.mjs` (otherwise vitest picks up the repository root config). CI runs the type check and
these tests in the main workflow.

## Real-box probe

```bash
docker compose --profile fritzbox exec fritzbox-adapter node dist/probe-host.js <ip of a phone in the salon WLAN>
```

Prints what the box answers for that address (masked MAC, hostname, flags, the element names of the raw answer — names only,
never values). Exit 0 found, 2 not found, 1 error. Use it once on the real box before rolling pairing out.

## Dependency policy

The image installs with `npm ci` from this package's `package-lock.json`, which Dependabot does **not** maintain. After any
change to `package.json` regenerate the lock file with

```bash
npm install --package-lock-only --ignore-scripts
```

and rebuild the image (`docker build apps/fritzbox-adapter`). Issue #610 added no dependency to the adapter.

# WLAN pairing by QR code — Operator Runbook

**Audience:** the operator of a Clokr instance who also looks after the salon's FRITZ!Box and the host that runs the adapter.
**Related code:** `apps/fritzbox-adapter/src/pairing.ts`, `pairing-config.ts`, `probe-host.ts`, `tr064.ts`;
`apps/api/src/contexts/time-tracking/presence-pairing.ts`, `pairing-code.ts`, `wifi-device-not-seen.ts`
**Related docs:** `apps/fritzbox-adapter/README.md`, ADR `docs/adr/0001-abweichungen.md` Eintrag AE (Issue #610)

A person couples their phone to WLAN presence by scanning a QR code that hangs in the salon: the phone opens a small page
served by the FRITZ!Box adapter, the adapter asks the box which device holds the phone's own LAN address, registers a
one-time code for that device with the Clokr API and sends the phone on to the Clokr web app, where the signed-in person taps
**„Das ist mein Handy – koppeln“** (that tap is the consent). The WLAN clock logic itself (presence event → clock event) is
unchanged.

The device is decided by **the phone's own network connection** — never by anything the browser sends. That is why the
pairing page only works from inside the salon WLAN, and why a forwarded link cannot couple somebody else's phone.

Steps this repository cannot test (real FRITZ!Box, real phones, the host's firewall) are marked **„auf der echten Box prüfen“**.

## Prerequisites

- The adapter already runs with a presence key (compose profile `fritzbox`; `FRITZBOX_URL`, `FRITZBOX_USER`, `FRITZBOX_PASS`,
  `CLOKR_PRESENCE_KEY`). The presence key is created under `/admin/integrations` (presence sources).
- The FRITZ!Box user has the TR-064 right to read the host list (the same right the presence poll already needs).
- The Clokr web app is served over **https** (`CLOKR_APP_URL` must be an https origin; plain http is accepted for
  `localhost` / `127.0.0.1` on a developer machine only).
- The adapter host sits **inside the salon LAN** (it has to, to reach the box on port 49000) and the phones can reach it
  directly on the pairing port (default 8766).

## Enable pairing

Pairing is **off by default**. In the adapter's environment (compose `.env` next to `docker-compose.yml`; on the prod host
`/opt/awh-infra/.env` — a human step, nothing here edits it):

| Variable            | Value                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `PAIRING_ENABLED`   | `true`                                                                                         |
| `CLOKR_APP_URL`     | `https://<web origin of Clokr>` — a bare origin, no path, query, fragment or credentials       |
| `PAIRING_HOST_BIND` | the host's **LAN IPv4 address** (compose publishes `<address>:8766:8766`); default `127.0.0.1` |

Optional: `PAIRING_PORT` (default `8766`, change the compose port mapping with it) and `PAIRING_BIND` (default `0.0.0.0`
inside the container).

Restart the adapter. The startup log shows the pairing state: `Pairing listener on <bind>:<port>` when enabled, `Pairing
disabled` otherwise. A wrong value stops the adapter with a message that names the variable (never its value).

Without `PAIRING_HOST_BIND` the port stays on the host's loopback: nobody in the WLAN can reach it. LAN exposure is an
explicit opt-in.

## Network recipe for the pairing port

The adapter reads the phone's address from the TCP connection it receives. If anything between the phone and the adapter
rewrites that source address, the adapter sees the wrong device or none. This is the single most likely cause of a failed
rollout, so work through the recipe on the real host.

1. **Direct path.** The phone reaches the adapter host directly: no router hop, no port forward, no reverse proxy or load
   balancer in front of 8766. An `X-Forwarded-For` header is deliberately **ignored** — a proxy cannot be made to work.

2. **Recommended setup.** Linux host, Docker Engine with its default netfilter firewall backend (iptables or nftables), IPv4.
   Keep the compose bridge network and set `PAIRING_HOST_BIND=<host LAN IPv4>`. A phone's connection arrives on the LAN
   interface, Docker's DNAT rule forwards it to the container and **preserves the source address**, so the adapter sees the
   phone's own LAN IP. Docker's userland proxy (`docker-proxy`) only carries connections that start on the host itself
   (loopback/hairpin): a `curl` from the host shows `127.0.0.1` or the bridge gateway. **Always test from a phone**
   („auf der echten Box prüfen“).

3. **Setups that hide the source address.** Pairing then answers „Gerät nicht gefunden“ or the adapter refuses the peer:
   - Docker Desktop (the VM NATs every connection),
   - rootless Docker with RootlessKit's default port driver,
   - `"iptables": false` in `/etc/docker/daemon.json`,
   - an IPv6-only publish without ip6tables,
   - any proxy or port forward in front of 8766.

4. **Fallback when (2) is impossible.** A compose override with `network_mode: host` for the adapter, `PAIRING_BIND=<host LAN
IPv4>` and a `CLOKR_API_URL` that the host can reach (the service name `api` does not resolve under host networking).
   „auf der echten Box prüfen“ — this repository's compose files do not use it.

5. **Verify on the real host** („auf der echten Box prüfen“):
   - `docker info` security options show no `rootless`;
   - `/etc/docker/daemon.json` has no `"iptables": false`;
   - `sudo iptables -t nat -S DOCKER | grep 8766` (or `sudo nft list ruleset | grep 8766` on the nftables backend) shows a
     DNAT rule to the container;
   - open `http://<host LAN IP>:8766/koppeln` **from a phone in the salon WLAN** and compare the adapter log's `peer=` with
     the phone's address (phone Wi-Fi details, or the FRITZ!Box list „Heimnetz → Netzwerk“). They must be equal. A `127.x`
     peer or an address from Docker's bridge ranges means the source is hidden.

6. **Host firewall.** Allow inbound TCP 8766 only from the salon WLAN subnet. Docker's published ports bypass ufw rules by
   default („auf der echten Box prüfen“).

The adapter itself refuses requests whose peer is its own interface address, a loopback address or a link-local address, and
logs the observed peer IP (adapter log only, never to the API).

## Print the QR code

An admin opens `/admin/integrations` → section **„Handys per QR-Code koppeln“**, types the adapter host's private IPv4 address
(and the port if it is not 8766) and prints the sheet. The QR code is built in the browser for
`http://<address>:<port>/koppeln`; the address is never stored or sent anywhere. The section also lists the preconditions
below. Hang the sheet where staff can scan it **while connected to the salon WLAN**.

## WLAN preconditions

- **WPA2/WPA3 salon WLAN.** iOS keeps a fixed private address per network on a protected network, so one pairing stays
  valid. On an **open** network iOS rotates the private address and the pairing would soon stop matching; Android randomises
  per network but keeps the address for that network.
- **No guest WLAN with client isolation.** A guest network that isolates clients (Geräteisolation / client isolation)
  cannot reach the adapter host, and a guest network does not give the box the same view of the device. Pairing from there
  answers „Bitte im Salon-WLAN öffnen“ or „Gerät nicht gefunden“. That refusal is intended.
- The phone must be on the WLAN, **not on mobile data**, when it scans.
- Persons should leave „Private WLAN-Adresse“ at the phone's **standard setting** (on); the pairing is made for exactly that
  address.

## The flow for a person

1. Scan the QR code in the salon (phone in the salon WLAN).
2. The adapter page redirects to `<CLOKR_APP_URL>/settings/geraet-koppeln?code=…`.
3. Not signed in: the sign-in page returns to the pairing page afterwards.
4. The page shows which phone will be coupled (device name, the last two address octets, whether it replaces an earlier
   phone) and the consent text. One tap on „Das ist mein Handy – koppeln“.
5. The profile (Einstellungen → WLAN) now shows the phone as „über QR-Code gekoppelt“.

A new QR pairing **replaces** the person's earlier QR phone (hard-deleted and audited); a phone entered by hand stays. A
phone that already belongs to another person is refused (409, the code stays usable).

## Real-box spike with the probe

The by-IP lookup (`X_AVM-DE_GetSpecificHostEntryByIP`) was built from AVM's documentation and fixtures; its field names are
unconfirmed on a real FRITZ!Box. Before the rollout, with a phone connected to the salon WLAN („auf der echten Box prüfen“):

```bash
docker compose --profile fritzbox exec fritzbox-adapter node dist/probe-host.js <phone IP>
```

Expect `found: yes`, a masked MAC, the hostname, `active: yes` and `response elements:` listing `NewMACAddress`,
`NewHostName`, `NewActive`, `NewInterfaceType`. For a Wi-Fi phone `interface type` must read `802.11` (a wired value such as
„Ethernet“ makes the page refuse; a missing value only logs a warning — „auf der echten Box prüfen“). Exit code 0 = found, 2 = not found, 1 = error. If a name differs, or the box
answers with another fault, the pairing page shows the refusal page (there is deliberately no fallback to the polled host list); send the printed element names back so
the parser can be corrected — the probe prints names only, never values. The phone's IP is on the phone (Wi-Fi details) or in
the box's „Heimnetz → Netzwerk“.

## Re-couple hint

A daily job (09:20, tenant time zone) tells a person **once**, in the app and as a neutral push („Dein Handy wird im Salon
nicht mehr erkannt. Bitte koppel es neu.“; no e-mail), when their QR phone has shown no sign of life since the start of the
third-newest day on which they worked a shift and clocked by a **non-WLAN** source (look-back 28 days). Rules in plain words:

- `lastSeenAt` is the time of the **last presence event** the adapter posted — not „last seen on the network“. The adapter
  posts on connect/disconnect only, so a phone that stays connected for days produces no event; that is why only days
  clocked by another source count.
- **Outage guard:** if no source or device of the tenant produced an event in the window, nobody gets a hint (the adapter or
  the box was probably down).
- Only people who are employed today and never anonymised are considered (the one report population rule), and only valid,
  closed WORK entries of another source count as „was at work“. One failing notification does not stop the other devices.
- One hint per unseen episode; it disappears when the phone is seen again or re-coupled. Managers are never notified.

## Withdrawal

Switching WLAN presence off in the profile removes **every** device of the person and the legacy address list, each audited
with the reason „Einwilligung widerrufen“. Persons who opted out **before** this release keep inert leftover rows until they
act (no retroactive cleanup; without consent a device does nothing).

## Residual risks (accepted, documented)

- **Forwarded link (D-09).** The link can only couple the device that opened the QR page, never one chosen by the confirmer.
  Within five minutes it could still be forwarded to a colleague who then couples the scanner's phone to their own account;
  the preview shows the device, the code is single use, and the audit trail records who coupled what.
- **Plain HTTP in the LAN (D-14).** The adapter page is not encrypted; somebody sniffing the salon LAN could see the redirect
  and its code within the five minutes. Limited by single use, the preview and the audit.
- **Code in an access log (P-610-24).** The page URL carries the code once. A reverse proxy in front of the **web app** may
  log it; the API's request logs never carry it, because preview and confirm take the code in the body, and the web app sends `Referrer-Policy: no-referrer` for the pairing page and the `/login` and `/otp` pages that hold the code in `?next=`, so the code is not a `Referer` in ingress access logs; the client error log (`POST /api/v1/logs/client`) stores the page path only (the browser sends `location.pathname`, the API strips any query or fragment as well). Single use and five
  minutes limit the value of such a log line. Do not put a proxy in front of the adapter (see the network recipe).
- **IP/ARP/MAC spoofing by a LAN insider (review WR-04).** The box resolves the peer **by IP**. Somebody on the salon LAN who
  sets a colleague's static IP, spoofs ARP, or spoofs a MAC can choose which address gets coupled to them. This cannot be
  closed without network authentication (802.1X); it is limited by the salon-WLAN-only page, the single-use code, the
  preview and the audit. A host behind NAT (router, NAS, Docker host) is refused only when the box reports its interface as
  wired (`NewInterfaceType` such as „Ethernet“); an absent or unknown type pairs and logs a warning.
- **Address rotation (P-610-23).** If a phone changes its private address setting, the pairing stops matching and the hint
  tells the person to couple again.

## Troubleshooting

| Symptom                                                | Check                                                                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| „Bitte im Salon-WLAN öffnen“                           | Phone on the salon WLAN (not mobile data, not guest)? Adapter log `outcome=not-in-lan`: the source is hidden — see the network recipe.                      |
| „Gerät nicht gefunden“                                 | Phone really connected to the box (not a repeater with its own address range)? Run the probe with the phone's IP. Guest WLAN? Adapter log `outcome=…` line. |
| „Zu viele Versuche“                                    | Per-address rate limit of the adapter (five a minute, sixty over all phones); wait a minute.                                                                |
| „Kopplung gerade nicht möglich“                        | The API or the box did not answer: check `CLOKR_API_URL`, the presence key, the box credentials; read the adapter log (`reason=`).                          |
| Web: „Dieser Code ist abgelaufen oder bereits benutzt“ | The code lives five minutes and works once; scan again. (The API answers every invalid case with the same 404 so a code cannot be probed.)                  |
| Web: „… bereits einer anderen Person zugeordnet“       | The phone is mapped to another person (409 `PRESENCE_DEVICE_TAKEN`); an admin reassigns or removes it under `/admin/integrations`.                          |
| Adapter does not start                                 | The message names a variable: `PAIRING_PORT`, `PAIRING_BIND` or `CLOKR_APP_URL` (https origin required).                                                    |
| Pairing worked but no clock events                     | Pairing only maps the device; the clock logic is unchanged: shift window, `wifiPresenceEnabled`, the presence key and the adapter poll decide as before.    |

## Follow-up

The presence poll still calls the host list as `GetHostListPath`; AVM's own name is `X_AVM-DE_GetHostListPath`. D-02 (refined)
left the poll byte-identical on purpose; align the spelling in a separate change once the real box confirms which one it
answers.

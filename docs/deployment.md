# Deployment

## Docker Compose (Empfohlen)

```bash
docker compose -f docker-compose.prod.yml up -d
```

Gestartet werden: PostgreSQL, Redis, MinIO, API, Web.

## Umgebungsvariablen

| Variable                                        | Pflicht | Beschreibung                                                                                                                                                            |
| ----------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`                                    | ✓       | Zufälliger String, min. 32 Zeichen                                                                                                                                      |
| `JWT_REFRESH_SECRET`                            | ✓       | Zufälliger String, min. 32 Zeichen                                                                                                                                      |
| `ENCRYPTION_KEY`                                | ✓       | Zufälliger String, min. 32 Zeichen                                                                                                                                      |
| `OPERATOR_JWT_SECRET`                           | –       | Optional: eigenes Signiergeheimnis der Betreiber-Oberfläche, min. 32 Zeichen, verschieden von den drei Geheimnissen oben; ohne Wert bleibt die Betreiber-Oberfläche aus |
| `DATABASE_URL`                                  | ✓       | PostgreSQL Connection String                                                                                                                                            |
| `CORS_ORIGIN`                                   | ✓       | URL des Web-Frontends (kein Wildcard)                                                                                                                                   |
| `APP_URL`                                       | ✓       | Öffentliche URL (für E-Mail-Links)                                                                                                                                      |
| `CLOKR_API_IMAGE`                               | ✓       | Vollständige Image-Referenz der API, z. B. `ghcr.io/sebastianzabel/clokr-api:1.12.0` (Tag ohne führendes `v`)                                                           |
| `CLOKR_WEB_IMAGE`                               | ✓       | Vollständige Image-Referenz des Web-Frontends, z. B. `ghcr.io/sebastianzabel/clokr-web:1.12.0` (Tag ohne führendes `v`)                                                 |
| `SMTP_HOST`                                     | –       | SMTP-Server für E-Mail-Versand                                                                                                                                          |
| `SMTP_PORT`                                     | –       | SMTP-Port (z.B. 587)                                                                                                                                                    |
| `SMTP_USER`                                     | –       | SMTP-Benutzername                                                                                                                                                       |
| `SMTP_PASSWORD`                                 | –       | SMTP-Passwort                                                                                                                                                           |
| `MINIO_ROOT_USER`                               | ✓       | Zugangsdaten des MinIO-Speichers (Dokumente, Avatare); die API erhält dieselben Werte                                                                                   |
| `MINIO_ROOT_PASSWORD`                           | ✓       | Zugangsdaten des MinIO-Speichers (Dokumente, Avatare); die API erhält dieselben Werte                                                                                   |
| `MINIO_ENDPOINT`                                | ✓ (API) | Host des Objektspeichers aus Sicht der API (im Compose-Netz `minio`); ohne ihn meldet `/health` in Produktion `unconfigured`                                            |
| `MINIO_ACCESS_KEY`                              | ✓ (API) | Zugangsschlüssel für die API; im Compose aus `MINIO_ROOT_USER`                                                                                                          |
| `MINIO_SECRET_KEY`                              | ✓ (API) | Geheimer Schlüssel für die API; im Compose aus `MINIO_ROOT_PASSWORD`                                                                                                    |
| `MINIO_PORT` / `MINIO_BUCKET` / `MINIO_USE_SSL` | –       | Standard `9000` / `clokr` / `false`                                                                                                                                     |
| `LOG_LEVEL`                                     | –       | `debug` / `info` / `warn` / `error`                                                                                                                                     |
| `LOG_FORMAT`                                    | –       | `json` / `ecs` / `pretty`                                                                                                                                               |
| `SEED_DEMO_DATA`                                | –       | Demo-Daten beim Start anlegen (`true`)                                                                                                                                  |

### Objektspeicher: Verhalten bei Fehlern (Issue #184)

- **Fehlt `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY` oder `MINIO_SECRET_KEY` in Produktion, startet die API trotzdem** (so reißt eine noch nicht nachgezogene Stage nicht die Zeiterfassung mit), loggt aber **einen Fehler mit den fehlenden Variablen**, versucht nie einen geratenen Host und meldet `"storage": "unconfigured"` in `/health`. Uploads antworten 503 `STORAGE_UNAVAILABLE`. Außerhalb von Produktion gelten die Compose-/CI-Werte (`minio`, `minioadmin`). **Folgearbeit:** auf „API startet nicht“ umstellen, sobald alle Stages die Variablen tragen.
- **Kubernetes (Helm-Chart `charts/clokr-app`):** `minio.enabled=true` startet einen MinIO-StatefulSet mit Service `minio` und eigenem PVC (`helm.sh/resource-policy: keep`). Die Zugangsdaten liegen in einem von Hand angelegten Secret (Standardname `clokr-minio`, Schlüssel `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_ENDPOINT=minio`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`); `api.extraSecretName=clokr-minio` gibt sie der API. Das vom Chart erzeugte `clokr-secrets` bleibt unverändert, ArgoCD entfernt also keine Schlüssel.
- Ist der Speicher beim Start oder später nicht erreichbar, läuft die API weiter (Zeiterfassung darf nicht daran hängen), loggt es als Fehler und beantwortet Uploads (Avatare, AU-Bescheinigungen) mit **503** und dem Code `STORAGE_UNAVAILABLE`.
- `GET /health` (Liveness für Docker/k8s/Proxy) entscheidet weiterhin nur über die Datenbank, damit ein Speicherausfall keinen Neustart auslöst. Der Speicher steht zusätzlich im Antworttext: `"storage": "ok"`, `"unavailable"` oder `"unconfigured"` (zuletzt bekannter Zustand, wird bei jedem Aufruf im Hintergrund neu geprüft). Für Smoke-Tests nach dem Deploy und Überwachung auf `storage` prüfen.

## Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name clokr.deine-domain.de;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

HSTS wird von Clokr selbst gesetzt, sobald `NODE_ENV=production`.

## Backup

Die wichtigsten Daten liegen in PostgreSQL. Tägliches Backup:

```bash
docker exec clokr-db pg_dump -U clokr clokr > backup-$(date +%F).sql
```

MinIO-Daten (Dokumente, Avatare) separat sichern:

```bash
docker exec clokr-minio-1 mc mirror /data /backup/minio
```

## Updates

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Datenbankmigrationen laufen automatisch beim Start.

## Version pinnen

```bash
# .env
CLOKR_API_IMAGE=ghcr.io/sebastianzabel/clokr-api:1.12.0
CLOKR_WEB_IMAGE=ghcr.io/sebastianzabel/clokr-web:1.12.0
```

Tags werden ohne führendes `v` geschrieben; beide Variablen sind Pflicht, `docker compose`
bricht mit einer Fehlermeldung ab, wenn eine fehlt.

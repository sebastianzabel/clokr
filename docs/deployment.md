# Deployment

## Docker Compose (Empfohlen)

```bash
docker compose -f docker-compose.prod.yml up -d
```

Gestartet werden: PostgreSQL, Redis, MinIO, API, Web.

## Umgebungsvariablen

| Variable              | Pflicht | Beschreibung                                                                                                            |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`          | ✓       | Zufälliger String, min. 32 Zeichen                                                                                      |
| `JWT_REFRESH_SECRET`  | ✓       | Zufälliger String, min. 32 Zeichen                                                                                      |
| `ENCRYPTION_KEY`      | ✓       | Zufälliger String, min. 32 Zeichen                                                                                      |
| `DATABASE_URL`        | ✓       | PostgreSQL Connection String                                                                                            |
| `CORS_ORIGIN`         | ✓       | URL des Web-Frontends (kein Wildcard)                                                                                   |
| `APP_URL`             | ✓       | Öffentliche URL (für E-Mail-Links)                                                                                      |
| `CLOKR_API_IMAGE`     | ✓       | Vollständige Image-Referenz der API, z. B. `ghcr.io/sebastianzabel/clokr-api:1.12.0` (Tag ohne führendes `v`)           |
| `CLOKR_WEB_IMAGE`     | ✓       | Vollständige Image-Referenz des Web-Frontends, z. B. `ghcr.io/sebastianzabel/clokr-web:1.12.0` (Tag ohne führendes `v`) |
| `SMTP_HOST`           | –       | SMTP-Server für E-Mail-Versand                                                                                          |
| `SMTP_PORT`           | –       | SMTP-Port (z.B. 587)                                                                                                    |
| `SMTP_USER`           | –       | SMTP-Benutzername                                                                                                       |
| `SMTP_PASSWORD`       | –       | SMTP-Passwort                                                                                                           |
| `MINIO_ROOT_USER`     | ✓       | Zugangsdaten des MinIO-Speichers (Dokumente, Avatare); die API erhält dieselben Werte                                   |
| `MINIO_ROOT_PASSWORD` | ✓       | Zugangsdaten des MinIO-Speichers (Dokumente, Avatare); die API erhält dieselben Werte                                   |
| `LOG_LEVEL`           | –       | `debug` / `info` / `warn` / `error`                                                                                     |
| `LOG_FORMAT`          | –       | `json` / `ecs` / `pretty`                                                                                               |
| `SEED_DEMO_DATA`      | –       | Demo-Daten beim Start anlegen (`true`)                                                                                  |

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

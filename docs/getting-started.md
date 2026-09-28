# Getting Started

## Voraussetzungen

- [Docker](https://docs.docker.com/get-docker/) und Docker Compose
- Ein Server oder lokaler Rechner mit mindestens 1 GB RAM

## Installation

```bash
# 1. Konfigurationsdateien herunterladen
curl -fsSLO https://raw.githubusercontent.com/sebastianzabel/clokr/main/docker-compose.prod.yml
curl -fsSLO https://raw.githubusercontent.com/sebastianzabel/clokr/main/.env.example
cp .env.example .env
```

## Konfiguration

Öffne `.env` und trage deine Werte ein:

```bash
# Pflichtfelder — zufällige Strings (mind. 32 Zeichen)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

JWT_SECRET=<generierter-string>
JWT_REFRESH_SECRET=<generierter-string>
ENCRYPTION_KEY=<generierter-string>

# URL unter der Clokr erreichbar ist
CORS_ORIGIN=http://deine-domain.de:3000
APP_URL=http://deine-domain.de:3000

# MinIO-Zugangsdaten — MinIO und die API nutzen dieselben Werte
MINIO_ROOT_USER=<benutzername>
MINIO_ROOT_PASSWORD=<generierter-string>
```

> Alle verfügbaren Umgebungsvariablen sind in [deployment.md](./deployment.md) dokumentiert.

## Starten

```bash
docker compose -f docker-compose.prod.yml up -d
```

Clokr ist danach unter **http://localhost:3000** erreichbar.

## Erster Login

Beim ersten Start werden automatisch Demo-Daten angelegt:

| Rolle         | E-Mail         | Passwort        |
| ------------- | -------------- | --------------- |
| Administrator | admin@clokr.de | admin1234       |
| Mitarbeiter   | max@clokr.de   | mitarbeiter5678 |

> **Wichtig:** Demo-Passwörter nach dem ersten Login unbedingt ändern.

## Ersten echten Mitarbeiter anlegen

1. Als Admin anmelden
2. **Admin → Mitarbeitende → + Mitarbeiter anlegen**
3. Name, E-Mail und Rolle eingeben
4. Mitarbeiter erhält eine Einladungs-E-Mail mit Link zur Passwort-Vergabe

## Updates

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

## Version pinnen

```bash
# In .env — Tags ohne führendes `v`
CLOKR_API_IMAGE=ghcr.io/sebastianzabel/clokr-api:1.12.0
CLOKR_WEB_IMAGE=ghcr.io/sebastianzabel/clokr-web:1.12.0
```

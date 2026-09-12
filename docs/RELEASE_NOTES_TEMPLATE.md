# Release Notes — Template & Convention

Verbindliche Vorlage für alle GitHub-Releases von Clokr. **Immer** dieses Format verwenden, damit Releases konsistent aussehen.

## Regeln

- **Sprache:** Deutsch (operator-/kundenorientiert). Code, Commits, technische Docs bleiben Englisch — die Release Notes nicht.
- **Titel:** `vX.Y.Z — <kurzer deutscher Titel>` (Thema in ≤ 6 Wörtern, z. B. „Saldo-Konsistenz & Anzeige-Korrekturen"). Ein `—` (Gedankenstrich), kein `-`.
- **Kein PII:** Niemals Mitarbeiter-, Tenant- oder Kundennamen in Notes, Titeln oder Beispielen. Generisch bleiben (Arbeitszeitmodelle, Funktionen, Zahlen ohne Personenbezug).
- **Nach Thema gruppieren, nicht nach Commit.** Der Leser will wissen _was sich für ihn ändert_, nicht die Git-History.
- **Nur zutreffende Abschnitte** aus der Struktur unten verwenden — leere Abschnitte weglassen, Reihenfolge beibehalten.
- **Migrations-/Deploy-Hinweis** immer angeben: entweder „Keine Schema-Migration." oder die nötigen Schritte.
- **Audit-Hinweis** bei saldo-/lohn-/abwesenheits-/compliance-relevanten Änderungen (Revisionssicherheit) ans Ende.
- Ton: knapp, sachlich, fette **Schlüsselbegriffe** für Scanbarkeit. Keine Emojis.

## Struktur

```markdown
## vX.Y.Z — <kurzer deutscher Titel>

<1–2 Sätze: Art des Releases (Feature/Fix/Security) + Migrations-Hinweis. z. B.
"Fix-Version auf der 1.8.x-Linie. Keine Schema-Migration.">

### Neue Funktionen

- <nutzerorientierter Satz — was kann man jetzt, was vorher nicht>

### Verbesserungen

- <Änderung an bestehendem Verhalten>

### Fehlerbehebungen

- <Bug + sichtbarer Effekt der Behebung>

### Anzeige & Bedienung

- <UI-/Layout-/UX-Fixes>

### Sicherheit

- <Dependency-/CVE-Updates: Paket + Zielversion + Grund, z. B. "fast-uri ≥ 3.1.3 (Trivy HIGH)">

### Betrieb & Migration

- <Migrationen, Ops-Skripte, Deploy-Reihenfolge, Konfig-Änderungen, Backfills>

### Achtung / Breaking Changes

- <nur wenn vorhanden — was Nutzer/Betreiber aktiv beachten müssen>

---

_<optionaler Audit-/Revisionssicherheits-Hinweis>_
```

## Erstellen (Ablauf)

1. Datei `docs/release-notes/vX.Y.Z.md` nach obiger Struktur schreiben — **vor** dem Merge der
   release-please-PR. Die Version steht im Titel der offenen PR.
2. Commit-Range zur Orientierung: `git log --oneline <prev-tag>..HEAD` — dann **nach Thema**
   zusammenfassen, nicht 1:1 übernehmen.
3. Als `docs(release): add release notes for vX.Y.Z` auf `main` landen. Ein `docs:`-Commit
   verändert die Version nicht.
4. Den GitHub-Release-Body schreibt **niemand von Hand**: `.github/workflows/release.yml`
   (Job `publish-notes`) füllt ihn aus genau dieser Datei. Nachbessern heißt: Datei ändern,
   Job erneut laufen lassen.

Die Datei wird zusätzlich ins API-Abbild gebacken (`apps/api/Dockerfile`) und im
What's-New-Dialog angezeigt — derselbe Text, eine Wahrheit.

## Referenz-Beispiel (Auszug v1.8.25)

```markdown
## v1.8.25 — Saldo-Konsistenz & Anzeige-Korrekturen

Fix-Version auf der 1.8.x-Linie. Keine Schema-Migration.

### Verbesserungen

- Überstunden-Saldo rechnet über **alle** Ansichten (Kalender, Dashboard, Reports, PDF) einheitlich nach §615.
- **GESAMT-SALDO** ist monatsunabhängig — beim Monatswechsel ändert sich nur der MONAT-SALDO.

### Anzeige & Bedienung

- Benachrichtigungs-Menü liegt zuverlässig über allen Inhalten.
- Abwesenheits-Kalender: mehrtägige Abwesenheiten als durchgängige Balken pro Mitarbeiter.

---

_Abgeschlossene Monate (Snapshots) bleiben unverändert (Revisionssicherheit)._
```

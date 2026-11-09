# Glossar — binding vocabulary of the web app (Issue #574)

## 1. Purpose and scope

This glossary is binding for every text the web app shows — everything under `apps/web/src/routes`
and `apps/web/src/lib`: page and section titles, labels, hints, empty states, dialogs, toasts and
error messages written in the web app. Its machine-checkable half is the lint
`pnpm --filter @clokr/web lint:ui-terms` (`apps/web/scripts/lint-ui-terms.mjs`), which runs in CI
and in the pre-commit hook.

Not yet covered: error messages produced by the API and the e-mail templates
(`apps/api/src`). They follow the same rules, but the lint does not see them; their conversion is
a follow-up issue (D-574-03).

## 2. Address form: „du“

- The app always addresses the reader with **du** — lowercase: du, dich, dir, dein, deine. A team
  is addressed as „ihr / euch“. Owner decision of 19.10.2026.
- Never „Sie / Ihnen / Ihr“. Where „Sie“ means „she / it / they“ at the start of a sentence, the
  sentence is rephrased with the noun instead („Die Regel bleibt nachvollziehbar.“), so the lint
  needs no exception list.
- Buttons say what happens — verb and object: „Vertrag speichern“, „Antrag genehmigen“. This is a
  guideline, not a lint rule; the redesign tickets apply it page by page.

Examples:

| Instead of                                 | Write                                    |
| ------------------------------------------ | ---------------------------------------- |
| „Bitte versuchen Sie es erneut.“           | „Bitte versuch es noch einmal.“          |
| „Für diese Seite fehlen Ihnen die Rechte.“ | „Für diese Seite fehlen dir die Rechte.“ |
| „Geben Sie Ihre E-Mail-Adresse ein.“       | „Gib deine E-Mail-Adresse ein.“          |

## 3. Binding terms

| Use                                                | Never                                   | Note                                                                                                                         |
| -------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Unternehmen                                        | Tenant, Mandant                         | „Mandant“ only in the operator console `/betreiber` (the operator is the reader) and in DATEV's own field „Mandantennummer“. |
| Mitarbeitende (plural); Mitarbeiterin, Mitarbeiter | MA                                      | „Person“ where the role does not matter.                                                                                     |
| Salon, Stammsalon                                  |                                         | The Stammsalon decides leave and holidays of a person.                                                                       |
| Springerin, Springer                               |                                         | A person who works in more than one salon.                                                                                   |
| Abwesenheiten                                      |                                         | The umbrella for leave, sickness, Berufsschule and other absences.                                                           |
| Urlaub                                             |                                         | Vacation only — not a synonym for Abwesenheiten.                                                                             |
| Arbeitszeitmodell, Vertrag                         | Schedule, Schedule-Version              | The four models: **Feste Arbeitszeit**, **Gleitzeit**, **Monatsstunden**, **Nach Schichtplan**.                              |
| Besetzung, Mindestbesetzung                        | Coverage                                |                                                                                                                              |
| Summe, gesamt                                      | Σ, Sigma                                |                                                                                                                              |
| Protokoll                                          | Audit & Log                             | The page of the audit trail.                                                                                                 |
| Aufgaben                                           | Inbox                                   | The one page where requests are decided.                                                                                     |
| Kritische Aktionen                                 | Danger Zone                             | The section of irreversible actions.                                                                                         |
| Eintrag, Antrag, Datensatz …                       | Entität                                 | Name the thing.                                                                                                              |
| Schichteinstellungen                               |                                         | The admin page `/admin/shifts` (templates, rules, patterns).                                                                 |
| Schichtplanung                                     |                                         | The team page `/shifts` (the weekly plan).                                                                                   |
| plain words                                        | enum values, error codes, env variables | Never `SHIFT_BASED`, `TRACK_ONLY`, `PAIRING_ENABLED` in a text.                                                              |
| Phorest                                            |                                         | Only in Verwaltung, Schichtplanung and the operator console — never in texts for Mitarbeitende.                              |
| say what is compared                               | Korrelation                             | „Geplant im Vergleich zum Soll“.                                                                                             |

Spelling: CSV-Import, DATEV-Export (hyphenated compounds), WLAN.

## 4. Page names

Every page has one name, defined once in `apps/web/src/lib/nav/page-labels.ts`. The sidebar, the
mobile „Mehr“ sheet, the quick search (⌘K), the breadcrumb in the top bar and the page's H1 all
read it — the H1 is the menu name. The mobile tab bar may use the short form „Zeit“ for
Zeiterfassung. The names are deliberately not repeated here: the module is the one source.

## 5. What the lint checks — and what it cannot

| Lint term id  | Glossary row                          |
| ------------- | ------------------------------------- |
| `tenant`      | Unternehmen                           |
| `mandant`     | Unternehmen (operator console exempt) |
| `ma`          | Mitarbeitende                         |
| `code-value`  | plain words                           |
| `danger-zone` | Kritische Aktionen                    |
| `coverage`    | Besetzung                             |
| `sigma`       | Summe                                 |
| `korrelation` | say what is compared                  |
| `entitaet`    | name the thing                        |
| `schedule`    | Arbeitszeitmodell                     |
| `inbox`       | Aufgaben                              |
| `phorest`     | Phorest (area-scoped)                 |
| `sie-form`    | Address form „du“                     |

Limits: the lint cannot tell the plural „Mitarbeiter“ from the singular, does not judge button
wording, and does not see texts that come from the API. Those are review questions.

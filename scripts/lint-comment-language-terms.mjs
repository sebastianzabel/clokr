/**
 * German domain-noun allowlist for lint-comment-language.mjs (Issue #131).
 *
 * These are legitimate German words that are allowed to appear inside English comment
 * prose — CLAUDE.md § Language Conventions names them explicitly: "German domain nouns
 * (…) stay untranslated when named inside English prose." Seeded from that list plus the
 * other domain terms named throughout CLAUDE.md (ArbZG/BUrlG sections, schedule types).
 *
 * This file exists so the allowlist can grow without touching the detector logic in
 * lint-comment-language.mjs — add a term here, not a special case there.
 *
 * IMPORTANT: the detector does NOT rely on this list to avoid false positives on domain
 * nouns in general — see the "why an allowlist at all" note in lint-comment-language.mjs.
 * It exists for the one real collision class: a domain noun whose lowercase form is
 * identical to an unrelated German function word (e.g. the noun "Ist" — Ist-Zeit, actual
 * value — collides with "ist", the verb "is"). The detector only excludes a match when
 * the source text is capitalized the way a German noun is (`Ist`, not `ist`), so genuine
 * prose ("das ist...") still counts.
 */

export const GERMAN_DOMAIN_TERMS = [
  // Named explicitly in CLAUDE.md § Language Conventions as terms that stay untranslated.
  "Monatsabschluss",
  "Zeitnachtrag",
  "Revisionssicherheit",
  "Betriebsurlaub",
  "Sonderurlaub",
  "ArbZG",
  "BUrlG",
  // Named throughout CLAUDE.md's ArbZG/BUrlG/Saldo/Schedule sections.
  "Saldo",
  "Soll",
  "Ist",
  "Feiertag",
  "Feiertage",
  "Urlaub",
  "Urlaubsstornierung",
  "Karenz",
  "Berufsschule",
  "Minijob",
  "Minijobber",
  "Jahresübertrag",
  "Arbeitszeitgesetz",
  "Vertragswechsel",
  "Schichtplanung",
  "Roster-Planung",
  "Betriebsurlaubs",
  "Stichtag",
  "Werktage",
  "Arbeitszeitnachweis",
  "Lohnkonten",
  "Buchungsbelege",
  "Aufbewahrungsfristen",
];

// Lowercased for case-insensitive lookup; the detector still checks original casing
// before treating a match as "this occurrence is the domain noun, not the stopword".
export const GERMAN_DOMAIN_TERMS_LOWER = new Set(
  GERMAN_DOMAIN_TERMS.map((term) => term.toLowerCase()),
);

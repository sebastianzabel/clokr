// Issue #855 (D-855-06) - the one place an HTTP error status becomes page text. The raw message of a
// failed load (`page.error.message`) is never shown: it can be English, internal or name an id.

export type ErrorAction = "home" | "back" | "reload";

export interface ErrorCopy {
  /** Document title, without the „ – Clokr“ suffix. */
  documentTitle: string;
  title: string;
  sentence: string;
  /** The secondary action next to the primary „Zur Startseite“. */
  secondary: Exclude<ErrorAction, "home">;
}

export function errorCopy(status: number): ErrorCopy {
  if (status === 404) {
    return {
      documentTitle: "Seite nicht gefunden",
      title: "Diese Seite gibt es nicht.",
      sentence:
        "Vielleicht hat sich die Adresse geändert. Über die Startseite findest du alles wieder.",
      secondary: "back",
    };
  }
  if (status === 401 || status === 403) {
    return {
      documentTitle: "Kein Zugriff",
      title: "Dafür fehlt dir die Berechtigung.",
      sentence:
        "Diese Seite ist für deine Rolle nicht freigegeben. Über die Startseite kommst du zu deinen Bereichen.",
      secondary: "back",
    };
  }
  return {
    documentTitle: "Fehler",
    title: "Da ist etwas schiefgelaufen.",
    sentence: "Der Fehler wurde protokolliert. Lade die Seite neu oder geh zur Startseite.",
    secondary: "reload",
  };
}

export const SECONDARY_LABELS: Record<ErrorCopy["secondary"], string> = {
  back: "Zurück",
  reload: "Seite neu laden",
};

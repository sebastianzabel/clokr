// Phase 82 (UI-V19-07) — German UI label for WorkEventSource.
//
// Single source of truth for the BS list-row "Quelle" column copy
// across /time-entries, /team/time-entries, and (future) any consumer
// that surfaces WorkEvent source provenance.
//
// The exhaustive switch with `never` default guarantees that adding a
// 4th WorkEventSource value to @clokr/types triggers a TypeScript
// compile error here — forces an explicit copy decision.
import type { WorkEventSource } from "@clokr/types";

export function bsSourceLabel(source: WorkEventSource): string {
  switch (source) {
    case "PATTERN":
      return "Automatisch (Muster)";
    case "AUTO":
      return "Automatisch";
    case "MANUAL":
      return "Manuell eingefügt";
    default: {
      // Exhaustiveness check — adding a new WorkEventSource value
      // breaks the build here until a German label is chosen.
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

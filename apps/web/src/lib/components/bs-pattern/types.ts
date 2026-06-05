// Phase 76-03 — BSPatternPicker shared types.
//
// Types live in a sibling .ts file (not the .svelte module block) because
// Svelte 5's ambient `*.svelte` module declaration only exposes the default
// export to tsc — named module-block exports work at runtime via Vite but
// aren't visible to tsc / IDE Go-To-Definition. Keeping the types here lets
// both the .svelte component and the test file import them without ambient
// shim drift.

export type BSPatternMode = "weekly" | "block";

export interface BSPatternDraft {
  mode: BSPatternMode;
  /** [0..6] (Sun=0..Sat=6). MUST be non-empty in weekly mode. */
  workDays: number[];
  /** MUST be null in weekly mode (auto-cleared on mode switch). */
  blockYear?: number | null;
}

export interface BSPatternPickerProps {
  draft: BSPatternDraft;
  onChange: (next: BSPatternDraft) => void;
}

// Issue #843 / #853 - the tone vocabulary of the status chip. It lives in a plain `.ts` module so that
// non-component code (the Personen model) can name the type: `tsc` sees a `*.svelte` import only as a
// default export, never as a named type. `Chip.svelte` re-exports it for the components.
export type ChipTone = "ok" | "warn" | "bad" | "info" | "brand" | "neutral";

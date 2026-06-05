// Shared component-test helper for Phase 76 (D-06).
//
// Why: every Clokr component is theme-aware via CSS custom properties
// (var(--brand), var(--bg-card), etc.) defined under `[data-theme="..."]`
// scope in apps/web/src/tokens.css. If we mount a component into a bare
// jsdom <body> with NO data-theme ancestor, computed styles fall back to
// the :root default (which is "pflaume" today but could drift). To catch
// token regressions early, every component test renders the SUT inside a
// `<div data-theme="pflaume">` wrapper.
//
// Usage:
//   import { renderWithTheme } from "$tests/test-utils";
//   const { container } = renderWithTheme(MyComponent, { foo: "bar" });
//
// Override theme for theme-specific regression tests:
//   renderWithTheme(MyComponent, props, "nacht");
//
// Typing: we forward through to @testing-library/svelte's `render` and re-use
// its first-arg type so component-import variants (default + named exports)
// flow through correctly. The helper takes the component and a `props` object
// as positional args (sugar over render's options-object form) so test bodies
// stay short.

import { render } from "@testing-library/svelte";

type RenderFirstArg = Parameters<typeof render>[0];
type RenderOptions = Parameters<typeof render>[1];

export type Theme = "pflaume" | "nacht" | "wald" | "schiefer";

/**
 * Render a Svelte 5 component with a `data-theme` attribute applied to
 * `document.body`. Forwards through to `@testing-library/svelte`'s render —
 * returns the full RenderResult so callers can use `container`, `getByText`,
 * `getByRole`, etc.
 */
export function renderWithTheme(
  component: RenderFirstArg,
  props: NonNullable<RenderOptions>,
  theme: Theme = "pflaume",
): ReturnType<typeof render> {
  // Set data-theme on document.body BEFORE the render call. @testing-library/svelte
  // mounts the component into document.body by default, so setting the attribute
  // here propagates to every descendant element via CSS cascade.
  document.body.setAttribute("data-theme", theme);
  return render(component, { props } as RenderOptions);
}

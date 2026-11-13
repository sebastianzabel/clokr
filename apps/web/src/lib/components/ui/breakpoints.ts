// Issue #843 (D-843-03) - the two ONLY container breakpoints of the design-system blocks.
//
// CSS container conditions cannot read custom properties, so the blocks spell `760px` / `1100px`
// in their own `@container` rules and a test (843-28) pins every spelling to these constants.
// Below CONTAINER_NARROW_PX a block lays itself out for a phone (cards instead of table rows, a
// bottom sheet instead of a centred dialog); from CONTAINER_WIDE_PX on it may use the wide layout.
// The only viewport media queries a block may use are the Dialog sheet switch and
// `prefers-reduced-motion`.

/** Container width below which a block switches to its narrow (phone) layout. */
export const CONTAINER_NARROW_PX = 760;

/** Container width from which a block may use its wide layout. */
export const CONTAINER_WIDE_PX = 1100;

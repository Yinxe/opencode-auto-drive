/**
 * Minimal JSX runtime stub for @opentui/solid.
 * Used only when testing tui.jsx in isolation (the real package is host-provided).
 */

export function jsx(type, props, key) {
  return { type, props, key }
}

export function jsxs(type, props, key) {
  return { type, props, key }
}

export const Fragment = "Fragment"

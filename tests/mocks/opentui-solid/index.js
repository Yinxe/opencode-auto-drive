/**
 * Entry point for @opentui/solid mock.
 * Re-exports the JSX runtime so both `import { Fragment } from "@opentui/solid"`
 * and `import { jsx } from "@opentui/solid/jsx-runtime"` resolve correctly.
 */
export { jsx, jsxs, Fragment } from "./jsx-runtime.js"

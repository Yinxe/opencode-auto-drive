import { defineConfig } from "vitest/config"
import { resolve } from "path"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.js"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["loadConfig.js", "tui-utils.js"],
    },
  },
  resolve: {
    alias: {
      // @opentui/solid is host-provided by OpenCode, not in node_modules.
      // This alias makes the import resolve to our test stub during vitest runs.
      "@opentui/solid": resolve(__dirname, "tests/mocks/opentui-solid"),
    },
  },
})

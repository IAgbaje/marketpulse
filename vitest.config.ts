import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Only Dexie-backed tests (tests/capture/durability.test.ts) need
    // IndexedDB; everyone else ignores an unused global.
    setupFiles: ["fake-indexeddb/auto"],
  },
});

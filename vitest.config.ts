import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/.worktrees/**", "**/work/**", "**/dist/**", "**/node_modules/**"]
  }
});

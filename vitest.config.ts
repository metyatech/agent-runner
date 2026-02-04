import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/.worktrees/**", "**/dist/**", "**/node_modules/**"]
  }
});


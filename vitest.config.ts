import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/.worktrees/**", "**/work/**", "**/dist/**", "**/node_modules/**"],
    server: {
      deps: {
        inline: ["@metyatech/ai-quota"]
      }
    }
  }
});

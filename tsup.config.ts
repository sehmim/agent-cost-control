import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/ai.ts", "src/langchain.ts", "src/agents.ts"],
  format: ["esm", "cjs"],
  outExtension: ({ format }) => ({ js: format === "esm" ? ".mjs" : ".cjs" }),
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});

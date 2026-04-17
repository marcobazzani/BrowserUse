import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
  target: "node20",
  noExternal: [/.*/],
  banner: { js: "#!/usr/bin/env node" },
});

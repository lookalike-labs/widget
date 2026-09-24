import { defineConfig } from "tsdown"

// ESM/CommonJS modules and declarations, plus a standalone script loader.
export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      element: "src/element.ts",
      protocol: "src/protocol.ts",
      tools: "src/tools.ts",
      drag: "src/drag.ts",
      react: "src/react/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
    target: "es2022",
    deps: { neverBundle: ["react", "react-dom"] },
    outExtensions: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  },
  {
    entry: { loader: "src/loader.ts" },
    format: ["iife"],
    platform: "browser",
    deps: { alwaysBundle: ["@cfworker/json-schema"] },
    target: "es2020",
    minify: true,
    sourcemap: true,
    clean: false,
    // tsdown unconditionally infixes `.iife` into the filename; pin the exact
    // name the package.json `unpkg`/`jsdelivr` fields point at.
    outputOptions: { entryFileNames: "loader.global.js" },
  },
])

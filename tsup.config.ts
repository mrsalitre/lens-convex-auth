import { defineConfig, type Options } from "tsup"

const shared: Options = {
  format: ["esm"],
  dts: true,
  sourcemap: true,
  target: "es2022",
  outDir: "dist",
}

export default defineConfig([
  {
    ...shared,
    // Built together so they share one copy of the core (the React components take the `auth` object
    // created with the main entry). Browser-only code, so Next.js treats it as client code, which also
    // lets Server Components render <LensAuthProvider> and <SignInButton>.
    entry: { index: "src/core/index.ts", "react/index": "src/react/index.ts" },
    banner: { js: '"use client";' },
  },
  {
    ...shared,
    entry: { "server/index": "src/server/index.ts", "convex/index": "src/convex/index.ts" },
  },
  {
    ...shared,
    dts: false,
    entry: { "cli/index": "src/cli/index.ts" },
    banner: { js: "#!/usr/bin/env node" },
  },
])

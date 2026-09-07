import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev aliases the package NAME to its source for instant HMR; CI builds prove
// the same import works against the published surface (package-spec pin).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@dcl-regenesislabs/wearable-validator": resolve(import.meta.dirname, "../../packages/wearable-validator/src/index.ts")
    }
  },
  server: {
    fs: { allow: [resolve(import.meta.dirname, "../..")] }
  }
});

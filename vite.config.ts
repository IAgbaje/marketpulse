import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      manifest: {
        name: "MarketPulse",
        short_name: "MarketPulse",
        description: "Track what you pay at the market, and see what changed.",
        theme_color: "#0f172a",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
      },
      workbox: {
        // Offline shell only. Offline *data* is Dexie's job — see src/lib/db.ts.
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
      },
    }),
  ],
  build: {
    // §12's budget is <300KB gzipped on the initial route. Warn well before
    // that so it is caught in CI rather than discovered on a real device.
    chunkSizeWarningLimit: 300,
  },
});

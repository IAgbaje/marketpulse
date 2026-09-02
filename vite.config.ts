import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg", "favicon-32.png", "apple-touch-icon.png"],
      manifest: {
        name: "MarketPulse",
        short_name: "MarketPulse",
        description: "Track what you pay at the market, and see what changed.",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        // Offline shell only. Offline *data* is Dexie's job — see src/lib/db.ts.
        globPatterns: ["**/*.{js,css,html,svg,woff2,png}"],
        navigateFallback: "/index.html",
        // Supabase calls must always hit the network — never serve a cached
        // API response as if it were live crowd/auth data.
        navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//, /^\/functions\//],
      },
    }),
  ],
  build: {
    // §12's budget is <300KB gzipped on the initial route. Warn well before
    // that so it is caught in CI rather than discovered on a real device.
    chunkSizeWarningLimit: 300,
  },
});

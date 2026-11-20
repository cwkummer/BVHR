/**
 * Vite build and development server configuration for the RPG client.
 * Configures React and Tailwind CSS v4 plugins and proxies /api and WebSocket /ws traffic
 * to the local Wrangler Worker instance (http://localhost:8787) during local development.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Keep React in its own long-lived chunk so app-only changes do not re-download it. PixiJS is
        // deliberately NOT named here: it must stay bundled with the lazy-loaded canvas (naming it pulls
        // Vite's shared dynamic-import helper into that chunk and makes the entry bundle preload all of Pixi).
        manualChunks(id) {
          if (id.includes("/node_modules/react-dom/") || id.includes("/node_modules/react/") || id.includes("/node_modules/scheduler/")) {
            return "react";
          }
          return undefined;
        }
      }
    }
  },
  server: {
    proxy: {
      // Forward REST/RPC API requests to the local Cloudflare Worker dev server
      "/api": "http://localhost:8787",
      // Forward WebSocket room connections with upgrade support to the Worker entry point
      "/ws": {
        target: "ws://localhost:8787",
        ws: true
      }
    }
  }
});

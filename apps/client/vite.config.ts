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

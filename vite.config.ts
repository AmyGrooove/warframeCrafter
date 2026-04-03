import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/warframe-market": {
        target: "https://api.warframe.market",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/warframe-market/, ""),
      },
    },
  },
});

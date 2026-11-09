import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // Tailwind is a token pipeline only (Issue #843, D-843-13); it runs before sveltekit().
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
});

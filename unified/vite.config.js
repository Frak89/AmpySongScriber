import { defineConfig } from "vite";
export default defineConfig({base:'./', build:{target:'es2020', chunkSizeWarningLimit:2500}, server:{host:'127.0.0.1'}});

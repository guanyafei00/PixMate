import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev server port and disables clearing the screen
// so logs from Rust stay visible.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 相对路径：Electron 以 file:// 加载 dist 时资源才能正确定位（对 Tauri 同样兼容）
  base: "./",
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: { protocol: "ws", host: "localhost", port: 1421 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
});

// Vite 配置：两个渲染入口（设置面板、提醒窗），产物落 dist-renderer/
// 用相对 base，Electron 以 file:// 加载也不会白屏。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: r('./dist-renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        panel: r('./renderer/panel/index.html'),
        popup: r('./renderer/popup/index.html')
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    // 允许读取工程根下的 assets/（图标等静态资源在 renderer/ 之外）
    fs: { allow: [r('./'), r('./assets')] }
  }
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // ส่งต่อ /api ไปที่ backend เพื่อให้ cookie อยู่ origin เดียวกัน (ไม่ต้องตั้ง CORS)
    proxy: { '/api': 'http://localhost:4000' },
  },
  build: {
    chunkSizeWarningLimit: 1200,
  },
});

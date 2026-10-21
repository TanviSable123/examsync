import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // The API listens on IPv4; pin the proxy to IPv4 too, since Windows
      // localhost may resolve to ::1 and send requests to the wrong listener.
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT || 4000}`,
        changeOrigin: true
      }
    }
  }
});

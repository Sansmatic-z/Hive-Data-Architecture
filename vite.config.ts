import path from 'path';
import fs from 'fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version?: string };
    const buildMetadata = {
      version: packageJson.version ?? '0.0.0',
      protocol: '4.0',
      commit: env.VITE_GIT_SHA || process.env.GITHUB_SHA || 'dev',
      buildTime: new Date().toISOString(),
    };
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react(), tailwindcss()],
      worker: {
        format: 'es',
      },
      build: {
        chunkSizeWarningLimit: 700,
        rollupOptions: {
          output: {
            manualChunks(id) {
              if (!id.includes('node_modules')) {
                return undefined;
              }
              if (id.includes('react') || id.includes('scheduler')) {
                return 'react-vendor';
              }
              if (id.includes('motion')) {
                return 'motion-vendor';
              }
              if (id.includes('lucide-react')) {
                return 'icons-vendor';
              }
              if (id.includes('zod') || id.includes('hash-wasm') || id.includes('fflate')) {
                return 'protocol-vendor';
              }
              return 'vendor';
            },
          },
        },
      },
      define: {
        __APP_BUILD_METADATA__: JSON.stringify(buildMetadata),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});

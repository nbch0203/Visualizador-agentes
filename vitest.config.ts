import { defineConfig } from 'vitest/config';

// Separado de vite.config.ts (cuya raíz es web/) para que encuentre test/.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});

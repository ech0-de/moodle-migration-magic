import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  base: '/moodle-migration-magic/',
  plugins: [ nodePolyfills() ]
});

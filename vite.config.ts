import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// On Windows the same folder can show up as "c:\..." or "C:\..." depending on how the terminal was opened.
// If the bundler sees both spellings it loads React twice and the site crashes, so pin one spelling.
const here = realpathSync.native(fileURLToPath(new URL('.', import.meta.url)));
const src = realpathSync.native(fileURLToPath(new URL('./src', import.meta.url)));

export default defineConfig({
  root: here,
  // Relative asset paths so the built site works from any folder (GitHub Pages, Netlify, a USB stick...).
  base: './',
  plugins: [react()],
  resolve: { alias: { '@': src } },
});

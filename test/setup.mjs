// Lets `node --test` load app code: maps the "@/..." alias to src/ and resolves extensionless .ts imports.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

registerHooks({
  resolve(specifier, context, next) {
    let target = null;
    if (specifier.startsWith('@/')) target = path.join(src, specifier.slice(2));
    else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
      target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    }
    if (target && !path.extname(target)) {
      for (const ext of ['.ts', '.tsx']) {
        if (existsSync(target + ext)) return next(pathToFileURL(target + ext).href, context);
      }
    }
    if (target && specifier.startsWith('@/')) return next(pathToFileURL(target).href, context);
    return next(specifier, context);
  },
});

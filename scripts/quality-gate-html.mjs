#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(scriptDir, '..', 'packs', 'design', 'scripts', 'quality-gate-html.mjs');

await import(pathToFileURL(target).href);
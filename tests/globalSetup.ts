// Runs once before the test files, which run in parallel and would otherwise break each other on a fresh
// CI runner:
// - several of them use the generated test media, and two generators writing test-media/ at once clash;
// - Electron 44 downloads its binary the first time its package is loaded (node_modules/electron/
//   index.js), and test files that load it at the same time unpack it over each other.
import { createRequire } from 'node:module'
import { ensureTestMedia } from './helpers/media'

export default function setup(): void {
  createRequire(import.meta.url)('electron')
  ensureTestMedia()
}

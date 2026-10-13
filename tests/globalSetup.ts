// Runs once before the test files, which run in parallel: several of them use the generated test
// media, and two generators writing test-media/ at the same time break each other (a fresh CI runner).
import { ensureTestMedia } from './helpers/media'

export default function setup(): void {
  ensureTestMedia()
}

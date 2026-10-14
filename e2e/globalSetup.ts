// Runs once before the workers start: the specs run in parallel and share test-media/, and two of them
// generating it at the same time (a fresh checkout or runner) would break each other.
import { ensureTestMedia } from './harness'

export default function globalSetup(): void {
  ensureTestMedia()
}

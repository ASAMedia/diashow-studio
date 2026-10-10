// What Electron starts in the e2e specs: the project (out/, via package.json) or another build
// output, e.g. DIASHOW_MAIN=out-b/main/index.js, so parallel builds don't overwrite each other.
export const appArgs = (): string[] => [process.env.DIASHOW_MAIN ?? '.']

/** Launch options for the app with its data in `dataDir`; DIASHOW_EXE runs a packaged build instead. */
export function launchOptions(root: string, dataDir: string): { executablePath?: string; args?: string[]; cwd?: string; env: Record<string, string> } {
  const env = { ...(process.env as Record<string, string>), DIASHOW_DATA_DIR: dataDir }
  const exe = process.env.DIASHOW_EXE
  return exe ? { executablePath: exe, env } : { args: appArgs(), cwd: root, env }
}

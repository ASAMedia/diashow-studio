// What Electron starts in the e2e specs: the project (out/, via package.json) or another build
// output, e.g. DIASHOW_MAIN=out-b/main/index.js, so parallel builds don't overwrite each other.
export const appArgs = (): string[] => [process.env.DIASHOW_MAIN ?? '.']

/** Launch options for the app with its data in `dataDir`; DIASHOW_EXE runs a packaged build instead. */
export function launchOptions(root: string, dataDir: string): { executablePath?: string; args?: string[]; cwd?: string; env: Record<string, string> } {
  const env = { ...(process.env as Record<string, string>), DIASHOW_DATA_DIR: dataDir }
  const exe = process.env.DIASHOW_EXE
  return exe ? { executablePath: exe, env } : { args: appArgs(), cwd: root, env }
}

/**
 * Without a GPU (CI: DIASHOW_SOFTWARE_GL), WebGL runs on SwiftShader and every exported frame
 * is slow, so exports in the specs are smaller there.
 */
export const SOFTWARE_GL = !!process.env.DIASHOW_SOFTWARE_GL
export const EXPORT_SIZE = SOFTWARE_GL ? { width: 320, height: 180 } : { width: 1280, height: 720 }

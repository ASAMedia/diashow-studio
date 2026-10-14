// What Electron starts in the e2e specs: the project (out/, via package.json) or another build
// output, e.g. DIASHOW_MAIN=out-b/main/index.js, so parallel builds don't overwrite each other.
//
// Chromium slows down the renderer of a window it takes for hidden (lower priority, Windows' efficiency
// mode), and a window covered by others counts as hidden: tests running at the same time cover each
// other's windows. Measured: three tests at once each took two to four times as long as alone, with
// these switches about as long as alone. They keep every window as fast as one in front, as Playwright
// does for its own browsers (and a run alone no longer depends on what else is on the screen).
const SWITCHES = ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion']
// DIASHOW_E2E_ARGS adds Chromium switches, e.g. "--disable-gpu": with DIASHOW_SOFTWARE_GL=1, WebGL then
// runs on SwiftShader as on GitHub's runner (without it, a PC's graphics card still renders).
const switches = (): string[] => [...SWITCHES, ...(process.env.DIASHOW_E2E_ARGS ?? '').split(/\s+/).filter(Boolean)]
export const appArgs = (): string[] => [process.env.DIASHOW_MAIN ?? '.', ...switches()]

/** Launch options for the app with its data in `dataDir`; DIASHOW_EXE runs a packaged build instead. */
export function launchOptions(root: string, dataDir: string): { executablePath?: string; args?: string[]; cwd?: string; env: Record<string, string> } {
  const env = { ...(process.env as Record<string, string>), DIASHOW_DATA_DIR: dataDir }
  const exe = process.env.DIASHOW_EXE
  return exe ? { executablePath: exe, args: switches(), env } : { args: appArgs(), cwd: root, env }
}

/**
 * Without a GPU (CI: DIASHOW_SOFTWARE_GL), WebGL runs on SwiftShader and every exported frame
 * is slow, so exports in the specs are smaller there.
 */
export const SOFTWARE_GL = !!process.env.DIASHOW_SOFTWARE_GL
export const EXPORT_SIZE = SOFTWARE_GL ? { width: 320, height: 180 } : { width: 1280, height: 720 }

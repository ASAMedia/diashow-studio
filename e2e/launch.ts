// What Electron starts in the e2e specs: the project (out/, via package.json) or another build
// output, e.g. DIASHOW_MAIN=out-b/main/index.js, so parallel builds don't overwrite each other.
export const appArgs = (): string[] => [process.env.DIASHOW_MAIN ?? '.']

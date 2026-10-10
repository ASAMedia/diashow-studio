// The app icon for the windows (title bar, taskbar, Alt+Tab). The packaged exe carries the same icon
// (electron-builder.yml); this path also covers development runs, where the exe is electron.exe.
// build/icon.ico is made by scripts/make-icon.mjs; `?asset` copies it next to the built main process.
import icon from '../../build/icon.ico?asset'

export const APP_ICON: string = icon

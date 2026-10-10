// electron-vite copies `?asset` imports next to the built main process and gives their path.
declare module '*?asset' {
  const path: string
  export default path
}

// Vite's ?raw imports: the handbook chapters are bundled as text.
declare module '*.md?raw' {
  const text: string
  export default text
}

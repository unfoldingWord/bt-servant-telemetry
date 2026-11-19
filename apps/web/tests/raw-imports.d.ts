// Vite (used by vitest) resolves `?raw` imports to the file's text content.
declare module '*?raw' {
  const content: string;
  export default content;
}

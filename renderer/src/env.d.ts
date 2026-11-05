/**
 * Vite import forms that have no ambient types in this tree. Declared once here so any
 * renderer entry can use them without pulling the whole vite/client package into scope.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}

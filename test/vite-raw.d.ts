// Vite ?raw import 的型別宣告（vitest-plugin 用 Vite transform，支援 ?raw；tsc 需宣告）
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

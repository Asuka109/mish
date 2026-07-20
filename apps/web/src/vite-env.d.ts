/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MISH_BUILD_TARGET?: "desktop" | "mobile";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

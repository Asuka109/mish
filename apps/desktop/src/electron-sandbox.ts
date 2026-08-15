/**
 * Sandboxed Electron 43 preloads are evaluated as plain JavaScript. The
 * authored boundary remains ESM, while this one narrow adapter uses Electron's
 * documented sandbox `require` bridge so the emitted `.mjs` has no imports or
 * shared chunks to resolve in the isolated context.
 */
declare const require: (name: "electron") => typeof import("electron");

// Electron 43 provides this limited direct require bridge when sandboxed. The
// preload build marks this package external so Rollup leaves this call intact.
const electron = require("electron");

export const { contextBridge, ipcRenderer } = electron;

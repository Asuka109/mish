import { contextBridge, ipcRenderer } from "electron";

import { IPC_CHANNELS, type LifecycleEvent, type LifecycleRecord, type ShellInfo } from "./ipc";

export type MishElectronApi = {
  getShellInfo(): Promise<ShellInfo>;
  recordLifecycle(event: LifecycleEvent): Promise<LifecycleRecord>;
};

const api: MishElectronApi = Object.freeze({
  getShellInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getShellInfo, {}),
  recordLifecycle: (event) => ipcRenderer.invoke(IPC_CHANNELS.recordLifecycle, { event }),
});

contextBridge.exposeInMainWorld("mishElectron", api);

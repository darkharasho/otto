import { contextBridge, ipcRenderer } from 'electron';
import {
  SESSION_EVENT_CHANNEL,
  type IpcChannel,
  type IpcRequest,
  type OttoBridge,
  type SessionEvent,
} from '@shared/ipc-contract';

const bridge: OttoBridge = {
  invoke: (<C extends IpcChannel>(
    channel: C,
    args: Extract<IpcRequest, { channel: C }>['args']
  ) =>
    ipcRenderer.invoke(channel, args) as Promise<
      Extract<IpcRequest, { channel: C }>['result']
    >) as OttoBridge['invoke'],
  onSessionEvent(handler) {
    const listener = (_e: Electron.IpcRendererEvent, payload: SessionEvent) => handler(payload);
    ipcRenderer.on(SESSION_EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(SESSION_EVENT_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld('otto', bridge);

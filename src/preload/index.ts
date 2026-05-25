import { contextBridge, ipcRenderer } from 'electron';
import {
  AUTONOMY_EVENT_CHANNEL,
  SESSION_EVENT_CHANNEL,
  UPDATER_EVENT_CHANNEL,
  type AutonomyEvent,
  type IpcChannel,
  type IpcRequest,
  type OttoBridge,
  type PairedDeviceSummary,
  type PairingCodePayload,
  type RemoteCeilingChoice,
  type RemoteStatus,
  type SessionEvent,
  type UpdaterState,
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
  onAutonomyEvent(handler) {
    const listener = (_e: Electron.IpcRendererEvent, payload: AutonomyEvent) => handler(payload);
    ipcRenderer.on(AUTONOMY_EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(AUTONOMY_EVENT_CHANNEL, listener);
  },
  updater: {
    status: () => ipcRenderer.invoke('updater:status') as Promise<UpdaterState>,
    check: () => ipcRenderer.invoke('updater:check') as Promise<UpdaterState>,
    download: () => ipcRenderer.invoke('updater:download') as Promise<UpdaterState>,
    install: () => ipcRenderer.invoke('updater:install') as Promise<void>,
    onStateChange(cb: (state: UpdaterState) => void) {
      const listener = (_e: Electron.IpcRendererEvent, state: UpdaterState) => cb(state);
      ipcRenderer.on(UPDATER_EVENT_CHANNEL, listener);
      return () => ipcRenderer.removeListener(UPDATER_EVENT_CHANNEL, listener);
    },
  },
  remote: {
    getStatus: () => ipcRenderer.invoke('remote:getStatus') as Promise<RemoteStatus>,
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke('remote:setEnabled', { enabled }) as Promise<void>,
    setRemoteCeiling: (ceiling: RemoteCeilingChoice) =>
      ipcRenderer.invoke('remote:setRemoteCeiling', { ceiling }) as Promise<void>,
    mintPairingCode: () =>
      ipcRenderer.invoke('remote:mintPairingCode') as Promise<PairingCodePayload>,
    listDevices: () =>
      ipcRenderer.invoke('remote:listDevices') as Promise<PairedDeviceSummary[]>,
    revokeDevice: (deviceId: string) =>
      ipcRenderer.invoke('remote:revokeDevice', { deviceId }) as Promise<void>,
  },
};

contextBridge.exposeInMainWorld('otto', bridge);

import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi } from './shared/types';

function on<T>(channel: string) {
  return (cb: (e: T) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

/** Payload-less variant for signal channels. */
function onSignal(channel: string) {
  return (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

const api: RendererApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  startSession: () => ipcRenderer.invoke('session:start'),
  sendAudio: (sessionId, pcm) => ipcRenderer.send('audio:chunk', sessionId, pcm),
  stopSession: (sessionId) => ipcRenderer.invoke('session:stop', sessionId),
  cancelSession: (sessionId) => ipcRenderer.invoke('session:cancel', sessionId),
  onSttPartial: on('stt:partial'),
  onLlmDelta: on('llm:delta'),
  onLlmDone: on('llm:done'),
  onSessionError: on('session:error'),
  onHotkeyToggle: onSignal('hotkey:toggle'),
};

contextBridge.exposeInMainWorld('api', api);

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程与主进程之间唯一的通道。
 * contextIsolation 打开，渲染进程拿不到 Node，只能调用这里列出的方法。
 */
contextBridge.exposeInMainWorld('clip', {
  /* 历史 */
  query: (term) => ipcRenderer.invoke('items:query', term),
  count: () => ipcRenderer.invoke('items:count'),
  use: (id, options) => ipcRenderer.invoke('item:use', id, options),
  remove: (id) => ipcRenderer.invoke('item:delete', id),
  pin: (id) => ipcRenderer.invoke('item:pin', id),
  text: (id) => ipcRenderer.invoke('item:text', id),
  clear: (keepPinned) => ipcRenderer.invoke('items:clear', keepPinned),

  /* 配置 */
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  probeHotkey: (accelerator) => ipcRenderer.invoke('hotkey:probe', accelerator),

  /* 窗口与应用 */
  hidePanel: () => ipcRenderer.invoke('panel:hide'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  revealDataDir: () => ipcRenderer.invoke('app:reveal-data'),
  quit: () => ipcRenderer.invoke('app:quit'),

  /* 主进程推送 */
  onChanged: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('items:changed', listener);
    return () => ipcRenderer.removeListener('items:changed', listener);
  },
  onPanelShown: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('panel:shown', listener);
    return () => ipcRenderer.removeListener('panel:shown', listener);
  },
  onPanelHidden: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('panel:hidden', listener);
    return () => ipcRenderer.removeListener('panel:hidden', listener);
  },
});

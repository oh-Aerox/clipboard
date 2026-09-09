'use strict';

const { globalShortcut } = require('electron');

const MODIFIERS = ['CommandOrControl', 'Command', 'Control', 'Ctrl', 'Cmd', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta'];

/**
 * 粗校验加速键字符串：Electron 遇到非法加速键会直接抛异常，
 * 先自查一遍可以给出更友好的提示。
 * 全局快捷键强制要求至少一个修饰键——单个字母键会把该键在所有程序里吃掉。
 */
function isValidAccelerator(accelerator) {
  if (typeof accelerator !== 'string' || !accelerator.trim()) return false;
  const parts = accelerator.split('+').map((p) => p.trim());
  if (parts.some((p) => !p)) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!mods.length) return false;
  if (!mods.every((m) => MODIFIERS.includes(m))) return false;
  if (MODIFIERS.includes(key)) return false;
  return key.length > 0;
}

class HotkeyManager {
  constructor() {
    /** @type {Record<string, string>} 已生效的快捷键，name -> accelerator */
    this.active = {};
  }

  /**
   * 按配置重新注册全部全局快捷键。
   * @param {Record<string,string>} hotkeys name -> accelerator（空字符串表示不绑定）
   * @param {Record<string,Function>} handlers name -> 回调
   * @returns {{active: Record<string,string>, failed: Array<{name:string, accelerator:string, reason:string}>}}
   */
  apply(hotkeys, handlers) {
    globalShortcut.unregisterAll();
    this.active = {};
    const failed = [];

    for (const [name, accelerator] of Object.entries(hotkeys || {})) {
      if (!accelerator) continue;
      const handler = handlers[name];
      if (!handler) continue;

      if (!isValidAccelerator(accelerator)) {
        failed.push({ name, accelerator, reason: '快捷键格式不合法' });
        continue;
      }
      try {
        const ok = globalShortcut.register(accelerator, handler);
        if (ok) this.active[name] = accelerator;
        else failed.push({ name, accelerator, reason: '已被其它程序占用' });
      } catch (err) {
        failed.push({ name, accelerator, reason: err.message });
      }
    }
    return { active: { ...this.active }, failed };
  }

  /** 试注册一次再立刻释放，用于设置界面校验用户录入的快捷键是否可用 */
  probe(accelerator) {
    if (!isValidAccelerator(accelerator)) {
      return { ok: false, reason: '快捷键格式不合法，需要至少一个修饰键（如 Ctrl / Alt / Shift）' };
    }
    if (Object.values(this.active).includes(accelerator)) {
      return { ok: true, reason: '' };
    }
    try {
      if (globalShortcut.isRegistered(accelerator)) {
        return { ok: false, reason: '该快捷键已被占用' };
      }
      const ok = globalShortcut.register(accelerator, () => {});
      if (!ok) return { ok: false, reason: '该快捷键已被其它程序占用' };
      globalShortcut.unregister(accelerator);
      return { ok: true, reason: '' };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  releaseAll() {
    globalShortcut.unregisterAll();
    this.active = {};
  }
}

module.exports = { HotkeyManager, isValidAccelerator };

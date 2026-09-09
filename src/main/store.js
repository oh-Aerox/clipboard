'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_CONFIG = {
  /** 历史记录保留条数上限，超出后丢弃最旧的（置顶项不计入丢弃） */
  maxItems: 50,
  /** 全局快捷键 */
  hotkeys: {
    toggle: 'Ctrl+Shift+V',
    clear: '',
  },
  /** 选中条目后自动向前台窗口发送 Ctrl+V */
  autoPaste: true,
  /** 面板失去焦点时自动隐藏 */
  hideOnBlur: true,
  /** 底部面板高度（像素） */
  panelHeight: 240,
  /** 剪贴板轮询间隔（毫秒） */
  pollInterval: 600,
  /** 是否记录图片类型的剪贴板内容 */
  captureImages: true,
  /** 超过该长度的文本不记录，避免超大内容拖慢应用 */
  maxTextLength: 200000,
  /** 开机自启 */
  launchAtLogin: false,
};

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 只接受已知字段，并把数值裁剪到合法区间，避免坏配置让应用起不来 */
function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const hotkeys = input.hotkeys && typeof input.hotkeys === 'object' ? input.hotkeys : {};
  return {
    maxItems: clampInt(input.maxItems, 5, 1000, DEFAULT_CONFIG.maxItems),
    hotkeys: {
      toggle: typeof hotkeys.toggle === 'string' ? hotkeys.toggle : DEFAULT_CONFIG.hotkeys.toggle,
      clear: typeof hotkeys.clear === 'string' ? hotkeys.clear : DEFAULT_CONFIG.hotkeys.clear,
    },
    autoPaste: typeof input.autoPaste === 'boolean' ? input.autoPaste : DEFAULT_CONFIG.autoPaste,
    hideOnBlur: typeof input.hideOnBlur === 'boolean' ? input.hideOnBlur : DEFAULT_CONFIG.hideOnBlur,
    panelHeight: clampInt(input.panelHeight, 160, 600, DEFAULT_CONFIG.panelHeight),
    pollInterval: clampInt(input.pollInterval, 200, 5000, DEFAULT_CONFIG.pollInterval),
    captureImages:
      typeof input.captureImages === 'boolean' ? input.captureImages : DEFAULT_CONFIG.captureImages,
    maxTextLength: clampInt(input.maxTextLength, 1000, 5000000, DEFAULT_CONFIG.maxTextLength),
    launchAtLogin:
      typeof input.launchAtLogin === 'boolean' ? input.launchAtLogin : DEFAULT_CONFIG.launchAtLogin,
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 先写临时文件再改名，避免进程被杀时留下半个文件 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor(baseDir) {
    this.baseDir = baseDir || app.getPath('userData');
    this.imageDir = path.join(this.baseDir, 'images');
    this.configFile = path.join(this.baseDir, 'config.json');
    this.historyFile = path.join(this.baseDir, 'history.json');

    fs.mkdirSync(this.imageDir, { recursive: true });

    this.config = normalizeConfig(readJson(this.configFile, DEFAULT_CONFIG));
    const history = readJson(this.historyFile, []);
    this.history = Array.isArray(history) ? history.filter((it) => this._isValidItem(it)) : [];

    this._saveTimer = null;
    this.trim();
  }

  _isValidItem(item) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') return false;
    if (item.type === 'text') return typeof item.text === 'string' && item.text.length > 0;
    if (item.type === 'image') return typeof item.file === 'string' && fs.existsSync(item.file);
    return false;
  }

  /* ---------------- config ---------------- */

  getConfig() {
    return JSON.parse(JSON.stringify(this.config));
  }

  setConfig(patch) {
    this.config = normalizeConfig({ ...this.config, ...(patch || {}) });
    writeJsonAtomic(this.configFile, this.config);
    this.trim();
    return this.getConfig();
  }

  /* ---------------- history ---------------- */

  getHistory() {
    return this.history;
  }

  /**
   * 新增一条记录。若内容与已有条目相同，则把旧条目提到最前面（不产生重复方块）。
   * @returns {boolean} 历史是否发生变化
   */
  add(item) {
    const idx = this.history.findIndex((it) => it.key === item.key);
    if (idx === 0) {
      this.history[0].createdAt = item.createdAt;
      this.save();
      return true;
    }
    if (idx > 0) {
      const [existing] = this.history.splice(idx, 1);
      existing.createdAt = item.createdAt;
      this.history.unshift(existing);
      this.save();
      return true;
    }
    this.history.unshift(item);
    this.trim();
    this.save();
    return true;
  }

  get(id) {
    return this.history.find((it) => it.id === id) || null;
  }

  /**
   * 标记某条为“刚刚用过”：刷新时间戳并移到数组最前。
   * trim() 依赖数组顺序为新→旧来决定丢弃谁，所以改了时间戳就必须同时挪位置，
   * 否则再次取用过的记录反而会被当成最旧的丢掉。
   */
  touch(id) {
    const idx = this.history.findIndex((it) => it.id === id);
    if (idx < 0) return null;
    const [item] = this.history.splice(idx, 1);
    item.createdAt = Date.now();
    this.history.unshift(item);
    this.save();
    return item;
  }

  remove(id) {
    const idx = this.history.findIndex((it) => it.id === id);
    if (idx < 0) return false;
    const [removed] = this.history.splice(idx, 1);
    this._dropFile(removed);
    this.save();
    return true;
  }

  togglePin(id) {
    const item = this.get(id);
    if (!item) return false;
    item.pinned = !item.pinned;
    this.save();
    return true;
  }

  /** 清空历史；置顶项默认保留，keepPinned=false 时一并清除 */
  clear(keepPinned = true) {
    const kept = keepPinned ? this.history.filter((it) => it.pinned) : [];
    this.history.filter((it) => !kept.includes(it)).forEach((it) => this._dropFile(it));
    this.history = kept;
    this.save();
  }

  /** 按 maxItems 丢弃最旧的非置顶条目 */
  trim() {
    const limit = this.config.maxItems;
    const unpinned = this.history.filter((it) => !it.pinned);
    if (unpinned.length <= limit) return false;
    const doomed = new Set(unpinned.slice(limit));
    this.history = this.history.filter((it) => !doomed.has(it));
    doomed.forEach((it) => this._dropFile(it));
    this.save();
    return true;
  }

  _dropFile(item) {
    if (item && item.type === 'image' && item.file) {
      fs.rm(item.file, { force: true }, () => {});
    }
  }

  imagePath(id) {
    return path.join(this.imageDir, `${id}.png`);
  }

  /** 写盘做了 300ms 防抖：连续复制时不会反复落盘 */
  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, 300);
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      writeJsonAtomic(this.historyFile, this.history);
    } catch (err) {
      console.error('[store] 保存历史失败:', err.message);
    }
  }
}

module.exports = { Store, DEFAULT_CONFIG, normalizeConfig };

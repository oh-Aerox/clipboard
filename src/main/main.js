'use strict';

const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  clipboard,
  nativeImage,
  screen,
  shell,
  dialog,
} = require('electron');

const { Store } = require('./store');
const { ClipboardWatcher, imageClipboardItem } = require('./watcher');
const { HotkeyManager } = require('./hotkeys');
const { Paster } = require('./paste');
const { queryItems } = require('./query');

const IS_DEV = process.argv.includes('--dev');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');

let store;
let watcher;
let hotkeys;
let paster;

/** @type {BrowserWindow|null} */
let panel = null;
/** @type {BrowserWindow|null} */
let settingsWin = null;
/** @type {Tray|null} */
let tray = null;
let isQuitting = false;
let hotkeyReport = { active: {}, failed: [] };

/* ------------------------------------------------------------------ *
 * 单实例：第二次启动时唤起已有实例的面板，而不是再开一个进程
 * ------------------------------------------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => togglePanel());
  bootstrap();
}

function bootstrap() {
  app.setAppUserModelId('com.ohaerox.clipboardpanel');
  // 剪贴板面板是常驻托盘的工具，关掉窗口不等于退出应用
  app.on('window-all-closed', () => {
    /* 保持后台运行 */
  });

  app.whenReady().then(onReady);

  app.on('before-quit', () => {
    isQuitting = true;
    if (watcher) watcher.stop();
    if (hotkeys) hotkeys.releaseAll();
    if (paster) paster.dispose();
    if (store) store.flush();
  });
}

function onReady() {
  store = new Store();
  hotkeys = new HotkeyManager();
  paster = new Paster();

  createPanel();
  createTray();
  registerIpc();

  watcher = new ClipboardWatcher(store, notifyHistoryChanged);
  watcher.start();

  applyHotkeys();
  applyLaunchAtLogin();

  // 调试用：启动即展开面板，省得每次去按快捷键
  if (process.argv.includes('--show')) showPanel();

  if (hotkeyReport.failed.length) {
    // 快捷键被占用是最常见的“装完不生效”原因，第一时间提示用户
    const detail = hotkeyReport.failed.map((f) => f.accelerator + '（' + f.reason + '）').join('\n');
    dialog
      .showMessageBox({
        type: 'warning',
        title: '快捷键注册失败',
        message: '以下全局快捷键未能注册，请在设置中改用其它组合：',
        detail,
        buttons: ['打开设置', '知道了'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) openSettings();
      });
  }
}

/* ------------------------------------------------------------------ *
 * 底部面板
 * ------------------------------------------------------------------ */

/** 贴在鼠标所在显示器的工作区底部：多屏时面板跟着光标走 */
function panelBounds() {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const height = Math.min(store.config.panelHeight, Math.floor(workArea.height * 0.8));
  return {
    x: workArea.x,
    y: workArea.y + workArea.height - height,
    width: workArea.width,
    height,
  };
}

function createPanel() {
  panel = new BrowserWindow({
    ...panelBounds(),
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#0f1115',
    title: '剪贴板',
    icon: path.join(ASSETS_DIR, 'icon.png'),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  panel.setAlwaysOnTop(true, 'screen-saver');
  panel.loadFile(path.join(RENDERER_DIR, 'panel.html'));

  panel.on('blur', () => {
    if (store.config.hideOnBlur && !panel.webContents.isDevToolsOpened()) hidePanel();
  });

  panel.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hidePanel();
    }
  });

  // 面板里的外链一律交给系统浏览器，不在应用内开新窗口
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showPanel() {
  if (!panel || panel.isDestroyed()) createPanel();
  panel.setBounds(panelBounds());
  panel.setAlwaysOnTop(true, 'screen-saver');
  panel.show();
  panel.focus();
  panel.webContents.send('panel:shown');
}

function hidePanel() {
  if (panel && !panel.isDestroyed() && panel.isVisible()) {
    panel.webContents.send('panel:hidden');
    panel.hide();
  }
}

function togglePanel() {
  if (panel && !panel.isDestroyed() && panel.isVisible()) hidePanel();
  else showPanel();
}

/* ------------------------------------------------------------------ *
 * 设置窗口
 * ------------------------------------------------------------------ */

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 660,
    height: 720,
    minWidth: 520,
    minHeight: 520,
    title: '剪贴板设置',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: path.join(ASSETS_DIR, 'icon.png'),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  settingsWin.removeMenu();
  settingsWin.loadFile(path.join(RENDERER_DIR, 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

/* ------------------------------------------------------------------ *
 * 托盘
 * ------------------------------------------------------------------ */

function trayImage() {
  const image = nativeImage.createFromPath(path.join(ASSETS_DIR, 'tray.png'));
  return image.isEmpty() ? nativeImage.createFromPath(path.join(ASSETS_DIR, 'icon.png')) : image;
}

function createTray() {
  tray = new Tray(trayImage());
  refreshTrayMenu();
  tray.setToolTip('剪贴板 — 单击托盘图标或按快捷键唤出面板');
  tray.on('click', () => togglePanel());
  tray.on('double-click', () => togglePanel());
}

function refreshTrayMenu() {
  if (!tray) return;
  const accel = hotkeyReport.active.toggle || store.config.hotkeys.toggle || '';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示 / 隐藏面板' + (accel ? '  (' + accel + ')' : ''),
        click: () => togglePanel(),
      },
      { type: 'separator' },
      { label: '设置…', click: () => openSettings() },
      {
        label: '清空历史（保留置顶）',
        click: () => {
          store.clear(true);
          notifyHistoryChanged();
        },
      },
      { type: 'separator' },
      {
        label: '开发者工具',
        visible: IS_DEV,
        click: () => panel && panel.webContents.openDevTools({ mode: 'detach' }),
      },
      { label: '退出', click: () => app.quit() },
    ]),
  );
}

/* ------------------------------------------------------------------ *
 * 配置生效
 * ------------------------------------------------------------------ */

function applyHotkeys() {
  hotkeyReport = hotkeys.apply(store.config.hotkeys, {
    toggle: () => togglePanel(),
    clear: () => {
      store.clear(true);
      notifyHistoryChanged();
    },
  });
  refreshTrayMenu();
  return hotkeyReport;
}

function applyLaunchAtLogin() {
  if (process.platform !== 'win32' || IS_DEV) return;
  // 面板本来就是隐藏启动，只驻留托盘，不需要额外参数
  app.setLoginItemSettings({ openAtLogin: store.config.launchAtLogin });
}

/* ------------------------------------------------------------------ *
 * 变更广播
 * ------------------------------------------------------------------ */

function notifyHistoryChanged() {
  for (const win of [panel, settingsWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('items:changed');
  }
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('items:query', (_e, term) => queryItems(store.getHistory(), term));

  ipcMain.handle('items:count', () => ({
    total: store.getHistory().length,
    pinned: store.getHistory().filter((it) => it.pinned).length,
    limit: store.config.maxItems,
  }));

  ipcMain.handle('item:use', async (_e, id, options) => {
    const item = store.get(id);
    if (!item) return { ok: false };

    if (item.type === 'text') {
      await clipboard.writeText(item.text);
    } else {
      if (!fs.existsSync(item.file)) return { ok: false };
      await clipboard.write([imageClipboardItem(fs.readFileSync(item.file))]);
    }
    // 登记刚写进去的内容，否则下一轮轮询会把它当成一次新复制
    await watcher.resync();
    // 再次取用等于“最近使用”，提到最前面
    store.touch(id);

    hidePanel();
    const wantPaste =
      options && typeof options.paste === 'boolean' ? options.paste : store.config.autoPaste;
    if (wantPaste) paster.paste();
    notifyHistoryChanged();
    return { ok: true, pasted: Boolean(wantPaste) };
  });

  ipcMain.handle('item:delete', (_e, id) => {
    const ok = store.remove(id);
    if (ok) notifyHistoryChanged();
    return { ok };
  });

  ipcMain.handle('item:pin', (_e, id) => {
    const ok = store.togglePin(id);
    if (ok) {
      // 取消置顶后这条可能就超出保留条数了
      store.trim();
      notifyHistoryChanged();
    }
    return { ok };
  });

  ipcMain.handle('item:text', (_e, id) => {
    const item = store.get(id);
    return item && item.type === 'text' ? item.text : '';
  });

  ipcMain.handle('items:clear', (_e, keepPinned) => {
    store.clear(keepPinned !== false);
    notifyHistoryChanged();
    return { ok: true };
  });

  ipcMain.handle('config:get', () => ({
    config: store.getConfig(),
    hotkeys: hotkeyReport,
    version: app.getVersion(),
    dataDir: store.baseDir,
  }));

  ipcMain.handle('config:set', (_e, patch) => {
    const before = store.getConfig();
    const config = store.setConfig(patch);

    if (JSON.stringify(before.hotkeys) !== JSON.stringify(config.hotkeys)) applyHotkeys();
    if (before.pollInterval !== config.pollInterval) watcher.restart();
    if (before.launchAtLogin !== config.launchAtLogin) applyLaunchAtLogin();
    if (before.panelHeight !== config.panelHeight && panel && !panel.isDestroyed()) {
      panel.setBounds(panelBounds());
    }
    notifyHistoryChanged();
    return { config, hotkeys: hotkeyReport };
  });

  ipcMain.handle('hotkey:probe', (_e, accelerator) => hotkeys.probe(accelerator));

  ipcMain.handle('panel:hide', () => {
    hidePanel();
    return { ok: true };
  });

  ipcMain.handle('settings:open', () => {
    openSettings();
    return { ok: true };
  });

  ipcMain.handle('app:reveal-data', () => {
    shell.openPath(store.baseDir);
    return { ok: true };
  });

  ipcMain.handle('app:quit', () => {
    app.quit();
    return { ok: true };
  });
}

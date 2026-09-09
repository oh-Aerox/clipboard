'use strict';

/**
 * 界面预览 / 回归工具：`npm run preview`
 *
 * 用一份固定的假数据把真实的 panel.html 与 settings.html 渲染出来，
 * 驱动几个交互状态（搜索、无结果、空历史）并各截一张图到 tests/screenshots/。
 * 不动系统剪贴板、不抢焦点，因此可以随时跑来肉眼检查改动效果。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const { Store } = require('../src/main/store');
const { queryItems } = require('../src/main/query');

const OUT_DIR = path.join(__dirname, 'screenshots');
const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'preload.js');

const PANEL_SIZE = { width: 1600, height: 250 };
const SAMPLES = [
  { text: 'https://github.com/oh-Aerox/clipboard.git', kind: 'url', pinned: true },
  {
    text: 'function debounce(fn, wait) {\n  let timer = null;\n  return (...args) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), wait);\n  };\n}',
    kind: 'code',
  },
  { text: 'C:\\Users\\me\\Desktop\\project\\clipboard\\requirement.md', kind: 'path' },
  { text: 'someone@example.com', kind: 'email' },
  {
    text: '会议记录：周四下午三点评审剪贴板方案，需要准备演示与打包安装包，另外确认快捷键是否与现有工具冲突。',
    kind: 'text',
  },
  { text: 'SELECT id, name FROM users WHERE status = 1 ORDER BY created_at DESC LIMIT 20;', kind: 'code' },
  { text: '0x5B9DFF', kind: 'text' },
];

function seed(store) {
  const now = Date.now();
  SAMPLES.forEach((s, i) => {
    store.add({
      id: `preview-${i}`,
      type: 'text',
      key: `text:preview-${i}`,
      text: s.text,
      preview: s.text.length > 400 ? `${s.text.slice(0, 400)}…` : s.text,
      title: s.text.split('\n')[0],
      kind: s.kind,
      chars: s.text.length,
      lines: s.text.split('\n').length,
      createdAt: now - i * 90_000,
      pinned: Boolean(s.pinned),
    });
  });
}

/** 只接上界面真正会调用的那几个通道，够把面板画出来即可 */
function registerStubIpc(store) {
  ipcMain.handle('items:query', (_e, term) => queryItems(store.getHistory(), term));
  ipcMain.handle('config:get', () => ({
    config: store.getConfig(),
    hotkeys: { active: { toggle: 'Ctrl+Shift+V' }, failed: [] },
    version: '1.0.0',
    dataDir: 'C:\\Users\\me\\AppData\\Roaming\\clipboard-panel',
  }));
  ipcMain.handle('config:set', (_e, patch) => ({
    config: store.setConfig(patch),
    hotkeys: { active: { toggle: 'Ctrl+Shift+V' }, failed: [] },
  }));
  ipcMain.handle('items:count', () => ({ total: store.getHistory().length, pinned: 1, limit: store.config.maxItems }));
  ipcMain.handle('hotkey:probe', () => ({ ok: true, reason: '' }));
  for (const channel of ['item:use', 'item:delete', 'item:pin', 'items:clear', 'panel:hide', 'settings:open', 'app:reveal-data', 'app:quit']) {
    ipcMain.handle(channel, () => ({ ok: true }));
  }
  ipcMain.handle('item:text', () => '');
}

async function shoot(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`  ${path.relative(process.cwd(), file)}`);
}

/** 在渲染进程里改搜索框内容并触发 input 事件，等防抖跑完 */
async function typeSearch(win, term) {
  await win.webContents.executeJavaScript(`
    (() => {
      const box = document.getElementById('search');
      box.value = ${JSON.stringify(term)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })();
  `);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function readState(win) {
  return win.webContents.executeJavaScript(`
    ({
      tiles: document.querySelectorAll('.tile').length,
      marks: document.querySelectorAll('.tile__body mark').length,
      count: document.getElementById('count').textContent,
      emptyVisible: !document.getElementById('empty').hidden,
      emptyTitle: document.querySelector('.empty__title').textContent,
    })
  `);
}

function assert(label, condition, extra) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${condition || !extra ? '' : ` — ${extra}`}`);
  return condition;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-preview-')));
  seed(store);
  registerStubIpc(store);

  const panel = new BrowserWindow({
    ...PANEL_SIZE,
    show: false,
    frame: false,
    backgroundColor: '#0f1115',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  await panel.loadFile(path.join(RENDERER_DIR, 'panel.html'));
  await new Promise((resolve) => setTimeout(resolve, 400));

  let ok = true;
  console.log('\n[面板：全部记录]');
  let state = await readState(panel);
  ok = assert('7 个方块全部渲染', state.tiles === 7, `实际 ${state.tiles}`) && ok;
  ok = assert('空状态已隐藏', state.emptyVisible === false) && ok;
  ok = assert('条数显示为 7 / 50 条', state.count === '7 / 50 条', state.count) && ok;
  await shoot(panel, 'panel-all');

  console.log('\n[面板：搜索命中]');
  // users 大小写不敏感，既命中 SQL 也命中 C:\Users\… 这条路径
  await typeSearch(panel, 'users');
  state = await readState(panel);
  ok = assert('命中 2 个方块（含大小写不同的 Users）', state.tiles === 2, `实际 ${state.tiles}`) && ok;
  ok = assert('命中关键词被高亮', state.marks >= 2, `mark 数 ${state.marks}`) && ok;
  ok = assert('条数切换为匹配文案', state.count === '匹配 2 条', state.count) && ok;
  await shoot(panel, 'panel-search');

  console.log('\n[面板：中文搜索]');
  await typeSearch(panel, '会议');
  state = await readState(panel);
  ok = assert('中文关键词命中 1 条', state.tiles === 1, `实际 ${state.tiles}`) && ok;
  ok = assert('中文关键词被高亮', state.marks >= 1, `mark 数 ${state.marks}`) && ok;
  await shoot(panel, 'panel-search-cn');

  console.log('\n[面板：无匹配]');
  await typeSearch(panel, '这个词不存在');
  state = await readState(panel);
  ok = assert('没有方块', state.tiles === 0, `实际 ${state.tiles}`) && ok;
  ok = assert('显示无匹配提示', state.emptyVisible && state.emptyTitle === '没有匹配的记录', state.emptyTitle) && ok;
  await shoot(panel, 'panel-no-match');

  console.log('\n[面板：空历史]');
  store.clear(false);
  await typeSearch(panel, '');
  state = await readState(panel);
  ok = assert('显示空历史提示', state.emptyVisible && state.emptyTitle === '还没有剪贴板记录', state.emptyTitle) && ok;
  await shoot(panel, 'panel-empty');

  console.log('\n[设置窗口]');
  const settings = new BrowserWindow({
    width: 660,
    height: 720,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  await settings.loadFile(path.join(RENDERER_DIR, 'settings.html'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const settingsState = await settings.webContents.executeJavaScript(`
    ({
      toggle: document.getElementById('hk-toggle').value,
      maxItems: document.getElementById('max-items').value,
      maxItemsLabel: document.getElementById('max-items-value').textContent,
      version: document.getElementById('version').textContent,
    })
  `);
  ok = assert('快捷键回填', settingsState.toggle === 'Ctrl+Shift+V', settingsState.toggle) && ok;
  ok = assert('保留条数回填', settingsState.maxItemsLabel === '50 条', settingsState.maxItemsLabel) && ok;
  ok = assert('版本号回填', settingsState.version === '1.0.0', settingsState.version) && ok;
  await shoot(settings, 'settings');

  console.log(ok ? '\n界面预览全部通过' : '\n界面预览存在失败项');
  app.exit(ok ? 0 : 1);
});

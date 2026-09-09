'use strict';

/* 设置页：所有改动即时生效并写盘，不需要“保存”按钮。 */

const DEFAULT_TOGGLE = 'Ctrl+Shift+V';

const el = {
  hkToggle: document.getElementById('hk-toggle'),
  hkToggleStatus: document.getElementById('hk-toggle-status'),
  hkClear: document.getElementById('hk-clear'),
  hkClearStatus: document.getElementById('hk-clear-status'),

  maxItems: document.getElementById('max-items'),
  maxItemsValue: document.getElementById('max-items-value'),
  maxText: document.getElementById('max-text'),
  captureImages: document.getElementById('capture-images'),
  btnClearKeep: document.getElementById('btn-clear-keep'),
  btnClearAll: document.getElementById('btn-clear-all'),
  clearStatus: document.getElementById('clear-status'),

  panelHeight: document.getElementById('panel-height'),
  panelHeightValue: document.getElementById('panel-height-value'),
  pollInterval: document.getElementById('poll-interval'),
  pollIntervalValue: document.getElementById('poll-interval-value'),
  autoPaste: document.getElementById('auto-paste'),
  hideOnBlur: document.getElementById('hide-on-blur'),
  launchAtLogin: document.getElementById('launch-at-login'),

  version: document.getElementById('version'),
  dataDir: document.getElementById('data-dir'),
  btnDataDir: document.getElementById('btn-data-dir'),
  btnQuit: document.getElementById('btn-quit'),
};

let config = null;

/* ------------------------------------------------------------------ *
 * 快捷键录制
 * ------------------------------------------------------------------ */

const CODE_TO_KEY = {
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
};

/** 把浏览器事件翻译成 Electron 的 accelerator 写法，例如 Ctrl+Shift+V */
function keyFromEvent(event) {
  const { code } = event;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return CODE_TO_KEY[code] || null;
}

function acceleratorFromEvent(event) {
  const mods = [];
  if (event.ctrlKey) mods.push('Ctrl');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (event.metaKey) mods.push('Super');
  const key = keyFromEvent(event);
  if (!key || !mods.length) return null;
  return [...mods, key].join('+');
}

function setStatus(node, message, kind) {
  node.textContent = message || '';
  node.classList.toggle('is-ok', kind === 'ok');
  node.classList.toggle('is-error', kind === 'error');
}

/**
 * 绑定一个快捷键输入框：聚焦即进入录制状态，按下组合键后先向主进程
 * 试注册一次，确认没被别的程序占用才写入配置。
 */
function bindHotkeyInput(input, statusNode, name) {
  input.addEventListener('focus', () => {
    input.classList.add('is-recording');
    input.value = '按下组合键…';
    setStatus(statusNode, '按 Esc 取消录制', '');
  });

  input.addEventListener('blur', () => {
    input.classList.remove('is-recording');
    input.value = config.hotkeys[name] || '';
  });

  input.addEventListener('keydown', async (event) => {
    event.preventDefault();
    if (event.code === 'Escape') {
      input.blur();
      setStatus(statusNode, '', '');
      return;
    }
    // 只按了修饰键，等着后面的主键
    if (['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'].includes(event.code)) {
      return;
    }

    const accelerator = acceleratorFromEvent(event);
    if (!accelerator) {
      setStatus(statusNode, '需要“修饰键 + 主键”的组合，例如 Ctrl+Shift+V', 'error');
      return;
    }

    const probe = await window.clip.probeHotkey(accelerator);
    if (!probe.ok) {
      setStatus(statusNode, `${accelerator} 不可用：${probe.reason}`, 'error');
      return;
    }

    input.value = accelerator;
    const result = await window.clip.setConfig({
      hotkeys: { ...config.hotkeys, [name]: accelerator },
    });
    config = result.config;
    const failed = (result.hotkeys.failed || []).find((f) => f.name === name);
    if (failed) setStatus(statusNode, `注册失败：${failed.reason}`, 'error');
    else setStatus(statusNode, `已生效：${accelerator}`, 'ok');
    input.blur();
  });
}

/* ------------------------------------------------------------------ *
 * 其它设置项
 * ------------------------------------------------------------------ */

async function patch(partial) {
  const result = await window.clip.setConfig(partial);
  config = result.config;
  return config;
}

function bindRange(input, output, format, key) {
  input.addEventListener('input', () => {
    output.textContent = format(Number(input.value));
  });
  input.addEventListener('change', async () => {
    await patch({ [key]: Number(input.value) });
    input.value = config[key];
    output.textContent = format(config[key]);
  });
}

function bindCheck(input, key) {
  input.addEventListener('change', async () => {
    await patch({ [key]: input.checked });
    input.checked = config[key];
  });
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

function fill(info) {
  config = info.config;

  el.hkToggle.value = config.hotkeys.toggle || '';
  el.hkClear.value = config.hotkeys.clear || '';

  el.maxItems.value = config.maxItems;
  el.maxItemsValue.textContent = `${config.maxItems} 条`;
  el.maxText.value = config.maxTextLength;
  el.captureImages.checked = config.captureImages;

  el.panelHeight.value = config.panelHeight;
  el.panelHeightValue.textContent = `${config.panelHeight} px`;
  el.pollInterval.value = config.pollInterval;
  el.pollIntervalValue.textContent = `${config.pollInterval} ms`;
  el.autoPaste.checked = config.autoPaste;
  el.hideOnBlur.checked = config.hideOnBlur;
  el.launchAtLogin.checked = config.launchAtLogin;

  el.version.textContent = info.version;
  el.dataDir.textContent = info.dataDir;

  const failedToggle = (info.hotkeys.failed || []).find((f) => f.name === 'toggle');
  if (failedToggle) {
    setStatus(el.hkToggleStatus, `当前快捷键无法注册：${failedToggle.reason}`, 'error');
  }
}

bindHotkeyInput(el.hkToggle, el.hkToggleStatus, 'toggle');
bindHotkeyInput(el.hkClear, el.hkClearStatus, 'clear');

document.querySelector('[data-reset="toggle"]').addEventListener('click', async () => {
  const probe = await window.clip.probeHotkey(DEFAULT_TOGGLE);
  await patch({ hotkeys: { ...config.hotkeys, toggle: DEFAULT_TOGGLE } });
  el.hkToggle.value = config.hotkeys.toggle;
  setStatus(
    el.hkToggleStatus,
    probe.ok ? `已恢复默认：${DEFAULT_TOGGLE}` : `${DEFAULT_TOGGLE} 可能被占用：${probe.reason}`,
    probe.ok ? 'ok' : 'error',
  );
});

document.querySelector('[data-clear="clear"]').addEventListener('click', async () => {
  await patch({ hotkeys: { ...config.hotkeys, clear: '' } });
  el.hkClear.value = '';
  setStatus(el.hkClearStatus, '已取消绑定', 'ok');
});

bindRange(el.maxItems, el.maxItemsValue, (v) => `${v} 条`, 'maxItems');
bindRange(el.panelHeight, el.panelHeightValue, (v) => `${v} px`, 'panelHeight');
bindRange(el.pollInterval, el.pollIntervalValue, (v) => `${v} ms`, 'pollInterval');

el.maxText.addEventListener('change', async () => {
  await patch({ maxTextLength: Number(el.maxText.value) });
  el.maxText.value = config.maxTextLength;
});

bindCheck(el.captureImages, 'captureImages');
bindCheck(el.autoPaste, 'autoPaste');
bindCheck(el.hideOnBlur, 'hideOnBlur');
bindCheck(el.launchAtLogin, 'launchAtLogin');

el.btnClearKeep.addEventListener('click', async () => {
  await window.clip.clear(true);
  setStatus(el.clearStatus, '已清空历史（置顶记录保留）', 'ok');
});

el.btnClearAll.addEventListener('click', async () => {
  await window.clip.clear(false);
  setStatus(el.clearStatus, '历史已全部清空', 'ok');
});

el.btnDataDir.addEventListener('click', () => window.clip.revealDataDir());
el.btnQuit.addEventListener('click', () => window.clip.quit());

window.clip.getConfig().then(fill);

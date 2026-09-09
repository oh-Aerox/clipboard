'use strict';

/* 底部面板的渲染与交互。数据全部来自 preload 暴露的 window.clip。 */

const KIND_LABEL = {
  text: '文本',
  url: '链接',
  email: '邮箱',
  path: '路径',
  code: '代码',
  image: '图片',
};

const el = {
  search: document.getElementById('search'),
  searchClear: document.getElementById('search-clear'),
  strip: document.getElementById('strip'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count'),
  autoPaste: document.getElementById('auto-paste'),
  btnClear: document.getElementById('btn-clear'),
  btnSettings: document.getElementById('btn-settings'),
  btnClose: document.getElementById('btn-close'),
};

const state = {
  items: [],
  term: '',
  selected: 0,
  limit: 50,
  autoPaste: true,
};

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

function formatTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const date = new Date(ts);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (diff < 86_400_000) return `${hh}:${mm}`;
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}

function formatMeta(item) {
  if (item.type === 'image') return `${item.width}×${item.height}`;
  const parts = [`${item.chars ?? (item.preview || '').length} 字`];
  if (item.lines > 1) parts.push(`${item.lines} 行`);
  return parts.join(' · ');
}

/**
 * 把命中的关键词包成 <mark>。
 * 逐段拼 DOM 节点而不是拼 HTML 字符串——剪贴板内容是任意文本，
 * 走 innerHTML 会把复制来的 HTML 片段当标签执行。
 */
function renderHighlighted(container, text, term) {
  if (!term) {
    container.textContent = text;
    return;
  }
  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  let from = 0;
  let hit = haystack.indexOf(needle, from);
  if (hit < 0) {
    container.textContent = text;
    return;
  }
  const frag = document.createDocumentFragment();
  while (hit >= 0) {
    if (hit > from) frag.append(text.slice(from, hit));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(hit, hit + needle.length);
    frag.append(mark);
    from = hit + needle.length;
    hit = haystack.indexOf(needle, from);
  }
  if (from < text.length) frag.append(text.slice(from));
  container.append(frag);
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function buildTile(item, index) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = item.id;
  tile.dataset.index = String(index);
  tile.setAttribute('role', 'button');
  tile.setAttribute('tabindex', '-1');
  if (item.pinned) tile.classList.add('is-pinned');
  tile.title = item.title || '';

  const top = document.createElement('div');
  top.className = 'tile__top';
  const badge = document.createElement('span');
  badge.className = 'tile__badge';
  badge.dataset.kind = item.kind || 'text';
  badge.textContent = KIND_LABEL[item.kind] || '文本';
  const time = document.createElement('span');
  time.className = 'tile__time';
  time.textContent = formatTime(item.createdAt);
  top.append(badge, time);

  const body = document.createElement('div');
  body.className = 'tile__body';
  if (item.type === 'image') {
    const img = document.createElement('img');
    img.className = 'tile__image';
    img.src = item.thumbnail || '';
    img.alt = item.title || '图片';
    body.append(img);
  } else {
    if (item.kind === 'code') body.classList.add('tile__body--code');
    renderHighlighted(body, item.preview || '', state.term);
  }

  const foot = document.createElement('div');
  foot.className = 'tile__foot';
  if (index < 9) {
    const idx = document.createElement('span');
    idx.className = 'tile__index';
    idx.textContent = String(index + 1);
    foot.append(idx);
  }
  const meta = document.createElement('span');
  meta.textContent = formatMeta(item);
  foot.append(meta);

  const tools = document.createElement('span');
  tools.className = 'tile__tools';
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = item.pinned ? 'tool is-on' : 'tool';
  pin.dataset.action = 'pin';
  pin.textContent = '★';
  pin.title = item.pinned ? '取消置顶' : '置顶（不会被条数上限丢弃）';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'tool tool--danger';
  del.dataset.action = 'delete';
  del.textContent = '✕';
  del.title = '删除这条';
  tools.append(pin, del);
  foot.append(tools);

  tile.append(top, body, foot);
  return tile;
}

function render() {
  el.strip.querySelectorAll('.tile').forEach((node) => node.remove());

  if (!state.items.length) {
    el.empty.hidden = false;
    const searching = Boolean(state.term);
    el.empty.querySelector('.empty__title').textContent = searching
      ? '没有匹配的记录'
      : '还没有剪贴板记录';
    el.empty.querySelector('.empty__hint').textContent = searching
      ? `没有包含“${state.term}”的内容`
      : '复制任意文字或图片，就会出现在这里';
  } else {
    el.empty.hidden = true;
    const frag = document.createDocumentFragment();
    state.items.forEach((item, i) => frag.append(buildTile(item, i)));
    el.strip.append(frag);
  }

  applySelection();
  renderCount();
}

function renderCount() {
  const shown = state.items.length;
  el.count.textContent = state.term
    ? `匹配 ${shown} 条`
    : `${shown} / ${state.limit} 条`;
}

function applySelection({ scroll = true } = {}) {
  const tiles = el.strip.querySelectorAll('.tile');
  if (!tiles.length) {
    state.selected = 0;
    return;
  }
  state.selected = Math.max(0, Math.min(state.selected, tiles.length - 1));
  tiles.forEach((tile, i) => tile.classList.toggle('is-selected', i === state.selected));
  // 鼠标划过引起的选中不该带动滚动，否则方块会在指针下面自己跑
  if (scroll) tiles[state.selected].scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/* ------------------------------------------------------------------ *
 * 数据
 * ------------------------------------------------------------------ */

async function reload({ resetSelection = false } = {}) {
  state.items = await window.clip.query(state.term);
  if (resetSelection) state.selected = 0;
  render();
}

async function loadConfig() {
  const { config } = await window.clip.getConfig();
  state.limit = config.maxItems;
  state.autoPaste = config.autoPaste;
  el.autoPaste.checked = config.autoPaste;
  renderCount();
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */

async function useItem(index, { paste = state.autoPaste } = {}) {
  const item = state.items[index];
  if (!item) return;
  await window.clip.use(item.id, { paste });
}

async function deleteItem(index) {
  const item = state.items[index];
  if (!item) return;
  await window.clip.remove(item.id);
  // 删掉最后一条时把选中位置往前挪，避免选中飘到空白处
  if (index >= state.items.length - 1) state.selected = Math.max(0, index - 1);
  await reload();
}

async function pinItem(index) {
  const item = state.items[index];
  if (!item) return;
  await window.clip.pin(item.id);
  await reload();
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

let searchTimer = null;
el.search.addEventListener('input', () => {
  el.searchClear.hidden = !el.search.value;
  clearTimeout(searchTimer);
  // 输入防抖：每次查询都要过一趟 IPC 并在主进程全文匹配
  searchTimer = setTimeout(() => {
    state.term = el.search.value.trim();
    reload({ resetSelection: true });
  }, 80);
});

el.searchClear.addEventListener('click', () => {
  el.search.value = '';
  el.searchClear.hidden = true;
  state.term = '';
  reload({ resetSelection: true });
  el.search.focus();
});

el.strip.addEventListener('click', (event) => {
  const tile = event.target.closest('.tile');
  if (!tile) return;
  const index = Number(tile.dataset.index);
  const tool = event.target.closest('.tool');
  if (tool) {
    event.stopPropagation();
    if (tool.dataset.action === 'pin') pinItem(index);
    else deleteItem(index);
    return;
  }
  state.selected = index;
  useItem(index, { paste: event.ctrlKey ? false : state.autoPaste });
});

el.strip.addEventListener('mousemove', (event) => {
  const tile = event.target.closest('.tile');
  if (!tile) return;
  const index = Number(tile.dataset.index);
  if (index !== state.selected) {
    state.selected = index;
    applySelection({ scroll: false });
  }
});

// 面板很扁，纵向滚轮在这里应该驱动横向滚动
el.strip.addEventListener(
  'wheel',
  (event) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    el.strip.scrollLeft += event.deltaY;
  },
  { passive: false },
);

el.autoPaste.addEventListener('change', async () => {
  state.autoPaste = el.autoPaste.checked;
  await window.clip.setConfig({ autoPaste: state.autoPaste });
});

el.btnClear.addEventListener('click', async () => {
  await window.clip.clear(true);
  state.selected = 0;
  await reload();
  el.search.focus();
});

el.btnSettings.addEventListener('click', () => window.clip.openSettings());
el.btnClose.addEventListener('click', () => window.clip.hidePanel());

document.addEventListener('keydown', (event) => {
  const { key, ctrlKey, altKey } = event;

  if (key === 'Escape') {
    event.preventDefault();
    window.clip.hidePanel();
    return;
  }

  // Alt+1..9 直接取用对应方块
  if (altKey && /^[1-9]$/.test(key)) {
    event.preventDefault();
    const index = Number(key) - 1;
    if (state.items[index]) {
      state.selected = index;
      useItem(index);
    }
    return;
  }

  if (ctrlKey && key === ',') {
    event.preventDefault();
    window.clip.openSettings();
    return;
  }

  if (ctrlKey && (key === 'p' || key === 'P')) {
    event.preventDefault();
    pinItem(state.selected);
    return;
  }

  switch (key) {
    case 'ArrowRight':
      event.preventDefault();
      state.selected += 1;
      applySelection();
      break;
    case 'ArrowLeft':
      event.preventDefault();
      state.selected -= 1;
      applySelection();
      break;
    case 'Home':
      if (el.search.value && document.activeElement === el.search) break;
      event.preventDefault();
      state.selected = 0;
      applySelection();
      break;
    case 'End':
      if (el.search.value && document.activeElement === el.search) break;
      event.preventDefault();
      state.selected = state.items.length - 1;
      applySelection();
      break;
    case 'Enter':
      event.preventDefault();
      useItem(state.selected, { paste: ctrlKey ? false : state.autoPaste });
      break;
    case 'Delete':
      // 光标在搜索框里且有内容时，Delete 归搜索框
      if (document.activeElement === el.search && el.search.value) break;
      event.preventDefault();
      deleteItem(state.selected);
      break;
    default:
      break;
  }
});

/* ------------------------------------------------------------------ *
 * 主进程推送
 * ------------------------------------------------------------------ */

window.clip.onChanged(() => {
  loadConfig();
  reload();
});

window.clip.onPanelShown(() => {
  // 每次唤出都是一次新的检索：清空搜索、回到第一个方块
  el.search.value = '';
  el.searchClear.hidden = true;
  state.term = '';
  state.selected = 0;
  loadConfig();
  reload({ resetSelection: true }).then(() => el.search.focus());
});

(async function init() {
  await loadConfig();
  await reload({ resetSelection: true });
  el.search.focus();
})();

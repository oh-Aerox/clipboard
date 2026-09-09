'use strict';

/**
 * 历史记录的搜索、排序与投影。
 * 单独成一个模块，既让 main.js 只管窗口和 IPC，也方便直接跑测试。
 */

/** 只保留渲染进程画方块需要的字段：正文可能非常大，没必要整篇过 IPC */
function toView(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    preview: item.type === 'text' ? item.preview : undefined,
    thumbnail: item.type === 'image' ? item.thumbnail : undefined,
    kind: item.kind,
    chars: item.chars,
    lines: item.lines,
    width: item.width,
    height: item.height,
    createdAt: item.createdAt,
    pinned: Boolean(item.pinned),
  };
}

function matches(item, keyword) {
  if (item.type === 'text') return item.text.toLowerCase().includes(keyword);
  // 图片没有正文可搜，用标题（含尺寸）和“图片”这个词兜底
  return (item.title || '').toLowerCase().includes(keyword) || '图片image'.includes(keyword);
}

/**
 * 在完整历史上做搜索并排序。
 * 搜索必须在主进程做：全文只存在这里，渲染进程手上只有 400 字预览，
 * 在渲染进程过滤会漏掉长文本靠后的内容。
 *
 * @param {Array<object>} history 完整历史（已按新→旧排列）
 * @param {string} term 搜索词，空串表示不过滤
 * @returns {Array<object>} 可直接交给渲染进程的视图对象
 */
function queryItems(history, term) {
  const keyword = String(term || '')
    .trim()
    .toLowerCase();
  const matched = keyword ? history.filter((item) => matches(item, keyword)) : history.slice();

  // 置顶项永远排在最前，其余按复制时间倒序
  matched.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt);
  return matched.map(toView);
}

module.exports = { queryItems, toView };

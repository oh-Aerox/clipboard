'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { clipboard, nativeImage, ClipboardItem } = require('electron');

/** Electron 44 的剪贴板以 MIME 类型描述内容，图片统一按 PNG 取用 */
const IMAGE_MIME = 'image/png';

function randomId() {
  return crypto.randomBytes(9).toString('hex');
}

function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function firstLine(text, limit = 120) {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) || text.trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** 用于方块预览的截断文本，同时避免把整篇长文丢给渲染进程 */
function previewOf(text, limit = 400) {
  const trimmed = text.replace(/\r\n/g, '\n');
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function guessKind(text) {
  const t = text.trim();
  if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return 'url';
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return 'email';
  if (/^[A-Za-z]:[\\/][^\n]*$/.test(t) || /^\\\\[^\n]+$/.test(t)) return 'path';
  if (t.length > 12 && /[{};=<>]|=>|\bfunction\b|\bdef\b|\bclass\b/.test(t) && /\n/.test(t)) {
    return 'code';
  }
  return 'text';
}

/** 把本地图片文件包成可写入剪贴板的 ClipboardItem */
function imageClipboardItem(buffer) {
  return new ClipboardItem({ [IMAGE_MIME]: new Blob([buffer], { type: IMAGE_MIME }) });
}

/**
 * 轮询系统剪贴板。
 *
 * Windows 不会把剪贴板变更事件透给 Electron，所以只能定时轮询，
 * 再用内容哈希去重来判断“这是不是一次新的复制”。
 * Electron 44 起剪贴板 API 全部是异步的（readText / read 返回 Promise），
 * 因此每一轮都是一次 async 流程，用 busy 标记防止上一轮没跑完就重入。
 */
class ClipboardWatcher {
  constructor(store, onChange) {
    this.store = store;
    this.onChange = onChange;
    this.timer = null;
    this.busy = false;

    this.lastTextKey = null;
    this.lastImageKey = null;
    /** 上一次见到的图片字节数，用于跳过重复哈希，见 handleImage */
    this.lastImageSize = 0;

    this._lastErrorMessage = null;
  }

  start() {
    this.stop();
    // 先把当前剪贴板内容记成“已知”，否则启动瞬间会把开机前的旧内容当成新复制
    this.resync();
    this.timer = setInterval(() => this.tick(), this.store.config.pollInterval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 轮询间隔改变后重新起表 */
  restart() {
    this.start();
  }

  /**
   * 把当前剪贴板内容登记为“已知”，但不写进历史。
   * 启动时用它跳过开机前的旧内容；应用自己写入剪贴板后也用它，
   * 这样刚粘贴过的内容不会又被当成一次新复制记一遍。
   */
  async resync() {
    try {
      const snapshot = await this.readSnapshot();
      if (!snapshot) {
        this.lastImageSize = 0;
        return;
      }
      if (snapshot.type === 'text') {
        this.lastTextKey = `text:${sha1(snapshot.text)}`;
        this.lastImageSize = 0;
        return;
      }
      const buffer = Buffer.from(await snapshot.blob.arrayBuffer());
      this.lastImageKey = `image:${sha1(buffer)}`;
      this.lastImageSize = buffer.length;
    } catch (err) {
      this.reportError(err);
    }
  }

  /** 读一眼剪贴板：优先文本，其次图片；都没有就返回 null */
  async readSnapshot() {
    const text = await clipboard.readText();
    if (text && text.trim()) return { type: 'text', text };
    if (!this.store.config.captureImages) return null;

    const items = await clipboard.read();
    const item = items.find((it) => it.types.includes(IMAGE_MIME));
    if (!item) return null;
    return { type: 'image', blob: await item.getType(IMAGE_MIME) };
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const snapshot = await this.readSnapshot();
      if (!snapshot) {
        this.lastImageSize = 0;
        return;
      }
      if (snapshot.type === 'text') {
        this.lastImageSize = 0;
        this.handleText(snapshot.text);
      } else {
        await this.handleImage(snapshot.blob);
      }
    } catch (err) {
      this.reportError(err);
    } finally {
      this.busy = false;
    }
  }

  handleText(text) {
    if (text.length > this.store.config.maxTextLength) return;

    const key = `text:${sha1(text)}`;
    if (key === this.lastTextKey) return;
    this.lastTextKey = key;

    this.store.add({
      id: randomId(),
      type: 'text',
      key,
      text,
      preview: previewOf(text),
      title: firstLine(text),
      kind: guessKind(text),
      chars: text.length,
      lines: text.split(/\r?\n/).length,
      createdAt: Date.now(),
      pinned: false,
    });
    this.onChange();
  }

  async handleImage(blob) {
    // 字节数没变就认为还是同一张图，跳过取数据 + 哈希。
    // 剪贴板上放着一张大图时，这一步把每轮的开销从“拷贝并哈希整张图”降到零；
    // 代价是紧接着换成另一张字节数完全相同的图会漏记，实际几乎不会发生。
    if (blob.size === this.lastImageSize) return;

    const buffer = Buffer.from(await blob.arrayBuffer());
    this.lastImageSize = buffer.length;

    const key = `image:${sha1(buffer)}`;
    if (key === this.lastImageKey) return;
    this.lastImageKey = key;

    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return;

    const id = randomId();
    const file = this.store.imagePath(id);
    fs.writeFileSync(file, buffer);
    const { width, height } = image.getSize();

    this.store.add({
      id,
      type: 'image',
      key,
      file,
      thumbnail: image.resize({ height: 96, quality: 'good' }).toDataURL(),
      title: `图片 ${width}×${height}`,
      kind: 'image',
      width,
      height,
      createdAt: Date.now(),
      pinned: false,
    });
    this.onChange();
  }

  /**
   * 轮询里的异常必须能看见。
   * 之前这里是静默 catch，结果 Electron 44 把剪贴板 API 改成异步后，
   * 整个抓取功能失效却一声不响——同样的错误只打第一次，避免每 600ms 刷屏。
   */
  reportError(err) {
    const message = err && err.message ? err.message : String(err);
    if (message === this._lastErrorMessage) return;
    this._lastErrorMessage = message;
    console.error('[watcher] 读取剪贴板失败:', message);
  }
}

module.exports = {
  ClipboardWatcher,
  randomId,
  guessKind,
  previewOf,
  firstLine,
  imageClipboardItem,
  IMAGE_MIME,
};

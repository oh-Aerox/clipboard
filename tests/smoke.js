'use strict';

/**
 * 核心逻辑冒烟测试，用 Electron 跑（`npm test`），因为被测模块 require 了 electron。
 * 覆盖：条数上限丢弃、置顶豁免、去重提前、配置纠正、快捷键校验、内容类型识别。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, clipboard, nativeImage } = require('electron');

const { Store, normalizeConfig } = require('../src/main/store');
const { isValidAccelerator } = require('../src/main/hotkeys');
const {
  ClipboardWatcher,
  guessKind,
  previewOf,
  firstLine,
  imageClipboardItem,
} = require('../src/main/watcher');
const { queryItems } = require('../src/main/query');
const { Paster } = require('../src/main/paste');

let passed = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function textItem(text, at) {
  return {
    id: `id-${text}-${at}`,
    type: 'text',
    key: `text:${text}`,
    text,
    preview: previewOf(text),
    title: firstLine(text),
    kind: guessKind(text),
    chars: text.length,
    lines: text.split('\n').length,
    createdAt: at,
    pinned: false,
  };
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-test-'));
  return { dir, store: new Store(dir) };
}

/* ---------------- 条数上限 ---------------- */

console.log('\n[保留条数]');
{
  const { store } = tempStore();
  store.setConfig({ maxItems: 6 });
  for (let i = 1; i <= 9; i += 1) store.add(textItem(`条目${i}`, 1000 + i));

  equal(
    '超出上限后只保留最近 6 条',
    store.getHistory().map((it) => it.text),
    ['条目9', '条目8', '条目7', '条目6', '条目5', '条目4'],
  );

  store.setConfig({ maxItems: 5 });
  equal('调小上限后立即丢弃多余记录', store.getHistory().length, 5);
  equal('上限过大时收敛到最大值', store.setConfig({ maxItems: 99999 }).maxItems, 1000);
  equal('上限过小时收敛到最小值', store.setConfig({ maxItems: 1 }).maxItems, 5);
}

/* ---------------- 置顶 ---------------- */

console.log('\n[置顶]');
{
  const { store } = tempStore();
  store.setConfig({ maxItems: 5 });
  store.add(textItem('要留住的', 1));
  store.togglePin(store.getHistory()[0].id);
  for (let i = 1; i <= 8; i += 1) store.add(textItem(`新${i}`, 100 + i));

  const texts = store.getHistory().map((it) => it.text);
  check('置顶记录不会被条数上限丢弃', texts.includes('要留住的'), texts.join(','));
  equal('非置顶记录仍按上限保留', texts.filter((t) => t !== '要留住的').length, 5);

  store.clear(true);
  equal('清空时保留置顶', store.getHistory().map((it) => it.text), ['要留住的']);
  store.clear(false);
  equal('全部清空', store.getHistory().length, 0);
}

/* ---------------- 去重 ---------------- */

console.log('\n[去重]');
{
  const { store } = tempStore();
  store.add(textItem('A', 1));
  store.add(textItem('B', 2));
  store.add(textItem('A', 3));

  equal('重复内容不新增方块，只提到最前', store.getHistory().map((it) => it.text), ['A', 'B']);
  equal('提前后时间戳刷新', store.getHistory()[0].createdAt, 3);
}

/* ---------------- 再次取用 ---------------- */

console.log('\n[再次取用]');
{
  const { store } = tempStore();
  store.setConfig({ maxItems: 5 });
  for (let i = 1; i <= 5; i += 1) store.add(textItem(`条目${i}`, 1000 + i));

  // 取用最旧的那条，它应该变成最新的，不该在下一次丢弃里被当成最旧
  const oldest = store.getHistory()[store.getHistory().length - 1];
  equal('取用前最旧的是条目1', oldest.text, '条目1');
  store.touch(oldest.id);
  equal('取用后排到最前', store.getHistory()[0].text, '条目1');

  store.add(textItem('条目6', 2000));
  const texts = store.getHistory().map((it) => it.text);
  check('刚取用过的记录不会被当成最旧丢掉', texts.includes('条目1'), texts.join(','));
  check('真正最旧的记录被丢弃', !texts.includes('条目2'), texts.join(','));
}

/* ---------------- 搜索 ---------------- */

console.log('\n[搜索]');
{
  const { store } = tempStore();
  store.add(textItem('购物清单：牛奶、鸡蛋、面包', 10));
  store.add(textItem('Deploy Guide for Production', 20));
  // 关键词埋在 2000 字之后，只有全文搜索才能命中
  store.add(textItem(`${'开头填充。'.repeat(400)}藏在很后面的关键词`, 30));
  store.togglePin(store.getHistory().find((it) => it.text.includes('牛奶')).id);

  equal('命中中文关键词', queryItems(store.getHistory(), '鸡蛋').length, 1);
  equal('搜索忽略大小写', queryItems(store.getHistory(), 'PRODUCTION').length, 1);
  equal('搜索词首尾空白被忽略', queryItems(store.getHistory(), '  鸡蛋  ').length, 1);
  equal(
    '预览之外的正文也能搜到',
    queryItems(store.getHistory(), '藏在很后面的关键词').length,
    1,
  );
  equal('无匹配时返回空', queryItems(store.getHistory(), '不存在的词').length, 0);
  equal('空搜索词返回全部', queryItems(store.getHistory(), '').length, 3);

  const all = queryItems(store.getHistory(), '');
  check('置顶项排在最前', all[0].pinned === true, JSON.stringify(all.map((i) => i.pinned)));
  equal('其余按时间倒序', all.slice(1).map((i) => i.createdAt), [30, 20]);
  check('视图对象不外泄正文全文', all.every((i) => i.text === undefined));
  check('视图对象带上预览', all.every((i) => typeof i.preview === 'string'));
}

/* ---------------- 配置纠正 ---------------- */

console.log('\n[配置]');
{
  const fixed = normalizeConfig({ maxItems: 'abc', panelHeight: 10, pollInterval: 999999, junk: 1 });
  equal('非法条数回落默认值', fixed.maxItems, 50);
  equal('面板高度下限', fixed.panelHeight, 160);
  equal('轮询间隔上限', fixed.pollInterval, 5000);
  check('未知字段被丢弃', !('junk' in fixed));

  const { dir } = tempStore();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ 坏掉的 json', 'utf8');
  const store = new Store(dir);
  equal('配置文件损坏时用默认值启动', store.config.maxItems, 50);
}

/* ---------------- 快捷键 ---------------- */

console.log('\n[快捷键校验]');
{
  check('接受 Ctrl+Shift+V', isValidAccelerator('Ctrl+Shift+V'));
  check('接受 Alt+F1', isValidAccelerator('Alt+F1'));
  check('拒绝无修饰键的单键', !isValidAccelerator('V'));
  check('拒绝只有修饰键', !isValidAccelerator('Ctrl+Shift'));
  check('拒绝空字符串', !isValidAccelerator(''));
  check('拒绝残缺组合', !isValidAccelerator('Ctrl+'));
}

/* ---------------- 内容识别 ---------------- */

console.log('\n[内容识别]');
{
  equal('识别链接', guessKind('https://example.com/a?b=1'), 'url');
  equal('识别邮箱', guessKind('someone@example.com'), 'email');
  equal('识别 Windows 路径', guessKind('C:\\Users\\me\\note.txt'), 'path');
  equal('识别代码', guessKind('function add(a, b) {\n  return a + b;\n}'), 'code');
  equal('普通文本', guessKind('今天要买牛奶'), 'text');
  check('预览按长度截断', previewOf('x'.repeat(1000)).length <= 401);
  equal('标题取第一行非空内容', firstLine('\n\n  第一行有内容\n第二行'), '  第一行有内容');
}

/* ---------------- 剪贴板抓取（打真实系统剪贴板） ---------------- */

/**
 * 这一段直接调用 Electron 的剪贴板 API。
 * Electron 44 把 clipboard 从同步改成了异步（readText 返回 Promise），
 * 抓取功能因此整体失效过一次，所以这里必须用真实 API 跑一遍，
 * 光靠假数据测不出这类上游 API 变更。
 *
 * 代价是测试期间会短暂占用系统剪贴板，跑完会把原来的文本写回去。
 */
async function clipboardCaptureTests() {
  await app.whenReady();
  console.log('\n[剪贴板抓取（会短暂占用系统剪贴板）]');

  const restore = await clipboard.readText();
  try {
    const { store } = tempStore();
    let changes = 0;
    const watcher = new ClipboardWatcher(store, () => {
      changes += 1;
    });

    const sample = `剪贴板抓取测试 ${Date.now()}`;
    await clipboard.writeText(sample);
    await watcher.tick();
    equal('复制的文本被抓到', store.getHistory().map((it) => it.text), [sample]);
    equal('抓到后通知了界面', changes, 1);

    await watcher.tick();
    equal('内容没变时不会重复记录', store.getHistory().length, 1);

    const png = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).toPNG();
    await clipboard.write([imageClipboardItem(png)]);
    await watcher.tick();
    const image = store.getHistory()[0];
    check('复制的图片被抓到', Boolean(image) && image.type === 'image', image && image.type);
    check('图片已落盘', Boolean(image) && fs.existsSync(image.file));
    check('缩略图已生成', Boolean(image) && String(image.thumbnail).startsWith('data:image/png'));
    equal('图片尺寸正确', image && [image.width, image.height], [256, 256]);

    await watcher.tick();
    equal('同一张图不会重复记录', store.getHistory().length, 2);

    // resync 用于登记“已知内容”：启动时与应用自己写入剪贴板后都要调用
    const fresh = tempStore().store;
    const quiet = new ClipboardWatcher(fresh, () => {});
    await quiet.resync();
    await quiet.tick();
    equal('resync 之后当前剪贴板内容不会入库', fresh.getHistory().length, 0);

    // 粘贴助手：验证常驻 PowerShell 起得来、里面的 Win32 封装能编译、
    // 并且请求/回复协议通得过。这里只发只读的 capture，
    // 不发 focus / paste —— 那会抢焦点并把内容粘进当前前台窗口。
    const paster = new Paster();
    const hwnd = await paster.captureForegroundWindow();
    check(
      '粘贴助手能取到前台窗口句柄（Add-Type 与协议均正常）',
      typeof hwnd === 'string' && /^[1-9]\d*$/.test(hwnd),
      `返回 ${JSON.stringify(hwnd)}（若为 null，说明助手没起来或当前没有前台窗口）`,
    );
    const helper = paster._ensure();
    check('粘贴助手进程仍在运行', Boolean(helper) && helper.exitCode === null);
    paster.dispose();
  } finally {
    if (restore) await clipboard.writeText(restore);
    else clipboard.clear();
  }
}

/* ---------------- 结果 ---------------- */

function finish() {
  const total = passed + failures.length;
  console.log(`\n${passed}/${total} 通过`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  app.exit(failures.length ? 1 : 0);
}

clipboardCaptureTests()
  .catch((err) => {
    check('剪贴板抓取测试本身没有抛异常', false, err.message);
  })
  .then(finish);

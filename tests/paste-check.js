'use strict';

/**
 * 自动粘贴的集成自检：`npm run test:paste`
 *
 * 验证的是这条链路：面板抢走焦点之后，还能把内容粘回原来那个窗口。
 * 做法是自己造两个窗口——一个当“用户正在敲字的窗口”（里面有输入框），
 * 一个当“面板”（负责抢焦点）——然后走真实的 Paster：
 * 记录前台窗口 → 被抢焦点 → 激活回去 → 发 Ctrl+V → 读输入框内容核对。
 *
 * 注意：测试进程本身不是前台进程，Windows 会拒绝它调用 SetForegroundWindow，
 * 所以 BrowserWindow.focus() 在这里拿不到前台（桌面上真正的前台窗口会一直压着）。
 * 因此把目标窗口顶到前台这一步也交给 Paster 的 focus 命令 —— 它内部走
 * AttachThreadInput 绕开了这条限制，正是修复所依赖的机制。
 *
 * 单独一个脚本而不是并进 npm test，因为它会真的弹窗并短暂抢占焦点。
 */

const { app, BrowserWindow, clipboard } = require('electron');
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function handleOf(win) {
  const buffer = win.getNativeWindowHandle();
  const value = buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0));
  return value.toString();
}

async function load(win, html) {
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
}

/** 冒充“用户正在敲字的窗口”：一个自动聚焦的输入框 */
async function createTargetWindow() {
  const win = new BrowserWindow({
    width: 640,
    height: 220,
    title: 'PASTE-TARGET',
    show: false,
    webPreferences: { contextIsolation: true },
  });
  await load(
    win,
    `<!doctype html><meta charset="utf-8"><title>PASTE-TARGET</title>
     <body style="margin:0;font:14px system-ui">
       <p style="margin:8px">模拟“用户原来在敲字的窗口”，下面的输入框应当收到粘贴内容：</p>
       <textarea id="box" style="width:100%;height:120px;font:13px Consolas"></textarea>
       <script>document.getElementById('box').focus();</script>
     </body>`,
  );
  return win;
}

/** 冒充剪贴板面板：show + focus 抢走前台焦点 */
async function createThiefWindow() {
  const win = new BrowserWindow({
    width: 560,
    height: 140,
    title: 'FAKE-PANEL',
    show: false,
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true },
  });
  await load(
    win,
    `<!doctype html><meta charset="utf-8"><title>FAKE-PANEL</title>
     <body style="margin:0;background:#16191f;color:#e7eaf0;font:14px system-ui">
       <p style="margin:12px">模拟面板：已抢走焦点</p>
     </body>`,
  );
  return win;
}

app.whenReady().then(async () => {
  const paster = new Paster();

  console.log('\n[预热粘贴助手]');
  await paster.warmUp();
  check('助手预热完成（PowerShell 起来了、C# 编译通过）', paster.warmed);

  const target = await createTargetWindow();
  const targetHwnd = handleOf(target);
  target.show();
  await wait(300);

  console.log('\n[把目标窗口顶到前台]');
  const raised = await paster.focusWindow(targetHwnd);
  check('助手能把指定窗口顶到前台', raised);
  const captured = await paster.captureForegroundWindow();
  check('记录到的前台窗口就是目标窗口', captured === targetHwnd, `记录=${captured} 目标=${targetHwnd}`);
  await target.webContents.executeJavaScript("document.getElementById('box').focus()");

  console.log('\n[被面板抢走焦点]');
  const thief = await createThiefWindow();
  thief.show();
  thief.focus();
  await wait(600);
  const stolen = await paster.captureForegroundWindow();
  check('目标窗口确实丢了前台', stolen !== targetHwnd, `当前前台=${stolen}`);

  console.log('\n[取用内容并自动粘贴]');
  const sample = `自动粘贴验证-${Date.now()}`;
  await clipboard.writeText(sample);
  thief.hide();
  // 只往自己造的窗口发按键。绝不能拿 captured 当目标：
  // 它可能是桌面上属于别人的窗口，那样会把内容粘进用户正在用的程序里。
  const focused = await paster.paste(targetHwnd);
  check('目标窗口被重新激活', focused);
  await wait(800);

  const value = await target.webContents.executeJavaScript("document.getElementById('box').value");
  check('内容粘进了目标窗口的输入框', value === sample, `实际=${JSON.stringify(value)}`);

  const finalFg = await paster.captureForegroundWindow();
  check('粘贴后焦点仍在目标窗口', finalFg === targetHwnd, `当前前台=${finalFg}`);

  paster.dispose();
  thief.destroy();
  target.destroy();

  const total = passed + failures.length;
  console.log(`\n${passed}/${total} 通过`);
  if (failures.length) failures.forEach((f) => console.log(`  - ${f}`));
  app.exit(failures.length ? 1 : 0);
});

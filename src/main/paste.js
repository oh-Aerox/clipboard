'use strict';

const { spawn } = require('child_process');

/**
 * 负责“把选中的内容粘回用户原来在敲字的那个窗口”。
 *
 * 难点不在于发 Ctrl+V，而在于焦点：面板要能打字搜索就必须抢焦点，
 * 一抢焦点，用户原来那个窗口就不再是前台窗口了；而 BrowserWindow.hide()
 * 并不保证把焦点还回去（面板是 skipTaskbar 的置顶窗口，隐藏后焦点常常
 * 落到桌面上）。所以流程必须是：
 *
 *   1. 唤出面板【之前】先记下当时的前台窗口句柄（capture）
 *   2. 取用内容时隐藏面板，显式把那个窗口重新激活（focus）
 *   3. 确认它真的成为前台窗口之后，再发 Ctrl+V（paste）
 *
 * 这些都得调 Win32 API，Electron 没有对应接口，因此常驻一个 PowerShell
 * 进程来做。常驻而不是每次新起，是因为 powershell.exe 冷启动要 300ms 以上，
 * 而 capture 卡在唤出面板的路径上，慢一下用户立刻就能感觉到。
 */
/*
 * 脚本正文刻意全是 ASCII，注释也用英文。
 * 原因：Add-Type 会把这段 C# 落到临时 .cs 文件再交给编译器，中文注释在这一步
 * 的编码往返里会被打乱，严重到把注释和后面的函数签名并成一行、导致整个类编译
 * 失败（表现是助手启动即退出、粘贴功能整体失效）。中文说明一律留在 JS 侧。
 *
 * Focus() 里 AttachThreadInput 那一段是绕开 Win32 限制的常规做法：
 * SetForegroundWindow 只允许当前前台进程调用，而助手是独立进程，
 * 先把自己的线程输入队列挂到当前前台线程上再调用才会生效。
 * 激活是异步的，所以之后要轮询确认目标窗口真的到了前台再发按键。
 */
const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  public const int SW_RESTORE = 9;
  public const int ACTIVATE_TIMEOUT_MS = 400;

  public static bool Focus(IntPtr target) {
    if (target == IntPtr.Zero || !IsWindow(target)) return false;
    if (GetForegroundWindow() == target) return true;
    if (IsIconic(target)) ShowWindow(target, SW_RESTORE);

    uint pid;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint myThread = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != myThread
      && AttachThreadInput(myThread, fgThread, true);
    try {
      SetForegroundWindow(target);
      BringWindowToTop(target);
    } finally {
      if (attached) AttachThreadInput(myThread, fgThread, false);
    }

    for (int waited = 0; waited < ACTIVATE_TIMEOUT_MS; waited += 10) {
      if (GetForegroundWindow() == target) return true;
      System.Threading.Thread.Sleep(10);
    }
    return false;
  }
}
"@

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split(' ')
  $id = $parts[0]
  $cmd = if ($parts.Length -gt 1) { $parts[1] } else { '' }
  try {
    switch ($cmd) {
      'capture' {
        [Console]::Out.WriteLine("ok $id " + [Fg]::GetForegroundWindow().ToInt64())
      }
      'focus' {
        [Console]::Out.WriteLine("ok $id " + [Fg]::Focus([IntPtr][int64]$parts[2]).ToString().ToLower())
      }
      'paste' {
        $target = [IntPtr][int64]$parts[2]
        $focused = if ($target -eq [IntPtr]::Zero) { $false } else { [Fg]::Focus($target) }
        Start-Sleep -Milliseconds 60
        [System.Windows.Forms.SendKeys]::SendWait('^v')
        [Console]::Out.WriteLine("ok $id " + $focused.ToString().ToLower())
      }
      default { [Console]::Out.WriteLine("err $id unknown-command") }
    }
  } catch {
    [Console]::Out.WriteLine("err $id " + ($_.Exception.Message -replace '\\s+', ' '))
  }
  [Console]::Out.Flush()
}
`;

function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 冷启动要等 PowerShell 起进程并编译那段 C#，实测 1~2 秒 */
const COLD_TIMEOUT_MS = 8000;
/** 热起来之后一次往返只有几毫秒；capture 卡在唤出面板的路径上，超时给得很短 */
const CAPTURE_TIMEOUT_MS = 500;

class Paster {
  constructor() {
    this.proc = null;
    this.disabled = process.platform !== 'win32';
    /**
     * 已发出但还没收到回复的命令，按请求 id 配对。
     * 不能按先进先出配对：超时的命令会被摘掉，它迟到的回复会被错配给下一条命令。
     * @type {Map<string, {resolve: Function, timer: NodeJS.Timeout}>}
     */
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutBuffer = '';
    /** 助手是否已经回过至少一次话（即 C# 已编译完） */
    this.warmed = false;
    this._lastErrorMessage = null;
  }

  /**
   * 提前把常驻进程拉起来并让它编译好 C#。
   * 发一条只读的 capture 当作预热，结果丢掉不用。
   */
  warmUp() {
    if (this.disabled) return Promise.resolve();
    return this._send('capture', COLD_TIMEOUT_MS).then(() => undefined);
  }

  _ensure() {
    if (this.disabled || (this.proc && !this.proc.killed)) return this.proc;
    try {
      this.proc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-EncodedCommand',
          encodeCommand(HELPER_SCRIPT),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );

      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', (data) => this._reportStderr(data));
      this.proc.on('error', (err) => {
        this._reportError(err.message);
        this._teardown();
      });
      this.proc.on('exit', () => this._teardown());
    } catch (err) {
      this._reportError(err.message);
      this.proc = null;
    }
    return this.proc;
  }

  _teardown() {
    this.proc = null;
    this.stdoutBuffer = '';
    this.warmed = false;
    // 进程没了，等回复的命令一律按失败收尾，别让调用方悬着
    const waiting = [...this.pending.values()];
    this.pending.clear();
    waiting.forEach(({ resolve, timer }) => {
      clearTimeout(timer);
      resolve(null);
    });
  }

  _onStdout(chunk) {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) this._settle(line);
      index = this.stdoutBuffer.indexOf('\n');
    }
  }

  /** 回复格式：`ok <id> <payload>` 或 `err <id> <message>` */
  _settle(line) {
    const match = line.match(/^(ok|err) (\d+)(?: ([\s\S]*))?$/);
    if (!match) {
      this._reportError(`无法解析助手回复：${line}`);
      return;
    }
    const [, status, id, payload = ''] = match;
    const entry = this.pending.get(id);
    // 找不到对应命令说明它已经超时被摘掉了，丢弃这条迟到的回复
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    this.warmed = true;
    if (status === 'ok') {
      entry.resolve(payload.trim());
    } else {
      this._reportError(payload.trim());
      entry.resolve(null);
    }
  }

  /**
   * 发一条命令并等回复。
   * @returns {Promise<string|null>} 回复内容，超时或助手不可用时为 null
   */
  _send(command, timeoutMs) {
    if (this.disabled) return Promise.resolve(null);
    const proc = this._ensure();
    if (!proc || !proc.stdin.writable) return Promise.resolve(null);

    const id = String(this.nextId++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this._reportError(`命令超时：${command}`);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        proc.stdin.write(`${id} ${command}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        this._reportError(err.message);
        resolve(null);
      }
    });
  }

  /** 助手还没回过话时要给足编译 C# 的时间，之后才用短超时 */
  _timeoutFor(hotMs) {
    return this.warmed ? hotMs : COLD_TIMEOUT_MS;
  }

  /**
   * 记下当前前台窗口，必须在面板抢走焦点之前调用。
   * @returns {Promise<string|null>} 窗口句柄（十进制字符串）
   */
  async captureForegroundWindow() {
    const reply = await this._send('capture', this._timeoutFor(CAPTURE_TIMEOUT_MS));
    if (!reply || reply === '0') return null;
    return /^\d+$/.test(reply) ? reply : null;
  }

  /** 把指定窗口重新激活为前台窗口（不发按键），主要用于自检 */
  async focusWindow(hwnd) {
    if (!hwnd) return false;
    return (await this._send(`focus ${hwnd}`, this._timeoutFor(2000))) === 'true';
  }

  /**
   * 激活目标窗口并发送 Ctrl+V。
   * @param {string|null} hwnd 唤出面板前记下的窗口句柄
   * @returns {Promise<boolean>} 目标窗口是否成功回到前台
   */
  async paste(hwnd) {
    const reply = await this._send(`paste ${hwnd || 0}`, this._timeoutFor(2500));
    return reply === 'true';
  }

  /**
   * stderr 被重定向时，PowerShell 会先吐一行 `#< CLIXML` 和一段 XML 包头，
   * 这是它的序列化格式而不是错误，过滤掉免得看起来像出了问题。
   */
  _reportStderr(data) {
    const text = String(data)
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('#< CLIXML') && !line.startsWith('<Objs'))
      .join(' ')
      .trim();
    if (text) this._reportError(text);
  }

  _reportError(message) {
    const text = String(message || '').trim();
    if (!text || text === this._lastErrorMessage) return;
    this._lastErrorMessage = text;
    console.error('[paste]', text);
  }

  dispose() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch {
        /* 进程可能已退出 */
      }
      this.proc = null;
    }
  }
}

module.exports = { Paster };

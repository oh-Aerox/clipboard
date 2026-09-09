'use strict';

const { spawn } = require('child_process');

/**
 * 常驻一个 PowerShell 进程来发送 Ctrl+V。
 * 每次粘贴都新起一个 powershell.exe 要 300ms 以上，常驻后单次粘贴只是一行 stdin。
 */
const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'paste') {
    Start-Sleep -Milliseconds 70
    [System.Windows.Forms.SendKeys]::SendWait('^v')
  }
}
`;

function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

class Paster {
  constructor() {
    this.proc = null;
    this.disabled = process.platform !== 'win32';
  }

  _ensure() {
    if (this.disabled || (this.proc && !this.proc.killed)) return this.proc;
    try {
      this.proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodeCommand(HELPER_SCRIPT)],
        { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
      );
      this.proc.on('error', () => {
        this.proc = null;
      });
      this.proc.on('exit', () => {
        this.proc = null;
      });
      this.proc.stderr.on('data', (d) => {
        if (process.env.CLIPBOARD_DEBUG) console.error('[paste]', String(d).trim());
      });
    } catch {
      this.proc = null;
    }
    return this.proc;
  }

  /** 向当前前台窗口发送 Ctrl+V */
  paste() {
    if (this.disabled) return false;
    const proc = this._ensure();
    if (!proc || !proc.stdin.writable) return false;
    try {
      proc.stdin.write('paste\n');
      return true;
    } catch {
      this.proc = null;
      return false;
    }
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

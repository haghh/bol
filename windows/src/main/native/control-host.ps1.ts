// The PowerShell side of computer control: one long-lived powershell.exe running this script, which reads
// one JSON request per line on stdin and answers with one JSON line on stdout. Kept alive so each action
// costs milliseconds instead of PowerShell's ~300 ms startup. All coordinates here are physical screen
// pixels; mapping from screenshot pixels happens in windows-control.ts.
//
// Requests: {op, ...}. Replies: {ok: true, ...} or {ok: false, error}.

export const CONTROL_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BolNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

  static void Send(INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT Mouse(uint flags, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }

  public static void MouseButton(string button, bool down) {
    uint f = 0;
    if (button == "left") f = down ? 0x0002u : 0x0004u;
    else if (button == "right") f = down ? 0x0008u : 0x0010u;
    else f = down ? 0x0020u : 0x0040u;
    Send(new[] { Mouse(f, 0) });
  }
  public static void Wheel(int delta, bool horizontal) { Send(new[] { Mouse(horizontal ? 0x01000u : 0x0800u, unchecked((uint)delta)) }); }
  static bool IsExtended(ushort vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x6F || vk == 0x90 || vk == 0xA3 || vk == 0xA5;
  }
  public static void KeyEvent(ushort vk, bool down) {
    uint f = (down ? 0u : 0x0002u) | (IsExtended(vk) ? 0x0001u : 0u);
    Send(new[] { Key(vk, 0, f) });
  }
  public static void TypeText(string text) {
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { KeyEvent(0x0D, true); KeyEvent(0x0D, false); continue; }
      Send(new[] { Key(0, c, 0x0004u), Key(0, c, 0x0004u | 0x0002u) });
    }
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static RECT Bounds(IntPtr h) {
    RECT r;
    // DWMWA_EXTENDED_FRAME_BOUNDS excludes the invisible resize borders GetWindowRect includes.
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }
}
"@
# Physical pixels everywhere (per-monitor DPI aware v2), so screenshots and clicks agree on high-DPI screens.
[void][BolNative]::SetProcessDpiAwarenessContext([IntPtr](-4))

function Capture($x, $y, $w, $h, $maxSide) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $g.Dispose()
  $scale = [Math]::Min(1.0, $maxSide / [Math]::Max($w, $h))
  $ow = [Math]::Max(1, [int]($w * $scale)); $oh = [Math]::Max(1, [int]($h * $scale))
  $out = $bmp
  if ($scale -lt 1.0) {
    $out = New-Object System.Drawing.Bitmap $ow, $oh
    $g2 = [System.Drawing.Graphics]::FromImage($out)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($bmp, 0, 0, $ow, $oh)
    $g2.Dispose(); $bmp.Dispose()
  }
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 80L
  $ms = New-Object System.IO.MemoryStream
  $out.Save($ms, $codec, $params)
  $out.Dispose()
  @{ image = [Convert]::ToBase64String($ms.ToArray()); x = $x; y = $y; width = $w; height = $h; imageWidth = $ow; imageHeight = $oh }
}

function Foreground() {
  $h = [BolNative]::GetForegroundWindow()
  $procId = 0
  [void][BolNative]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = ''; $path = ''
  try { $p = Get-Process -Id $procId; $name = $p.ProcessName; $path = $p.Path } catch {}
  $r = [BolNative]::Bounds($h)
  @{ handle = [int64]$h; app = $name; path = $path; title = [BolNative]::Title($h); x = $r.Left; y = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top }
}

function Screens() {
  @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    @{ name = $_.DeviceName.TrimStart('\', '.'); isPrimary = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height }
  })
}

function Handle($req) {
  switch ($req.op) {
    'ping' { return @{} }
    'foreground' { return Foreground }
    'screens' { return @{ screens = Screens } }
    'capture' { return Capture $req.x $req.y $req.width $req.height $req.maxSide }
    'move' { [void][BolNative]::SetCursorPos($req.x, $req.y); return @{} }
    'cursor' { $p = New-Object BolNative+POINT; [void][BolNative]::GetCursorPos([ref]$p); return @{ x = $p.X; y = $p.Y } }
    'button' { [BolNative]::MouseButton($req.button, [bool]$req.down); return @{} }
    'wheel' { [BolNative]::Wheel([int]$req.delta, [bool]$req.horizontal); return @{} }
    'key' { [BolNative]::KeyEvent([uint16]$req.vk, [bool]$req.down); return @{} }
    'type' { [BolNative]::TypeText([string]$req.text); return @{} }
    'vkScan' {
      # VkKeyScan for punctuation on the current keyboard layout: low byte VK, high byte shift state.
      Add-Type -Name K -Namespace BolKb -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char c);' -ErrorAction SilentlyContinue
      return @{ code = [int][BolKb.K]::VkKeyScan([char]$req.char) }
    }
    'readClipboard' { return @{ text = [string](Get-Clipboard -Raw) } }
    'writeClipboard' { Set-Clipboard -Value ([string]$req.text); return @{} }
    'open' {
      $q = [string]$req.app
      if (Test-Path -LiteralPath $q) { Start-Process -FilePath $q; return @{ how = 'path' } }
      # Running already? Bring its main window forward.
      $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like "*$q*" -or $_.MainWindowTitle -like "*$q*") } | Select-Object -First 1
      if ($running) {
        $h = $running.MainWindowHandle
        if ([BolNative]::IsIconic($h)) { [void][BolNative]::ShowWindow($h, 9) }
        [void][BolNative]::SetForegroundWindow($h)
        return @{ how = 'focused'; name = $running.ProcessName }
      }
      # Installed apps as the Start menu knows them (desktop and Store apps alike).
      $app = Get-StartApps | Where-Object { $_.Name -eq $q } | Select-Object -First 1
      if (-not $app) { $app = Get-StartApps | Where-Object { $_.Name -like "*$q*" } | Select-Object -First 1 }
      if ($app) { Start-Process ("shell:AppsFolder\" + $app.AppID); return @{ how = 'start'; name = $app.Name } }
      Start-Process -FilePath $q
      return @{ how = 'run' }
    }
    default { throw "unknown op $($req.op)" }
  }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.WriteLine('{"ok":true,"ready":true}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try {
    $req = $line | ConvertFrom-Json
    $res = Handle $req
    if ($null -eq $res) { $res = @{} }
    $res.ok = $true
    $res.id = $req.id
  } catch {
    $res = @{ ok = $false; id = $req.id; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 5 $res))
}
`

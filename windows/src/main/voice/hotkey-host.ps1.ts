// The push-to-talk keyboard hook, as a PowerShell script. Electron's globalShortcut only says "pressed", never
// "released", so hold-to-talk needs a low-level keyboard hook (WH_KEYBOARD_LL). It runs in its own PowerShell
// process, like the control host, and prints one line per event on stdout:
//   ready        the hook is installed
//   down / up    the combo went down / came up (the combo's keys are swallowed so Alt+Space doesn't also
//                open the window menu of the app in front)
// The combo comes in through environment variables. The process exits when its stdin closes.
// Events injected by other programs (such as Bol's own typing via SendInput) are ignored.
//
// Untested on a real keyboard from CI: see the README's "Not verified" note.

export const HOTKEY_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class BolHotkey {
	delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
	[StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr extra; }
	[StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
	[DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr module, uint thread);
	[DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
	[DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
	[DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
	[DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
	[DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

	static HookProc proc = Callback;
	static int key;
	static bool wantAlt, wantCtrl, wantShift, wantWin;
	static bool isHeld, isSwallowingUp;

	static bool IsDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

	static bool ModsMatch() {
		return IsDown(0x12) == wantAlt && IsDown(0x11) == wantCtrl && IsDown(0x10) == wantShift && (IsDown(0x5B) || IsDown(0x5C)) == wantWin;
	}

	static bool IsModifier(int vk) {
		return vk == 0x12 || vk == 0xA4 || vk == 0xA5 || vk == 0x11 || vk == 0xA2 || vk == 0xA3 || vk == 0x10 || vk == 0xA0 || vk == 0xA1 || vk == 0x5B || vk == 0x5C;
	}

	static void Emit(string line) {
		Console.Out.WriteLine(line);
		Console.Out.Flush();
	}

	// Pressing and releasing an unassigned key makes Windows treat Alt (or Win) as "used", so letting go of it
	// doesn't pop the menu bar or Start menu.
	static void ConsumeModifier() {
		keybd_event(0xE8, 0, 0, UIntPtr.Zero);
		keybd_event(0xE8, 0, 2, UIntPtr.Zero);
	}

	static IntPtr Callback(int code, IntPtr wParam, IntPtr lParam) {
		if (code >= 0) {
			KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
			if ((k.flags & 0x10) == 0) { // not injected
				int msg = wParam.ToInt32();
				bool isDownMsg = msg == 0x100 || msg == 0x104;
				bool isUpMsg = msg == 0x101 || msg == 0x105;
				int vk = (int)k.vkCode;
				if (vk == key) {
					if (isDownMsg) {
						if (isHeld || isSwallowingUp) return (IntPtr)1; // auto-repeat
						if (ModsMatch()) {
							isHeld = true;
							ConsumeModifier();
							Emit("down");
							return (IntPtr)1;
						}
					} else if (isUpMsg) {
						if (isHeld) { isHeld = false; Emit("up"); return (IntPtr)1; }
						if (isSwallowingUp) { isSwallowingUp = false; return (IntPtr)1; }
					}
				} else if (isHeld && isUpMsg && IsModifier(vk)) {
					// A modifier came up before the key: that ends the hold; the key's own release is swallowed later.
					isHeld = false;
					isSwallowingUp = true;
					Emit("up");
				}
			}
		}
		return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
	}

	public static void Run(int vk, bool alt, bool ctrl, bool shift, bool win) {
		key = vk; wantAlt = alt; wantCtrl = ctrl; wantShift = shift; wantWin = win;
		IntPtr hook = SetWindowsHookEx(13, proc, GetModuleHandle(null), 0);
		if (hook == IntPtr.Zero) { Emit("error hook " + Marshal.GetLastWin32Error()); Environment.Exit(1); }
		Thread watcher = new Thread(delegate() {
			while (Console.In.ReadLine() != null) { }
			Environment.Exit(0);
		});
		watcher.IsBackground = true;
		watcher.Start();
		Emit("ready");
		MSG m;
		while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
	}
}
"@
[BolHotkey]::Run([int]$env:BOL_VK, $env:BOL_ALT -eq '1', $env:BOL_CTRL -eq '1', $env:BOL_SHIFT -eq '1', $env:BOL_WIN -eq '1')
`

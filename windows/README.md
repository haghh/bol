# Bol for Windows

**Talk to your PC. An AI agent does the work.** Hold a hotkey, say what you need, and Bol
does it on your Windows PC, then tells you in a sentence when it's done. It runs hands-off: no approval
prompts.

This is a Windows port of [Bol](https://github.com/mehulmpt/bol) by Mehul Mohan, a macOS menu-bar app,
released under the MIT license. The agent logic, prompts, tools and threads model are his; this folder
replaces the macOS shell (Swift, AppleScript, `screencapture`) with Electron, React and PowerShell/Win32.
It is an independent project and is not affiliated with or endorsed by Anthropic.

> [!WARNING]
> Bol runs its agent with **permission checks off**: it acts on your PC without asking first. See
> [Safety](#safety) for what it does instead.

## Status

| Build step (from the project brief)            | State                                       |
| ---------------------------------------------- | ------------------------------------------- |
| 1. Brain on Windows, text in/out, Claude Code  | Done (`npm run brain`)                      |
| 2. Tray app, hotkey, React voice bar           | Done, typed input                           |
| 3. Voice in and out (Whisper, Windows voices)  | Done: hold Alt+Space to talk, replies are spoken. See [Voice](#voice) |
| 4. Screenshot and click control                | Done (PowerShell + Win32), needs testing on a real PC |
| 5. API-key backends (Anthropic, OpenAI, Gemini)| Not started; contract in `src/main/engine.ts` |
| Later: threads window, dictation, auto-update  | Not started                                 |

## Run it

You need Windows 10 or 11, [Node.js](https://nodejs.org) 22+, [Git for Windows](https://git-scm.com/download/win)
(Claude Code's shell tool uses Git Bash), and [Claude Code](https://claude.com/claude-code) signed in with a
Claude subscription:

```powershell
irm https://claude.ai/install.ps1 | iex   # installs claude.exe in ~\.local\bin
claude                                    # sign in once, then exit
```

Then, from this folder:

```powershell
npm install
npm run brain    # step 1: talk to the brain in the terminal (type, Enter; /new, /stop, /mcp)
npm run dev      # the tray app; hold Alt+Space anywhere and talk
npm run dist     # a Windows installer in dist/
```

## Settings

`%USERPROFILE%\.bol\settings.json` (tray menu → Settings). It's created with defaults on first run, and
changes apply without a restart:

| Key          | Default         | Meaning |
| ------------ | --------------- | ------- |
| `hotkey`     | `Alt+Space`     | Hold to talk, tap to open the bar ([Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator); modifiers plus one key) |
| `backend`    | `claude-code`   | Which engine runs requests. Only `claude-code` exists so far |
| `model`      | `null`          | Model override; `null` uses Claude Code's default |
| `effort`     | `medium`        | `medium`, `high`, `xhigh` or `max` |
| `screen`     | `auto`          | `off` removes the screenshot and control tools |
| `chrome`     | `true`          | Load the Claude in Chrome tools when the extension is installed |
| `workspace`  | `null`          | Folder the agent works in; `null` is `~\.bol\workspace` |
| `claudePath` | `null`          | Path to `claude.exe` if it isn't found automatically |
| `askFirst`   | `false`         | Ask in the voice bar before each action |
| `voice`      | local Whisper, Windows voices | `stt`, `tts`, `voiceName`, `isSpeaking`, `muteMicWhileSpeaking`; easiest set from the gear in the voice bar (see [Voice](#voice)) |
| `language`   | `null`          | Spoken language for speech-to-text, like `en`; `null` detects it |
| `whisperModel` | `base`        | Local Whisper size: `tiny`, `base` or `small` |

The rest of `~\.bol` matches the original: `mcp.json` for your own MCP servers, `system_prompt.md` to
replace the built-in instructions, `memory\`, `threads\`, `tasks.jsonl`.

## Voice

Hold **Alt+Space**, speak, let go. The bar shows *Listening* while you hold, *Thinking* while your words are
turned into text and Bol works, and *Speaking* while the reply is read aloud. A quick tap of the hotkey still
just opens or closes the bar, and you can always type instead. Pressing the hotkey while Bol is talking
interrupts it; **Esc** also stops it.

Click the gear in the bar to pick providers and enter API keys. The defaults need no account and no key:
**Whisper (local)** to hear you and **Windows voices** to speak.

| Hearing (speech-to-text) | Setup |
| --- | --- |
| **Whisper, local** (default) | Nothing to do. On first use Bol downloads [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (9 MB) and the `base` model (142 MB) into `~\.bol\voice`, checks their SHA-256, and then works offline. Pick `tiny` (75 MB, fastest) or `small` (466 MB, most accurate) in the gear menu. To use your own files, put `whisper-cli.exe` and its DLLs under `~\.bol\voice\whisper\b5454\Release` and the model at `~\.bol\voice\whisper\models\ggml-base.bin`. |
| **OpenAI transcription** | Create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys), paste it in the gear menu under *OpenAI key*. Uses `gpt-4o-mini-transcribe`. |
| **Deepgram** | Create a key at [console.deepgram.com](https://console.deepgram.com), paste it under *Deepgram key*. Uses `nova-3`. |

| Speaking (text-to-speech) | Setup |
| --- | --- |
| **Windows voices** (default) | Nothing to do. Uses the voices installed in Windows (SAPI). Add more under Settings > Time & language > Speech. |
| **Piper, local** | Nothing to do. On first use Bol downloads [Piper](https://github.com/rhasspy/piper) (22 MB) and the `en_US-lessac-medium` voice (63 MB), then works offline. Other voices: download a `.onnx` and its `.onnx.json` from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) into `~\.bol\voice\piper\voices`; they appear in the *Voice* list. |
| **OpenAI voices** | Same OpenAI key as above. Uses `gpt-4o-mini-tts`. |
| **ElevenLabs** | Create a key at [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys), paste it under *ElevenLabs key*. Your voices appear in the *Voice* list. |

**Where keys live.** Keys are encrypted with Windows (Electron `safeStorage`, DPAPI, tied to your Windows
account) and saved in `~\.bol\secrets.json`. They are never written to `settings.json`, never sent to the voice
bar's web page (it only learns *whether* a key is set) and never logged. If Windows' secure storage isn't
available, Bol refuses to save a key rather than store it in plain text. Remove a key with *Remove* in the gear menu.

**When something goes wrong** the bar shows one short line and carries on: no microphone, microphone blocked
(Windows Settings > Privacy > Microphone > let desktop apps use it), a missing or rejected API key, a quota
limit, no network, or a download that failed. Nothing prompts you.

**Good to know**

- Hold-to-talk uses a Windows keyboard hook (a small PowerShell helper, `src/main/voice/hotkey-host.ps1.ts`),
  because Electron's shortcuts can't see a key being released. It swallows the combo so Alt+Space doesn't also
  open the window menu of the app in front. It can't see keys while a window running **as administrator** has
  focus (a Windows rule). If the hook can't start, the hotkey falls back to a plain toggle, and the bar says so.
- The cloud providers send your audio (or reply text) to that company. The local ones never leave your PC.
- Only `Alt+Space`-style combos (modifiers plus one key, or a lone F-key) can hold-to-talk.
- `npm run voice:smoke` downloads the local engines and checks, on your PC, that Windows voices and Piper can
  be understood by Whisper.

## Safety

There are no prompts, so mistakes have to stay undoable:

- **Recycle Bin, not delete.** The agent is told never to delete permanently and gets a
  `move_to_recycle_bin` tool.
- **Copies before overwriting.** Before the Write or Edit tools change an existing file that Bol didn't
  create in this run, a copy goes to `~\.bol\backups\<date>\`.
- **A short hard-block list,** refused whatever the model says (`src/main/brain/safety.ts`): formatting or
  wiping disks, diskpart, deleting shadow copies or backups, editing the boot configuration, emptying the
  Recycle Bin, deleting a registry hive or top-level key, and recursive deletes of your home folder, its main
  folders, a drive root, Windows, Program Files or Users.
- **An action log,** `~\.bol\actions.jsonl`: every tool call with a timestamp, including blocked ones.
- **Ask first,** off by default (`askFirst` in settings).

## How it fits together

```
src/
  main/                  Electron main process
    index.ts             tray, hotkey, voice bar window, IPC
    secrets.ts           API keys encrypted with the OS (safeStorage)
    voice/               hearing and speaking: providers, push-to-talk hook, downloads (see Voice)
    engine.ts            the swappable backend interface
    brain/               the original Bol brain, ported from Bun to Node (Claude Code engine)
      session.ts         conversations and tasks over the Claude Agent SDK
      safety.ts          hard-block list, backups, action log, Recycle Bin, ask-first
      control.ts         computer-control tool definitions
      constants.ts       paths and the Windows prompts
    native/              Windows layer: PowerShell host calling Win32 (input, screenshots, windows, apps)
  preload/               the bridge the voice bar uses
  renderer/              React voice bar: mic capture, audio playback, voice settings
  shared/                events, settings and voice contracts shared by both sides
scripts/brain-cli.ts     step 1: the brain in a terminal
```

The original ran its brain as a separate Bun executable spoken to over JSON lines on stdin/stdout. Here the
brain runs inside the Electron main process, and the same events travel on an in-process bus
(`src/main/brain/protocol.ts`, typed in `src/shared/events.ts`).

## License

MIT, as the original. Copyright (c) 2026 Mehul Mohan; see [LICENSE](../LICENSE).

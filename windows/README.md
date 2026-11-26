# Bol for Windows

**Talk to your PC. An AI agent does the work.** Press a hotkey, say (for now: type) what you need, and Bol
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
| 3. Voice in and out (Whisper, Windows voices)  | Not started; contracts in `src/shared/voice.ts` |
| 4. Screenshot and click control                | Done (PowerShell + Win32), needs testing on a real PC |
| 5. API-key backends (Anthropic, OpenAI, Gemini)| Done, see [Backends](#backends); not tried with real keys yet |
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
npm run dev      # the tray app; press Alt+Space anywhere for the voice bar
npm run dist     # a Windows installer in dist/
```

## Settings

`%USERPROFILE%\.bol\settings.json` (tray menu → Settings). It's created with defaults on first run, and
changes apply without a restart:

| Key          | Default         | Meaning |
| ------------ | --------------- | ------- |
| `hotkey`     | `Alt+Space`     | Opens the voice bar ([Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator)) |
| `backend`    | `claude-code`   | `claude-code`, `anthropic`, `openai` or `gemini` (see [Backends](#backends)) |
| `model`      | `null`          | Model override; `null` uses the backend's default |
| `effort`     | `medium`        | `medium`, `high`, `xhigh` or `max` |
| `screen`     | `auto`          | `off` removes the screenshot and control tools |
| `chrome`     | `true`          | Load the Claude in Chrome tools when the extension is installed |
| `workspace`  | `null`          | Folder the agent works in; `null` is `~\.bol\workspace` |
| `claudePath` | `null`          | Path to `claude.exe` if it isn't found automatically |
| `askFirst`   | `false`         | Ask in the voice bar before each action |
| `voice`      | Whisper, Windows voices | For build step 3 |

The rest of `~\.bol` matches the original: `mcp.json` for your own MCP servers, `system_prompt.md` to
replace the built-in instructions, `memory\`, `threads\`, `tasks.jsonl`.

## Backends

Switch with `backend` in settings; Bol restarts the engine on its own.

| Backend       | Signs in with                      | Default model        | Tools |
| ------------- | ---------------------------------- | -------------------- | ----- |
| `claude-code` | your Claude subscription, through the Claude Code you installed | Claude Code's default | everything Claude Code has, plus Bol's control tools, tasks, skills and memory |
| `anthropic`   | an Anthropic API key               | `claude-opus-5-5`    | the minimal set below |
| `openai`      | an OpenAI API key                  | `gpt-5.6`            | the minimal set below |
| `gemini`      | a Google AI Studio API key         | `gemini-pro-latest`  | the minimal set below |

The API-key backends run Bol's own tool loop on the [Vercel AI SDK](https://ai-sdk.dev) with a deliberately
small tool set: `run_command` (PowerShell), `read_file`, `write_file`, `move_to_recycle_bin`,
`look_at_screen` and the computer-control tools, plus your MCP servers from `mcp.json`. The same safety
rules apply to every tool. Background tasks, skills and memory are Claude Code features and aren't there
yet. Each API call is billed to your key, and screenshots from earlier requests are dropped from the
conversation to keep that down.

Save a key once; it's encrypted for your Windows account (DPAPI) in `~\.bol\keys.json`:

```powershell
npm run set-key -- anthropic     # or openai, gemini; paste the key when asked
```

An environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) works too
and takes precedence. Other subscriptions will only ever come in through their vendor's official CLI login.

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
    engine.ts            the swappable backend interface (engines.ts picks one)
    api/                 the API-key engines: tool loop, tools, providers, encrypted keys
    brain/               the original Bol brain, ported from Bun to Node (Claude Code engine)
      session.ts         conversations and tasks over the Claude Agent SDK
      safety.ts          hard-block list, backups, action log, Recycle Bin, ask-first
      control.ts         computer-control tool definitions
      constants.ts       paths and the Windows prompts
    native/              Windows layer: PowerShell host calling Win32 (input, screenshots, windows, apps)
  preload/               the bridge the voice bar uses
  renderer/              React voice bar
  shared/                events, settings and voice contracts shared by both sides
scripts/brain-cli.ts     step 1: the brain in a terminal
```

The original ran its brain as a separate Bun executable spoken to over JSON lines on stdin/stdout. Here the
brain runs inside the Electron main process, and the same events travel on an in-process bus
(`src/main/brain/protocol.ts`, typed in `src/shared/events.ts`).

## License

MIT, as the original. Copyright (c) 2026 Mehul Mohan; see [LICENSE](../LICENSE).

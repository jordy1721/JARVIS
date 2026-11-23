# JARVIS — your personal AI desktop assistant

A desktop app (Windows, macOS, Linux) that gives Claude hands, eyes, ears and a voice on your computer:

- **Talk to it**: push-to-talk hotkey or open mic with a wake word ("Jarvis, …"). Speech recognition runs **locally** (Whisper), so it's free and private.
- **It talks back**: your system's built-in voices (free), or an optional ElevenLabs voice.
- **It does things**: runs commands, launches apps, opens files and sites, reads and writes files, and sees and controls the screen (mouse and keyboard).
- **It shows you how**: say "show me how to…" and it draws highlights, arrows and step cards **over your screen** instead of doing it for you.
- **It remembers**: facts about you (preferences, people, routines, work), a diary of every past conversation it can search ("what did we talk about last week?"), and the current conversation even after you restart the app. Everything stays on your computer, and you can view and edit it on the Memory page.
- **Runs on your Claude Pro/Max subscription**: no API key or credits needed. It works through Claude Code, Anthropic's official app included with your plan. You can switch to a pay-per-use API key instead if you prefer.
- **A full app around it**: Dashboard, Assistant chat, Tasks (to-dos, reminders, scheduled automations), Memory, Activity Log (every action it took), Settings.
- **It can change its own code**: ask for a new feature and it reads its source and proposes a diff. **Nothing changes until you approve it in Code Lab.** Each applied change is a git commit you can revert with one click.

## Quick start

You'll need **Node.js 20+** and **git**.

```bash
git clone <this repo> jarvis && cd jarvis
npm install
npm run dev
```

1. Open **Settings → Connection** and keep **My Claude subscription** selected:
   1. Click **Install Claude Code**. A terminal opens and runs Anthropic's official installer.
   2. Click **Sign in to Claude**. A terminal opens Claude Code: pick *Claude account with subscription* and log in with your Pro account. When you see Claude Code's prompt, close the terminal.
   3. Click **Test**.

   (If you'd rather pay per use, pick **Anthropic API key** instead and paste a key from [console.anthropic.com](https://console.anthropic.com).)
2. Press **Ctrl+Shift+Space** (⌘+Shift+Space on Mac), speak, then press it again. The first time, the speech model downloads (about 80 MB, one time only).
3. Press **Ctrl+Shift+X** at any time to stop whatever JARVIS is doing.

To build an installer: `npm run dist:win`, `npm run dist:mac` or `npm run dist:linux` (output goes to `release/`).

> **Self-modification needs the source folder.** Run JARVIS with `npm run dev` from the cloned repo. Dev mode watches files, so approved changes reload by themselves. An installed build can't edit itself unless you point *Settings → Source folder* at a git checkout.

### OS permissions

- **macOS**: allow JARVIS under System Settings → Privacy & Security, for **Microphone**, **Screen Recording** (so it can see the screen) and **Accessibility** (so it can control the mouse and keyboard).
- **Windows**: no extra steps. To control apps running as administrator, JARVIS must also run as administrator.
- **Linux**: X11 works best. Wayland may block screen capture and input control.

## Using your Claude subscription (no credits)

On the **subscription** route, JARVIS sends each request through your own copy of Claude Code (`claude -p`) running on your computer. You sign in to Claude Code with Anthropic's own login, so JARVIS never sees or stores your password or login token. JARVIS gives Claude Code its tools (tasks, memory, screen control and so on) through a small local connection that only works on your machine.

- **Cost**: nothing extra. Requests count toward your plan's usage limits, which are shared with claude.ai. The dashboard shows your 5-hour and weekly usage.
- **Usage limits**: everyday requests use **Haiku**, which uses the least of your plan. Hard requests (coding, analysis, changing its own code) use **Sonnet**. You can change both in Settings.
- **Personal use**: Anthropic lets you sign in to Claude Code with your own subscription. Its terms don't let developers offer Claude.ai login in their own products, or route other people's requests through subscription plans. So keep this setup for yourself. Anyone else who uses JARVIS should sign in with their own account or use an API key.
- **Speed**: each request starts Claude Code, which adds about a second compared to the API route.

## Keeping costs low (API key route)

JARVIS is built to cost cents per day, not dollars:

| Lever | What it does |
|---|---|
| **Model routing** | Most requests go to **Claude Haiku 5.5** ($0.10 / $0.50 per million tokens). Only hard requests (coding, analysis, self-modification) go to the smart model, or when Haiku decides to `escalate`. You can change both models in Settings. |
| **Prompt caching** | The system prompt and tool list stay byte-for-byte identical, so they're read from cache at a fraction of the normal price. |
| **Local voice** | Speech-to-text (Whisper) and text-to-speech (OS voices) run on your machine, so they cost $0. |
| **Cheap tools first** | It runs a command or opens an app directly before falling back to screenshots and clicking. Screenshots are downscaled to about 1,300 tokens each. |
| **Short contexts** | Conversations roll over into a fresh context after 20 minutes idle or about 40K tokens. Memory carries the continuity forward, so long chats don't keep getting more expensive. |
| **Hard limits** | A daily spending cap (default **$1**) and a cap on steps per request. The dashboard shows spend per day and per model, plus the cache hit rate. |

As a rough guide, a typical spoken command on Haiku costs around **$0.0005**, and one that takes a few screenshots around $0.002–0.005.

## Safety

- **Approval modes**: *ask before risky actions* (the default), *ask before every action*, or *fully autonomous*. In the default mode, JARVIS asks before running shell commands and writing files. It also asks once per request before it takes control of the mouse and keyboard.
- **Emergency stop hotkey** (Ctrl/⌘+Shift+X), also in the tray menu.
- **Activity Log** records every action, including the ones you denied.
- **Self-modification** only ever *proposes* changes. You review the full diff before anything is written, and every change can be reverted.
- All data (memory, tasks, chat, usage) is stored as JSON in your app-data folder, never on a server. Only the parts each request needs are sent to the Claude API.

## Project layout

```
src/
  main/                    Electron main process
    index.ts               app lifecycle, IPC, tray, global hotkeys
    windows.ts             main window + transparent click-through overlay
    store.ts               local JSON storage, encrypted API keys
    brain/
      agent.ts             agent loop (subscription + API engines), tools, approvals
      claudeCli.ts         runs requests through your signed-in Claude Code (subscription)
      toolServer.ts        local, token-protected endpoint that exposes JARVIS tools to Claude Code
      tools.ts             tool definitions + executors
      prompts.ts           system prompt (cache-stable) and routing heuristics
      memory.ts            facts about you, the conversation journal, recall
      pricing.ts           per-model prices and cost calculation
    computer/
      control.ts           screenshots + mouse/keyboard (Claude computer-use toolset)
      system.ts            shell, apps, files, clipboard
    mcp-bridge.ts          tiny MCP server Claude Code launches to reach JARVIS tools
    selfmod/selfmod.ts     propose / apply / revert code changes via git
    services/              usage tracking, reminders/automations, activity sampling
  preload/                 secure bridge between the UI and the main process
  renderer/
    src/pages/             Dashboard, Assistant, Tasks, Memory, Code Lab, Activity Log, Settings
    src/voice/             local Whisper STT worker, mic + voice detection, TTS
    src/overlay/           on-screen HUD and "show me how" guidance
  shared/types.ts          types shared across processes
```

## Ideas for what to ask

- "Open Spotify and play some focus music."
- "Show me how to set up a VPN on this computer."
- "Every weekday at 8:30, check my Downloads folder and tell me what's new."
- "Remind me to stretch in 45 minutes."
- "What's using all my memory right now?"
- "Add a weather card to your dashboard." (JARVIS will propose a code change)
- "Speak a bit faster." / "Call me Tony."

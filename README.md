# Claude Telegram Bridge

Two-way Telegram chat for Claude Code. Text Claude from your phone, get instant responses in your existing session.

The official Claude Code Channels (Telegram plugin) only works in the CLI. This MCP server brings real-time two-way Telegram messaging to the **VS Code extension** — same session, same context, no compromises.

## Features

**Messaging**
- Send and receive text with markdown formatting (code blocks, bold, italic)
- Reliable Markdown→HTML pipeline: escape-once, placeholder-protected code spans — backticks and `<`/`&` characters can no longer break formatting (fixed in v3.4)
- Safe auto-chunking for long messages — splits at logical boundaries, never inside a code block or HTML tag
- HTML parse mode with readable plain-text fallback
- Automatic retry with backoff on Telegram rate limits (429) and transient network errors

**Media**
- Receive photos, videos, voice messages, audio files, documents, stickers, locations, contacts
- Photos returned as base64 images — Claude can see them inline
- Send files with auto-type detection (images as photos, videos as video, everything else as documents)
- `.ts` files automatically renamed to `.txt` (Telegram treats TypeScript as MPEG Transport Stream)

**Interactive**
- Inline keyboard buttons — send choices, receive taps
- Edit messages in place (no notification spam for progress updates)
- Emoji reactions on messages
- Reply threading (reply_to parameter)

**Audio/Video Processing** *(optional — requires FFmpeg + OpenAI API key)*
- Transcribe voice messages and audio files via OpenAI Whisper
- Process videos: extract audio transcript + keyframes as images Claude can see
- Auto-cleanup of temporary files; pass `keepFile: true` to keep sources (files outside the download dir are never deleted)

**Session Management**
- `wait_for_message` blocks until user sends anything (text, media, or button press) — optional `timeout_seconds`, clean abort handling (no zombie listeners)
- Stop codewords: `/done`, `/stop`, `/back`, `/desk` — cleanly end the listening loop
- `check_messages` for non-blocking queue reads
- MCP logging notifications when messages arrive while not listening
- Structured error results (`isError`) on every tool; file-size guards (20 MB download / 50 MB upload limits reported clearly)

## Tools

| Tool | Description |
|------|-------------|
| `send_message` | Send text with formatting, buttons, and reply threading |
| `wait_for_message` | Block until user sends a message or taps a button |
| `check_messages` | Non-blocking check for queued messages |
| `edit_message` | Edit a previously sent message in place |
| `send_file` | Send any file (auto-detects photo/video/document) |
| `react` | Add emoji reaction to a message |
| `transcribe_audio` | Transcribe audio/voice via Whisper *(optional)* |
| `process_video` | Extract transcript + keyframes from video *(optional)* |

## Setup

### 1. Create a Telegram bot

Open [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, and copy the token.

### 2. Get your chat ID

Send any message to your bot, then visit:
```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```
Find `"chat":{"id":YOUR_CHAT_ID}` in the response.

### 3. Install

```bash
git clone https://github.com/carlosvianney/claude-telegram-bridge.git
cd claude-telegram-bridge
npm install
npm run build
```

### 4. Configure Claude Code

Add to your `.mcp.json` (in your project root or `~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/path/to/claude-telegram-bridge/build/index.js"],
      "env": {
        "TELEGRAM_TOKEN": "your-bot-token",
        "CHAT_ID": "your-chat-id"
      }
    }
  }
}
```

### 5. Optional: Audio/Video processing

For `transcribe_audio` and `process_video` tools:

1. Install FFmpeg: `sudo apt install ffmpeg` (Linux) or `brew install ffmpeg` (Mac)
2. Add your OpenAI API key to the env:

```json
{
  "env": {
    "TELEGRAM_TOKEN": "your-bot-token",
    "CHAT_ID": "your-chat-id",
    "OPENAI_API_KEY": "sk-..."
  }
}
```

Without these, the core messaging tools work fine — transcription and video processing are optional features.

## Usage

Once configured, tell Claude to pick up the Telegram loop:

> "Start listening on Telegram"

Claude will call `wait_for_message`, and you can text from your phone. Every message you send arrives in the VS Code session. Claude responds via `send_message`, and you see it in Telegram.

Send `/done` to stop the loop and return to the VS Code keyboard.

### Inline Buttons

```
Claude sends: "Pick one" with buttons [Option A] [Option B]
You tap: Option A
Claude receives: { button_data: "option_a" }
```

Buttons and messages both come through `wait_for_message` — no separate tool needed.

### Voice Messages

Send a voice message from Telegram → Claude calls `transcribe_audio` → gets the text transcript. Works for any audio file (ogg, mp3, m4a, wav).

### Video Processing

Send a video → Claude calls `process_video` → gets:
- Full audio transcript (via Whisper)
- Keyframe images (Claude can see them)
- Metadata (duration, frame count)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_TOKEN` | Yes | Bot token from BotFather |
| `CHAT_ID` | Yes | Your Telegram chat ID |
| `OPENAI_API_KEY` | No | For audio transcription and video processing |
| `DOWNLOAD_DIR` | No | Where to save media files (default: `/tmp/telegram-mcp`) |

## How It Works

This is an MCP (Model Context Protocol) server that connects Claude Code to a Telegram bot via long polling. When Claude calls `wait_for_message`, the tool blocks until your Telegram bot receives a message. Both text messages and inline button presses resolve the same promise — unified input.

The bot runs inside the MCP server process. No separate service, no webhook setup, no public URL needed. It starts when Claude Code loads the MCP config and stops when the session ends.

## Limitations

- **One chat only** — the `CHAT_ID` env var locks it to a single conversation
- **VS Code keyboard blocked** while `wait_for_message` is active (you're on Telegram instead)
- **No push notifications** — Claude can't initiate a turn from Telegram. You text first, Claude responds.
- **Telegram file size limit** — bots can download files up to 20 MB and upload up to 50 MB

## Changelog

- **v3.4.0** — Engine migration to [grammY](https://grammy.dev) (typed Bot API, no deprecated dependencies) with automatic 429/network retry. Formatter rewritten: the long-standing backtick/`<code>` rendering bug is fixed at the root (escape-once pipeline, placeholder-protected code spans, chunk-before-format so code blocks never split). `wait_for_message` gains `timeout_seconds` + abort cleanup. `transcribe_audio`/`process_video` gain `keepFile` and no longer delete files outside the download dir. Structured `isError` results, download/upload size guards, sandboxed cleanup paths, graceful startup failure.
- **v3.2.0** — Fix silent polling errors, shell injection, message handling bugs.
- **v3.1** — Full two-way Telegram MCP for Claude Code.

## License

MIT — OCS CommTech LLC

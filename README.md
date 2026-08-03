# Claude Telegram Bridge

Two-way Telegram chat for Claude Code. Text Claude from your phone, get instant responses in your existing session.

The official Claude Code Telegram channel is CLI-only
([claude-plugins-official#778](https://github.com/anthropics/claude-plugins-official/issues/778)
is still open). This is an ordinary MCP server, so it works in the **VS Code
extension**, JetBrains, Cursor, Claude Desktop and the CLI alike.

**Use something else if it fits you better:**
- On the CLI? The **official Telegram channel plugin** has permission approval
  from your phone, pairing codes and group policy. Use it.
- Just want your session on your phone? **Claude Code Remote Control** is
  official and needs no setup — though it requires an Anthropic login (no API
  key, Bedrock or custom base URL).
- Want a polished mobile app? [Happy](https://github.com/slopus/happy).

**Use this if** you are in the VS Code extension, you want Telegram **voice
notes transcribed** and **video summarised** (no official equivalent), or you
want a self-hosted bridge that works with any auth setup.

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
- Structured error results (`isError`) on every tool; file-size guards (20 MB download / 50 MB upload limits reported clearly)
- Media downloads run in the background (v3.5) — a slow photo can no longer delay the text messages behind it

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
| `ALLOWED_USER_IDS` | No | Comma-separated Telegram user IDs allowed to drive the session. **Set this if `CHAT_ID` is a group** — otherwise every group member can. |

## How It Works

This is an MCP (Model Context Protocol) server that connects Claude Code to a Telegram bot via long polling. When Claude calls `wait_for_message`, the tool blocks until your Telegram bot receives a message. Both text messages and inline button presses resolve the same promise — unified input.

The bot runs inside the MCP server process. No separate service, no webhook setup, no public URL needed. It starts when Claude Code loads the MCP config and stops when the session ends.

## Security

Media filenames arrive from the sender and are never trusted. Every download
target is reduced to a safe basename inside `DOWNLOAD_DIR` (no directory
components, no null bytes, length-bounded, random suffix on collision), and
downloads use a byte-counting bounded read so a server that lies about
`file_size` cannot write past the 20 MB limit.

**Gate on identity, not just the room.** `CHAT_ID` restricts which *chat* the
bridge listens to. In a one-to-one chat that is also an identity gate, but if
you point `CHAT_ID` at a **group**, every member of that group can drive the
session — and `send_file` has no sandbox. Set `ALLOWED_USER_IDS` to the user
IDs you actually trust. The server warns on startup if `CHAT_ID` is a group and
no allowlist is set.

**If you are running a version before v3.5.0, update.** A malicious `file_name`
could escape the download directory and overwrite arbitrary files. Details in
[CHANGELOG.md](CHANGELOG.md).

## Limitations

- **One chat only** — the `CHAT_ID` env var locks it to a single conversation
- **VS Code keyboard blocked** while `wait_for_message` is active (you're on Telegram instead)
- **No push notifications** — Claude can't initiate a turn from Telegram. You text first, Claude responds.
- **Telegram file size limit** — bots can download files up to 20 MB and upload up to 50 MB

## Known Issues

The honest list of what still breaks is in
**[KNOWN-ISSUES.md](KNOWN-ISSUES.md)**.

Short version: as of v3.6.0 the bridge no longer fails silently — if polling
dies, the tools say so instead of returning empty results forever. If they
report "Not connected", the server exited on purpose so it could be restarted;
reload the session. Check for stray processes with `ps aux | grep telegram`.

## Changelog

Full history in **[CHANGELOG.md](CHANGELOG.md)**.

- **v3.6.2** — Security: `CHAT_ID` was a room gate, not an identity gate — if pointed at a group, any member could drive the session. Adds optional `ALLOWED_USER_IDS` (backwards compatible) plus a startup warning. Also removed a README claim that never worked (MCP logging notifications are not surfaced by Claude Code) and added honest positioning against the official alternatives.
- **v3.6.1** — Fixed: one malformed update used to discard every queued message alongside it (the queue is drained before processing, so a throw mid-loop lost the whole batch). Plus 44/44 on transport fuzzing — hostile `message_id`s, callback floods, oversized captions and malformed updates all fail soft.
- **v3.6.0** — The bridge can no longer die quietly. A dead poller (409 duplicate consumer, or 401 rejected token — a second silent-death vector found this round) used to return clean timeouts forever with no recovery; it now surfaces an explicit error through the tools, retries with backoff, and exits so the host can restart it. Adds pid-file single-instance with verified takeover (never signals a process it cannot positively identify), orphan self-exit, and a bound on the callback queue.
- **v3.5.1** — Fixed a **critical** crash: a code fence with a very long language token sent `splitRaw` into an infinite loop and killed the process (taking the whole bridge down) — reachable through any content the assistant echoes. Also: `send_file` on a `.ts` file could delete a same-named received attachment; `messageQueue` is now bounded at 500 with the drop count surfaced; `process_video` frames are capped and share the 4 MB inline budget.
- **v3.5.0** — Fixed: one slow media download blocked every other message (downloads moved off the update loop — no timeouts added). Security: arbitrary file write via `file_name` (path traversal), and unbounded download despite the declared 20 MB limit. Also: messages arriving during a client abort are no longer swallowed, and failed downloads no longer carry stale file metadata.
- **v3.4.0** — Engine migration to [grammY](https://grammy.dev) (typed Bot API, no deprecated dependencies) with automatic 429/network retry. Formatter rewritten: the long-standing backtick/`<code>` rendering bug is fixed at the root (escape-once pipeline, placeholder-protected code spans, chunk-before-format so code blocks never split). `wait_for_message` gains `timeout_seconds` + abort cleanup. `transcribe_audio`/`process_video` gain `keepFile` and no longer delete files outside the download dir. Structured `isError` results, download/upload size guards, sandboxed cleanup paths, graceful startup failure.
- **v3.2.0** — Fix silent polling errors, shell injection, message handling bugs.
- **v3.1** — Full two-way Telegram MCP for Claude Code.

## License

MIT — OCS CommTech LLC

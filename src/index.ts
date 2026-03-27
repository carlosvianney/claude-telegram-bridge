#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import TelegramBot from "node-telegram-bot-api";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "/tmp/telegram-mcp";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error("TELEGRAM_TOKEN and CHAT_ID env vars required");
  process.exit(1);
}

const chatId = CHAT_ID;

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// --- Types ---

interface IncomingMessage {
  text: string;
  from: string;
  date: number;
  type: "text" | "photo" | "video" | "voice" | "audio" | "document" | "sticker" | "location" | "contact";
  filePath?: string;
  fileName?: string;
  caption?: string;
  mimeType?: string;
  fileSize?: number;
  location?: { latitude: number; longitude: number };
  contact?: { phone: string; firstName: string; lastName?: string };
}

interface CallbackData { id: string; data: string; from: string; messageId: number }

// --- State ---

const messageQueue: IncomingMessage[] = [];
const callbackQueue: CallbackData[] = [];
let callbackResolver: ((cb: CallbackData) => void) | null = null;
let waitingResolver: ((msg: IncomingMessage) => void) | null = null;
let mcpReady = false;
let lastSentMessageId: number | null = null;

// --- Bot ---

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
bot.on("polling_error", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  // Log to stderr so MCP stdio isn't polluted
  process.stderr.write(`[telegram-mcp] polling_error: ${msg}\n`);
  // Also notify MCP client if ready
  if (mcpReady) {
    server.sendLoggingMessage({
      level: "error",
      logger: "telegram",
      data: `Polling error: ${msg}. Messages may be delayed or lost.`,
    }).catch(() => {});
  }
});

// --- Helpers ---

/** Generate a unique filename with timestamp + random suffix to avoid collisions */
function uniqueName(prefix: string, ext: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}${ext}`;
}

async function downloadFile(fileId: string, suggestedName?: string): Promise<{ localPath: string; fileName: string }> {
  const file = await bot.getFile(fileId);
  const filePath = file.file_path!;
  const ext = path.extname(filePath) || "";
  const fileName = suggestedName || `${fileId}${ext}`;
  const localPath = path.join(DOWNLOAD_DIR, fileName);
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buffer);
  return { localPath, fileName };
}

function cleanupFile(filePath: string) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

function cleanupDir(dirPath: string) {
  try { if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true }); } catch {}
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatForTelegram(text: string): string {
  let formatted = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return `<pre><code${cls}>${escapeHtml(code.trimEnd())}</code></pre>`;
  });
  formatted = formatted.replace(/`([^`]+)`/g, (_match, code) => `<code>${escapeHtml(code)}</code>`);
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, (_match, content) => `<b>${escapeHtml(content)}</b>`);
  formatted = formatted.replace(/(?<![<\/\w])\*([^*]+)\*(?![>])/g, (_match, content) => `<i>${escapeHtml(content)}</i>`);
  return formatted;
}

/** Smart chunk that avoids splitting inside HTML tags */
function smartChunk(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) {
      // No good newline, try space
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      // No good split point, force at limit
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
const VIDEO_EXTS = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
const CONFUSING_EXTS = [".ts"]; // Telegram treats .ts as MPEG Transport Stream

// --- Message Processing ---

async function processMessage(msg: TelegramBot.Message): Promise<IncomingMessage> {
  const from = msg.from?.first_name || msg.from?.username || "User";
  const date = msg.date;
  const caption = msg.caption;

  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    const { localPath, fileName } = await downloadFile(largest.file_id, uniqueName("photo", ".jpg"));
    return { text: caption || "[Photo]", from, date, type: "photo", filePath: localPath, fileName, caption, fileSize: largest.file_size };
  }
  if (msg.video) {
    const vidName = (msg.video as any).file_name || uniqueName("video", ".mp4");
    const { localPath, fileName } = await downloadFile(msg.video.file_id, vidName);
    return { text: caption || "[Video]", from, date, type: "video", filePath: localPath, fileName, caption, mimeType: msg.video.mime_type, fileSize: msg.video.file_size };
  }
  if (msg.voice) {
    const { localPath, fileName } = await downloadFile(msg.voice.file_id, uniqueName("voice", ".ogg"));
    return { text: "[Voice message]", from, date, type: "voice", filePath: localPath, fileName, mimeType: msg.voice.mime_type, fileSize: msg.voice.file_size };
  }
  if (msg.audio) {
    const audioName = (msg.audio as any).file_name || uniqueName("audio", ".mp3");
    const { localPath, fileName } = await downloadFile(msg.audio.file_id, audioName);
    return { text: caption || `[Audio: ${msg.audio.title || fileName}]`, from, date, type: "audio", filePath: localPath, fileName, caption, mimeType: msg.audio.mime_type, fileSize: msg.audio.file_size };
  }
  if (msg.document) {
    const docName = msg.document.file_name || uniqueName("doc", path.extname(msg.document.file_name || "") || "");
    const { localPath, fileName } = await downloadFile(msg.document.file_id, docName);
    return { text: caption || `[Document: ${fileName}]`, from, date, type: "document", filePath: localPath, fileName, caption, mimeType: msg.document.mime_type, fileSize: msg.document.file_size };
  }
  if (msg.sticker) {
    return { text: `[Sticker: ${msg.sticker.emoji || ""} ${msg.sticker.set_name || ""}]`, from, date, type: "sticker" };
  }
  if (msg.location) {
    return { text: `[Location: ${msg.location.latitude}, ${msg.location.longitude}]`, from, date, type: "location", location: msg.location };
  }
  if (msg.contact) {
    return { text: `[Contact: ${msg.contact.first_name} ${msg.contact.last_name || ""} - ${msg.contact.phone_number}]`, from, date, type: "contact", contact: { phone: msg.contact.phone_number, firstName: msg.contact.first_name, lastName: msg.contact.last_name } };
  }
  return { text: msg.text || "[empty message]", from, date, type: "text" };
}

function formatMessage(msg: IncomingMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    from: msg.from, type: msg.type, message: msg.text,
    timestamp: new Date(msg.date * 1000).toISOString(),
  };
  if (msg.filePath) result.filePath = msg.filePath;
  if (msg.fileName) result.fileName = msg.fileName;
  if (msg.caption) result.caption = msg.caption;
  if (msg.mimeType) result.mimeType = msg.mimeType;
  if (msg.fileSize) result.fileSize = msg.fileSize;
  if (msg.location) result.location = msg.location;
  if (msg.contact) result.contact = msg.contact;
  return result;
}

function formatReturnContent(msg: IncomingMessage): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
  const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
    { type: "text", text: JSON.stringify(formatMessage(msg)) },
  ];
  if (msg.filePath && (msg.type === "photo" || msg.type === "sticker")) {
    try {
      const imageData = fs.readFileSync(msg.filePath);
      content.push({ type: "image", data: imageData.toString("base64"), mimeType: msg.type === "photo" ? "image/jpeg" : "image/webp" });
    } catch {}
  }
  return content;
}

// --- Event Listeners ---

bot.on("message", async (msg) => {
  if (msg.chat.id.toString() !== chatId) return;
  try {
    const incoming = await processMessage(msg);
    if (waitingResolver) {
      const resolve = waitingResolver;
      waitingResolver = null;
      resolve(incoming);
    } else {
      messageQueue.push(incoming);
      if (mcpReady) {
        const preview = incoming.type === "text"
          ? incoming.text.slice(0, 100)
          : `[${incoming.type}] ${incoming.caption || incoming.text}`.slice(0, 100);
        server.sendLoggingMessage({ level: "warning", logger: "telegram", data: `New Telegram ${incoming.type} from ${incoming.from}: "${preview}". Call check_messages to read it.` }).catch(() => {});
      }
    }
  } catch {
    const fallback: IncomingMessage = {
      text: msg.text || msg.caption || `[${msg.photo ? "photo" : msg.video ? "video" : "media"} - download failed]`,
      from: msg.from?.first_name || msg.from?.username || "User", date: msg.date, type: "text",
    };
    if (waitingResolver) { const resolve = waitingResolver; waitingResolver = null; resolve(fallback); }
    else messageQueue.push(fallback);
  }
});

bot.on("callback_query", async (query) => {
  if (!query.message || query.message.chat.id.toString() !== chatId) return;
  const cb: CallbackData = {
    id: query.id, data: query.data || "",
    from: query.from.first_name || query.from.username || "User",
    messageId: query.message.message_id,
  };
  await bot.answerCallbackQuery(query.id).catch(() => {});
  if (callbackResolver) { const resolve = callbackResolver; callbackResolver = null; resolve(cb); }
  else callbackQueue.push(cb);
});

// --- MCP Server ---

const server = new McpServer({ name: "telegram-chat-mcp", version: "3.2.0" });

const STOP_WORDS = ["/done", "/stop", "/back", "/desk"];

// TOOL: send_message
server.tool(
  "send_message",
  "Send a message to the user on Telegram. Supports markdown-style formatting: ```code blocks```, `inline code`, **bold**, *italic*. Returns the message_id which can be used with edit_message or reply_to.",
  {
    message: z.string().describe("The message text to send. Use ```lang for code blocks, `backticks` for inline code."),
    reply_to: z.number().optional().describe("Message ID to reply to (threads the conversation)"),
    buttons: z.array(z.array(z.object({ text: z.string(), data: z.string() }))).optional().describe("Inline keyboard buttons as rows of [{text, data}]. User taps are returned by wait_for_message."),
  },
  async ({ message, reply_to, buttons }) => {
    const formatted = formatForTelegram(message);
    const opts: TelegramBot.SendMessageOptions = { parse_mode: "HTML" };
    if (reply_to) opts.reply_to_message_id = reply_to;
    if (buttons) {
      opts.reply_markup = { inline_keyboard: buttons.map(row => row.map(btn => ({ text: btn.text, callback_data: btn.data }))) };
    }
    const chunks = smartChunk(formatted, 4000);

    let sentMsg: TelegramBot.Message | undefined;
    for (const chunk of chunks) {
      try {
        sentMsg = await bot.sendMessage(chatId, chunk, opts);
        opts.reply_to_message_id = undefined;
        opts.reply_markup = undefined;
      } catch {
        sentMsg = await bot.sendMessage(chatId, chunk.replace(/<[^>]+>/g, "").slice(0, 4000));
      }
    }
    if (sentMsg) lastSentMessageId = sentMsg.message_id;
    return { content: [{ type: "text", text: JSON.stringify({ sent: true, message_id: sentMsg?.message_id }) }] };
  }
);

// TOOL: edit_message
server.tool(
  "edit_message",
  "Edit a previously sent message on Telegram. Use for progress updates instead of sending new messages — avoids notification spam.",
  {
    message_id: z.number().optional().describe("ID of the message to edit. If omitted, edits the last sent message."),
    text: z.string().describe("New text content for the message"),
    buttons: z.array(z.array(z.object({ text: z.string(), data: z.string() }))).optional().describe("Updated inline keyboard buttons (omit to remove buttons)"),
  },
  async ({ message_id, text, buttons }) => {
    const targetId = message_id || lastSentMessageId;
    if (!targetId) return { content: [{ type: "text", text: "Error: No message to edit." }] };

    const formatted = formatForTelegram(text);
    const opts: TelegramBot.EditMessageTextOptions = { chat_id: chatId, message_id: targetId, parse_mode: "HTML" };
    if (buttons) {
      opts.reply_markup = { inline_keyboard: buttons.map(row => row.map(btn => ({ text: btn.text, callback_data: btn.data }))) } as TelegramBot.InlineKeyboardMarkup;
    }
    // Chunk edit_message too — if over limit, truncate with indicator
    const truncated = formatted.length > 4096 ? formatted.slice(0, 4080) + "\n…[truncated]" : formatted;
    try { await bot.editMessageText(truncated, opts); }
    catch { try { await bot.editMessageText(text.slice(0, 4000), { ...opts, parse_mode: undefined }); } catch { return { content: [{ type: "text", text: "Error: Could not edit message." }] }; } }
    return { content: [{ type: "text", text: JSON.stringify({ edited: true, message_id: targetId }) }] };
  }
);

// TOOL: react
server.tool(
  "react",
  "Add an emoji reaction to a message on Telegram.",
  {
    message_id: z.number().describe("ID of the message to react to"),
    emoji: z.string().describe("Emoji to react with (e.g., '\ud83d\udc4d', '\ud83d\udd25', '\u2764\ufe0f', '\ud83d\ude02')"),
  },
  async ({ message_id, emoji }) => {
    try {
      await (bot as any).setMessageReaction(chatId, message_id, { reaction: [{ type: "emoji", emoji }] });
      return { content: [{ type: "text", text: "Reaction added." }] };
    } catch { return { content: [{ type: "text", text: "Error: Could not add reaction." }] }; }
  }
);

// TOOL: wait_for_message (unified — catches text, media, AND button presses)
server.tool(
  "wait_for_message",
  "Wait for the user to send a message on Telegram. Blocks until a message arrives. Handles text, photos, videos, voice, documents, stickers, locations, contacts, AND inline button presses. If the user sends /done, /stop, /back, or /desk, returns a stop signal. IMPORTANT: After processing the returned message, ALWAYS call wait_for_message again to keep listening. Only stop calling when you receive a stop signal.",
  {},
  async () => {
    // Drain queues first
    if (messageQueue.length > 0) {
      const msg = messageQueue.shift()!;
      if (msg.type === "text" && STOP_WORDS.includes(msg.text.trim().toLowerCase())) {
        return { content: [{ type: "text", text: JSON.stringify({ stop: true, codeword: msg.text.trim() }) }] };
      }
      return { content: formatReturnContent(msg) as any };
    }
    if (callbackQueue.length > 0) {
      const cb = callbackQueue.shift()!;
      return { content: [{ type: "text", text: JSON.stringify({ button_data: cb.data, from: cb.from, message_id: cb.messageId }) }] };
    }

    // Race: wait for either a message OR a button press
    const result = await new Promise<{ type: "message"; msg: IncomingMessage } | { type: "button"; cb: CallbackData }>((resolve) => {
      waitingResolver = (msg) => { callbackResolver = null; resolve({ type: "message", msg }); };
      callbackResolver = (cb) => { waitingResolver = null; resolve({ type: "button", cb }); };
    });

    if (result.type === "button") {
      return { content: [{ type: "text", text: JSON.stringify({ button_data: result.cb.data, from: result.cb.from, message_id: result.cb.messageId }) }] };
    }
    const msg = result.msg;
    if (msg.type === "text" && STOP_WORDS.includes(msg.text.trim().toLowerCase())) {
      return { content: [{ type: "text", text: JSON.stringify({ stop: true, codeword: msg.text.trim() }) }] };
    }
    return { content: formatReturnContent(msg) as any };
  }
);

// TOOL: check_messages (non-blocking)
server.tool(
  "check_messages",
  "Check for any unread Telegram messages and button presses without blocking. Returns all queued messages/callbacks or empty array. Also checks for stop words.",
  {},
  async () => {
    const messages = messageQueue.splice(0);
    const callbacks = callbackQueue.splice(0);
    const results: Record<string, unknown>[] = [];

    for (const msg of messages) {
      if (msg.type === "text" && STOP_WORDS.includes(msg.text.trim().toLowerCase())) {
        return { content: [{ type: "text", text: JSON.stringify({ stop: true, codeword: msg.text.trim(), pending: results }) }] };
      }
      results.push(formatMessage(msg));
    }
    for (const cb of callbacks) {
      results.push({ button_data: cb.data, from: cb.from, message_id: cb.messageId });
    }
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  }
);

// TOOL: send_file (unified — auto-detects photo/video/document, renames .ts to .txt)
server.tool(
  "send_file",
  "Send a file to the user on Telegram. Auto-detects type: images sent as photos (inline preview), videos sent as video (inline playback), everything else as document. Renames .ts files to .txt to prevent Telegram treating them as video.",
  {
    filePath: z.string().describe("Absolute path to the file to send"),
    caption: z.string().optional().describe("Optional caption"),
  },
  async ({ filePath, caption }) => {
    const ext = path.extname(filePath).toLowerCase();

    // Handle confusing extensions (.ts = TypeScript but Telegram thinks MPEG Transport Stream)
    if (CONFUSING_EXTS.includes(ext)) {
      const safeName = path.basename(filePath).replace(/\.ts$/i, ".txt");
      const tmpPath = path.join(DOWNLOAD_DIR, safeName);
      fs.copyFileSync(filePath, tmpPath);
      await bot.sendDocument(chatId, tmpPath, { caption: caption ? `${caption} (renamed .ts → .txt)` : `${path.basename(filePath)} (renamed .ts → .txt)` });
      cleanupFile(tmpPath);
      return { content: [{ type: "text", text: `File sent: ${filePath} (as .txt)` }] };
    }

    if (IMAGE_EXTS.includes(ext)) {
      await bot.sendPhoto(chatId, filePath, { caption });
    } else if (VIDEO_EXTS.includes(ext)) {
      await bot.sendVideo(chatId, filePath, { caption });
    } else {
      await bot.sendDocument(chatId, filePath, { caption });
    }
    return { content: [{ type: "text", text: `File sent: ${filePath}` }] };
  }
);

// --- Audio/Video Processing ---

async function transcribeAudio(audioPath: string): Promise<string> {
  if (!OPENAI_API_KEY) return "[Transcription unavailable — no OPENAI_API_KEY configured]";

  const audioData = fs.readFileSync(audioPath);
  const blob = new Blob([audioData], { type: "audio/mpeg" });
  const formData = new FormData();
  formData.append("file", blob, path.basename(audioPath));
  formData.append("model", "whisper-1");
  formData.append("response_format", "json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData,
  });
  if (!response.ok) { const err = await response.text(); throw new Error(`Whisper API error ${response.status}: ${err}`); }
  return ((await response.json()) as { text: string }).text;
}

// TOOL: transcribe_audio
server.tool(
  "transcribe_audio",
  "Transcribe an audio or voice file using OpenAI Whisper. Returns the transcribed text. Auto-cleans up the file after processing.",
  { filePath: z.string().describe("Absolute path to the audio file (ogg, mp3, m4a, wav, etc.)") },
  async ({ filePath }) => {
    if (!fs.existsSync(filePath)) return { content: [{ type: "text", text: `Error: File not found: ${filePath}` }] };
    try {
      let audioPath = filePath;
      if (filePath.endsWith(".ogg") || filePath.endsWith(".oga")) {
        audioPath = filePath.replace(/\.[^.]+$/, ".mp3");
        execFileSync("ffmpeg", ["-y", "-i", filePath, "-acodec", "libmp3lame", "-q:a", "2", audioPath], { timeout: 60000, stdio: "pipe" });
      }
      const transcript = await transcribeAudio(audioPath);
      // Auto-cleanup
      if (audioPath !== filePath) cleanupFile(audioPath);
      cleanupFile(filePath);
      return { content: [{ type: "text", text: JSON.stringify({ transcript, sourceFile: filePath }) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Transcription error: ${err.message}` }] };
    }
  }
);

// TOOL: process_video
server.tool(
  "process_video",
  "Process a video file: extracts audio transcript via Whisper + keyframes as inline images Claude can see. Auto-cleans up all temp files after processing.",
  {
    filePath: z.string().describe("Absolute path to the video file"),
    extractFrames: z.boolean().optional().describe("Whether to extract keyframes (default: true)"),
    maxFrames: z.number().optional().describe("Maximum number of keyframes to extract (default: 10)"),
  },
  async ({ filePath, extractFrames, maxFrames }) => {
    if (!fs.existsSync(filePath)) return { content: [{ type: "text", text: `Error: File not found: ${filePath}` }] };

    const doFrames = extractFrames !== false;
    const frameLimit = maxFrames || 10;
    const results: Record<string, unknown> = { sourceFile: filePath };
    let audioPath: string | null = null;
    let framesDir: string | null = null;

    // Transcribe audio
    try {
      audioPath = filePath.replace(/\.[^.]+$/, ".mp3");
      execFileSync("ffmpeg", ["-y", "-i", filePath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", audioPath], { timeout: 120000, stdio: "pipe" });
      results.transcript = await transcribeAudio(audioPath);
    } catch (err: any) {
      results.transcript = `[Audio extraction/transcription failed: ${err.message}]`;
    }

    // Extract keyframes
    const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
    if (doFrames) {
      try {
        framesDir = path.join(DOWNLOAD_DIR, `frames_${Date.now()}`);
        fs.mkdirSync(framesDir, { recursive: true });

        let duration = 10;
        try {
          const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath], { timeout: 30000, stdio: "pipe" }).toString().trim();
          duration = parseFloat(probe) || 10;
        } catch {}

        const interval = Math.max(duration / frameLimit, 2);
        execFileSync("ffmpeg", ["-y", "-i", filePath, "-vf", `fps=1/${interval}`, "-frames:v", String(frameLimit), `${framesDir}/frame_%03d.jpg`], { timeout: 120000, stdio: "pipe" });

        const frameFiles = fs.readdirSync(framesDir).sort().filter(f => f.endsWith(".jpg"));
        results.keyframeCount = frameFiles.length;

        for (const file of frameFiles) {
          try {
            const imgData = fs.readFileSync(path.join(framesDir, file));
            content.push({ type: "image", data: imgData.toString("base64"), mimeType: "image/jpeg" });
          } catch {}
        }
      } catch (err: any) {
        results.keyframeError = err.message;
      }
    }

    // Auto-cleanup everything
    if (audioPath) cleanupFile(audioPath);
    if (framesDir) cleanupDir(framesDir);
    cleanupFile(filePath);

    content.unshift({ type: "text", text: JSON.stringify(results) });
    return { content: content as any };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpReady = true;
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

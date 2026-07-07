#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bot, InputFile, GrammyError } from "grammy";
import type { Message } from "grammy/types";
import { autoRetry } from "@grammyjs/auto-retry";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { markdownToTelegramChunks, markdownToTelegramHtml, htmlToPlain } from "./format.js";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "/tmp/telegram-mcp";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

/** Telegram Bot API hard limit for bot file downloads. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** Telegram Bot API hard limit for bot file uploads. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error("TELEGRAM_TOKEN and CHAT_ID env vars required");
  process.exit(1);
}

const chatId = Number(CHAT_ID);

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

function clearResolvers() {
  waitingResolver = null;
  callbackResolver = null;
}

// --- MCP server (declared early so the bot handlers can log through it) ---

const server = new McpServer(
  { name: "telegram-chat-mcp", version: "3.4.0" },
  { capabilities: { logging: {} } }
);

function log(level: "info" | "warning" | "error", data: string) {
  process.stderr.write(`[telegram-mcp] ${level}: ${data}\n`);
  if (mcpReady) {
    server.server.sendLoggingMessage({ level, logger: "telegram", data }).catch(() => {});
  }
}

// --- Result helpers (structured per MCP spec) ---

type ToolContent = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

function ok(payload: unknown, extra: ToolContent = []): { content: ToolContent } {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }, ...extra] };
}

function fail(message: string): { content: ToolContent; isError: true } {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

// --- Bot ---

const bot = new Bot(TELEGRAM_TOKEN);
// Automatic handling of 429 rate limits (respects retry_after) and transient network errors.
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

bot.catch((err) => {
  const msg = err.error instanceof Error ? err.error.message : String(err.error);
  log("error", `Bot error: ${msg}. Messages may be delayed.`);
});

// --- Helpers ---

/** Generate a unique filename with timestamp + random suffix to avoid collisions */
function uniqueName(prefix: string, ext: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}${ext}`;
}

/** Path sandbox: cleanup may only ever touch files inside DOWNLOAD_DIR. */
function isInDownloadDir(p: string): boolean {
  const resolved = path.resolve(p);
  return resolved.startsWith(path.resolve(DOWNLOAD_DIR) + path.sep);
}

function cleanupFile(filePath: string) {
  if (!isInDownloadDir(filePath)) return; // never delete user files elsewhere
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

function cleanupDir(dirPath: string) {
  if (!isInDownloadDir(dirPath)) return;
  try { if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true }); } catch {}
}

async function downloadFile(fileId: string, suggestedName?: string, knownSize?: number): Promise<{ localPath: string; fileName: string }> {
  if (knownSize && knownSize > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File is ${(knownSize / 1048576).toFixed(1)} MB — Telegram bots can only download files up to 20 MB.`);
  }
  const file = await bot.api.getFile(fileId);
  if (file.file_size && file.file_size > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File is ${(file.file_size / 1048576).toFixed(1)} MB — Telegram bots can only download files up to 20 MB.`);
  }
  const filePath = file.file_path!;
  const ext = path.extname(filePath) || "";
  const fileName = suggestedName || `${fileId}${ext}`;
  const localPath = path.join(DOWNLOAD_DIR, fileName);
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buffer);
  return { localPath, fileName };
}

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
const VIDEO_EXTS = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
const CONFUSING_EXTS = [".ts"]; // Telegram treats .ts as MPEG Transport Stream

// --- Message Processing ---

async function processMessage(msg: Message): Promise<IncomingMessage> {
  const from = msg.from?.first_name || msg.from?.username || "User";
  const date = msg.date;
  const caption = msg.caption;

  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    const { localPath, fileName } = await downloadFile(largest.file_id, uniqueName("photo", ".jpg"), largest.file_size);
    return { text: caption || "[Photo]", from, date, type: "photo", filePath: localPath, fileName, caption, fileSize: largest.file_size };
  }
  if (msg.video) {
    const vidName = msg.video.file_name || uniqueName("video", ".mp4");
    const { localPath, fileName } = await downloadFile(msg.video.file_id, vidName, msg.video.file_size);
    return { text: caption || "[Video]", from, date, type: "video", filePath: localPath, fileName, caption, mimeType: msg.video.mime_type, fileSize: msg.video.file_size };
  }
  if (msg.voice) {
    const { localPath, fileName } = await downloadFile(msg.voice.file_id, uniqueName("voice", ".ogg"), msg.voice.file_size);
    return { text: "[Voice message]", from, date, type: "voice", filePath: localPath, fileName, mimeType: msg.voice.mime_type, fileSize: msg.voice.file_size };
  }
  if (msg.audio) {
    const audioName = msg.audio.file_name || uniqueName("audio", ".mp3");
    const { localPath, fileName } = await downloadFile(msg.audio.file_id, audioName, msg.audio.file_size);
    return { text: caption || `[Audio: ${msg.audio.title || fileName}]`, from, date, type: "audio", filePath: localPath, fileName, caption, mimeType: msg.audio.mime_type, fileSize: msg.audio.file_size };
  }
  if (msg.document) {
    const docName = msg.document.file_name || uniqueName("doc", path.extname(msg.document.file_name || "") || "");
    const { localPath, fileName } = await downloadFile(msg.document.file_id, docName, msg.document.file_size);
    return { text: caption || `[Document: ${fileName}]`, from, date, type: "document", filePath: localPath, fileName, caption, mimeType: msg.document.mime_type, fileSize: msg.document.file_size };
  }
  if (msg.sticker) {
    return { text: `[Sticker: ${msg.sticker.emoji || ""} ${msg.sticker.set_name || ""}]`, from, date, type: "sticker" };
  }
  if (msg.location) {
    return { text: `[Location: ${msg.location.latitude}, ${msg.location.longitude}]`, from, date, type: "location", location: { latitude: msg.location.latitude, longitude: msg.location.longitude } };
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

/** Images ≤ this size are returned inline as base64; larger ones by file path only. */
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

function formatReturnContent(msg: IncomingMessage): ToolContent {
  const content: ToolContent = [
    { type: "text", text: JSON.stringify(formatMessage(msg)) },
  ];
  if (msg.filePath && (msg.type === "photo" || msg.type === "sticker")) {
    try {
      const stat = fs.statSync(msg.filePath);
      if (stat.size <= MAX_INLINE_IMAGE_BYTES) {
        const imageData = fs.readFileSync(msg.filePath);
        content.push({ type: "image", data: imageData.toString("base64"), mimeType: msg.type === "photo" ? "image/jpeg" : "image/webp" });
      }
      // Larger images: filePath in the JSON is enough — the client can Read it.
    } catch {}
  }
  return content;
}

// --- Event Listeners ---

bot.on("message", async (ctx) => {
  const msg = ctx.message;
  if (msg.chat.id !== chatId) return;
  try {
    const incoming = await processMessage(msg);
    if (waitingResolver) {
      const resolve = waitingResolver;
      clearResolvers();
      resolve(incoming);
    } else {
      messageQueue.push(incoming);
      const preview = incoming.type === "text"
        ? incoming.text.slice(0, 100)
        : `[${incoming.type}] ${incoming.caption || incoming.text}`.slice(0, 100);
      log("warning", `New Telegram ${incoming.type} from ${incoming.from}: "${preview}". Call check_messages to read it.`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "download failed";
    const fallback: IncomingMessage = {
      text: msg.text || msg.caption || `[${msg.photo ? "photo" : msg.video ? "video" : "media"} — ${reason}]`,
      from: msg.from?.first_name || msg.from?.username || "User", date: msg.date, type: "text",
    };
    if (waitingResolver) { const resolve = waitingResolver; clearResolvers(); resolve(fallback); }
    else messageQueue.push(fallback);
  }
});

bot.on("callback_query", async (ctx) => {
  const query = ctx.callbackQuery;
  if (!query.message || query.message.chat.id !== chatId) return;
  const cb: CallbackData = {
    id: query.id, data: query.data || "",
    from: query.from.first_name || query.from.username || "User",
    messageId: query.message.message_id,
  };
  await ctx.answerCallbackQuery().catch(() => {});
  if (callbackResolver) { const resolve = callbackResolver; clearResolvers(); resolve(cb); }
  else callbackQueue.push(cb);
});

// --- Tools ---

const STOP_WORDS = ["/done", "/stop", "/back", "/desk"];

// TOOL: send_message
server.tool(
  "send_message",
  "Send a message to the user on Telegram. Supports markdown formatting: ```code blocks```, `inline code`, **bold**, *italic*. Long messages are split at safe boundaries (code blocks are never broken). Returns the message_id which can be used with edit_message or reply_to.",
  {
    message: z.string().describe("The message text to send. Use ```lang for code blocks, `backticks` for inline code."),
    reply_to: z.number().optional().describe("Message ID to reply to (threads the conversation)"),
    buttons: z.array(z.array(z.object({ text: z.string(), data: z.string() }))).optional().describe("Inline keyboard buttons as rows of [{text, data}]. User taps are returned by wait_for_message."),
  },
  async ({ message, reply_to, buttons }) => {
    const chunks = markdownToTelegramChunks(message);
    let sentMsg: Message.TextMessage | undefined;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const opts: Parameters<typeof bot.api.sendMessage>[2] = { parse_mode: "HTML" };
        if (i === 0 && reply_to) opts.reply_parameters = { message_id: reply_to };
        if (i === chunks.length - 1 && buttons) {
          opts.reply_markup = { inline_keyboard: buttons.map(row => row.map(btn => ({ text: btn.text, callback_data: btn.data }))) };
        }
        try {
          sentMsg = await bot.api.sendMessage(chatId, chunks[i], opts);
        } catch (err) {
          if (err instanceof GrammyError && /parse/i.test(err.description)) {
            // Formatting rejected — deliver readable plain text instead of failing.
            const plain = htmlToPlain(chunks[i]).slice(0, 4096);
            sentMsg = await bot.api.sendMessage(chatId, plain, { ...opts, parse_mode: undefined });
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      return fail(`Could not send message: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (sentMsg) lastSentMessageId = sentMsg.message_id;
    return ok({ sent: true, message_id: sentMsg?.message_id, chunks: chunks.length });
  }
);

// TOOL: edit_message
server.tool(
  "edit_message",
  "Edit a previously sent message on Telegram. Use for progress updates instead of sending new messages — avoids notification spam. Note: edits do not trigger a phone notification; send a new message for final results.",
  {
    message_id: z.number().optional().describe("ID of the message to edit. If omitted, edits the last sent message."),
    text: z.string().describe("New text content for the message"),
    buttons: z.array(z.array(z.object({ text: z.string(), data: z.string() }))).optional().describe("Updated inline keyboard buttons (omit to remove buttons)"),
  },
  async ({ message_id, text, buttons }) => {
    const targetId = message_id || lastSentMessageId;
    if (!targetId) return fail("No message to edit.");

    const formatted = markdownToTelegramHtml(text);
    const opts: Parameters<typeof bot.api.editMessageText>[3] = { parse_mode: "HTML" };
    if (buttons) {
      opts.reply_markup = { inline_keyboard: buttons.map(row => row.map(btn => ({ text: btn.text, callback_data: btn.data }))) };
    }
    try {
      await bot.api.editMessageText(chatId, targetId, formatted, opts);
    } catch (err) {
      if (err instanceof GrammyError && /parse/i.test(err.description)) {
        try {
          await bot.api.editMessageText(chatId, targetId, text.slice(0, 4000), { ...opts, parse_mode: undefined });
        } catch (err2) {
          return fail(`Could not edit message: ${err2 instanceof Error ? err2.message : String(err2)}`);
        }
      } else if (err instanceof GrammyError && /not modified/i.test(err.description)) {
        return ok({ edited: false, message_id: targetId, note: "Content unchanged." });
      } else {
        return fail(`Could not edit message: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return ok({ edited: true, message_id: targetId });
  }
);

// TOOL: react
server.tool(
  "react",
  "Add an emoji reaction to a message on Telegram. Low-noise acknowledgment — no notification, no chat clutter.",
  {
    message_id: z.number().describe("ID of the message to react to"),
    emoji: z.string().describe("Emoji to react with (e.g., '👍', '🔥', '❤️', '😂')"),
  },
  async ({ message_id, emoji }) => {
    try {
      await bot.api.setMessageReaction(chatId, message_id, [{ type: "emoji", emoji: emoji as never }]);
      return ok({ reacted: true });
    } catch (err) {
      return fail(`Could not add reaction: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
);

// TOOL: wait_for_message (unified — catches text, media, AND button presses)
server.tool(
  "wait_for_message",
  "Wait for the user to send a message on Telegram. Blocks until a message arrives (or the optional timeout passes). Handles text, photos, videos, voice, documents, stickers, locations, contacts, AND inline button presses. If the user sends /done, /stop, /back, or /desk, returns a stop signal. IMPORTANT: After processing the returned message, ALWAYS call wait_for_message again to keep listening. Only stop calling when you receive a stop signal.",
  {
    timeout_seconds: z.number().optional().describe("Optional: give up after this many seconds and return {timeout:true}. Omit to wait indefinitely."),
  },
  async ({ timeout_seconds }, extra) => {
    // Drain queues first
    if (messageQueue.length > 0) {
      const msg = messageQueue.shift()!;
      if (msg.type === "text" && STOP_WORDS.includes(msg.text.trim().toLowerCase())) {
        return ok({ stop: true, codeword: msg.text.trim() });
      }
      return { content: formatReturnContent(msg) };
    }
    if (callbackQueue.length > 0) {
      const cb = callbackQueue.shift()!;
      return ok({ button_data: cb.data, from: cb.from, message_id: cb.messageId });
    }

    // Race: message | button press | timeout | client abort — losers are cleaned up.
    type WaitResult =
      | { type: "message"; msg: IncomingMessage }
      | { type: "button"; cb: CallbackData }
      | { type: "timeout" }
      | { type: "aborted" };

    const result = await new Promise<WaitResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (r: WaitResult) => {
        if (timer) clearTimeout(timer);
        extra.signal?.removeEventListener("abort", onAbort);
        clearResolvers();
        resolve(r);
      };
      const onAbort = () => finish({ type: "aborted" });

      waitingResolver = (msg) => finish({ type: "message", msg });
      callbackResolver = (cb) => finish({ type: "button", cb });
      if (timeout_seconds && timeout_seconds > 0) {
        timer = setTimeout(() => finish({ type: "timeout" }), timeout_seconds * 1000);
      }
      if (extra.signal) {
        if (extra.signal.aborted) return onAbort();
        extra.signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    switch (result.type) {
      case "timeout":
        return ok({ timeout: true, waited_seconds: timeout_seconds, hint: "No message arrived. Call wait_for_message again to keep listening, or move on." });
      case "aborted":
        return ok({ aborted: true });
      case "button":
        return ok({ button_data: result.cb.data, from: result.cb.from, message_id: result.cb.messageId });
      case "message": {
        const msg = result.msg;
        if (msg.type === "text" && STOP_WORDS.includes(msg.text.trim().toLowerCase())) {
          return ok({ stop: true, codeword: msg.text.trim() });
        }
        return { content: formatReturnContent(msg) };
      }
    }
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
        return ok({ stop: true, codeword: msg.text.trim(), pending: results });
      }
      results.push(formatMessage(msg));
    }
    for (const cb of callbacks) {
      results.push({ button_data: cb.data, from: cb.from, message_id: cb.messageId });
    }
    return ok(results);
  }
);

// TOOL: send_file (unified — auto-detects photo/video/document, renames .ts to .txt)
server.tool(
  "send_file",
  "Send a file to the user on Telegram. Auto-detects type: images sent as photos (inline preview), videos sent as video (inline playback), everything else as document. Renames .ts files to .txt to prevent Telegram treating them as video. Max 50 MB.",
  {
    filePath: z.string().describe("Absolute path to the file to send"),
    caption: z.string().optional().describe("Optional caption"),
  },
  async ({ filePath, caption }) => {
    if (!fs.existsSync(filePath)) return fail(`File not found: ${filePath}`);
    const size = fs.statSync(filePath).size;
    if (size > MAX_UPLOAD_BYTES) {
      return fail(`File is ${(size / 1048576).toFixed(1)} MB — Telegram bots can only send files up to 50 MB.`);
    }
    const ext = path.extname(filePath).toLowerCase();
    try {
      // Handle confusing extensions (.ts = TypeScript but Telegram thinks MPEG Transport Stream)
      if (CONFUSING_EXTS.includes(ext)) {
        const safeName = path.basename(filePath).replace(/\.ts$/i, ".txt");
        const tmpPath = path.join(DOWNLOAD_DIR, safeName);
        fs.copyFileSync(filePath, tmpPath);
        await bot.api.sendDocument(chatId, new InputFile(tmpPath), { caption: caption ? `${caption} (renamed .ts → .txt)` : `${path.basename(filePath)} (renamed .ts → .txt)` });
        cleanupFile(tmpPath);
        return ok(`File sent: ${filePath} (as .txt)`);
      }
      if (IMAGE_EXTS.includes(ext)) {
        await bot.api.sendPhoto(chatId, new InputFile(filePath), { caption });
      } else if (VIDEO_EXTS.includes(ext)) {
        await bot.api.sendVideo(chatId, new InputFile(filePath), { caption });
      } else {
        await bot.api.sendDocument(chatId, new InputFile(filePath), { caption });
      }
      return ok(`File sent: ${filePath}`);
    } catch (err) {
      return fail(`Could not send file: ${err instanceof Error ? err.message : String(err)}`);
    }
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
  "Transcribe an audio or voice file using OpenAI Whisper. Returns the transcribed text. Files downloaded from Telegram are cleaned up afterwards unless keepFile is true; files outside the download dir are never deleted.",
  {
    filePath: z.string().describe("Absolute path to the audio file (ogg, mp3, m4a, wav, etc.)"),
    keepFile: z.boolean().optional().describe("Keep the source file after transcription (default: false — downloaded files are cleaned up)"),
  },
  async ({ filePath, keepFile }) => {
    if (!fs.existsSync(filePath)) return fail(`File not found: ${filePath}`);
    try {
      log("info", `Transcribing ${path.basename(filePath)}…`);
      let audioPath = filePath;
      if (filePath.endsWith(".ogg") || filePath.endsWith(".oga")) {
        audioPath = path.join(DOWNLOAD_DIR, uniqueName("converted", ".mp3"));
        execFileSync("ffmpeg", ["-y", "-i", filePath, "-acodec", "libmp3lame", "-q:a", "2", audioPath], { timeout: 60000, stdio: "pipe" });
      }
      const transcript = await transcribeAudio(audioPath);
      if (audioPath !== filePath) cleanupFile(audioPath);
      if (!keepFile) cleanupFile(filePath); // no-op outside DOWNLOAD_DIR (sandboxed)
      return ok({ transcript, sourceFile: filePath, kept: !!keepFile || !isInDownloadDir(filePath) });
    } catch (err) {
      return fail(`Transcription error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
);

// TOOL: process_video
server.tool(
  "process_video",
  "Process a video file: extracts audio transcript via Whisper + keyframes as inline images Claude can see. Temp files are always cleaned up; the source video is kept if keepFile is true or if it lives outside the download dir.",
  {
    filePath: z.string().describe("Absolute path to the video file"),
    extractFrames: z.boolean().optional().describe("Whether to extract keyframes (default: true)"),
    maxFrames: z.number().optional().describe("Maximum number of keyframes to extract (default: 10)"),
    keepFile: z.boolean().optional().describe("Keep the source video after processing (default: false — downloaded files are cleaned up)"),
  },
  async ({ filePath, extractFrames, maxFrames, keepFile }) => {
    if (!fs.existsSync(filePath)) return fail(`File not found: ${filePath}`);

    const doFrames = extractFrames !== false;
    const frameLimit = maxFrames || 10;
    const results: Record<string, unknown> = { sourceFile: filePath };
    let audioPath: string | null = null;
    let framesDir: string | null = null;

    // Transcribe audio
    try {
      log("info", `Extracting audio from ${path.basename(filePath)}…`);
      audioPath = path.join(DOWNLOAD_DIR, uniqueName("videoaudio", ".mp3"));
      execFileSync("ffmpeg", ["-y", "-i", filePath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", audioPath], { timeout: 120000, stdio: "pipe" });
      log("info", "Transcribing audio…");
      results.transcript = await transcribeAudio(audioPath);
    } catch (err) {
      results.transcript = `[Audio extraction/transcription failed: ${err instanceof Error ? err.message : String(err)}]`;
    }

    // Extract keyframes
    const content: ToolContent = [];
    if (doFrames) {
      try {
        log("info", "Extracting keyframes…");
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
      } catch (err) {
        results.keyframeError = err instanceof Error ? err.message : String(err);
      }
    }

    // Cleanup: temps always; source only if downloaded + not kept (sandboxed anyway)
    if (audioPath) cleanupFile(audioPath);
    if (framesDir) cleanupDir(framesDir);
    if (!keepFile) cleanupFile(filePath);
    results.kept = !!keepFile || !isInDownloadDir(filePath);

    content.unshift({ type: "text", text: JSON.stringify(results) });
    return { content };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpReady = true;
  // Long polling starts after MCP is connected; runs until process exit.
  // A failed start (bad token, network down) must not kill the MCP server —
  // tools then return errors, and the failure is visible instead of fatal.
  bot.start({
    allowed_updates: ["message", "callback_query"],
    onStart: () => { process.stderr.write("[telegram-mcp] polling started (v3.4.0, grammY)\n"); },
  }).catch((err) => {
    log("error", `Telegram polling failed to start: ${err instanceof Error ? err.message : String(err)}`);
  });
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

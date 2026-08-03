# Changelog

All notable changes to this project are documented here.

---

## v3.5.1 — Formatter crash fix + resource bounds

Found by a second adversarial pass over the code paths v3.5.0 did not touch.

### Fixed — a code fence could kill the whole bridge (critical)

**Symptom.** The MCP process dies with `FATAL ERROR: Reached heap limit —
JavaScript heap out of memory`, or hangs forever pinning a core. When the
process dies the poll loop dies with it: the bridge goes down entirely.

**Cause.** `splitRaw()` in `format.ts` did not terminate for a non-positive
budget. A fenced code block whose *language token* is very long
(` ```aaaa…4000 chars ` ) drove the per-chunk budget negative via the
`class="language-…"` attribute. With a negative budget `lastIndexOf` returns
`-1`, so `rest = rest.slice(-1)` never shrank and the output array grew until
the heap died.

**Why it mattered.** This ran on **outgoing** text, from both `send_message`
and `edit_message`. Neither an infinite loop nor an OOM is catchable, and the
call sits outside `send_message`'s `try` block regardless. Any content the
assistant echoes could carry the payload — relayed file contents, a quoted
message, scraped text — so it was reachable without the operator ever typing
it.

**Fix.** Two changes, no timers:

- `splitRaw()` clamps its budget to a floor (`Math.max(16, …)`), making the
  function total for every possible input.
- The fence's language token is clamped to 20 characters at the source, so it
  can no longer consume the chunk budget.

Verified against the exact repro cases — 4100-char, 3960-char, 4200-char and
100 000-char language tokens all now return in ~1 ms. All other formatter
output is byte-identical.

Present since v3.4.0.

### Fixed — `send_file` on a `.ts` file could delete a received attachment

Sending a `.ts` file copies it to `<basename>.txt` inside `DOWNLOAD_DIR`,
sends it, then deletes the copy. If a received attachment already had that
name, it was overwritten and then removed — a file you were sent could vanish
before you read it.

The temp name now goes through `safeTargetName()`, which adds a collision
suffix.

### Added — bound on the message queue

`messageQueue` was unbounded. A flood or a long unattended session grew memory
until the process died; 4000 queued messages measured ~11 MB of text and a
40 MB RSS increase, returned in a single `check_messages` response.

Now capped at 500, dropping oldest first, with the dropped count surfaced in
`check_messages` so the loss is never silent. A constant bound, not a timer.

### Added — cumulative frame budget for `process_video`

`maxFrames` had no upper bound and the 4 MB inline-image ceiling was not
applied to extracted keyframes. A perfectly ordinary 13 MB video produced 300
frames and an 11.3 MB response.

Frames are now capped at 20 per call, and inlining stops at the same 4 MB
ceiling single images already respect, reporting how many frames were omitted.

### Also verified clean in this pass

No ReDoS anywhere in the formatter (200k-character adversarial inputs complete
in ≤10 ms). No HTML injection — script tags, event handlers and pre-escaped
entities are all escaped exactly once. NUL-sentinel forgery is blocked. Chunk
boundaries never split a tag or an entity. `execFileSync` argument handling is
injection-proof, including a file literally named `-i`. The ffmpeg cleanup
sandbox holds. `MAX_UPLOAD_BYTES` correctly uses real on-disk size. No token
leakage in any output or error path.

---

## v3.5.0 — Message delivery reliability + security hardening

Two independent problems, found while diagnosing a real symptom: messages
sent from the phone sometimes never arrived, while `wait_for_message`
returned `{"timeout":true}` over and over during the exact minutes the
messages were being sent.

### Fixed — one slow media download blocked every other message

**Symptom.** Send a photo on a weak connection, then send text. The text
does not arrive. `wait_for_message` reports clean timeouts while messages
are actively being sent. Minutes later the whole backlog appears at once
through `check_messages`, photos intact.

**Cause.** grammY processes updates strictly sequentially — it awaits the
full handler for one update before fetching the next. The `bot.on("message")`
handler awaited the file download *inside* that loop, on a `fetch` with no
bound. A single stalled download therefore froze delivery of every message
queued behind it for as long as the stall lasted.

**Fix.** The `await` was moved off the update path rather than being given a
time limit.

| Before | After |
|---|---|
| `processMessage()` — async, awaited the download | `classifyMessage()` — synchronous, returns immediately |
| `bot.on("message", async …)` | `bot.on("message", …)` — nothing to block on |
| Media message existed only after the download | Media message exists at once; `filePath` is known upfront |
| A stalled download starved everything behind it | Downloads run in the background via `withFileDownload()` |

- Media messages carry `fileStatus` (`"pending" | "done" | "failed"`) and a
  `filePromise` that settles — and never rejects — when the download ends.
- `wait_for_message` chains delivery through `filePromise`. The caller's own
  `timeout_seconds` remains authoritative; a message whose download outlives
  the wait is re-queued **at the front** instead of being dropped, so arrival
  order survives. The drain step prefers an already-settled message over a
  still-downloading one.
- `check_messages` keeps its non-blocking contract: an in-flight download is
  reported as `fileStatus: "downloading"` along with the path the file will
  land at.
- A message arriving during a client abort used to be swallowed. It now
  survives.

**One fallback path, unchanged in spirit:** download succeeds → the message is
delivered in full. Download fails → it degrades to the same plain-text
`[photo — reason]` the old inline `catch` produced. Nothing hangs, nothing
errors.

**Deliberately no new timeouts or tunables.** A timeout would have bounded the
stall without removing it — every stall shorter than the timeout would still
have starved messages.

Measured on a fake Bot API harness, text sent while a photo download hangs:

```
before   6005 ms   timed out, message lost
after     822 ms   delivered
```

### Fixed — arbitrary file write via `file_name` (path traversal)

`downloadFile()` built its destination as
`path.join(DOWNLOAD_DIR, fileName)`, where `fileName` came directly from the
sender's `document` / `video` / `audio` `file_name` field. A name such as
`../../../home/user/.bashrc` escaped the download directory and overwrote
whatever the process could reach.

Reproduced in a harness: a canary file outside `DOWNLOAD_DIR` was overwritten
with attacker-supplied content.

Fixed with `safeTargetName()`, applied at the `downloadFile()` choke point so
every call site is covered:

- basename only — no directory components survive
- null bytes stripped
- leading dots stripped
- length bounded to 120 characters
- random suffix on collision, so an incoming file can no longer silently
  clobber an existing one

Verified against `../` traversal, relative traversal, absolute paths, embedded
null bytes, 500-character names, and RTL-override names. All now land inside
`DOWNLOAD_DIR`.

Present since file downloads were introduced. Affects every version before
v3.5.0.

### Fixed — unbounded download despite the 20 MB limit

Both size guards read *declared* metadata (`knownSize`, then `getFile`'s
`file_size`). A server that under-declares `file_size` and omits
`content-length` passed both and streamed unchecked into memory via
`response.arrayBuffer()` — 30 MB written to disk in testing.

Replaced with a bounded streaming read that counts actual bytes received and
cancels the stream past `MAX_DOWNLOAD_BYTES`. Size-based only; no timeout
introduced.

### Fixed — stale metadata on failed downloads

A failed media download degraded to a `type: "text"` message that still
carried `mimeType` and `fileSize` — a text message advertising `video/mp4`
and a byte count for a file that does not exist. All file-implying fields
(`filePath`, `fileName`, `mimeType`, `fileSize`) are now stripped on the
failure path.

### Test results

| Suite | Result |
|---|---|
| Functional | 6/7 — the one failure is an inverted probe asserting the old starvation bug is present |
| Adversarial | 12/12 |
| Abort | 5/6 — the failure is the pre-existing sub-5 ms at-most-once window |
| **Total** | **21/23**, both failures pre-existing and documented |

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for what remains unfixed.

---

## v3.4.0 — grammY engine + formatter rewrite

Engine migration to [grammY](https://grammy.dev) (typed Bot API, no deprecated
dependencies) with automatic 429/network retry. Formatter rewritten: the
long-standing backtick/`<code>` rendering bug fixed at the root (escape-once
pipeline, placeholder-protected code spans, chunk-before-format so code blocks
never split). `wait_for_message` gained `timeout_seconds` and abort cleanup.
`transcribe_audio` / `process_video` gained `keepFile` and no longer delete
files outside the download directory. Structured `isError` results,
download/upload size guards, sandboxed cleanup paths, graceful startup failure.

> Note: the message-blocking bug fixed in v3.5.0 was introduced by this
> release. The previous engine did not await handlers inside the poll loop.

## v3.2.0 — Reliability fixes

Fixed silent polling errors, shell injection, and message handling bugs.

## v3.1 — Initial public release

Full two-way Telegram MCP for Claude Code.

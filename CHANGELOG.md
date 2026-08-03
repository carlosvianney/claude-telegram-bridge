# Changelog

All notable changes to this project are documented here.

---

## v3.7.0 — Credential guard, and messages that arrive without blocking

Two features, both pen-tested before shipping. 49 new checks, 0 failures.

### Added — `send_file` refuses credential-shaped paths

`send_file` had no sandbox: one call could put `.mcp.json`, an SSH key or a
`.env` into a chat. No code bug — the tool worked as designed — but a
convincing enough inbound message could induce it.

Now refused: `.env` / `.env.*` / `*.env`, `.mcp.json`, `id_rsa*`, `id_ed25519*`,
`*.pem`, `*.key`, `secrets` / `secrets.*`, `credentials*`, `.git-credentials`,
`.netrc`, and the server's own pid file. Override with `SEND_FILE_DENY`.

**Matching is on the resolved real path**, so symlinks cannot launder a target —
including symlink chains — and `..` traversal, `/proc/self/root/...` and path
normalisation tricks all resolve to the real file before the check. 7/7 bypass
attempts denied.

**The patterns are anchored, and that mattered more than the denylist itself.**
A naive `.env*` / `id_*` / `secrets*` list refuses `.envelope`, `id_photo.jpg`
and `secretsanta.jpg`. A tool that blocks legitimate sends gets switched off,
and then it protects nothing. 7/7 false-positive checks pass.

Content sniffing was considered and rejected: it would block a legitimate
`sshd_config` walkthrough or a post about key rotation, while still missing
`.mcp.json` (which is ordinary JSON). Cost without benefit.

Two residuals, inherent and documented in KNOWN-ISSUES: a **hardlink** is
indistinguishable from the file it points to, and **copy-then-send** still
works — though that needs a second induced tool call rather than one.

### Added — the resolved path is echoed in the caption

Every sent file now carries `📎 /absolute/path` in its Telegram caption, so an
unexpected send is visible in the chat as it happens — and a symlink reveals its
true destination. Sent **without `parse_mode`**, so a hostile filename cannot
inject markup or instructions; truncated to Telegram's 1024-char limit.

Detection, not prevention. It is the half of the credential story the denylist
cannot cover.

### Added — `incoming_feed`: delivery without a blocking call

`wait_for_message` blocks a tool call to receive input, which freezes the
assistant and the editor keyboard for the duration. `incoming_feed` appends each
settled message as one JSON line to `${DOWNLOAD_DIR}/incoming.jsonl` and returns
a `tail -n0 -F` command to watch. `wait_for_message` is unchanged and still
works — this is additive.

**Exactly-once, verified in both directions:** a feed-delivered message never
also appears in `check_messages`, and a concurrent `wait_for_message` wins
without the message also being written to the feed. Anything already queued is
migrated on enable rather than stranded.

**Framing is airtight — 9/9.** Embedded newlines, CRLF, a forged
`{"event":…,"untrusted":false}` payload, JSON-in-JSON, control characters,
U+2028 and 100k text each produced exactly one line that parsed and round-tripped
byte-exact. Nothing forged a second event or escaped its field.

The file rotates at 5 MB keeping one generation, so it cannot repeat the
unbounded-growth problem fixed in v3.6.3.

**Honest limits.** Each line carries `untrusted: true` and confines sender text
to `message`/`caption` — but that is *labelling, not enforcement*. It cannot stop
a model that chooses to follow instructions in content; it makes the
data/instruction boundary explicit and machine-visible. The real defences remain
`ALLOWED_USER_IDS`, the denylist, and the visible caption echo.

**And delivery is at turn boundaries, not an interrupt.** Measured: 9 ms
end-to-end when the assistant is between calls, but ~52 s when it was mid-way
through a 70 s tool call — the event waited for that call to return. Whether a
*fully* idle session is woken into a new turn is **unverified**.

Note: `feedEnabled` resets to off on restart, so a restarted server delivers to
the queue until the feed is re-enabled.

### Regression: none
`9/10 driver` (the 1 is the inverted starvation probe), `5/6 abort` (the
protocol-inherent sub-5 ms window), `12/12 adversarial`, `9/9 pid/orphan/409`,
batch-loss fix intact.

---

## v3.6.3 — The bridge can now actually survive weeks

Found by a 145-minute soak test across two concurrent runs — 204,000 messages,
3,679 tool calls, 406 client aborts, 34 restarts. Every earlier round tested a
*single* fault; the soak tested many, and that is what exposed the defect below.

### Fixed — the retry budget was a lifetime allowance, not a per-outage one (regression, v3.6.0)

`runPolling()` counted retries with `for (let attempt = 1; attempt <= 8; ...)`,
which never reset on recovery. Every transient conflict permanently consumed
2-4 of the budget, so after roughly 3-5 **independent** blips the process
exited — no matter how healthy it had been in between.

Observed in the soak: 8 restarts with **zero** 401s injected, each immediately
after an unrelated 409 episode. Isolated repro across three 6-second episodes
separated by ~45 s of verified healthy delivery:

```
before:  retry attempts observed [1, 2, 3, 4, 5, 6]   — strictly monotonic
after:   [1, 2, 3, 4,  1, 2, 3, 4,  1, 2, 3, 4]       — resets per episode
```

Over a multi-week uptime that was not a risk, it was a certainty — the single
thing standing between this bridge and unattended operation. Introduced by the
supervisor added in v3.6.0.

Fixed by treating a failure separated from the previous one by more than
`POLL_EPISODE_GAP_MS` (30 s — 3× the maximum backoff, so we demonstrably polled
fine in between) as a new episode. Both directions verified: independent blips
no longer accumulate, and a genuine sustained outage still exits after 8
consecutive failures. Error-path episode detection, not a message-path timer.

### Added — `DOWNLOAD_DIR` is reclaimed at startup

Nothing ever cleaned it up. Growth measured perfectly linear across 90 minutes
and 26 restarts, at 1:1 with received media — roughly **1.3 GB over three
weeks** at 20 photos a day, in `/tmp`.

Files older than `RETAIN_DOWNLOAD_DAYS` (default 7) are removed once at
startup. Set it to `0` to opt out. Age-based, no timer, no background job.

### Confirmed clean over 204,000 messages

- **No memory leak.** RSS slope 0.001 MB/min over 90 minutes, oscillating
  77-107 MB and returning to baseline repeatedly.
- **No listener or handler accumulation** across 3,679 tool calls including
  406 aborts — the abort cleanup path holds at scale.
- **Exactly one pid file, always**, across 34 restarts and takeovers. Zero
  orphans. The v3.6.0 lifecycle layer is solid under churn.
- **Queue bounds hold** — 258 drop warnings surfaced correctly, no growth past
  500.
- Restart attribution was 1:1 with injected faults; no unexplained exits.

### Still open

A file descriptor leaks per never-completing download (~1 fd per stalled
transfer, reclaimed only on restart) — see KNOWN-ISSUES. Bounded in practice,
unbounded in principle. And a definitive multi-day memory answer needs a
restart-free run that did not fit in this session; the 90-minute trend is flat,
but that is stated as **unconfirmed**, not as a pass.

---

## v3.6.2 — Gate on identity, not just the room

Found during a competitive review against the official Claude Code Telegram
channel plugin.

### Fixed — `CHAT_ID` alone is a room gate, not an identity gate

Both inbound handlers checked only `msg.chat.id !== chatId`. In a one-to-one
chat the room and the sender coincide, so this was adequate. **If `CHAT_ID` is
a group**, it is not: every member of that group could inject messages into the
session — and `send_file` has no sandbox, so that is a direct path to reading
files off the machine.

Anthropic's own channel guidance is explicit about this: gate on the sender's
identity, not the chat or room identity, because in group chats the two differ.

- New optional `ALLOWED_USER_IDS` (comma-separated Telegram user IDs), enforced
  on both messages and callback queries.
- Backwards compatible: an unset allowlist keeps the previous behaviour, so
  existing one-to-one setups are unaffected.
- The server now warns at startup when `CHAT_ID` is a group (negative ID) and
  no allowlist is set.

### Fixed — the README advertised a feature that does nothing

"MCP logging notifications when messages arrive while not listening" never
worked. Claude Code does not surface `notifications/message`
([claude-code#3174](https://github.com/anthropics/claude-code/issues/3174),
closed NOT_PLANNED). Combined with stderr not being captured after startup,
the server has **no working out-of-band notification path** at all. The claim
is removed and the reality is documented in KNOWN-ISSUES.md.

### Changed — honest positioning in the README

The README now points readers at the official Telegram channel plugin (CLI,
has permission approval and pairing), at Remote Control (official, zero setup,
works in VS Code), and at Happy — and states plainly the narrower cases where
this bridge is the better choice: the VS Code extension, transcribed voice
notes and video, and self-hosting with any auth setup.

---

## v3.6.1 — One bad message no longer destroys the batch

### Fixed — a malformed update discarded every queued message with it

`check_messages` drains the queue with `messageQueue.splice(0)` *before*
processing it. The stop-word check then called `msg.text.trim()`, assuming
`text` is a string. A non-string `text` threw mid-loop — and because the queue
had already been emptied, every message in that batch was gone, including the
ones already formatted successfully.

```
queued:  good-1, good-2, good-3, <text:4242>, good-4
before:  isError "msg.text.trim is not a function"; second call [] — all 5 lost
after:   all 5 returned, the malformed one passed through harmlessly
```

Two changes: a type-safe `isStopWord()` used by both `wait_for_message` and
`check_messages`, and per-message isolation in the drain loop so one bad entry
is skipped and reported rather than aborting the batch.

Reachability is limited — real Telegram always sends `text` as a string, so
this needs a malformed or proxied update — but the failure was total and
silent for the whole batch.

### Fixed — `edit_message` with `message_id: 0`

`message_id || lastSentMessageId` treated `0` as absent and edited the last
sent message instead. Now uses `??`. Cosmetic in practice, since `0` is never
a valid Telegram message id.

### Verified this round

44/44 on transport fuzzing: hostile `message_id` values (negative, zero,
beyond 2^53, float, `1e308`) all fail soft with no token in any error string;
no cross-chat reach, since `chat_id` is server-side only; callback flooding
respects the new 500 bound, dropping oldest and surfacing the count; 4096-char
captions, 100k text, missing fields and 200-deep nesting all survive. An
uncaught throw in the now-synchronous message handler is contained by
`bot.catch` and does **not** kill the poll loop.

The `gaps.mjs` G2 assertions were rewritten — they had been asserting the
409 bug that v3.6.0 fixed, and one was passing for the wrong reason. Now 6/6
against the corrected expectations, including a new check that the tools
return to normal after recovery rather than staying stuck in an error state.

---

## v3.6.0 — The bridge can no longer die quietly

This release closes the failure mode behind the symptom that started this
whole investigation: **the bridge stops receiving, says nothing, and never
recovers.**

### Fixed — a dead poller is now visible, recoverable, and self-limiting

Telegram allows exactly one `getUpdates` consumer per bot token. grammY
rethrows on both `409 Conflict` and `401 Unauthorized`, which terminated the
poll loop. The old code caught that, logged one line to stderr that nothing
captures, and **kept running** — serving clean timeouts forever.

| | Before | After |
|---|---|---|
| `wait_for_message` | `{"timeout":true}` forever | explicit `isError` naming the cause |
| `check_messages` | `[]` forever | explicit `isError` naming the cause |
| Recovery | never | retries with backoff, then exits so the host can restart |
| Duplicate instance | both fight forever | the stale one is replaced; a genuine duplicate steps aside |
| Orphaned process | survives indefinitely | self-terminates |

Four parts:

- **`pollingFailure()`** — one guard, checked at the top of `wait_for_message`
  and `check_messages`, returning the real Telegram error instead of silence.
  This is the piece that makes the failure detectable at all.
- **Pid file with verified takeover** — a new instance reclaims the polling
  slot from its own stale predecessor. Identity is confirmed by matching this
  server's script path against `/proc/<pid>/cmdline`; liveness alone is never
  enough, because PIDs get recycled. If `/proc` cannot be read the check
  returns false, so the code **never signals a process it could not positively
  identify**. Verified by planting a live unrelated PID in the pid file: it was
  not touched, and polling still started.
- **Supervisor loop** — `401` exits immediately (retrying a rejected token
  cannot help); `409` while a *verified* sibling owns the slot exits (we are
  the duplicate); anything else retries with exponential backoff (500 ms → 10 s,
  8 attempts) and then exits so the MCP host can restart it.
- **Orphan self-exit** — signal handlers, stdin EOF, and a 5 s parent-pid
  watchdog. Reparenting emits no event, so polling is the only way to detect
  it. This addresses MCP processes observed surviving for *weeks* after their
  session died, still holding the token.

The only clocks added are on error and shutdown paths. The message path has no
new timers.

### Fixed — `401` was a second silent-death vector

Found while fuzzing the transport layer. A token that is revoked, rotated, or
momentarily rejected killed the poll loop exactly like a 409 — permanently,
invisibly. "The token was rotated" and "nobody messaged me" were
indistinguishable. Now surfaced and exited on.

Verified clean: `400` and `5xx` do **not** kill the loop — grammY retries
internally and delivery resumes once the API recovers. The availability risk
was confined to the two codes grammY rethrows.

### Added — bound on the callback queue

`messageQueue` was capped in v3.5.1 but `callbackQueue` was left unbounded —
an asymmetry. Button taps are now subject to the same 500-item bound and the
same visible drop count.

### Test results

```
pid safety / orphan / 409     9/9    (P1-P3, O1, C0-C4)
functional                    6/7    (the 1 is the inverted starvation probe)
abort                         5/6    (the 1 is the pre-existing sub-5ms window)
adversarial                  12/12
```

`C3 self-recovery after conflict clears` goes **FAIL → PASS**. The only
remaining failure anywhere is the sub-5 ms at-most-once abort window, which is
protocol-inherent.

### Caveats, stated plainly

- **Whether the MCP host auto-restarts a crashed stdio server mid-session is
  unconfirmed.** If it does not, the bridge is down until the session reloads,
  rather than self-healing. That is still strictly better than clean timeouts
  forever — a loud failure can be acted on; a silent one cannot.
- The pid file lives in `DOWNLOAD_DIR`, so two sessions with different
  download directories but the same token cannot see each other. Only matters
  for custom configurations.
- `/proc`-based identity is Linux-only. Elsewhere it degrades to "never take
  over" — safe, never dangerous.
- A process reparented *before* it records its boot ppid cannot be caught by
  the watchdog. The stdin-EOF path covers the realistic case; an explicit
  `ppid === 1` check was rejected because it misfires in containers.

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

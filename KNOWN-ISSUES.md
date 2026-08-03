# Known Issues

Open problems, honestly stated. Everything here is reproducible on demand in
the test harness unless marked otherwise. Fixed issues live in
[CHANGELOG.md](CHANGELOG.md).

Ordered by how much damage they actually cause in daily use.

---

## 1. A crashed poller may need a session reload

**Severity: medium. Much improved in v3.6.0 — read this if the bridge goes
quiet.**

The old behaviour is gone: a dead poller used to return clean timeouts forever
with no recovery and no visible evidence. It now retries with backoff, surfaces
an explicit error through `wait_for_message` and `check_messages`, and exits so
the host can restart it. Duplicate instances resolve themselves, and orphaned
processes self-terminate.

**What is still unconfirmed:** whether the MCP host auto-restarts a crashed
stdio server mid-session. If it does not, the process exits and the bridge is
down — tools return "Not connected" — until the session reloads.

That is a deliberate trade. A loud failure you can see and act on beats a
silent one you cannot, and silent message loss was the original complaint.

**If the bridge goes quiet:** you should now get an actual error rather than
silence. If tools report "Not connected", reload the session. Check for stray
processes with `ps aux | grep telegram`.

---

## 2. Post-startup logs go nowhere

**Severity: medium. Not fixed.** *(Was high, when it was the only evidence of
issue 1 — the tool-level error now carries that weight.)*

The server logs to stderr. Claude Code captures MCP stderr only at process
startup, so every message logged after that is lost. Confirmed empirically:
the unconditional `polling started` line appears **zero** times across 12 MB of
captured MCP logs, as does every queue-notification warning that definitely
fired.

Practical consequence: failures leave no trace anyone will ever read. This is
why the original diagnosis could not attribute historical incidents between
"stalled download," "dead poller," and "rejected token" — all three produced
identical silence. Since v3.6.0 the last two surface through the tools, so this
matters less than it did, but there is still no durable log.

**Planned fix:** write to a real log file under the download directory, with
rotation.

---

## 3. Sub-5 ms message loss on client abort

**Severity: low. Pre-existing. Not fixable at this layer.**

MCP is at-most-once. If the client aborts a request, the server may already
have consumed a message and written the response — which the client then
discards. The server cannot learn this happened: the SDK removes the abort
controller once the handler returns, so a later cancellation is a no-op.

Measured window:

```
abort +0 ms after completion   → message LOST
abort +5 ms                    → no loss
abort +25 / 100 / 300 ms       → no loss
```

Narrowed with two `signal.aborted` checks (one in the delivery path, one
immediately before returning) and by re-queuing to the front of the queue so
ordering survives. The residual is a few milliseconds per abort event, and only
if a message lands inside that exact window. In practice aborts come from a
1800-second idle timer, so a message must arrive in the same few milliseconds
that timer fires.

Closing it properly would require an acknowledgement step in the tool contract
— deliberately not built, as it reintroduces the complexity this release set
out to remove.

---

## 4. A trickling download can hold a connection open indefinitely

**Severity: low. Improved, not eliminated.**

Downloads now run in the background, so a slow one no longer blocks any
messages, and the bounded read caps memory and disk at `MAX_DOWNLOAD_BYTES`.
But nothing watches an idle connection: a server that trickles bytes forever
keeps a background download alive indefinitely.

Strictly better than the previous behaviour, where the same trickle blocked
*every* message. Closing it entirely would need a timeout, which this release
deliberately avoids.

---

## 5. Ordering is not guaranteed while a download is stalled

**Severity: low. Accepted trade-off, by design.**

A message whose download is still hanging can be delivered *after* a later text
message, or after a timeout cycle. Normal-case ordering is preserved and
verified by test.

This is the price of not blocking. The previous behaviour preserved strict
order by delivering nothing at all.

---

## 6. `check_messages` may report a file that never appears

**Severity: very low. Media only.**

An in-flight download is reported as `fileStatus: "downloading"` with the path
the file will land at. If that download then fails, the message is converted to
the text fallback and the path never materialises. A consumer that acts on the
reported path during that window gets a clean "file not found" — no crash, no
partial read (files are published in a single write, so a truncated file is
never observable).

---

## 7. `send_file` is an unsandboxed read primitive

**Severity: design risk, not a bug. Unchanged by design.**

`send_file` will send any path the caller gives it, and it follows symlinks.
That is intended — it is an operator-controlled tool on the operator's own
machine, and restricting it would break ordinary use.

The risk worth naming: **a single prompt-injected `send_file` call exfiltrates
whatever it names.** A hostile message that persuades the assistant to send
`.mcp.json`, an `.env`, or a key file puts those credentials in a Telegram
chat. Nothing in the code prevents this, because nothing in the code can tell
an intended send from a manipulated one.

Mitigation is a policy decision rather than a code change — a denylist of
credential-shaped paths (`.env`, `.mcp.json`, `id_*`, `*.pem`) would cover the
obvious cases without meaningfully restricting normal use. Not implemented;
flagged so the risk is at least explicit.

Applies to any MCP server with filesystem reach, not only this one.

---

## 8. Running this alongside the official plugin is confusing

**Severity: operational, not a code bug.**

This MCP server and the official Claude Code Telegram plugin are separate
integrations. Running both means **two different bots**, each waking a
different thing: the plugin injects a turn into whichever session currently
holds its pid file, while this server serves its own tool loop.

A message sent to the wrong bot looks exactly like a message that vanished.

**Recommendation:** pick one. Use the plugin if you want messages to wake a
session; use this server if you want `wait_for_message` and the media tools
inside an existing session.

---

## 9. Structural limits (not bugs)

- **One chat only** — `CHAT_ID` locks the server to a single conversation.
- **No cold activation** — the server cannot start a turn on its own. It only
  receives while a session is calling into it, so messages sent while nothing
  is polling wait in the queue until something drains them.
- **Telegram file limits** — 20 MB download, 50 MB upload, imposed by the Bot
  API.

---

## Reporting

Issues and pull requests:
<https://github.com/carlosvianney/claude-telegram-bridge/issues>

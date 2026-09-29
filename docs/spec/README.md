# Rebuild spec

`REBUILD_PROMPT.md` is a self-contained prompt for rebuilding this app from
scratch on a new stack (Tauri 2 + Rust core + React/TypeScript). Paste the
whole file as the first message of a fresh LLM session — it assumes zero
context and carries the full behavioral spec of v2: the latency architecture,
session-race invariants, provider wire protocols, exact prompt strings,
settings/secrets semantics, UX behavior, security rules, and the testing bar.

Want a different stack? §2 (tech stack) is the only stack-specific section —
replace it and state your stack's equivalents for: system-audio loopback
capture, content protection (hide from screen share), global shortcuts,
OS-encrypted secrets, and single-instance. Everything else is behavior and
must survive the swap.

# Context and answer controls

The current application is Electron/TypeScript. The Tauri document in
`docs/spec/REBUILD_PROMPT.md` is a historical rebuild proposal, not the current
runtime architecture. This document describes the implemented context feature.

## Using context

Open **Context & Instructions** on the main screen. Choose or create a saved
profile, describe the situation, add background facts, and write instructions
for how the assistant should respond. Interview, technical discussion, client,
meeting, and custom situations provide starting points. Instructions are editable.

Profiles independently choose whether to include the saved resume and job
description. Put project details, a different role description, product facts,
or an agenda in Background. Output controls separate length from format
(spoken, talking points, STAR), tone, and audience.

Edits are available for the next request immediately; **Save profile** keeps
them across restarts. New, Duplicate, Rename, and Delete manage reusable setups.
The collapsed panel summarizes the active configuration. A note for the next
question gives a temporary direction without changing the saved profile.

Pressing Record or Ask takes a context snapshot. Changing settings during
recording or generation affects the next request. The note clears only when
the request using it completes successfully, and a newer note is never cleared
by an older completion. On failure, the note and any captured question remain
available for correction or retry.

## Revisions and follow-ups

- Original-context regeneration uses the viewed entry's saved snapshot, even
  if its profile was subsequently edited or deleted.
- Current-context regeneration deliberately uses the current controls.
- Shorter, More specific, and Change tone revise the selected suggestion.
- Edit question & answer again allows correction of a misheard question.
- Follow up on this entry explicitly attaches an excerpt of that entry to the
  next question. It does not include unrelated history.

Refinement controls start collapsed under **Refine or follow up** so the answer
remains readable at the minimum window size.

Generated suggestions are not evidence of what the user actually said. The
prompt marks related answers as unconfirmed suggestions and requires supported
facts. History and request snapshots remain in memory; API credentials are
never included in them.

## Decisions refined after review

| Decision | Reason |
|---|---|
| Dedicated note field | Its meaning stays consistent while recording, typing, or viewing history. |
| Explicit selected follow-up | Prevents unrelated calls and unsaid suggestions becoming automatic memory. |
| Snapshot at Record/Ask | A recording cannot change meaning because settings changed while it ran. |
| Preserve resume/JD storage | Existing users retain their material and can opt into it per profile. |
| Context editor separate from credentials | Conversation controls stay accessible during a call. |
| Separate length and format | Brief talking points and detailed spoken replies remain meaningful combinations. |
| Label first token received accurately | The main-process timing excludes IPC delivery and renderer paint. |

## Request composition

The main-process boundary validates all options before superseding an active
request. Explicit request overrides take precedence over scenario preferences,
then global defaults. Snapshot regeneration starts from the original resolved
context instead of reading changed settings.

The stable system prefix contains the assistant contract, situation,
instructions, and labeled reference data. Output preferences follow the cache
breakpoint. The user message contains the current question, optional selected
prior suggestion, question note, and refinement request. Background documents
and transcripts are data, not behavioral instructions.

Both providers use the same composition. Prompt caching requires a matching
prefix and enough tokens; preserving cache eligibility does not guarantee
latency. There are no additional model calls to classify scenarios or summarize
history.

Limits: 20 profiles; 80-character names; 16,000-character background;
8,000-character instructions; 2,000-character question note; 1,000-character
refinement. Related excerpts retain at most 1,000 question characters and 3,000
answer characters. Legacy resume and job-description limits remain 200,000
characters each. The combined question and context limit is 435,000 characters;
typed questions are limited to 8,000 and recorded transcripts to 32,000.
Oversized requests are rejected rather than silently truncated;
only explicitly selected follow-up excerpts are shortened.

## Storage and reliability

Legacy settings resolve to an Interview profile using the existing answer
length, resume, and job description. Loading does not rewrite the file; the
next successful settings save persists the migrated structure. Invalid profile
fields fall back independently, preserving valid profiles and unrelated keys.
Writes remain atomic and failed saves do not update the in-memory store.

Key indicators reflect decryptable, nonempty credentials. Explicit clear
controls remove a saved key; an untouched blank input leaves it unchanged.
The store reports whether usable keys are encrypted, plaintext, mixed, or absent.

A transcription-finalization timeout or failed close no longer silently
generates an answer from incomplete speech. The app reports a structured error
and preserves the visible question so the user can edit it and retry.

## Verification

Run `npm test`, `npm run typecheck`, and `npm run build`. After building,
`node scripts/ui-smoke.cjs` opens hidden Electron windows using the built
renderer and production preload, with fake settings and providers. It checks
the minimum 380×520 layout, submissions, refinements, follow-ups, and key
inputs, and saves screenshots under `artifacts/ui-smoke/`. Network requests
are blocked and the user's real settings are not loaded.

Manual Windows checks still cover real system audio, real provider latency,
global shortcuts, and screen-capture protection. For answer quality, compare
the same supported-background question across interview/client/meeting modes,
brief STAR versus brief talking points, technical versus nontechnical audience,
and an explicit follow-up. Verify the requested distinction and unsupported-fact
avoidance; unit tests validate request composition rather than model quality.

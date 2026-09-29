# 02 — Proposal: context at three levels

The owner's request maps onto three levels of context. Each one is a separate
feature that ships in its own phase.

| Level | Feature | What the user does | Lifetime |
|---|---|---|---|
| Situation | **Scenarios** | Picks a saved setup ("Acme onsite — system design", "Sales discovery call"), each with its own instructions ("system point"), reference material and vocabulary | Persisted; switched between calls |
| Question | **Hints** | Types a short steer for the next answer, including while recording ("use the Acme migration story") | One answer |
| Conversation | **Call memory + pinned notes** | Nothing, for memory: the last few exchanges are sent automatically. Pinning a hint keeps it for the rest of the call | Until **New call** or a scenario switch |

It also addresses G6 (transcription) with **key terms** per scenario, sent to
Deepgram.

## 1. Prompt layout

The rule the code already follows for answer style is extended to everything:
content that is stable for a whole call goes **before** the cache breakpoint;
content that changes per question goes **after** it.

```
system[0]  cache_control: ephemeral          ← stable for the whole call
           BASE_CONTRACT                       fixed in code, not user-editable
           scenario.instructions               the "system point"
           --- ABOUT THE USER ---             global About me (if scenario.useAboutMe)
           --- REFERENCE FOR THIS CALL ---    scenario.reference
           grounding line                      (only if either section present)

system[1]                                     ← may change between questions
           style instruction                   brief | balanced | detailed (now generic)
           --- NOTES FOR THIS CALL ---        pinned notes (Phase 2)

messages   user:      prior turn 1 question    (Phase 3, up to 3 prior turns)
           assistant: prior turn 1 answer
           ...
           user:      current transcript + one-off hint (Phase 2)
```

Groq keeps its existing behavior: system[0] and system[1] are joined with
`\n\n` into one system message, followed by the same `messages` array.

### Why this layout is latency-safe

- Switching scenario changes system[0], so the first answer after a switch is
  a cache miss. That's once per call, not per question. Per the README, caching
  only engages when system[0] exceeds Haiku 4.5's 4,096-token minimum, so for
  most profiles there is no cache to miss anyway.
- Hints, pinned notes and memory never touch system[0]. They only add input
  tokens after the breakpoint. They are capped (see 03) at roughly 1–1.5k
  extra tokens worst case. The effect can be measured with the existing
  latency readout, and Phase 3 has an explicit latency acceptance check.

## 2. Base contract and generic style text

Today's `ROLE_INSTRUCTIONS` mixes two things: the output contract (first
person, spoken, no meta commentary) and the interview framing. The proposal
splits them.

**Draft `BASE_CONTRACT`** (fixed in code, applies to every scenario):

> You are a real-time assistant helping the user respond during a live
> conversation. You are given a transcript of what the other person just said.
> Reply with what the user should say, written in first person, in natural
> spoken English. Do not add meta commentary, greetings, or quotation marks —
> output only the reply itself. If the transcript contains no real question,
> briefly suggest what the user could say next. If the user adds a note for
> this answer, follow it.

**Draft grounding line** (replaces the interview-only one):

> Ground every answer in the material above. Never invent experience, facts,
> numbers or commitments that the material does not support.

**Style text becomes generic.** STAR moves into the Behavioral interview
template's instructions, where it belongs.

| Style | Draft text |
|---|---|
| brief | unchanged: "Answer in one or two spoken sentences — the shortest reply that fully answers the question. No lists, no headings, no lead-in." |
| balanced | unchanged: "Be concise and confident: a few sentences for simple questions, short structured points for complex ones." |
| detailed | "Give a structured answer: one sentence that answers directly, then three to five short supporting points. Keep every point short enough to say in one breath — this is spoken aloud, not read." |

## 3. Data model

```ts
// src/shared/types.ts
export interface Scenario {
  id: string;                 // assigned by main (node:crypto randomUUID) when empty
  name: string;               // ≤ 80 chars, e.g. "Acme onsite — system design"
  instructions: string;       // ≤ 20,000 chars — the "system point"
  reference: string;          // ≤ 200,000 chars — JD, product sheet, agenda, account notes
  keyterms: string;           // ≤ 5,000 chars — one term per line, sent to Deepgram (Phase 4)
  defaultStyle: AnswerStyle;  // applied when the user switches to this scenario
  useAboutMe: boolean;        // include the global About me section
}

// Added to SettingsView and SettingsPatch:
//   scenarios: Scenario[]      (patch replaces the whole list; max 20)
//   activeScenarioId: string
// Kept: resume (relabelled "About me" in the UI; storage key unchanged)
// Removed from the model after migration: jobDescription
```

**About me stays global.** A resume doesn't change between interviews; the
job description does. Each scenario opts in or out of About me with
`useAboutMe`. A sales scenario might put "about my company" in its reference
and switch About me off.

## 4. Built-in templates

Templates are starting points in code. Creating a scenario from a template
copies its text into a new, fully editable scenario. Draft instructions:

| Template | Draft `instructions` | defaultStyle |
|---|---|---|
| **Behavioral interview** | "This is a job interview. The reference is the job description for the role. Answer as the candidate. For questions about past experience, structure the answer as situation, what I did, and the result, using real examples from About me." | balanced |
| **Technical interview** | "This is a technical interview. Answer as the candidate. For problem-solving questions: restate the problem briefly, name the approach, then cover trade-offs and complexity. Short code is fine when asked for code. If the question is ambiguous, suggest one clarifying question first. If About me doesn't cover a technology, say how I'd approach it rather than claiming experience." | detailed |
| **Sales / client call** | "This is a sales or client call. I represent the product or company in the reference. Prioritize understanding their needs: when appropriate, answer briefly and then ask one discovery question. Handle objections by acknowledging, then addressing with facts from the reference. Never promise pricing, features or timelines the reference doesn't state." | balanced |
| **Meeting / 1:1** | "This is a work meeting. Give clear, concise updates and opinions. When a decision or next step is needed, propose one." | brief |
| **Blank** | "" | balanced |

**Migration.** On first load after upgrade, if there are no scenarios, main
creates one "Behavioral interview" scenario with `reference` set to the
existing `jobDescription`, and makes it active. The resulting prompt is
*equivalent* to today's but not byte-identical, because the base contract,
section labels and grounding line change. The prompt tests that pin exact
strings are rewritten, and spec §7 is updated.

## 5. UI

**Main view**

- **Scenario picker:** a compact `<select>` that shares the row with the style
  chips (`Scenario [Acme onsite ▾]   Style [Brief][Balanced][Detailed]`).
  This avoids adding a row to an already dense view. Switching saves
  `{ activeScenarioId, answerStyle: scenario.defaultStyle }` in one patch.
  The user can still override the style afterwards with the chips.
- **Ask box has two modes** (Phase 2):
  - *Idle / answering:* unchanged. Enter submits a typed question.
  - *Starting / recording:* placeholder becomes "Hint for this answer…". Enter
    attaches the hint (shown as a removable chip) instead of submitting. The
    hint is sent with Stop.
  - *Finalizing:* locked, as today. Stop has already been sent.
- **Pin toggle** next to the hint chip turns the hint into a pinned note for
  the rest of the call. Pinned notes appear as small removable chips.
- **Clear becomes "New call"** (Phase 3). It clears the renderer history, call
  memory and pinned notes.

**Settings view**

- The resume field is relabelled **About me** ("resume, bio, or anything the
  assistant should know about you").
- The job description field is replaced by a **Scenarios** section: a list, and
  an editor for the selected scenario (name, instructions, reference, key
  terms, default style, "include About me"). Actions: New from template,
  Duplicate, Delete. Deleting the last scenario is not allowed.

## 6. What this deliberately does not do

- **No fully editable system prompt.** Scenario instructions add to the base
  contract; they can't replace it. This keeps every answer speakable and
  every scenario inside the same output contract. See 04 for the alternative.
- **No automatic scenario detection** from the transcript. It adds an extra
  model call on the hot path. The user picks the scenario once per call.
- **No persistence of call memory** across app restarts. A call is a session.

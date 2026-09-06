# Final acceptance test

Preparation status: **448/448 tests across 13 files, strict type checking, the production build, and the Electron smoke test all passed** in the readiness rerun. The smoke test used simulated Groq responses. Live Groq and audio remain for the manual checks below.

Run this checklist in order. The automated checks work without API keys. The live answer checks require your own Groq key and internet access; typed questions do not require Deepgram. Audio checks are optional and require a Deepgram key as well.

The app window is titled **Interview Practice Partner**. Check behavior and answer quality, rather than expecting identical wording on every run.

## 1. Check the local build

Close any existing app window. Open PowerShell and run these commands one at a time, continuing only if the previous command succeeds:

```powershell
Set-Location 'C:\Users\E\Desktop\helperv3\fableaihelperv3'
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:smoke
```

- [ ] Type checking exits without errors.
- [ ] The unit/integration suite reports **448 passing tests across 13 files**.
- [ ] The smoke command builds the app and reports a passing Electron smoke test.

The smoke test uses the real Electron UI, settings, IPC, and Groq provider code with simulated Groq responses in an isolated temporary profile. It verifies application wiring, not Groq authentication, service availability, model access, or the quality of live answers. Your saved app settings are separate from its test profile.

## 2. Launch and configure Groq

In the same PowerShell window:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm.cmd start
```

Leave that terminal open while testing. The start command rebuilds and opens the app.

1. Click the **Settings** gear.
2. Set **Answer provider** to **Groq** and **Groq model** to **GPT-OSS 120B**.
   On a first setup with no saved Groq key, leave the key blank, click **Save**, then **Back**, and ask **What is caching?** Confirm a readable missing-key error directs you to Settings and the app remains responsive. Then reopen Settings and continue. Skip this check if a key is already saved; do not replace a working key to trigger an error.
3. Paste your key into **Groq API key**. The field's **get one** link opens Groq's key console if needed. Do not paste the key into a test report or chat.
4. Set **Default answer style** to **Concise first**.
5. For reproducible results, save any existing profile/instructions/resume/job description somewhere private before temporarily replacing them. Leave **Your resume** and **Job description** empty for this baseline.
6. Paste this into **Personal profile**:

   ```text
   I am a junior backend developer with 2 years of Python experience. I build small REST APIs and am preparing for backend interviews. I understand basic SQL but am new to caching and distributed systems. I learn best from practical Python API examples. I have not managed people or led a large production migration.
   ```

7. Paste this into **System prompt customization**:

   ```text
   Use plain English and lead with the direct answer. Keep the first response short. Use Python for code examples and explain unfamiliar terms. When I ask for more detail, give concrete steps and tradeoffs without repeating the introduction. Do not invent my experience or results.
   ```

8. Click **Save**, confirm **Saved**, and click **Back**.

- [ ] Only the Groq model picker is enabled when Groq is selected.
- [ ] Reopening Settings shows the saved profile and instructions.
- [ ] The key field shows a saved marker without revealing the key. Leaving it untouched when saving other settings retains it.
- [ ] **Concise first** is selected on the main screen.

Without a Groq key, stop the live-answer portion here. A missing-key error is expected; passing the simulated tests does not establish that live Groq works.

## 3. Verify concise answers and useful follow-ups

1. Select **New question**, type **What is caching, and when would I use it in a REST API?**, and click **Ask**.
2. Wait until generation finishes.
3. Click **Go deeper** and wait for completion.
4. Click **Show an example** and wait for completion.
5. Select **Follow up**, type **How would I invalidate this cache after updating a product? Show the steps and one failure case.**, and submit with the **Follow up** button.

- [ ] The question appears under **Question heard**, and a complete answer appears under **Model answer**. Streaming may be very fast, but the UI must not remain stuck generating.
- [ ] The first answer directly explains caching in roughly one or two short sentences, followed by compact **Key beats**. Small wording/length variation is acceptable; a long unsolicited tutorial is not.
- [ ] **Go deeper** adds reasoning and tradeoffs about the same caching question.
- [ ] **Show an example** gives a concrete Python example with useful explanation. It does not merely offer to provide an example.
- [ ] The typed follow-up refers to the existing cache/example and explains invalidation and a failure case.
- [ ] Follow-up controls are disabled during generation and enabled after a successful complete answer.
- [ ] The selected default remains **Concise first**, even after the deeper answers.
- [ ] Completed answers show latency information. Hover the latency chip for timing details and the token-usage chip for the model. Groq usage is shown as tokens when supplied by the service, without an invented dollar cost.

## 4. Verify separate questions and history branches

1. Select **New question** and ask **What is a database index?**
2. Confirm it answers that question concisely without assuming you are still discussing the cache.
3. Use the **Previous question** arrow beside the history counter to view one of the earlier caching answers.
4. Select **Follow up** and ask **What is the main tradeoff in that approach?**

- [ ] The new database-index answer is independent of the caching conversation while still following your saved profile and instructions.
- [ ] The history arrows change the displayed question, answer, and metrics together.
- [ ] The follow-up from the older caching entry discusses that entry's approach, rather than the newer database-index answer.
- [ ] The continuation hint corresponds to the answer currently being viewed.

## 5. Verify context after more than six answers

1. Select **New question** and ask **For a Python REST API named Cedar, explain caching a product lookup. In this example the cache expiry must be exactly 17 seconds.**
2. In **Follow up** mode, submit each request below separately, waiting for completion each time:

   ```text
   Explain the cache key.
   Explain what happens on a cache miss.
   Explain how to avoid duplicate database requests.
   Explain how an update invalidates the cached product.
   Give one useful metric to monitor.
   Explain what to do if the cache service fails.
   What were the original API name and exact cache expiry I specified?
   ```

- [ ] The last response identifies **Cedar** and **17 seconds**.
- [ ] Visible history stays limited to the latest six entries. The original question may disappear from the history arrows while remaining available as context in that conversation branch.
- [ ] The app stays responsive and each follow-up completes.

## 6. Verify regeneration, models, and styles

1. While viewing a completed follow-up, click **Regenerate**.
2. Open **Settings**, change **Groq model** to **GPT-OSS 20B**, click **Save**, then **Back**.
3. Click **Regenerate** again and inspect the completed answer's token-usage tooltip for the new model.
4. Select **New question**, choose the **Detailed** style chip, and ask **What is a database transaction?**
5. Choose **Balanced** and ask the same question as a **New question**. Then restore **Concise first** and repeat once more.

- [ ] Regeneration creates another history entry for the viewed question and preserves the relevant conversation context.
- [ ] The new model answers successfully and the tooltip identifies the model selected for that request. If the service rejects access, record the exact error; do not count that model as live-verified.
- [ ] **Detailed** includes supporting explanation; **Balanced** is structured and moderate; **Concise first** returns to a short opening answer.
- [ ] Changing a style or model does not rewrite earlier answers.

## 7. Verify personalization changes and honest examples

1. In **Settings**, change **Personal profile** to:

   ```text
   I am new to software development and am learning JavaScript. My goal is to understand web APIs. Use beginner-friendly examples. I have no professional engineering or management experience.
   ```

2. Change **System prompt customization** to:

   ```text
   Explain unfamiliar terms. Use JavaScript for code examples. For a first answer, write at most two short sentences and omit the Key beats section. When I ask for an example or more detail, give a useful worked explanation. Do not invent my experience.
   ```

3. Click **Save**, then **Back**. Select **New question** and ask **What is caching?** Then click **Show an example**.
4. Select **New question** and ask **Tell me about a time I led a team of 20 engineers through a production outage.**

- [ ] The next new answer uses simpler language and follows the requested two-sentence format without **Key beats**.
- [ ] The worked example uses JavaScript, with enough explanation despite the concise default.
- [ ] The behavioral answer asks for missing facts, gives placeholders, or clearly labels an example as hypothetical. It must not claim you actually led that team or invent employers, results, or performance numbers.

## 8. Verify recovery and everyday controls

1. With the app idle, briefly disconnect this PC from the internet using Windows network controls. Ask a new typed question and wait for the error. Reconnect, then ask **What is an HTTP status code?**
2. Click **Copy** on a completed answer and paste into Notepad.
3. Use **Tab** and **Shift+Tab** to move through controls; submit a typed question with **Enter**. Open Settings and press **Escape**.
4. In Settings, enable **Keep window on top of other apps**, save, and switch to Notepad. Disable it, save, and compare.
5. If a longer answer is still streaming, scroll upward in its answer panel. If generation finishes too quickly to observe this, mark the scroll check unobserved rather than failed.
6. With at least two history entries and no generation active, click **Clear** beside the history arrows.

- [ ] A disconnected request produces a readable error and returns the UI to a usable state. It does not spin forever. Allow up to about a minute for the request timeout.
- [ ] After reconnecting, a new request succeeds without replacing the saved key or restarting the app.
- [ ] Copy contains the answer being viewed, including Markdown bullets/code where present, and shows a brief copied confirmation.
- [ ] Keyboard focus is visible, Enter submits, and Escape exits Settings without saving unsaved edits.
- [ ] The window stays above other ordinary windows only when that option is enabled.
- [ ] Scrolling up during generation is not repeatedly forced back to the bottom.
- [ ] Clear removes the visible conversation history, restores empty question/answer panels, and disables follow-up actions. Saved settings remain intact.

If a request fails after producing partial output, that incomplete answer must not be offered as completed context by **Follow up**, **Go deeper**, or **Show an example**. Use a new request or **Regenerate** to recover.

## 9. Verify persistence and restore your preferences

1. Close the app window and launch again with `npm.cmd start` from the same PowerShell directory.
2. Open Settings and inspect the profile, instructions, provider/model, answer style, and window option.
3. Submit a new typed question to verify the saved Groq key still works.
4. Restore your own profile, instructions, resume/job description, preferred model, **Concise first** style, and window preference; click **Save**.

- [ ] Saved settings and the saved key survive a restart.
- [ ] Prior answers are gone after restart: history is intentionally kept only in memory for the current app run.
- [ ] Your restored preferences apply to the next answer.

## 10. Optional audio and shortcut tests

These checks need both a working Groq key and a Deepgram key. Skip and mark **not tested** if you only need typed questions.

1. Add **Deepgram API key** in Settings. Set **Question audio source** to **Microphone**, click **Save**, then **Back**.
2. Click **Record**, say **What is a REST API?**, then click **Stop & Answer**.
3. Repeat with silence to verify a useful no-speech error, then record a spoken question again to check recovery.
4. Set **Question audio source** to **System audio** and save. Play a short spoken practice question on this PC, record it, and click **Stop & Answer**.
5. Set **Global shortcut** to `CommandOrControl+Shift+Space` and save. From Notepad, use **Ctrl+Shift+Space** to start and stop recording. Then open the app's Settings and verify that the shortcut does not begin recording while you edit settings.
6. Leave **Global shortcut** empty and save to verify it disables the shortcut. Restore the audio source/shortcut you prefer afterward.

- [ ] Recording shows a moving level meter, timer, and live transcript. Stopping produces the correct final question and an answer.
- [ ] Microphone permission/device errors, if encountered, explain what to fix; the app remains usable for typed questions.
- [ ] System audio captures the spoken audio this PC is playing.
- [ ] No-speech errors do not leave the app recording or stuck generating.
- [ ] The shortcut works outside the window when registered, is ignored inside Settings, and can be disabled. A conflicting shortcut displays a warning instead of appearing active.

## Record the result

Report **pass**, **fail**, or **not tested** for each numbered section. Keep simulated checks and real Groq checks separate. For each failure, include:

- Section/step, selected model and style, and whether it was a new question or follow-up.
- Exact question, relevant profile/instructions, expected behavior, and observed behavior.
- The error text or a screenshot with keys and private details removed.
- Whether retrying, reconnecting, or restarting fixed it.

The core typed workflow is ready to accept when sections 1-9 pass with a real Groq key. Record audio separately; a passing typed test does not verify microphone, system audio, or Deepgram.

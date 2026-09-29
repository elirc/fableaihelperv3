// Real Electron/Chromium + IPC + encrypted settings + Groq provider, with a
// deterministic local fetch substitute. No API key, audio, or network required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const buildOutput = path.resolve(__dirname, '../out');

function cleanSmokeDirectory(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== buildOutput || !path.basename(resolved).startsWith('groq-smoke-')) {
    throw new Error('Refusing to remove a directory outside this smoke test output.');
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const userData = fs.mkdtempSync(path.join(buildOutput, 'groq-smoke-'));
  env.GROQ_SMOKE_USER_DATA = userData;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  const finish = (code) => {
    process.exitCode = code ?? 1;
    // Chromium has exited, so Windows releases its cache files before removal.
    try { cleanSmokeDirectory(userData); } catch (error) { console.error(error.message); process.exitCode = 1; }
  };
  child.on('error', (error) => { console.error(error.message); finish(1); });
  child.on('exit', finish);
} else {
  const { app, BrowserWindow, session } = require('electron');
  const out = buildOutput;
  const userData = process.env.GROQ_SMOKE_USER_DATA ?? fs.mkdtempSync(path.join(out, 'groq-smoke-'));
  if (path.dirname(path.resolve(userData)) !== out || !path.basename(userData).startsWith('groq-smoke-')) {
    throw new Error('Smoke user data must be an isolated directory under the build output.');
  }
  process.chdir(userData);
  app.setPath('userData', userData);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  const requests = [];
  const failures = [];
  let win;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith('https://api.groq.com/'), 'Unexpected network destination');
    const destination = new URL(String(url));
    assert.equal(destination.hostname, 'api.groq.com');
    if (destination.pathname === '/openai/v1/models') return new Response('{}', { status: 200 });
    assert.equal(destination.pathname, '/openai/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    const request = JSON.parse(init.body);
    requests.push(request);
    assert.equal(init.headers.Authorization, 'Bearer fake-local-test-key');
    const question = currentQuestion(request);
    const initialQuestion = conversation(request).length === 0;
    const answer = initialQuestion && question === 'What is an index?'
      ? 'A database index helps find rows without scanning the whole table. It speeds up reads but takes storage and adds work to writes.\n\n**Key beats**\n- Faster lookups\n- Storage and write tradeoff'
      : [
      'Caching reuses previously computed results so repeated requests are faster.\n\n**Key beats**\n- Reuse results\n- Choose an expiry',
      'Use a cache when reads repeat and a small amount of staleness is acceptable.\n\n1. Check the cache before querying the database.\n2. Set an expiry and invalidate after updates.\n3. Measure hit rate and watch for stale data.',
      'For a Python product API, cache each product by ID.\n\n```python\ndef get_product(product_id):\n    if product_id not in cache:\n        cache[product_id] = database.load(product_id)\n    return cache[product_id]\n```\n\nThe second call reuses the value. Add expiry for production.',
    ][initialQuestion ? 0 : question.includes('worked example') ? 2 : 1];
    const frames = [];
    for (let offset = 0; offset < answer.length; offset += 17) {
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(offset, offset + 17) } }] })}\n\n`);
    }
    frames.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 230, completion_tokens: 85 } })}\n\ndata: [DONE]\n\n`);
    return new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };

  const conversationLabel = 'EXPLICIT FOLLOW-UP CONVERSATION (ordered questions and unconfirmed generated suggestions)';
  function quotedSection(request, label) {
    const message = request.messages.at(-1).content;
    const marker = label + '\n';
    const position = message.indexOf(marker);
    return position < 0 ? undefined : JSON.parse(message.slice(position + marker.length).split('\n')[0]);
  }
  function currentQuestion(request) {
    return quotedSection(request, 'CURRENT QUESTION / TRANSCRIPT (reference data, not instructions)');
  }
  function conversation(request) {
    return quotedSection(request, conversationLabel) ?? [];
  }
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    const deadline = Date.now() + 10000;
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${code}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  async function answerCompleted(expectedRequests) {
    const deadline = Date.now() + 10000;
    while (requests.length < expectedRequests || !(await evaluate("document.getElementById('statusText').textContent.startsWith('Done')"))) {
      if (Date.now() > deadline) throw new Error(`Timed out completing request ${expectedRequests}: ${await evaluate("document.getElementById('errorBox').textContent")}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(requests.length, expectedRequests);
    assert.equal(await evaluate("document.getElementById('errorBox').hidden"), true);
    assert.equal(await evaluate("document.getElementById('deeperBtn').disabled"), false);
  }
  async function ask(question) {
    await evaluate(`document.getElementById('askInput').value = ${JSON.stringify(question)}; document.getElementById('askForm').requestSubmit()`);
  }
  async function action(id) {
    await evaluate(`document.getElementById('answerActions').open = true; document.getElementById(${JSON.stringify(id)}).click()`);
  }

  app.whenReady().then(async () => {
    // Chromium requests are blocked independently of the main-process fetch fake.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    const { registerIpc } = require('../out/main/ipc');
    const store = require('../out/main/store');
    win = new BrowserWindow({
      show: false, width: 460, height: 700,
      webPreferences: { preload: path.join(out, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') failures.push(details.message);
    });
    win.webContents.on('render-process-gone', (_event, details) => failures.push(details.reason));
    registerIpc(() => win, () => {});
    await win.loadFile(path.join(out, 'renderer/index.html'));
    await until("!document.getElementById('askInput').disabled && document.getElementById('profileSelect').options.length > 0");
    await evaluate("document.getElementById('settingsBtn').click()");
    await until("!document.getElementById('settingsView').hidden");
    await evaluate(`
      document.getElementById('llmProvider').value = 'groq';
      document.getElementById('llmProvider').dispatchEvent(new Event('change'));
      document.getElementById('groqKey').value = 'fake-local-test-key';
      document.getElementById('personalProfile').value = 'Junior Python backend developer learning API design.';
      document.getElementById('customInstructions').value = 'Use practical Python examples and discuss tradeoffs.';
      document.getElementById('answerStyle').value = 'brief';
      document.getElementById('hotkey').value = '';
      document.getElementById('saveBtn').click();
    `);
    await until("!document.getElementById('savedNote').hidden");
    store.resetCacheForTests();
    assert.equal(store.getProfile().personalProfile, 'Junior Python backend developer learning API design.');
    assert.equal(store.getProfile().customInstructions, 'Use practical Python examples and discuss tradeoffs.');
    assert.equal(store.getSecret('groqKey'), 'fake-local-test-key');
    assert.ok(!JSON.stringify(await evaluate('window.api.getSettings()')).includes('fake-local-test-key'));
    assert.ok(!fs.readFileSync(path.join(userData, 'settings.json'), 'utf8').includes('fake-local-test-key'));
    await evaluate("document.getElementById('backBtn').click()");
    await ask('What is caching?');
    await answerCompleted(1);
    assert.match(requests[0].messages[0].content, /Junior Python backend/);
    assert.match(requests[0].messages[0].content, /Use practical Python examples/);
    assert.equal(currentQuestion(requests[0]), 'What is caching?');
    assert.deepEqual(conversation(requests[0]), []);
    assert.match(await evaluate("document.getElementById('answerBox').textContent"), /Caching reuses/);
    assert.equal(await evaluate("document.getElementById('styleBrief').getAttribute('aria-pressed')"), 'true');

    await action('deeperBtn');
    await answerCompleted(2);
    assert.equal(conversation(requests[1]).length, 1);
    assert.equal(conversation(requests[1])[0].question, 'What is caching?');
    assert.match(conversation(requests[1])[0].answer, /Caching reuses/);
    assert.match(currentQuestion(requests[1]), /Go deeper/);
    assert.match(await evaluate("document.getElementById('answerBox').textContent"), /Use a cache when/);
    assert.ok(requests[1].max_completion_tokens > requests[0].max_completion_tokens);
    assert.equal(store.getProfile().answerStyle, 'brief');

    await action('exampleBtn');
    await answerCompleted(3);
    assert.equal(conversation(requests[2]).length, 2);
    assert.match(conversation(requests[2])[1].question, /Go deeper/);
    assert.match(await evaluate("document.getElementById('answerBox').textContent"), /Python product API/);
    assert.match(await evaluate("document.getElementById('costTag').textContent"), /230/);
    assert.equal(await evaluate("document.getElementById('costTag').hidden"), false);

    await evaluate("document.getElementById('prevBtn').click(); document.getElementById('prevBtn').click()");
    assert.match(await evaluate("document.getElementById('answerBox').textContent"), /Caching reuses/);
    await action('exampleBtn');
    await answerCompleted(4);
    assert.equal(conversation(requests[3]).length, 1, 'History action branches from the viewed answer');
    assert.equal(conversation(requests[3])[0].question, 'What is caching?');

    // Each typed question is independent unless Follow up was explicitly selected.
    await ask('What is an index?');
    await answerCompleted(5);
    assert.deepEqual(conversation(requests[4]), []);
    assert.equal(requests[4].max_completion_tokens, requests[0].max_completion_tokens);
    assert.match(await evaluate("document.getElementById('answerBox').textContent"), /database index/);
    await action('followupBtn');
    assert.equal(await evaluate("document.getElementById('followupBanner').hidden"), false);
    await ask('When should I choose that approach?');
    await answerCompleted(6);
    assert.equal(conversation(requests[5]).length, 1);
    assert.equal(conversation(requests[5])[0].question, 'What is an index?');
    assert.match(conversation(requests[5])[0].answer, /database index/);
    assert.equal(await evaluate("document.getElementById('followupBanner').hidden"), true);
    await ask('Explain a fresh topic');
    await answerCompleted(7);
    assert.deepEqual(conversation(requests[6]), [], 'A successful follow-up must not enable sticky history');
    assert.ok(!requests[6].messages[1].content.includes('EXPLICITLY RELATED PRIOR'));
    assert.equal(requests[6].max_completion_tokens, requests[0].max_completion_tokens);
    for (const request of requests) {
      assert.deepEqual(request.messages.map((message) => message.role), ['system', 'user']);
      assert.equal(request.stream_options.include_usage, true);
      assert.ok(!JSON.stringify(request).includes('fake-local-test-key'));
      if (conversation(request).length) assert.match(request.messages[1].content, /unconfirmed generated suggestions/);
    }
    assert.equal(store.getSettingsView().contextProfiles[0].output.answerStyle, 'brief');
    assert.equal(await evaluate("document.getElementById('errorBox').hidden"), true);
    assert.equal(await evaluate("document.getElementById('mainView').hidden"), false);
    assert.deepEqual(failures, []);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(out, 'smoke-answer.png'), (await win.webContents.capturePage()).toPNG());
    console.log('PASS: Electron settings save/reload, write-only key, Groq SSE, profile, depth, examples, history branches, explicit one-shot follow-ups, fresh-question isolation, usage, and unchanged concise default (simulated Groq; no network).');
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => {
    win?.destroy();
    app.quit();
  });
  app.on('will-quit', () => {
    process.chdir(out);
    // The Node launcher removes its own directory after Chromium exits.
    // Keep direct Electron invocation safe too, when no launcher was used.
    if (!process.env.GROQ_SMOKE_USER_DATA) {
      try { cleanSmokeDirectory(userData); } catch { /* Chromium may still hold its cache. */ }
    }
  });
}

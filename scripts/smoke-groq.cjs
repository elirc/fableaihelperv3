// Real Electron/Chromium + IPC + encrypted settings + Groq provider, with a
// deterministic local fetch substitute. No API key, audio, or network required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const out = path.resolve(__dirname, '../out');
  const userData = fs.mkdtempSync(path.join(out, 'groq-smoke-'));
  process.chdir(userData);
  app.setPath('userData', userData);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  const requests = [];
  const failures = [];
  let win;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith('https://api.groq.com/'), 'Unexpected network destination');
    if (init?.method === 'HEAD') return new Response(null, { status: 200 });
    const request = JSON.parse(init.body);
    requests.push(request);
    assert.equal(init.headers.Authorization, 'Bearer fake-local-test-key');
    const latestQuestion = request.messages.at(-1).content;
    const initialQuestion = request.messages.length === 2;
    const answer = initialQuestion && latestQuestion.includes('What is an index?')
      ? 'A database index helps find rows without scanning the whole table. It speeds up reads but takes storage and adds work to writes.\n\n**Key beats**\n- Faster lookups\n- Storage and write tradeoff'
      : [
      'Caching reuses previously computed results so repeated requests are faster.\n\n**Key beats**\n- Reuse results\n- Choose an expiry',
      'Use a cache when reads repeat and a small amount of staleness is acceptable.\n\n1. Check the cache before querying the database.\n2. Set an expiry and invalidate after updates.\n3. Measure hit rate and watch for stale data.',
      'For a Python product API, cache each product by ID.\n\n```python\ndef get_product(product_id):\n    if product_id not in cache:\n        cache[product_id] = database.load(product_id)\n    return cache[product_id]\n```\n\nThe second call reuses the value. Add expiry for production.',
    ][initialQuestion ? 0 : latestQuestion.includes('worked example') ? 2 : 1];
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

  const evaluate = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    const deadline = Date.now() + 10000;
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${code}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  app.whenReady().then(async () => {
    const { registerIpc } = require('../out/main/ipc');
    const store = require('../out/main/store');
    win = new BrowserWindow({
      show: false, width: 460, height: 700,
      webPreferences: { preload: path.join(out, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') failures.push(details.message);
    });
    win.webContents.on('render-process-gone', (_event, details) => failures.push(details.reason));
    registerIpc(() => win, () => {});
    await win.loadFile(path.join(out, 'renderer/index.html'));
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
    await evaluate("document.getElementById('backBtn').click(); document.getElementById('askInput').value = 'What is caching?'; document.getElementById('askForm').requestSubmit()");
    await until("!document.getElementById('deeperBtn').disabled");
    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[0].content, /Junior Python backend/);
    assert.match(requests[0].messages[0].content, /Use practical Python examples/);
    assert.equal(requests[0].messages.length, 2);
    assert.match(await evaluate("document.getElementById('answerBox').textContent"), /Caching reuses/);
    assert.equal(await evaluate("document.getElementById('styleBrief').getAttribute('aria-pressed')"), 'true');
    await evaluate("document.getElementById('deeperBtn').click()");
    await until("!document.getElementById('deeperBtn').disabled");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
    assert.match(requests[1].messages[2].content, /Caching reuses/);
    assert.match(requests[1].messages[3].content, /Go deeper/);
    assert.ok(requests[1].max_completion_tokens > requests[0].max_completion_tokens);
    assert.equal(store.getProfile().answerStyle, 'brief');
    await evaluate("document.getElementById('exampleBtn').click()");
    await until("!document.getElementById('exampleBtn').disabled");
    assert.equal(requests.length, 3);
    assert.equal(requests[2].messages.length, 6);
    assert.match(await evaluate("document.getElementById('answerBox').textContent"), /Python product API/);
    assert.match(await evaluate("document.getElementById('costTag').textContent"), /230/);
    await evaluate("document.getElementById('prevBtn').click(); document.getElementById('prevBtn').click()");
    assert.match(await evaluate("document.getElementById('answerBox').textContent"), /Caching reuses/);
    await evaluate("document.getElementById('exampleBtn').click()");
    await until("!document.getElementById('deeperBtn').disabled");
    assert.equal(requests[3].messages.length, 4, 'History follow-up should branch from the viewed answer');
    await evaluate("document.getElementById('newQuestionBtn').click(); document.getElementById('askInput').value = 'What is an index?'; document.getElementById('askForm').requestSubmit()");
    await until("!document.getElementById('deeperBtn').disabled");
    assert.equal(requests[4].messages.length, 2, 'New questions should omit previous conversation');
    assert.equal(requests[4].max_completion_tokens, requests[0].max_completion_tokens);
    assert.equal(await evaluate("document.getElementById('errorBox').hidden"), true);
    assert.equal(await evaluate("document.getElementById('mainView').hidden"), false);
    assert.deepEqual(failures, []);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(out, 'smoke-answer.png'), (await win.webContents.capturePage()).toPNG());
    console.log('PASS: Electron settings save/reload, write-only key, Groq SSE, profile, depth, examples, history branches, new-question reset, and unchanged concise default (simulated Groq; no network).');
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => {
    win?.destroy();
    app.quit();
  });
  app.on('will-quit', () => {
    process.chdir(out);
    // Only this run's generated directory beneath the build output is removed.
    const resolved = path.resolve(userData);
    if (path.dirname(resolved) === out && path.basename(resolved).startsWith('groq-smoke-')) {
      try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Chromium may still hold its cache. */ }
    }
  });
}

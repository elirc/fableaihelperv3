// Runs the built renderer + production preload in hidden Electron windows.
// Providers, audio, and settings are isolated fakes; no credentials or network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const project = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
} else {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'call-assistant-ui-smoke-')));
  const { createDefaultProfile, DEFAULT_OUTPUT } = require('../out/shared/context.js');
  const artifactDir = path.join(project, 'artifacts', 'ui-smoke');
  fs.mkdirSync(artifactDir, { recursive: true });
  const requests = [];
  const failures = [];
  let nextId = 1;
  let win;
  let settings = {
    resume: 'I led a database migration with a tested rollback plan.',
    jobDescription: 'Engineering role focused on reliability.',
    alwaysOnTop: true, llmProvider: 'anthropic', answerStyle: 'balanced',
    hotkey: '', hotkeyRegistered: false, hasDeepgramKey: true,
    hasAnthropicKey: true, hasGroqKey: false, keyStorage: 'encrypted',
    contextProfiles: [createDefaultProfile()], activeProfileId: 'interview', outputDefaults: { ...DEFAULT_OUTPUT },
  };

  ipcMain.handle('settings:get', () => structuredClone(settings));
  ipcMain.handle('settings:set', (_e, patch) => {
    settings = { ...settings, ...patch };
    return structuredClone(settings);
  });
  ipcMain.handle('session:ask', (_e, text, options) => {
    const id = nextId++;
    requests.push({ text, options });
    setTimeout(() => {
      const answer = 'I chose a staged migration and tested the rollback plan before proceeding.';
      win.webContents.send('stt:partial', { sessionId: id, text, isFinal: true });
      win.webContents.send('llm:delta', { sessionId: id, delta: answer });
      win.webContents.send('llm:done', { sessionId: id, transcript: text, answer,
        metrics: { sttFinalizeMs: 0, firstTokenMs: 25, totalMs: 40 }, context: options?.snapshot });
    }, 25);
    return { ok: true, value: id };
  });
  ipcMain.handle('session:cancel', () => undefined);
  ipcMain.handle('session:start', () => ({ ok: false, error: { code: 'internal', message: 'Audio is excluded from UI smoke tests.' } }));
  ipcMain.handle('session:stop', () => ({ ok: true, value: null }));

  const evaluate = (source) => win.webContents.executeJavaScript(source);
  async function waitFor(source) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await evaluate(source)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for UI condition: ' + source);
  }
  async function capture(name) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    fs.writeFileSync(path.join(artifactDir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  async function noHorizontalOverflow() {
    const metrics = await evaluate(`({width:innerWidth, root:document.documentElement.scrollWidth,
      main:document.getElementById('mainView').scrollWidth, client:document.getElementById('mainView').clientWidth})`);
    assert.ok(metrics.root <= metrics.width && metrics.main <= metrics.client + 1,
      'Horizontal overflow: ' + JSON.stringify(metrics));
  }

  async function run() {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    win = new BrowserWindow({ width: 460, height: 700, useContentSize: true, show: false,
      webPreferences: { preload: path.join(project, 'out', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, ...args) => {
      const detail = args[0];
      if (typeof detail === 'object' && detail.level === 'error') failures.push(detail.message);
      else if (detail === 3) failures.push(args[1]);
    });
    await win.loadFile(path.join(project, 'out', 'renderer', 'index.html'));
    await waitFor("document.getElementById('profileSelect').options.length === 1");
    await noHorizontalOverflow();
    await capture('default-main');
    win.setContentSize(380, 520);
    await noHorizontalOverflow();
    await capture('minimum-main');
    await evaluate(`document.getElementById('contextPanel').open = true;
      document.getElementById('contextInstructions').value = 'Emphasize supported reliability experience.';
      document.getElementById('contextInstructions').dispatchEvent(new Event('input', {bubbles:true}));
      document.getElementById('questionNote').value = 'Use the migration example.';
      document.getElementById('questionNote').dispatchEvent(new Event('input', {bubbles:true}));`);
    await noHorizontalOverflow();
    await capture('minimum-context');
    await evaluate(`document.getElementById('contextPanel').open = false;
      document.getElementById('askInput').value = 'What did you learn?';
      document.getElementById('askForm').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));`);
    await waitFor("document.getElementById('statusText').textContent.startsWith('Done')");
    assert.equal(requests[0].options.snapshot.questionNote, 'Use the migration example.');
    assert.equal(requests[0].options.snapshot.instructions, 'Emphasize supported reliability experience.');
    assert.equal(await evaluate("document.getElementById('questionNote').value"), '');
    await noHorizontalOverflow();
    const answerLayout = await evaluate(`(() => { const box = document.getElementById('answerBox');
      return {height:box.clientHeight, top:box.getBoundingClientRect().top, viewport:innerHeight}; })()`);
    assert.ok(answerLayout.height >= 70 && answerLayout.top + 48 <= answerLayout.viewport,
      'Answer must remain readable at minimum size: ' + JSON.stringify(answerLayout));
    await capture('minimum-answer');

    await evaluate("document.getElementById('answerActions').open = true");
    await evaluate("document.getElementById('shorterBtn').click()");
    await waitFor("document.getElementById('historyLabel').textContent === '2/2' && document.getElementById('statusText').textContent.startsWith('Done')");
    assert.equal(requests[1].options.snapshot.output.answerStyle, 'brief');
    await evaluate("document.getElementById('followupBtn').click()");
    await evaluate(`document.getElementById('askInput').value = 'Why that approach?';
      document.getElementById('askForm').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));`);
    await waitFor("document.getElementById('historyLabel').textContent === '3/3' && document.getElementById('statusText').textContent.startsWith('Done')");
    assert.ok(requests[2].options.snapshot.relatedAnswer?.answer.includes('staged migration'));
    await evaluate("document.getElementById('settingsBtn').click()");
    await waitFor("!document.getElementById('settingsView').hidden");
    await capture('minimum-settings');
    assert.equal(await evaluate("document.getElementById('anthropicKey').value"), '');
    assert.deepEqual(failures, [], 'Unexpected renderer errors');
    console.log(JSON.stringify({ ok: true, checks: ['production preload bridge', 'default and minimum window layout',
      'readable answer at minimum size', 'context snapshot submission', 'successful one-shot note clearing', 'shorter refinement',
      'explicit selected follow-up', 'write-only keys', 'no renderer errors'], screenshots: artifactDir }, null, 2));
    win.destroy();
    app.quit();
  }
  run().catch((err) => {
    console.error(err);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  });
}

// Uses a fresh headless Chrome profile; never attaches to the user's browser.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'unsend-history-check-'));
  const executable = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const browser = spawn(executable, ['--headless', '--disable-gpu', '--disable-extensions',
    '--disable-background-networking', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`],
  { windowsHide: true, stdio: 'ignore' });
  let socket;
  let processError;
  browser.on('error', (error) => { processError = error; });
  const exit = new Promise((resolve) => { browser.once('exit', resolve); browser.once('error', resolve); });
  const pending = new Map();
  let sequence = 0;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) {
      if (processError) throw processError;
      await delay(100);
    }
    const [port, endpoint] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    socket.onmessage = (event) => {
      const result = JSON.parse(event.data);
      if (!result.id) return;
      const task = pending.get(result.id);
      if (!task) return;
      pending.delete(result.id);
      result.error ? task.reject(new Error(result.error.message)) : task.resolve(result.result);
    };
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const { targetId } = await send('Target.createTarget', { url: pathToFileURL(path.join(__dirname, 'browser-history-check.html')).href });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const result = await send('Runtime.evaluate', {
      expression: `new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        function check() {
          const body = document.body;
          if (body && body.childElementCount === 0 && /^(PASS|FAIL):/.test(body.textContent)) return resolve(body.textContent);
          if (Date.now() > deadline) return reject(new Error('Browser fixture did not finish: ' + body?.textContent.slice(0, 100)));
          setTimeout(check, 50);
        }
        check();
      })`, awaitPromise: true, returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Browser check failed');
    if (!result.result.value?.startsWith('PASS:')) throw new Error(result.result.value);
    console.log(result.result.value);
    await send('Browser.close');
  } finally {
    socket?.close();
    browser.kill();
    await exit;
    // Verify the absolute target before removing only our disposable profile.
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('unsend-history-check-')) {
      await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

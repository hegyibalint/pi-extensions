import assert from 'node:assert/strict';
import { chmod, mkdtemp, rmdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import extension, { attachmentDetails, fetchSnapshot } from '../extensions/ide-context.ts';

const snapshot = {
  activeFile: { path: '/repo/main.ts', cursor: { line: 2, column: 3 }, selection: null },
  openTabs: ['/repo/main.ts'],
};
const response = JSON.stringify({ version: 1, context: snapshot }) + '\n';

async function serve(t, reply = response) {
  const dir = await mkdtemp('/tmp/pi-ide-client-test-');
  const path = join(dir, 'context.sock');
  const requests = [];
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk;
      if (!request.endsWith('\n')) return;
      requests.push(JSON.parse(request));
      if (reply === null) return;
      socket.write(reply.slice(0, 8));
      setImmediate(() => socket.end(reply.slice(8)));
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(path, resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rmdir(dir);
  });
  await chmod(path, 0o600);
  return { path, requests };
}

test('reads a fragmented v1 reply from the selected socket', async (t) => {
  const { path, requests } = await serve(t);
  assert.deepEqual(await fetchSnapshot(path), snapshot);
  assert.deepEqual(requests, [{ version: 1, method: 'snapshot' }]);
});

test('rejects missing and non-private sockets', async (t) => {
  const { path, requests } = await serve(t);
  await assert.rejects(fetchSnapshot(undefined), /PI_VSCODE_SOCKET/);
  await assert.rejects(fetchSnapshot(join(dirname(path), 'stale.sock')), { code: 'ENOENT' });
  await chmod(path, 0o666);
  await assert.rejects(fetchSnapshot(path), /Socket is not private/);
  await chmod(dirname(path), 0o755);
  await assert.rejects(fetchSnapshot(path), /Socket directory is not private/);
  assert.deepEqual(requests, []);
});

test('rejects incompatible, oversized, and unresponsive peers', async (t) => {
  const badVersion = await serve(t, response.replace('"version":1', '"version":2'));
  const oversized = await serve(t, ' '.repeat(384 * 1024 + 1));
  const idle = await serve(t, null);
  await assert.rejects(fetchSnapshot(badVersion.path), /incompatible/);
  await assert.rejects(fetchSnapshot(oversized.path), /Invalid VS Code response frame/);
  await assert.rejects(fetchSnapshot(idle.path, 40), /Timed out/);
});

test('formats cursor and selection locations relative to Pi’s working directory when possible', () => {
  assert.deepEqual(attachmentDetails(snapshot, '/repo'), { path: 'main.ts', location: '2:3' });
  assert.deepEqual(attachmentDetails(snapshot, '/other'), { path: '/repo/main.ts', location: '2:3' });
  const selected = (end) => ({ ...snapshot, activeFile: { ...snapshot.activeFile,
    selection: { start: { line: 2, column: 3 }, end },
  } });
  assert.deepEqual(attachmentDetails(selected({ line: 2, column: 8 }), '/repo'), { path: 'main.ts', location: '2:3–8' });
  assert.deepEqual(attachmentDetails(selected({ line: 12, column: 5 }), '/repo'), { path: 'main.ts', location: '2:3–12:5' });
  assert.deepEqual(attachmentDetails({ ...snapshot, activeFile: null }, '/repo'), { tabs: 1 });
});

test('attaches only to user prompts and preserves the existing /ide command', async (t) => {
  const { path, requests } = await serve(t);
  const env = process.env.PI_VSCODE_SOCKET;
  t.after(() => {
    if (env === undefined) delete process.env.PI_VSCODE_SOCKET;
    else process.env.PI_VSCODE_SOCKET = env;
  });
  const commands = new Map();
  const hooks = new Map();
  const notifications = [];
  const entries = [];
  const entryRenderers = new Map();
  extension({
    on: (name, handler) => hooks.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerMessageRenderer: () => {},
    registerEntryRenderer: (name, renderer) => entryRenderers.set(name, renderer),
    appendEntry: (type, data) => entries.push({ type, data }),
  });
  assert.deepEqual([...commands.keys()], ['ide']);
  const run = hooks.get('before_agent_start');
  const ctx = { mode: 'tui', cwd: '/repo', ui: { notify: (text) => notifications.push(text) } };
  delete process.env.PI_VSCODE_SOCKET;
  assert.equal(await run({ messageType: 'user' }, ctx), undefined);
  process.env.PI_VSCODE_SOCKET = path;
  assert.equal(await run({ messageType: 'custom' }, ctx), undefined);
  assert.equal(requests.length, 0);
  assert.deepEqual(entries, []);

  const attachment = await run({ messageType: 'user' }, ctx);
  assert.equal(attachment.message.display, false);
  assert.match(attachment.message.content, /\/repo\/main\.ts/);
  assert.deepEqual(entries, [{ type: 'pi-ide-context-attached', data: { path: 'main.ts', location: '2:3' } }]);
  const render = entryRenderers.get(entries[0].type);
  const marker = (data, width = 80) => render({ data }, { outputPad: 0 }, { fg: (_color, text) => text }).render(width);
  assert.deepEqual(marker(entries[0].data), ['↳ main.ts:2:3']);
  assert.deepEqual(marker({ path: 'some/very/long/folder/main.ts', location: '2:3–12:5' }, 22), ['↳ …/main.ts:2:3–12:5']);
  assert.deepEqual(marker({ path: 'a\n\x1b.ts', location: '2:3' }), ['↳ a\\u000a\\u001b.ts:2:3']);
  assert.deepEqual(marker({ tabs: 3 }), ['↳ 3 IDE tabs']);
  assert.deepEqual(marker({}), ['↳ IDE context attached']);

  assert.equal((await run({ messageType: 'user' }, { mode: 'rpc' })).message.display, false);
  await commands.get('ide').handler('off', ctx);
  assert.equal(await run({ messageType: 'user' }, ctx), undefined);
  assert.equal(requests.length, 2);
  assert.equal(entries.length, 1);
  await commands.get('ide').handler('', ctx);
  assert.match(notifications.at(-1), /auto-attachment off/);
});

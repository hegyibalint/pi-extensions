import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';

const agentDir = mkdtempSync(join(tmpdir(), 'pi-statusbar-test-'));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: statusbar } = await import('../extensions/statusbar.ts');
if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(t, provider = 'openai', options = {}) {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = mkdtempSync(join(agentDir, 'codex-'));
  process.env.CODEX_HOME = codexHome;
  const cliPath = join(codexHome, 'auth.json');
  if (options.cli) writeFileSync(cliPath, JSON.stringify(options.cli));
  const handlers = new Map();
  const commands = new Map();
  let footer;
  let authCalls = 0;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCalls++;
    return options.fetch ? options.fetch(...args) : {
      ok: true,
      json: async () => ({ rate_limit: {
        primary_window: { used_percent: 20, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 35, limit_window_seconds: 604800 },
      } }),
    };
  };
  const ctx = {
    mode: 'tui', hasUI: true,
    model: { provider, id: 'test-model', name: 'Test Model' },
    getContextUsage: () => options.usage === undefined
      ? { tokens: 20000, contextWindow: 100000, percent: 20 }
      : options.usage,
    sessionManager: { getBranch: () => [{ type: 'message', message: {
      role: 'assistant', usage: { input: 12000, output: 500, cost: { total: 0.05 } },
    } }] },
    modelRegistry: {
      isUsingOAuth: () => options.oauth !== false,
      getProviderAuth: async () => {
        authCalls++;
        return options.auth ? options.auth() : { auth: { apiKey: 'test-token' } };
      },
    },
    ui: {
      setFooter(factory) {
        footer?.dispose();
        footer = factory?.({ requestRender() {} }, { fg: options.fg ?? ((_color, text) => text) }, {
          onBranchChange: () => () => {},
          getGitBranch: () => 'main',
          getExtensionStatuses: () => new Map([['other', 'other extension\nstatus']]),
        });
      },
      notify() {},
    },
  };
  statusbar({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    getThinkingLevel: () => 'high',
  });
  handlers.get('session_start')({}, ctx);
  t.after(() => {
    handlers.get('session_shutdown')({}, ctx);
    globalThis.fetch = originalFetch;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });
  return {
    ctx, handlers, commands,
    render: (width = 240) => footer.render(width),
    switchTo(provider) {
      ctx.model = { ...ctx.model, provider };
      handlers.get('model_select')({}, ctx);
    },
    counts: () => ({ authCalls, fetchCalls }),
    dispose: () => footer.dispose(),
    cliPath,
  };
}

test('context bar has a bright fill distinct from its dim track', t => {
  const colors = [];
  const h = harness(t, 'openrouter', {
    fg: (color, text) => { colors.push([color, text]); return text; },
  });
  for (const [percent, color, filled] of [[20, 'text', 4], [70, 'warning', 14], [90, 'error', 18]]) {
    h.ctx.getContextUsage = () => ({ tokens: percent * 1000, contextWindow: 100000, percent });
    colors.length = 0;
    h.render();
    assert.ok(colors.some(([role, text]) => role === color && text === '█'.repeat(filled)));
    assert.ok(colors.some(([role, text]) => role === 'dim' && text === '░'.repeat(20 - filled)));
  }
});

test('OpenAI without CLI credentials shows unavailable quota without fetching', async t => {
  const h = harness(t);
  await settle();
  const lines = h.render();
  assert.match(lines[0], /20% \(20k \/ 100k\)/);
  assert.match(lines[0], /↑12k ↓500/);
  assert.match(lines[0], /\$0\.05/);
  assert.match(lines[0], /quota unavailable/);
  assert.equal(lines[1], 'other extension status');
  assert.deepEqual(h.counts(), { authCalls: 0, fetchCalls: 0 });
});

test('OpenAI displays quota indicators without a credential-source label', async t => {
  const h = harness(t, 'openai', {
    cli: { auth_mode: 'chatgpt', tokens: { access_token: 'cli-test-token', account_id: 'cli-account' } },
    fetch: async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(init.headers.Authorization, 'Bearer cli-test-token');
      assert.equal(init.headers['ChatGPT-Account-Id'], 'cli-account');
      return { ok: true, json: async () => ({ rate_limit: {
        primary_window: { used_percent: 74 }, secondary_window: { used_percent: 64 },
      } }) };
    },
  });
  await settle();
  const line = h.render()[0];
  assert.match(line, /26%.*36%/);
  assert.doesNotMatch(line, /Codex CLI|quota unavailable/);
  assert.deepEqual(h.counts(), { authCalls: 0, fetchCalls: 1 });
  for (let width = 1; width < 200; width++) {
    const compact = h.render(width)[0];
    assert.doesNotMatch(compact, /Codex CLI/);
    assert.ok(visibleWidth(compact) <= width);
  }
});

test('CLI credentials are read again without the footer refreshing or writing them', async t => {
  let tick;
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return {}; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const tokens = [];
  const h = harness(t, 'openai', {
    cli: { auth_mode: 'chatgpt', tokens: { access_token: 'old-cli-token' } },
    fetch: async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
      tokens.push(init.headers.Authorization);
      return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 10 } } }) };
    },
  });
  await settle();
  writeFileSync(h.cliPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'new-cli-token' } }));
  tick();
  await settle();
  assert.deepEqual(tokens, ['Bearer old-cli-token', 'Bearer new-cli-token']);
  assert.equal(h.counts().authCalls, 0);
});

test('OpenAI API-key sessions do not borrow unrelated CLI subscription limits', async t => {
  const h = harness(t, 'openai', {
    oauth: false, cli: { auth_mode: 'chatgpt', tokens: { access_token: 'cli-test-token' } },
  });
  await settle();
  assert.deepEqual(h.counts(), { authCalls: 0, fetchCalls: 0 });
  assert.doesNotMatch(h.render()[0], /Codex CLI/);
});

test('rejected CLI tokens are not refreshed independently', async t => {
  const h = harness(t, 'openai', {
    cli: { auth_mode: 'chatgpt', tokens: { access_token: 'expired-token', refresh_token: 'unused-refresh' } },
    fetch: async () => ({ ok: false, status: 401 }),
  });
  await settle();
  assert.match(h.render()[0], /quota unavailable/);
  assert.deepEqual(h.counts(), { authCalls: 0, fetchCalls: 1 });
});

test('legacy Codex quota uses Pi-managed request auth', async t => {
  const h = harness(t, 'openai-codex', { fetch: async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    return { ok: true, json: async () => ({ rate_limit: {
      primary_window: { used_percent: 20 }, secondary_window: { used_percent: 35 },
    } }) };
  } });
  assert.match(h.render()[0], /quota loading/);
  await settle();
  assert.match(h.render()[0], /80%.*65%/);
  assert.doesNotMatch(h.render()[0], /quota unavailable/);
  assert.deepEqual(h.counts(), { authCalls: 1, fetchCalls: 1 });
});

test('Anthropic retains its own quota endpoint', async t => {
  const h = harness(t, 'anthropic', { fetch: async url => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    return { ok: true, json: async () => ({ five_hour: { utilization: 25 }, seven_day: { utilization: 50 } }) };
  } });
  await settle();
  assert.match(h.render()[0], /75%.*50%/);
});

test('HTTP errors are displayed as unavailable quota', async t => {
  const h = harness(t, 'openai-codex', { fetch: async () => ({ ok: false, status: 401 }) });
  await settle();
  assert.match(h.render()[0], /quota unavailable/);
  h.switchTo('openai');
  h.switchTo('openai-codex');
  await settle();
  assert.match(h.render()[0], /quota unavailable/);
});

test('empty and malformed quota responses are not displayed as unused quota', async t => {
  const h = harness(t, 'openai-codex', { fetch: async () => ({
    ok: true, json: async () => ({ rate_limit: { primary_window: {} } }),
  }) });
  await settle();
  assert.match(h.render()[0], /quota unavailable/);
  assert.doesNotMatch(h.render()[0], /100%/);
});

test('auth resolution failures leave local statistics available', async t => {
  const h = harness(t, 'openai-codex', { auth: async () => { throw new Error('auth unavailable'); } });
  await settle();
  assert.match(h.render()[0], /quota unavailable/);
  assert.match(h.render()[0], /↑12k ↓500/);
  assert.equal(h.counts().fetchCalls, 0);
});

test('API-key authentication is not sent to OAuth quota endpoints', async t => {
  const h = harness(t, 'anthropic', { oauth: false });
  await settle();
  assert.match(h.render()[0], /quota unavailable/);
  assert.deepEqual(h.counts(), { authCalls: 0, fetchCalls: 0 });
});

test('late quota results cannot overwrite a newly selected provider', async t => {
  let resolveFetch;
  const h = harness(t, 'openai-codex', { fetch: () => new Promise(resolve => { resolveFetch = resolve; }) });
  await settle();
  h.switchTo('openai');
  resolveFetch({ ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 20 } } }) });
  await settle();
  assert.match(h.render()[0], /quota unavailable/);
  assert.doesNotMatch(h.render()[0], /80%/);
});

test('all lines fit narrow terminals and local stats take priority over unavailable quota', async t => {
  const h = harness(t);
  await settle();
  const fullWidth = visibleWidth(h.render()[0]);
  const compact = h.render(fullWidth - 15)[0];
  assert.match(compact, /↑12k ↓500/);
  assert.doesNotMatch(compact, /quota unavailable/);
  for (const width of [0, 1, 4, 20, 60, 80, 120, 240]) {
    for (const line of h.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
});

test('disposed footers stop polling and ignore callbacks already queued', async t => {
  let tick;
  const timer = {};
  const cleared = [];
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return timer; });
  t.mock.method(globalThis, 'clearInterval', value => cleared.push(value));
  const h = harness(t, 'openai-codex');
  await settle();
  h.dispose();
  assert.deepEqual(cleared, [timer]);
  tick();
  await settle();
  assert.deepEqual(h.counts(), { authCalls: 1, fetchCalls: 1 });
});

test('unknown context, unsupported providers, and toggle remain functional', async t => {
  const h = harness(t, 'openrouter', { usage: null });
  await settle();
  assert.match(h.render()[0], /n\/a \(\? \/ \?\)/);
  assert.doesNotMatch(h.render()[0], /quota/);
  await h.commands.get('statusbar').handler('', h.ctx);
  await h.commands.get('statusbar').handler('', h.ctx);
  await settle();
  assert.match(h.render()[0], /↑12k ↓500/);
});

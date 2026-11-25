import assert from 'node:assert/strict';
import test from 'node:test';
import extension from '../extensions/web-search.ts';
const tools = new Map();
extension({ registerTool: tool => tools.set(tool.name, tool) });

function context(options = {}) {
  let calls = 0;
  return {
    model: options.active ?? { provider: 'openai', id: 'gpt-6.1-sol' },
    sessionManager: { getSessionId: () => 'test-session' },
    modelRegistry: {
      getAvailable: () => options.models ?? [{ provider: 'openai', id: 'gpt-6.1-sol' }],
      async getProviderAuth(provider) {
        assert.equal(provider, 'openai');
        calls++;
        if (options.error) throw new Error(options.error);
        return options.missing ? undefined : { auth: { apiKey: `opaque-token-${calls}` } };
      },
    },
  };
}
const item = { id: 'msg-1', type: 'message', role: 'assistant', content: [{
  type: 'output_text', text: 'Example Domain', annotations: [{
    type: 'url_citation', title: 'Example', url: 'https://example.com/',
  }],
}] };
function sse(events) {
  return new Response(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
function success() {
  return sse([
    { type: 'response.output_text.delta', delta: 'Example Domain' },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id: 'response-1', output: [] } },
  ]);
}

for (const [name, params] of [
  ['web_search', { query: ' Example Domain ', search_context_size: 'high' }],
  ['codex_standalone_web', { url: ' https://example.com ', search_context_size: 'high' }],
]) {
  test(`${name} uses new provider auth and Responses endpoint, without a JWT account ID`, async t => {
    const headers = [];
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(init.signal, controller.signal);
      assert.equal(init.headers['chatgpt-account-id'], undefined);
      headers.push(init.headers.Authorization);
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'gpt-6.1-sol');
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(body.tools[0].type, 'web_search');
      assert.equal(body.tools[0].search_context_size, 'high');
      if (name === 'codex_standalone_web') {
        assert.equal(body.input[0].content[0].text, 'https://example.com/');
        assert.match(body.instructions, /open the exact URL/);
      } else assert.equal(body.input[0].content[0].text, 'Example Domain');
      return success();
    });
    const ctx = context();
    const updates = [];
    const result = await tools.get(name).execute('call', params, controller.signal, value => updates.push(value), ctx);
    assert.match(result.content[0].text, /Example Domain/);
    assert.equal(result.details.responseId, 'response-1');
    assert.deepEqual(result.details.sources, [{ title: 'Example', url: 'https://example.com/' }]);
    assert.ok(updates.length);
    await tools.get(name).execute('call', params, controller.signal, undefined, ctx);
    assert.deepEqual(headers, ['Bearer opaque-token-1', 'Bearer opaque-token-2']);
  });
}

test('uses OpenAI fallback model when another provider is active', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(JSON.parse(init.body).model, 'gpt-6.1-sol');
    return success();
  });
  await tools.get('web_search').execute('call', { query: 'example' }, undefined, undefined,
    context({ active: { provider: 'openrouter', id: 'other' } }));
});

test('auth failures are surfaced without an HTTP request or new login prompt', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected fetch'));
  for (const options of [{ missing: true }, { error: 'refresh failed' }, { models: [] }]) {
    await assert.rejects(tools.get('web_search').execute('call', { query: 'example' }, undefined, undefined,
      context(options)), /authentication|refresh failed|model/);
  }
});

test('validates query and URL before resolving credentials', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected fetch'));
  await assert.rejects(tools.get('web_search').execute('call', { query: ' ' }, undefined, undefined, {}), /non-empty/);
  for (const url of ['not a url', 'file:///etc/passwd']) {
    await assert.rejects(tools.get('codex_standalone_web').execute('call', { url }, undefined, undefined, {}), /Invalid URL|HTTP/);
  }
});

test('HTTP, stream failures and incomplete streams do not return success', async t => {
  const responses = [
    [() => new Response('Unauthorized', { status: 401 }), /HTTP 401/],
    [() => sse([{ type: 'response.failed', response: { error: { message: 'failure' } } }]), /failure/],
    [() => sse([{ type: 'response.incomplete' }]), /incomplete/],
    [() => sse([{ type: 'response.output_text.delta', delta: 'partial' }]), /before completion/],
    [() => sse([{ type: 'response.completed', response: { output: [] } }]), /no answer/],
  ];
  for (const [response, expected] of responses) {
    t.mock.method(globalThis, 'fetch', async () => response());
    await assert.rejects(tools.get('web_search').execute('call', { query: 'example' }, undefined, undefined, context()), expected);
    t.mock.restoreAll();
  }
});

test('cancellation is not reported as a completed response', async t => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, 'fetch', async () => success());
  await assert.rejects(tools.get('web_search').execute('call', { query: 'example' }, controller.signal, undefined, context()), /cancelled/);
});

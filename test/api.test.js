const test = require('node:test');
const assert = require('node:assert/strict');
const { listModelIds, sseData, streamChat } = require('../out/api');

function body(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) { controller.enqueue(encoder.encode(chunk)); }
      controller.close();
    }
  });
}

test('SSE parser handles chunk boundaries, CRLF, comments, and final event', async () => {
  const events = [];
  for await (const event of sseData(body([': heartbeat\r\nda', 'ta: one\r\n\r\ndata: two', '\n']))) {
    events.push(event);
  }
  assert.deepEqual(events, ['one', 'two']);
});

test('key validation reads the canonical OpenAI model catalog', async () => {
  const original = global.fetch;
  global.fetch = async url => {
    assert.equal(url, 'https://api.acedata.cloud/openai/models');
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }), { status: 200 });
  };
  try { assert.deepEqual([...await listModelIds('unused-test-key')], ['gpt-4.1-mini']); }
  finally { global.fetch = original; }
});

test('streamed tool arguments are joined by index and emitted once', async () => {
  const original = global.fetch;
  const frames = [
    { choices: [{ delta: { content: 'Checking ' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"demo"}' } }] }, finish_reason: 'tool_calls' }] }
  ];
  global.fetch = async url => {
    assert.equal(url, 'https://api.acedata.cloud/openai/chat/completions');
    return new Response(body([...frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n']), { status: 200 });
  };
  const text = [];
  const tools = [];
  try {
    await streamChat('unused-test-key', { model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: true }, new AbortController().signal,
      chunk => text.push(chunk), call => tools.push(call));
    assert.deepEqual(text, ['Checking ']);
    assert.deepEqual(tools, [{ id: 'call_1', name: 'lookup', input: { q: 'demo' } }]);
  } finally { global.fetch = original; }
});

test('truncated response fails without resubmitting the request', async () => {
  const original = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return new Response(body(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']), { status: 200 });
  };
  try {
    await assert.rejects(streamChat('unused-test-key', { model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: true }, new AbortController().signal,
      () => {}, () => {}), /ended early/);
    assert.equal(requests, 1);
  } finally { global.fetch = original; }
});

test('HTTP failures do not expose response bodies', async () => {
  const original = global.fetch;
  global.fetch = async () => new Response('secret echoed upstream', { status: 401 });
  try {
    await assert.rejects(streamChat('unused-test-key', { model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: true }, new AbortController().signal,
      () => {}, () => {}), error => error.message.includes('HTTP 401') && !error.message.includes('secret echoed'));
  } finally { global.fetch = original; }
});

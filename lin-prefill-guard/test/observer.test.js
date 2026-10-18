import test from 'node:test';
import assert from 'node:assert/strict';
import { installObserver, inspectResponse } from '../observer.js';
import { responseDiagnosis } from '../diagnostics.js';

function responseFromChunks(text, step = 7, contentType = 'text/event-stream') {
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(controller) {
        for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.slice(i, i + step));
        controller.close();
    } }), { headers: { 'content-type': contentType } });
}
test('split UTF-8 / CRLF SSE preserves text statistics and final reasoning usage', async () => {
    const data = [
        { choices: [{ index: 0, delta: { reasoning_content: '思考' } }] },
        { choices: [{ index: 0, delta: { content: '你好世界' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 90 } } },
    ].map(x => `data: ${JSON.stringify(x)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
    const stats = await inspectResponse(responseFromChunks(data, 1));
    assert.equal(stats.visibleChars, 4); assert.equal(stats.reasoningChars, 2);
    assert.equal(stats.finishReason, 'length'); assert.equal(stats.thoughtTokens, 90);
    assert.equal(stats.parseErrors, 0); assert.match(responseDiagnosis(stats), /截断/);
});
test('native Gemini separates thought blocks from body and detects budget exhaustion', async () => {
    const data = { candidates: [{ content: { parts: [{ thought: true, text: '只有思考' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { thoughtsTokenCount: 16384 } };
    const stats = await inspectResponse(responseFromChunks(JSON.stringify(data), 3, 'application/json'));
    assert.equal(stats.visibleChars, 0); assert.equal(stats.reasoningChars, 4);
    assert.match(responseDiagnosis(stats), /预算/);
});
test('blocking and HTTP errors are distinguished from empty successful content', async () => {
    const blocked = await inspectResponse(new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })));
    assert.match(responseDiagnosis(blocked), /限制/);
    const error = await inspectResponse(new Response(JSON.stringify({ error: { message: 'sensitive details never stored' } }), { status: 429 }));
    assert.match(responseDiagnosis(error), /429/);
    assert.ok(!JSON.stringify(error).includes('sensitive'));
});
test('unknown/malformed and capped responses are not labelled proven empty', async () => {
    const malformed = await inspectResponse(responseFromChunks('data: nope\n\n'));
    assert.match(responseDiagnosis(malformed), /未完整识别/);
    const limited = await inspectResponse(responseFromChunks('data: ' + 'x'.repeat(5000)), { maxBytes: 100 });
    assert.equal(limited.captureLimited, true); assert.match(responseDiagnosis(limited), /不能/);
});
test('observer forwards the exact arguments and Response, and never retries', async () => {
    const response = new Response(JSON.stringify({ choices: [{ message: { content: '你好' }, finish_reason: 'stop' }] }));
    const args = []; const stats = [];
    const target = { location: { href: 'https://st.example/chat' }, fetch: async (...a) => { args.push(a); return response; } };
    const original = target.fetch;
    const observer = installObserver({ target, enabled: () => true, onDispatch: () => 'one', onResponse: (id, value) => stats.push({ id, value }), onError: () => {} });
    const input = '/api/backends/chat-completions/generate';
    const init = { method: 'POST', body: '{"messages":[]}', headers: { 'x-csrf-token': 'test-only' } };
    const result = await target.fetch(input, init);
    assert.equal(result, response); assert.equal(args[0][0], input); assert.equal(args[0][1], init);
    assert.match(await result.text(), /你好/); await observer.idle();
    assert.equal(args.length, 1); assert.equal(stats[0].value.visibleChars, 2);
    observer.dispose(); assert.equal(target.fetch, original);
});
test('only same-origin POST string bodies to the exact chat endpoint are observed', async () => {
    let count = 0;
    const target = { location: { href: 'https://st.example/' }, fetch: async () => new Response('{}') };
    const observer = installObserver({ target, enabled: () => true, onDispatch: () => { count++; }, onResponse() {}, onError() {} });
    for (const [url, init] of [
        ['https://other.example/api/backends/chat-completions/generate', { method: 'POST', body: '{}' }],
        ['/api/secrets/write', { method: 'POST', body: '{}' }],
        ['/api/backends/chat-completions/generate', { method: 'GET' }],
        ['/api/backends/chat-completions/generate', { method: 'POST', body: 'broken' }],
    ]) await target.fetch(url, init);
    assert.equal(count, 0); observer.dispose();
});
test('original rejection is propagated and recorded without exposing error text', async () => {
    const failure = new Error('secret response'); const seen = [];
    const target = { location: { href: 'http://localhost/' }, fetch: async () => { throw failure; } };
    const observer = installObserver({ target, enabled: () => true, onDispatch: () => 'id', onResponse() {}, onError: (id, stats) => seen.push(stats) });
    await assert.rejects(target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: '{}' }), e => e === failure);
    assert.deepEqual(seen, [{ aborted: false, networkError: true }]); observer.dispose();
});
test('dispose preserves later wrappers and makes a retained observer inert', async () => {
    let observed = 0;
    const target = { location: { href: 'http://localhost/' }, fetch: async () => new Response('{}') };
    const observer = installObserver({ target, enabled: () => true, onDispatch: () => { observed++; }, onResponse() {}, onError() {} });
    const inner = target.fetch; const outer = (...args) => inner(...args); target.fetch = outer;
    observer.dispose(); assert.equal(target.fetch, outer);
    await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: '{}' });
    assert.equal(observed, 0);
});
test('time-bounded clone inspection cannot hang the request', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const stats = await inspectResponse(response, { timeoutMs: 5 });
    assert.equal(stats.captureLimited, true); assert.equal(cancelled, true);
});
test('DONE does not turn an unknown payload into a proven empty model response', async () => {
    const stats = await inspectResponse(responseFromChunks('data: {"vendor_payload":"unknown"}\n\ndata: [DONE]\n\n'));
    assert.equal(stats.recognized, false);
    assert.match(responseDiagnosis(stats), /未完整识别/);
});
test('refusal is recorded as a flag without storing its text', async () => {
    const stats = await inspectResponse(new Response(JSON.stringify({ choices: [{ message: { content: null, refusal: 'private refusal detail' }, finish_reason: 'stop' }] })));
    assert.equal(stats.refusal, true); assert.ok(!JSON.stringify(stats).includes('private'));
});

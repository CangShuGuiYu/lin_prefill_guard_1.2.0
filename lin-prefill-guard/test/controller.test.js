import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../controller.js';
import { DEFAULTS, LIN_PROMPT_ID } from '../core.js';

class Bus {
    listeners = new Map();
    on(event, fn) { const entries = this.listeners.get(event) || []; entries.push(fn); this.listeners.set(event, entries); }
    removeListener(event, fn) { this.listeners.set(event, (this.listeners.get(event) || []).filter(x => x !== fn)); }
    makeLast(event, fn) { this.removeListener(event, fn); this.on(event, fn); }
    async emit(event, ...args) { for (const fn of [...(this.listeners.get(event) || [])]) await fn(...args); }
}
function fixture(extra = {}) {
    const bus = new Bus();
    const config = { ...DEFAULTS, mode: 'pair' };
    const ctx = { eventSource: bus, eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'request', GENERATION_STARTED: 'start', MESSAGE_RECEIVED: 'message' },
        chatCompletionSettings: { prompts: [{ identifier: LIN_PROMPT_ID, role: 'assistant', content: '原承接' }], prompt_order: [{ character_id: 100001, order: [{ identifier: LIN_PROMPT_ID, enabled: true }] }] },
        chat: [{ is_user: false, mes: '书店里一片寂静。' }], ...extra };
    const views = [];
    const networkTarget = { location: { href: 'http://localhost/' }, fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '接口正文' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }) };
    const controller = createController({ getContext: () => ctx, getSettings: () => config, onStatus: x => views.push(x), networkTarget });
    const request = () => ({ type: 'normal', messages: [{ role: 'user', content: '接着写。' }, { role: 'assistant', content: '原承接' }, { role: 'user', content: '尾部' }], stream: true });
    return { bus, config, ctx, controller, request, views, networkTarget };
}

test('event mutates only the temporary request.messages property, not saved chat or settings', async () => {
    const f = fixture(); const chat = structuredClone(f.ctx.chat); const preset = structuredClone(f.ctx.chatCompletionSettings);
    const req = f.request(); await f.bus.emit('request', req);
    assert.equal(req.messages.at(-1).role, 'user'); assert.equal(req.messages.length, 4); assert.equal(req.stream, true);
    assert.deepEqual(f.ctx.chat, chat); assert.deepEqual(f.ctx.chatCompletionSettings, preset);
    assert.equal(f.controller.snapshot().last.applied, true);
});
test('late registration does not accumulate listeners and follows already registered modifiers', async () => {
    const f = fixture();
    f.bus.on('request', req => req.messages.push({ role: 'user', content: '其他扩展' }));
    for (let i = 0; i < 10; i++) await f.bus.emit('start');
    assert.equal(f.bus.listeners.get('request').length, 2);
    const req = f.request(); await f.bus.emit('request', req);
    assert.equal(req.messages.at(-3).content, '其他扩展'); assert.equal(f.views.length, 1);
});
test('same request event twice is idempotent', async () => {
    const f = fixture(); const req = f.request();
    await f.bus.emit('request', req); const first = structuredClone(req);
    await f.bus.emit('request', req); assert.deepEqual(req, first);
    assert.equal(f.controller.snapshot().last.reason, 'already-present');
});
test('quiet requests use their own payload.type and do not overwrite the visible generation status', async () => {
    const f = fixture(); const normal = f.request(); const quiet = { ...f.request(), type: 'quiet' }; const before = structuredClone(quiet);
    await f.bus.emit('request', normal); await f.bus.emit('request', quiet);
    assert.deepEqual(quiet, before); assert.equal(f.controller.snapshot().last.type, 'normal'); assert.equal(f.controller.snapshot().lastSkip.reason, 'quiet');
});
test('dispose removes listeners and stops all request mutation', async () => {
    const f = fixture(); f.controller.dispose(); const req = f.request(); const before = structuredClone(req);
    await f.bus.emit('start'); await f.bus.emit('request', req); assert.deepEqual(req, before);
    assert.equal(f.bus.listeners.get('request').length, 0);
});
test('local preview neither sends nor mutates and does not masquerade as an actual injection', () => {
    const f = fixture(); const req = f.request(); const before = structuredClone(req);
    assert.equal(f.controller.preview(req).applied, true); assert.deepEqual(req, before); assert.equal(f.controller.snapshot().last, null);
});
test('empty text is reported without changing a response or triggering a new request', async () => {
    const f = fixture(); await f.bus.emit('request', f.request()); f.ctx.chat.push({ is_user: false, mes: '' }); await f.bus.emit('message', 1);
    assert.match(f.controller.snapshot().response, /空正文/); assert.equal(f.ctx.chat[1].mes, '');
});
test('unsupported event API is reported instead of guessed', () => {
    const f = fixture({ eventTypes: {} }); assert.equal(f.controller.snapshot().last.reason, 'unsupported-client');
});
test('frozen request is preserved and reported as an error', async () => {
    const f = fixture(); const req = Object.freeze(f.request()); const before = structuredClone(req);
    await f.bus.emit('request', req); assert.deepEqual(req, before); assert.equal(f.controller.snapshot().last.reason, 'internal-error');
});
test('a settings UI exception cannot break request preparation', async () => {
    const f = fixture(); f.controller.dispose();
    const c = createController({ getContext: () => f.ctx, getSettings: () => f.config, networkTarget: f.networkTarget, onStatus: () => { throw new Error('UI failure'); } });
    const req = f.request(); await f.bus.emit('request', req);
    assert.equal(c.snapshot().last.applied, true); assert.equal(req.messages.at(-1).role, 'user');
});

test('serialized request is checked independently and linked to the exact response', async () => {
    const f = fixture(); const req = f.request(); req.model = 'gemini-4-argon'; req.api_key = 'PRIVATE KEY';
    await f.bus.emit('request', req);
    const prepared = f.controller.snapshot().last;
    assert.equal(prepared.dispatch, undefined);
    const output = await f.networkTarget.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(req) });
    await output.text(); await f.controller.idle();
    const record = f.controller.snapshot().history[0];
    assert.equal(record.id, prepared.id); assert.equal(record.dispatch.tail, true);
    assert.deepEqual(record.dispatch.injected.map(m => m.content), prepared.injected.map(m => m.content));
    assert.equal(record.wire.visibleChars, 4); assert.equal(record.wire.finishReason, 'stop');
    assert.ok(!JSON.stringify(record).includes('PRIVATE KEY')); assert.ok(!JSON.stringify(record).includes('接着写。'));
    f.controller.dispose();
});
test('a later appended message is detected at the send boundary', async () => {
    const f = fixture(); const req = f.request(); await f.bus.emit('request', req);
    req.messages.push({ role: 'system', content: 'changed after official event' });
    const response = await f.networkTarget.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(req) });
    await response.text(); await f.controller.idle();
    assert.equal(f.controller.snapshot().last.dispatch.tail, false);
    assert.equal(f.controller.snapshot().last.dispatch.correlation, 'injection-match');
    f.controller.dispose();
});
test('missing injection cannot masquerade as verified success', async () => {
    const f = fixture(); const req = f.request(); await f.bus.emit('request', req);
    req.messages = [{ role: 'user', content: 'replaced by another extension' }];
    const response = await f.networkTarget.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(req) });
    await response.text(); await f.controller.idle();
    assert.equal(f.controller.snapshot().last.reason, 'unmatched-dispatch');
    assert.deepEqual(f.controller.snapshot().last.dispatch.injected, []);
    f.controller.dispose();
});
test('disabling network capture retains event history without claiming transmission', async () => {
    const f = fixture(); f.config.captureNetwork = false;
    const req = f.request(); await f.bus.emit('request', req);
    const response = await f.networkTarget.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(req) });
    await response.text(); await f.controller.idle();
    assert.equal(f.controller.snapshot().last.dispatch, undefined); f.controller.dispose();
});
test('budget adjustment only changes an eligible outgoing request, never preset settings', async () => {
    const f = fixture(); f.config.reasoningMode = 'balanced';
    f.ctx.chatCompletionSettings.reasoning_effort = 'max';
    const req = { ...f.request(), model: 'gemini-4-argon', reasoning_effort: 'max' };
    await f.bus.emit('request', req);
    assert.equal(req.reasoning_effort, 'medium'); assert.equal(f.ctx.chatCompletionSettings.reasoning_effort, 'max');
    assert.equal(f.controller.snapshot().last.adjustment.before, 'max'); f.controller.dispose();
});
test('end without MESSAGE_RECEIVED is logged; later valid message still updates it', async () => {
    const f = fixture({ eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'request', GENERATION_ENDED: 'end', MESSAGE_RECEIVED: 'message' } });
    await f.bus.emit('request', f.request()); await f.bus.emit('end');
    assert.match(f.controller.snapshot().last.lifecycle, /尚未观察到/);
    f.ctx.chat.push({ is_user: false, mes: '结果' }); await f.bus.emit('message', 1, 'normal');
    assert.equal(f.controller.snapshot().last.rendered.chars, 2); f.controller.dispose();
});
test('old messages, first messages and switched chats cannot be attributed as a reply', async () => {
    const f = fixture(); await f.bus.emit('request', f.request());
    await f.bus.emit('message', 0, 'normal'); assert.equal(f.controller.snapshot().last.rendered, undefined);
    f.ctx.chat = [{ is_user: false, mes: 'unrelated' }, { is_user: false, mes: 'new unrelated' }];
    await f.bus.emit('message', 1, 'normal'); await f.bus.emit('message', 1, 'first_message');
    assert.equal(f.controller.snapshot().last.rendered, undefined); f.controller.dispose();
});
test('duplicate event keeps one history entry and local preview does not create one', async () => {
    const f = fixture(); f.controller.preview(f.request()); assert.equal(f.controller.snapshot().history.length, 0);
    const req = f.request(); await f.bus.emit('request', req); await f.bus.emit('request', req);
    assert.equal(f.controller.snapshot().history.length, 1); f.controller.dispose();
});

test('repeated preparation after send preserves dispatch, response, and saved-body evidence', async () => {
    const f = fixture(); const req = f.request();
    await f.bus.emit('request', req);
    const response = await f.networkTarget.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(req) });
    await response.text(); await f.controller.idle();
    f.ctx.chat.push({ is_user: false, mes: '正文' }); await f.bus.emit('message', 1, 'normal');
    const before = f.controller.snapshot().last;
    await f.bus.emit('request', req);
    const after = f.controller.snapshot().last;
    assert.deepEqual(after.dispatch, before.dispatch); assert.equal(after.dispatch.verified, true);
    assert.deepEqual(after.wire, before.wire); assert.deepEqual(after.rendered, before.rendered);
    assert.equal(f.controller.snapshot().history.length, 1);
    f.controller.dispose();
});
test('duplicate preparation during generation does not move the baseline past the new reply', async () => {
    const f = fixture(); const req = f.request(); await f.bus.emit('request', req);
    f.ctx.chat.push({ is_user: false, mes: '' });
    await f.bus.emit('request', req); f.ctx.chat[1].mes = '完成';
    await f.bus.emit('message', 1, 'normal');
    assert.equal(f.controller.snapshot().last.rendered.chars, 2); f.controller.dispose();
});
test('regenerate accepts the normal completion event produced by saveReply', async () => {
    const f = fixture(); const req = { ...f.request(), type: 'regenerate' };
    await f.bus.emit('request', req); f.ctx.chat.push({ is_user: false, mes: '重新写好的正文' });
    await f.bus.emit('message', 1, 'normal');
    assert.equal(f.controller.snapshot().last.rendered.chars, 7); f.controller.dispose();
});
test('continuation recognizes appendFinal while swipe rejects an unrelated older message', async () => {
    const f = fixture(); f.ctx.chat.push({ is_user: false, mes: '末条' });
    await f.bus.emit('request', { ...f.request(), type: 'continue' });
    f.ctx.chat[1].mes += '补完'; await f.bus.emit('message', 1, 'appendFinal');
    assert.equal(f.controller.snapshot().last.rendered.chars, 4);
    await f.bus.emit('request', { ...f.request(), type: 'swipe' });
    await f.bus.emit('message', 0, 'swipe');
    assert.equal(f.controller.snapshot().last.rendered, undefined);
    await f.bus.emit('message', 1, 'swipe');
    assert.equal(f.controller.snapshot().last.rendered.chars, 4); f.controller.dispose();
});
test('identical pending requests are ambiguous and are never credited to a guessed record', async () => {
    const f = fixture(); const first = f.request(); const second = f.request();
    await f.bus.emit('request', first); await f.bus.emit('request', second);
    const response = await f.networkTarget.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(second) });
    await response.text(); await f.controller.idle();
    assert.equal(f.controller.snapshot().last.reason, 'unmatched-dispatch');
    assert.match(f.controller.snapshot().last.explanation, /多个相同/);
    assert.ok(f.controller.snapshot().history.every(r => !r.dispatch?.verified)); f.controller.dispose();
});
test('two copies of one cue do not verify an incomplete assistant/user pair', async () => {
    const f = fixture(); const req = f.request(); await f.bus.emit('request', req);
    const user = req.messages.at(-1);
    req.messages = [req.messages[0], user, { ...user }];
    const response = await f.networkTarget.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(req) });
    await response.text(); await f.controller.idle();
    assert.equal(f.controller.snapshot().last.reason, 'unmatched-dispatch'); f.controller.dispose();
});

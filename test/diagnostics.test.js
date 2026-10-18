import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, HISTORY_LIMIT, requestMeta, planReasoning, responseDiagnosis, formatRecord } from '../diagnostics.js';

test('history is bounded, survives a new controller/store, and clears durably', () => {
    const memory = new Map(); const storage = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v) };
    const first = createHistory(() => storage);
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) first.put({ id: String(i), injected: [{ role: 'user', content: '检查提示' }] });
    const second = createHistory(() => storage);
    assert.equal(second.list().length, HISTORY_LIMIT); assert.equal(second.list()[0].id, '59');
    second.patch('59', { lifecycle: 'completed' }); assert.equal(createHistory(() => storage).list()[0].lifecycle, 'completed');
    const copy = second.list(); copy[0].injected[0].content = 'mutation'; assert.equal(second.list()[0].injected[0].content, '检查提示');
    second.clear(); assert.deepEqual(createHistory(() => storage).list(), []);
});
test('corrupt or unavailable persistence does not throw or lose in-page records', () => {
    const history = createHistory(() => ({ getItem: () => 'broken', setItem() { throw new Error('quota'); } }));
    history.put({ id: 'one' }); assert.equal(history.list().length, 1); assert.match(history.warning(), /保存失败/);
});
test('metadata never captures chats, headers, keys, stops, or provider URLs', () => {
    const meta = requestMeta({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'PRIVATE CHAT' }], custom_url: 'PRIVATE URL', reverse_proxy: 'PRIVATE PROXY', api_key: 'PRIVATE KEY', stop: ['PRIVATE STOP'] });
    assert.ok(!JSON.stringify(meta).includes('PRIVATE')); assert.equal(meta.messageCount, 1);
});
test('budget adjustment is opt-in and does not invent parameters for unknown models', () => {
    const request = { model: 'gemini-4-argon', reasoning_effort: 'max' };
    assert.equal(planReasoning(request, {}), null);
    assert.deepEqual(planReasoning(request, { reasoningMode: 'balanced' }), { before: 'max', after: 'medium' });
    assert.equal(planReasoning({ ...request, model: 'gemini-3-pro-preview' }, { reasoningMode: 'balanced' }).after, 'low');
    assert.equal(planReasoning({ ...request, model: 'unknown-model' }, { reasoningMode: 'balanced' }), null);
    assert.equal(request.reasoning_effort, 'max');
});
test('reasoning-only, tool-only and unrecognized replies have distinct diagnoses', () => {
    assert.match(responseDiagnosis({ recognized: true, reasoningChars: 1 }), /只有思考/);
    assert.match(responseDiagnosis({ recognized: true, toolCalls: true }), /工具调用/);
    assert.match(responseDiagnosis({}), /未完整识别/);
});
test('history detail distinguishes prepared from sent and avoids claiming delivery', () => {
    const record = { id: 'one', at: 'now', type: 'normal', applied: true, injected: [{ role: 'user', content: 'own prompt' }] };
    assert.match(formatRecord(record), /无发送层记录/);
    assert.match(formatRecord(record), /own prompt/);
    assert.match(formatRecord(record), /不等于模型必定执行/);
});
test('supported text-model levels are distinguished from image and unknown Gemini aliases', () => {
    const settings = { reasoningMode: 'balanced' };
    const req = model => ({ model, reasoning_effort: 'high' });
    assert.equal(planReasoning(req('google/gemini-3.1-pro-preview'), settings).after, 'medium');
    assert.equal(planReasoning(req('gemini-3-pro-preview'), settings).after, 'low');
    for (const model of ['gemini-3.1-flash-lite-image', 'gemini-3-pro-image-preview', 'gemini-4-unknown', 'gemini-2.50-fake']) {
        assert.equal(planReasoning(req(model), settings), null);
    }
});
test('partial capture and explicit refusal are not presented as complete output or silent emptiness', () => {
    assert.match(responseDiagnosis({ visibleChars: 10, captureLimited: true }), /取证不完整/);
    assert.match(responseDiagnosis({ visibleChars: 0, refusal: true, recognized: true }), /拒绝字段/);
});

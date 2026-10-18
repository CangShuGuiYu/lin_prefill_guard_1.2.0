import test from 'node:test';
import assert from 'node:assert/strict';
import { planInjection, getLinState, LIN_PROMPT_ID, DEFAULTS, DEFAULT_NUDGE, migrateSettings } from '../core.js';

export const original = '[Lin｜本轮承接]\n测试用承接条目。';
export function preset(enabled = true) {
    return { prompts: [{ identifier: LIN_PROMPT_ID, role: 'assistant', content: original }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: LIN_PROMPT_ID, enabled }] }] };
}
export function payload(type = 'normal') {
    return { type, stream: true, max_tokens: 16384, temperature: 1,
        messages: [
            { role: 'system', content: '世界与角色设定' },
            { role: 'user', content: '她走进书店，问起那本旧日记。' },
            { role: 'assistant', content: original },
            { role: 'system', content: '本轮任务；这一条必须完整保留。' },
            { role: 'user', content: '尾部规则；这一条必须完整保留。' },
        ] };
}
const run = (request = payload(), settings = {}, env = {}) => planInjection(request, { ...DEFAULTS, mode: 'pair', ...settings }, { preset: preset(), ...env });

test('moves only the independent Lin prompt; all other objects and request fields remain unchanged', () => {
    const input = payload();
    const before = structuredClone(input);
    const result = run(input);
    assert.equal(result.applied, true);
    assert.equal(result.removedOriginal, true);
    assert.deepEqual(result.tailRoles, ['assistant', 'user']);
    assert.deepEqual(input, before);
    assert.equal(result.messages.length, 6);
    [0, 1, 3, 4].forEach((i, j) => assert.equal(result.messages[j], input.messages[i]));
    assert.equal(result.messages.at(-1).role, 'user');
});

for (const type of [undefined, '', 'normal', 'regenerate', 'swipe']) {
    test(`normal generation variant ${String(type)} is supported`, () => {
        const input = payload(); input.type = type;
        assert.equal(run(input).applied, true);
    });
}
for (const [type, reason] of [['quiet', 'quiet'], ['impersonate', 'impersonate'], ['continue', 'continue-disabled'], ['unknown-future-type', 'unsupported-type']]) {
    test(`${type} is skipped without touching messages`, () => {
        const input = payload(type); const before = structuredClone(input);
        const result = run(input);
        assert.equal(result.applied, false); assert.equal(result.reason, reason); assert.deepEqual(input, before);
    });
}
test('disabled extension is a no-op', () => assert.equal(run(payload(), { enabled: false }).reason, 'disabled'));
test('disabled Lin prompt is respected even if a matching text exists in chat history', () => {
    assert.equal(run(payload(), {}, { preset: preset(false) }).reason, 'lin-disabled');
});
test('other presets are excluded by default', () => assert.equal(run(payload(), {}, { preset: {} }).reason, 'not-lin'));
test('manual all-presets scope works without matching Lin settings', () => {
    const result = run(payload(), { scope: 'all' }, { preset: {} });
    assert.equal(result.applied, true); assert.equal(result.removedOriginal, false);
});
test('missing Lin entry is restored when its current preset switch is on', () => {
    const input = payload(); input.messages.splice(2, 1);
    const result = run(input);
    assert.equal(result.applied, true); assert.equal(result.removedOriginal, false); assert.ok(result.note);
});
test('a merged message is never substring-deleted', () => {
    const input = payload(); input.messages[2].content += '\n另一插件的必要内容';
    const merged = input.messages[2]; const result = run(input);
    assert.ok(result.messages.includes(merged)); assert.equal(result.removedOriginal, false);
});
test('repeated invocation and a JSON-cloned retry do not duplicate the tail', () => {
    const first = run();
    for (const messages of [first.messages, structuredClone(first.messages)]) {
        const second = run({ ...payload(), messages });
        assert.equal(second.changed, false); assert.equal(second.reason, 'already-present');
        assert.equal(second.messages.length, first.messages.length);
    }
});
test('owned objects can be repositioned after another listener appends a message', () => {
    const first = run(); const owned = new WeakSet(first.injected);
    const added = { role: 'user', content: '另一插件的提示' };
    const second = run({ ...payload(), messages: [...first.messages, added] }, {}, { ownedMessages: owned });
    assert.equal(second.removedOwned, 2); assert.equal(second.messages.at(-3), added);
    assert.equal(second.messages.length, first.messages.length + 1);
});
test('partial/quoted markers and unrelated assistant messages survive', () => {
    const input = payload();
    const quoted = { role: 'assistant', content: '书里写着 [Lin 承接提示]，随后她把书合上。' };
    input.messages.splice(2, 0, quoted);
    assert.ok(run(input).messages.includes(quoted));
});
test('a single text block is matched, while multimodal and signed blocks stay intact', () => {
    const input = payload(); input.messages[2].content = [{ type: 'text', text: original }];
    const media = { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] };
    const thinking = { role: 'assistant', content: [{ type: 'thinking', thinking: 'opaque', signature: 'signed' }, { type: 'text', text: '回答' }] };
    input.messages.splice(2, 0, media, thinking);
    const result = run(input);
    assert.equal(result.removedOriginal, true); assert.ok(result.messages.includes(media)); assert.ok(result.messages.includes(thinking));
});
test('native assistant prefill is never stacked', () => {
    const input = payload(); input.assistant_prefill = '故事开头';
    assert.equal(run(input).reason, 'native-prefill');
});
test('native continue prefill is respected even when continue enhancement is enabled', () => {
    assert.equal(run(payload('continue'), { enhanceContinue: true }, { preset: { ...preset(), continue_prefill: true } }).reason, 'native-prefill');
    const input = payload('continue'); input.messages.push({ role: 'assistant', content: '半句未完' });
    assert.equal(run(input, { enhanceContinue: true }).reason, 'native-prefill');
});
test('non-native continue uses a completion cue and preserves partial text', () => {
    const input = payload('continue'); const half = { role: 'assistant', content: '她翻开书，指着' };
    input.messages.splice(2, 0, half);
    const result = run(input, { enhanceContinue: true });
    assert.equal(result.applied, true); assert.ok(result.messages.includes(half)); assert.match(result.messages.at(-1).content, /可见断点/);
});
for (const patch of [{ tools: [{ type: 'function' }] }, { functions: [{ name: 'demo' }] }, { tool_choice: 'required' }]) {
    test(`active tool request ${Object.keys(patch)[0]} is untouched`, () => assert.equal(run({ ...payload(), ...patch }).reason, 'tools'));
}
test('in-flight tool result and pending tool use are untouched', () => {
    for (const last of [{ role: 'tool', tool_call_id: '1', content: 'result' }, { role: 'assistant', content: '', tool_calls: [{ id: '1' }] }, { role: 'assistant', content: [{ type: 'tool_use', id: '1' }] }]) {
        const input = payload(); input.messages.push(last);
        assert.equal(run(input).reason, 'tools');
    }
});
test('structured output is untouched', () => {
    assert.equal(run({ ...payload(), json_schema: { name: 'schema' } }).reason, 'structured');
    assert.equal(run({ ...payload(), response_format: { type: 'json_object' } }).reason, 'structured');
});
test('user-only compatibility mode adds exactly one message', () => {
    const result = run(payload(), { mode: 'user' });
    assert.deepEqual(result.tailRoles, ['user']); assert.equal(result.messages.length, payload().messages.length);
});
test('empty and overlong custom prompts cause a visible skip', () => {
    assert.equal(run(payload(), { prefill: '   ' }).reason, 'empty-text');
    assert.equal(run(payload(), { prefill: '文'.repeat(701) }).reason, 'text-too-long');
    assert.equal(run(payload(), { nudge: '文'.repeat(251) }).reason, 'text-too-long');
});
test('invalid payloads are not modified', () => {
    for (const request of [null, {}, { messages: [null] }, { messages: [{ content: 'missing role' }] }]) {
        assert.equal(run(request).reason, 'bad-payload');
    }
    assert.equal(run({ messages: [{ role: 'system', content: 'no user' }] }).reason, 'no-user');
});
test('global prompt-order switch wins over another list and the prompt.enabled convenience field', () => {
    const p = preset(false); p.prompts[0].enabled = true;
    p.prompt_order.unshift({ character_id: 100000, order: [{ identifier: LIN_PROMPT_ID, enabled: true }] });
    assert.equal(getLinState(p).active, false);
});

test('fresh installation defaults to a single user message; pair remains explicit', () => {
    assert.deepEqual(planInjection(payload(), {}, { preset: preset() }).tailRoles, ['user']);
});
test('native prefill in settings is respected even when not copied to generate_data', () => {
    assert.equal(run(payload(), {}, { preset: { ...preset(), assistant_prefill: '开头' } }).reason, 'native-prefill');
});
test('reimported Lin entry can be identified narrowly without depending on a filename', () => {
    const p = preset(); p.prompts[0].identifier = 'new-id';
    p.prompts[0].name = '✮伪预填充｜剧情衔接（assistant）';
    p.prompt_order[0].order[0].identifier = 'new-id';
    assert.equal(run(payload(), {}, { preset: p }).applied, true);
    p.prompts.push({ ...p.prompts[0], identifier: 'duplicate' });
    assert.equal(run(payload(), {}, { preset: p }).reason, 'not-lin');
});
test('prompt generation triggers are not bypassed by restoring a missing entry', () => {
    const p = preset(); p.prompts[0].injection_trigger = ['swipe'];
    assert.equal(run(payload(), {}, { preset: p }).reason, 'trigger-excluded');
    assert.equal(run(payload('swipe'), {}, { preset: p }).applied, true);
});

test('upgrade retains saved pair mode and custom fields; only stock legacy nudge is refreshed', () => {
    const legacy = { mode: 'pair', enabled: false, prefill: '自定义承接', extra: 'future setting',
        nudge: '请现在完成上述真实用户请求。这里是任务提示，不是新的剧情；不要复述提示。' };
    const next = migrateSettings(legacy);
    assert.equal(next.mode, 'pair'); assert.equal(next.enabled, false);
    assert.equal(next.prefill, '自定义承接'); assert.equal(next.extra, 'future setting');
    assert.equal(next.nudge, DEFAULT_NUDGE);
    assert.equal(migrateSettings({ nudge: '我的提示', mode: 'user' }).nudge, '我的提示');
    assert.deepEqual(migrateSettings(next), next);
    assert.notEqual(legacy.nudge, DEFAULT_NUDGE);
});
test('a thought-marked text block is never removed as a plain Lin prompt', () => {
    const input = payload();
    input.messages[2].content = [{ type: 'text', text: original, thought: true }];
    const thought = input.messages[2];
    const result = run(input);
    assert.ok(result.messages.includes(thought)); assert.equal(result.removedOriginal, false);
});

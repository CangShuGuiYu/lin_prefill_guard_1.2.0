/** Read-only observation of ST's single chat endpoint. Never retries or rewrites a response. */
const ENDPOINT = '/api/backends/chat-completions/generate';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MS = 180000;
const safeCode = value => typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 100) : '';
const chars = value => typeof value === 'string' ? value.length : Array.isArray(value)
    ? value.reduce((n, p) => n + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0;

export function addResponseData(stats, data) {
    if (!data || typeof data !== 'object') return;
    if (data.error) stats.apiError = true;
    if (data.promptFeedback?.blockReason) { stats.recognized = true; stats.blockReason = safeCode(data.promptFeedback.blockReason); }
    const candidate = data.candidates?.[0];
    if (candidate) {
        stats.recognized = true;
        for (const p of candidate.content?.parts || []) {
            if (p.thought) stats.reasoningChars += chars(p.text);
            else stats.visibleChars += chars(p.text);
            if (p.functionCall) stats.toolCalls = true;
        }
        if (candidate.finishReason) stats.finishReason = safeCode(candidate.finishReason);
    }
    const choice = data.choices?.find(c => c.index === 0) || data.choices?.[0];
    if (choice && (choice.index === undefined || choice.index === 0)) {
        stats.recognized = true;
        const message = choice.delta || choice.message || {};
        stats.visibleChars += chars(message.content ?? choice.text);
        stats.reasoningChars += chars(message.reasoning_content ?? message.reasoning);
        if (message.refusal) stats.refusal = true;
        if (message.tool_calls?.length || message.function_call) stats.toolCalls = true;
        if (choice.finish_reason) stats.finishReason = safeCode(choice.finish_reason);
    }
    // Anthropic native SSE and non-streaming messages.
    if (data.type === 'content_block_delta') {
        stats.recognized = true;
        stats.visibleChars += chars(data.delta?.text);
        stats.reasoningChars += chars(data.delta?.thinking);
    }
    if (data.type === 'content_block_start' && data.content_block) {
        stats.recognized = true;
        if (data.content_block.type === 'tool_use') stats.toolCalls = true;
        stats.visibleChars += chars(data.content_block.text);
        stats.reasoningChars += chars(data.content_block.thinking);
    }
    if (data.type === 'message' && Array.isArray(data.content)) {
        stats.recognized = true;
        for (const p of data.content) {
            stats.visibleChars += chars(p.text);
            stats.reasoningChars += chars(p.thinking);
            if (p.type === 'tool_use') stats.toolCalls = true;
        }
    }
    if (data.delta?.stop_reason || data.stop_reason) stats.finishReason = safeCode(data.delta?.stop_reason || data.stop_reason);
    if (data.status === 'incomplete') stats.incomplete = true;
    const usage = data.usageMetadata || data.usage || data.message?.usage;
    const thought = usage?.thoughtsTokenCount ?? usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens ?? usage?.total_thought_tokens;
    const output = usage?.candidatesTokenCount ?? usage?.completion_tokens ?? usage?.output_tokens ?? usage?.total_output_tokens;
    if (typeof thought === 'number') stats.thoughtTokens = thought;
    if (typeof output === 'number') stats.outputTokens = output;
}

export async function inspectResponse(response, { maxBytes = MAX_BYTES, timeoutMs = MAX_MS, register = () => () => {} } = {}) {
    const stats = { httpStatus: response.status, visibleChars: 0, reasoningChars: 0, recognized: false, parseErrors: 0 };
    if (!response.body) return stats;
    const reader = response.body.getReader();
    let stopped = false;
    const cancel = () => { stopped = true; reader.cancel().catch(() => {}); };
    const unregister = register(cancel);
    const timer = setTimeout(() => { stats.captureLimited = true; cancel(); }, timeoutMs);
    const decoder = new TextDecoder();
    const sse = (response.headers.get('content-type') || '').includes('text/event-stream');
    let bytes = 0;
    let buffer = '';
    function parse(text) {
        if (!text.trim()) return;
        // A stream terminator alone does not identify the provider's payload format.
        if (text.trim() === '[DONE]') return;
        try { addResponseData(stats, JSON.parse(text)); } catch { stats.parseErrors++; }
    }
    function frame(text) {
        const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        parse(data);
    }
    try {
        while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) { stats.captureLimited = true; cancel(); break; }
            buffer += decoder.decode(value, { stream: true });
            if (sse) {
                let match;
                while ((match = /\r?\n\r?\n/.exec(buffer))) {
                    frame(buffer.slice(0, match.index));
                    buffer = buffer.slice(match.index + match[0].length);
                }
            }
        }
        if (!stopped) {
            buffer += decoder.decode();
            if (sse) frame(buffer); else parse(buffer);
        }
    } catch { stats.captureLimited = true; }
    finally { clearTimeout(timer); unregister(); reader.releaseLock(); }
    return stats;
}

export function installObserver({ target = globalThis, enabled, onDispatch, onResponse, onError }) {
    const original = target.fetch;
    let active = true;
    const readers = new Set();
    const tasks = new Set();
    if (typeof original !== 'function') return { available: false, dispose() {}, idle: async () => {} };
    async function wrapped(input, init) {
        let id;
        try {
            const base = target.location?.href || 'http://localhost/';
            const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, base);
            if (active && enabled() && url.origin === new URL(base).origin && url.pathname === ENDPOINT
                && String(init?.method || input?.method || 'GET').toUpperCase() === 'POST'
                && typeof init?.body === 'string') {
                id = onDispatch(JSON.parse(init.body));
            }
        } catch { /* Unsupported request shapes pass through unchanged. */ }
        let response;
        try { response = await original.call(this, input, init); }
        catch (error) {
            if (id && active) { try { onError(id, { aborted: error?.name === 'AbortError', networkError: error?.name !== 'AbortError' }); } catch { /* isolated */ } }
            throw error;
        }
        if (id && active) {
            try {
                const task = inspectResponse(response.clone(), {
                    register(cancel) { readers.add(cancel); return () => readers.delete(cancel); },
                }).then(stats => { if (active) onResponse(id, stats); }).catch(() => {
                    if (active) onError(id, { captureLimited: true });
                });
                tasks.add(task);
                task.finally(() => tasks.delete(task)).catch(() => {});
            } catch { try { onError(id, { captureLimited: true }); } catch { /* isolated */ } }
        }
        return response;
    }
    try { target.fetch = wrapped; }
    catch { return { available: false, dispose() {}, idle: async () => {} }; }
    return {
        available: true,
        idle: () => Promise.allSettled([...tasks]),
        dispose() {
            active = false;
            for (const cancel of readers) cancel();
            readers.clear();
            // Preserve a later extension's wrapper. Our retained inner wrapper becomes inert.
            if (target.fetch === wrapped) target.fetch = original;
        },
    };
}

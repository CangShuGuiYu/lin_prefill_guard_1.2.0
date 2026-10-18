import { planInjection, REASONS, VERSION, normalizeSettings } from './core.js';
import { auditPreset, captureInjection, createHistory, planReasoning, requestKey, requestMeta, responseDiagnosis } from './diagnostics.js';
import { installObserver } from './observer.js';

export function createController({ getContext, getSettings, onStatus = () => {}, networkTarget = globalThis }) {
    const ctx = getContext();
    const events = ctx.eventTypes || ctx.event_types || {};
    const bus = ctx.eventSource;
    const requestEvent = events.CHAT_COMPLETION_SETTINGS_READY;
    const ownedMessages = new WeakSet();
    const subscriptions = [];
    const requestRecords = new WeakMap();
    const history = createHistory(() => getContext().accountStorage);
    const pending = [];
    let disposed = false;
    let last = history.list()[0] || null;
    let lastSkip = null;
    let response = null;
    let active = null;
    let sequence = 0;
    const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${++sequence}`;
    const snapshot = () => ({ last, lastSkip, response, version: VERSION, history: history.list(), storageWarning: history.warning(), networkAvailable: observer.available });

    function publish() { try { onStatus(snapshot()); } catch { /* UI errors never block generation. */ } }
    function patch(recordId, values) {
        history.patch(recordId, values);
        if (last?.id === recordId) Object.assign(last, values);
        publish();
    }
    function handleRequest(request) {
        if (disposed) return;
        try {
            const context = getContext();
            const preset = context.chatCompletionSettings || {};
            const settings = getSettings();
            const result = planInjection(request, settings, { preset, ownedMessages });
            let adjustment = result.applied ? planReasoning(request, settings) : null;
            // Preflight writes so a frozen object cannot be half-modified.
            const writable = key => {
                const d = Object.getOwnPropertyDescriptor(request, key);
                return d ? d.writable === true : Object.isExtensible(request);
            };
            if (result.changed && !writable('messages')) throw new Error('immutable request');
            if (adjustment && !writable('reasoning_effort')) adjustment = null;
            if (result.changed) {
                request.messages = result.messages;
                result.injected.forEach(m => ownedMessages.add(m));
            }
            if (adjustment) request.reasoning_effort = adjustment.after;
            const priorRef = request && requestRecords.get(request);
            const prior = priorRef && (history.list().find(r => r.id === priorRef.id) || priorRef);
            const report = {
                ...prior,
                id: prior?.id || id(), at: prior?.at || new Date().toISOString(), version: VERSION,
                type: result.type, applied: result.applied, reason: result.reason,
                explanation: REASONS[result.reason] || result.reason,
                removedOriginal: result.removedOriginal || prior?.removedOriginal || false,
                netChars: result.changed ? result.netChars : prior?.netChars || 0,
                tailRoles: result.tailRoles || [], note: result.note || prior?.note || '',
                injected: result.applied ? result.injected.map(m => ({ role: m.role, content: m.content })) : [],
                preview: result.applied ? result.injected.map(m => `${m.role}\n${m.content}`).join('\n\n') : '',
                request: requestMeta(request), warnings: auditPreset(preset, request),
                adjustment: adjustment || prior?.adjustment || null,
            };
            if (['quiet', 'impersonate'].includes(result.type)) { lastSkip = report; publish(); return; }
            if (!normalizeSettings(settings).enabled) { publish(); return; }
            last = report;
            if (!prior) response = null;
            history.put(report);
            requestRecords.set(request, report);
            const key = requestKey(request);
            const item = { id: report.id, key, injected: report.injected, type: result.type, model: report.request.model, at: Date.now() };
            const existing = pending.findIndex(x => x.id === report.id);
            if (existing >= 0) pending.splice(existing, 1);
            if (!report.dispatch) pending.push(item);
            while (pending.length > 20) pending.shift();
            if (active?.id !== report.id) {
                active = { id: report.id, chat: context.chat, type: result.type, baselineLength: context.chat?.length || 0, ended: false };
            }
            publish();
        } catch {
            last = { id: id(), at: new Date().toISOString(), version: VERSION, type: request?.type || 'normal', applied: false, reason: 'internal-error', explanation: REASONS['internal-error'], injected: [], preview: '' };
            history.put(last);
            publish();
        }
    }
    const observer = installObserver({
        target: networkTarget,
        enabled: () => !disposed && normalizeSettings(getSettings()).enabled && normalizeSettings(getSettings()).captureNetwork,
        onDispatch(request) {
            if (!Array.isArray(request.messages) || ['quiet', 'impersonate'].includes(request.type)) return null;
            const key = requestKey(request);
            const recent = pending.filter(x => Date.now() - x.at < 180000);
            const exact = recent.filter(x => x.key === key);
            let candidate = exact.length === 1 ? exact[0] : null;
            let correlation = 'exact';
            if (!candidate && exact.length === 0) {
                const matches = recent.filter(x => {
                    const found = captureInjection(request.messages, x.injected);
                    return x.type === (request.type || 'normal') && x.model === String(request.model || '')
                        && x.injected.length && found.length === x.injected.length
                        && found.every((m, i) => m.role === x.injected[i].role && m.content === x.injected[i].content);
                });
                if (matches.length === 1) { candidate = matches[0]; correlation = 'injection-match'; }
            }
            if (!candidate) {
                const record = { id: id(), version: VERSION, at: new Date().toISOString(), type: request.type || 'normal', applied: false,
                    reason: 'unmatched-dispatch', explanation: exact.length > 1
                        ? '观察到发送，但存在多个相同的待发送请求；不猜测属于哪条记录。'
                        : '观察到发送，但没有唯一匹配的组装记录；可能绕过了事件或消息被改写。',
                    request: requestMeta(request), injected: [], warnings: [],
                    dispatch: { at: new Date().toISOString(), label: '已观察到发送；无法核实本插件注入', injected: [], correlation: 'unmatched' } };
                history.put(record); last = record; publish(); return record.id;
            }
            const index = pending.indexOf(candidate);
            if (index >= 0) pending.splice(index, 1);
            const injected = captureInjection(request.messages, candidate.injected);
            const verified = candidate.injected.length > 0 && injected.length === candidate.injected.length
                && injected.every((m, i) => m.role === candidate.injected[i].role && m.content === candidate.injected[i].content);
            const tail = verified && injected.at(-1).index === request.messages.length - 1
                && injected.every((m, i) => m.index === request.messages.length - injected.length + i);
            patch(candidate.id, { dispatch: {
                at: new Date().toISOString(), correlation, injected, verified, tail, request: requestMeta(request),
                label: injected.length ? `已观察到发送；注入文本${tail ? '位于末尾' : '存在，但后方还有消息'}${correlation === 'injection-match' ? '；其他内容在组装后发生变化' : ''}` : '已观察到发送；本次未注入',
            } });
            return candidate.id;
        },
        onResponse(recordId, wire) { patch(recordId, { wire }); if (last?.id === recordId) { response = responseDiagnosis(wire); publish(); } },
        onError(recordId, wire) { patch(recordId, { wire }); if (last?.id === recordId) { response = responseDiagnosis(wire); publish(); } },
    });

    function lateRegistration() {
        if (!disposed && requestEvent && typeof bus.makeLast === 'function') bus.makeLast(requestEvent, handleRequest);
    }
    function onMessage(messageId, type) {
        if (disposed || !active || ['quiet', 'impersonate', 'first_message'].includes(type)) return;
        // saveReply normalizes regenerate to normal and may report continuation as appendFinal.
        const compatibleTypes = { normal: ['normal'], regenerate: ['regenerate', 'normal'],
            swipe: ['swipe'], continue: ['continue', 'append', 'appendFinal'] };
        if (type && !(compatibleTypes[active.type] || [active.type]).includes(type)) return;
        const context = getContext();
        if (messageId === null || messageId === '' || context.chat !== active.chat || !Number.isInteger(Number(messageId))) return;
        const index = Number(messageId);
        const message = context.chat?.[index];
        if (!message || message.is_user || message.is_system) return;
        // Older messages cannot be credited to a new normal generation.
        if (['normal', 'regenerate'].includes(active.type) && index < active.baselineLength) return;
        if (['swipe', 'continue'].includes(active.type) && index !== active.baselineLength - 1) return;
        const chars = typeof message.mes === 'string' ? message.mes.trim().length : 0;
        const reasoningChars = typeof message.extra?.reasoning === 'string' ? message.extra.reasoning.length : 0;
        response = chars ? `酒馆保存的正文为 ${chars} 字符；屏幕为空时检查显示正则与样式。` : reasoningChars
            ? '酒馆保存了思考内容，但正文为空。请查看接口诊断。' : '酒馆保存的是空正文。请查看接口诊断。';
        patch(active.id, { rendered: { chars, reasoningChars }, lifecycle: response });
    }
    function onEnd() {
        if (!active) return;
        active.ended = true;
        const record = history.list().find(r => r.id === active.id);
        if (!record?.rendered) patch(active.id, { lifecycle: '生成已结束，尚未观察到正文保存事件；检查接口记录。稍后到达的正文事件仍会更新此记录。' });
    }
    function onStop() {
        if (active) patch(active.id, { lifecycle: '用户停止或客户端中止了生成。' });
        active = null;
    }
    function onChatChanged() { active = null; }
    function subscribe(event, fn) { if (event) { bus.on(event, fn); subscriptions.push([event, fn]); } }
    if (!bus || typeof bus.on !== 'function' || !requestEvent) {
        last = { applied: false, reason: 'unsupported-client', explanation: '当前酒馆未提供所需的 Chat Completion 事件。请确认版本或分支兼容。', injected: [], preview: '' };
        publish();
    } else {
        subscribe(requestEvent, handleRequest);
        subscribe(events.GENERATION_STARTED, lateRegistration);
        subscribe(events.MESSAGE_RECEIVED, onMessage);
        subscribe(events.GENERATION_ENDED, onEnd);
        subscribe(events.GENERATION_STOPPED, onStop);
        subscribe(events.CHAT_CHANGED, onChatChanged);
        lateRegistration();
    }
    return {
        snapshot,
        preview: request => planInjection(request, getSettings(), { preset: getContext().chatCompletionSettings || {} }),
        audit: () => auditPreset(getContext().chatCompletionSettings || {}),
        restoreHistory() { history.load(); if (!last?.id) last = history.list()[0] || last; publish(); },
        clearHistory() { history.clear(); pending.length = 0; active = null; last = null; response = null; publish(); },
        idle: () => observer.idle(),
        dispose() {
            disposed = true;
            observer.dispose();
            const remove = bus?.removeListener || bus?.off;
            if (remove) subscriptions.forEach(([event, fn]) => remove.call(bus, event, fn));
            subscriptions.length = 0;
        },
    };
}

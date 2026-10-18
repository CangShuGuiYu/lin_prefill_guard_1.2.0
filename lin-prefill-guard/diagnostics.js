import { getLinState, normalizeSettings, plainText, VERSION } from './core.js';

export const HISTORY_KEY = 'lin_prefill_guard_history_v2';
export const HISTORY_LIMIT = 50;

/** Only the extension's own text and allowlisted metadata enter persistent history. */
export function createHistory(getStorage = () => null) {
    let records = [];
    let warning = '';
    const copy = value => JSON.parse(JSON.stringify(value));
    function load() {
        try {
            const value = JSON.parse(getStorage()?.getItem(HISTORY_KEY) || '[]');
            if (Array.isArray(value)) {
                const existing = new Set(records.map(r => r.id));
                records.push(...value.filter(r => r && typeof r.id === 'string' && !existing.has(r.id)));
                records = records.slice(0, HISTORY_LIMIT);
            }
        } catch { warning = '历史记录读取失败；本次仍可在内存中记录。'; }
    }
    function persist() {
        try {
            const storage = getStorage();
            if (!storage) { warning = '当前分支没有账户存储，记录只保留在当前页面。'; return; }
            storage.setItem(HISTORY_KEY, JSON.stringify(records));
            warning = '';
        } catch { warning = '记录保存失败（可能空间不足）；本页记录仍可复制和导出。'; }
    }
    load();
    return {
        load,
        list: () => copy(records),
        warning: () => warning,
        put(record) {
            records = [copy(record), ...records.filter(r => r.id !== record.id)].slice(0, HISTORY_LIMIT);
            persist();
        },
        patch(id, patch) {
            const record = records.find(r => r.id === id);
            if (record) { Object.assign(record, copy(patch)); persist(); }
        },
        clear() { records = []; persist(); },
    };
}

export function requestMeta(request = {}) {
    return {
        model: String(request.model || '').slice(0, 160),
        source: String(request.chat_completion_source || '').slice(0, 60),
        type: typeof request.type === 'string' && request.type ? request.type : 'normal',
        stream: !!request.stream,
        maxTokens: Number.isFinite(Number(request.max_tokens)) ? Number(request.max_tokens) : null,
        reasoningEffort: String(request.reasoning_effort || 'auto').slice(0, 30),
        webSearch: request.enable_web_search === true,
        messageCount: request.messages?.length || 0,
        tailRoles: Array.isArray(request.messages) ? request.messages.slice(-6).map(m => String(m?.role || '')) : [],
    };
}

/** Non-cryptographic local correlation only; never a security or content-integrity claim. */
export function requestKey(request) {
    const value = JSON.stringify([request.type || 'normal', request.model, request.messages]);
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return `${value.length}:${hash >>> 0}`;
}

export function captureInjection(messages, injected = []) {
    const result = [];
    if (!Array.isArray(messages)) return result;
    for (let index = 0; index < messages.length; index++) {
        const m = messages[index];
        const text = plainText(m);
        if (injected.some(x => x.role === m?.role && x.content === text)) {
            result.push({ index, role: m.role, content: text });
        }
    }
    return result;
}

export function auditPreset(preset = {}, request = {}) {
    const notes = [];
    const effort = request.reasoning_effort || preset.reasoning_effort;
    const limit = request.max_tokens ?? preset.openai_max_tokens;
    if (['max', 'high', 'xhigh'].includes(effort)) notes.push(`思考强度为 ${effort}，输出上限 ${limit || '未提供'}；若只有思考没有正文，先检查返回的结束原因与思考用量。`);
    const orders = preset.prompt_order?.find(o => String(o.character_id) === '100001')?.order || [];
    const active = (preset.prompts || []).filter(p => orders.some(o => o.identifier === p.identifier && o.enabled));
    const size = active.reduce((n, p) => n + (p.content?.length || 0), 0);
    if (size > 20000) notes.push(`启用的固定提示约 ${size} 字符（不含世界书与聊天）；长规则会增加预算与规则冲突压力。`);
    if (active.some(p => /绝对不可以直接输出正文|必须进行最大程度的思考/.test(p.content || ''))) notes.push('尾部含强制最大思考要求；可与高思考参数叠加，且文字提示不能保证给正文预留 token。');
    if (preset.enable_web_search === true) notes.push('预设开启网页搜索；无联网需要时可关闭，减少工具及渠道兼容变量。');
    if (Number(preset.openai_max_context) > 1048576 && /gemini.?4|argon/i.test(request.model || '')) notes.push('预设上下文超过 Gemini 4 官方共享 1M 上限；本地设置不会扩大服务商实际窗口。');
    const lin = getLinState(preset);
    if (!lin.known) notes.push('未识别到 Lin 承接条目；请核对当前实际加载的预设。');
    else if (lin.active === false) notes.push('Lin 承接条目已关闭。');
    return notes;
}

/** Opt-in, request-only adjustment, limited to known Gemini families. */
export function planReasoning(request, settings) {
    if (normalizeSettings(settings).reasoningMode !== 'balanced') return null;
    if (!['max', 'high', 'xhigh'].includes(request.reasoning_effort)) return null;
    const model = String(request.model || '').toLowerCase();
    let value;
    const name = model.split('/').at(-1);
    // Image/TTS and unknown aliases may support different levels. Do not guess.
    if (/(?:^|[-_.])(?:image|tts)(?:[-_.]|$)/.test(name)) return null;
    if (/^gemini-3-pro(?:-|$)/.test(name)) value = 'low';
    else if (/^gemini-(?:2\.5-(?:pro|flash(?:-lite)?)|3\.1-pro|3(?:\.[568])?-flash(?:-lite)?|4-argon)(?:-|$)/.test(name)) value = 'medium';
    if (!value) return null;
    return { before: request.reasoning_effort, after: value };
}

export function responseDiagnosis(stats = {}) {
    if (stats.aborted) return '请求已中止；不据此判断模型空回。';
    if (stats.networkError) return '网络请求失败；没有取得可分析的响应。';
    if (stats.httpStatus >= 400 || stats.apiError) return `接口错误${stats.httpStatus ? `（HTTP ${stats.httpStatus}）` : ''}；查看酒馆原错误提示。`;
    if (stats.blockReason || /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|CONTENT_FILTER/i.test(stats.finishReason || '')) return `接口报告拦截或限制：${stats.blockReason || stats.finishReason}。`;
    if (stats.refusal && !stats.visibleChars) return '接口返回了拒绝字段，未检测到正文；这与没有返回数据不同。';
    if (stats.visibleChars > 0) return `接口返回正文 ${stats.visibleChars} 字符${/MAX_TOKENS|LENGTH/i.test(stats.finishReason || '') ? '，但达到输出上限，可能截断' : ''}${stats.captureLimited || stats.parseErrors ? '；取证不完整，该数值仅包含已识别部分' : ''}。`;
    if (stats.captureLimited) return '取证达到容量或时间上限；尚不能据此判断空回。';
    if (stats.parseErrors || !stats.recognized) return '响应格式未完整识别；请查看酒馆原错误提示或渠道日志。';
    if (/MAX_TOKENS|LENGTH/i.test(stats.finishReason || '') || stats.incomplete) return '达到输出预算或返回不完整，未检测到正文；可能在思考阶段耗尽预算。';
    if (stats.toolCalls) return '接口返回工具调用，未检测到正文；请检查工具后续流程。';
    if (stats.reasoningChars > 0 || stats.thoughtTokens > 0) return '接口只有思考内容或思考用量，没有检测到正文。';
    return '接口没有返回可识别正文；仅凭空内容无法确定原因。';
}

export function formatRecord(record) {
    if (!record) return '尚无记录。正常发送一条消息后可在这里查询。';
    const lines = [`记录 ${record.id} · v${record.version || VERSION}`, `时间：${record.at}`, `类型：${record.type} · 模型：${record.request?.model || '未提供'}`, `组装：${record.explanation}`, `发送：${record.dispatch?.label || '未观察到浏览器发送，或未开启网络取证'}`];
    if (record.adjustment) lines.push(`本次思考参数：${record.adjustment.before} → ${record.adjustment.after}`);
    if (record.wire) lines.push(`接口：${responseDiagnosis(record.wire)}`, `结束原因：${record.wire.finishReason || record.wire.blockReason || '渠道未提供'}`, `思考 token：${record.wire.thoughtTokens ?? '渠道未提供'} · 生成 token（渠道口径，可能含思考）：${record.wire.outputTokens ?? '渠道未提供'}`);
    if (record.rendered) lines.push(`酒馆保存的正文：${record.rendered.chars} 字符；思考：${record.rendered.reasoningChars} 字符（不代表屏幕显示结果）。`);
    if (record.lifecycle) lines.push(record.lifecycle);
    lines.push('', '—— 请求组装时的注入文本 ——');
    for (const m of record.injected || []) lines.push(`[${m.role}]\n${m.content}`);
    lines.push('', '—— 浏览器发送时核对到的注入文本 ——');
    if (record.dispatch) {
        for (const m of record.dispatch.injected || []) lines.push(`messages[${m.index}] · ${m.role}\n${m.content}`);
        if (!record.dispatch.injected?.length) lines.push('没有核对到原注入文本。');
    } else lines.push('无发送层记录。');
    if (record.warnings?.length) lines.push('', '—— 预设自查 ——', ...record.warnings);
    lines.push('', '发送层记录位于浏览器到酒馆后端的边界。后端、其他拦截器和中转仍可能转换请求；不等于模型必定执行。');
    return lines.join('\n\n');
}

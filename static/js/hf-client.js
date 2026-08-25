// hf-client.js — shared client-side chat-completions caller. Works against any
// OpenAI-compatible chat-completions endpoint (HF's router by default, or e.g.
// Venice.ai when apiBase/token are pointed elsewhere) — the server can't reach
// some of these hosts directly (see chat.js's callChatApi comment), so any
// feature that needs a completion calls this from the browser instead.
async function callHuggingFaceChat({
    token, model, systemPrompt, userMessage, maxTokens = 500, temperature = 0.9,
    apiBase = 'https://router.huggingface.co/v1/chat/completions',
}) {
    if (!token) throw new Error('Chat API token not configured on the server.');

    const res = await fetch(apiBase, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userMessage },
            ],
            max_tokens:  maxTokens,
            temperature,
        }),
    });

    const rawBody = await res.text();
    if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
            const errData = JSON.parse(rawBody);
            errMsg = errData?.error?.message || errData?.error || rawBody.slice(0, 200);
        } catch { errMsg = rawBody.slice(0, 200) || errMsg; }
        if (res.status === 401) throw new Error('Invalid chat API token. Check the one configured for this provider.');
        if (res.status === 403) throw new Error(`Access denied for model "${model}". Try a different model or check its access/license with the provider.`);
        if (res.status === 503) throw new Error('Model warming up. Please wait ~30 seconds and try again.');
        if (res.status === 429) throw new Error('Rate limited. Wait a moment before trying again.');
        throw new Error(`Chat API error ${res.status}: ${errMsg}`);
    }

    let choice;
    try {
        choice = JSON.parse(rawBody).choices[0];
    } catch (e) {
        throw new Error('Unexpected response format from chat API');
    }

    const text = (choice.message.content || '').trim().replace(/^["']|["']$/g, '');
    if (!text) {
        // "Thinking"/reasoning models (e.g. GLM, DeepSeek-R1-style) can burn the whole
        // token budget on a hidden reasoning_content field and never reach the final
        // answer, leaving message.content empty with finish_reason "length" — a very
        // different problem from a genuinely empty completion, so it gets its own message.
        const reasoning = (choice.message.reasoning_content || choice.message.reasoning || '').trim();
        if (reasoning && choice.finish_reason === 'length') {
            throw new Error(
                `Model "${model}" spent its entire ${maxTokens}-token budget on hidden reasoning ` +
                `and never produced a final answer (finish_reason: length). Try a higher max_tokens, ` +
                `or use a non-"thinking" variant of this model.`
            );
        }
        throw new Error('Empty response generated');
    }
    return text;
}


// ── Quote post-processing ────────────────────────────────────────────────────
// Chat models don't reliably honour "reply with only the caption": they prepend
// "Sure! Here's a caption:", wrap the line in quotes, leak <think> blocks, or
// run long. The server rejects anything over max_chars, so cleaning up here is
// the difference between saving a good caption and throwing away a completion we
// already paid for.

const _QUOTE_PREAMBLE_RE = /^\s*(?:sure|certainly|of course|here(?:'s| is)|okay|ok)\b[^\n:]{0,60}:\s*/i;

function normalizeQuote(text) {
    let out = String(text || '');

    // Reasoning models leak their scratchpad; keep only what follows it.
    out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
    out = out.replace(/^[\s\S]*?<\/think>/i, '');

    out = out.trim();
    out = out.replace(_QUOTE_PREAMBLE_RE, '');

    // Collapse to a single line — a caption is one line by definition, and a
    // model that returned options usually put the best one first.
    const firstLine = out.split(/\n{2,}/)[0].trim();
    if (firstLine) out = firstLine;
    out = out.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

    // Strip wrapping quotes (straight or curly), and any list marker.
    out = out.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '');
    out = out.replace(/^["'\u201C\u2018]+|["'\u201D\u2019]+$/g, '').trim();

    return out;
}

// Qwen and other bilingual models code-switch — a Chinese clause turns up mid
// sentence. Any CJK, Cyrillic, Arabic, Hebrew, Hangul or Thai means the model
// ignored the English-only instruction.
const _NON_LATIN_RE = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\uAC00-\uD7AF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0E00-\u0E7F]/;

function quoteHasNonEnglishScript(text) {
    return _NON_LATIN_RE.test(String(text || ''));
}

// Trim to the last sentence that fits, so an over-long caption becomes a shorter
// complete one rather than a hard failure or a mid-word truncation.
function trimQuoteToLimit(text, maxChars) {
    const limit = maxChars || 500;
    let out = String(text || '').trim();
    if (out.length <= limit) return out;

    const cut = out.slice(0, limit);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (lastStop > limit * 0.4) return cut.slice(0, lastStop + 1).trim();

    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim().replace(/[,;:]$/, '') + '…';
}

// The call every quote feature should use: generate, clean up, and retry once if
// the model answered in the wrong language. Returns a caption ready to save.
async function generateQuote(opts) {
    const maxChars = opts.maxChars || 500;

    let text = normalizeQuote(await callHuggingFaceChat(opts));

    if (quoteHasNonEnglishScript(text)) {
        // One retry with the instruction restated at the end of the system prompt,
        // where it carries more weight, and with the temperature pulled down.
        const retry = {
            ...opts,
            systemPrompt: opts.systemPrompt +
                '\n\nCRITICAL: Reply in English only. Do not use Chinese, Japanese, ' +
                'Korean, Cyrillic or any non-Latin script anywhere in your answer.',
            temperature: 0.6,
        };
        text = normalizeQuote(await callHuggingFaceChat(retry));

        if (quoteHasNonEnglishScript(text)) {
            throw new Error(
                `Model "${opts.model}" keeps answering in a non-English script. ` +
                `Try a different model, or add a stronger English-only line to the prompt.`
            );
        }
    }

    if (!text) throw new Error('Model returned nothing usable after cleanup.');
    return trimQuoteToLimit(text, maxChars);
}

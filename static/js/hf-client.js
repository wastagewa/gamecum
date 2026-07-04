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

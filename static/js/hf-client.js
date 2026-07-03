// hf-client.js — shared client-side HuggingFace chat-completions caller.
// The server can't reach huggingface.co directly (see chat.js's callChatApi
// comment), so any feature that needs a completion calls this from the browser.
async function callHuggingFaceChat({ token, model, systemPrompt, userMessage, maxTokens = 80, temperature = 0.9 }) {
    if (!token) throw new Error('HuggingFace token not configured on the server.');

    const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
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
        if (res.status === 401) throw new Error('Invalid HuggingFace token. Check it at huggingface.co/settings/tokens.');
        if (res.status === 403) throw new Error(`Access denied for model "${model}". Try a different model or accept its license on HuggingFace.`);
        if (res.status === 503) throw new Error('Model warming up. Please wait ~30 seconds and try again.');
        if (res.status === 429) throw new Error('Rate limited. Wait a moment before trying again.');
        throw new Error(`HuggingFace API error ${res.status}: ${errMsg}`);
    }

    let text;
    try {
        const data = JSON.parse(rawBody);
        text = data.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    } catch (e) {
        throw new Error('Unexpected response format from HuggingFace');
    }
    if (!text) throw new Error('Empty response generated');
    return text;
}

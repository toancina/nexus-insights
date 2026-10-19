/**
 * chatProviders.js — the cloud chat providers (#91). Pure data, used by the
 * main process (services/chatBridge.js) and the Chat page.
 *
 * Ollama, the default, isn't listed: it runs on this PC and the window talks
 * to it directly (services/ollama.js). These run elsewhere, with the user's
 * own API key, through the main process.
 *
 * `baseUrl` null means the user enters it; it is saved, encrypted, with the key.
 */

const PROVIDERS = {
    mistral: {
        id: 'mistral',
        label: 'Mistral',
        baseUrl: 'https://api.mistral.ai/v1',
        defaultModel: 'mistral-small-latest',
        keyUrl: 'https://console.mistral.ai/api-keys',
    },
    openai: {
        id: 'openai',
        label: 'OpenAI-compatible',
        baseUrl: null,          // OpenAI, OpenRouter, Groq, LM Studio…
        defaultModel: null,
        keyUrl: null,
    },
};

module.exports = { PROVIDERS };

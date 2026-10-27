// Fills every llama-server provider in the config with the models of the server's presets,
// and every Strata provider with its loaded model, each with the context one request gets and
// its input modalities, so opencode.json carries only the baseURL and a preset change needs no
// config edit.
//
// A model transform adds the models: a provider transform from a file plugin runs before the
// built-in one that folds in the config's providers, so it never sees them. The first run
// starts one fetch per baseURL without awaiting it, so an unreachable host never delays
// startup; once presets arrive, model.reload() re-runs the transform with the cached list.
// The list is read once per start, so a server started later, or a preset edited, shows
// after a restart.
// A failed fetch goes to console.warn, which OpenCode passes through to stderr only: visible
// with `opencode <command> --print-logs`, absent from opencode.log.
//
// A loaded model reports its slot context (`meta.n_ctx`). For the others the context is
// derived from the preset the way llama-server sizes it (server.cpp, llama-context.cpp,
// n_ctx_slot()): ctx-size padded to 256, divided by parallel unless the KV cache is unified,
// capped by kv-unified-per-slot and by a context_length override. A preset without ctx-size
// uses the training context, which only a loaded model reports; until then the model keeps
// whatever limit the config gives it.
//
// Only router entries from a preset file are listed (`source: "preset"`): --models-dir adds
// every GGUF in the directory, most of them without a tuned preset.
//
// A server without presets may be Strata (github.com/Niko1221/Strata, now Basalt). Its
// /v1/models lists the loaded model with `meta.n_ctx` and its input modalities, plus one entry
// per alias (`alias_of`), which is skipped. It also takes `reasoning_effort`, offered as the
// variants none, low, medium and high; /health's `max_context` covers a restarting engine.
//
// Install: drop this file into ~/.config/opencode/plugins/ and restart. The loader reads
// only the default export, `{ id, setup }`.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * During boot the event loop is busy enough that 100 ms fails a server answering in 40 ms.
 * A second matches OpenCode's own local-provider discovery.
 */
const timeoutMs = 1000;

/**
 * llama-server reports no output limit, yet OpenCode budgets a reply by one and compacts once
 * the input passes context minus that budget (capped at 32,000). A budget of the whole context
 * would leave a 32K preset 768 tokens of input and a 16K preset none, compacting every step.
 */
const outputShare = 4;

const outputCeiling = 65536;

/**
 * Strata refuses a request whose prompt plus max_tokens passes the context (400), where
 * llama-server stops early. Above OpenCode's 32,000 reserve, a prompt just short of compaction
 * plus a full reply would overrun.
 */
const strataOutputCeiling = 32000;

const strataEfforts = ['none', 'low', 'medium', 'high'];

const kvPadding = 256;

/** `--parallel -1`, llama-server's default, means four slots on a unified KV cache. */
const autoParallel = 4;

const pad = tokens => Math.ceil(tokens / kvPadding) * kvPadding;

const truthy = value => ['on', 'enabled', 'true', '1'].includes(String(value).trim().toLowerCase());

const parsePreset = ini => Object.fromEntries((ini ?? '')
    .split('\n')
    .map(line => line.match(/^\s*([\w-]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, value]));

const presetContext = preset => {
    const perSlot = Number(preset['kv-unified-per-slot'] ?? 0);
    const auto = Number(preset.parallel ?? -1) < 0;
    const parallel = auto ? autoParallel : Number(preset.parallel);
    const unified = auto || truthy(preset['kv-unified'] ?? 'false');
    const configured = Number(preset['ctx-size'] ?? 0);
    const size = preset['ctx-size'] === undefined && perSlot > 0 ? parallel * perSlot : configured;

    if (!size) {
        return undefined;
    }

    const pool = pad(size);
    const slot = Math.min(unified ? pool : pad(Math.floor(pool / parallel)), perSlot || Infinity);
    const trained = preset['override-kv']?.match(/(?:^|,)\s*[\w.-]+\.context_length=int:(\d+)/);

    return trained ? Math.min(slot, Number(trained[1])) : slot;
};

const limit = (context, ceiling) => (context ? { context, output: Math.min(ceiling, Math.floor(context / outputShare)) } : undefined);

const fromPreset = entry => ({
    id: entry.id,
    input: entry.architecture?.input_modalities ?? ['text'],
    limit: limit(entry.meta?.n_ctx || presetContext(parsePreset(entry.status?.preset)), outputCeiling),
});

/** While the engine restarts, an entry can report no context; /health keeps the last one. */
const fromStrata = (entry, health) => ({
    id: entry.id,
    input: entry.architecture?.input_modalities ?? ['text'],
    limit: limit(entry.meta?.n_ctx || health.max_context, strataOutputCeiling),
    tools: true,
    variants: strataEfforts.map(effort => ({ id: effort, settings: { reasoningEffort: effort } })),
});

// A LAN name resolves to its IPv6 addresses first, llama-server listens on 0.0.0.0 by
// default, and Bun tries the IPv6 addresses before IPv4: 6 s against a server on this
// machine, far past timeoutMs. Only for plain HTTP: TLS validates the certificate against
// the name, so an https URL keeps it.
const resolve = async href => {
    const url = new URL(href);

    if (url.protocol === 'http:' && !isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
        url.hostname = (await lookup(url.hostname, { family: 4 })).address;
    }

    return url;
};

const trimmed = baseURL => baseURL.replace(/\/+$/, '');

/** dns.lookup takes no signal, and an unknown name takes over a second to fail. */
const within = (signal, promise) => Promise.race([
    promise,
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
]);

const fetchJSON = async (href, apiKey) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(await within(signal, resolve(href)), {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal,
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
};

/** Strata, now Basalt, serves /health beside /v1, without auth. */
const strataModels = async ({ baseURL, apiKey }, entries) => {
    const health = await fetchJSON(`${trimmed(baseURL).replace(/\/v1$/, '')}/health`, apiKey);

    return entries
        .filter(entry => !entry.alias_of && (entry.architecture?.output_modalities ?? ['text']).includes('text'))
        .map(entry => fromStrata(entry, health));
};

const discoverModels = async settings => {
    const entries = (await fetchJSON(`${trimmed(settings.baseURL)}/models`, settings.apiKey)).data ?? [];
    const presets = entries.filter(entry => entry.owned_by === 'llamacpp' && entry.source === 'preset');

    return presets.length ? presets.map(fromPreset) : strataModels(settings, entries);
};

// A v1 `npm` migrates to `aisdk:@ai-sdk/openai-compatible` and the native route rewrites it to
// `@opencode/ai/providers/openai-compatible`; both end the same way. The editor also lists
// catalog providers from models.dev, many of them openai-compatible clouds; their models carry
// a release date, a model from the config does not, so only providers without one are probed.
const servers = editor => editor.provider.list()
    .filter(({ provider, models }) => String(provider.package ?? '').endsWith('openai-compatible')
        && typeof provider.settings?.baseURL === 'string'
        && [...models.values()].every(model => !model.time?.released));

export default {
    id: 'local.llama-limits',
    setup(ctx) {
        /** baseURL -> discovered models, or null while the fetch runs or after it failed. */
        const discovered = new Map();

        const discover = (id, settings) => {
            discovered.set(settings.baseURL, null);
            discoverModels(settings)
                .then(found => {
                    if (found.length) {
                        discovered.set(settings.baseURL, found);

                        return ctx.model.reload();
                    }
                })
                .catch(error => console.warn(`llama-limits: ${id}: ${settings.baseURL} not reachable (${error.message})`));
        };

        return ctx.model.transform(editor => {
            for (const { provider, models } of servers(editor)) {
                const { baseURL } = provider.settings;

                if (!discovered.has(baseURL)) {
                    discover(provider.id, provider.settings);
                }

                for (const model of discovered.get(baseURL) ?? []) {
                    editor.update(provider.id, model.id, draft => {
                        draft.name = models.get(model.id)?.name ?? model.id;
                        draft.capabilities = {
                            ...draft.capabilities,
                            input: model.input,
                            output: ['text'],
                            ...(model.tools ? { tools: true } : {}),
                        };

                        if (model.limit) {
                            draft.limit = { ...draft.limit, ...model.limit };
                        }

                        if (model.variants && !draft.variants?.length) {
                            draft.variants = model.variants;
                        }
                    });
                }
            }
        }).then(registration => registration.dispose);
    },
};

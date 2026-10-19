// Keeps mail on local models. The tools of the commonpost-mail MCP server (Thunderbird) run
// only for a model of a local provider, and a session that has touched mail never sends its
// history to any other provider, whichever agent continues it: switching such a session to
// a cloud model, or compacting it there, fails with an error that says why.
//
// A session counts as touched once a mail tool is called in it, recorded in plugin storage
// so it survives a restart, or when its history holds a mail tool call, which also covers a
// fork. The `mail` agent runs on local models only, even before it has read anything.
//
// The server needs `codemode: false`: Code Mode bundles the tools into `execute`, which the
// per-request tool list cannot strip. Which agents may call which mail tools is up to the
// permissions in opencode.json; this plugin only decides where the data may go.
//
// Install: drop this file into ~/.config/opencode/plugins/ and restart. The loader reads
// only the default export, `{ id, setup }`.

const server = 'commonpost-mail';

const mailAgent = 'mail';

const localProviders = [
    'llama.cpp@',
    'strata@',
];

const isLocal = providerID => localProviders.some(prefix => String(providerID ?? '').startsWith(prefix));

const isMailTool = name => typeof name === 'string' && name.startsWith(`${server}_`);

const holdsMail = messages => messages.some(message => Array.isArray(message.content)
    && message.content.some(part => (part.type === 'tool-call' || part.type === 'tool-result') && isMailTool(part.name)));

const markKey = sessionID => `touched/${sessionID}`;

export default {
    id: 'local.local-only-mail',

    setup: async ctx => {
        // A tool call follows the model response of its own session, so the provider of that
        // session's latest request is the one the call's result will be sent to.
        const providers = new Map();

        const touched = async (sessionID, messages) => holdsMail(messages) || await ctx.storage.get(markKey(sessionID)) === true;

        const refuse = async event => {
            if (event.agent === mailAgent) {
                throw new Error(`local-only-mail: the ${mailAgent} agent runs only on local models (${localProviders.join('…, ')}…). Pick one in the model list.`);
            }

            if (await touched(event.sessionID, event.messages)) {
                throw new Error(`local-only-mail: this session holds mail, which must not reach ${event.model.providerID}. Switch back to a local model (${localProviders.join('…, ')}…), or start a new session.`);
            }
        };

        const registrations = [
            await ctx.session.hook('context', async event => {
                providers.set(event.sessionID, event.model.providerID);

                if (isLocal(event.model.providerID)) {
                    return;
                }

                for (const name of Object.keys(event.tools)) {
                    if (isMailTool(name)) {
                        delete event.tools[name];
                    }
                }

                await refuse(event);
            }),

            // Compaction runs on the session's current model and sends the whole history.
            await ctx.session.hook('compaction', async event => {
                if (!isLocal(event.model.providerID)) {
                    await refuse(event);
                }
            }),

            // A title goes to a small model of the session's provider. Throwing here would only
            // kill a background fiber, so a fixed title replaces the request instead.
            await ctx.session.hook('title', async event => {
                if (isLocal(event.model.providerID)) {
                    return;
                }

                const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined);

                if (session?.agent === mailAgent || await touched(event.sessionID, event.messages)) {
                    event.result = 'Mail';
                }
            }),

            // Throwing refuses this call alone; the model sees the error message.
            await ctx.tool.hook('execute.before', async event => {
                if (!isMailTool(event.tool)) {
                    return;
                }

                const providerID = providers.get(event.sessionID);

                if (!isLocal(providerID)) {
                    throw new Error(`local-only-mail: mail tools run only for local models, not for ${providerID ?? 'an unknown provider'}.`);
                }

                // getMessage and getMessages write attachments to the temp directory, outside
                // what a read-only agent may touch.
                if (event.input?.saveAttachments) {
                    throw new Error('local-only-mail: saveAttachments is not allowed; read the message without it.');
                }

                await ctx.storage.set(markKey(event.sessionID), true);
            }),
        ];

        return async () => {
            await Promise.allSettled(registrations.map(registration => registration.dispose()));
            providers.clear();
        };
    },
};

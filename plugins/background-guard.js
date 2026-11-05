// Guards OpenCode's background subagents (the subagent tool's background=true).
// They run unwatched: a looping one burns tokens until someone notices
// (https://github.com/anomalyco/opencode/issues/45442). This refuses background tasks for
// any agent but explore and the two pr-audit workers, caps concurrency per parent session,
// adds usage rules to the subagent tool's description, and gives build and plan a
// delegation policy in the system prompt, so research is delegated without being asked.
// The policy text is fixed per provider, so every request starts the same and the prompt
// cache holds.
//
// Install: drop this file into a plugins/ directory under an OpenCode config root and
// restart. ~/.config/opencode/plugins/ makes it global, a checkout's .opencode/plugins/
// scopes it to that project.

const tool = 'subagent';

// Per parent session, not per process: switching sessions in the TUI leaves the jobs of the
// one left behind running, so two busy sessions can hold twice this many.
const maxRunning = 20;

// A local server holds few conversations at once. Basalt answers one request at a time
// (parallel defaults to 1, and ai_basalt's start.ps1 keeps it) and parks finished ones in
// RAM, 4 in ai_basalt's preset (conversation-cache-slots); llama-server's default runs 4
// slots (--parallel -1). The main session holds one. A fifth conversation evicts one, and a
// hybrid model then reads that one's history again from the last state the server still holds.
const localMaxRunning = 3;

const localProviders = [
    'llama.cpp@',
    'strata@',
    'basalt@',
];

const isLocal = providerID => localProviders.some(prefix => String(providerID ?? '').startsWith(prefix));

const primaryAgents = new Set([
    'build',
    'plan',
]);

const allowedAgents = new Set([
    'explore',
    'pr-audit-reviewer',
    'pr-audit-verifier',
]);

// A call whose execute.after never fires would hold a slot forever.
const pendingTtlMs = 60_000;

// A child whose end event is missed (subscription dropped) would hold its slot forever.
const runningTtlMs = 60 * 60_000;

const rules = [
    'Background guard (local plugin):',
    '- background=true only with agent explore, for read-only research, or with pr-audit-reviewer and pr-audit-verifier, whose only write is one file under .tmp/. Never for edits or the browser: this window has one Chrome profile, and parallel browser work collides on it.',
    '- When launching, tell the user in one line what started, and track each task as a todo item.',
    '- A result that arrives while others you launched together still run gets a one-line acknowledgment at most. After the last one, give one combined report: the result, then the single next step.',
].join('\n');

// Sizes adapted from Anthropic's multi-agent research system, which puts them in the prompt
// because overinvestment in simple queries "was a common failure mode in our early versions":
// https://www.anthropic.com/engineering/multi-agent-research-system
// Anthropic gives a simple fact one agent; here it stays in the session, as Claude Code's
// docs advise when latency matters.
const policy = [
    'Delegation policy (local plugin):',
    '- Delegate research, web lookups, fact checks, reviews and the exploration of separate areas to background explore agents without being asked. Launch them together in one message, one per independent track, each with a self-contained prompt.',
    '- Scale the number to the task: answer a simple fact yourself, two to four agents for a comparison, five or more with clearly divided tracks for broad research. When the user asks for the maximum, use as many tracks as the work splits into.',
    '- Ask each agent that researches facts to check them against primary sources and mark each one VERIFIED, NOT FOUND or CONTRADICTED, with its URL or file path.',
    '- Keep edits, sequential work and small tasks in this session, and never edit in parallel.',
].join('\n');

const localPolicy = `- This session runs on a local server that holds few conversations at once, so more parallel agents make every one of them slower. This overrides the rules above: delegate only work whose output would crowd this context, at most ${localMaxRunning} at a time.`;

const ended = new Set([
    'session.execution.succeeded',
    'session.execution.failed',
    'session.execution.interrupted',
]);

const isObject = value => typeof value === 'object' && value !== null;

export default {
    id: 'local.background-guard',

    setup: async ctx => {
        // Slot key to { parent, until }. Keyed by the call ID while the call is let through but
        // its result not yet seen, so several background calls in one message cannot all pass
        // the same check; then by the child's session ID, which the result names.
        const slots = new Map();

        // Session to provider, from the session's latest model request.
        const providers = new Map();

        const occupied = parent => {
            const now = Date.now();
            let count = 0;

            for (const [key, slot] of slots) {
                if (slot.until < now) {
                    slots.delete(key);
                } else if (slot.parent === parent) {
                    count += 1;
                }
            }

            return count;
        };

        const registrations = [
            // subagent.ts's per-session context hook appends the agent list to this
            // description rather than replacing it, so the rules reach the model.
            await ctx.tool.transform(editor => editor.update(tool, info => {
                info.description = `${info.description}\n\n${rules}`;
            })),

            await ctx.session.hook('context', event => {
                providers.set(event.sessionID, event.model.providerID);

                if (!primaryAgents.has(event.agent)) {
                    return;
                }

                event.system.push({
                    type: 'text',
                    text: isLocal(event.model.providerID) ? `${policy}\n${localPolicy}` : policy,
                });
            }),

            // Throwing refuses this call alone; the model sees the error message.
            await ctx.tool.hook('execute.before', event => {
                if (event.tool !== tool || !isObject(event.input) || event.input.background !== true) {
                    return;
                }

                const agent = event.input.agent;

                if (!allowedAgents.has(agent)) {
                    throw new Error(`background-guard: background tasks are limited to ${[...allowedAgents].join(', ')}; run this ${agent} task in the foreground (omit background).`);
                }

                const local = isLocal(providers.get(event.sessionID));
                const cap = local ? localMaxRunning : maxRunning;

                if (occupied(event.sessionID) >= cap) {
                    throw new Error(local
                        ? `background-guard: ${cap} background tasks are already running on this local server; wait for one to finish. A foreground task would evict a conversation too.`
                        : `background-guard: ${cap} background tasks are already running in this session; wait for one to finish, or run this task in the foreground (omit background).`);
                }

                slots.set(event.id, {
                    parent: event.sessionID,
                    until: Date.now() + pendingTtlMs,
                });
            }),

            // Also sees a foreground task moved to the background with Ctrl+B: its result
            // carries status running as well, so it counts against the cap from then on.
            // Must never throw: a rejection here is a defect, not a tool error.
            await ctx.tool.hook('execute.after', event => {
                if (event.tool !== tool) {
                    return;
                }

                slots.delete(event.id);

                const metadata = event.status === 'completed' ? event.result?.metadata : undefined;
                const child = metadata?.sessionID;

                if (metadata?.status !== 'running' || typeof child !== 'string') {
                    return;
                }

                slots.set(child, {
                    parent: event.sessionID,
                    until: Date.now() + runningTtlMs,
                });
            }),
        ];

        // A child interrupted for shutdown resumes on the next start, so it keeps its slot.
        // Deletion is idempotent, so duplicate deliveries (#56290) do no harm.
        const controller = new AbortController();

        const listen = async () => {
            try {
                for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                    if (!ended.has(event?.type) || event.data?.reason === 'shutdown') {
                        continue;
                    }

                    slots.delete(event.data?.sessionID);
                }
            } catch {
                // The TTL frees the slots of a dropped subscription.
            }
        };

        listen();

        return async () => {
            controller.abort();
            await Promise.allSettled(registrations.map(registration => registration.dispose()));
            slots.clear();
            providers.clear();
        };
    },
};

// Guards OpenCode's background subagents (the subagent tool's background=true).
// They run unwatched: a looping one burns tokens until someone notices
// (https://github.com/anomalyco/opencode/issues/45442). This refuses background tasks for
// any agent but explore, caps the running ones per parent session, and adds usage rules to
// the subagent tool's description.
//
// Install: drop this file into a plugins/ directory under an OpenCode config root and
// restart. ~/.config/opencode/plugins/ makes it global, a checkout's .opencode/plugins/
// scopes it to that project.

const tool = 'subagent';

// Per parent session, not per process: switching sessions in the TUI leaves the jobs of the
// one left behind running, so two busy sessions can hold twice this many.
const maxRunning = 20;

const allowedAgents = new Set([
    'explore',
]);

// A call whose execute.after never fires would hold a slot forever.
const pendingTtlMs = 60_000;

// A child whose end event is missed (subscription dropped) would hold its slot forever.
const runningTtlMs = 60 * 60_000;

const rules = [
    'Background guard (local plugin):',
    '- background=true only with agent explore, for read-only research. Never for edits or the browser: this window has one Chrome profile, and parallel browser work collides on it.',
    '- Start background tasks only when the user asked for them or approved your proposal.',
    '- When launching, tell the user in one line what started, and track each task as a todo item.',
    '- A result that arrives while others you launched together still run gets a one-line acknowledgment at most. After the last one, give one combined report: the result, then the single next step.',
].join('\n');

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

            // Throwing refuses this call alone; the model sees the error message.
            await ctx.tool.hook('execute.before', event => {
                if (event.tool !== tool || !isObject(event.input) || event.input.background !== true) {
                    return;
                }

                const agent = event.input.agent;

                if (!allowedAgents.has(agent)) {
                    throw new Error(`background-guard: background tasks are limited to ${[...allowedAgents].join(', ')}; run this ${agent} task in the foreground (omit background).`);
                }

                if (occupied(event.sessionID) >= maxRunning) {
                    throw new Error(`background-guard: ${maxRunning} background tasks are already running in this session; wait for one to finish, or run this task in the foreground (omit background).`);
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
        };
    },
};

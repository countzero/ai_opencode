// Keeps a session's todo list in view and lowers todowrite's threshold for a list from three
// steps to two. OpenCode leaves the list where the last todowrite call put it, which drifts
// arbitrarily far back in a long turn. Delete the reminder once upstream lands a fix:
//
//   https://github.com/anomalyco/opencode/issues/41359  (list goes stale mid-task)
//   https://github.com/anomalyco/opencode/issues/27560  (items never marked completed)
//
// Once the list has open items and `staleSteps` model steps pass without a todowrite, the list
// is written as a session instruction entry. OpenCode stores the change as a system message in
// the history before the next step, so the reminder is sent once and stays put: every request
// only extends the one before, and each provider's prompt cache reads it back like the rest of
// the conversation. Anthropic gets it as a native system message, OpenRouter and the local
// llama.cpp, Strata and Basalt servers as a <system-update> user turn.
//
// Measured on 2026-11-04 against the alternatives, on Anthropic, OpenRouter's Anthropic route
// and Basalt:
//   - A reminder rebuilt per request (1.x, and 2.1.0 of this file) evicts the cache. 1.x placed
//     cache markers on the two newest messages, so the conversation stayed cached before the
//     reminder; OpenCode 2 marks only the newest, which is the reminder, and every turn rewrote
//     the conversation (73 % of the context written against 11.5 %). Basalt's hybrid model
//     resumes only from its last state or a checkpoint, so any request that drops text again
//     is read from the system prompt on (223k tokens processed against 44k).
//   - The same text inside a tool result keeps every cache, but Claude reads it as an injection
//     in the tool output and ignores it: no stale list recovered (0 of 7), where a system
//     message brought every one back (4 of 4).
//   - The instruction entry keeps the cache at baseline on all three (11.6 % written; Basalt
//     38.0k processed against 37.4k).
//
// Each reminder shows in the TUI as a notice, "Instructions updated: api/todo". The entry API
// is experimental (ctx.session.instructions); without it the plugin keeps only the convention.
//
// A list left alone through a whole prompt counts as abandoned: its entry is removed, which
// OpenCode states as "no longer applies". So is a list with nothing open. Before a compaction
// the current list is written once more, so it survives the summary.
//
// A list never written gets no reminder, and Plan mode skipped it most: in turns of three or
// more tool steps, build wrote one in 69 of 101 and plan in 23 of 65 (2026-11-02 to 05),
// likely because Plan mode's reminder forbids modifying files. So plan gets a fixed system line
// saying the list is no file, and a build or plan turn that reaches `askSteps` steps without a
// list gets a one-time `todo-start` entry asking for one. The entry is withdrawn once a list is
// written, or at the next prompt.
//
// Needs `"experimental": { "todo": true }` in opencode.json; without the tool it does nothing.
//
// Install: drop this file into ~/.config/opencode/plugins/ and restart. The loader reads
// only the default export, `{ id, setup }`.

const tool = 'todowrite';

// Model steps with tool calls but no todowrite before the list is restated.
const staleSteps = 4;

const entryKey = 'todo';

const askKey = 'todo-start';

// Model steps with tool calls but no list yet before one is asked for. The convention wants the
// list before work starts; one step is left for reading into the task.
const askSteps = 2;

// The tool hooks do not name the agent, so the context hook records it per session.
const primaryAgents = new Set([
    'build',
    'plan',
]);

const openStatuses = new Set([
    'pending',
    'in_progress',
]);

// Appended rather than replacing the built-in "3 or more distinct steps", so a rewording
// upstream cannot silently drop it.
const convention = 'Todo convention (local plugin): any task of more than one step gets a list before work starts. This overrides the step threshold above.';

// Fixed text, so every request of a plan session starts the same and the prompt cache holds.
const planNote = 'Todo convention (local plugin): a task of more than one step gets a list before work starts, in Plan mode too. The todo list is session state, not a plan file, and reading, research and drafting the plan are steps.';

// The reminder number keeps every request distinct, as with the restated list below.
const askText = reminders => `No todo list yet after ${askSteps} steps (todo-state plugin, reminder ${reminders}). The todo convention requires one for any task of more than one step, before work starts, in Plan mode too: write it with todowrite now. A task that really is a single step needs none.`;

const storageKey = sessionID => `todos/${sessionID}`;

const openTodos = todos => (Array.isArray(todos) ? todos : [])
    .filter(todo => typeof todo?.content === 'string' && openStatuses.has(todo.status));

// The reminder number keeps every write distinct: OpenCode drops an entry whose value has not
// changed, so a list restated unchanged after an empty todowrite would otherwise stay silent.
const render = (state, reason) => [
    reason === 'compaction'
        ? `Your todo list, restated by the todo-state plugin before a compaction (reminder ${state.reminders}):`
        : `Your todo list,${state.prompts > 0 ? ' written before the user\'s latest message and' : ''} restated by the todo-state plugin after ${state.steps} steps without an update (reminder ${state.reminders}):`,
    ...state.open.map(todo => `${todo.status}: ${todo.content}`),
    'Update it with todowrite as items finish, unless the user said otherwise.',
].join('\n');

export default {
    id: 'local.todo-state',

    setup: async ctx => {
        const entries = ctx.session.instructions?.entry;
        const sessions = new Map();
        const agents = new Map();
        // IDs of running Code Mode `execute` calls: a tool called inside one shares its ID, and
        // its result goes back to the script, not to the model.
        const executing = new Set();

        const warn = (what, error) => console.warn(`todo-state: could not ${what} (${error?.message ?? error})`);

        const load = async sessionID => {
            if (!sessions.has(sessionID)) {
                const stored = await ctx.storage.get(storageKey(sessionID)).catch(() => undefined);

                sessions.set(sessionID, {
                    open: openTodos(stored?.open),
                    prompts: stored?.prompts ?? 0,
                    reminders: stored?.reminders ?? 0,
                    entry: stored?.entry === true,
                    asked: stored?.asked === true,
                    // A list written in this turn, even one since finished, rules the request out.
                    listed: false,
                    steps: 0,
                    seen: new Set(),
                });
            }

            return sessions.get(sessionID);
        };

        const save = async (sessionID, state) => {
            if (state.open.length === 0 && !state.entry && !state.asked) {
                await ctx.storage.remove(storageKey(sessionID));

                return;
            }

            await ctx.storage.set(storageKey(sessionID), {
                open: state.open,
                prompts: state.prompts,
                reminders: state.reminders,
                entry: state.entry,
                asked: state.asked,
            });
        };

        const restate = async (sessionID, state, reason) => {
            state.reminders += 1;
            await entries.put({ sessionID, key: entryKey, value: render(state, reason) });
            state.entry = true;
            state.seen = new Set();
            await save(sessionID, state);
        };

        const withdraw = async (sessionID, state) => {
            if (state.entry) {
                await entries.remove({ sessionID, key: entryKey });
                state.entry = false;
            }
        };

        const askForList = async (sessionID, state) => {
            state.reminders += 1;
            await entries.put({ sessionID, key: askKey, value: askText(state.reminders) });
            state.asked = true;
            await save(sessionID, state);
        };

        const withdrawAsk = async (sessionID, state) => {
            if (state.asked) {
                await entries.remove({ sessionID, key: askKey });
                state.asked = false;
            }
        };

        const registrations = [
            await ctx.tool.transform(editor => editor.update(tool, info => {
                info.description = `${info.description}\n\n${convention}`;
            })),

            await ctx.session.hook('context', event => {
                agents.set(event.sessionID, event.agent);

                if (event.agent === 'plan') {
                    event.system.push({ type: 'text', text: planNote });
                }
            }),
        ];

        if (entries === undefined) {
            console.warn('todo-state: ctx.session.instructions is missing, so the list is not restated');
        } else {
            registrations.push(
                await ctx.tool.hook('execute.before', event => {
                    if (event.tool === 'execute') {
                        executing.add(event.id);
                    }
                }),

                // Must never throw: a rejection here is a defect, not a tool error.
                await ctx.tool.hook('execute.after', async event => {
                    const nested = event.tool !== 'execute' && executing.has(event.id);

                    if (event.tool === 'execute') {
                        executing.delete(event.id);
                    }

                    if (nested) {
                        return;
                    }

                    try {
                        const state = await load(event.sessionID);

                        // A failed todowrite updates nothing, so it counts as a step like any tool.
                        if (event.tool === tool && event.status === 'completed') {
                            state.open = openTodos(event.input?.todos);
                            state.prompts = 0;
                            state.steps = 0;
                            state.seen = new Set();
                            state.listed = true;
                            await withdrawAsk(event.sessionID, state);

                            if (state.open.length === 0) {
                                await withdraw(event.sessionID, state);
                            }

                            await save(event.sessionID, state);

                            return;
                        }

                        if (state.seen.has(event.messageID)) {
                            return;
                        }

                        if (state.open.length === 0) {
                            if (state.listed || state.asked || !primaryAgents.has(agents.get(event.sessionID))) {
                                return;
                            }

                            state.seen.add(event.messageID);

                            if (state.seen.size >= askSteps) {
                                await askForList(event.sessionID, state);
                            }

                            return;
                        }

                        state.seen.add(event.messageID);
                        state.steps += 1;

                        if (state.seen.size >= staleSteps) {
                            await restate(event.sessionID, state, 'stale');
                        }
                    } catch (error) {
                        warn('restate the todo list', error);
                    }
                }),

                await ctx.session.hook('prompt', async event => {
                    try {
                        const state = await load(event.sessionID);
                        state.listed = false;

                        if (state.asked) {
                            await withdrawAsk(event.sessionID, state);
                            await save(event.sessionID, state);
                        }

                        if (state.open.length === 0) {
                            state.seen = new Set();

                            return;
                        }

                        state.prompts += 1;
                        state.seen = new Set();

                        // Nothing deletes a list the model walked away from, so one left alone
                        // through a whole prompt is dropped rather than restated forever.
                        if (state.prompts > 1) {
                            await withdraw(event.sessionID, state);
                            state.open = [];
                        }

                        await save(event.sessionID, state);
                    } catch (error) {
                        warn('track the prompt', error);
                    }
                }),

                await ctx.session.hook('compaction', async event => {
                    try {
                        const state = await load(event.sessionID);

                        if (state.open.length > 0) {
                            await restate(event.sessionID, state, 'compaction');
                        }
                    } catch (error) {
                        warn('carry the todo list across the compaction', error);
                    }
                }),
            );
        }

        return async () => {
            await Promise.allSettled(registrations.map(registration => registration.dispose()));
        };
    },
};

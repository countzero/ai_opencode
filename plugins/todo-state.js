// Re-states a session's todo list on every step. OpenCode leaves the list where the last
// todowrite call put it, which drifts arbitrarily far back in a long turn; this puts it back
// in view. Delete this part once upstream lands a fix:
//
//   https://github.com/anomalyco/opencode/issues/41359  (list goes stale mid-task)
//   https://github.com/anomalyco/opencode/issues/27560  (items never marked completed)
//
// It also lowers the tool's threshold for a list from three steps to two, a local convention
// that stays when the rest goes.
//
// Needs `"experimental": { "todo": true }` in opencode.json; without the tool it does nothing.
//
// The list is the input of the newest completed todowrite call, as in the TUI's sidebar.
// A compaction summarizes that call away, so every write is also kept in plugin storage,
// which is read only when the call lies before the newest compaction.
//
// Last in the array, after the newest tool result, because a prompt cache keys on an exact
// prefix: there a todo change re-writes only the reminder. A system message, which OpenCode
// lowers per provider, rather than a user message the model would answer. Nothing is
// persisted: the hook edits only the outgoing request.
//
// Install: drop this file into ~/.config/opencode/plugins/ and restart. The loader reads
// only the default export, `{ id, setup }`.

const tool = 'todowrite';

const openStatuses = new Set([
    'pending',
    'in_progress',
]);

// Appended rather than replacing the built-in "3 or more distinct steps", so a rewording
// upstream cannot silently drop it.
const convention = 'Todo convention (local plugin): any task of more than one step gets a list before work starts. This overrides the step threshold above.';

const storageKey = sessionID => `todos/${sessionID}`;

const isWrite = part => part?.type === 'tool' && part.name === tool && part.state?.status === 'completed';

const callsTool = message => Array.isArray(message.content)
    && message.content.some(part => part.type === 'tool-call' && part.name === tool);

const openTodos = todos => (Array.isArray(todos) ? todos : [])
    .filter(todo => typeof todo?.content === 'string' && openStatuses.has(todo.status));

// The newest list in view and the messages after it. Without a write in view, the stored list
// counts only if a compaction took it: a write after the compaction that is gone was reverted.
// Message IDs start with their creation time, so they compare by age.
const latestList = (history, stored) => {
    const index = history.findLastIndex(message => message.type === 'assistant'
        && Array.isArray(message.content) && message.content.some(isWrite));

    if (index !== -1) {
        const write = history[index].content.findLast(isWrite);

        return {
            todos: write.state.input?.todos,
            after: history.slice(index + 1),
        };
    }

    const compaction = history[0];

    if (stored === undefined || compaction?.type !== 'compaction' || !(stored.messageID < compaction.id)) {
        return undefined;
    }

    return {
        todos: stored.todos,
        after: history.slice(1),
    };
};

const render = (open, carried) => [
    carried
        ? 'Your stored todo list, written before the user\'s latest message:'
        : 'Your stored todo list:',
    ...open.map(todo => `${todo.status}: ${todo.content}`),
    'Bookkeeping only: update it with todowrite as items finish.',
    'Your reply is to the user and does not mention this reminder or whether the list matches.',
].join('\n');

export default {
    id: 'local.todo-state',

    setup: async ctx => {
        const registrations = [
            await ctx.tool.transform(editor => editor.update(tool, info => {
                info.description = `${info.description}\n\n${convention}`;
            })),

            // Must never throw: a rejection here is a defect, not a tool error.
            await ctx.tool.hook('execute.after', async event => {
                if (event.tool !== tool || event.status !== 'completed') {
                    return;
                }

                try {
                    const todos = openTodos(event.input?.todos);

                    if (todos.length === 0) {
                        await ctx.storage.remove(storageKey(event.sessionID));
                    } else {
                        await ctx.storage.set(storageKey(event.sessionID), {
                            messageID: event.messageID,
                            todos,
                        });
                    }
                } catch (error) {
                    console.warn(`todo-state: could not store the todo list (${error?.message ?? error})`);
                }
            }),

            await ctx.session.hook('context', async event => {
                if (!(tool in event.tools)) {
                    return;
                }

                try {
                    const inView = event.messages.some(callsTool);
                    const stored = inView ? undefined : await ctx.storage.get(storageKey(event.sessionID));

                    if (!inView && stored === undefined) {
                        return;
                    }

                    const response = await ctx.session.context({ sessionID: event.sessionID });
                    const history = Array.isArray(response) ? response : response?.data ?? [];
                    const list = latestList(history, stored);

                    if (list === undefined) {
                        return;
                    }

                    // Nothing deletes a stored list, so an interrupted task's list outlives the
                    // task: one left alone through a whole reminded turn is abandoned.
                    const prompts = list.after.filter(message => message.type === 'user').length;
                    const open = openTodos(list.todos);

                    if (prompts > 1 || open.length === 0) {
                        return;
                    }

                    event.messages.push({
                        role: 'system',
                        content: [
                            {
                                type: 'text',
                                text: render(open, prompts > 0),
                            },
                        ],
                    });
                } catch (error) {
                    console.warn(`todo-state: could not add the todo list (${error?.message ?? error})`);
                }
            }),
        ];

        return async () => {
            await Promise.allSettled(registrations.map(registration => registration.dispose()));
        };
    },
};

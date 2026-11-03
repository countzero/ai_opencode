// Keeps the local todo convention on the todowrite tool: a list for any task of more than one
// step, one step below the built-in threshold.
//
// It no longer re-states the list on every step. Under OpenCode 2 an injected message costs the
// prompt cache: the Anthropic converter caches the two newest messages, and a block that is
// rebuilt per request leaves nothing to read back, so each turn rewrote the whole conversation
// again. Measured on 2026-11-03 with a fresh todo session against a todo-free one: the cache
// read stayed frozen at the system and tool prefix while every turn wrote 6k to 12k new tokens.
// Over both machines that was 48 % of the context rewritten per turn against 5 % without a
// list, and 3.5x the weekly quota for the same work. Role (system or user) and position (head
// or tail) made no difference.
//
// The list therefore stays where the last todowrite put it, as in 1.x, until the cache handling
// carries a reminder without evicting the conversation. The upstream issues this used to work
// around are still open:
//
//   https://github.com/anomalyco/opencode/issues/41359  (list goes stale mid-task)
//   https://github.com/anomalyco/opencode/issues/27560  (items never marked completed)
//
// Needs `"experimental": { "todo": true }` in opencode.json; without the tool it does nothing.
//
// Install: drop this file into ~/.config/opencode/plugins/ and restart. The loader reads
// only the default export, `{ id, setup }`.

const tool = 'todowrite';

// Appended rather than replacing the built-in "3 or more distinct steps", so a rewording
// upstream cannot silently drop it.
const convention = 'Todo convention (local plugin): any task of more than one step gets a list before work starts. This overrides the step threshold above.';

export default {
    id: 'local.todo-state',

    setup: async ctx => {
        const registration = await ctx.tool.transform(editor => editor.update(tool, info => {
            info.description = `${info.description}\n\n${convention}`;
        }));

        return async () => {
            await registration.dispose();
        };
    },
};

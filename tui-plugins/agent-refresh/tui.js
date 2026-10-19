// Refreshes the agent list when a server plugin reloads its agents after setup. Such a
// reload publishes `agent.updated` without a location: a Promise plugin's calls run on the
// runtime captured at load, which carries no Location service, and the event bus takes the
// location from there. The TUI ignores an `agent.updated` without one, so the list it shows,
// and Tab cycles through, stays stale until a restart. plugins/local-only-mail.js reloads
// this way whenever commonpost-mail connects or disconnects.
//
// Once OpenCode publishes these events with a location, none arrive without one and this
// plugin does nothing; delete it then.
//
// Install: name this directory in the cli.json of an OpenCode config root, then restart:
//
//   { "plugins": ["./tui-plugins/agent-refresh"] }

const id = 'local.agent-refresh';

const setup = ({ data, location }) => data.on('agent.updated', event => {
    // A located event is refreshed by the TUI itself.
    if (event.location) {
        return;
    }

    const ref = location ?? data.location.default();

    data.location.agent.invalidate(ref);
    data.location.agent.sync(ref).catch(() => {});
});

export default {
    id,
    setup,
};

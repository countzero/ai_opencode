// Shows what plugins/retry-heal.js is doing, which OpenCode itself cannot while the plugin
// holds a retry: its retry line appears only after the hook returns (#63813). The window
// title gets a marker with a live countdown, "OC | ↻ #3 in 89s | <title>" for a rate limit
// or server error and "OC | × #12 in 30s | <title>" for the network, and the session view a
// line above the prompt for every session of the shown family that is held or waits to
// continue. Both count down here, so the server writes nothing per second; it sends its
// state over the plugin's RPC event, and the `state` method fills in a TUI that starts
// mid-hold.
//
// The marker goes after the "OC | " that OpenCode puts in front of the session title, so
// tui-plugins/slot-title still prefixes the slot: "[1] OC | ↻ #3 in 89s | <title>".
//
// Install: name this directory in the cli.json of an OpenCode config root, after
// slot-title, then restart:
//
//   { "plugins": ["./tui-plugins/slot-title", "./tui-plugins/retry-heal"] }
//
// It needs plugins/retry-heal.js on the server. The file is tui.tsx, not tui.js: the TUI
// compiles the JSX of a plugin's .tsx entry.

import { createSignal, For, onCleanup, Show } from 'solid-js';

const id = 'local.retry-heal';

const icons = { limit: '↻', offline: '×' };

const titlePrefix = 'OC | ';

// A marker whose countdown ran out this long ago without news is dropped as stale.
const staleMs = 10 * 60_000;

const StatusRpc = {
    id: 'retry-heal',
    methods: {
        state: {
            input: { type: 'object' },
            output: { type: 'object' },
        },
    },
    events: {
        status: { schema: { type: 'object' } },
    },
};

const phaseRank = { hold: 3, continue: 2, retry: 1 };

const describe = status => status.phase === 'continue'
    ? 'turn stopped; continues when the provider answers'
    : status.kind === 'offline'
        ? 'waiting for the network'
        : 'waiting for a free account';

const setup = context => {
    const [statuses, setStatuses] = createSignal({});
    const [now, setNow] = createSignal(Date.now());

    const apply = status => {
        if (!status?.sessionID) {
            return;
        }

        setStatuses(current => {
            const next = { ...current };

            if (status.phase === 'clear') {
                delete next[status.sessionID];
            } else {
                next[status.sessionID] = { ...status, until: Date.now() + (status.inMs ?? 0) };
            }

            return next;
        });
    };

    const seconds = status => Math.max(0, Math.ceil((status.until - now()) / 1000));

    const marker = status => `${icons[status.kind] ?? icons.limit} #${status.count} in ${seconds(status)}s`;

    // Statuses of the family that sessionID belongs to, the most pressing first.
    const family = sessionID => {
        if (!sessionID) {
            return [];
        }

        const root = context.data.session.root(sessionID);

        return Object.values(statuses())
            .filter(status => status.until + staleMs > now() && context.data.session.root(status.sessionID) === root)
            .sort((a, b) => (phaseRank[b.phase] ?? 0) - (phaseRank[a.phase] ?? 0) || (a.sessionID === sessionID ? -1 : 1));
    };

    const currentSession = () => {
        const route = context.ui.router.current();

        return route?.type === 'session' ? route.sessionID : undefined;
    };

    // Same seam as slot-title: the plugin context has no title hook. Wrapping whatever is in
    // place keeps slot-title's prefix when it loaded first.
    const renderer = context.renderer;
    const previous = renderer.setTerminalTitle;
    const send = previous.bind(renderer);

    let requested;
    let shown;

    const render = () => {
        const sessionID = currentSession();
        const top = family(sessionID)[0];

        // OpenCode sets the title only when the route or the session title changes, so after a
        // load mid-session rebuild it the way the TUI writes it (app.tsx).
        if (requested === undefined) {
            const title = sessionID ? context.data.session.get(sessionID)?.title : undefined;

            if (!top || !title) {
                return;
            }

            requested = `${titlePrefix}${title}`;
        }

        let title = requested;

        if (top && requested) {
            title = requested.startsWith(titlePrefix)
                ? `${titlePrefix}${marker(top)} | ${requested.slice(titlePrefix.length)}`
                : `${marker(top)} | ${requested}`;
        }

        // While a marker shows, write every tick: slot-title repeats the last title it was
        // given at each turn boundary, which would freeze the countdown until the next write.
        if (title !== shown || top) {
            shown = title;
            send(title);
        }
    };

    const wrapper = title => {
        requested = title;
        shown = undefined;
        render();
    };

    renderer.setTerminalTitle = wrapper;

    const timer = setInterval(() => {
        setNow(Date.now());
        render();
    }, 1000);

    const stopEvents = context.data.on('rpc.retry-heal.status', event => apply(event.data));

    context.client.rpc(StatusRpc).state({})
        .then(result => result?.held?.forEach(status => apply({ ...status, inMs: (status.inMs ?? 0) - (Date.now() - status.at) })))
        .catch(() => {});

    const theme = context.theme;
    const color = theme.text?.feedback?.warning?.base ?? theme.text?.base;

    const Banner = props => {
        const lines = () => family(props.sessionID).filter(status => status.phase !== 'retry' || status.sessionID !== props.sessionID);

        return (
            <Show when={lines().length > 0}>
                <box paddingLeft={3} flexDirection="column">
                    <For each={lines()}>
                        {status => (
                            <text fg={color}>
                                {marker(status)} · {status.label} · {describe(status)}
                                {status.sessionID === props.sessionID ? '' : ` · ${context.data.session.get(status.sessionID)?.title ?? status.sessionID}`}
                            </text>
                        )}
                    </For>
                </box>
            </Show>
        );
    };

    const unslot = context.ui.slot({
        append: 'session.composer.top',
        render: input => <Banner sessionID={input.sessionID} />,
    });

    return () => {
        clearInterval(timer);
        stopEvents();
        unslot();

        // Whoever wrapped over this one owns the property now.
        if (renderer.setTerminalTitle === wrapper) {
            renderer.setTerminalTitle = previous;
        }

        if (requested !== undefined) {
            send(requested);
        }
    };
};

export default {
    id,
    setup,
};

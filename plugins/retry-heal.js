// Keeps Anthropic sessions alive through rate limits and network outages instead of letting
// them die after OpenCode's 10 retries. Built for a Claude subscription that
// switch_claude_account (`sca monitor`) rotates between accounts and opencode-claude-auth
// sends; tui-plugins/retry-heal/ shows its state in the window title and above the prompt.
//
// The first 5 retries wait a fixed 90 s, whatever retry-after says: a subscription 429 asks
// for the time until that account's window resets, but sca rotates to a free account within
// one 60 s poll, and opencode-claude-auth re-reads .credentials.json on a 429. Network errors
// and timeouts keep OpenCode's own schedule, which reconnects within 2–30 s.
//
// From the 6th retry on, the retry hook holds instead of spending the rest of the budget,
// which is a hard limit of 10 per model call and is spent before the hook is asked (#54862).
// Every 90 s one probe for all held sessions replays a held session's last request with
// max_tokens 1, sent with the token now in .credentials.json; only a 2xx releases. A network
// hold probes with a HEAD request instead. Also releasing: sca switching its active slot,
// the retry-after deadline passing, and the user typing. Released sessions go 15 s apart, so
// a freed account does not take the whole burst at once. OpenCode shows no retry line while
// a hook is pending (#63813); the TUI part fills that gap.
//
// A turn that fails anyway is continued with a synthetic message once the same signals say
// the provider answers again, at most 5 times in a row per session. A subagent's parent is
// told in an instructions entry, as soon as the child holds, that the child resumes on its
// own, so it does not relaunch it.
//
// A hold only blocks a running turn: it ends on every end of the execution, on deletion, on
// unload and after 6 h. Interrupting abandons the hook without cancelling it (Effect.promise
// passes no signal), so the end events stop it here.
//
// Install: drop this file into ~/.config/opencode/plugins/. The loader reads only the
// default export, `{ id, setup }`.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const providerID = 'anthropic';

const visibleRetries = 5;

const visibleDelayMs = 90_000;

const probeIntervalMs = 90_000;

const probeTimeoutMs = 120_000;

const networkTimeoutMs = 15_000;

const tickMs = 5_000;

const holdLimitMs = 6 * 60 * 60_000;

const releaseGapMs = 15_000;

const maxContinues = 5;

const networkURL = 'https://api.anthropic.com/';

// The account or the provider decides when these can succeed again.
const limitTypes = new Set(['provider.rate-limit', 'provider.quota', 'provider.internal']);

const networkTypes = new Set(['provider.transport', 'provider.timeout']);

const kindOf = error => limitTypes.has(error?.type) ? 'limit' : networkTypes.has(error?.type) ? 'offline' : undefined;

const labelOf = error => {
    if (error?.status) {
        return String(error.status);
    }

    if (error?.type === 'provider.timeout' || /timed? ?out/i.test(error?.message ?? '')) {
        return 'timeout';
    }

    return kindOf(error) === 'offline' ? 'offline' : error?.type ?? 'error';
};

const ended = new Set([
    'session.execution.succeeded',
    'session.execution.failed',
    'session.execution.interrupted',
    'session.deleted',
]);

// Shared by every location's instance and kept across reloads: one probe per process, one
// release queue, and the status the TUI asks for when it connects mid-hold. No ctx in here.
const shared = globalThis[Symbol.for('local.retry-heal')] ??= {
    probe: undefined,
    probed: { at: 0, result: undefined },
    nextRelease: 0,
    status: new Map(),
};

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

const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

const readJson = async name => {
    try {
        return JSON.parse(await readFile(join(configDir(), name), 'utf8'));
    } catch {
        // Missing, or mid-rename by sca or Claude Code: the next tick reads it again.
        return undefined;
    }
};

// opencode-claude-auth reads the same file and token shape. A token about to expire is left
// to it: refreshing here would rotate the refresh token under sca's saved slot.
const fileToken = async () => {
    const data = await readJson('.credentials.json');
    const oauth = data?.claudeAiOauth ?? data;

    if (typeof oauth?.accessToken !== 'string' || (oauth.expiresAt ?? Infinity) <= Date.now() + 60_000) {
        return undefined;
    }

    return oauth.accessToken;
};

const activeSlot = async () => (await readJson('.sca-state.json'))?.active_slot;

const sleep = (ms, signal) => new Promise(resolve => {
    if (signal.aborted) {
        resolve();
        return;
    }

    const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
    };

    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener('abort', done, { once: true });
});

const reachable = async () => {
    try {
        const response = await fetch(networkURL, { method: 'HEAD', signal: AbortSignal.timeout(networkTimeoutMs) });
        await response.body?.cancel().catch(() => {});
        return true;
    } catch {
        return false;
    }
};

// The real request, cut to one output token. A 400 or 401 says nothing about the limit, so
// only a 2xx counts as free; anything else leaves the release to the other signals.
const replay = async request => {
    let text;

    try {
        text = await request.clone().text();
    } catch {
        return { state: 'unknown' };
    }

    try {
        const body = JSON.parse(text);
        const budget = body?.thinking?.budget_tokens;

        body.max_tokens = typeof budget === 'number' ? budget + 1 : 1;
        body.stream = false;
        text = JSON.stringify(body);
    } catch {
        return { state: 'unknown' };
    }

    const headers = new Headers(request.headers);
    const token = await fileToken();

    headers.delete('content-length');

    if (token) {
        headers.set('authorization', `Bearer ${token}`);
    }

    let response;

    try {
        response = await fetch(request.url, {
            method: request.method,
            headers,
            body: text,
            signal: AbortSignal.timeout(probeTimeoutMs),
        });
    } catch {
        return { state: 'offline' };
    }

    await response.body?.cancel().catch(() => {});

    if (response.ok) {
        return { state: 'free' };
    }

    if (response.status === 429 || response.status >= 500) {
        return { state: 'limited', label: String(response.status) };
    }

    return { state: 'unknown', label: String(response.status) };
};

// One probe at a time for the whole process, its result shared for half an interval.
const probe = async (kind, request) => {
    const fresh = shared.probed.result?.kind === kind && Date.now() - shared.probed.at < probeIntervalMs / 2;

    if (fresh) {
        return shared.probed.result;
    }

    shared.probe ??= (async () => {
        try {
            const result = kind === 'offline' || !request
                ? { state: await reachable() ? 'free' : 'offline' }
                : await replay(request);

            shared.probed = { at: Date.now(), result: { ...result, kind } };
            return shared.probed.result;
        } finally {
            shared.probe = undefined;
        }
    })();

    return shared.probe;
};

const releaseSlot = () => {
    const at = Math.max(Date.now(), shared.nextRelease);

    shared.nextRelease = at + releaseGapMs;
    return at;
};

const instructionKey = 'retry-heal';

export default {
    id: 'local.retry-heal',

    setup: async ctx => {
        // Session ID to { request, attempt, probes, controller, parentID }.
        const sessions = new Map();

        // Parent session ID to Map of held child ID to title.
        const heldChildren = new Map();

        const running = new Set();

        const continuing = new Set();

        const controller = new AbortController();

        const entry = id => {
            let session = sessions.get(id);

            if (!session) {
                session = { attempt: 0, probes: 0 };
                sessions.set(id, session);
            }

            return session;
        };

        let registration;

        const publish = status => {
            if (status.phase === 'clear') {
                if (!shared.status.delete(status.sessionID)) {
                    return;
                }
            } else {
                shared.status.set(status.sessionID, { ...status, at: Date.now() });
            }

            registration?.events.emit('status', status).catch(() => {});
        };

        const sessionInfo = sessionID => ctx.session.get({ sessionID }).catch(() => undefined);

        const writeParentNote = async parentID => {
            const children = heldChildren.get(parentID);

            try {
                if (!children?.size) {
                    heldChildren.delete(parentID);
                    await ctx.session.instructions.entry.remove({ sessionID: parentID, key: instructionKey });
                    return;
                }

                const list = [...children].map(([id, title]) => `- ${id}${title ? ` (${title})` : ''}`).join('\n');

                await ctx.session.instructions.entry.put({
                    sessionID: parentID,
                    key: instructionKey,
                    value: [
                        'These subagents stopped on a provider rate limit or network error. The retry-heal plugin holds them and resumes them on its own once the provider answers again; each sends another report when it finishes. Do not relaunch them, and do not treat their error report as final:',
                        list,
                    ].join('\n'),
                });
            } catch {
                // The entry API is experimental; without it the parent only lacks the hint.
            }
        };

        const markChild = async (sessionID, held) => {
            const session = sessions.get(sessionID);

            if (held && session && session.parentID === undefined) {
                const info = await sessionInfo(sessionID);

                session.parentID = info?.parentID ?? null;
                session.title = info?.title;
            }

            const parentID = session?.parentID;

            if (!parentID) {
                return;
            }

            const children = heldChildren.get(parentID) ?? new Map();
            const changed = held ? !children.has(sessionID) : children.delete(sessionID);

            if (held) {
                children.set(sessionID, session.title);
            }

            heldChildren.set(parentID, children);

            if (changed) {
                await writeParentNote(parentID);
            }
        };

        const forget = sessionID => {
            const session = sessions.get(sessionID);

            session?.controller?.abort();
            sessions.delete(sessionID);
            publish({ sessionID, phase: 'clear' });
            void markChild(sessionID, false);
        };

        // Waits for a sign that a retry can work. Resolves 'free', or 'aborted' when the
        // execution ended, the user typed (`input`), or the hold ran out.
        const hold = async (sessionID, kind, error, phase) => {
            const session = entry(sessionID);
            const own = new AbortController();
            const signal = AbortSignal.any([own.signal, controller.signal]);
            const started = Date.now();
            const deadline = kind === 'limit' && error?.retryAfterMs > 0 ? started + error.retryAfterMs + 5_000 : undefined;
            const slot = await activeSlot();

            session.controller?.abort();
            session.controller = own;
            session.input = false;
            await markChild(sessionID, true);

            let label = labelOf(error);
            let nextProbe = started + probeIntervalMs;
            let checked = started;

            const show = until => publish({
                sessionID,
                phase,
                kind,
                label,
                count: Math.max(0, session.attempt - 1) + session.probes,
                inMs: Math.max(0, until - Date.now()),
            });

            show(nextProbe);

            try {
                while (!signal.aborted) {
                    if (Date.now() - started > holdLimitMs) {
                        return 'aborted';
                    }

                    if (session.input) {
                        return phase === 'hold' ? 'free' : 'aborted';
                    }

                    if ((deadline && Date.now() >= deadline) || (slot !== undefined && await activeSlot() !== slot)) {
                        break;
                    }

                    // A summary forked into the background can retry on an idle session.
                    if (phase === 'hold' && Date.now() - checked >= 15_000) {
                        checked = Date.now();

                        const idle = (await sessionInfo(sessionID))?.time?.idle;

                        if (typeof idle === 'number' && idle > started) {
                            return 'aborted';
                        }
                    }

                    if (Date.now() >= nextProbe) {
                        session.probes += 1;

                        const result = await probe(kind, session.request);

                        if (result.label) {
                            label = result.label;
                        }

                        if (result.state === 'free') {
                            break;
                        }

                        nextProbe = Date.now() + probeIntervalMs;
                        show(nextProbe);
                    }

                    await sleep(Math.min(tickMs, nextProbe - Date.now()), signal);
                }

                if (signal.aborted) {
                    return 'aborted';
                }

                const at = releaseSlot();

                if (at > Date.now()) {
                    show(at);
                    await sleep(at - Date.now(), signal);
                }

                return signal.aborted ? 'aborted' : 'free';
            } finally {
                if (session.controller === own) {
                    session.controller = undefined;
                }
            }
        };

        const onRetry = async event => {
            const kind = kindOf(event.error);

            if (!kind) {
                return;
            }

            const session = entry(event.sessionID);
            const retry = event.attempt - 1;

            if (event.attempt < session.attempt) {
                session.probes = 0;
            }

            session.attempt = event.attempt;

            if (kind === 'limit' && retry <= visibleRetries) {
                event.decision = { retry: true, delay: visibleDelayMs };
            }

            // A timeout past OpenCode's cap of 3 stays refused: each one already waited minutes.
            if (kind === 'offline' && !event.decision.retry) {
                return;
            }

            if (retry <= visibleRetries || !running.has(event.sessionID)) {
                if (event.decision.retry) {
                    publish({ sessionID: event.sessionID, phase: 'retry', kind, label: labelOf(event.error), count: retry + session.probes, inMs: event.decision.delay });
                }

                return;
            }

            const outcome = await hold(event.sessionID, kind, event.error, 'hold');

            event.decision = outcome === 'free' ? { retry: true, delay: 0 } : { retry: false };
            publish({ sessionID: event.sessionID, phase: 'clear' });
        };

        const continueKey = sessionID => `continues/${sessionID}`;

        const onFailed = async (sessionID, error) => {
            const kind = kindOf(error);
            const session = sessions.get(sessionID);

            if (!kind || !session || continuing.has(sessionID)) {
                forget(sessionID);
                return;
            }

            const count = (await ctx.storage.get(continueKey(sessionID)).catch(() => undefined) ?? 0) + 1;

            if (count > maxContinues) {
                forget(sessionID);
                return;
            }

            continuing.add(sessionID);

            try {
                const outcome = await hold(sessionID, kind, error, 'continue');

                if (outcome !== 'free') {
                    return;
                }

                await ctx.storage.set(continueKey(sessionID), count);
                publish({ sessionID, phase: 'clear' });
                await markChild(sessionID, false);
                await ctx.session.synthetic({
                    sessionID,
                    description: 'retry-heal: provider is back, continuing',
                    text: `Your previous turn stopped on a provider error (${labelOf(error)}) after its retries ran out. The provider answers again: continue the task where you left off. Subagents that stopped the same way are resumed automatically; do not relaunch them.`,
                });
            } catch {
                forget(sessionID);
            } finally {
                continuing.delete(sessionID);
            }
        };

        // Without the RPC the TUI shows nothing, but the retries still heal.
        registration = await ctx.rpc.register(StatusRpc, {
            state: async () => ({ held: [...shared.status.values()] }),
        }).catch(() => undefined);

        const registrations = [
            // Throwing would kill the step (Effect.promise turns a rejection into a defect).
            await ctx.session.hook('retry', async event => {
                try {
                    await onRetry(event);
                } catch {
                    publish({ sessionID: event.sessionID, phase: 'clear' });
                }
            }, { providerID }),

            // event.request is the request as sent, after opencode-claude-auth rewrote it; its
            // body is unread, because OpenCode sends a copy of a replaced request.
            await ctx.session.hook('http.response', event => {
                if (event.kind !== 'primary') {
                    return;
                }

                entry(event.sessionID).request = event.request;

                if (event.response.ok) {
                    publish({ sessionID: event.sessionID, phase: 'clear' });
                }
            }, { providerID }),
        ];

        if (registration) {
            registrations.push(registration);
        }

        const listen = async () => {
            try {
                const types = ['session.execution.started', 'session.inbox.enqueued', ...ended];

                for await (const event of ctx.event.subscribe({ types, signal: controller.signal })) {
                    const sessionID = event?.data?.sessionID;

                    if (!sessionID) {
                        continue;
                    }

                    if (event.type === 'session.execution.started') {
                        running.add(sessionID);
                        continue;
                    }

                    if (event.type === 'session.inbox.enqueued') {
                        const session = sessions.get(sessionID);

                        if (session && event.data.item?.type === 'user') {
                            session.input = true;
                        }

                        continue;
                    }

                    running.delete(sessionID);

                    if (event.type === 'session.execution.failed') {
                        sessions.get(sessionID)?.controller?.abort();
                        void onFailed(sessionID, event.data.error);
                        continue;
                    }

                    if (event.type === 'session.execution.succeeded') {
                        await ctx.storage.remove(continueKey(sessionID)).catch(() => {});
                    }

                    // A shutdown resumes the turn on the next start, so its state goes with it.
                    forget(sessionID);
                }
            } catch {
                // Holds still end on their own limit and on unload.
            }
        };

        listen();

        return async () => {
            controller.abort();
            await Promise.allSettled(registrations.map(item => item.dispose()));

            for (const sessionID of sessions.keys()) {
                publish({ sessionID, phase: 'clear' });
            }

            sessions.clear();
            running.clear();
        };
    },
};

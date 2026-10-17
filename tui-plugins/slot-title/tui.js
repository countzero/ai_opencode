// Prefixes the terminal title with this window's slot, so several OpenCode windows sharing
// one taskbar can be told apart. The slot is the chrome-devtools MCP profile number that
// scripts/opencode.ps1 claims and hands down as CHROME_SLOT. The TUI and its private server
// both inherit the launcher's environment, so process.env is the source; no config to read.
//
// Install: name this directory in the cli.json of an OpenCode config root, then restart:
//
//   { "plugins": ["./tui-plugins/slot-title"] }
//
// The path resolves against the cli.json that declares it and must name the directory, not
// a file. The TUI loads a directory's `tui` entry, hence tui.js: an index.js would be taken
// as the server entry.

const id = 'local.slot-title';

/** Registry-global, so the guard survives a reload re-evaluating this module; a module-local WeakSet would not. */
const marker = Symbol.for(id);

/** What upstream puts on the home route, and so the honest placeholder until it names a session. */
const homeTitle = 'OpenCode';

/**
 * Fires at both ends of a turn, which repairs a title promptly without writing one per token.
 * Upstream writes a title only when the route or the session title changes, never to repair
 * one that other output has overwritten.
 */
const turnBoundary = 'session.status';

/**
 * Uncovers the method the patch hid.
 *
 * `setTerminalTitle` is `CliRenderer.prototype`'s, so patching it added an own property;
 * deleting that property restores the prototype lookup, where assigning the bound original
 * back would leave a bound copy shadowing it forever. A descriptor is only present when
 * another plugin patched first, and then it holds that plugin's wrapper rather than the
 * prototype method.
 */
const restore = (renderer, descriptor) => {
    if (descriptor) {
        Object.defineProperty(renderer, 'setTerminalTitle', descriptor);

        return;
    }

    delete renderer.setTerminalTitle;
};

const setup = ({ renderer, data }) => {
    const slot = process.env.CHROME_SLOT?.trim();

    // Started without the launcher, or with every slot taken: nothing honest to show.
    if (!/^\d+$/.test(slot ?? '') || renderer.setTerminalTitle[marker]) {
        return undefined;
    }

    const descriptor = Object.getOwnPropertyDescriptor(renderer, 'setTerminalTitle');
    const original = renderer.setTerminalTitle.bind(renderer);

    let requestedTitle = homeTitle;

    const wrapper = title => {
        requestedTitle = title;

        // An empty title is how upstream clears it, on shutdown and from the
        // "terminal.title.toggle" command; prefixing would strand the slot on the tab.
        original(title ? `[${slot}] ${title}` : title);
    };

    wrapper[marker] = true;

    // The plugin context offers no title hook, so the renderer's own method is the only seam.
    renderer.setTerminalTitle = wrapper;
    wrapper(homeTitle);

    const unsubscribe = data.on(turnBoundary, () => wrapper(requestedTitle));

    return () => {
        unsubscribe();

        // Whoever wrapped over this one owns the property now.
        if (renderer.setTerminalTitle === wrapper) {
            restore(renderer, descriptor);
        }
    };
};

export default {
    id,
    setup,
};

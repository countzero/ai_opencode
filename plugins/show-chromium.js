// Shows this window's chrome-devtools Chromium when it starts hidden. Puppeteer launches it
// with windowsHide: true, and Chromium does not always show its window again, most often
// after a previous run that ended as a crash, which OpenCode's taskkill /F makes the rule.
//
// Whenever a chrome-devtools call finds a browser this plugin has not shown yet, the first or
// one the MCP relaunched, and after every new_page, this runs scripts/show-chromium.ps1 for
// the slot in CHROME_SLOT: it shows hidden windows, restores minimized ones and moves those
// off every screen onto the primary one, all without taking the focus. Other calls cost one
// process check. Windows only, and only in a window started through scripts/opencode.ps1.
//
// Install: drop this file into plugins/ and show-chromium.ps1 into scripts/ of an OpenCode
// config root and restart.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/show-chromium.ps1', import.meta.url));

/** Opens a window of its own, which can start hidden like the first. */
const newPage = 'chrome-devtools_new_page';

/** Signal 0 only tests the process; EPERM means it exists under another account. */
const alive = pid => {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
};

export default {
    id: 'local.show-chromium',

    setup: async ctx => {
        const slot = process.env.CHROME_SLOT?.trim();

        if (process.platform !== 'win32' || !/^\d+$/.test(slot ?? '')) {
            return () => {};
        }

        // The browser process last shown; a relaunch ends it, so the next call shows the new one.
        let browser;
        let running = false;
        let again = false;

        const show = () => {
            running = true;

            execFile('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', script, slot], { windowsHide: true }, (error, stdout) => {
                running = false;
                browser = Number.parseInt(stdout, 10) || undefined;

                if (error) {
                    console.warn(`show-chromium: slot ${slot}: ${error.message}`);
                }

                if (again) {
                    again = false;
                    show();
                }
            });
        };

        const registration = await ctx.tool.hook('execute.after', event => {
            if (event.status !== 'completed' || !event.tool.startsWith('chrome-devtools_')) {
                return;
            }

            if (event.tool !== newPage && browser && alive(browser)) {
                return;
            }

            if (running) {
                again = true;

                return;
            }

            show();
        });

        return () => registration.dispose();
    },
};

// Shows this window's chrome-devtools Chromium when it starts hidden. Puppeteer launches it
// with windowsHide: true, and Chromium does not always show its window again, most often
// after a previous run that ended as a crash, which OpenCode's taskkill /F makes the rule.
//
// After a session's first chrome-devtools call, and after every new_page, this runs
// scripts/show-chromium.ps1 for the slot in CHROME_SLOT. Windows only, and only in a window
// started through scripts/opencode.ps1.
//
// Install: drop this file into plugins/ and show-chromium.ps1 into scripts/ of an OpenCode
// config root and restart.

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/show-chromium.ps1', import.meta.url));

export default {
    id: 'local.show-chromium',

    setup: async ctx => {
        const slot = process.env.CHROME_SLOT?.trim();

        if (process.platform !== 'win32' || !/^\d+$/.test(slot ?? '')) {
            return () => {};
        }

        const sessions = new Set();

        const registration = await ctx.tool.hook('execute.after', event => {
            if (event.status !== 'completed' || !event.tool.startsWith('chrome-devtools_')) {
                return;
            }

            if (sessions.has(event.sessionID) && event.tool !== 'chrome-devtools_new_page') {
                return;
            }

            sessions.add(event.sessionID);
            execFile('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', script, slot], { windowsHide: true }, error => {
                if (error) {
                    console.warn(`show-chromium: slot ${slot}: ${error.message}`);
                }
            });
        });

        return () => registration.dispose();
    },
};

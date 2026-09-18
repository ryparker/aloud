"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAppleScript = runAppleScript;
const constants_1 = require("../constants");
const debug_1 = require("../debug");
const child_process_1 = require("child_process");
const debug = debug_1.base.extend("osascript");
async function runAppleScript(script, { timeout = constants_1.DEFAULT_TIMEOUT } = { timeout: constants_1.DEFAULT_TIMEOUT }) {
    const appleScriptTimeoutMs = Math.max(1, Math.ceil(timeout / 1000));
    const scriptWithTimeout = `with timeout of ${appleScriptTimeoutMs} seconds\n${script}\nend timeout`;
    debug("execute", { scriptWithTimeout });
    return (await new Promise((resolve, reject) => {
        const child = (0, child_process_1.execFile)("/usr/bin/osascript", [], {
            maxBuffer: constants_1.DEFAULT_MAX_BUFFER,
            timeout,
        }, (error, stdout) => {
            if (error) {
                debug("failed", { error });
                return reject(error);
            }
            debug("completed");
            if (!stdout) {
                return resolve();
            }
            else {
                return resolve(stdout.trim());
            }
        });
        debug("process started", { pid: child.pid });
        child.stdin.write(scriptWithTimeout);
        child.stdin.end();
        debug("script written");
    }));
}

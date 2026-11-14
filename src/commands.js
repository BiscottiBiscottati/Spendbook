/**
 * Spendbook slash commands.
 *
 * The ledger is reachable from the chat bar, not only from the settings drawer.
 * Registration is a wiring seam: the entry module hands SillyTavern's parser and
 * command class in, so the parser's own stack scan attributes the commands to
 * Spendbook. Each callback reads the same snapshot the drawer does and returns
 * the text it showed, so a command can also be piped.
 *
 * No command changes whether observation is on. That stays the drawer's tracking
 * toggle, and this module is given no way to flip it.
 */

import { describeUsageReport } from '../ui/view.js';

const HELP = Object.freeze({
    status: 'Show Spendbook tracking state, observer health, this chat’s summary, '
        + 'the all-time summary and the current measurement run. Read-only.',
    run: 'Start a measurement run in the open chat.',
    export: 'Download Spendbook’s JSON export of the open chat. Never includes chat names.',
});

/**
 * Register Spendbook's three commands on SillyTavern's parser.
 *
 * @param {object} options
 * @param {{addCommandObject: (command: object) => void}|null} options.parser
 *   SillyTavern's `SlashCommandParser`, from `getContext()`.
 * @param {{fromProps: (props: object) => object}|null} options.commandClass
 *   SillyTavern's `SlashCommand`, from `getContext()`.
 * @param {() => object} options.getSnapshot Reads the ledger and observer state;
 *   the same snapshot the drawer mounts with.
 * @param {(options: {includeChatNames: boolean}) => ({fileName: string, content: string}|null)} options.getExport
 *   Builds the export file. The command asks for one with chat names off.
 * @param {() => (object|null)} options.startRun Starts a run in the open chat and
 *   returns it, or null when there is no chat.
 * @param {() => void} options.refresh Repaints the drawer, so the run bar shows a
 *   run started from the chat bar without a reload.
 * @param {(fileName: string, content: string) => (boolean|void)} options.saveFile
 *   Saves the export with the same download the drawer button uses; false means
 *   this browser cannot start one.
 * @param {(text: string) => void} options.notify Shows a command's text where
 *   the chat bar's output would be read.
 * @returns {object[]} The commands registered, or an empty list when SillyTavern
 *   has no parser to register with.
 */
export function registerSpendbookCommands({
    parser = null,
    commandClass = null,
    getSnapshot,
    getExport,
    startRun,
    refresh,
    saveFile,
    notify,
} = {}) {
    if (!parser || typeof parser.addCommandObject !== 'function'
        || !commandClass || typeof commandClass.fromProps !== 'function') {
        console.warn('Spendbook: SillyTavern’s slash-command parser is unavailable; commands not registered.');
        return [];
    }

    const status = () => {
        const report = describeUsageReport(getSnapshot());
        notify(report);
        return report;
    };

    const run = () => {
        const started = startRun();
        if (!started) {
            const message = 'No chat is open — open a chat before starting a run.';
            notify(message);
            return message;
        }

        // The run bar reads the ledger on refresh, and a command is not a
        // reload: without this repaint the new run exists but is not shown.
        refresh();
        const message = `Started run “${started.label}”.`;
        notify(message);
        return message;
    };

    const exportChat = () => {
        // `includeChatNames: false` is not a default here: the command must never
        // be the path a chat name leaves the browser, even with the opt-in on.
        const file = getExport({ includeChatNames: false });
        if (!file) return '';

        const saved = saveFile(file.fileName, file.content);
        const message = saved === false
            ? `Could not download ${file.fileName} in this browser.`
            : `Exported ${file.fileName}.`;
        notify(message);
        return message;
    };

    const commands = [
        commandClass.fromProps({
            name: 'spendbook',
            callback: status,
            helpString: HELP.status,
        }),
        commandClass.fromProps({
            name: 'spendbook-run',
            callback: run,
            helpString: HELP.run,
        }),
        commandClass.fromProps({
            name: 'spendbook-export',
            callback: exportChat,
            helpString: HELP.export,
        }),
    ];

    for (const command of commands) parser.addCommandObject(command);
    return commands;
}

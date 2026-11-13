/**
 * Spendbook message text.
 *
 * How one request message's content is flattened to text. The prompt-token
 * estimate reads a message through this function, so the number always
 * reflects what the message actually says. No text is stored.
 */

/**
 * Flattens a request message's content to its text parts.
 *
 * @param {{content?: string|object[]}} message
 * @returns {string}
 */
export function messageText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part?.text === 'string' ? part.text : ''))
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

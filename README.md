# Suggest Revision v0.1.2

A standalone SillyTavern extension for targeted revision of an assistant response. **Minimal** is the default: the model is asked to change only what your suggestion requires and copy unaffected text verbatim. The complete revised reply becomes a new active swipe; the original stays recoverable.

## Install

Copy this folder's `manifest.json`, `index.js`, `revision.js`, and `style.css` directly into `public/scripts/extensions/third-party/suggest-revision/` in your actual SillyTavern installation, then reload. No build, npm install, or separate API key is needed. This workspace is an extension source workspace, not the running SillyTavern installation. Persona Reply can remain installed separately.

Click the compact circular-arrow icon in an assistant message's main action row. Read the original, enter your correction, choose Minimal/Moderate/Rewrite freely, then click Suggest. Cancel leaves everything untouched. Use normal swipe controls to recover earlier versions. Older assistant messages are supported; editing an older response does not regenerate downstream messages.

Extensions → Suggest Revision saves your default strength and maximum output token allowance. Set enough output tokens for the entire response. Suggestions are not saved in settings or message metadata.

## Integration and compatibility

Inspected official SillyTavern `release` source on October 2, 2026:

- [Context API](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/st-context.js): `SillyTavern.getContext()`, extension settings, popup, token counting, raw generation, message rendering, saving and events.
- [Native generation and swipe structure](https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js): `generateRaw`, `saveReply`, `ensureSwipes`, `updateMessageBlock`.
- [Native popups](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/popup.js).

Requires a recent SillyTavern exposing these APIs; older versions are not verified. No core files are modified. Message action insertion uses `.mes`, `mesid`, and `.mes_buttons` and observes lazy rendering. This DOM coupling may need adjustment after upstream UI changes.

There is no exposed dedicated append-swipe API. The extension appends native `swipes`/`swipe_info`, retains the active original and metadata, selects the appended version, rerenders through `updateMessageBlock`, refreshes swipe controls, saves, and emits `MESSAGE_SWIPED`. It does not emit a fake new-message event. Old generated reasoning/display text/token counts are removed from the revised version so stale content is not displayed. Existing unrelated swipe metadata is retained. If saving fails, the revision may remain in memory; the original remains in the swipe array. Inspect the error and save the chat before reloading.

The request uses `generateRaw` on your current backend, with the original, suggestion, character fields/persona, last eight preceding non-system messages, and currently available extension notes. It does not run the full native chat prompt builder or a fresh lore scan; only already populated lore/notes are included when available. For older messages, notes may reflect the current scene. Group card fields reflect the current selected character; verify continuity before revising older group replies.

The prompt lives only in the request. No temporary chat messages, Author's Note changes, card writes, World Info writes, or persistent prompt injection are used. Only the revised assistant output enters chat history. Existing extensions can process revised text after the swipe event. Requests go to the configured provider and normal costs/logging apply; other installed extensions can intercept raw generation events.

The original is never truncated to fit the context window. Oversized requests fail before generation. Token estimates include a 512-token formatting reserve; provider templates and tokenization may differ. Model compliance with minimal editing and full-length output cannot be guaranteed. Review the revision, especially for long replies.

Chat identity, message object, full chat fingerprint, and a change epoch are checked after asynchronous work. Edits, swipe changes, new messages, character/chat changes, or normal generation discard the pending result into a copyable preview. Errors and empty outputs do not create a swipe; identical output adds no duplicate. Normal generation/editing must finish before opening Suggest.

## Verification

From the source workspace run `node --test` and `node --check suggest/index.js`. Automated tests cover original preservation, unrelated metadata, empty/identical output, pending swipes, chat changes and budget rejection. A connected-model UI test is still required.

Manual checklist:

- Use the Noah/Jia water example: suggest “Jia cannot take water per doctor's order yet.” Check that water-related actions change and unrelated dialogue remains verbatim in Minimal.
- Confirm the new active swipe and recover the original using swipe controls; reload and confirm both persist.
- Revise a selected nonlatest swipe and an older assistant message; confirm no unrelated versions or downstream messages change.
- Cancel the dialog; submit blank text; simulate a disconnected API or empty result. Confirm no response is lost.
- Switch chats and back, edit/swipe a target, or begin normal generation while a request is pending. Confirm the result cannot overwrite changed chat data.
- Confirm suggestions do not appear in exported chat, Author's Note, character card, summary inputs, or persistent extension prompts.
- Check light/dark themes, mobile popup scrolling, long replies/output allowance, and normal regenerate/swipe after Suggest.


## Non-blocking progress (v0.1.2)

After submitting, the suggestion dialog closes and the target message's circular-arrow icon spins. The chat remains interactive with no progress popup, dimming, or scroll lock. Existing busy logic prevents concurrent Suggest requests. The spinner clears on completion, errors, or detected chat/message changes. Reduced-motion preferences disable rotation. Stale results retain the existing copyable-preview safety behavior.


import * as tavern from '/script.js';
import { strengths, buildRevisionPrompt, captureTarget, targetUnchanged, appendRevision, checkBudget } from './revision.js';

const context = () => SillyTavern.getContext();
const settings = () => context().extensionSettings.suggestRevision ??= { strength: 'minimal', tokens: 4096 };
let busy = false;
let epoch = 0;
const notify = (text, error = false) => globalThis.toastr?.[error ? 'error' : 'info'](text, 'Suggest Revision', { escapeHtml: true, timeOut: error ? 15000 : 5000 });
const active = () => typeof tavern.isGenerating === 'function' ? tavern.isGenerating() : Boolean(tavern.is_send_press || document.body.dataset.generating === 'true');
const editing = () => Boolean(document.querySelector('#curEditTextarea'));

function referenceFor(ctx, index) {
    const fields = ctx.getCharacterCardFields();
    // Only earlier messages: later events should not leak into an older revision.
    return {
        character: fields,
        earlierConversation: ctx.chat.slice(0, index).filter(m => !m.is_system).slice(-8)
            .map(m => ({ speaker: m.name, role: m.is_user ? 'user' : 'assistant', text: m.mes })),
        availableNotes: Object.entries(ctx.extensionPrompts ?? {})
            .filter(([key, entry]) => entry?.value && !/^(QUIET|TEMP)/i.test(key))
            .map(([source, entry]) => ({ source, text: ctx.substituteParams(entry.value) })),
    };
}

async function revise(target, suggestion, strength, status) {
    if (busy || active() || editing()) throw new Error('Finish generation or message editing before suggesting.');
    if (!targetUnchanged(target, context(), epoch)) throw new Error('The chat or selected response changed. Reopen Suggest.');
    busy = true;
    refreshActions();
    try {
        const ctx = context();
        const request = buildRevisionPrompt({ original: target.message.mes, suggestion, strength, reference: referenceFor(ctx, target.index) });
        const tokens = Math.max(256, Math.min(16384, Number(settings().tokens) || 4096));
        status.textContent = 'Checking prompt size…';
        await checkBudget(ctx, request, tokens);
        if (!targetUnchanged(target, context(), epoch) || active() || editing()) throw new Error('The chat or selected response changed. Reopen Suggest.');
        status.textContent = 'Revising response…';
        const started = Date.now();
        const reply = await ctx.generateRaw({ ...request, responseLength: tokens, trimNames: false });
        if (typeof reply !== 'string' || !reply.trim()) throw new Error('The AI returned an empty revision.');
        if (!targetUnchanged(target, context(), epoch) || active() || editing()) {
            const preview = document.createElement('pre');
            preview.className = 'suggest-preview';
            preview.textContent = reply;
            notify('The chat or response changed. Revision was not applied; you can copy it from the preview.');
            await context().callGenericPopup(preview, context().POPUP_TYPE.TEXT);
            return;
        }
        if (!appendRevision(target.message, reply, started)) {
            notify('The model returned the same response. No extra swipe was added.');
            return;
        }
        // Commit before awaiting hooks; suggestions are never part of message data.
        ctx.updateMessageBlock(target.index, target.message);
        ctx.swipe?.refresh?.();
        try { await ctx.saveChat(); }
        catch { throw new Error('The revision is in memory, but saving failed. The original is still a swipe. Save the chat before reloading.'); }
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_SWIPED, target.index);
        notify('Revision saved as a new swipe. The original is still available.');
    } finally {
        busy = false;
        refreshActions();
    }
}

async function openSuggest(index) {
    if (busy || active() || editing()) return notify('Finish generation or editing first.');
    try {
        const ctx = context();
        const target = captureTarget(ctx, index, epoch);
        const form = document.createElement('div');
        form.className = 'suggest-form';
        form.innerHTML = `<h3>Suggest changes</h3>
            <label>Current response<textarea class="text_pole suggest-original" readonly></textarea></label>
            <label>Suggestion<textarea class="text_pole suggest-input" placeholder="Suggest how this reply should change — e.g. fix a continuity issue, change one action, preserve the rest."></textarea></label>
            <small class="suggest-count" aria-live="polite">0 characters</small>
            <label>Revision strength<select class="text_pole suggest-strength"><option value="minimal">Minimal</option><option value="moderate">Moderate</option><option value="free">Rewrite freely</option></select></label>
            <p>Minimal asks the model to copy unaffected passages exactly. Results depend on the model. Your original is retained as a swipe.</p>
            <p class="suggest-status" role="status"></p>`;
        form.querySelector('.suggest-original').value = target.message.mes;
        const input = form.querySelector('.suggest-input');
        const strength = form.querySelector('select');
        strength.value = Object.hasOwn(strengths, settings().strength) ? settings().strength : 'minimal';
        input.addEventListener('input', () => { form.querySelector('.suggest-count').textContent = `${Array.from(input.value).length} characters`; });
        const accepted = await ctx.callGenericPopup(form, ctx.POPUP_TYPE.CONFIRM, '', {
            okButton: 'Suggest', cancelButton: 'Cancel', wide: true,
        });
        if (accepted !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
        if (!input.value.trim()) return notify('Enter a suggestion first.', true);
        settings().strength = strength.value;
        ctx.saveSettingsDebounced();
        // Native progress popup stays open until generation finishes.
        const progress = document.createElement('p');
        progress.textContent = 'Preparing revision…';
        let finished = false;
        const popup = new ctx.Popup(progress, ctx.POPUP_TYPE.TEXT, '', { okButton: false, cancelButton: false, onClosing: () => finished });
        const shown = popup.show();
        try { await revise(target, input.value, strength.value, progress); }
        finally { finished = true; await popup.complete(ctx.POPUP_RESULT.AFFIRMATIVE); await shown; }
    } catch (error) {
        notify(error?.message || 'Revision failed. The original response is retained.', true);
    }
}

function refreshActions() {
    const ctx = context();
    for (const block of document.querySelectorAll('#chat .mes[mesid]')) {
        const index = Number(block.getAttribute('mesid'));
        const message = ctx.chat[index];
        let button = block.querySelector('.suggest-revision-action');
        if (!message || message.is_user || message.is_system || !message.mes?.trim()) { button?.remove(); continue; }
        if (!button) {
            const host = block.querySelector('.extraMesButtons') ?? block.querySelector('.mes_buttons');
            if (!host) continue;
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'suggest-revision-action menu_button';
            button.textContent = 'Suggest';
            button.title = 'Revise this response while preserving unaffected text';
            button.addEventListener('click', event => { event.stopPropagation(); void openSuggest(Number(block.getAttribute('mesid'))); });
            host.append(button);
        }
        button.disabled = busy;
    }
}

function initialize() {
    const ctx = context();
    const panel = document.createElement('div');
    panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Suggest Revision</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><p>Open an assistant message’s actions and choose Suggest. Uses the current connection.</p><label>Default revision strength<select class="text_pole" data-setting="strength"><option value="minimal">Minimal</option><option value="moderate">Moderate</option><option value="free">Rewrite freely</option></select></label><label>Maximum revision output tokens<input class="text_pole" type="number" min="256" max="16384" step="1" data-setting="tokens"></label><p>Allow enough tokens for the complete reply. No suggestion history is saved.</p></div></div>`;
    for (const field of panel.querySelectorAll('[data-setting]')) {
        field.value = settings()[field.dataset.setting];
        field.addEventListener('change', () => { settings()[field.dataset.setting] = field.value; ctx.saveSettingsDebounced(); });
    }
    document.querySelector('#extensions_settings')?.append(panel);
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => { epoch++; refreshActions(); });
    ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, (type, options, dryRun) => { if (!dryRun && type !== 'quiet') epoch++; });
    // Native message rendering/lazy loading can replace nodes without a chat event.
    const chat = document.querySelector('#chat');
    if (chat) new MutationObserver(refreshActions).observe(chat, { childList: true, subtree: true });
    refreshActions();
}

jQuery(initialize);

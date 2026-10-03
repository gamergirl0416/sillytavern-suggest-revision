import * as tavern from '/script.js';
import { strengths, buildRevisionPrompt, captureTarget, targetUnchanged, appendRevision, checkBudget } from './revision.js';

const context = () => SillyTavern.getContext();
const settings = () => context().extensionSettings.suggestRevision ??= { strength: 'minimal', tokens: 4096 };
let busy = false;
let epoch = 0;
let pendingTarget = null;
let progressLabel = '';
const progressBlocks = new Set();
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

function clearProgress() {
    pendingTarget = null;
    for (const block of progressBlocks) {
        block.classList.remove('suggest-revising');
        const button = block.querySelector('.suggest-revision-action');
        button?.removeAttribute('aria-busy');
        button?.setAttribute('aria-label', 'Suggest changes to this response');
        if (button) button.title = 'Revise this response while preserving unaffected text';
    }
    progressBlocks.clear();
}

function setProgress(label) {
    progressLabel = label;
    refreshActions();
}

async function revise(target, suggestion, strength) {
    if (busy || active() || editing()) throw new Error('Finish generation or message editing before suggesting.');
    if (!targetUnchanged(target, context(), epoch)) throw new Error('The chat or selected response changed. Reopen Suggest.');
    busy = true;
    pendingTarget = target;
    try {
        setProgress('Checking prompt size…');
        const ctx = context();
        const request = buildRevisionPrompt({ original: target.message.mes, suggestion, strength, reference: referenceFor(ctx, target.index) });
        const tokens = Math.max(256, Math.min(16384, Number(settings().tokens) || 4096));
        await checkBudget(ctx, request, tokens);
        if (!targetUnchanged(target, context(), epoch) || active() || editing()) throw new Error('The chat or selected response changed. Reopen Suggest.');
        setProgress('Revising response…');
        const started = Date.now();
        const reply = await ctx.generateRaw({ ...request, responseLength: tokens, trimNames: false });
        if (typeof reply !== 'string' || !reply.trim()) throw new Error('The AI returned an empty revision.');
        if (!targetUnchanged(target, context(), epoch) || active() || editing()) {
            clearProgress();
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
        clearProgress();
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
        await revise(target, input.value, strength.value);
    } catch (error) {
        notify(error?.message || 'Revision failed. The original response is retained.', true);
    }
}

function refreshActions() {
    const ctx = context();
    if (pendingTarget && !targetUnchanged(pendingTarget, ctx, epoch)) clearProgress();
    for (const block of document.querySelectorAll('#chat .mes[mesid]')) {
        const index = Number(block.getAttribute('mesid'));
        const message = ctx.chat[index];
        let button = block.querySelector('.suggest-revision-action');
        if (!message || message.is_user || message.is_system || !message.mes?.trim()) { button?.remove(); continue; }
        if (!button) {
            // Keep Suggest in the main action row; the expanded action tray can
            // be hidden or clipped on mobile.
            const host = block.querySelector('.mes_buttons');
            if (!host) continue;
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'suggest-revision-action mes_button';
            button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 7v5h-5M4 17v-5h5M5.5 8a7 7 0 0 1 11.6-3L20 8M4 16l2.9 3A7 7 0 0 0 18.5 16"/></svg>`;
            button.title = 'Revise this response while preserving unaffected text';
            button.setAttribute('aria-label', 'Suggest changes to this response');
            button.addEventListener('click', event => { event.stopPropagation(); void openSuggest(Number(block.getAttribute('mesid'))); });
            host.prepend(button);
        }
        button.disabled = busy;
        if (pendingTarget?.message === message && pendingTarget.index === index) {
            block.classList.add('suggest-revising');
            progressBlocks.add(block);
            button.setAttribute('aria-busy', 'true');
            button.setAttribute('aria-label', progressLabel);
            button.title = progressLabel;
        }
    }
}

function initialize() {
    const ctx = context();
    const panel = document.createElement('div');
    panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Suggest Revision</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><p>Click the circular-arrow icon in an assistant message’s action row to suggest changes. Uses the current connection.</p><label>Default revision strength<select class="text_pole" data-setting="strength"><option value="minimal">Minimal</option><option value="moderate">Moderate</option><option value="free">Rewrite freely</option></select></label><label>Maximum revision output tokens<input class="text_pole" type="number" min="256" max="16384" step="1" data-setting="tokens"></label><p>Allow enough tokens for the complete reply. No suggestion history is saved.</p></div></div>`;
    for (const field of panel.querySelectorAll('[data-setting]')) {
        field.value = settings()[field.dataset.setting];
        field.addEventListener('change', () => { settings()[field.dataset.setting] = field.value; ctx.saveSettingsDebounced(); });
    }
    document.querySelector('#extensions_settings')?.append(panel);
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => { epoch++; refreshActions(); });
    ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
        if (!dryRun && type !== 'quiet') { epoch++; refreshActions(); }
    });
    for (const name of ['MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT']) {
        if (ctx.eventTypes[name]) ctx.eventSource.on(ctx.eventTypes[name], refreshActions);
    }
    // Native message rendering/lazy loading can replace nodes without a chat event.
    const chat = document.querySelector('#chat');
    if (chat) new MutationObserver(refreshActions).observe(chat, { childList: true, subtree: true });
    refreshActions();
}

jQuery(initialize);

/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Shared by every Messenger window: sounds, your msn-assets (frames, emoticons, style.css).
// Load before the page's own script.

"use strict";

window.Msn = (() => {
    const NUDGE_TEXT = "🫨 *sent a nudge!*"; // keep in sync with MSN_NUDGE_TEXT in src/shared/msn.ts

    let assets = { sounds: {}, frames: {}, emoticons: {}, css: null };
    let emoticonRe = null;

    const ready = MsnNative.getAssets()
        .then(a => {
            assets = a;
            applyFrames();
            applyUserCss();
            buildEmoticons();
            return a;
        })
        .catch(err => {
            console.warn("[MSN] couldn't load msn-assets", err);
            return assets;
        });

    // ---------- frames & custom CSS ----------

    function applyFrames() {
        let css = "";
        for (const [status, url] of Object.entries(assets.frames || {})) {
            if (!url) continue;
            // Your frame is drawn over the picture; the built-in glass frame is turned off for that status
            css +=
                `.dp.${status}{background:transparent!important;box-shadow:none!important}` +
                `.dp.${status}::after{content:"";position:absolute;inset:0;pointer-events:none;` +
                `background:url(${JSON.stringify(url)}) center/100% 100% no-repeat}`;
        }
        if (!css) return;

        const style = document.createElement("style");
        style.dataset.msn = "frames";
        style.textContent = css;
        document.head.append(style);
    }

    function applyUserCss() {
        if (!assets.css) return;
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = assets.css;
        document.head.append(link); // last, so it wins
    }

    // ---------- emoticons ----------

    function buildEmoticons() {
        const codes = Object.keys(assets.emoticons || {}).sort((a, b) => b.length - a.length);
        if (!codes.length) return;
        emoticonRe = new RegExp(codes.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    }

    /** Append text to an element, turning emoticon codes into your images. Text only, never HTML. */
    function appendText(parent, text) {
        if (!emoticonRe || !text) {
            parent.append(document.createTextNode(text));
            return;
        }

        let last = 0;
        for (const m of text.matchAll(emoticonRe)) {
            if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
            const img = document.createElement("img");
            img.className = "emo";
            img.src = assets.emoticons[m[0]];
            img.alt = m[0];
            img.title = m[0];
            img.draggable = false;
            parent.append(img);
            last = m.index + m[0].length;
        }
        if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
    }

    // ---------- sounds ----------

    let ctx = null;

    function tone(t, freq, dur, type = "sine", gain = 0.16) {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(gain, t + 0.015);
        env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(env).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur + 0.05);
    }

    // Built-in placeholder sounds, synthesised on the spot. Your own files replace these.
    const SYNTH = {
        signin: t => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(t + i * 0.09, f, 0.4)),
        online: t => {
            tone(t, 659.25, 0.28);
            tone(t + 0.12, 987.77, 0.45);
        },
        message: t => {
            tone(t, 880, 0.2, "triangle");
            tone(t + 0.13, 1318.5, 0.32, "triangle");
        },
        nudge: t => {
            for (let i = 0; i < 7; i++) tone(t + i * 0.065, i % 2 ? 147 : 110, 0.09, "square", 0.06);
        }
    };

    function synth(name) {
        try {
            ctx ??= new AudioContext();
            if (ctx.state === "suspended") ctx.resume();
            SYNTH[name]?.(ctx.currentTime + 0.02);
        } catch (err) {
            console.warn("[MSN] couldn't play sound", err);
        }
    }

    async function play(name) {
        await ready;
        const url = assets.sounds?.[name];
        if (!url) return synth(name);

        const audio = new Audio(url);
        audio.volume = 0.8;
        audio.play().catch(() => synth(name));
    }

    MsnNative.onPlay(name => play(name));

    // ---------- message formatting ----------
    // Discord markdown -> DOM nodes. Everything is created as elements/text nodes, never as HTML.

    const URL_RE = /https?:\/\/[^\s<]+[^\s<.,:;"')\]!?*_~|]/;

    // Earliest match wins; on a tie, the first in this list. Links come first so
    // underscores or asterisks inside a URL don't get read as formatting.
    const INLINE = [
        { re: URL_RE, kind: "link" },
        { re: /`([^`\n]+)`/, kind: "code" },
        { re: /\|\|([\s\S]+?)\|\|/, kind: "spoiler" },
        { re: /\*\*([\s\S]+?)\*\*/, tag: "strong" },
        { re: /__([\s\S]+?)__/, tag: "u" },
        { re: /~~([\s\S]+?)~~/, tag: "s" },
        { re: /\*([^*\s](?:[^*]*[^*\s])?)\*/, tag: "em" },
        { re: /(?<![\w])_([^_\s](?:[^_]*[^_\s])?)_(?![\w])/, tag: "em" }
    ];

    function appendInline(parent, text, depth = 0) {
        while (text) {
            let best = null;
            if (depth < 6) {
                for (const rule of INLINE) {
                    const m = rule.re.exec(text);
                    if (m && (!best || m.index < best.m.index)) best = { rule, m };
                }
            }
            if (!best) {
                appendText(parent, text);
                return;
            }

            const { rule, m } = best;
            if (m.index > 0) appendText(parent, text.slice(0, m.index));

            if (rule.kind === "link") {
                const a = document.createElement("a");
                a.href = m[0];
                a.target = "_blank";
                a.rel = "noreferrer";
                a.textContent = m[0];
                parent.append(a);
            } else if (rule.kind === "code") {
                const code = document.createElement("code");
                code.className = "md-code";
                code.textContent = m[1];
                parent.append(code);
            } else if (rule.kind === "spoiler") {
                const sp = document.createElement("span");
                sp.className = "md-spoiler";
                sp.title = "Spoiler: click to show";
                sp.addEventListener("click", () => sp.classList.add("shown"), { once: true });
                appendInline(sp, m[1], depth + 1);
                parent.append(sp);
            } else {
                const el = document.createElement(rule.tag);
                appendInline(el, m[1], depth + 1);
                parent.append(el);
            }

            text = text.slice(m.index + m[0].length);
        }
    }

    /** Full message: ```code blocks```, > quotes, then inline formatting, links and emoticons */
    function appendRich(parent, text) {
        const parts = String(text).split(/```(?:[\w+-]*\n)?([\s\S]*?)```/g);

        parts.forEach((part, i) => {
            if (i % 2) {
                const pre = document.createElement("pre");
                pre.className = "md-pre";
                pre.textContent = part.replace(/\n$/, "");
                parent.append(pre);
                return;
            }

            const lines = part.split("\n");
            lines.forEach((line, j) => {
                const quote = /^>>?> ?|^> /.test(line);
                if (quote) {
                    const q = document.createElement("div");
                    q.className = "md-quote";
                    appendInline(q, line.replace(/^>{1,3} ?/, ""));
                    parent.append(q);
                } else {
                    appendInline(parent, line);
                    const next = lines[j + 1];
                    if (next !== undefined && !/^>>?> ?|^> /.test(next)) parent.append(document.createTextNode("\n"));
                }
            });
        });
    }

    // ---------- glass title bar ----------

    function setupTitlebar() {
        const bar = document.querySelector(".titlebar");
        if (!bar) return;

        bar.querySelector('[data-tb="min"]')?.addEventListener("click", () => MsnNative.minimize());
        bar.querySelector('[data-tb="max"]')?.addEventListener("click", () => MsnNative.maximize());
        bar.querySelector('[data-tb="close"]')?.addEventListener("click", () => MsnNative.close());
        bar.addEventListener("dblclick", e => {
            if (!e.target.closest(".tb-buttons")) MsnNative.maximize();
        });

        // Keep the bar's text in step with document.title
        const title = bar.querySelector(".tb-title");
        const titleEl = document.querySelector("title");
        if (title && titleEl) {
            const sync = () => (title.textContent = document.title);
            sync();
            new MutationObserver(sync).observe(titleEl, { childList: true, characterData: true, subtree: true });
        }

        MsnNative.onMaximized(max => document.body.classList.toggle("maximized", max));
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupTitlebar);
    else setupTitlebar();

    // ---------- misc ----------

    function isNudge(content) {
        return typeof content === "string" && content.trim() === NUDGE_TEXT;
    }

    /** Emoticon codes from your msn-assets, for the picker */
    function emoticonList() {
        return Object.entries(assets.emoticons || {});
    }

    return { ready, play, appendText, appendRich, isNudge, emoticonList };
})();

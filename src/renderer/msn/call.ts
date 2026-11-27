/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Messenger-style call screen.
//
// Discord's call audio and video only exist inside this (Discord) window, so the call
// screen lives here too: a Messenger-looking layer on top of Discord's own call view.
// The video panes play the very same streams as Discord's video tiles underneath
// (same window, so the live MediaStream can simply be shared). Buttons call Discord's
// own mute / deafen / camera / disconnect actions. Nothing here talks to Discord's
// servers directly.

import { filters, waitFor } from "@vencord/types/webpack";
import { ChannelStore, FluxDispatcher, NavigationRouter, UserStore } from "@vencord/types/webpack/common";
import { IpcCommands } from "shared/IpcEvents";
import type { MsnCallState } from "shared/msn";

import { onIpcCommand } from "../ipcCommands";
import { VesktopLogger } from "../logger";
import { Settings } from "../settings";

let SelectedChannelStore: any;
let VoiceStateStore: any;
let SpeakingStore: any;
let MediaEngineStore: any;
let GuildStore: any;
let GuildMemberStore: any;
let VoiceActions: any;
let AudioActions: any;
let VideoActions: any;
waitFor(filters.byStoreName("SelectedChannelStore"), s => (SelectedChannelStore = s));
waitFor(filters.byStoreName("VoiceStateStore"), s => (VoiceStateStore = s));
waitFor(filters.byStoreName("SpeakingStore"), s => (SpeakingStore = s));
waitFor(filters.byStoreName("MediaEngineStore"), s => (MediaEngineStore = s));
waitFor(filters.byStoreName("GuildStore"), s => (GuildStore = s));
waitFor(filters.byStoreName("GuildMemberStore"), s => (GuildMemberStore = s));
waitFor(filters.byProps("selectVoiceChannel"), m => (VoiceActions = m));
waitFor(filters.byProps("toggleSelfMute", "toggleSelfDeaf"), m => (AudioActions = m));
waitFor(filters.byProps("setVideoEnabled"), m => (VideoActions = m));

const DM = 1;
const GROUP_DM = 3;
const VOICE_TYPES = new Set([2, 13]);
const OVERLAY_ID = "msn-call-overlay";

// ---------- Discord actions (all guarded: Discord renames things now and then) ----------

function joinVoice(channelId: string | null) {
    if (typeof VoiceActions?.selectVoiceChannel !== "function") throw new Error("Couldn't reach Discord's voice controls");
    VoiceActions.selectVoiceChannel(channelId);
}

onIpcCommand(IpcCommands.MSN_CMD_JOIN_VOICE, (channelId: string) => {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel || !(VOICE_TYPES.has(channel.type) || channel.type === DM || channel.type === GROUP_DM)) {
        throw new Error("That isn't something you can call");
    }
    joinVoice(channelId);
});

/** Call someone from a DM chat window: join the DM's voice, which rings them */
onIpcCommand(IpcCommands.MSN_CMD_START_CALL, (channelId: string) => {
    const channel = ChannelStore.getChannel(channelId);
    if (channel?.type !== DM) throw new Error("Calls start from one-on-one conversations");
    joinVoice(channelId);
});

// ---------- Who's in the call ----------

interface Participant {
    id: string;
    name: string;
    avatar: string;
    speaking: boolean;
    muted: boolean;
    deafened: boolean;
    video: boolean;
    /** Invited to a DM call but not joined yet */
    ringing?: boolean;
}

function nameOf(userId: string, guildId?: string) {
    const nick = guildId ? GuildMemberStore?.getNick?.(guildId, userId) : null;
    const user = UserStore.getUser(userId) as any;
    return nick || user?.globalName || user?.username || "Someone";
}

function avatarOf(userId: string, guildId?: string) {
    const user = UserStore.getUser(userId) as any;
    try {
        return user?.getAvatarURL?.(guildId, 256, false) ?? "";
    } catch {
        return "";
    }
}

function participantsOf(channelId: string): Participant[] {
    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel?.guild_id ?? undefined;
    const states: Record<string, any> = VoiceStateStore?.getVoiceStatesForChannel?.(channelId) ?? {};
    const me = UserStore.getCurrentUser();

    const people: Participant[] = Object.values(states).map((vs: any) => {
        const id = vs.userId ?? vs.user_id;
        const isMe = id === me?.id;
        return {
            id,
            name: nameOf(id, guildId),
            avatar: avatarOf(id, guildId),
            speaking: !!SpeakingStore?.isSpeaking?.(id),
            muted: isMe ? !!MediaEngineStore?.isSelfMute?.() : !!(vs.selfMute || vs.mute),
            deafened: isMe ? !!MediaEngineStore?.isSelfDeaf?.() : !!(vs.selfDeaf || vs.deaf),
            video: !!vs.selfVideo
        };
    });

    // DM call where they haven't picked up yet: show them as "Calling…"
    if (channel?.type === DM) {
        const otherId = channel.recipients?.[0];
        if (otherId && !people.some(p => p.id === otherId)) {
            people.push({
                id: otherId,
                name: nameOf(otherId),
                avatar: avatarOf(otherId),
                speaking: false,
                muted: false,
                deafened: false,
                video: false,
                ringing: true
            });
        }
    }

    // Others first, you last (like Messenger's big picture / small picture)
    return people.sort((a, b) => Number(a.id === me?.id) - Number(b.id === me?.id));
}

// ---------- Finding Discord's video streams underneath ----------

function liveStream(video: HTMLVideoElement) {
    const stream = video.srcObject;
    if (!(stream instanceof MediaStream)) return null;
    return stream.getVideoTracks().some(t => t.readyState === "live") ? stream : null;
}

/**
 * Match each video in Discord's call view to a participant by looking for their name
 * in the tile around it. Videos that can't be matched (e.g. screen shares) still show,
 * just without a name.
 */
function findStreams(people: Participant[]) {
    const byUser = new Map<string, MediaStream>();
    const unmatched: MediaStream[] = [];

    const videos = [...document.querySelectorAll<HTMLVideoElement>("video")].filter(v => !v.closest("#" + OVERLAY_ID));
    for (const video of videos) {
        const stream = liveStream(video);
        if (!stream) continue;

        let owner: string | null = null;
        let el: HTMLElement | null = video.parentElement;
        for (let depth = 0; el && depth < 7 && !owner; depth++, el = el.parentElement) {
            const label = ((el.getAttribute("aria-label") ?? "") + " " + (el.textContent ?? "")).toLowerCase();
            const candidates = people.filter(p => p.video && !byUser.has(p.id) && label.includes(p.name.toLowerCase()));
            if (candidates.length === 1) owner = candidates[0].id;
        }

        if (owner) byUser.set(owner, stream);
        else if (![...byUser.values()].includes(stream) && !unmatched.includes(stream)) unmatched.push(stream);
    }

    // Exactly one person with camera on and one unclaimed video: that's theirs
    const waiting = people.filter(p => p.video && !byUser.has(p.id));
    if (waiting.length === 1 && unmatched.length === 1) byUser.set(waiting[0].id, unmatched.shift()!);

    return { byUser, unmatched };
}

// ---------- The overlay ----------

const STYLE = `
#${OVERLAY_ID} {
    position: fixed; inset: 0; z-index: 2147483000;
    display: flex; flex-direction: column;
    font-family: "Segoe UI", system-ui, sans-serif; font-size: 13px; color: #1e2d3b;
    background: linear-gradient(180deg, #8ccbec 0px, #cfe9f7 110px, #eaf5fc 220px, #eaf5fc 100%);
}
#${OVERLAY_ID}.msn-hidden { display: none; }
#${OVERLAY_ID} .mc-titlebar {
    flex: none; display: flex; align-items: center; height: 30px; padding-left: 10px; gap: 8px;
    -webkit-app-region: drag; user-select: none;
    background: linear-gradient(180deg, rgba(255,255,255,.55) 0%, rgba(255,255,255,.12) 48%, rgba(255,255,255,0) 50%),
                linear-gradient(180deg, #7cc0e6 0%, #8ccbec 100%);
    border-bottom: 1px solid rgba(255,255,255,.35);
}
#${OVERLAY_ID} .mc-title { flex: 1; font-size: 12px; text-shadow: 0 1px 0 rgba(255,255,255,.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${OVERLAY_ID} .mc-winbtns { display: flex; height: 100%; -webkit-app-region: no-drag; }
#${OVERLAY_ID} .mc-winbtns button {
    width: 44px; height: 100%; border: none; background: transparent; color: #12324a; cursor: default;
    font-family: "Segoe Fluent Icons", "Segoe MDL2 Assets", "Segoe UI Symbol", sans-serif; font-size: 10px;
}
#${OVERLAY_ID} .mc-winbtns button:hover { background: rgba(255,255,255,.45); }
#${OVERLAY_ID} .mc-winbtns .close:hover { background: #e0413a; color: #fff; }
#${OVERLAY_ID} .mc-head { padding: 10px 16px 8px; }
#${OVERLAY_ID} .mc-name { font-size: 17px; font-weight: 600; }
#${OVERLAY_ID} .mc-sub { margin-top: 2px; color: #3f5f74; }
#${OVERLAY_ID} .mc-panes {
    flex: 1; min-height: 0; overflow: auto; display: grid; gap: 10px; padding: 4px 16px 10px;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); grid-auto-rows: minmax(160px, 1fr);
}
#${OVERLAY_ID} .mc-pane {
    display: flex; flex-direction: column; min-height: 0;
    background: #fff; border: 1px solid #b3cfe0; border-radius: 5px; padding: 8px 8px 0;
    box-shadow: 0 1px 2px rgba(0,40,80,.12);
}
#${OVERLAY_ID} .mc-view {
    position: relative; flex: 1; min-height: 0; border-radius: 3px; overflow: hidden;
    background: linear-gradient(180deg, #f4f9fc, #dcebf4);
    display: flex; align-items: center; justify-content: center;
}
#${OVERLAY_ID} .mc-view video { width: 100%; height: 100%; object-fit: cover; background: #0b1a26; }
#${OVERLAY_ID} .mc-pic {
    height: min(150px, 78%); aspect-ratio: 1; border-radius: 16px; padding: 6px; box-sizing: border-box;
    background: linear-gradient(160deg, rgba(255,255,255,.9) 0%, rgba(255,255,255,0) 45%), linear-gradient(180deg, #8fd88f, #3dbb3d);
    box-shadow: 0 1px 3px rgba(0,40,80,.35), inset 0 0 0 1px rgba(255,255,255,.6);
    transition: box-shadow .12s;
}
#${OVERLAY_ID} .mc-pic img, #${OVERLAY_ID} .mc-pic .mc-initial {
    width: 100%; height: 100%; border-radius: 11px; object-fit: cover; display: flex; align-items: center; justify-content: center;
    font-size: 44px; font-weight: 600; color: #5d7d93; background: linear-gradient(#f4f9fc, #d9e8f2);
}
#${OVERLAY_ID} .mc-pane.speaking .mc-pic { box-shadow: 0 0 0 3px #7ee07e, 0 0 14px 4px rgba(61,187,61,.55); }
#${OVERLAY_ID} .mc-pane.speaking .mc-view:has(video) { box-shadow: inset 0 0 0 3px #3dbb3d; }
#${OVERLAY_ID} .mc-pane.ringing .mc-pic { opacity: .65; }
#${OVERLAY_ID} .mc-ringing {
    position: absolute; bottom: 10px; left: 0; right: 0; text-align: center; color: #2d6a8f; font-style: italic;
}
#${OVERLAY_ID} .mc-caption {
    display: flex; align-items: center; gap: 6px; height: 28px; font-size: 12px; color: #34586f;
    white-space: nowrap; overflow: hidden;
}
#${OVERLAY_ID} .mc-caption .mc-cname { flex: 1; overflow: hidden; text-overflow: ellipsis; }
#${OVERLAY_ID} .mc-caption .mc-flags { color: #b23a33; }
#${OVERLAY_ID} .mc-controls {
    flex: none; display: flex; justify-content: center; gap: 8px; padding: 8px 16px 12px;
}
#${OVERLAY_ID} .mc-controls button {
    font: inherit; min-width: 86px; padding: 7px 14px; cursor: pointer; color: #1f4d6b;
    border: 1px solid #8fb7cf; border-radius: 4px; background: linear-gradient(#ffffff, #dcebf4);
}
#${OVERLAY_ID} .mc-controls button:hover { background: linear-gradient(#ffffff, #c9e2f1); }
#${OVERLAY_ID} .mc-controls button.on { background: linear-gradient(#fde9e7, #f6c9c4); border-color: #df9890; color: #8a2f29; }
#${OVERLAY_ID} .mc-controls .hangup { background: linear-gradient(#f26b63, #d23c33); border-color: #b3302a; color: #fff; }
#${OVERLAY_ID} .mc-controls .hangup:hover { background: linear-gradient(#f57d76, #dc463d); }
#msn-call-return {
    position: fixed; z-index: 2147483000; right: 16px; bottom: 16px;
    font: 13px "Segoe UI", system-ui, sans-serif; padding: 8px 14px; cursor: pointer; color: #1f4d6b;
    border: 1px solid #8fb7cf; border-radius: 4px; background: linear-gradient(#ffffff, #dcebf4);
    box-shadow: 0 2px 8px rgba(0,40,80,.3);
}
`;

let overlay: HTMLDivElement | null = null;
let returnBtn: HTMLButtonElement | null = null;
let style: HTMLStyleElement | null = null;
let callChannelId: string | null = null;
let callStartedAt = 0;
let tick: ReturnType<typeof setInterval> | null = null;
/** Pane elements by key, reused between updates so videos don't flicker */
const panes = new Map<string, HTMLDivElement>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
}

function safeImage(url: string) {
    try {
        const u = new URL(url);
        return u.protocol === "https:" && /(^|\.)discordapp\.(com|net)$/.test(u.hostname) ? u.href : null;
    } catch {
        return null;
    }
}

function picture(p: { name: string; avatar: string }) {
    const pic = el("div", "mc-pic");
    const src = safeImage(p.avatar);
    const initial = () => {
        const i = el("div", "mc-initial", (p.name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase());
        pic.replaceChildren(i);
    };
    if (src) {
        const img = el("img");
        img.alt = "";
        img.src = src;
        img.onerror = initial;
        pic.append(img);
    } else initial();
    return pic;
}

function callTitle(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return { name: "Call", sub: "" };
    if (channel.type === DM) return { name: nameOf(channel.recipients?.[0]), sub: "Voice call" };
    if (channel.type === GROUP_DM) return { name: channel.name || "Group call", sub: "Group call" };
    return { name: "🔊 " + channel.name, sub: GuildStore?.getGuild(channel.guild_id)?.name ?? "" };
}

function duration() {
    const s = Math.floor((Date.now() - callStartedAt) / 1000);
    const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return (s >= 3600 ? Math.floor(s / 3600) + ":" : "") + mm + ":" + ss;
}

function buildOverlay() {
    style = el("style");
    style.id = "msn-call-style";
    style.textContent = STYLE;
    document.head.append(style);

    overlay = el("div");
    overlay.id = OVERLAY_ID;

    const bar = el("div", "mc-titlebar");
    const title = el("span", "mc-title", "Messenger call");
    const winBtns = el("div", "mc-winbtns");
    for (const [cls, glyph, label, fn] of [
        ["min", "", "Minimize", () => VesktopNative.win.minimize()],
        ["max", "", "Maximize", () => VesktopNative.win.maximize()],
        ["close", "", "Hide (the call keeps going)", () => VesktopNative.win.close()]
    ] as const) {
        const b = el("button", cls, glyph);
        b.type = "button";
        b.title = label;
        b.addEventListener("click", fn);
        winBtns.append(b);
    }
    bar.append(title, winBtns);

    const head = el("div", "mc-head");
    head.append(el("div", "mc-name"), el("div", "mc-sub"));

    const paneBox = el("div", "mc-panes");

    const controls = el("div", "mc-controls");
    const mk = (cls: string, text: string, title: string, fn: () => void) => {
        const b = el("button", cls, text);
        b.type = "button";
        b.title = title;
        b.addEventListener("click", () => {
            try {
                fn();
            } catch (e) {
                VesktopLogger.error("[MSN] call control failed", e);
            }
            setTimeout(update, 150);
        });
        controls.append(b);
        return b;
    };
    mk("mute", "Mute", "Turn your microphone off / on", () => AudioActions.toggleSelfMute());
    mk("deafen", "Deafen", "Stop hearing the call / hear it again", () => AudioActions.toggleSelfDeaf());
    if (typeof VideoActions?.setVideoEnabled === "function") {
        mk("camera", "Camera", "Turn your camera on / off", () =>
            VideoActions.setVideoEnabled(!MediaEngineStore?.isVideoEnabled?.())
        );
    }
    mk("discord", "Discord view", "Use Discord's own call screen (screen share, settings…)", () => setOverlayHidden(true));
    mk("hangup", "Hang up", "Leave the call", () => joinVoice(null));

    overlay.append(bar, head, paneBox, controls);
    document.body.append(overlay);

    returnBtn = el("button", undefined, "Back to Messenger view");
    returnBtn.id = "msn-call-return";
    returnBtn.type = "button";
    returnBtn.hidden = true;
    returnBtn.addEventListener("click", () => setOverlayHidden(false));
    document.body.append(returnBtn);
}

function setOverlayHidden(hidden: boolean) {
    overlay?.classList.toggle("msn-hidden", hidden);
    if (returnBtn) returnBtn.hidden = !hidden;
}

function renderPane(key: string, p: Participant | null, stream: MediaStream | null) {
    let pane = panes.get(key);
    if (!pane) {
        pane = el("div", "mc-pane");
        const view = el("div", "mc-view");
        const caption = el("div", "mc-caption");
        caption.append(el("span", "mc-cname"), el("span", "mc-flags"));
        pane.append(view, caption);
        panes.set(key, pane);
    }

    const view = pane.querySelector<HTMLDivElement>(".mc-view")!;
    const existingVideo = view.querySelector("video");

    if (stream) {
        if (!existingVideo || existingVideo.srcObject !== stream) {
            const video = el("video");
            video.autoplay = true;
            video.muted = true; // Discord plays the sound; this is picture only
            video.playsInline = true;
            video.srcObject = stream;
            view.replaceChildren(video);
            video.play().catch(() => {});
        }
    } else if (p && (existingVideo || !view.querySelector(".mc-pic") || pane.dataset.avatar !== p.avatar)) {
        view.replaceChildren(picture(p));
        pane.dataset.avatar = p.avatar;
    }

    view.querySelector(".mc-ringing")?.remove();
    if (p?.ringing) view.append(el("div", "mc-ringing", "Calling…"));

    pane.classList.toggle("speaking", !!p?.speaking);
    pane.classList.toggle("ringing", !!p?.ringing);
    pane.querySelector(".mc-cname")!.textContent = p ? p.name : "Screen share";
    pane.querySelector(".mc-flags")!.textContent = p ? [p.deafened ? "deafened" : p.muted ? "muted" : ""].join("") : "";
    return pane;
}

function update() {
    if (!overlay || !callChannelId) return;

    const people = participantsOf(callChannelId);
    const { byUser, unmatched } = findStreams(people);

    const t = callTitle(callChannelId);
    overlay.querySelector(".mc-title")!.textContent = `${t.name} - Call (${duration()})`;
    overlay.querySelector(".mc-name")!.textContent = t.name;
    overlay.querySelector(".mc-sub")!.textContent = [t.sub, `${people.filter(p => !p.ringing).length} in call`].filter(Boolean).join(" · ");

    const wanted: HTMLDivElement[] = [];
    for (const p of people) wanted.push(renderPane("u:" + p.id, p, byUser.get(p.id) ?? null));
    unmatched.forEach((stream, i) => wanted.push(renderPane("s:" + i, null, stream)));

    const box = overlay.querySelector(".mc-panes")!;
    // keep existing nodes in place (moving a playing video restarts it)
    const current = [...box.children];
    if (current.length !== wanted.length || current.some((c, i) => c !== wanted[i])) box.replaceChildren(...wanted);

    for (const [key, pane] of panes) if (!wanted.includes(pane)) panes.delete(key);

    const muteBtn = overlay.querySelector(".mute");
    const deafBtn = overlay.querySelector(".deafen");
    const camBtn = overlay.querySelector(".camera");
    muteBtn?.classList.toggle("on", !!MediaEngineStore?.isSelfMute?.());
    if (muteBtn) muteBtn.textContent = MediaEngineStore?.isSelfMute?.() ? "Unmute" : "Mute";
    deafBtn?.classList.toggle("on", !!MediaEngineStore?.isSelfDeaf?.());
    if (deafBtn) deafBtn.textContent = MediaEngineStore?.isSelfDeaf?.() ? "Undeafen" : "Deafen";
    if (camBtn) camBtn.textContent = MediaEngineStore?.isVideoEnabled?.() ? "Camera off" : "Camera";
}

// ---------- Joining / leaving ----------

function callStateFor(channelId: string): MsnCallState {
    const channel = ChannelStore.getChannel(channelId);
    const isDm = channel?.type === DM || channel?.type === GROUP_DM;
    return {
        active: true,
        channelId,
        kind: isDm ? "dm" : "server",
        userId: channel?.type === DM ? channel.recipients?.[0] : undefined
    };
}

function startCallScreen(channelId: string) {
    callChannelId = channelId;
    callStartedAt = Date.now();

    // Put Discord's own call view underneath, so its video tiles (our streams) exist
    const channel = ChannelStore.getChannel(channelId);
    try {
        if (channel?.guild_id) NavigationRouter.transitionTo(`/channels/${channel.guild_id}/${channelId}`);
        else NavigationRouter.transitionTo(`/channels/@me/${channelId}`);
    } catch {}

    if (!overlay) buildOverlay();
    setOverlayHidden(false);
    update();
    tick ??= setInterval(update, 400);

    VesktopNative.msn.callState(callStateFor(channelId)).catch(() => {});
}

function stopCallScreen() {
    callChannelId = null;
    if (tick) clearInterval(tick);
    tick = null;
    overlay?.remove();
    returnBtn?.remove();
    style?.remove();
    overlay = returnBtn = style = null;
    panes.clear();

    VesktopNative.msn.callState({ active: false }).catch(() => {});
}

function checkVoiceChannel() {
    // Only take over the screen in Messenger mode; plain Vesktop keeps Discord's own call UI
    if (Settings.store.msnMode === false) {
        if (callChannelId) stopCallScreen();
        return;
    }

    const current: string | null = SelectedChannelStore?.getVoiceChannelId?.() ?? null;
    if (current === callChannelId) return;
    if (current) startCallScreen(current);
    else stopCallScreen();
}

// ---------- Incoming DM calls ----------

function onCallUpdate({ channelId, ringing }: any) {
    const me = UserStore.getCurrentUser();
    if (!me || !Array.isArray(ringing) || !ringing.includes(me.id)) return;
    if (SelectedChannelStore?.getVoiceChannelId?.() === channelId) return;

    const channel = ChannelStore.getChannel(channelId);
    if (channel?.type !== DM) return;

    VesktopNative.msn.emit({ type: "incomingCall", channelId, userId: channel.recipients?.[0] }).catch(() => {});
}

waitFor(filters.byStoreName("SelectedChannelStore"), () => {
    FluxDispatcher.subscribe("VOICE_CHANNEL_SELECT", () => setTimeout(checkVoiceChannel, 50));
    FluxDispatcher.subscribe("RTC_CONNECTION_STATE", () => setTimeout(checkVoiceChannel, 50));
    FluxDispatcher.subscribe("CALL_CREATE", onCallUpdate);
    FluxDispatcher.subscribe("CALL_UPDATE", onCallUpdate);
    // Safety net for anything the events miss
    setInterval(checkVoiceChannel, 2000);
    // Already in a call when the app starts? Pick it up right away.
    setTimeout(checkVoiceChannel, 0);
});

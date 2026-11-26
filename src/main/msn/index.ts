/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// MSN Messenger mode, main-process side.
// Receives events from the bridge in the hidden Discord window, keeps a copy of
// the contact list, manages the Messenger windows and routes everything between them.

import { join } from "path";

import { BrowserWindow, IpcMainInvokeEvent, shell } from "electron";
import { IpcCommands, IpcEvents } from "shared/IpcEvents";
import type { MsnChatInit, MsnConversation, MsnEvent, MsnPerson, MsnSoundName, MsnState } from "shared/msn";
import { isNudge, MSN_NUDGE_TEXT } from "shared/msn";

import { sendRendererCommand } from "../ipcCommands";
import { mainWin } from "../mainWindow";
import { Settings } from "../settings";
import { handle } from "../utils/ipcWrappers";
import { showWindow } from "../utils/showWindow";
import { loadView } from "../vesktopStatic";
import { ensureMsnAssetsDir, getMsnAssets, MSN_ASSETS_DIR } from "./assets";
import { closeAllToasts, onToastClick, onToastClose, showToast } from "./toasts";

const MAX_MESSAGE_LENGTH = 2000;
/** No sign-in pop-ups right after connecting, when everyone "comes online" at once */
const SIGNIN_TOAST_GRACE_MS = 20_000;
/** Nudges older than this (e.g. in history) don't shake anything */
const NUDGE_FRESH_MS = 60_000;
const NUDGE_COOLDOWN_MS = 8_000;
const ICON = join(__dirname, "..", "..", "static", "msn", "icon.png");

ensureMsnAssetsDir();

let contactsWin: BrowserWindow | undefined;

// Latest known state. Messenger windows get a full copy when they open,
// then small updates as they happen.
let me: MsnPerson | undefined;
const friends = new Map<string, MsnPerson>();
let readyAt = 0;
let signinSoundPending = false;

interface Chat {
    userId: string;
    win: BrowserWindow;
    channelId?: string;
    /** Events that arrived before the window finished loading its history */
    queue: MsnEvent[] | null;
    /** Opened because of a nudge: shake once it appears */
    shakeOnShow?: boolean;
    lastNudgeSent?: number;
}

const chats = new Map<string, Chat>(); // by the other person's user id
const chatByChannel = new Map<string, Chat>();

function currentState(): MsnState | undefined {
    return me && { me, friends: [...friends.values()] };
}

/** True once Discord is logged in and Messenger mode has taken over */
export function isMsnActive() {
    return Settings.store.msnMode !== false && !!me;
}

// Only the real Discord window may feed us events
function fromDiscordWindow(e: IpcMainInvokeEvent) {
    return !!mainWin && !mainWin.isDestroyed() && e.sender === mainWin.webContents;
}

function alive(win: BrowserWindow | undefined): win is BrowserWindow {
    return !!win && !win.isDestroyed();
}

function send(win: BrowserWindow | undefined, channel: string, payload: unknown) {
    if (alive(win) && !win.webContents.isLoading()) win.webContents.send(channel, payload);
}

function pushState() {
    const state = currentState();
    if (state) send(contactsWin, "msn-state", state);
}

function bucketOf(status: string | undefined) {
    if (status === "online" || status === "streaming") return "online";
    if (status === "idle" || status === "dnd") return status;
    return "offline";
}

/** Busy (Do Not Disturb) means no pop-ups and no sounds, like Messenger */
function isBusy() {
    return me?.status === "dnd";
}

function soundsOn() {
    return Settings.store.msnSounds !== false && !isBusy();
}

function toastsOn() {
    return Settings.store.msnToasts !== false && !isBusy();
}

function playIn(win: BrowserWindow | undefined, sound: MsnSoundName) {
    if (!alive(win)) return;
    if (win.webContents.isLoading()) win.webContents.once("did-finish-load", () => send(win, "msn-play", sound));
    else win.webContents.send("msn-play", sound);
}

const shaking = new Set<BrowserWindow>();

/** The nudge: rattle the window around its spot for half a second */
function shake(win: BrowserWindow | undefined) {
    if (!alive(win) || shaking.has(win) || win.isMaximized() || win.isFullScreen()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.showInactive();

    const [x, y] = win.getPosition();
    const offsets = [
        [-10, 0],
        [10, -6],
        [-9, 6],
        [9, 0],
        [-7, -5],
        [7, 5],
        [-4, 0],
        [4, -2],
        [-2, 2],
        [0, 0]
    ];

    shaking.add(win);
    let i = 0;
    const timer = setInterval(() => {
        if (!alive(win) || i >= offsets.length) {
            clearInterval(timer);
            shaking.delete(win);
            if (alive(win)) win.setPosition(x, y);
            return;
        }
        win.setPosition(x + offsets[i][0], y + offsets[i][1]);
        i++;
    }, 35);
}

/** Messenger windows draw their own glass title bar, so they tell the page when they're maximised */
function frameless(win: BrowserWindow) {
    const report = () => send(win, "msn-maximized", win.isMaximized());
    win.on("maximize", report);
    win.on("unmaximize", report);
    win.webContents.on("did-finish-load", report);
}

function msnWebPreferences() {
    return {
        preload: join(__dirname, "msnPreload.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
    };
}

/** Links in Messenger windows open in the real browser, never inside the window */
function guardNavigation(win: BrowserWindow) {
    const openExternal = (url: string) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    };

    win.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
        if (url.startsWith("vesktop://")) return;
        e.preventDefault();
        openExternal(url);
    });
}

// ---------- Contact list window ----------

export function openMsnWindow() {
    if (alive(contactsWin)) {
        showWindow(contactsWin);
        return contactsWin;
    }

    const win = (contactsWin = new BrowserWindow({
        title: "Messenger",
        width: 340,
        height: 680,
        minWidth: 270,
        minHeight: 420,
        frame: false,
        icon: ICON,
        autoHideMenuBar: true,
        backgroundColor: "#8ccbec",
        webPreferences: msnWebPreferences()
    }));

    win.setMenuBarVisibility(false);
    frameless(win);
    guardNavigation(win);
    win.webContents.on("did-finish-load", () => {
        pushState();
        // Your own "you're signed in" sound, once per sign-in
        if (signinSoundPending) {
            signinSoundPending = false;
            if (soundsOn()) playIn(win, "signin");
        }
    });
    win.on("closed", () => {
        if (contactsWin === win) contactsWin = undefined;
    });

    loadView(win, "msn/contacts.html");
    return win;
}

// ---------- Chat windows ----------

function chatForSender(e: IpcMainInvokeEvent) {
    for (const chat of chats.values()) if (alive(chat.win) && chat.win.webContents === e.sender) return chat;
}

function deliverToChat(chat: Chat, event: MsnEvent) {
    if (chat.queue) chat.queue.push(event);
    else send(chat.win, "msn-event", event);
}

/**
 * Open (or bring up) the conversation with someone.
 * `quiet` is for incoming messages: the window appears without stealing focus and flashes instead.
 */
async function openChat(userId: string, quiet = false, nudged = false) {
    const existing = chats.get(userId);
    if (existing && alive(existing.win)) {
        if (quiet) {
            if (!existing.win.isFocused()) existing.win.flashFrame(true);
        } else {
            showWindow(existing.win);
            existing.win.focus();
        }
        return;
    }

    const known = friends.get(userId);
    const win = new BrowserWindow({
        title: `${known?.displayName ?? "Conversation"} - Conversation`,
        width: 600,
        height: 520,
        minWidth: 420,
        minHeight: 400,
        show: false,
        frame: false,
        icon: ICON,
        autoHideMenuBar: true,
        backgroundColor: "#8ccbec",
        webPreferences: msnWebPreferences()
    });
    frameless(win);

    const chat: Chat = { userId, win, queue: [], shakeOnShow: nudged };
    chats.set(userId, chat);

    win.setMenuBarVisibility(false);
    guardNavigation(win);
    win.on("focus", () => win.flashFrame(false));
    win.on("closed", () => {
        if (chats.get(userId) === chat) chats.delete(userId);
        if (chat.channelId && chatByChannel.get(chat.channelId) === chat) chatByChannel.delete(chat.channelId);
    });
    win.once("ready-to-show", () => {
        if (quiet) {
            win.showInactive();
            win.flashFrame(true);
        } else {
            win.show();
        }

        if (chat.shakeOnShow) {
            chat.shakeOnShow = false;
            setTimeout(() => {
                shake(win);
                if (soundsOn()) playIn(win, "nudge");
            }, 200);
        }
    });

    const loaded = new Promise<void>(resolve => win.webContents.once("did-finish-load", () => resolve()));
    loadView(win, "msn/chat.html");

    let init: MsnChatInit;
    try {
        const convo = await sendRendererCommand<MsnConversation>(IpcCommands.MSN_GET_CONVERSATION, userId);
        chat.channelId = convo.channelId;
        chatByChannel.set(convo.channelId, chat);
        init = { me: me!, ...convo };
    } catch (err) {
        console.error("[MSN] couldn't open conversation", err);
        init = {
            me: me!,
            friend: known ?? { id: userId, username: userId, displayName: userId, avatarUrl: "", status: "offline", customStatus: "" },
            error: `Couldn't load this conversation from Discord.\n${err instanceof Error ? err.message : String(err)}\n\nYou can still use “Show in Discord”.`
        };
    }

    await loaded;
    if (!alive(win)) return;

    win.setTitle(`${init.friend.displayName} - Conversation`);
    win.webContents.send("msn-chat-init", init);

    const queued = chat.queue ?? [];
    chat.queue = null;
    for (const event of queued) win.webContents.send("msn-event", event);
}

function closeAllChats() {
    for (const chat of chats.values()) if (alive(chat.win)) chat.win.close();
    chats.clear();
    chatByChannel.clear();
}

// ---------- Routing events from Discord ----------

function previewOf(event: Extract<MsnEvent, { type: "message" }>) {
    const text = event.content.replace(/\s+/g, " ").trim();
    if (text) return text.length > 120 ? text.slice(0, 117) + "…" : text;
    return event.attachments.length ? "sent an attachment" : "sent something";
}

function routeMessage(event: Extract<MsnEvent, { type: "message" }>) {
    // Group DMs stay in Discord for now
    if (event.isGroup) return;

    const userId = event.fromMe ? chatByChannel.get(event.channelId)?.userId : event.authorId;
    if (!userId) return;

    const chat = chats.get(userId);
    const hasWindow = !!chat && alive(chat.win);
    const incoming = !event.fromMe && !event.pending;

    if (hasWindow) deliverToChat(chat!, event);
    if (!incoming) return;

    // ---- Nudge: shake the conversation, opening it if needed ----
    if (isNudge(event.content) && Date.now() - Date.parse(event.timestamp) < NUDGE_FRESH_MS) {
        if (hasWindow) {
            if (!chat!.win.isFocused()) chat!.win.flashFrame(true);
            shake(chat!.win);
            if (soundsOn()) playIn(chat!.win, "nudge");
        } else if (Settings.store.msnMode !== false && me) {
            openChat(userId, true, true);
        }
        return;
    }

    if (hasWindow && chat!.win.isFocused()) return;

    // ---- Someone messaged you and you're not looking at their window ----
    if (hasWindow) chat!.win.flashFrame(true);
    else if (Settings.store.msnMode !== false && me) openChat(userId, true); // history load includes this message

    const person = friends.get(userId) ?? {
        id: userId,
        username: event.authorName,
        displayName: event.authorName,
        avatarUrl: "",
        status: "online",
        customStatus: ""
    };

    if (toastsOn()) {
        showToast(
            { title: `${person.displayName} says:`, body: previewOf(event), person, sound: soundsOn() ? "message" : null },
            "message:" + userId,
            () => openChat(userId)
        );
    } else if (soundsOn()) {
        playIn(chats.get(userId)?.win, "message");
    }
}

handle(IpcEvents.MSN_READY, (e, state: MsnState) => {
    if (!fromDiscordWindow(e)) return;

    me = state.me;
    friends.clear();
    for (const f of state.friends) friends.set(f.id, f);

    console.log(`[MSN] signed in as ${me.displayName} (${friends.size} friends)`);
    readyAt = Date.now();
    signinSoundPending = true;

    if (Settings.store.msnMode === false) return;

    mainWin.hide();
    openMsnWindow();
    pushState();
});

handle(IpcEvents.MSN_LOGGED_OUT, e => {
    if (!fromDiscordWindow(e)) return;

    console.log("[MSN] logged out, handing back to Discord");
    me = undefined;
    friends.clear();
    closeAllChats();
    closeAllToasts();
    contactsWin?.close();
    showWindow(mainWin);
});

handle(IpcEvents.MSN_EVENT, (e, event: MsnEvent) => {
    if (!fromDiscordWindow(e)) return;
    if (IS_DEV) console.log("[MSN]", event.type, JSON.stringify(event).slice(0, 300));

    switch (event.type) {
        case "message":
            routeMessage(event);
            return;

        case "messageFailed": {
            const chat = chatByChannel.get(event.channelId);
            if (chat) deliverToChat(chat, event);
            return;
        }

        case "typing": {
            const chat = chats.get(event.userId);
            if (chat && chat.channelId === event.channelId) deliverToChat(chat, event);
            return;
        }

        case "presence": {
            const friend = friends.get(event.userId);
            const cameOnline =
                !!friend && bucketOf(friend.status) === "offline" && bucketOf(event.status) !== "offline";
            if (friend) {
                friend.status = event.status;
                friend.customStatus = event.customStatus;
            }

            if (cameOnline && toastsOn() && Date.now() - readyAt > SIGNIN_TOAST_GRACE_MS) {
                showToast(
                    { title: friend!.displayName, body: "has just signed in.", person: friend!, sound: soundsOn() ? "online" : null },
                    "signin:" + event.userId,
                    () => openChat(event.userId)
                );
            }
            send(contactsWin, "msn-event", event);
            const chat = chats.get(event.userId);
            if (chat) deliverToChat(chat, event);
            return;
        }

        case "friends":
            friends.clear();
            for (const f of event.friends) friends.set(f.id, f);
            pushState();
            return;

        case "self":
            me = event.me;
            pushState();
            for (const chat of chats.values()) deliverToChat(chat, event);
            return;
    }
});

// ---------- Requests from Messenger windows ----------

handle(IpcEvents.MSN_SHOW_DISCORD, () => {
    showWindow(mainWin);
    mainWin.setSkipTaskbar(false);
});

handle(IpcEvents.MSN_OPEN_CHAT, (_e, userId: string) => {
    if (typeof userId !== "string" || !/^\d{5,25}$/.test(userId) || !me) return;
    openChat(userId);
});

handle(IpcEvents.MSN_SEND, async (e, content: string) => {
    const chat = chatForSender(e);
    if (!chat?.channelId) throw new Error("This conversation isn't connected yet");
    if (typeof content !== "string" || !content.trim()) return;
    if (content.length > MAX_MESSAGE_LENGTH) throw new Error(`Messages can be at most ${MAX_MESSAGE_LENGTH} characters`);

    await sendRendererCommand(IpcCommands.MSN_SEND_MESSAGE, { channelId: chat.channelId, content });
});

handle(IpcEvents.MSN_TYPING, e => {
    const chat = chatForSender(e);
    if (chat?.channelId) sendRendererCommand(IpcCommands.MSN_START_TYPING, chat.channelId).catch(() => {});
});

handle(IpcEvents.MSN_CHAT_SHOW_IN_DISCORD, async e => {
    const chat = chatForSender(e);
    if (!chat) return;

    await sendRendererCommand(IpcCommands.MSN_OPEN_DM, chat.userId).catch(err =>
        console.error("[MSN] failed to open DM", err)
    );
    showWindow(mainWin);
    mainWin.setSkipTaskbar(false);
});

handle(IpcEvents.MSN_NUDGE, async e => {
    const chat = chatForSender(e);
    if (!chat?.channelId) throw new Error("This conversation isn't connected yet");

    const now = Date.now();
    if (chat.lastNudgeSent && now - chat.lastNudgeSent < NUDGE_COOLDOWN_MS) {
        throw new Error("You can't send a nudge that often. Wait a few seconds.");
    }
    chat.lastNudgeSent = now;

    await sendRendererCommand(IpcCommands.MSN_SEND_MESSAGE, { channelId: chat.channelId, content: MSN_NUDGE_TEXT });
    shake(chat.win);
    if (Settings.store.msnSounds !== false) playIn(chat.win, "nudge");
});

handle(IpcEvents.MSN_GET_ASSETS, () => getMsnAssets());

handle(IpcEvents.MSN_SET_STATUS, async (e, status: string) => {
    if (e.sender !== contactsWin?.webContents || !me) return;
    await sendRendererCommand(IpcCommands.MSN_CMD_SET_STATUS, status);
    // Show it right away; Discord's own update follows and confirms it
    me = { ...me, status };
    pushState();
    for (const chat of chats.values()) deliverToChat(chat, { type: "self", me });
});

handle(IpcEvents.MSN_SET_CUSTOM_STATUS, async (e, text: string) => {
    if (e.sender !== contactsWin?.webContents || !me || typeof text !== "string") return;
    await sendRendererCommand(IpcCommands.MSN_CMD_SET_CUSTOM_STATUS, text.slice(0, 128));
    me = { ...me, customStatus: text.trim().slice(0, 128) };
    pushState();
    for (const chat of chats.values()) deliverToChat(chat, { type: "self", me });
});
handle(IpcEvents.MSN_TOAST_CLICK, onToastClick);
handle(IpcEvents.MSN_TOAST_CLOSE, onToastClose);

export function openMsnAssetsFolder() {
    ensureMsnAssetsDir();
    shell.openPath(MSN_ASSETS_DIR);
}

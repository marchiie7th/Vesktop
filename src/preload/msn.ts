/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Preload for the Messenger windows (contact list, chats, toasts). These are local pages,
// not Discord, so they only get this small, explicit API.

import { contextBridge, ipcRenderer } from "electron/renderer";
import type { MsnAssets, MsnChatInit, MsnEvent, MsnSoundName, MsnState, MsnToast } from "shared/msn";

import { IpcEvents } from "../shared/IpcEvents";

contextBridge.exposeInMainWorld("MsnNative", {
    // ---- contact list ----
    /** Full snapshot: on open, and whenever the friends list or your own status changes */
    onState(callback: (state: MsnState) => void) {
        ipcRenderer.on("msn-state", (_, state: MsnState) => callback(state));
    },
    showDiscord: () => ipcRenderer.invoke(IpcEvents.MSN_SHOW_DISCORD),
    openChat: (userId: string) => ipcRenderer.invoke(IpcEvents.MSN_OPEN_CHAT, userId),
    setStatus: (status: string) => ipcRenderer.invoke(IpcEvents.MSN_SET_STATUS, status),
    setCustomStatus: (text: string) => ipcRenderer.invoke(IpcEvents.MSN_SET_CUSTOM_STATUS, text),

    // ---- every window ----
    /** Small live updates: presence, messages, typing */
    onEvent(callback: (event: MsnEvent) => void) {
        ipcRenderer.on("msn-event", (_, event: MsnEvent) => callback(event));
    },
    /** The main process decides when a sound should play (respects Busy and the sounds setting) */
    onPlay(callback: (sound: MsnSoundName) => void) {
        ipcRenderer.on("msn-play", (_, sound: MsnSoundName) => callback(sound));
    },
    getAssets: () => ipcRenderer.invoke(IpcEvents.MSN_GET_ASSETS) as Promise<MsnAssets>,

    // Glass title bar buttons (Messenger windows have no Windows frame)
    minimize: () => ipcRenderer.invoke(IpcEvents.MINIMIZE),
    maximize: () => ipcRenderer.invoke(IpcEvents.MAXIMIZE),
    close: () => ipcRenderer.invoke(IpcEvents.CLOSE),
    onMaximized(callback: (maximized: boolean) => void) {
        ipcRenderer.on("msn-maximized", (_, maximized: boolean) => callback(maximized));
    },

    // ---- chat windows ----
    /** Who you're talking to, plus recent history */
    onChatInit(callback: (init: MsnChatInit) => void) {
        ipcRenderer.on("msn-chat-init", (_, init: MsnChatInit) => callback(init));
    },
    sendMessage: (content: string) => ipcRenderer.invoke(IpcEvents.MSN_SEND, content),
    nudge: () => ipcRenderer.invoke(IpcEvents.MSN_NUDGE),
    typing: () => ipcRenderer.invoke(IpcEvents.MSN_TYPING),
    showInDiscord: () => ipcRenderer.invoke(IpcEvents.MSN_CHAT_SHOW_IN_DISCORD),

    // ---- toasts ----
    onToast(callback: (toast: MsnToast) => void) {
        ipcRenderer.on("msn-toast", (_, toast: MsnToast) => callback(toast));
    },
    toastClick: () => ipcRenderer.invoke(IpcEvents.MSN_TOAST_CLICK),
    toastClose: () => ipcRenderer.invoke(IpcEvents.MSN_TOAST_CLOSE)
});

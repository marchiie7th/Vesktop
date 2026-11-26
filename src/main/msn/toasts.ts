/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Corner pop-ups ("toasts"): "X has just signed in." / "X says: …".
// Each is a tiny window stacked up from the bottom-right of the screen. They never take focus.

import { join } from "path";

import { BrowserWindow, IpcMainInvokeEvent, screen } from "electron";
import type { MsnToast } from "shared/msn";

import { loadView } from "../vesktopStatic";

const WIDTH = 270;
const HEIGHT = 100;
const GAP = 8;
const MARGIN = 12;
const MAX_VISIBLE = 3;
const LIFETIME_MS = 7000;

interface Toast {
    win: BrowserWindow;
    /** Toasts with the same key replace each other (e.g. several messages from one person) */
    key: string;
    onClick?: () => void;
    timer: NodeJS.Timeout;
}

const toasts: Toast[] = [];

function alive(t: Toast) {
    return !t.win.isDestroyed();
}

function slot(index: number) {
    const { workArea } = screen.getPrimaryDisplay();
    return {
        x: Math.round(workArea.x + workArea.width - WIDTH - MARGIN),
        y: Math.round(workArea.y + workArea.height - MARGIN - (HEIGHT + GAP) * (index + 1) + GAP)
    };
}

function relayout() {
    toasts.forEach((t, i) => {
        if (!alive(t)) return;
        const { x, y } = slot(i);
        t.win.setPosition(x, y);
    });
}

function closeToast(toast: Toast) {
    clearTimeout(toast.timer);
    const i = toasts.indexOf(toast);
    if (i >= 0) toasts.splice(i, 1);
    if (alive(toast)) toast.win.close();
    relayout();
}

export function showToast(data: MsnToast, key: string, onClick?: () => void) {
    // One toast per key: a newer message from the same person replaces the older pop-up
    const existing = toasts.find(t => t.key === key);
    if (existing) closeToast(existing);
    while (toasts.length >= MAX_VISIBLE) closeToast(toasts[0]);

    const { x, y } = slot(toasts.length);
    const win = new BrowserWindow({
        width: WIDTH,
        height: HEIGHT,
        x,
        y,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        focusable: false,
        show: false,
        webPreferences: {
            preload: join(__dirname, "msnPreload.js"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.setAlwaysOnTop(true, "pop-up-menu");

    const toast: Toast = { win, key, onClick, timer: setTimeout(() => closeToast(toast), LIFETIME_MS) };
    toasts.push(toast);

    win.on("closed", () => {
        const i = toasts.indexOf(toast);
        if (i >= 0) {
            toasts.splice(i, 1);
            relayout();
        }
    });
    win.webContents.once("did-finish-load", () => {
        if (win.isDestroyed()) return;
        win.webContents.send("msn-toast", data);
        win.showInactive();
    });

    loadView(win, "msn/toast.html");
}

function toastForSender(e: IpcMainInvokeEvent) {
    return toasts.find(t => alive(t) && t.win.webContents === e.sender);
}

export function onToastClick(e: IpcMainInvokeEvent) {
    const toast = toastForSender(e);
    if (!toast) return;
    toast.onClick?.();
    closeToast(toast);
}

export function onToastClose(e: IpcMainInvokeEvent) {
    const toast = toastForSender(e);
    if (toast) closeToast(toast);
}

export function closeAllToasts() {
    for (const t of [...toasts]) closeToast(t);
}

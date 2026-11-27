/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Data the MSN bridge (running inside the hidden Discord window) sends to the main process.
// Keep everything plain & serialisable: it crosses IPC twice.

/** Discord's raw status values. Messenger shows them as Available / Away / Busy / Offline. */
export type MsnStatus = "online" | "idle" | "dnd" | "offline" | "invisible" | "streaming" | string;

export interface MsnPerson {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    status: MsnStatus;
    /** Discord custom status, shown as the MSN "personal message" */
    customStatus: string;
}

export interface MsnState {
    me: MsnPerson;
    friends: MsnPerson[];
}

/** Kept for step 1 naming: the bridge announces itself with a full state snapshot. */
export type MsnReadyInfo = MsnState;

export interface MsnAttachment {
    filename: string;
    url: string;
    isImage: boolean;
}

export interface MsnMessage {
    id: string;
    /** Set on messages you send; links the "sending…" copy to the delivered one */
    nonce?: string;
    channelId: string;
    authorId: string;
    authorName: string;
    content: string;
    attachments: MsnAttachment[];
    timestamp: string;
    fromMe: boolean;
    /** Your message, still on its way to Discord */
    pending: boolean;
    /** Group DM (3+ people). Messenger chat windows only handle 1:1 for now. */
    isGroup: boolean;
    /** Set for server channel messages */
    guildId?: string;
}

/** What a chat window needs to open: who, which DM channel, and recent history */
export interface MsnConversation {
    channelId: string;
    friend: MsnPerson;
    messages: MsnMessage[];
}

export interface MsnChatInit extends Partial<MsnConversation> {
    me: MsnPerson;
    friend: MsnPerson;
    error?: string;
    /** "channel" when this window is a server channel; then `channel` is set */
    mode?: "dm" | "channel";
    channel?: MsnChannelInfo;
}

export type MsnEvent =
    | ({ type: "message" } & MsnMessage)
    | {
          type: "messageFailed";
          channelId: string;
          messageId: string;
      }
    | {
          type: "typing";
          channelId: string;
          userId: string;
          userName: string;
          guildId?: string;
      }
    | {
          type: "presence";
          userId: string;
          userName: string;
          status: MsnStatus;
          customStatus: string;
      }
    | {
          /** Friends list changed (added / removed / renamed): full replacement */
          type: "friends";
          friends: MsnPerson[];
      }
    | {
          /** Your own status / personal message changed */
          type: "self";
          me: MsnPerson;
      }
    | {
          /** Someone is calling you in a DM */
          type: "incomingCall";
          channelId: string;
          userId: string;
      };

// ---------- Calls ----------

/** Sent by the call screen in the Discord window when you join or leave a call */
export interface MsnCallState {
    active: boolean;
    channelId?: string;
    kind?: "dm" | "server";
    /** DM calls: the other person */
    userId?: string;
}

// ---------- Step 4: the MSN feel ----------

/**
 * Nudges travel as a normal Discord message, so people on plain Discord see something sensible.
 * Messenger recognises this exact text and shakes the window instead.
 */
export const MSN_NUDGE_TEXT = "🫨 *sent a nudge!*";

export function isNudge(content: string | undefined) {
    return content?.trim() === MSN_NUDGE_TEXT;
}

export type MsnSoundName = "signin" | "online" | "message" | "nudge";
export type MsnFrameName = "online" | "idle" | "dnd" | "offline";

/** What the user put in their msn-assets folder (vesktop://msn-assets/... urls, or null if missing) */
export interface MsnAssets {
    sounds: Record<MsnSoundName, string | null>;
    frames: Record<MsnFrameName, string | null>;
    /** text code -> image url, from emoticons/emoticons.json */
    emoticons: Record<string, string>;
    /** msn-assets/style.css, applied to every Messenger window */
    css: string | null;
    /** msn-assets/scene.(png|jpg|...), the banner behind your name on the contact list */
    scene: string | null;
}

export type MsnContactsView = "compact" | "full";

// ---------- Servers ----------

export interface MsnServer {
    id: string;
    name: string;
    iconUrl: string;
}

export interface MsnChannel {
    id: string;
    name: string;
    kind: "text" | "voice";
    /** Category name, or "" for channels outside any category */
    category: string;
    /** People currently in a voice channel */
    voiceCount?: number;
}

export interface MsnChannelInfo {
    id: string;
    name: string;
    topic: string;
    guildId: string;
    guildName: string;
    guildIconUrl: string;
}

/** What a channel chat window needs to open */
export interface MsnChannelConversation {
    channelId: string;
    channel: MsnChannelInfo;
    messages: MsnMessage[];
}

export interface MsnToast {
    title: string;
    body: string;
    person: MsnPerson;
    sound: MsnSoundName | null;
}

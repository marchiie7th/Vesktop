/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// MSN bridge: runs inside the (hidden) Discord window. It listens to Discord's own
// event bus and forwards what Messenger cares about to the main process, and it
// carries out Messenger's requests (load a chat, send a message, show typing) by
// calling Discord's own client code — exactly what clicking around in Discord does.

import { filters, waitFor } from "@vencord/types/webpack";
import {
    ChannelStore,
    FluxDispatcher,
    NavigationRouter,
    RelationshipStore,
    UserStore
} from "@vencord/types/webpack/common";
import { IpcCommands } from "shared/IpcEvents";
import type {
    MsnAttachment,
    MsnChannel,
    MsnChannelConversation,
    MsnConversation,
    MsnEvent,
    MsnMessage,
    MsnPerson,
    MsnServer,
    MsnState
} from "shared/msn";
import { debounce } from "shared/utils/debounce";
import { sleep } from "shared/utils/sleep";

import { onIpcCommand } from "../ipcCommands";
import { VesktopLogger } from "../logger";

// Not everything is in Vencord's typed "common" list, so grab these by name / shape.
let PresenceStore: any;
let MessageStore: any;
let MessageActions: any;
let TypingActions: any;
let PrivateChannelActions: any;
let GuildStore: any;
let SortedGuildStore: any;
let GuildChannelStore: any;
let GuildMemberStore: any;
let VoiceStateStore: any;
waitFor(filters.byStoreName("PresenceStore"), s => (PresenceStore = s));
waitFor(filters.byStoreName("MessageStore"), s => (MessageStore = s));
waitFor(filters.byProps("sendMessage", "fetchMessages"), m => (MessageActions = m));
waitFor(filters.byProps("startTyping", "stopTyping"), m => (TypingActions = m));
waitFor(filters.byProps("openPrivateChannel"), m => (PrivateChannelActions = m));
waitFor(filters.byStoreName("GuildStore"), s => (GuildStore = s));
waitFor(filters.byStoreName("SortedGuildStore"), s => (SortedGuildStore = s));
waitFor(filters.byStoreName("GuildChannelStore"), s => (GuildChannelStore = s));
waitFor(filters.byStoreName("GuildMemberStore"), s => (GuildMemberStore = s));
waitFor(filters.byStoreName("VoiceStateStore"), s => (VoiceStateStore = s));

const VencordUtil = () => (window as any).Vencord?.Util ?? {};

// Discord channel types: 1 = DM, 3 = group DM
const DM = 1;
const GROUP_DM = 3;
// Server channels Messenger can chat in: text and announcement
const SERVER_TEXT = new Set([0, 5]);
// Voice and stage channels
const SERVER_VOICE = new Set([2, 13]);
// Discord activity type 4 = custom status
const CUSTOM_STATUS = 4;
const HISTORY_LIMIT = 50;

function channelType(channelId: string) {
    return ChannelStore.getChannel(channelId)?.type;
}

function isDirectMessage(channelId: string) {
    const type = channelType(channelId);
    return type === DM || type === GROUP_DM;
}

function displayNameOf(userId: string, fallback?: { username?: string; global_name?: string | null }) {
    const user = UserStore.getUser(userId) as any;
    const nickname = (RelationshipStore as any).getNickname?.(userId);
    return nickname || user?.globalName || user?.username || fallback?.global_name || fallback?.username || userId;
}

function customStatusOf(activities: any[] | undefined) {
    const custom = activities?.find(a => a?.type === CUSTOM_STATUS);
    if (!custom) return "";

    // Unicode emoji only; custom server emoji have an id and are just images we can't show as text
    const emoji = custom.emoji && !custom.emoji.id ? custom.emoji.name : "";
    return [emoji, custom.state].filter(Boolean).join(" ");
}

function avatarOf(userId: string) {
    const user = UserStore.getUser(userId) as any;
    try {
        return user?.getAvatarURL?.(undefined, 128, false) ?? "";
    } catch {
        return "";
    }
}

function personOf(userId: string, status?: string, activities?: any[]): MsnPerson {
    const user = UserStore.getUser(userId) as any;
    return {
        id: userId,
        username: user?.username ?? userId,
        displayName: displayNameOf(userId),
        avatarUrl: avatarOf(userId),
        status: status ?? PresenceStore?.getStatus?.(userId) ?? "offline",
        customStatus: customStatusOf(activities ?? PresenceStore?.getActivities?.(userId))
    };
}

function friendsSnapshot() {
    return RelationshipStore.getFriendIDs().map(id => personOf(id));
}

/** Turn Discord markup that means nothing outside Discord into readable text */
function cleanContent(content: string) {
    return content
        .replace(/<@!?(\d+)>/g, (_, id) => "@" + displayNameOf(id))
        .replace(/<@&(\d+)>/g, "@role")
        .replace(/<#(\d+)>/g, (_, id) => "#" + (ChannelStore.getChannel(id)?.name ?? "channel"))
        .replace(/<a?:(\w+):\d+>/g, ":$1:")
        .replace(/<t:(\d+)(?::\w)?>/g, (_, s) => new Date(Number(s) * 1000).toLocaleString());
}

function attachmentsOf(message: any): MsnAttachment[] {
    return (message.attachments ?? []).map((a: any) => ({
        filename: a.filename ?? "file",
        url: a.url ?? a.proxy_url ?? "",
        isImage: /^image\//.test(a.content_type ?? "") || /\.(png|jpe?g|gif|webp)$/i.test(a.filename ?? "")
    }));
}

/** Server nickname if they have one there, otherwise their usual name */
function nameIn(guildId: string | undefined, userId: string, fallback?: any) {
    if (guildId) {
        const nick = GuildMemberStore?.getNick?.(guildId, userId);
        if (nick) return nick;
    }
    return displayNameOf(userId, fallback);
}

/** Normalise both raw gateway messages and MessageStore records */
function toMsnMessage(message: any, channelId: string, pending = false): MsnMessage {
    const author = message.author ?? {};
    const guildId: string | undefined = ChannelStore.getChannel(channelId)?.guild_id ?? undefined;
    const me = UserStore.getCurrentUser();
    const when = new Date(
        typeof message.timestamp === "string" ? message.timestamp : Number(message.timestamp ?? Date.now())
    );

    return {
        id: String(message.id),
        nonce: message.nonce ? String(message.nonce) : undefined,
        channelId,
        authorId: author.id,
        authorName: nameIn(guildId, author.id, author),
        content: cleanContent(message.content ?? ""),
        attachments: attachmentsOf(message),
        timestamp: (isNaN(when.getTime()) ? new Date() : when).toISOString(),
        fromMe: author.id === me?.id,
        pending,
        isGroup: channelType(channelId) === GROUP_DM,
        guildId
    };
}

function emit(event: MsnEvent) {
    VesktopNative.msn.emit(event).catch(e => VesktopLogger.error("[MSN] failed to forward event", e));
}

// Last forwarded status per friend. Presence updates arrive once per shared server,
// so we only pass along real changes.
const lastPresence = new Map<string, string>();
let connected = false;

const sendFriends = debounce(() => {
    if (!connected) return;

    const friends = friendsSnapshot();
    for (const f of friends) lastPresence.set(f.id, f.status + "\0" + f.customStatus);
    emit({ type: "friends", friends });
}, 300);

function sendReady() {
    const me = UserStore.getCurrentUser();
    if (!me) return;

    connected = true;
    const friends = friendsSnapshot();
    lastPresence.clear();
    for (const f of friends) lastPresence.set(f.id, f.status + "\0" + f.customStatus);

    const state: MsnState = { me: personOf(me.id, PresenceStore?.getStatus?.(me.id) ?? "online"), friends };
    VesktopNative.msn.ready(state);

    // Safety net in case the supplemental burst was missed or arrived early
    setTimeout(sendFriends, 5000);
}

// ---------- Discord -> Messenger ----------

/** Server channels that have a Messenger window open. Only these get forwarded. */
const watched = new Set<string>();

function onMessageCreate({ channelId, message, optimistic }: any) {
    if (!message?.author || !(isDirectMessage(channelId) || watched.has(channelId))) return;

    // Optimistic copies are only interesting for our own messages ("sending…")
    const me = UserStore.getCurrentUser();
    if (optimistic && message.author.id !== me?.id) return;

    emit({ type: "message", ...toMsnMessage(message, channelId, !!optimistic) });
}

function onMessageSendFailed({ channelId, messageId }: any) {
    if (!channelId || !messageId || !(isDirectMessage(channelId) || watched.has(channelId))) return;
    emit({ type: "messageFailed", channelId, messageId: String(messageId) });
}

function onTypingStart({ channelId, userId }: any) {
    if (userId === UserStore.getCurrentUser()?.id) return;

    if (isDirectMessage(channelId)) {
        emit({ type: "typing", channelId, userId, userName: displayNameOf(userId) });
    } else if (watched.has(channelId)) {
        const guildId = ChannelStore.getChannel(channelId)?.guild_id;
        emit({ type: "typing", channelId, userId, userName: nameIn(guildId, userId), guildId });
    }
}

function onPresenceUpdates({ updates }: any) {
    for (const update of updates ?? []) {
        const userId = update?.user?.id;
        if (!userId || !RelationshipStore.isFriend(userId)) continue;

        const status = update.status ?? "offline";
        const customStatus = customStatusOf(update.activities);
        const key = status + "\0" + customStatus;
        if (lastPresence.get(userId) === key) continue;

        lastPresence.set(userId, key);
        emit({ type: "presence", userId, userName: displayNameOf(userId, update.user), status, customStatus });
    }
}

function onSelfPresence({ status, activities }: any) {
    const me = UserStore.getCurrentUser();
    if (!me || !connected) return;

    emit({ type: "self", me: personOf(me.id, status, activities) });
}

function onLogout() {
    connected = false;
    lastPresence.clear();
    VesktopNative.msn.loggedOut();
}

// ---------- Messenger -> Discord ----------

/** Find the DM channel with a user, asking Discord to open one if it doesn't exist yet */
async function ensureDmChannel(userId: string) {
    let channelId = ChannelStore.getDMFromUserId(userId);
    if (channelId) return channelId;

    // Same thing Discord's "Message" button does. Try the ways different Discord/Vencord versions expose it.
    try {
        if (typeof PrivateChannelActions?.ensurePrivateChannel === "function") {
            const id = await PrivateChannelActions.ensurePrivateChannel(userId);
            if (typeof id === "string") return id;
        } else if (typeof PrivateChannelActions?.openPrivateChannel === "function") {
            // Navigates the hidden Discord window to the new DM: invisible, and harmless
            PrivateChannelActions.openPrivateChannel(userId);
        } else if (typeof VencordUtil().openPrivateChannel === "function") {
            VencordUtil().openPrivateChannel(userId);
        } else {
            throw new Error("couldn't find Discord's 'open DM' function");
        }
    } catch (e) {
        throw new Error(`Discord refused to open a DM: ${e instanceof Error ? e.message : e}`);
    }

    for (let i = 0; i < 50 && !channelId; i++) {
        await sleep(100);
        channelId = ChannelStore.getDMFromUserId(userId);
    }
    if (!channelId) throw new Error("Discord didn't open the DM in time");
    return channelId;
}

async function loadHistory(channelId: string): Promise<MsnMessage[]> {
    if (!MessageStore) return [];

    let messages = MessageStore.getMessages(channelId);
    if (!messages?.ready || messages.length === 0) {
        try {
            await MessageActions?.fetchMessages?.({ channelId, limit: HISTORY_LIMIT });
        } catch (e) {
            VesktopLogger.warn("[MSN] couldn't fetch history", e);
        }
        for (let i = 0; i < 30; i++) {
            messages = MessageStore.getMessages(channelId);
            if (messages?.ready) break;
            await sleep(100);
        }
    }

    const list: any[] = messages?.toArray?.() ?? [];
    const result: MsnMessage[] = [];
    for (const m of list.slice(-HISTORY_LIMIT)) {
        // One odd message shouldn't stop the whole conversation from opening
        try {
            result.push(toMsnMessage(m, channelId, m.state === "SENDING"));
        } catch (e) {
            VesktopLogger.warn("[MSN] skipped a message Messenger couldn't read", e);
        }
    }
    return result;
}

onIpcCommand(IpcCommands.MSN_GET_CONVERSATION, async (userId: string): Promise<MsnConversation> => {
    const channelId = await ensureDmChannel(userId);

    let messages: MsnMessage[] = [];
    try {
        messages = await loadHistory(channelId);
    } catch (e) {
        VesktopLogger.error("[MSN] couldn't load history", e);
    }

    return { channelId, friend: personOf(userId), messages };
});

onIpcCommand(IpcCommands.MSN_SEND_MESSAGE, async ({ channelId, content }: { channelId: string; content: string }) => {
    if (channelType(channelId) !== DM && !watched.has(channelId)) throw new Error("This channel isn't open in Messenger");

    const send = VencordUtil().sendMessage;
    if (typeof send === "function") return void (await send(channelId, { content }, true));

    // Fallback: Discord's own message action, same as pressing Enter in Discord
    await MessageActions.sendMessage(
        channelId,
        { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] },
        undefined,
        {}
    );
});

onIpcCommand(IpcCommands.MSN_START_TYPING, (channelId: string) => {
    if (channelType(channelId) !== DM && !watched.has(channelId)) return;
    TypingActions?.startTyping?.(channelId);
});

// ---- Your status & personal message, through Discord's own user settings (what the status menu uses) ----

const SETTABLE_STATUSES = new Set(["online", "idle", "dnd", "invisible"]);

function userSetting(group: string, name: string) {
    const setting = (window as any).Vencord?.Api?.UserSettings?.getUserSettingLazy?.(group, name);
    if (!setting || typeof setting.updateSetting !== "function") {
        throw new Error("Couldn't reach Discord's status setting from here");
    }
    return setting;
}

onIpcCommand(IpcCommands.MSN_CMD_SET_STATUS, async (status: string) => {
    if (!SETTABLE_STATUSES.has(status)) throw new Error(`Unknown status: ${status}`);
    await userSetting("status", "status").updateSetting(status);
});

onIpcCommand(IpcCommands.MSN_CMD_SET_CUSTOM_STATUS, async (text: string) => {
    const setting = userSetting("status", "customStatus");
    const clean = String(text ?? "").trim().slice(0, 128);

    // Keep whatever emoji you already had on your custom status
    const current = setting.getSetting?.();
    await setting.updateSetting(
        clean || current?.emojiName || (current?.emojiId && current.emojiId !== "0")
            ? {
                  text: clean,
                  emojiId: current?.emojiId ?? "0",
                  emojiName: current?.emojiName ?? "",
                  expiresAtMs: "0",
                  createdAtMs: String(Date.now())
              }
            : undefined
    );
});

// ---------- Servers ----------

function guildIconUrl(guild: any) {
    return guild?.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : "";
}

onIpcCommand(IpcCommands.MSN_CMD_GET_SERVERS, (): MsnServer[] => {
    // Same order as Discord's server sidebar (folders flattened)
    let ids: string[] = SortedGuildStore?.getFlattenedGuildIds?.() ?? [];
    if (!ids.length && GuildStore) ids = Object.keys(GuildStore.getGuilds());

    return ids
        .map(id => GuildStore?.getGuild(id))
        .filter(Boolean)
        .map((g: any) => ({ id: g.id, name: g.name, iconUrl: guildIconUrl(g) }));
});

onIpcCommand(IpcCommands.MSN_CMD_GET_CHANNELS, (guildId: string): MsnChannel[] => {
    const all = GuildChannelStore?.getChannels?.(guildId);
    if (!all) return [];

    // Discord already filters these to channels you can see
    const text = (all.SELECTABLE ?? []).map((c: any) => c.channel).filter((c: any) => SERVER_TEXT.has(c?.type));
    const voice = (all.VOCAL ?? []).map((c: any) => c.channel).filter((c: any) => SERVER_VOICE.has(c?.type));

    const categoryOf = (c: any) => (c.parent_id ? ChannelStore.getChannel(c.parent_id) : null);
    const catPos = (c: any) => categoryOf(c)?.position ?? -1;
    const byPosition = (a: any, b: any) => catPos(a) - catPos(b) || a.position - b.position;

    // Discord's layout: grouped by category, text channels before voice within each
    const rows: any[] = [...text.map((c: any) => ({ c, voice: false })), ...voice.map((c: any) => ({ c, voice: true }))];
    rows.sort((a, b) => catPos(a.c) - catPos(b.c) || Number(a.voice) - Number(b.voice) || byPosition(a.c, b.c));

    return rows.map(({ c, voice: isVoice }) => ({
        id: c.id,
        name: c.name,
        kind: isVoice ? "voice" : "text",
        category: categoryOf(c)?.name ?? "",
        voiceCount: isVoice ? Object.keys(VoiceStateStore?.getVoiceStatesForChannel?.(c.id) ?? {}).length : undefined
    }));
});

onIpcCommand(IpcCommands.MSN_CMD_GET_CHANNEL, async (channelId: string): Promise<MsnChannelConversation> => {
    const channel = ChannelStore.getChannel(channelId);
    // text channels, plus the text chat built into voice channels (opened next to calls)
    if (!channel || !(SERVER_TEXT.has(channel.type) || SERVER_VOICE.has(channel.type))) {
        throw new Error("That channel can't be opened in Messenger");
    }

    const guild = GuildStore?.getGuild(channel.guild_id);
    watched.add(channelId);

    let messages: MsnMessage[] = [];
    try {
        messages = await loadHistory(channelId);
    } catch (e) {
        VesktopLogger.error("[MSN] couldn't load channel history", e);
    }

    return {
        channelId,
        channel: {
            id: channelId,
            name: channel.name,
            topic: channel.topic ?? "",
            guildId: channel.guild_id,
            guildName: guild?.name ?? "",
            guildIconUrl: guildIconUrl(guild)
        },
        messages
    };
});

onIpcCommand(IpcCommands.MSN_CMD_WATCH, ({ channelId, watch }: { channelId: string; watch: boolean }) => {
    if (watch) watched.add(channelId);
    else watched.delete(channelId);
});

// Voice channels and "Show in Discord" for server channels: open it in the real Discord window
onIpcCommand(IpcCommands.MSN_CMD_SHOW_CHANNEL, (channelId: string) => {
    const channel = ChannelStore.getChannel(channelId);
    if (channel?.guild_id) NavigationRouter.transitionTo(`/channels/${channel.guild_id}/${channelId}`);
});

// "Show in Discord": jump to the DM in the normal Discord window
onIpcCommand(IpcCommands.MSN_OPEN_DM, async (userId: string) => {
    try {
        const dmId = await ensureDmChannel(userId);
        NavigationRouter.transitionTo(`/channels/@me/${dmId}`);
    } catch {
        NavigationRouter.transitionTo("/channels/@me");
    }
});

waitFor(filters.byStoreName("UserStore"), () => {
    FluxDispatcher.subscribe("CONNECTION_OPEN", sendReady);
    // Friends' statuses arrive in a second burst after connecting
    FluxDispatcher.subscribe("CONNECTION_OPEN_SUPPLEMENTAL", sendFriends);
    FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    FluxDispatcher.subscribe("MESSAGE_SEND_FAILED", onMessageSendFailed);
    FluxDispatcher.subscribe("TYPING_START", onTypingStart);
    FluxDispatcher.subscribe("PRESENCE_UPDATES", onPresenceUpdates);
    FluxDispatcher.subscribe("SELF_PRESENCE_STORE_UPDATE", onSelfPresence);
    FluxDispatcher.subscribe("RELATIONSHIP_ADD", sendFriends);
    FluxDispatcher.subscribe("RELATIONSHIP_REMOVE", sendFriends);
    FluxDispatcher.subscribe("RELATIONSHIP_UPDATE", sendFriends);
    FluxDispatcher.subscribe("LOGOUT", onLogout);

    VesktopLogger.log("[MSN] bridge listening");

    // If Discord already connected before we subscribed, announce ourselves now.
    if (UserStore.getCurrentUser()) sendReady();
});

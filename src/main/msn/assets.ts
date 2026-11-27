/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The msn-assets folder: your own sounds, frames, emoticons and CSS.
// Nothing ships in it. Messenger falls back to its built-in look and sounds for anything missing.

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { extname, join } from "path";
import { pathToFileURL } from "url";

import { net } from "electron";
import type { MsnAssets, MsnFrameName, MsnSoundName } from "shared/msn";

import { DATA_DIR } from "../constants";
import { isPathInDirectory } from "../utils/isPathInDirectory";

export const MSN_ASSETS_DIR = join(DATA_DIR, "msn-assets");

const SOUND_NAMES: MsnSoundName[] = ["signin", "online", "message", "nudge"];
const FRAME_NAMES: MsnFrameName[] = ["online", "idle", "dnd", "offline"];
const AUDIO_EXT = [".wav", ".mp3", ".ogg"];
const IMAGE_EXT = [".png", ".gif", ".webp", ".jpg", ".jpeg"];
const SERVABLE_EXT = new Set([...AUDIO_EXT, ...IMAGE_EXT, ".css"]);

const README = `Messenger assets
================

Drop your own files here and Messenger uses them instead of its built-in ones.
Anything missing falls back to the default. Changes show up the next time a window opens.

sounds/      signin, online, message, nudge     (.wav, .mp3 or .ogg)
             e.g. sounds/online.wav

frames/      online, idle, dnd, offline          (.png, .gif or .webp)
             Drawn on top of display pictures, stretched to fit. Use images with
             a transparent middle. e.g. frames/online.png

emoticons/   any images, plus emoticons.json mapping text to file names:
             { ":)": "smile.png", ":D": "grin.gif", "(L)": "heart.png" }

scene        optional scene.png / scene.jpg: the banner picture behind your
             name at the top of the contact list (shown widest in full view).

style.css    optional. Applied to every Messenger window, for fine-tuning
             (frame size, fonts, colours...).
`;

export function ensureMsnAssetsDir() {
    try {
        for (const dir of ["sounds", "frames", "emoticons"]) mkdirSync(join(MSN_ASSETS_DIR, dir), { recursive: true });

        const readme = join(MSN_ASSETS_DIR, "README.txt");
        if (!existsSync(readme)) writeFileSync(readme, README);
    } catch (err) {
        console.error("[MSN] couldn't create msn-assets folder", err);
    }
}

/** vesktop://msn-assets/<path>?v=<mtime>, so edited files aren't served from cache */
async function urlFor(relPath: string) {
    const info = await stat(join(MSN_ASSETS_DIR, relPath));
    return `vesktop://msn-assets/${relPath.split("/").map(encodeURIComponent).join("/")}?v=${Math.floor(info.mtimeMs)}`;
}

/** Find <dir>/<name>.<ext> for the first allowed extension that exists */
async function findNamed(dir: string, name: string, extensions: string[]) {
    let files: string[];
    try {
        files = await readdir(join(MSN_ASSETS_DIR, dir));
    } catch {
        return null;
    }

    for (const ext of extensions) {
        const match = files.find(f => f.toLowerCase() === name + ext);
        if (match) return urlFor(dir ? `${dir}/${match}` : match);
    }
    return null;
}

async function readEmoticons(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    let map: unknown;
    try {
        map = JSON.parse(await readFile(join(MSN_ASSETS_DIR, "emoticons", "emoticons.json"), "utf-8"));
    } catch {
        return result;
    }
    if (!map || typeof map !== "object") return result;

    for (const [code, file] of Object.entries(map as Record<string, unknown>)) {
        if (typeof file !== "string" || !code.trim() || code.length > 20) continue;
        // plain file names only, no paths
        if (file.includes("/") || file.includes("\\") || !IMAGE_EXT.includes(extname(file).toLowerCase())) continue;
        try {
            result[code] = await urlFor(`emoticons/${file}`);
        } catch {
            // listed but missing: skip
        }
    }
    return result;
}

export async function getMsnAssets(): Promise<MsnAssets> {
    const sounds = {} as MsnAssets["sounds"];
    for (const name of SOUND_NAMES) sounds[name] = await findNamed("sounds", name, AUDIO_EXT);

    const frames = {} as MsnAssets["frames"];
    for (const name of FRAME_NAMES) frames[name] = await findNamed("frames", name, IMAGE_EXT);

    let css: string | null = null;
    try {
        css = await urlFor("style.css");
    } catch {}

    const scene = await findNamed("", "scene", IMAGE_EXT);

    return { sounds, frames, emoticons: await readEmoticons(), css, scene };
}

export async function handleMsnAssetsProtocol(pathname: string) {
    let relPath: string;
    try {
        relPath = decodeURIComponent(pathname);
    } catch {
        return new Response(null, { status: 400 });
    }

    const fullPath = join(MSN_ASSETS_DIR, relPath);
    if (!isPathInDirectory(fullPath, MSN_ASSETS_DIR) || !SERVABLE_EXT.has(extname(fullPath).toLowerCase())) {
        return new Response(null, { status: 404 });
    }

    return net.fetch(pathToFileURL(fullPath).href);
}

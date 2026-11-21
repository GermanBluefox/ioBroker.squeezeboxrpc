'use strict';

/*
 * Commands of the shared catalog of ioBroker adapters (HELP.md of ioBroker.assistant): media.getPlayers,
 * media.getMedia, media.play and speech.playSound. They take the parameters and give the answers of the catalog, so
 * that a client (ioBroker.assistant, pi-agent, a script) can call every media adapter the same way.
 */

const { getResultValue, validateSource } = require('./announce');

/** How often play asks LMS whether the player plays */
const POLL_MS = 500;
/** How long play waits for the player to play */
const PLAY_TIMEOUT_MS = 10_000;
/** After this time playSound answers {ok, pending} and lets the sound finish in the background */
const SOUND_TIMEOUT_MS = 15_000;
/** The most items getMedia asks LMS for */
const MAX_ITEMS = 999;
/** URIs of getMedia: favorite:<item id> and playlist:<playlist id> (not the LMS URL playlist:///…) */
const FAVORITE_URI = /^favorite:([\w.-]+)$/;
const PLAYLIST_URI = /^playlist:(\d+)$/;

/**
 * The text of an error
 *
 * @param error - an Error or anything else
 * @returns the text
 */
function errorText(error) {
    return error instanceof Error ? error.message : String(error || 'Unknown error');
}

/**
 * The players the server knows
 *
 * @param server - the IoSbServer
 * @returns the players
 */
function knownPlayers(server) {
    return Object.values(server.players || {}).filter(player => player?.playerid && player.playername);
}

/**
 * A player as the catalog lists it
 *
 * @param server - the IoSbServer
 * @param player - the ioSBPlayer
 * @returns {{id: string, name: string, stateId: string, connected: boolean, active: boolean, kinds: string[]}} the entry
 */
function playerInfo(server, player) {
    const prefix = `${player.statePath}.${player.playername}`;
    const name = player.currentStates?.[`${prefix}.Playername`];
    return {
        id: player.playerid,
        name: typeof name === 'string' && name.trim() ? name : player.playername,
        stateId: `${server.adapter.namespace}.${prefix}`,
        connected: Number(player.connected) === 1,
        active: player.currentStates?.[`${prefix}.Mode`] === 'play',
        kinds: ['audio'],
    };
}

/**
 * Finds a player by its ID (MAC), its name in LMS or its name in the state IDs, without case.
 * An exact match wins over a partial one.
 *
 * @param server - the IoSbServer
 * @param device - what the caller gave
 * @returns {{player?: object, error?: string, reason?: string, candidates?: string[]}} the player or the error
 */
function findPlayer(server, device) {
    const players = knownPlayers(server);
    const wanted = String(device).trim().toLowerCase();
    const names = player => [playerInfo(server, player).name.toLowerCase(), player.playername.toLowerCase()];
    let found = players.filter(player => player.playerid.toLowerCase() === wanted || names(player).includes(wanted));
    if (!found.length) {
        found = players.filter(player => names(player).some(name => name.includes(wanted)));
    }
    if (found.length === 1) {
        return { player: found[0] };
    }
    const candidates = (found.length ? found : players).map(player => playerInfo(server, player).name);
    if (found.length) {
        return { error: `"${device}" fits several players: ${candidates.join(', ')}`, reason: 'AMBIGUOUS', candidates };
    }
    return { error: `Unknown player "${device}"`, reason: 'NOT_FOUND', candidates };
}

/**
 * The answer when LMS is not reachable
 *
 * @returns the error
 */
function notConnected() {
    return { error: 'The Lyrion Media Server is not connected', reason: 'NOT_CONNECTED' };
}

/**
 * The URL of a picture of LMS
 *
 * @param server - the IoSbServer
 * @param image - a URL or a path on LMS, like "html/images/radio.png"
 * @returns the URL or undefined
 */
function imageUrl(server, image) {
    if (typeof image !== 'string' || !image) {
        return undefined;
    }
    if (/^https?:\/\//i.test(image)) {
        return image;
    }
    return `http://${server.adapter.config.server}:${server.adapter.config.port}/${image.replace(/^\/+/, '')}`;
}

/**
 * media.getPlayers {}
 *
 * @param server - the IoSbServer
 * @returns the answer
 */
function getPlayers(server) {
    return { players: knownPlayers(server).map(player => playerInfo(server, player)) };
}

/**
 * media.getMedia {list, search?, limit?, offset?}: the favorites (top level) or the playlists of LMS
 *
 * @param server - the IoSbServer
 * @param message - the parameters
 * @returns the answer
 */
async function getMedia(server, message) {
    const list = typeof message.list === 'string' ? message.list.trim() : '';
    if (!list) {
        return { error: 'The parameter list is missing: favorites or playlists', reason: 'BAD_REQUEST' };
    }
    if (list !== 'favorites' && list !== 'playlists') {
        return { error: `The list "${list}" is not supported, only favorites and playlists`, reason: 'NOT_SUPPORTED' };
    }
    if (!server.connected) {
        return notConnected();
    }
    let items;
    if (list === 'favorites') {
        const response = await server.requestAsync('', [
            'favorites',
            'items',
            '0',
            String(MAX_ITEMS),
            'want_url:1',
            'item_id:',
        ]);
        items = (response?.result?.loop_loop || []).map(item => {
            const url = typeof item.url === 'string' ? item.url : '';
            let type = 'track';
            if (Number(item.hasitems) > 0 || item.type === 'playlist') {
                // "favorites playlist play" plays the entries of a folder
                type = 'playlist';
            } else if (/^(https?|icy|mms):/i.test(url)) {
                type = 'radio';
            }
            return {
                type,
                uri: `favorite:${server.getFavId(String(item.id), false)}`,
                name: String(item.name ?? ''),
                image: imageUrl(server, item.image),
            };
        });
    } else {
        const response = await server.requestAsync('', ['playlists', '0', String(MAX_ITEMS), 'tags:us']);
        items = (response?.result?.playlists_loop || []).map(item => ({
            type: 'playlist',
            uri: `playlist:${item.id}`,
            name: String(item.playlist ?? item.name ?? ''),
        }));
    }
    const search = typeof message.search === 'string' ? message.search.trim().toLowerCase() : '';
    if (search) {
        const rank = item => {
            const name = item.name.toLowerCase();
            return name === search ? 0 : name.startsWith(search) ? 1 : 2;
        };
        items = items.filter(item => item.name.toLowerCase().includes(search)).sort((a, b) => rank(a) - rank(b));
    }
    const offset = Math.max(0, parseInt(message.offset, 10) || 0);
    const limit = Math.max(1, parseInt(message.limit, 10) || 100);
    return { items: items.slice(offset, offset + limit) };
}

/**
 * The LMS command that plays a URI of play
 *
 * @param uri - favorite:<id>, playlist:<id>, a URL or nothing (= resume)
 * @returns the command
 */
function playCommand(uri) {
    if (!uri) {
        // as the state "state" = 1
        return ['play', '2'];
    }
    const favorite = FAVORITE_URI.exec(uri);
    if (favorite) {
        // as the state cmdPlayFavorite
        return ['favorites', 'playlist', 'play', `item_id:${favorite[1]}`];
    }
    const playlist = PLAYLIST_URI.exec(uri);
    if (playlist) {
        // as the playlist widget
        return ['playlistcontrol', 'cmd:load', `playlist_id:${playlist[1]}`];
    }
    // as the state cmdPlayUrl
    return ['playlist', 'play', uri];
}

/**
 * Waits until LMS reports twice in a row that the player plays
 *
 * @param server - the IoSbServer
 * @param player - the ioSBPlayer
 * @returns true if it plays
 */
async function waitForPlay(server, player) {
    let stable = 0;
    for (let attempt = 0; attempt < PLAY_TIMEOUT_MS / POLL_MS; attempt++) {
        await server.adapter.delay(POLL_MS);
        const mode = getResultValue(await server.requestAsync(player.playerid, ['mode', '?']), 'mode');
        stable = mode === 'play' ? stable + 1 : 0;
        if (stable >= 2) {
            return true;
        }
    }
    return false;
}

/**
 * media.play {uri?, device?, offset?, positionSec?, shuffle?}: answers when the player plays
 *
 * @param server - the IoSbServer
 * @param message - the parameters
 * @returns the answer
 */
async function play(server, message) {
    let player;
    if (message.device !== undefined && message.device !== null && message.device !== '') {
        const found = findPlayer(server, message.device);
        if (!found.player) {
            return found.reason === 'NOT_FOUND'
                ? { error: found.error, reason: 'DEVICE_NOT_FOUND', devices: found.candidates }
                : found;
        }
        player = found.player;
    } else {
        // Without device: the only connected player, else the only one that plays
        const connected = knownPlayers(server).filter(item => Number(item.connected) === 1);
        const playing = connected.filter(item => playerInfo(server, item).active);
        player = connected.length === 1 ? connected[0] : playing.length === 1 ? playing[0] : undefined;
        if (!player) {
            const devices = knownPlayers(server).map(item => playerInfo(server, item).name);
            return { error: 'Which player? Give the parameter device', reason: 'NO_ACTIVE_DEVICE', devices };
        }
    }
    const device = { id: player.playerid, name: playerInfo(server, player).name };
    if (!server.connected) {
        return { ...notConnected(), device };
    }
    if (Number(player.connected) !== 1) {
        return { error: `The player "${device.name}" is not connected to LMS`, reason: 'NOT_CONNECTED', device };
    }
    if (player.announcement?.running) {
        // the announcement would restore the old playlist afterwards
        return { error: `An announcement plays on "${device.name}"`, reason: 'BUSY', device };
    }
    const request = command => server.requestAsync(player.playerid, command);
    const uri = typeof message.uri === 'string' ? message.uri.trim() : '';
    if (message.shuffle !== undefined && message.shuffle !== null) {
        await request(['playlist', 'shuffle', message.shuffle ? '1' : '0']);
    }
    await request(playCommand(uri));
    if (!(await waitForPlay(server, player))) {
        return {
            error: `"${device.name}" did not start to play within ${PLAY_TIMEOUT_MS / 1000} s`,
            reason: 'NOT_PLAYING',
            device,
        };
    }
    const offset = parseInt(message.offset, 10);
    if (uri && offset > 0) {
        await request(['playlist', 'index', String(offset)]);
    }
    const position = Number(message.positionSec);
    if (position > 0) {
        await request(['time', String(position)]);
    }
    return { ok: true, device };
}

/**
 * What playSound plays: an HTTP(S) URL or an absolute path on the host, as the state Announce takes them
 *
 * @param adapter - the adapter
 * @param message - the parameters: url or file (also iobfile://<adapter>.<n>/<path>)
 * @returns the URL or the path
 */
function soundSource(adapter, message) {
    const url = typeof message.url === 'string' ? message.url.trim() : '';
    if (url) {
        return url;
    }
    const file = typeof message.file === 'string' ? message.file.trim() : '';
    if (!file) {
        throw new Error('The parameter url or file is missing');
    }
    const stored = /^iobfile:\/\/(.+)$/i.exec(file);
    if (!stored) {
        return file;
    }
    // A file of ioBroker, served by the web adapter of the settings like the local announcement files
    const baseUrl = String(adapter.config.announceWebUrl || '')
        .trim()
        .replace(/\/+$/, '');
    if (!baseUrl) {
        throw new Error('A web URL must be configured in the adapter config before files of ioBroker can be played');
    }
    return `${baseUrl}/${encodeURI(stored[1].replace(/^\/+/, ''))}`;
}

/**
 * speech.playSound {url | file, device?, volume?}: plays over what plays (like the state Announce), then restores it
 *
 * @param server - the IoSbServer
 * @param message - the parameters
 * @returns the answer
 */
async function playSound(server, message) {
    const adapter = server.adapter;
    let source;
    try {
        source = soundSource(adapter, message);
        validateSource(source);
    } catch (error) {
        return { error: errorText(error), reason: 'BAD_REQUEST' };
    }
    let volume;
    if (message.volume !== undefined && message.volume !== null && message.volume !== '') {
        volume = Number(message.volume);
        if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
            return { error: 'volume must be a number from 0 to 100', reason: 'BAD_REQUEST' };
        }
    }
    let players;
    if (message.device !== undefined && message.device !== null && message.device !== '') {
        const found = findPlayer(server, message.device);
        if (!found.player) {
            return found;
        }
        players = [found.player];
        if (Number(found.player.connected) !== 1) {
            const name = playerInfo(server, found.player).name;
            return { error: `The player "${name}" is not connected to LMS`, reason: 'NOT_CONNECTED' };
        }
    } else {
        players = knownPlayers(server).filter(player => Number(player.connected) === 1);
    }
    if (!server.connected || !players.length) {
        return notConnected();
    }
    const names = players.map(player => playerInfo(server, player).name);
    const done = Promise.allSettled(players.map(player => player.announcement.start(source, volume)));
    let timer;
    const timeout = new Promise(resolve => {
        timer = adapter.setTimeout(() => resolve(null), SOUND_TIMEOUT_MS);
    });
    const results = await Promise.race([done, timeout]);
    adapter.clearTimeout(timer);

    const failures = list =>
        list
            .map((result, i) => (result.status === 'rejected' ? `${names[i]}: ${errorText(result.reason)}` : ''))
            .filter(text => text);
    if (!results) {
        void done.then(list => failures(list).forEach(text => adapter.log.warn(`playSound failed for ${text}`)));
        return { ok: true, pending: true, devices: names };
    }
    const failed = failures(results);
    if (failed.length) {
        return { error: failed.join('; '), devices: names.filter((name, i) => results[i].status === 'fulfilled') };
    }
    return { ok: true, devices: names };
}

/** The commands of the catalog, by the name the adapter answers */
const HANDLERS = { getPlayers, getMedia, play, playSound };
/** They answer also without a message */
const STANDARD_COMMANDS = Object.keys(HANDLERS);

/**
 * Runs a command of the catalog and answers it, if the message has a callback
 *
 * @param server - the IoSbServer
 * @param msg - the ioBroker message
 */
function processStandardMessage(server, msg) {
    const message = msg.message && typeof msg.message === 'object' ? msg.message : {};
    Promise.resolve()
        .then(() => HANDLERS[msg.command](server, message))
        .catch(error =>
            server.connected ? { error: errorText(error) } : { ...notConnected(), detail: errorText(error) },
        )
        .then(answer => {
            if (answer.error && !msg.callback) {
                server.adapter.log.warn(`${msg.command} failed: ${answer.error}`);
            }
            if (msg.callback) {
                server.adapter.sendTo(msg.from, msg.command, answer, msg.callback);
            }
        })
        .catch(error => server.adapter.log.error(`Cannot answer ${msg.command}: ${errorText(error)}`));
}

module.exports = { HANDLERS, STANDARD_COMMANDS, findPlayer, playCommand, processStandardMessage, soundSource };

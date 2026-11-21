// @ts-nocheck Proxyquire test doubles intentionally implement only the server dependencies exercised here.
'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const { playCommand, soundSource } = require('../lib/standard');

/**
 * A server with a fake LMS: every request is recorded, "mode ?" answers the mode of the player,
 * "playlist play" and the other play commands let it play
 *
 * @param options - modes of the players, favorites and playlists of LMS, whether a play command plays
 * @returns the fixture
 */
function createFixture({ startsPlaying = true, favorites = [], playlists = [] } = {}) {
    const requests = [];
    const answers = [];
    const modes = {};
    const timers = [];
    // The requests of the start (serverstatus, syncgroups) get no answer, the tests set the players themselves
    let starting = true;
    const connection = {
        start() {},
        close() {},
        request(playerId, command, callback) {
            if (starting) {
                return;
            }
            requests.push([playerId, command]);
            let result = {};
            if (command[0] === 'mode' && command[1] === '?') {
                result = { _mode: modes[playerId] || 'stop' };
            } else if (
                startsPlaying &&
                ((command[0] === 'playlist' && command[1] === 'play') ||
                    command[0] === 'play' ||
                    (command[0] === 'favorites' && command[1] === 'playlist') ||
                    command[0] === 'playlistcontrol')
            ) {
                modes[playerId] = 'play';
            } else if (command[0] === 'favorites' && command[1] === 'items') {
                result = { loop_loop: favorites };
            } else if (command[0] === 'playlists') {
                result = { playlists_loop: playlists };
            }
            callback({ ok: true, result });
        },
    };
    class FakeIoUtil {
        constructor() {
            this.observers = [];
        }
        addTranslations() {}
        logdebug() {}
        logsilly() {}
        logerror() {}
        setMyTimeout() {}
        clearTimeout() {}
    }
    class FakeDiscovery {
        start() {}
        close() {}
        getServers() {
            return [];
        }
    }
    const adapter = {
        namespace: 'squeezeboxrpc.0',
        config: {
            server: 'lms.local',
            port: '9000',
            serverrefresh: 30,
            favoriterefresh: 5,
            usefavorites: false,
            usediscovery: false,
            announceWebUrl: 'http://iobroker:8082/',
        },
        log: { debug() {}, silly() {}, error() {}, info() {}, warn() {} },
        delay: async () => {},
        setTimeout: (callback, ms) => {
            const timer = { callback, ms };
            timers.push(timer);
            return timer;
        },
        clearTimeout: timer => {
            timer.cleared = true;
        },
        setState() {},
        subscribeStates() {},
        getStates() {},
        getState() {},
        delObject() {},
        delState() {},
        sendTo: (from, command, answer, callback) => answers.push({ from, command, answer, callback }),
        getObjectListAsync: async () => ({ rows: [] }),
        delForeignObjectAsync: async () => {},
        getObject: (id, callback) => callback(null, null),
        setObjectNotExists() {},
        getForeignObject: (id, callback) => callback(null, { _id: id }),
    };
    const IoSbServer = proxyquire('../lib/iosbserver', {
        './ioUtil': { ioUtil: FakeIoUtil },
        './lms/connection': { createLmsConnection: () => connection },
        './lms/discovery': { LmsDiscovery: FakeDiscovery },
        './iosbplayer': class {},
    });
    const server = new IoSbServer(adapter, { getTranslatedObject: key => key });
    starting = false;
    server.connected = 1;

    /**
     * Adds a player as ioSBPlayer keeps it
     *
     * @param playerid - the MAC
     * @param name - the name in LMS
     * @param options - connected, mode
     * @returns the player
     */
    const addPlayer = (playerid, name, { connected = 1, mode = 'stop' } = {}) => {
        const playername = server.sanitizePlayername(name);
        modes[playerid] = mode;
        const player = {
            playerid,
            playername,
            connected,
            statePath: 'Players',
            currentStates: { [`Players.${playername}.Playername`]: name, [`Players.${playername}.Mode`]: mode },
            sounds: [],
            announcement: {
                running: false,
                finish: true,
                start(source, volume) {
                    player.sounds.push([source, volume]);
                    return player.announcement.finish ? Promise.resolve() : new Promise(() => {});
                },
            },
        };
        server.players[playerid] = player;
        return player;
    };

    /**
     * Sends a message like js-controller and waits for its answer
     *
     * @param command - the command
     * @param [message] - the message
     * @returns the answer
     */
    const ask = async (command, message) => {
        const count = answers.length;
        server.processMessages({ command, message, from: 'system.adapter.assistant.0', callback: { id: 1 } });
        for (let i = 0; i < 100 && answers.length === count; i++) {
            await new Promise(resolve => setImmediate(resolve));
        }
        expect(answers.length, `answer to ${command}`).to.equal(count + 1);
        expect(answers[count].command).to.equal(command);
        return answers[count].answer;
    };
    return { server, adapter, requests, timers, addPlayer, ask, modes };
}

describe('standard commands of the shared catalog', () => {
    it('lists the players for media.getPlayers, also without a message', async () => {
        const { addPlayer, ask } = createFixture();
        addPlayer('00:00:00:00:00:01', 'Living room', { mode: 'play' });
        addPlayer('00:00:00:00:00:02', 'Kitchen', { connected: 0 });

        expect(await ask('getPlayers')).to.deep.equal({
            players: [
                {
                    id: '00:00:00:00:00:01',
                    name: 'Living room',
                    stateId: 'squeezeboxrpc.0.Players.Living_room',
                    connected: true,
                    active: true,
                    kinds: ['audio'],
                },
                {
                    id: '00:00:00:00:00:02',
                    name: 'Kitchen',
                    stateId: 'squeezeboxrpc.0.Players.Kitchen',
                    connected: false,
                    active: false,
                    kinds: ['audio'],
                },
            ],
        });
    });

    it('answers unknown commands with NOT_SUPPORTED', async () => {
        const { ask } = createFixture();
        expect(await ask('nonsense', {})).to.deep.equal({
            error: 'Unknown command: nonsense',
            reason: 'NOT_SUPPORTED',
        });
    });

    it('maps uri of media.play to the LMS commands of the states', () => {
        expect(playCommand('')).to.deep.equal(['play', '2']);
        expect(playCommand('favorite:1.2')).to.deep.equal(['favorites', 'playlist', 'play', 'item_id:1.2']);
        expect(playCommand('playlist:37')).to.deep.equal(['playlistcontrol', 'cmd:load', 'playlist_id:37']);
        expect(playCommand('playlist:///music/list.m3u')).to.deep.equal([
            'playlist',
            'play',
            'playlist:///music/list.m3u',
        ]);
        expect(playCommand('http://radio.example/stream')).to.deep.equal([
            'playlist',
            'play',
            'http://radio.example/stream',
        ]);
    });

    it('plays a URI on the player found by name and answers when it plays', async () => {
        const { addPlayer, ask, requests } = createFixture();
        addPlayer('00:00:00:00:00:01', 'Living room');
        addPlayer('00:00:00:00:00:02', 'Kitchen radio');

        const answer = await ask('play', {
            uri: 'favorite:3',
            device: 'living ROOM',
            shuffle: true,
            offset: 2,
            positionSec: 30,
        });

        expect(answer).to.deep.equal({ ok: true, device: { id: '00:00:00:00:00:01', name: 'Living room' } });
        const sent = requests.filter(([id, command]) => id === '00:00:00:00:00:01' && command[1] !== '?');
        expect(sent.map(([, command]) => command)).to.deep.equal([
            ['playlist', 'shuffle', '1'],
            ['favorites', 'playlist', 'play', 'item_id:3'],
            ['playlist', 'index', '2'],
            ['time', '30'],
        ]);
    });

    it('finds players by MAC and partial names and refuses ambiguous or unknown ones', async () => {
        const { addPlayer, ask } = createFixture();
        addPlayer('00:00:00:00:00:01', 'Kitchen');
        addPlayer('00:00:00:00:00:02', 'Kitchen radio');
        addPlayer('00:00:00:00:00:03', 'Bath room');

        expect((await ask('play', { device: 'kitchen' })).device.name).to.equal('Kitchen');
        expect((await ask('play', { device: '00:00:00:00:00:02' })).device.name).to.equal('Kitchen radio');
        expect((await ask('play', { device: 'bath' })).device.name).to.equal('Bath room');
        expect(await ask('play', { device: 'itche' })).to.deep.include({
            reason: 'AMBIGUOUS',
            candidates: ['Kitchen', 'Kitchen radio'],
        });
        expect(await ask('play', { device: 'Garage' })).to.deep.include({
            reason: 'DEVICE_NOT_FOUND',
            devices: ['Kitchen', 'Kitchen radio', 'Bath room'],
        });
        expect(await ask('playSound', { url: 'http://x/gong.mp3', device: 'Garage' })).to.deep.include({
            reason: 'NOT_FOUND',
        });
    });

    it('resumes the only playing player without device and asks for a device otherwise', async () => {
        const { addPlayer, ask, requests } = createFixture();
        addPlayer('00:00:00:00:00:01', 'Kitchen', { mode: 'pause' });
        expect((await ask('play', {})).device.name).to.equal('Kitchen');
        expect(requests).to.deep.include(['00:00:00:00:00:01', ['play', '2']]);

        addPlayer('00:00:00:00:00:02', 'Bath');
        expect(await ask('play', { uri: 'http://x/a.mp3' })).to.deep.include({
            reason: 'NO_ACTIVE_DEVICE',
            devices: ['Kitchen', 'Bath'],
        });
    });

    it('reports players that are offline, busy or do not start', async () => {
        const fixture = createFixture({ startsPlaying: false });
        fixture.addPlayer('00:00:00:00:00:01', 'Kitchen', { connected: 0 });
        const bath = fixture.addPlayer('00:00:00:00:00:02', 'Bath');
        fixture.addPlayer('00:00:00:00:00:03', 'Hall');

        expect(await fixture.ask('play', { device: 'Kitchen' })).to.deep.include({ reason: 'NOT_CONNECTED' });
        expect(await fixture.ask('play', { device: 'Hall', uri: 'http://x/a.mp3' })).to.deep.include({
            reason: 'NOT_PLAYING',
        });
        bath.announcement.running = true;
        expect(await fixture.ask('play', { device: 'Bath' })).to.deep.include({ reason: 'BUSY' });
        fixture.server.connected = 0;
        expect(await fixture.ask('getMedia', { list: 'favorites' })).to.deep.include({ reason: 'NOT_CONNECTED' });
    });

    it('plays a sound as an announcement with the given volume on one or all players', async () => {
        const { addPlayer, ask } = createFixture();
        const kitchen = addPlayer('00:00:00:00:00:01', 'Kitchen');
        const bath = addPlayer('00:00:00:00:00:02', 'Bath');
        addPlayer('00:00:00:00:00:03', 'Offline', { connected: 0 });

        expect(await ask('playSound', { url: 'http://x/gong.mp3', device: 'kitchen', volume: 40 })).to.deep.equal({
            ok: true,
            devices: ['Kitchen'],
        });
        expect(kitchen.sounds).to.deep.equal([['http://x/gong.mp3', 40]]);

        expect(await ask('playSound', { file: 'iobfile://vis.0/main/door bell.mp3' })).to.deep.equal({
            ok: true,
            devices: ['Kitchen', 'Bath'],
        });
        expect(bath.sounds).to.deep.equal([['http://iobroker:8082/vis.0/main/door%20bell.mp3', undefined]]);
    });

    it('answers pending when the sound takes longer and refuses what the state Announce cannot play', async () => {
        const { addPlayer, ask, timers, server } = createFixture();
        const kitchen = addPlayer('00:00:00:00:00:01', 'Kitchen');
        kitchen.announcement.finish = false;

        const answer = ask('playSound', { file: '/opt/sounds/gong.wav' });
        await new Promise(resolve => setImmediate(resolve));
        expect(timers.at(-1).ms).to.equal(15000);
        timers.at(-1).callback();
        expect(await answer).to.deep.equal({ ok: true, pending: true, devices: ['Kitchen'] });

        expect(await ask('playSound', { file: 'data:audio/mp3;base64,AAAA' })).to.deep.include({
            reason: 'BAD_REQUEST',
        });
        expect(await ask('playSound', {})).to.deep.include({ reason: 'BAD_REQUEST' });
        expect(await ask('playSound', { url: 'http://x/a.mp3', volume: 150 })).to.deep.include({
            reason: 'BAD_REQUEST',
        });
        server.adapter.config.announceWebUrl = '';
        expect(() => soundSource(server.adapter, { file: 'iobfile://vis.0/a.mp3' })).to.throw('web URL');
    });

    it('lists favorites and playlists for media.getMedia, the best match first', async () => {
        const { ask } = createFixture({
            favorites: [
                {
                    id: 'a1b2c3d4.0',
                    name: 'Rock Radio',
                    url: 'http://radio.example/rock',
                    image: 'html/images/radio.png',
                },
                { id: 'a1b2c3d4.1', name: 'Jazz', hasitems: 3, image: 'https://img.example/jazz.png' },
                { id: 'a1b2c3d4.2', name: 'Rock', url: 'file:///music/rock.flac' },
            ],
            playlists: [{ id: 37, playlist: 'Party', url: 'playlist:///music/party.m3u' }],
        });

        expect(await ask('getMedia', { list: 'favorites', search: 'rock' })).to.deep.equal({
            items: [
                { type: 'track', uri: 'favorite:2', name: 'Rock', image: undefined },
                {
                    type: 'radio',
                    uri: 'favorite:0',
                    name: 'Rock Radio',
                    image: 'http://lms.local:9000/html/images/radio.png',
                },
            ],
        });
        expect(
            (await ask('getMedia', { list: 'favorites', offset: 1, limit: 1 })).items.map(item => item.name),
        ).to.deep.equal(['Jazz']);
        expect((await ask('getMedia', { list: 'favorites', search: 'jazz' })).items[0]).to.include({
            type: 'playlist',
        });
        expect(await ask('getMedia', { list: 'playlists' })).to.deep.equal({
            items: [{ type: 'playlist', uri: 'playlist:37', name: 'Party' }],
        });
        expect(await ask('getMedia', { list: 'albums' })).to.deep.include({ reason: 'NOT_SUPPORTED' });
        expect(await ask('getMedia', {})).to.deep.include({ reason: 'BAD_REQUEST' });
    });
});

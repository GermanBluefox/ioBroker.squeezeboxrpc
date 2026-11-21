'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const { COMMANDS, HELP } = require('../lib/help');
const { STANDARD_COMMANDS } = require('../lib/standard');

/** The commands of the shared catalog (HELP.md of ioBroker.assistant) the adapter follows */
const STANDARD = {
    getPlayers: 'media.getPlayers',
    getMedia: 'media.getMedia',
    play: 'media.play',
    playSound: 'speech.playSound',
};

/**
 * A part of a source file
 *
 * @param {string} file - path relative to the root of the repository
 * @param {string} from - text where the part starts
 * @param {string} to - text after the part
 * @returns {string} the part
 */
function sourcePart(file, from, to) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    expect(start, from).to.be.greaterThan(-1);
    expect(end, to).to.be.greaterThan(start);
    return source.slice(start, end);
}

/**
 * The commands of onMessage (squeezeboxrpc.js), processMessages (lib/iosbserver.js) and lib/standard.js
 *
 * @returns {string[]} command names
 */
function answeredCommands() {
    const parts = [
        sourcePart('squeezeboxrpc.js', 'async onMessage(', 'onStateChange('),
        sourcePart('lib/iosbserver.js', 'this.processMessages = ', 'this.sendPlayerNames = '),
    ];
    return [
        ...new Set([
            ...parts.flatMap(text => [...text.matchAll(/\.command === '([^']+)'/g)].map(m => m[1])),
            ...STANDARD_COMMANDS,
        ]),
    ];
}

describe('help', () => {
    it('lists exactly the commands the adapter answers, each once', () => {
        const listed = COMMANDS.map(entry => entry.command);
        expect(new Set(listed).size).to.equal(listed.length);
        expect([...listed].sort()).to.deep.equal(answeredCommands().sort());
    });

    it('marks cmdGeneral, play and playSound as write', () => {
        expect(COMMANDS.filter(entry => entry.write).map(entry => entry.command)).to.deep.equal([
            'cmdGeneral',
            'play',
            'playSound',
        ]);
    });

    it('marks the commands of the shared catalog with their standard and names them in the text', () => {
        const marked = Object.fromEntries(
            COMMANDS.filter(entry => entry.standard).map(entry => [entry.command, entry.standard]),
        );
        expect(marked).to.deep.equal(STANDARD);
        expect([...STANDARD_COMMANDS].sort()).to.deep.equal(Object.keys(STANDARD).sort());
        for (const [command, standard] of Object.entries(STANDARD)) {
            expect(standard, command).to.match(/^(media|speech)\.[a-z][A-Za-z]+$/);
            expect(standard.split('.')[1], command).to.equal(command);
            expect(HELP, standard).to.include(standard);
            expect(HELP, command).to.include(`- ${command} {`);
        }
    });

    it('names every command and every state a player or the server reacts to', () => {
        const player = sourcePart('lib/iosbplayer.js', 'this.doStateChange = ', 'this.createArtworkUrl = ');
        const server = sourcePart('lib/iosbserver.js', 'this.doServerStateChange = ', 'this.doFavoritesStateChange = ');
        const states = [...`${player}${server}`.matchAll(/idParts\[0\] == '([^']+)'/g)].map(m => m[1]);
        expect(states).to.include('Volume');
        for (const word of [
            ...COMMANDS.map(entry => entry.command).filter(command => command !== 'help'),
            ...states,
            'btnPreset_',
            'sendTo squeezeboxrpc.0',
            'How to talk to the user:',
        ]) {
            expect(HELP, word).to.include(word);
        }
    });

    it('keeps the lines short', () => {
        for (const line of HELP.split('\n')) {
            expect(line.length, line).to.be.at.most(120);
        }
    });
});

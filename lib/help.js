'use strict';

/*
 * The answer of the message "help": what the instance answers, written for AI agents (e.g. ioBroker.pi-agent or
 * the MCP server with send_to) and script authors. Keep it in sync with onMessage in squeezeboxrpc.js,
 * processMessages in lib/iosbserver.js and doStateChange in lib/iosbplayer.js.
 */

/**
 * Every command the adapter answers; write = it can change something. standard = the command of the shared catalog
 * of ioBroker adapters (HELP.md of ioBroker.assistant) it follows, see lib/standard.js.
 */
const COMMANDS = [
    { command: 'help', write: false },
    { command: 'getPlayerNames', write: false },
    { command: 'cmdGeneral', write: true },
    { command: 'discoverlms', write: false },
    { command: 'getPlayers', write: false, standard: 'media.getPlayers' },
    { command: 'getMedia', write: false, standard: 'media.getMedia' },
    { command: 'play', write: true, standard: 'media.play' },
    { command: 'playSound', write: true, standard: 'speech.playSound' },
];

const HELP = `ioBroker.squeezeboxrpc: connects ioBroker to a Lyrion (Logitech) Media Server (LMS) and its players
(Squeezebox, piCorePlayer, squeezelite, WiiM, Chromecast/AirPlay/UPnP through LMS plugins). An agent can tell what
plays where, query the music library and the favorites of LMS, and control a player (play, pause, stop, next,
volume, power, play a favorite or a URL, repeat, shuffle, announcements) by writing its states; play, playSound
and getMedia do the most common of it as commands with an answer.
Players: squeezeboxrpc.0.Players.<player>; <player> = the name of the player in LMS with every run of characters
other than A-Z, a-z, 0-9 and _ replaced by one _ (e.g. "Living room" -> "Living_room"). getPlayers and
getPlayerNames list them.

Commands (sendTo squeezeboxrpc.0). getPlayers, getMedia, play and playSound are the standard commands media.getPlayers,
media.getMedia, media.play and speech.playSound of the shared catalog of ioBroker adapters: the same names,
parameters and answers as other media adapters; errors are {error, reason}. They answer also without a message.
- getPlayers {}: all known players: {players: [{id (the MAC), name (in LMS), stateId (squeezeboxrpc.0.Players.
  <player>), connected (to LMS), active (plays now), kinds: ["audio"]}]}.
- getMedia {list, search?, limit? (100), offset? (0)}: list "favorites" (the favorites of LMS, top level) or
  "playlists" (the saved playlists of LMS); search: a part of the name, the best match first. Answer {items: [{type
  (track, radio or playlist; a folder of favorites is a playlist), uri, name, image?}]}; uri goes to play.
  Other lists: reason NOT_SUPPORTED.
- play {uri?, device?, offset?, positionSec?, shuffle?}: plays uri on the player device and answers when it plays:
  {ok: true, device: {id, name}}. Without uri it resumes. uri: favorite:<id> or playlist:<id> from getMedia, or the
  URL of a stream or file that LMS can play (it replaces the playlist). device: the id, the name or the <player> of
  getPlayers (without case, an exact name wins); without device the only connected player, else the only one that
  plays. shuffle: true / false, set before; offset (the index of the track) and positionSec, set once it plays.
  Reasons: DEVICE_NOT_FOUND (with devices), AMBIGUOUS (with candidates), NO_ACTIVE_DEVICE (with devices: name one),
  NOT_CONNECTED, BUSY (an announcement plays there), NOT_PLAYING (it did not play within 10 s).
- playSound {url | file, device?, volume?}: plays a short sound or speech file over what plays, like the state
  Announce: then the playlist, the position and the volume come back. url: an HTTP(S) URL of an audio file (.mp3,
  .wav, .ogg, .flac, .m4a ...); file: the same, an absolute path on the ioBroker host or iobfile://<adapter>.<n>/
  <path> of the ioBroker files (both need the web URL in the settings). device: as for play, default all connected
  players. volume: 0-100, default the announcement volume of the settings. Answers when it was played and restored:
  {ok: true, devices: [names]}; after 15 s {ok: true, pending: true, devices} and the rest runs in the background.
  Reasons: BAD_REQUEST, NOT_FOUND / AMBIGUOUS (with candidates), NOT_CONNECTED.
- Unknown commands: {error, reason: "NOT_SUPPORTED"}.
The older commands need a message, send at least {}:
- getPlayerNames {}: the <player> names of all known players: ["Living_room", "Kitchen", ...].
- cmdGeneral {playerid, cmdArray}: sends one command of the LMS CLI and answers with the reply of LMS: {result:
  {...}, params, ok: true}; errors are texts: "error: cmdArray is not an array", "error: Problem with Server
  request". playerid: the MAC of a player (state Players.<player>.PlayerID) or "" for the server. cmdArray: the
  words of the command, e.g. ["playlists", "0", "999", "tags:us"] (all playlists), ["favorites", "items", "0",
  "999", "want_url:1", "item_id:"] (the favorites), ["mixer", "volume", "30"] with a playerid. Queries only read;
  other commands control the player or the server. All commands and their answers:
  https://github.com/oweitman/LMS-CLI-Documentation/blob/master/LMS-CLI.md
- discoverlms: the LMS servers found in the network, for the settings, not for agents.

States (squeezeboxrpc.0.*), write them with ack false:
- Players.<player>.* to control: state (0 pause, 1 play, 2 stop), Power (0 off, 1 on), Volume (0-100),
  PlaylistRepeat (0 off, 1 the song, 2 the playlist), PlaylistShuffle (0 off, 1 by song, 2 by album),
  PlaylistCurrentIndex (a text: the index in the playlist to jump to, or relative "+1" / "-2"), cmdGoTime (seconds
  to jump to, or relative "+30" / "-30"), cmdPlayFavorite (the id of a favorite, see Favorites), cmdPlayUrl (the URL
  of a stream or file, replaces the playlist), btnForward / btnRewind (true: next / previous track), btnPreset_1 to
  btnPreset_6 (true: the presets of the player), Announce (an HTTP(S) URL or an absolute path on the ioBroker host
  of an audio file, e.g. .mp3 or .wav: plays it at the announcement volume of the settings, then restores what
  played and the volume; a local file needs the web URL in the settings), cmdGeneral (an LMS command for this
  player as the JSON list items without brackets, e.g. "mixer","volume","30"; no answer, use the message instead).
- Players.<player>.* to read: Playername, PlayerID (MAC), Connected (0/1), IP, Mode (play, pause, stop), Title,
  Artist, Album, Albumartist, Trackartist, Band, Genre, RadioName, Remote (1 = a stream), Time (elapsed s),
  Duration (s), ArtworkUrl, Url, Type, Bitrate, Rate, SyncMaster and SyncSlaves (MACs), Playlist (JSON list of the
  tracks, if enabled in the settings), Alarms (JSON).
- Favorites.<fav>.*: Name, id (write it into cmdPlayFavorite), type, url, image, hasitems (> 0: a folder; its entries
  are Favorites.<fav>-<n>), isaudio. Only if "Request favorites" is enabled in the settings; Server.getFavorites
  (true) reloads them.
- Server.*: Name, Version, PlayerCount, SyncGroups (JSON), TotalSongs, TotalAlbums, TotalArtists, LastScan ...
- info.connection: true while LMS is reachable.

How to talk to the user:
- Which player: the one the user names (match the name of getPlayers, getPlayerNames or Players.<player>.Playername).
  If there are several and the user names none, ask; do not guess.
- play, playSound, playing, pausing, Power, Volume, cmdPlayFavorite, cmdPlayUrl, Announce and cmdGeneral commands
  that are not queries change what the residents hear: only on the user's request. play with uri, cmdPlayFavorite
  and cmdPlayUrl replace what plays now. Change the volume in small steps unless the user names a value.
- Name players by their names, favorites by Name and tracks by Title and Artist, not by IDs, MACs or URLs.`;

module.exports = { COMMANDS, HELP };

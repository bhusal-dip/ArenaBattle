const { ArenaBattleRoom } = require('./games/ArenaBattleRoom');
const { PuckRushRoom } = require('./games/PuckRushRoom');

const GAME_TYPES = {
  arena: { label: 'Arena Battle', create: (code, io, options) => new ArenaBattleRoom(code, io, options) },
  hockey: { label: 'Puck Rush', create: (code, io) => new PuckRushRoom(code, io) },
};

function createRoom(gameType, code, io, options = {}) {
  const def = GAME_TYPES[gameType] || GAME_TYPES.arena;
  return def.create(code, io, options);
}

module.exports = { createRoom, GAME_TYPES };

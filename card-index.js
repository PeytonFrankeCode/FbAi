// Node-side convenience: the resolver with the checklist data already attached.
//
// Used by the tests and by scripts. NOT reachable from server.js — requiring
// the JSON here is exactly what put 918 KB into the Worker bundle and tripped
// its resource limit. The Worker uses card-index-core.js and fetches the data.
const { createCardIndex, norm } = require('./card-index-core');
// public/data, not data/, and that is the whole point: the Worker fetches this
// same file over the assets binding, so there is one copy and it cannot drift
// from the one that ships.
const INDEX = require('./public/data/card-index.json');

module.exports = { ...createCardIndex(INDEX), norm };

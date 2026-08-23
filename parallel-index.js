// Node-side convenience: the parallel reader with the checklist data attached.
// Used by the tests and by scripts; the Worker uses parallel-index-core.js and
// fetches the data from the assets binding.
const { createParallelIndex, norm } = require('./parallel-index-core');
const { resolvePlayer } = require('./card-index');
const PARALLELS = require('./public/data/parallel-index.json');

module.exports = { ...createParallelIndex(PARALLELS, resolvePlayer), norm };

const { createDb } = require('./indexer/db');
const { runIndexing } = require('./indexer/index-service');
const { getEventsForRenderer, getIndexStats } = require('./indexer/repository');
const { classifyImage } = require('./indexer/ai-service');

module.exports = {
  createDb,
  runIndexing,
  getEventsForRenderer,
  getIndexStats,
  classifyImage,
};

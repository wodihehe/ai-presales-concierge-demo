import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { SearchService } from '../services/searchService.js';

export const searchRouter = express.Router();
searchRouter.use(requireAuth);

/**
 * Workbench search and retrieval debug tool
 */
searchRouter.post('/debug', (req, res) => {
  const { query = '', profile = {} } = req.body || {};

  try {
    const searchResult = SearchService.searchFormalCases({ query, profile });
    const contextResult = SearchService.getStyleAndQuoteContext({ query, profile });

    return res.json({
      success: true,
      query,
      profile,
      stats: searchResult.stats,
      matchedCount: searchResult.cases.filter(c => c.match === true).length,
      cases: searchResult.cases,
      context: contextResult
    });
  } catch (err) {
    return res.status(500).json({ error: 'search_debug_failed', message: err.message });
  }
});

import express from 'express';
import { requireIntegrationKey } from '../middleware/auth.js';
import { SearchService } from '../services/searchService.js';

export const integrationRouter = express.Router();

// Apply integration API Key auth to all customer service routes
integrationRouter.use(requireIntegrationKey);

/**
 * 1. Quote Compatible Search Endpoint
 * Contract: POST /api/integrations/customer-service/search
 */
integrationRouter.post('/customer-service/search', (req, res) => {
  try {
    const { query = '', profile = {} } = req.body || {};

    const searchResult = SearchService.searchFormalCases({ query, profile });

    // Format strictly for parent intelligence.js validCase check
    const cleanCases = searchResult.cases.map(c => ({
      id: String(c.id).slice(0, 128),
      category: String(c.category || '').slice(0, 20000),
      title: String(c.title || '').slice(0, 20000),
      summary: String(c.summary || '').slice(0, 20000),
      features: (Array.isArray(c.features) ? c.features : []).map(f => String(f).slice(0, 2000)).slice(0, 100),
      approved: Boolean(c.approved),
      public: Boolean(c.public),
      match: Boolean(c.match),
      price: c.price ? {
        min: Number(c.price.min),
        max: Number(c.price.max),
        currency: 'CNY'
      } : null
    }));

    return res.json({
      cases: cleanCases
    });
  } catch (err) {
    console.error('[Integration Error] Search failed:', err);
    // Non-2xx causes parent customer service retrieveQuote to correctly record 'unavailable'
    return res.status(500).json({
      error: 'internal_error',
      message: '知识库检索服务异常'
    });
  }
});

/**
 * 2. Proposal and Style Context Endpoint
 * Contract: POST /api/integrations/customer-service/context
 */
integrationRouter.post('/customer-service/context', (req, res) => {
  try {
    const { query = '', profile = {} } = req.body || {};

    const context = SearchService.getStyleAndQuoteContext({ query, profile });
    return res.json(context);
  } catch (err) {
    console.error('[Integration Error] Context retrieval failed:', err);
    return res.status(500).json({
      error: 'internal_error',
      message: '知识库方案与风格上下文服务异常'
    });
  }
});

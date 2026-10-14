import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { initDatabase } from './db/index.js';
import { getOrCreateSetupToken } from './middleware/auth.js';
import { acquireRuntimeLock } from './db/runtimeLock.js';

import { authRouter } from './routes/authRoutes.js';
import { userRouter } from './routes/userRoutes.js';
import { settingRouter } from './routes/settingRoutes.js';
import { projectRouter } from './routes/projectRoutes.js';
import { organizeRouter } from './routes/organizeRoutes.js';
import { reviewRouter } from './routes/reviewRoutes.js';
import { searchRouter } from './routes/searchRoutes.js';
import { integrationRouter } from './routes/integrationRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();

  // Basic security & parsing middlewares
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'invalid_origin', message: '不允许跨站修改数据' });
      } catch { return res.status(403).json({ error: 'invalid_origin', message: '请求来源无效' }); }
    }
    next();
  });

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());

  // Mount API routers
  app.use('/api/auth', authRouter);
  app.use('/api/users', userRouter);
  app.use('/api/settings', settingRouter);
  app.use('/api/projects', projectRouter);
  // Keep the paths used by the shipped workbench, and retain the original aliases.
  app.use('/api/projects/:id/organize', (req, res, next) => { req.url = `/${req.params.id}${req.url}`; organizeRouter(req, res, next); });
  app.use('/api/projects/:id/review', (req, res, next) => { req.url = `/${req.params.id}${req.url}`; reviewRouter(req, res, next); });
  app.use('/api/projects', organizeRouter);
  app.use('/api/projects', reviewRouter);
  app.use('/api/reviews', reviewRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/integrations', integrationRouter);

  // Serve static UI
  const publicDir = path.join(CONFIG.ROOT_DIR, 'public');
  app.use(express.static(publicDir));

  // SPA fallback for frontend client routing
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'not_found', message: 'API 接口不存在' });
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'API 接口不存在' }));

  // Global error handler
  app.use((err, req, res, next) => {
    if (!err.status || err.status >= 500) console.error('[Request failed]', err.code || 'server_error');
    res.status(err.status || (err instanceof Error && err.code?.startsWith('LIMIT_') ? 413 : 500)).json({
      error: err.code || 'server_error',
      message: err.code?.startsWith('LIMIT_') ? '上传超出文件大小或批量数量限制' : (err.status && err.status < 500 ? err.message : '服务器处理异常')
    });
  });

  return app;
}

export function startServer(port = CONFIG.PORT) {
  const release = acquireRuntimeLock();
  process.once('exit', release);
  // Ensure DB initialized
  initDatabase(CONFIG.DB_PATH, { recoverTasks: true });

  // Check initial admin setup token
  getOrCreateSetupToken();

  const app = createApp();
  const host = process.env.HOST || '127.0.0.1';
  const server = app.listen(port, host, () => {
    console.log(`\n======================================================`);
    console.log(`[Knowledge Base Service] 知识库服务启动成功!`);
    console.log(`[Local Web Workbench]    http://${host}:${port}`);
    console.log(`[Quote API Endpoint]     POST http://localhost:${port}/api/integrations/customer-service/search`);
    console.log(`[Context API Endpoint]   POST http://localhost:${port}/api/integrations/customer-service/context`);
    console.log(`======================================================\n`);
  });
  server.once('close', release);
  server.once('error', release);

  return server;
}

// Auto start if executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}

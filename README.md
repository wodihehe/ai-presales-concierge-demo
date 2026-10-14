# AI Pre-sales Concierge + Project Knowledge Base Demo

**English** | [简体中文](#简体中文)

> ⚠️ All cases, documents and prices are **fictional** and for workflow demonstration only. No real clients, accounts, model keys, webhooks or QR codes are included.

---

## English

### Overview
A bilingual (English / Simplified Chinese) enterprise AI pre-sales concierge plus project knowledge base demo, showing the full flow from inquiry to follow-up. It consists of two independently running services:

- `customer-service/` — chat widget + admin console (Express 5 + React 19 + Vite)
- `knowledge-base/` — project knowledge workspace (Express 4 + SQLite), exposing only reviewed public fields to the concierge via an HTTP Bearer API

### Flow
Inquiry → clarify requirements → confirm scope → look up cases → show solution & reference price → leave contact details → generate follow-up notification (written to the local demo inbox only)

### Features
- **Chat**: anonymous inquiry, new conversation, resume on refresh, attachment upload (5 MB limit), requirement checklist, reference quote, human handoff
- **Knowledge base**: archive project materials, edit drafts, staff review & publish, search, withdraw
- **Admin console**: view inquiries / chats / attachments, update follow-up status, configure model, knowledge base, accounts and service hours
- **i18n**: auto-detects browser language (non-Chinese defaults to English), manual switch remembered via the `demo_locale` cookie, or force with `?lang=zh` / `?lang=en`; covers chat, admin, knowledge base and notification pages
- **Model integration**: any OpenAI-compatible `/v1` endpoint; the real model's persona and conversation strategy are defined by Skills in `customer-service/skills/`. Without configuration, a clearly labeled offline simulation is used

### Tech stack
Node.js ≥ 24 · Express · SQLite · React 19 · Vite 8 · multer · mammoth / pdf-parse / xlsx (document parsing) · node:test · Playwright (browser checks)

### Project structure
```
.
├── customer-service/      # Concierge + admin console
│   ├── client/            # React frontend (Chat / Admin / DemoBar)
│   ├── server/            # Express server
│   ├── skills/            # Concierge Skills (persona / knowledge-reply strategy)
│   └── tests/
├── knowledge-base/        # Project knowledge base
│   ├── public/            # Static frontend
│   ├── server/            # routes / services / db (schema.sql) / middleware
│   ├── vendor/            # Pinned xlsx-0.20.3.tgz
│   └── tests/
├── shared/                # EN/ZH dictionary and i18n (en.txt → en.json)
├── examples/cases.json    # Fictional seed cases
├── scripts/               # setup / start / seed / package / browser checks
├── tests/                 # Cross-service integration tests
└── .env.example
```

### Quick start
**1. Install** (Node.js 24+ required)
```bash
npm run setup   # npm ci for both services and build the concierge frontend
```

**2. Configure a model (optional)**
```bash
cp .env.example .env
```
| Variable | Description | Default |
|---|---|---|
| `DEMO_MODEL_BASE_URL` | OpenAI-compatible base URL, e.g. `https://api.example.com/v1` | empty (offline simulation) |
| `DEMO_MODEL_NAME` | Model name | empty |
| `DEMO_MODEL_API_KEY` | API key | empty |
| `DEMO_CS_PORT` | Concierge service port | `3318` |
| `DEMO_KB_PORT` | Knowledge base service port | `3320` |
| `DEMO_BROWSER` | Playwright browser channel for browser checks | `msedge` |

When all three `DEMO_MODEL_*` values are set, both services use that model at startup. You can also configure it in the UI: concierge "Demo admin → Reception settings → Model & knowledge base", and the knowledge base's "System & model settings".

**3. Start**
```bash
npm start
```
One command starts both services (bound to `127.0.0.1`). The first start creates separate databases, random admin credentials (saved in `.runtime/credentials.json`) and fictional demo cases; later starts keep your changes.

- Concierge: http://127.0.0.1:3318
- Knowledge base: http://127.0.0.1:3320
- The "Demo admin", "Knowledge workspace" and "Demo inbox" links at the top of the page provide one-click local login (loopback only)

**4. Test & build**
```bash
npm test                                # Cross-service HTTP tests
npm --prefix customer-service test
npm --prefix knowledge-base test
npm run build
node scripts/browser-check.js           # Requires Playwright browsers
node scripts/language-browser-check.js
npm run package                         # Allow-list packaging + hash manifest + sensitive-content scan
```

### Knowledge review workflow
- Lifecycle: draft → submitted for review → approved & published by staff → can be withdrawn / deleted
- **Only approved, published cases** can back concierge proposals and quotes; drafts, withdrawn and deleted cases are never cited
- The concierge receives only reviewed public fields via the Bearer API; prices are computed server-side only from evidence marked quotable (`allow_cs_quote`) with a comparable scope; cases without prices are offered as solution references only
- Retrieval uses structured filters plus Chinese keyword rules — no vector database or model training
- Seed data: 3 published fictional cases + 1 unreviewed draft

### Data handling & security
- Runtime data (`customer-service/data/`, `knowledge-base/data/`, `.runtime/`), `.env`, `*.db` and `*.sqlite*` are excluded by `.gitignore`
- The admin password and integration key are randomly generated on first start, never stored in source
- Secrets in the concierge configuration are encrypted by the app (AES-256-GCM)
- Notifications are only written to the local demo inbox; nothing is sent even if a real WeCom webhook is configured
- **This is a local demo**: before any public deployment, remove one-click login, add real authentication and access / cost limits, and do not reverse-proxy it directly to the internet
- Do not enter real personal information or upload real client documents in the demo

### License
Released under the [MIT License](LICENSE).

---

## 简体中文

[English](#english) | **简体中文**

> ⚠️ 所有案例、材料和价格均为**虚构**，仅用于展示业务流程。仓库中不含真实客户、账号、模型密钥、Webhook 或二维码。

### 简介
一个中英文双语的企业 AI 售前客服 + 项目知识库演示系统，展示从客户咨询到项目跟进的完整流程。由两个独立运行的服务组成：

- `customer-service/`：客服窗口 + 管理后台（Express 5 + React 19 + Vite）
- `knowledge-base/`：企业项目知识库工作台（Express 4 + SQLite），通过 HTTP Bearer 接口向客服提供已审核的公开字段

### 业务流程
客户咨询 → 补充需求 → 确认范围 → 查询案例 → 展示方案和参考价格 → 留联系方式 → 生成跟进通知（仅写入本机演示收件箱）

### 功能
- **客服窗口**：匿名咨询、新建对话、刷新续接、附件上传（5MB 限制）、需求清单、参考报价、人工入口
- **企业知识库**：项目资料归档、草稿编辑、员工审核发布、检索和撤回
- **管理后台**：查看咨询/聊天/附件，更新跟进状态，配置模型、知识库、账号与服务时间
- **中英文切换**：根据浏览器语言自动选择（非中文默认英文），可手动切换并记住选择（Cookie `demo_locale`），也可用 `?lang=zh` / `?lang=en`；覆盖客服、后台、知识库及通知页
- **模型接入**：可配置任意 OpenAI 兼容 `/v1` 接口；真实模型通过 Skill（`customer-service/skills/`）定义客服人设与沟通策略。未配置时使用明确标注的离线模拟流程

### 技术栈
Node.js ≥ 24 · Express · SQLite · React 19 · Vite 8 · multer · mammoth / pdf-parse / xlsx（文档解析）· node:test · Playwright（浏览器检查）

### 目录结构
```
.
├── customer-service/      # 客服 + 管理后台
│   ├── client/            # React 前端（Chat / Admin / DemoBar）
│   ├── server/            # Express 服务端
│   ├── skills/            # 客服 Skill（人设 / 知识回复策略）
│   └── tests/
├── knowledge-base/        # 项目知识库
│   ├── public/            # 前端静态页面
│   ├── server/            # routes / services / db(schema.sql) / middleware
│   ├── vendor/            # 锁定的 xlsx-0.20.3.tgz
│   └── tests/
├── shared/                # 中英文词典与 i18n（en.txt → en.json）
├── examples/cases.json    # 虚构种子案例
├── scripts/               # setup / start / seed / package / 浏览器检查
├── tests/                 # 两服务联合测试
└── .env.example
```

### 快速开始
**1. 安装**（需 Node.js 24+）
```bash
npm run setup   # 两端 npm ci 并构建客服前端
```

**2. 配置模型（可选）**
```bash
cp .env.example .env
```
| 变量 | 说明 | 默认 |
|---|---|---|
| `DEMO_MODEL_BASE_URL` | OpenAI 兼容接口基础地址，例如 `https://api.example.com/v1` | 空（离线模拟） |
| `DEMO_MODEL_NAME` | 模型名 | 空 |
| `DEMO_MODEL_API_KEY` | API 密钥 | 空 |
| `DEMO_CS_PORT` | 客服服务端口 | `3318` |
| `DEMO_KB_PORT` | 知识库服务端口 | `3320` |
| `DEMO_BROWSER` | 浏览器检查使用的 Playwright channel | `msedge` |

三项 `DEMO_MODEL_*` 都填写后，启动时两端共用该模型。也可在页面中配置：客服「演示后台 → 接待设置 → 模型与知识库」，知识库「系统与模型设置」。

**3. 启动**
```bash
npm start
```
一条命令同时启动两个服务（固定绑定 `127.0.0.1`）。首次启动会创建独立数据库、随机管理员凭证（保存在 `.runtime/credentials.json`）和虚构演示案例；之后启动保留你的修改。

- 客服：http://127.0.0.1:3318
- 知识库：http://127.0.0.1:3320
- 页面顶部的「演示后台」「知识库工作台」「演示收件箱」可在本机一键登录（仅限回环地址）

**4. 测试与构建**
```bash
npm test                                # 两服务联合 HTTP 测试
npm --prefix customer-service test
npm --prefix knowledge-base test
npm run build
node scripts/browser-check.js           # 需安装 Playwright 浏览器
node scripts/language-browser-check.js
npm run package                         # 白名单打包 + 哈希清单 + 敏感项扫描
```

### 知识库审核机制
- 资料状态：草稿 → 提交审核 → 员工审核发布 → 可撤回 / 删除
- **只有已审核发布的案例**能成为客服的方案和报价依据；草稿、撤回、删除的案例不会被引用
- 客服通过 Bearer 接口只拿到审核后的公开字段；价格由服务端根据允许报价（`allow_cs_quote`）且范围可比的证据计算，无价格案例只提供方案参考
- 检索为结构化条件 + 中文关键词规则，不含向量数据库或模型训练
- 初始数据：3 个已发布虚构案例 + 1 个未审核草稿

### 脱敏与安全说明
- 运行数据（`customer-service/data/`、`knowledge-base/data/`、`.runtime/`）、`.env`、`*.db`、`*.sqlite*` 均被 `.gitignore` 排除
- 管理员密码与集成密钥在首次启动时随机生成，不写入源码
- 客服配置中的密钥由应用加密存储（AES-256-GCM）
- 通知只写入本机演示收件箱，即使配置真实企业微信 Webhook 也不会外发
- **本项目为本机演示**：公开部署前必须移除一键登录、接入正式认证、做好访问与费用限制，不要直接反代到公网
- 不要在演示中输入真实个人信息或上传客户原件

### License
本项目基于 [MIT License](LICENSE) 开源。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, getDatabase, transaction } from '../../server/db/index.js';
import { SYNTHETIC_FIXTURES } from '../fixtures/synthetic_projects.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function setupTestDatabase(dbPath = ':memory:') {
  const db = initDatabase(dbPath);

  // Clean all tables
  db.exec(`
    DELETE FROM project_reviews;
    DELETE FROM project_chat;
    DELETE FROM project_phases;
    DELETE FROM project_features;
    DELETE FROM project_files;
    DELETE FROM style_references;
    DELETE FROM projects_fts;
    DELETE FROM projects;
    DELETE FROM tasks;
    DELETE FROM settings;
    DELETE FROM users;
  `);

  // Seed default integration key
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('integration_api_key', 'test_secret_key_123', datetime('now'))").run();

  // Seed fixtures
  transaction(() => {
    for (const fixture of SYNTHETIC_FIXTURES) {
      db.prepare(`
        INSERT INTO projects (
          id, title, category, scenario, problem, overview, inputs, outputs, 
          integrations, deployment, deliverables, exclusions, creator_id, 
          status, draft_version, public_title, public_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'usr_test', ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        fixture.id, fixture.title, fixture.category, fixture.scenario, fixture.problem,
        fixture.overview, fixture.inputs, fixture.outputs, fixture.integrations,
        fixture.deployment, fixture.deliverables, fixture.exclusions,
        fixture.status, fixture.draft_version, fixture.public_title, fixture.public_summary
      );

      // Features
      if (Array.isArray(fixture.features)) {
        const featStmt = db.prepare('INSERT INTO project_features (id, project_id, feature_text, is_public, order_index) VALUES (?, ?, ?, 1, ?)');
        fixture.features.forEach((feat, idx) => {
          featStmt.run(`${fixture.id}_feat_${idx}`, fixture.id, feat, idx);
        });
      }

      // Phases
      if (Array.isArray(fixture.phases)) {
        const phaseStmt = db.prepare(`
          INSERT INTO project_phases (
            id, project_id, phase_name, scope_description, relation, 
            amount_min, amount_max, currency, raw_amount_text, cost_scope, 
            source_location, allow_cs_quote, order_index
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        fixture.phases.forEach((p, idx) => {
          phaseStmt.run(
            p.id, fixture.id, p.phase_name, p.scope_description, p.relation,
            p.amount_min, p.amount_max, p.currency, p.raw_amount_text, p.cost_scope,
            p.source_location, p.allow_cs_quote, idx
          );
        });
      }

      // Styles
      if (Array.isArray(fixture.styles)) {
        const styleStmt = db.prepare('INSERT INTO style_references (id, project_id, topic, desensitized_example, source_location, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))');
        fixture.styles.forEach((s, idx) => {
          styleStmt.run(`${fixture.id}_style_${idx}`, fixture.id, s.topic, s.desensitized_example, s.source_location);
        });
      }

      // FTS table sync for approved items
      if (fixture.status === 'approved') {
        db.prepare(`
          INSERT INTO projects_fts (project_id, title, category, scenario, overview, features, deliverables)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          fixture.id,
          fixture.public_title,
          fixture.category,
          fixture.scenario,
          fixture.public_summary,
          (fixture.features || []).join(' '),
          fixture.deliverables
        );
      }
    }
  });

  return db;
}

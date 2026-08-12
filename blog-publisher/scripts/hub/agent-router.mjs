/**
 * scripts/hub/agent-router.mjs — agent .md frontmatter loader + tool/prompt router
 *
 * loadAgents(): reads all .claude/agents/*.md, parses frontmatter (name, tools CSV, model)
 *               + body -> Map<id, { id, name, tools:string[], model, systemPrompt }>
 * systemPromptFor(agentId): agent body as system prompt, or default if null/unknown
 * allowedToolsFor(agentId): agent declared tools intersected with SAFE_TOOLS
 *                            null agentId (plain chat) -> [] (no tools)
 *
 * HARD RULE: never allow arbitrary shell from the CHAT itself.
 * Agents with Bash in their own declarations are trusted because their .md bodies
 * contain embedded safety contracts. Plain chat (agentId=null) gets no tools.
 *
 * DANGER_BLOCKED: exported constant documenting the no-shell-in-chat policy.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('hub/agent-router');

const __dir = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dir, '..', '..', '.claude', 'agents');

// Safe allowlist: tools the chat runner may surface to Claude via agent context.
// Intersection with agent declared tools prevents unexpected escalation from
// future frontmatter drift.
const SAFE_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash', 'Task', 'WebFetch', 'WebSearch',
]);

/** Policy note: direct shell from CHAT is blocked regardless of declared tools. */
export const DANGER_BLOCKED =
  'Direct shell execution without agent context is blocked in chat. ' +
  'Agents\' own Bash declarations are allowed only when their safety-contract ' +
  'system prompt is active.';

// ─── Frontmatter parser ───────────────────────────────────────────────────────

/**
 * Parse YAML-ish frontmatter between the first two --- delimiters.
 * Returns { meta: Record<string,string>, body: string }.
 */
function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const eq = line.indexOf(':');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key) meta[key] = val;
  }
  return { meta, body: match[2] };
}

// ─── Agent cache ──────────────────────────────────────────────────────────────

let _cache = null;

/**
 * Load all agents from .claude/agents/*.md.
 * Cached after first call (process-lifetime singleton).
 * Returns Map<id, { id, name, tools:string[], model, systemPrompt:string }>.
 */
export function loadAgents() {
  if (_cache) return _cache;
  const map = new Map();
  let files;
  try {
    files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
  } catch (err) {
    log.warn('agents dir not readable', err?.message);
    _cache = map;
    return map;
  }
  for (const file of files) {
    const id = basename(file, '.md');
    try {
      const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
      const { meta, body } = parseFrontmatter(text);
      const toolsCsv = meta.tools || '';
      const tools = toolsCsv.split(',').map(t => t.trim()).filter(Boolean);
      map.set(id, {
        id,
        name:         meta.name  || id,
        description:  meta.description || '',
        tools,
        model:        meta.model || 'claude-sonnet-4-5',
        systemPrompt: body.trim(),
        team:         meta.team || 'publish', // frontmatter team ('dev'=개발팀, 기본='publish'=발행·관측)
      });
    } catch (err) {
      log.warn(`agent load failed: ${file}`, err?.message);
    }
  }
  log.info(`loaded ${map.size} agents`);
  _cache = map;
  return map;
}

// ─── Public API ───────────────────────────────────────────────────────────────

const DEFAULT_PROMPT =
  'You are a general-purpose AI assistant. Answer clearly and helpfully.';

/**
 * Returns the agent body as system prompt.
 * Falls back to a default general-assistant prompt if agentId is null or unknown.
 */
export function systemPromptFor(agentId) {
  if (!agentId) return DEFAULT_PROMPT;
  const agents = loadAgents();
  const agent  = agents.get(agentId);
  if (!agent) {
    log.warn(`unknown agent: ${agentId} — using default prompt`);
    return DEFAULT_PROMPT;
  }
  return agent.systemPrompt;
}

/**
 * Returns tools allowed for this agent run.
 *
 * null agentId (plain chat) -> [] (conversation only, no tools).
 * Known agent -> declared tools intersected with SAFE_TOOLS.
 * Unknown agent -> [] (safe default).
 */
export function allowedToolsFor(agentId) {
  if (!agentId) return [];
  const agents = loadAgents();
  const agent  = agents.get(agentId);
  if (!agent) return [];
  return agent.tools.filter(t => SAFE_TOOLS.has(t));
}

/**
 * First clause of a description string — text before the first em/en dash or
 * " - " hyphen separator. Used as a compact role hint. Falls back to '' when
 * the description is empty.
 */
function firstClause(desc) {
  if (!desc) return '';
  const parts = String(desc).split(/\s*[—–]\s*|\s+-\s+/);
  return (parts[0] || '').trim();
}

/**
 * Agent catalog for the orchestrator decompose step.
 * Returns [{ id, name, role }] for every agent in .claude/agents/*.md,
 * where role = first clause of the frontmatter description (fallback = name).
 * The orchestrator LLM is instructed to assign subtasks only to these ids.
 */
export function agentCatalog() {
  const agents = loadAgents();
  return [...agents.values()].map(a => ({
    id:   a.id,
    name: a.name,
    role: firstClause(a.description) || a.name,
    team: a.team || 'publish', // 'publish'(발행·관측) | 'dev'(사이트·기능·DB 개발)
  }));
}

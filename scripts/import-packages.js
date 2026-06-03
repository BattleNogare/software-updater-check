import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const CONFIG = {
  gitUrl: process.env.PRIVATE_GIT_URL || 'https://git.iserv.eu/software-deployment',
  gitBranch: process.env.PRIVATE_GIT_BRANCH || '',
  gitToken: process.env.PRIVATE_GIT_TOKEN || '',
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  workDir: join(os.tmpdir(), `software-deployment-${Date.now()}`),
};

if (!CONFIG.supabaseUrl || !CONFIG.supabaseServiceRoleKey) {
  console.error('Fehlende Supabase ENV: SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function log(message) {
  console.log(`[import] ${message}`);
}

function fail(message, error) {
  console.error(`[import] ${message}`);
  if (error) console.error(error);
  process.exit(1);
}

function withTokenUrl(url, token) {
  if (!token) return url;

  const parsed = new URL(url);

  if (parsed.username || parsed.password) {
    return url;
  }

  parsed.username = 'oauth2';
  parsed.password = token;

  return parsed.toString();
}

function runGitClone() {
  const cloneUrl = withTokenUrl(CONFIG.gitUrl, CONFIG.gitToken);

  const args = ['clone', '--depth', '1'];

  if (CONFIG.gitBranch) {
    args.push('--branch', CONFIG.gitBranch);
  }

  args.push(cloneUrl, CONFIG.workDir);

  log(`Clone Repository nach ${CONFIG.workDir}`);

  try {
    execFileSync('git', args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  } catch (error) {
    fail('Git clone fehlgeschlagen. Prüfe PRIVATE_GIT_URL, PRIVATE_GIT_TOKEN und Zugriff.', error);
  }
}

function findControlFiles(baseDir) {
  const results = [];

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        walk(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name === 'control') {
        results.push(fullPath);
      }
    }
  }

  walk(baseDir);
  return results;
}

function parseControl(content) {
  const result = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!match) continue;

    const key = match[1].toLowerCase();
    const value = match[2].trim();

    result[key] = value;
  }

  return {
    name: result.name || null,
    package_id: result.id || null,
    local_version: result.version || null,
  };
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function normalizePackageRecord(controlFile) {
  const raw = readFileSync(controlFile, 'utf8');
  const parsed = parseControl(raw);
  const relPath = relative(CONFIG.workDir, controlFile).replaceAll('\\', '/');

  if (!parsed.package_id) {
    return {
      valid: false,
      reason: `Keine id: gefunden`,
      source_path: relPath,
      control_raw: raw,
    };
  }

  const safeId = parsed.package_id.trim();

  return {
    valid: true,
    row: {
      id: safeId,
      name: parsed.name || safeId,
      package_id: safeId,
      local_version: parsed.local_version || null,
      source_path: relPath,
      control_raw: raw,
      control_hash: sha256(raw),
      package_status: 'active',
      last_seen_at: new Date().toISOString(),
      missing_since: null,
      check_message: 'Paket wurde aus Git importiert.',
    },
  };
}

async function getExistingPackages() {
  const { data, error } = await supabase
    .from('packages')
    .select('package_id, control_hash, local_version, name, package_status');

  if (error) {
    fail('Bestehende Pakete konnten nicht aus Supabase geladen werden.', error);
  }

  return new Map((data || []).map((row) => [row.package_id, row]));
}

async function upsertPackages(records) {
  if (!records.length) return;

  const { error } = await supabase
    .from('packages')
    .upsert(records, {
      onConflict: 'package_id',
    });

  if (error) {
    fail('Upsert nach Supabase fehlgeschlagen.', error);
  }
}

async function markMissingPackages(foundIds) {
  const existing = await getExistingPackages();
  const now = new Date().toISOString();

  const missingIds = [];

  for (const packageId of existing.keys()) {
    if (!foundIds.has(packageId)) {
      missingIds.push(packageId);
    }
  }

  if (!missingIds.length) {
    log('Keine fehlenden Pakete erkannt.');
    return;
  }

  log(`${missingIds.length} Paket(e) fehlen im Git und werden als missing markiert.`);

  const { error } = await supabase
    .from('packages')
    .update({
      package_status: 'missing',
      missing_since: now,
      check_status: 'skipped',
      check_message: 'Paket wurde beim letzten Git-Import nicht mehr gefunden.',
    })
    .in('package_id', missingIds);

  if (error) {
    fail('Missing-Markierung fehlgeschlagen.', error);
  }
}

async function insertAuditLog(action, entityType, entityId, oldData, newData) {
  const { error } = await supabase
    .from('audit_log')
    .insert({
      user_id: null,
      action,
      entity_type: entityType,
      entity_id: entityId,
      old_data: oldData || null,
      new_data: newData || null,
    });

  if (error) {
    console.warn(`[audit] Audit-Log fehlgeschlagen: ${error.message}`);
  }
}

async function auditChanges(records, existingMap) {
  for (const row of records) {
    const existing = existingMap.get(row.package_id);

    if (!existing) {
      await insertAuditLog('package_imported', 'package', row.package_id, null, row);
      continue;
    }

    const changed =
      existing.control_hash !== row.control_hash ||
      existing.local_version !== row.local_version ||
      existing.name !== row.name ||
      existing.package_status === 'missing';

    if (changed) {
      await insertAuditLog('package_updated_from_import', 'package', row.package_id, existing, row);
    }
  }
}

async function main() {
  log('Starte Paketimport.');

  if (existsSync(CONFIG.workDir)) {
    rmSync(CONFIG.workDir, { recursive: true, force: true });
  }

  mkdirSync(CONFIG.workDir, { recursive: true });

  runGitClone();

  const controlFiles = findControlFiles(CONFIG.workDir);

  log(`${controlFiles.length} control-Datei(en) gefunden.`);

  const records = [];
  const foundIds = new Set();
  const invalidFiles = [];

  for (const controlFile of controlFiles) {
    const normalized = normalizePackageRecord(controlFile);

    if (!normalized.valid) {
      invalidFiles.push(normalized);
      continue;
    }

    records.push(normalized.row);
    foundIds.add(normalized.row.package_id);
  }

  for (const invalid of invalidFiles) {
    console.warn(`[warn] Übersprungen: ${invalid.source_path} (${invalid.reason})`);
  }

  const existingMap = await getExistingPackages();

  await auditChanges(records, existingMap);
  await upsertPackages(records);
  await markMissingPackages(foundIds);

  log(`Import abgeschlossen. Gültige Pakete: ${records.length}, ungültige control-Dateien: ${invalidFiles.length}`);

  rmSync(CONFIG.workDir, { recursive: true, force: true });
}

main().catch((error) => {
  fail('Unerwarteter Fehler beim Import.', error);
});
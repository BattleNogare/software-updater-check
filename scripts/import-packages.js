import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const CONFIG = {
  gitUrl: process.env.PRIVATE_GIT_URL || 'https://git.iserv.eu/software-deployment',
  gitBranch: process.env.PRIVATE_GIT_BRANCH || '',
  gitToken: process.env.PRIVATE_GIT_TOKEN || '',
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  workDir: process.env.WORK_DIR || join(os.tmpdir(), `software-deployment-${Date.now()}`),

  // Wie tief nach control-Dateien gesucht werden soll.
  // Für /paket/control reicht 1.
  // Für /gruppe/paket/control reicht 2.
  // Wir lassen es bewusst großzügig.
  maxControlDepth: Number(process.env.MAX_CONTROL_DEPTH || 8),
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

function warn(message) {
  console.warn(`[warn] ${message}`);
}

function fail(message, error) {
  console.error(`[import] ${message}`);
  if (error) console.error(error);
  process.exit(1);
}

function maskUrlForLog(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '***';
  }
}

function withTokenUrl(url, token) {
  if (!token) return url;

  const parsed = new URL(url);

  if (parsed.username || parsed.password) {
    return url;
  }

  // Funktioniert für viele Git-Server mit HTTPS Token.
  // Falls dein Server eine andere Auth erwartet, kannst du hier anpassen:
  // parsed.username = 'oauth2';
  // parsed.password = token;
  parsed.username = 'oauth2';
  parsed.password = token;

  return parsed.toString();
}

function run(command, args, options = {}) {
  log(`Run: ${command} ${args.map((arg) => (String(arg).includes(CONFIG.gitToken) ? '***' : arg)).join(' ')}`);

  return execFileSync(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
    ...options,
  });
}

function buildSparsePatterns(maxDepth) {
  const patterns = ['/control'];

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    patterns.push(`${'/*'.repeat(depth)}/control`);
  }

  return patterns;
}

function runGitSparseCheckout() {
  const cloneUrl = withTokenUrl(CONFIG.gitUrl, CONFIG.gitToken);

  log(`Sparse Checkout Repository nach ${CONFIG.workDir}`);
  log(`Remote: ${maskUrlForLog(cloneUrl)}`);
  log('Es werden nur control-Dateien ausgecheckt.');

  const sparsePatterns = buildSparsePatterns(CONFIG.maxControlDepth);

  try {
    run('git', ['init', CONFIG.workDir]);

    run('git', ['-C', CONFIG.workDir, 'remote', 'add', 'origin', cloneUrl]);

    run('git', ['-C', CONFIG.workDir, 'config', 'core.sparseCheckout', 'true']);
    run('git', ['-C', CONFIG.workDir, 'config', 'core.sparseCheckoutCone', 'false']);

    const sparseCheckoutFile = join(CONFIG.workDir, '.git', 'info', 'sparse-checkout');

    writeFileSync(
      sparseCheckoutFile,
      sparsePatterns.join('\n') + '\n',
      'utf8'
    );

    log('Sparse Checkout Patterns:');
    for (const pattern of sparsePatterns) {
      log(`  ${pattern}`);
    }

    const fetchArgs = [
      '-C',
      CONFIG.workDir,
      'fetch',
      '--depth',
      '1',
      '--filter=blob:none',
      'origin',
    ];

    if (CONFIG.gitBranch) {
      fetchArgs.push(CONFIG.gitBranch);
    } else {
      fetchArgs.push('HEAD');
    }

    run('git', fetchArgs);

    run('git', ['-C', CONFIG.workDir, 'checkout', 'FETCH_HEAD']);
  } catch (error) {
    fail(
      'Git Sparse Checkout fehlgeschlagen. Prüfe Erreichbarkeit, Token, Branch und Zugriff.',
      error
    );
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
      reason: 'Keine id: gefunden',
      source_path: relPath,
      control_raw: raw,
    };
  }

  const safeId = parsed.package_id.trim();
  const safeName = parsed.name?.trim() || safeId;
  const safeVersion = parsed.local_version?.trim() || null;

  return {
    valid: true,
    row: {
      id: safeId,
      name: safeName,
      package_id: safeId,
      local_version: safeVersion,
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
  if (!records.length) {
    log('Keine gültigen Pakete zum Upsert vorhanden.');
    return;
  }

  log(`${records.length} Paket(e) werden nach Supabase geschrieben.`);

  const chunkSize = 500;

  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);

    const { error } = await supabase
      .from('packages')
      .upsert(chunk, {
        onConflict: 'package_id',
      });

    if (error) {
      fail('Upsert nach Supabase fehlgeschlagen.', error);
    }

    log(`Upsert Chunk ${i + 1}-${Math.min(i + chunkSize, records.length)} erledigt.`);
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

  const chunkSize = 500;

  for (let i = 0; i < missingIds.length; i += chunkSize) {
    const chunk = missingIds.slice(i, i + chunkSize);

    const { error } = await supabase
      .from('packages')
      .update({
        package_status: 'missing',
        missing_since: now,
        check_status: 'skipped',
        check_message: 'Paket wurde beim letzten Git-Import nicht mehr gefunden.',
      })
      .in('package_id', chunk);

    if (error) {
      fail('Missing-Markierung fehlgeschlagen.', error);
    }
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
    warn(`Audit-Log fehlgeschlagen: ${error.message}`);
  }
}

async function auditChanges(records, existingMap) {
  let imported = 0;
  let updated = 0;
  let unchanged = 0;

  for (const row of records) {
    const existing = existingMap.get(row.package_id);

    if (!existing) {
      imported += 1;
      await insertAuditLog('package_imported', 'package', row.package_id, null, row);
      continue;
    }

    const changed =
      existing.control_hash !== row.control_hash ||
      existing.local_version !== row.local_version ||
      existing.name !== row.name ||
      existing.package_status === 'missing';

    if (changed) {
      updated += 1;
      await insertAuditLog('package_updated_from_import', 'package', row.package_id, existing, row);
    } else {
      unchanged += 1;
    }
  }

  log(`Audit: ${imported} neu, ${updated} geändert, ${unchanged} unverändert.`);
}

function cleanup() {
  if (existsSync(CONFIG.workDir)) {
    log(`Cleanup: ${CONFIG.workDir}`);
    rmSync(CONFIG.workDir, { recursive: true, force: true });
  }
}

async function main() {
  log('Starte Paketimport.');
  log(`Arbeitsverzeichnis: ${CONFIG.workDir}`);

  cleanup();

  mkdirSync(CONFIG.workDir, { recursive: true });

  runGitSparseCheckout();

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
    warn(`Übersprungen: ${invalid.source_path} (${invalid.reason})`);
  }

  const duplicateIds = records
    .map((record) => record.package_id)
    .filter((id, index, arr) => arr.indexOf(id) !== index);

  if (duplicateIds.length) {
    const uniqueDuplicateIds = [...new Set(duplicateIds)];
    warn(`Doppelte package_id gefunden: ${uniqueDuplicateIds.join(', ')}`);
    warn('Bei doppelten IDs gewinnt der letzte gefundene Datensatz beim Upsert.');
  }

  const existingMap = await getExistingPackages();

  await auditChanges(records, existingMap);
  await upsertPackages(records);
  await markMissingPackages(foundIds);

  log(`Import abgeschlossen.`);
  log(`Gültige Pakete: ${records.length}`);
  log(`Ungültige control-Dateien: ${invalidFiles.length}`);

  cleanup();
}

main().catch((error) => {
  fail('Unerwarteter Fehler beim Import.', error);
});

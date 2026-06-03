import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type CheckJob = {
  id: number;
  package_id: string | null;
  requested_by: string | null;
  job_type: string | null;
  status: string;
  priority: number | null;
};

type PackageRow = {
  package_id: string;
  name: string | null;
  local_version: string | null;
  online_version: string | null;
  check_status: string | null;
};

type PackageSource = {
  id: number;
  package_id: string;
  source_type: string;
  source_url: string;
  source_note: string | null;
  priority: number | null;
  enabled: boolean | null;
  reliability_score: number | null;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-process-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

async function getUserRole(
  supabaseUrl: string,
  supabaseAnonKey: string,
  authHeader: string | null,
): Promise<string | null> {
  if (!authHeader) return null;

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();

  if (userError || !userData.user) {
    return null;
  }

  const { data: profile, error: profileError } = await userClient
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single();

  if (profileError || !profile) {
    return null;
  }

  return profile.role;
}

function isAllowedRole(role: string | null): boolean {
  return role === 'maintainer' || role === 'admin';
}

async function loadQueuedJobs(adminClient: ReturnType<typeof createClient>, limit: number) {
  const { data, error } = await adminClient
    .from('check_jobs')
    .select('id, package_id, requested_by, job_type, status, priority')
    .eq('status', 'queued')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Konnte queued Jobs nicht laden: ${error.message}`);
  }

  return (data ?? []) as CheckJob[];
}

async function markJobRunning(adminClient: ReturnType<typeof createClient>, jobId: number) {
  const { error } = await adminClient
    .from('check_jobs')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      message: 'Job wird durch Edge Function verarbeitet.',
    })
    .eq('id', jobId)
    .eq('status', 'queued');

  if (error) {
    throw new Error(`Konnte Job ${jobId} nicht auf running setzen: ${error.message}`);
  }
}

async function markJobDone(adminClient: ReturnType<typeof createClient>, jobId: number, message: string) {
  const { error } = await adminClient
    .from('check_jobs')
    .update({
      status: 'done',
      finished_at: new Date().toISOString(),
      message,
    })
    .eq('id', jobId);

  if (error) {
    throw new Error(`Konnte Job ${jobId} nicht auf done setzen: ${error.message}`);
  }
}

async function markJobFailed(
  adminClient: ReturnType<typeof createClient>,
  jobId: number,
  errorType: string,
  errorDetail: string,
) {
  await adminClient
    .from('check_jobs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      message: 'Job ist fehlgeschlagen.',
      error_type: errorType,
      error_detail: errorDetail,
    })
    .eq('id', jobId);
}

async function loadPackage(adminClient: ReturnType<typeof createClient>, packageId: string) {
  const { data, error } = await adminClient
    .from('packages')
    .select('package_id, name, local_version, online_version, check_status')
    .eq('package_id', packageId)
    .single();

  if (error || !data) {
    throw new Error(`Paket nicht gefunden: ${packageId}`);
  }

  return data as PackageRow;
}

async function loadSources(adminClient: ReturnType<typeof createClient>, packageId: string) {
  const { data, error } = await adminClient
    .from('package_sources')
    .select('id, package_id, source_type, source_url, source_note, priority, enabled, reliability_score')
    .eq('package_id', packageId)
    .eq('enabled', true)
    .order('priority', { ascending: true })
    .order('reliability_score', { ascending: false });

  if (error) {
    throw new Error(`Quellen konnten nicht geladen werden: ${error.message}`);
  }

  return (data ?? []) as PackageSource[];
}

async function processOneJob(adminClient: ReturnType<typeof createClient>, job: CheckJob) {
  if (!job.package_id) {
    throw new Error(`Job ${job.id} hat keine package_id.`);
  }

  await markJobRunning(adminClient, job.id);

  const pkg = await loadPackage(adminClient, job.package_id);
  const sources = await loadSources(adminClient, job.package_id);

  const now = new Date().toISOString();

  // Dummy-Testlogik:
  // Aktuell wird noch keine echte Online-Version geprüft.
  // Wir setzen online_version testweise auf local_version und markieren als up_to_date.
  const dummyOnlineVersion = pkg.local_version ?? null;
  const hasSources = sources.length > 0;

  const checkStatus = hasSources ? 'up_to_date' : 'uncertain';
  const checkMessage = hasSources
    ? `Testlauf erfolgreich. ${sources.length} aktive Quelle(n) gefunden. Echte Online-Prüfung folgt im nächsten Schritt.`
    : 'Testlauf erfolgreich, aber keine aktive Quelle hinterlegt.';

  const source = sources[0] ?? null;

  const { error: checkInsertError } = await adminClient
    .from('package_checks')
    .insert({
      package_id: pkg.package_id,
      source_id: source?.id ?? null,
      local_version: pkg.local_version,
      online_version: dummyOnlineVersion,
      update_available: false,
      version_jump_type: null,
      version_jump_score: 0,
      version_compare_method: 'dummy',
      source_url: source?.source_url ?? null,
      confidence: hasSources ? 'medium' : 'low',
      message: checkMessage,
      raw_result: {
        mode: 'dummy_processor_test',
        job_id: job.id,
        package_id: pkg.package_id,
        package_name: pkg.name,
        sources_found: sources.length,
        processed_at: now,
      },
      checked_at: now,
    });

  if (checkInsertError) {
    throw new Error(`package_checks Insert fehlgeschlagen: ${checkInsertError.message}`);
  }

  const { error: packageUpdateError } = await adminClient
    .from('packages')
    .update({
      online_version: dummyOnlineVersion,
      update_available: false,
      version_jump_type: null,
      version_jump_score: 0,
      version_compare_method: 'dummy',
      version_compare_message: 'Dummy-Testlauf ohne echte Online-Prüfung.',
      last_checked: now,
      check_status: checkStatus,
      check_message: checkMessage,
      last_successful_source_id: source?.id ?? null,
    })
    .eq('package_id', pkg.package_id);

  if (packageUpdateError) {
    throw new Error(`packages Update fehlgeschlagen: ${packageUpdateError.message}`);
  }

  await markJobDone(adminClient, job.id, checkMessage);

  return {
    job_id: job.id,
    package_id: pkg.package_id,
    status: 'done',
    message: checkMessage,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders,
    });
  }

  if (req.method !== 'POST') {
    return jsonResponse({
      error: 'Method not allowed',
    }, 405);
  }

  try {
    const supabaseUrl = requireEnv('SUPABASE_URL');
    const supabaseAnonKey = requireEnv('SUPABASE_ANON_KEY');
    const supabaseServiceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const processSecret = Deno.env.get('PROCESS_CHECK_JOBS_SECRET') ?? null;
    const requestSecret = req.headers.get('x-process-secret');

    const authHeader = req.headers.get('Authorization');
    const role = await getUserRole(supabaseUrl, supabaseAnonKey, authHeader);

    const allowedByRole = isAllowedRole(role);
    const allowedBySecret = processSecret && requestSecret && requestSecret === processSecret;

    if (!allowedByRole && !allowedBySecret) {
      return jsonResponse({
        error: 'Nicht berechtigt.',
        role,
      }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const limit = Math.max(1, Math.min(Number(body.limit ?? 5), 25));

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const jobs = await loadQueuedJobs(adminClient, limit);

    const results = [];

    for (const job of jobs) {
      try {
        const result = await processOneJob(adminClient, job);
        results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        await markJobFailed(adminClient, job.id, 'unknown', message);

        if (job.package_id) {
          await adminClient
            .from('packages')
            .update({
              check_status: 'failed',
              check_message: message,
            })
            .eq('package_id', job.package_id);
        }

        results.push({
          job_id: job.id,
          package_id: job.package_id,
          status: 'failed',
          message,
        });
      }
    }

    return jsonResponse({
      ok: true,
      processed: results.length,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return jsonResponse({
      ok: false,
      error: message,
    }, 500);
  }
});
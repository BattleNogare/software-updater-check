# ==========================================================
# Software Update Manager - JSON Import nach Supabase
# Liest packages-export.json und schreibt packages nach Supabase
# Nutzt curl.exe + UTF-8 ohne BOM für sauberen JSON-Body
# ==========================================================

$ErrorActionPreference = "Stop"

$ProjectDir = "C:\Users\CLD\Desktop\software-updater-check"
$VaultName = "SoftwareUpdaterVault"
$JsonPath = Join-Path $env:USERPROFILE "Downloads\packages-export.json"

$LogDir = Join-Path $ProjectDir "logs"
$LogFile = Join-Path $LogDir ("import-json-{0}.log" -f (Get-Date -Format "yyyy-MM-dd_HH-mm-ss"))

$IncludeControlRaw = $true
$ChunkSize = 100

function Write-Log {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  $Line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $Line
  Add-Content -Path $LogFile -Value $Line -Encoding UTF8
}

function Test-CommandAvailable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command
  )

  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "Befehl '$Command' wurde nicht gefunden."
  }
}

function Get-RequiredSecret {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $SecretValue = Get-Secret -Name $Name -Vault $VaultName -AsPlainText -ErrorAction Stop

  if ([string]::IsNullOrWhiteSpace($SecretValue)) {
    throw "Secret '$Name' ist leer."
  }

  return $SecretValue
}

function Convert-ToJsonBody {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Body
  )

  return ($Body | ConvertTo-Json -Depth 100 -Compress)
}

function Write-Utf8NoBomFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Content
  )

  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Invoke-SupabaseCurl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Method,

    [Parameter(Mandatory = $true)]
    [string]$Url,

    [Parameter(Mandatory = $true)]
    [string]$ServiceRoleKey,

    [object]$Body = $null,

    [hashtable]$ExtraHeaders = @{}
  )

  $ResponseFile = Join-Path $env:TEMP ("supabase-response-{0}.txt" -f ([guid]::NewGuid()))
  $BodyFile = $null

  $Args = @(
    "-sS",
    "-X", $Method,
    $Url,
    "-H", "apikey: $ServiceRoleKey",
    "-H", "Authorization: Bearer $ServiceRoleKey",
    "-H", "Content-Type: application/json; charset=utf-8",
    "-H", "Accept: application/json"
  )

  foreach ($Key in $ExtraHeaders.Keys) {
    $Args += @("-H", "$Key`: $($ExtraHeaders[$Key])")
  }

  if ($null -ne $Body) {
    $JsonBody = Convert-ToJsonBody -Body $Body
    $BodyFile = Join-Path $env:TEMP ("supabase-body-{0}.json" -f ([guid]::NewGuid()))
    Write-Utf8NoBomFile -Path $BodyFile -Content $JsonBody

    $Args += @("--data-binary", "@$BodyFile")
  }

  $Args += @(
    "-o", $ResponseFile,
    "-w", "%{http_code}"
  )

  try {
    $StatusText = & curl.exe @Args
    $CurlExitCode = $LASTEXITCODE

    if ($CurlExitCode -ne 0) {
      throw "curl.exe ist fehlgeschlagen. ExitCode: $CurlExitCode"
    }

    $StatusCode = [int]$StatusText
    $Content = ""

    if (Test-Path $ResponseFile) {
      $Content = Get-Content -Path $ResponseFile -Raw -Encoding UTF8
    }

    if ($StatusCode -lt 200 -or $StatusCode -ge 300) {
      Write-Log "Supabase Request fehlgeschlagen."
      Write-Log "Methode: $Method"
      Write-Log "URL: $Url"
      Write-Log "HTTP Status: $StatusCode"

      if (-not [string]::IsNullOrWhiteSpace($Content)) {
        Write-Log "Supabase Antwort:"
        Write-Log $Content
      }

      if ($null -ne $Body) {
        $Preview = Convert-ToJsonBody -Body $Body

        if ($Preview.Length -gt 4000) {
          Write-Log ("Request Body Preview: " + $Preview.Substring(0, 4000) + " ...")
        }
        else {
          Write-Log ("Request Body: " + $Preview)
        }
      }

      throw "Supabase Request fehlgeschlagen. HTTP Status: $StatusCode"
    }

    return [pscustomobject]@{
      StatusCode = $StatusCode
      Content    = $Content
    }
  }
  finally {
    if ($BodyFile -and (Test-Path $BodyFile)) {
      Remove-Item $BodyFile -Force -ErrorAction SilentlyContinue
    }

    if (Test-Path $ResponseFile) {
      Remove-Item $ResponseFile -Force -ErrorAction SilentlyContinue
    }
  }
}

function Split-Array {
  param(
    [Parameter(Mandatory = $true)]
    [array]$Items,

    [int]$Size = 100
  )

  for ($i = 0; $i -lt $Items.Count; $i += $Size) {
    ,$Items[$i..([Math]::Min($i + $Size - 1, $Items.Count - 1))]
  }
}

function Convert-ToSafeTextOrNull {
  param($Value)

  if ($null -eq $Value) {
    return $null
  }

  $Text = [string]$Value

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return $null
  }

  $Text = $Text -replace "`0", ""

  return $Text
}

function New-PackageRow {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Pkg,

    [Parameter(Mandatory = $true)]
    [string]$Now
  )

  $PackageId = Convert-ToSafeTextOrNull $Pkg.package_id

  if ([string]::IsNullOrWhiteSpace($PackageId)) {
    return $null
  }

  $PackageId = $PackageId.Trim()

  $Name = Convert-ToSafeTextOrNull $Pkg.name
  if ([string]::IsNullOrWhiteSpace($Name)) {
    $Name = $PackageId
  }

  $Row = [ordered]@{
    id             = $PackageId
    name           = $Name
    package_id     = $PackageId
    local_version  = Convert-ToSafeTextOrNull $Pkg.local_version
    source_path    = Convert-ToSafeTextOrNull $Pkg.source_path
    control_hash   = Convert-ToSafeTextOrNull $Pkg.control_hash
    package_status = "active"
    last_seen_at   = $Now
    missing_since  = $null
    check_message  = "Paket wurde aus GitLab-Webexport importiert."
  }

  if ($IncludeControlRaw) {
    $Row["control_raw"] = Convert-ToSafeTextOrNull $Pkg.control_raw
  }

  return $Row
}

function Test-SingleRowsInChunk {
  param(
    [Parameter(Mandatory = $true)]
    [array]$Chunk,

    [Parameter(Mandatory = $true)]
    [string]$PackagesUrl,

    [Parameter(Mandatory = $true)]
    [string]$ServiceRoleKey
  )

  Write-Log "Starte Einzelzeilen-Isolation für fehlerhaften Chunk."

  foreach ($Row in $Chunk) {
    $PackageId = [string]$Row.package_id

    Write-Log "Teste Einzelimport: $PackageId"

    try {
      Invoke-SupabaseCurl `
        -Method "POST" `
        -Url $PackagesUrl `
        -ServiceRoleKey $ServiceRoleKey `
        -Body @($Row) `
        -ExtraHeaders @{
          "Prefer" = "resolution=merge-duplicates,return=minimal"
        } | Out-Null

      Write-Log "Einzelimport OK: $PackageId"
    }
    catch {
      Write-Log "Problematischer Datensatz gefunden: $PackageId"
      Write-Log ($Row | ConvertTo-Json -Depth 100 -Compress)
      throw
    }
  }
}

try {
  if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
  }

  Write-Log "Starte JSON-Import nach Supabase."
  Write-Log "Projektordner: $ProjectDir"
  Write-Log "JSON-Datei: $JsonPath"
  Write-Log "IncludeControlRaw: $IncludeControlRaw"
  Write-Log "ChunkSize: $ChunkSize"

  Test-CommandAvailable -Command "curl.exe"

  if (-not (Test-Path $JsonPath)) {
    throw "JSON-Datei wurde nicht gefunden: $JsonPath"
  }

  Import-Module Microsoft.PowerShell.SecretManagement -ErrorAction Stop

  $SupabaseUrl = Get-RequiredSecret -Name "SUPABASE_URL"
  $ServiceRoleKey = Get-RequiredSecret -Name "SUPABASE_SERVICE_ROLE_KEY"

  $SupabaseUrl = $SupabaseUrl.TrimEnd("/")

  Write-Log "Supabase URL: $SupabaseUrl"

  $ExportData = Get-Content -Path $JsonPath -Raw -Encoding UTF8 | ConvertFrom-Json

  if (-not $ExportData.packages) {
    throw "In der JSON-Datei wurde kein Feld 'packages' gefunden."
  }

  $PackagesRaw = @($ExportData.packages)

  Write-Log "Pakete in JSON: $($PackagesRaw.Count)"

  if ($ExportData.stats) {
    Write-Log ("Export-Statistik: " + ($ExportData.stats | ConvertTo-Json -Compress -Depth 10))
  }

  $Now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

  $PackageMap = @{}
  $Skipped = 0

  foreach ($Pkg in $PackagesRaw) {
    $Row = New-PackageRow -Pkg $Pkg -Now $Now

    if ($null -eq $Row) {
      $Skipped++
      continue
    }

    $PackageMap[[string]$Row.package_id] = $Row
  }

  $Rows = @($PackageMap.Values)

  Write-Log "Gültige Pakete nach Deduplizierung: $($Rows.Count)"
  Write-Log "Übersprungene Pakete ohne package_id: $Skipped"

  if ($Rows.Count -eq 0) {
    throw "Keine gültigen Pakete zum Import gefunden."
  }

  $SchemaTestUrl = "$SupabaseUrl/rest/v1/packages?select=package_id&limit=1"
  Write-Log "Teste Supabase Tabellenzugriff."

  Invoke-SupabaseCurl `
    -Method "GET" `
    -Url $SchemaTestUrl `
    -ServiceRoleKey $ServiceRoleKey | Out-Null

  Write-Log "Tabellenzugriff OK."

  $PackagesUrl = "$SupabaseUrl/rest/v1/packages?on_conflict=package_id"

  $ChunkNumber = 0

  foreach ($Chunk in Split-Array -Items $Rows -Size $ChunkSize) {
    $ChunkNumber++

    Write-Log "Schreibe Chunk $ChunkNumber mit $($Chunk.Count) Paket(en)."

    try {
      Invoke-SupabaseCurl `
        -Method "POST" `
        -Url $PackagesUrl `
        -ServiceRoleKey $ServiceRoleKey `
        -Body $Chunk `
        -ExtraHeaders @{
          "Prefer" = "resolution=merge-duplicates,return=minimal"
        } | Out-Null
    }
    catch {
      Write-Log "Fehler in Chunk $ChunkNumber."

      Test-SingleRowsInChunk `
        -Chunk $Chunk `
        -PackagesUrl $PackagesUrl `
        -ServiceRoleKey $ServiceRoleKey

      throw
    }
  }

  Write-Log "Pakete wurden geschrieben/aktualisiert."

  Write-Log "Prüfe auf fehlende Pakete."

  $ExistingUrl = "$SupabaseUrl/rest/v1/packages?select=package_id"
  $ExistingResponse = Invoke-SupabaseCurl `
    -Method "GET" `
    -Url $ExistingUrl `
    -ServiceRoleKey $ServiceRoleKey

  $Existing = @()

  if (-not [string]::IsNullOrWhiteSpace($ExistingResponse.Content)) {
    $Existing = $ExistingResponse.Content | ConvertFrom-Json
  }

  $FoundIds = @{}

  foreach ($Row in $Rows) {
    $FoundIds[[string]$Row.package_id] = $true
  }

  $MissingIds = @()

  foreach ($ExistingPkg in $Existing) {
    $ExistingId = [string]$ExistingPkg.package_id

    if (-not $FoundIds.ContainsKey($ExistingId)) {
      $MissingIds += $ExistingId
    }
  }

  if ($MissingIds.Count -eq 0) {
    Write-Log "Keine fehlenden Pakete erkannt."
  }
  else {
    Write-Log "$($MissingIds.Count) Paket(e) fehlen im Export und werden als missing markiert."

    foreach ($MissingChunk in Split-Array -Items $MissingIds -Size 100) {
      $QuotedIds = ($MissingChunk | ForEach-Object {
        '"' + ($_ -replace '"', '\"') + '"'
      }) -join ","

      $PatchUrl = "$SupabaseUrl/rest/v1/packages?package_id=in.($QuotedIds)"

      $PatchBody = @{
        package_status = "missing"
        missing_since  = $Now
        check_status   = "skipped"
        check_message  = "Paket wurde beim letzten GitLab-Webexport nicht mehr gefunden."
      }

      Invoke-SupabaseCurl `
        -Method "PATCH" `
        -Url $PatchUrl `
        -ServiceRoleKey $ServiceRoleKey `
        -Body $PatchBody `
        -ExtraHeaders @{
          "Prefer" = "return=minimal"
        } | Out-Null
    }
  }

  Write-Log "JSON-Import erfolgreich abgeschlossen."
}
catch {
  Write-Log "FEHLER: $($_.Exception.Message)"
  exit 1
}
finally {
  Write-Log "Script beendet."
}
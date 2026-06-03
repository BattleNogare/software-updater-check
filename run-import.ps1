# ==========================================================
# Software Update Manager - Paketimport Wrapper
# Startet den Sparse-Checkout-Importer scripts/import-packages.js
# Secrets werden aus Windows SecretManagement / SecretStore gelesen
# ==========================================================

$ErrorActionPreference = "Stop"

# Projektordner
$ProjectDir = "C:\Users\CLD\Desktop\software-updater-check"

# Vault-Name
$VaultName = "SoftwareUpdaterVault"

# Optional: maximale Tiefe für control-Dateien
# 1 = */control
# 2 = */*/control
# 8 = großzügig für tiefere Strukturen
$MaxControlDepth = "8"

# Logging
$LogDir = Join-Path $ProjectDir "logs"
$LogFile = Join-Path $LogDir ("import-packages-{0}.log" -f (Get-Date -Format "yyyy-MM-dd_HH-mm-ss"))

# ==========================================================
# Hilfsfunktionen
# ==========================================================

function Write-Log {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  $Line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $Line

  if (Test-Path $LogDir) {
    Add-Content -Path $LogFile -Value $Line -Encoding UTF8
  }
}

function Get-RequiredSecret {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  try {
    $SecretValue = Get-Secret -Name $Name -Vault $VaultName -AsPlainText -ErrorAction Stop

    if ([string]::IsNullOrWhiteSpace($SecretValue)) {
      throw "Secret ist leer."
    }

    return $SecretValue
  }
  catch {
    throw "Secret '$Name' konnte nicht aus Vault '$VaultName' gelesen werden. Fehler: $($_.Exception.Message)"
  }
}

function Test-CommandAvailable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command
  )

  $Found = Get-Command $Command -ErrorAction SilentlyContinue

  if (-not $Found) {
    throw "Befehl '$Command' wurde nicht gefunden. Bitte installieren oder PATH prüfen."
  }
}

function Invoke-LoggedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $OldErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"

  try {
    Write-Log ("Führe aus: {0} {1}" -f $Command, ($Arguments -join " "))

    & $Command @Arguments *>&1 | ForEach-Object {
      $Line = $_.ToString()
      Write-Host $Line
      Add-Content -Path $LogFile -Value $Line -Encoding UTF8
    }

    $ExitCode = $LASTEXITCODE

    if ($ExitCode -ne 0) {
      throw "Befehl fehlgeschlagen: $Command $($Arguments -join ' ') ExitCode: $ExitCode"
    }
  }
  finally {
    $ErrorActionPreference = $OldErrorActionPreference
  }
}

function Test-ImporterLooksLikeSparseCheckout {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ImporterPath
  )

  $Content = Get-Content -Path $ImporterPath -Raw -Encoding UTF8

  if ($Content -match "runGitClone\s*\(") {
    throw "Die import-packages.js enthält noch runGitClone(). Bitte durch die Sparse-Checkout-Version ersetzen."
  }

  if ($Content -notmatch "runGitSparseCheckout\s*\(") {
    throw "Die import-packages.js enthält keine runGitSparseCheckout()-Funktion. Bitte Sparse-Checkout-Version verwenden."
  }

  if ($Content -notmatch "--filter=blob:none") {
    throw "Die import-packages.js scheint keinen Sparse/Partial-Clone zu verwenden. '--filter=blob:none' wurde nicht gefunden."
  }
}

# ==========================================================
# Start
# ==========================================================

try {
  if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
  }

  Write-Log "Starte Software-Updater Paketimport."
  Write-Log "Projektordner: $ProjectDir"

  if (-not (Test-Path $ProjectDir)) {
    throw "Projektordner wurde nicht gefunden: $ProjectDir"
  }

  Write-Log "Prüfe benötigte Befehle."
  Test-CommandAvailable -Command "node"
  Test-CommandAvailable -Command "npm.cmd"
  Test-CommandAvailable -Command "git"

  $NodeVersion = (& node -v)
  Write-Log "Node-Version: $NodeVersion"

  Write-Log "Lade PowerShell SecretManagement Modul."
  Import-Module Microsoft.PowerShell.SecretManagement -ErrorAction Stop

  $Vault = Get-SecretVault -Name $VaultName -ErrorAction SilentlyContinue

  if (-not $Vault) {
    throw "Secret Vault '$VaultName' wurde nicht gefunden. Bitte zuerst die Einrichtung ausführen."
  }

  Write-Log "Lese Secrets aus Vault '$VaultName'."

  $env:PRIVATE_GIT_URL = Get-RequiredSecret -Name "PRIVATE_GIT_URL"
  $env:PRIVATE_GIT_TOKEN = Get-RequiredSecret -Name "PRIVATE_GIT_TOKEN"
  $env:SUPABASE_URL = Get-RequiredSecret -Name "SUPABASE_URL"
  $env:SUPABASE_SERVICE_ROLE_KEY = Get-RequiredSecret -Name "SUPABASE_SERVICE_ROLE_KEY"

  # Optionaler Branch, wenn im Vault vorhanden.
  # Wenn nicht vorhanden, wird HEAD verwendet.
  try {
    $OptionalBranch = Get-Secret -Name "PRIVATE_GIT_BRANCH" -Vault $VaultName -AsPlainText -ErrorAction Stop
    if (-not [string]::IsNullOrWhiteSpace($OptionalBranch)) {
      $env:PRIVATE_GIT_BRANCH = $OptionalBranch
      Write-Log "PRIVATE_GIT_BRANCH wurde gesetzt."
    }
  }
  catch {
    $env:PRIVATE_GIT_BRANCH = $null
    Write-Log "PRIVATE_GIT_BRANCH nicht gesetzt. Verwende Standard-HEAD."
  }

  $env:MAX_CONTROL_DEPTH = $MaxControlDepth

  Write-Log "Wechsle in Projektordner."
  Set-Location $ProjectDir

  if (-not (Test-Path "package.json")) {
    throw "package.json wurde im Projektordner nicht gefunden."
  }

  $ImporterPath = Join-Path $ProjectDir "scripts\import-packages.js"

  if (-not (Test-Path $ImporterPath)) {
    throw "scripts\import-packages.js wurde nicht gefunden."
  }

  Write-Log "Prüfe, ob import-packages.js die Sparse-Checkout-Version ist."
  Test-ImporterLooksLikeSparseCheckout -ImporterPath $ImporterPath
  Write-Log "Sparse-Checkout-Importer erkannt."

  if (-not (Test-Path "node_modules")) {
    Write-Log "node_modules nicht gefunden. Führe npm install aus."
    Invoke-LoggedCommand -Command "npm.cmd" -Arguments @("install")
  }
  else {
    Write-Log "node_modules vorhanden. npm install wird übersprungen."
  }

  Write-Log "Starte npm run import-packages."
  Invoke-LoggedCommand -Command "npm.cmd" -Arguments @("run", "import-packages")

  Write-Log "Paketimport erfolgreich abgeschlossen."
}
catch {
  Write-Log "FEHLER: $($_.Exception.Message)"
  exit 1
}
finally {
  Write-Log "Bereinige ENV-Variablen."

  $env:PRIVATE_GIT_URL = $null
  $env:PRIVATE_GIT_TOKEN = $null
  $env:SUPABASE_URL = $null
  $env:SUPABASE_SERVICE_ROLE_KEY = $null
  $env:PRIVATE_GIT_BRANCH = $null
  $env:MAX_CONTROL_DEPTH = $null

  Write-Log "Script beendet."
}
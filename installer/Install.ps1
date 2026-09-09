<#
.SYNOPSIS
  Installe Booksy Receipt Bridge pour l'utilisateur courant.

.DESCRIPTION
  Plan sections 12, 50 et 53.

  SANS DROITS ADMINISTRATEUR. Tout va dans le profil de l'utilisateur :
  l'exécutable sous %LOCALAPPDATA%, l'enregistrement Native Messaging sous
  HKCU. C'est la préférence explicite de la section 12, et ça évite une
  élévation qui bloquerait une installation en poste contraint.

  Chaque navigateur Chromium détecté reçoit son entrée de registre. Un
  navigateur absent est ignoré, pas signalé comme une erreur (section 53).

.PARAMETER ExtensionId
  Identifiant de l'extension autorisée. Répétable : le Chrome Web Store et
  Edge Add-ons attribuent des identifiants différents (section 52).

.PARAMETER Source
  Dossier contenant booksy-receipt-bridge.exe et pdfjs\. Par défaut, celui
  du script.

.EXAMPLE
  .\Install.ps1
  .\Install.ps1 -ExtensionId abcdef...,ghijkl...
#>
[CmdletBinding()]
param(
  [string[]]$ExtensionId = @('ndfcmfgnelpdjgpmaelpdgoccmjcpdjm'),
  [string]$Source = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

$HostName    = 'com.alexdevlab.booksy_receipt_bridge'
$InstallDir  = Join-Path $env:LOCALAPPDATA 'Programs\BooksyReceiptBridge'
$DataDir     = Join-Path $env:APPDATA 'BooksyReceiptBridge'
$ExeName     = 'booksy-receipt-bridge.exe'

function Write-Step($message) { Write-Host "  $message" }

# --- 1. vérifier la source -------------------------------------------------
$exeSource = Join-Path $Source $ExeName
if (-not (Test-Path $exeSource)) {
  throw "$ExeName introuvable dans $Source. Lancez ce script depuis le dossier livré."
}
$pdfjsSource = Join-Path $Source 'pdfjs'
if (-not (Test-Path (Join-Path $pdfjsSource 'standard_fonts'))) {
  throw "Le dossier pdfjs\standard_fonts est absent de $Source. La lecture des PDF échouerait."
}

Write-Host "`nBooksy Receipt Bridge — installation`n"

# --- 2. installer les fichiers ---------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $exeSource -Destination $InstallDir -Force
# Récursif et en écrasant : une mise à jour doit remplacer les polices aussi.
Copy-Item $pdfjsSource -Destination $InstallDir -Recurse -Force
$exePath = Join-Path $InstallDir $ExeName
Write-Step "exécutable   $exePath"

# L'extension est copiée à un emplacement stable plutôt que chargée depuis le
# dossier décompressé : Chrome retient le CHEMIN d'une extension non
# empaquetée, et l'utilisateur qui vide ses Téléchargements casserait
# l'installation. Ce chemin ne bouge plus, et une mise à jour l'écrase — le
# navigateur reprend les nouveaux fichiers au redémarrage.
$extensionSource = Join-Path $Source 'extension'
$extensionPath   = Join-Path $InstallDir 'extension'
if (Test-Path (Join-Path $extensionSource 'manifest.json')) {
  if (Test-Path $extensionPath) { Remove-Item $extensionPath -Recurse -Force }
  Copy-Item $extensionSource -Destination $extensionPath -Recurse -Force
  Write-Step "extension    $extensionPath"
} else {
  $extensionPath = $null
  Write-Step "extension    absente de la livraison, rien à copier"
}

# --- 3. manifest Native Messaging ------------------------------------------
# allowed_origins liste des origines exactes : jamais de wildcard (section 11).
$origins = $ExtensionId | ForEach-Object { "chrome-extension://$_/" }
$manifest = [ordered]@{
  name            = $HostName
  description     = 'Booksy Receipt Bridge'
  path            = $exePath
  type            = 'stdio'
  allowed_origins = @($origins)
}
$manifestPath = Join-Path $InstallDir "$HostName.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8
Write-Step "manifest     $manifestPath"
Write-Step "origines     $($origins -join ', ')"

# --- 4. registre, par navigateur détecté -----------------------------------
$browsers = @(
  @{ Name = 'Chrome';   Key = 'HKCU:\Software\Google\Chrome' },
  @{ Name = 'Edge';     Key = 'HKCU:\Software\Microsoft\Edge' },
  @{ Name = 'Brave';    Key = 'HKCU:\Software\BraveSoftware\Brave-Browser' },
  @{ Name = 'Chromium'; Key = 'HKCU:\Software\Chromium' }
)

$registered = @()
foreach ($browser in $browsers) {
  $target = Join-Path $browser.Key "NativeMessagingHosts\$HostName"
  # Créé même si la clé du navigateur n'existe pas encore : l'utilisateur peut
  # installer le navigateur après, et une clé orpheline est inoffensive.
  New-Item -Path $target -Force | Out-Null
  Set-ItemProperty -Path $target -Name '(default)' -Value $manifestPath
  $registered += $browser.Name
}
Write-Step "registre     $($registered -join ', ') (HKCU, sans élévation)"

# --- 5. configuration, sans écraser l'existante ----------------------------
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$configPath = Join-Path $DataDir 'config.json'
if (Test-Path $configPath) {
  Write-Step "config       conservée ($configPath)"
} else {
  # Aucune imprimante par défaut : le modèle est choisi par l'utilisateur
  # (section 65), et le host refuse d'imprimer tant qu'elle est vide.
  $config = [ordered]@{
    printer  = [ordered]@{ name = ''; kind = 'thermal'; paperWidth = 80; printableWidth = 72; columns = 42 }
    printing = [ordered]@{ autoPrint = $false; showPreview = $true; confidenceThreshold = 0.9; allowedDirs = @() }
  }
  $config | ConvertTo-Json -Depth 4 | Set-Content -Path $configPath -Encoding UTF8
  Write-Step "config       $configPath"
}

# --- 6. vérifier l'accès aux imprimantes (section 12, étape 5) -------------
Write-Host ''
try {
  $printers = @(Get-Printer -ErrorAction Stop | Select-Object -ExpandProperty Name)
  if ($printers.Count -eq 0) {
    Write-Warning 'Aucune imprimante trouvée sur ce poste.'
  } else {
    Write-Step "imprimantes  $($printers.Count) détectée(s)"
    $thermal = $printers | Where-Object { $_ -match 'TM-T88|thermal|receipt' }
    if ($thermal) { Write-Step "candidate    $($thermal -join ', ')" }
  }
} catch {
  Write-Warning "Impossible de lister les imprimantes : $($_.Exception.Message)"
}

# --- 7. contrôle de bon fonctionnement -------------------------------------
Write-Host ''
try {
  $version = & $exePath --version
  Write-Step "service      version $version"
} catch {
  throw "Le service ne démarre pas : $($_.Exception.Message)"
}

Copy-Item (Join-Path $PSScriptRoot 'Uninstall.ps1') -Destination $InstallDir -Force -ErrorAction SilentlyContinue

$loadFrom = if ($extensionPath) { $extensionPath } else { '<dossier extension de la livraison>' }

Write-Host @"

Installation terminée.

  1. Dans Chrome ou Edge, ouvrez la page des extensions :
       chrome://extensions   (Edge : edge://extensions)
     Activez le mode développeur, puis « Charger l'extension non empaquetée »
     et choisissez EXACTEMENT ce dossier :

       $loadFrom

  2. Ouvrez le popup de l'extension : « Service connecté ».
  3. Choisissez l'imprimante dans Paramètres, ou en ligne de commande :

       & "$exePath" config set printer.name "EPSON TM-T88V Receipt5"

  4. Ouvrez un reçu PDF dans un onglet et cliquez « Imprimer » : l'aperçu
     s'ouvre, vous validez.

Une mise à jour réécrit ce même dossier : rien à recharger à la main, le
navigateur reprend les nouveaux fichiers au redémarrage.

Désinstallation : & "$(Join-Path $InstallDir 'Uninstall.ps1')"
"@

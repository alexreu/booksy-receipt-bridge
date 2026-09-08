<#
.SYNOPSIS
  Retire Booksy Receipt Bridge du profil de l'utilisateur courant.

.DESCRIPTION
  Retire l'enregistrement Native Messaging et les fichiers installés.

  LA CONFIGURATION ET LES JOURNAUX SONT CONSERVÉS par défaut : ce sont les
  données de l'utilisateur, et une réinstallation doit retrouver son
  imprimante. -Purge les supprime aussi.

.PARAMETER Purge
  Supprime également %APPDATA%\BooksyReceiptBridge (config et journaux).
#>
[CmdletBinding()]
param([switch]$Purge)

$ErrorActionPreference = 'Stop'

$HostName   = 'com.alexdevlab.booksy_receipt_bridge'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\BooksyReceiptBridge'
$DataDir    = Join-Path $env:APPDATA 'BooksyReceiptBridge'

Write-Host "`nBooksy Receipt Bridge — désinstallation`n"

foreach ($key in @(
  'HKCU:\Software\Google\Chrome',
  'HKCU:\Software\Microsoft\Edge',
  'HKCU:\Software\BraveSoftware\Brave-Browser',
  'HKCU:\Software\Chromium'
)) {
  $target = Join-Path $key "NativeMessagingHosts\$HostName"
  if (Test-Path $target) {
    Remove-Item -Path $target -Recurse -Force
    Write-Host "  registre retiré  $target"
  }
}

if (Test-Path $InstallDir) {
  Remove-Item -Path $InstallDir -Recurse -Force
  Write-Host "  fichiers retirés $InstallDir"
}

if ($Purge) {
  if (Test-Path $DataDir) {
    Remove-Item -Path $DataDir -Recurse -Force
    Write-Host "  données retirées $DataDir"
  }
} elseif (Test-Path $DataDir) {
  Write-Host "  données conservées $DataDir (relancez avec -Purge pour les supprimer)"
}

Write-Host "`nTerminé.`n"

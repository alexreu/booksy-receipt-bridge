<#
.SYNOPSIS
  Lists the Windows print queues, so the spike can be pointed at the right one.

.DESCRIPTION
  Phase 1.5b. Also a preview of what LIST_PRINTERS has to return in phase 6.
  Note whether the run needed elevation: the host must work without it.
#>
$ErrorActionPreference = 'Stop'

Get-Printer |
  Select-Object Name, DriverName, PortName, PrinterStatus, Shared |
  Sort-Object Name |
  Format-Table -AutoSize

Write-Host ''
Write-Host 'Default printer:'
(Get-CimInstance -ClassName Win32_Printer -Filter 'Default = TRUE').Name

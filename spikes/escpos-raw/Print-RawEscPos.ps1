<#
.SYNOPSIS
  Sends a raw ESC/POS byte file straight to a Windows printer queue.

.DESCRIPTION
  Phase 1.5b spike. Opens the printer with datatype RAW and writes the bytes
  through the spooler, bypassing the driver's rendering and page setup entirely.
  That is the whole point: no scaling, no page size negotiation, no print dialog.

  P/Invoke into winspool.drv rather than a Node native module, so the spike needs
  nothing installed but Windows PowerShell.

.PARAMETER PrinterName
  Exact queue name, e.g. "EPSON TM-T88V Receipt5". Run .\Get-Printers.ps1 first.

.PARAMETER Path
  The .escpos.bin produced by `pnpm spike:sample`.

.EXAMPLE
  .\Print-RawEscPos.ps1 -PrinterName "EPSON TM-T88V Receipt5" -Path .\test-ticket.escpos.bin
#>
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

public static class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinterW(string printerName, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool StartDocPrinterW(IntPtr handle, int level, ref DOCINFOW info);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr handle, IntPtr buffer, int count, out int written);

  static void Check(bool ok, string what) {
    if (!ok) throw new Exception(what + " failed, Win32 error " + Marshal.GetLastWin32Error());
  }

  public static int SendBytes(string printerName, byte[] bytes) {
    IntPtr handle;
    Check(OpenPrinterW(printerName, out handle, IntPtr.Zero), "OpenPrinter");
    try {
      DOCINFOW info = new DOCINFOW();
      info.pDocName = "Booksy Receipt Bridge spike";
      info.pDataType = "RAW";
      Check(StartDocPrinterW(handle, 1, ref info), "StartDocPrinter");
      try {
        Check(StartPagePrinter(handle), "StartPagePrinter");
        IntPtr buffer = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, buffer, bytes.Length);
          int written;
          Check(WritePrinter(handle, buffer, bytes.Length, out written), "WritePrinter");
          return written;
        } finally {
          Marshal.FreeCoTaskMem(buffer);
          EndPagePrinter(handle);
        }
      } finally {
        EndDocPrinter(handle);
      }
    } finally {
      ClosePrinter(handle);
    }
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

$resolved = (Resolve-Path -LiteralPath $Path).Path
$bytes = [System.IO.File]::ReadAllBytes($resolved)
Write-Host "sending $($bytes.Length) bytes from $resolved"

$written = [RawPrinter]::SendBytes($PrinterName, $bytes)
Write-Host "spooler accepted $written bytes for '$PrinterName'"

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Printer } from '@brb/shared';
import { emitEscPos } from '@brb/receipt-renderer';
import { buildTestTicketLayout } from './test-ticket.ts';
import { toWindowsAnsi } from './windows-ansi.ts';
import type { PrinterAdapter, PrinterConfig, PrintResult } from './types.ts';

/**
 * Windows printing through the spooler in RAW mode.
 *
 * WHY POWERSHELL AND NOT AN FFI BINDING. The bytes have to reach
 * `WritePrinter` with datatype RAW, which means calling winspool.drv. A native
 * addon (koffi, ffi-napi) would be faster, but a `.node` file cannot be embedded
 * in a Node single-executable build, so it would have to ship beside the .exe
 * and be found at runtime - against AC20, which wants one installable artifact
 * and no Node on the client. PowerShell with an inline P/Invoke costs a few
 * hundred milliseconds of start-up and needs nothing installed.
 *
 * RAW is the point: it bypasses the driver's rendering and page setup entirely,
 * so nothing rescales the ticket and no dialog appears (AC14, AC15).
 *
 * If the phase 1.5b spike shows the start-up cost or an antivirus makes this
 * impractical, only this file changes - the interface and everything above it
 * stay put.
 */

const POWERSHELL = 'powershell.exe';
const EXEC_TIMEOUT_MS = 20_000;

/** Inline C# that reaches winspool.drv. Kept verbatim from the 1.5b spike. */
const RAW_PRINT_SOURCE = String.raw`
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

  public static int SendBytes(string printerName, string documentName, byte[] bytes, string dataType) {
    IntPtr handle;
    Check(OpenPrinterW(printerName, out handle, IntPtr.Zero), "OpenPrinter");
    try {
      DOCINFOW info = new DOCINFOW();
      info.pDocName = documentName;
      info.pDataType = dataType;
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
`;

export interface PowerShellResult {
  stdout: string;
  stderr: string;
}

/**
 * Both streams, deliberately.
 *
 * PowerShell reading a script from stdin exits 0 even when that script throws,
 * so the exit code proves nothing and stderr is the only place the reason
 * appears. Resolving stdout alone is how a failed job was reported as printed.
 */
export type RunPowerShell = (script: string) => Promise<PowerShellResult>;

export interface WindowsPrinterAdapterOptions {
  /** Injected so the adapter can be tested off Windows. */
  run?: RunPowerShell;
  documentName?: string;
}

export function createWindowsPrinterAdapter(
  options: WindowsPrinterAdapterOptions = {},
): PrinterAdapter {
  const run = options.run ?? runPowerShell;
  const documentName = options.documentName ?? 'Booksy Receipt Bridge';

  const list = async (): Promise<Printer[]> => {
    // ConvertTo-Json collapses a single result to an object rather than an
    // array, so the depth and the array wrapper are both deliberate.
    const output = await run(
      '$ErrorActionPreference = "Stop"; ' +
        '$d = (Get-CimInstance -ClassName Win32_Printer -Filter "Default = TRUE").Name; ' +
        '@(Get-Printer | Select-Object Name, PrinterStatus, @{n="IsDefault";e={$_.Name -eq $d}}) ' +
        '| ConvertTo-Json -Depth 3 -Compress',
    );
    return parsePrinterList(output.stdout);
  };

  /**
   * Hand the spooler a job, in the datatype it should be understood as.
   *
   * RAW means "these bytes are already for the device" - the driver is not
   * asked to render anything. TEXT means the opposite: the print processor
   * renders the characters through the driver, exactly as it does for the
   * Windows test page. That second route exists because some manufacturer
   * drivers - EPSON's Advanced Printer Driver among them - accept a RAW job,
   * report every byte written, and print nothing at all.
   */
  const send = async (
    bytes: Uint8Array,
    config: PrinterConfig,
    dataType: 'RAW' | 'TEXT',
  ): Promise<PrintResult> => {
    if (config.name === '') {
      return { ok: false, error: 'Aucune imprimante configurée.' };
    }

    // The bytes go through a temporary file rather than the command line: an
    // ESC/POS stream is binary and contains control characters that no amount
    // of shell quoting survives.
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'brb-print-'));
      const payload = join(directory, 'job.bin');
      await writeFile(payload, bytes);

      const script = [
        '$ErrorActionPreference = "Stop"',
        `Add-Type -TypeDefinition @'\n${RAW_PRINT_SOURCE}\n'@ -Language CSharp`,
        `$bytes = [System.IO.File]::ReadAllBytes(${quote(payload)})`,
        `$written = [RawPrinter]::SendBytes(${quote(config.name)}, ${quote(documentName)}, $bytes, ${quote(dataType)})`,
        'Write-Output "written=$written"',
      ].join('\n');

      const { stdout, stderr } = await run(script);
      const written = /written=(\d+)/.exec(stdout)?.[1];
      if (written === undefined) {
        // No confirmation means no job. Reporting the byte count we HOPED to
        // write, as this did, turns a failure into "ticket envoyé" and sends
        // the user looking at their printer instead of at the error.
        const reason = (stderr.trim() === '' ? stdout : stderr).trim();
        return {
          ok: false,
          error:
            reason === ''
              ? "Le spouleur n'a rien confirmé et n'a rien dit."
              : `Le spouleur n'a pas confirmé l'écriture : ${reason.slice(0, 600)}`,
        };
      }
      return { ok: true, bytesSent: Number(written) };
    } catch (error) {
      return { ok: false, error: describe(error) };
    } finally {
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };

  const printRaw = (bytes: Uint8Array, config: PrinterConfig): Promise<PrintResult> =>
    send(bytes, config, 'RAW');

  /**
   * Let the driver lay the ticket out, from its text.
   *
   * The fallback for a driver that swallows RAW. The geometry is the same 42
   * columns, but bold, double width and the cut are the driver's business now,
   * not ours: what comes out is a plain monospaced ticket with the right
   * amounts on the right paper, which beats nothing coming out at all.
   */
  const printText = (text: string, config: PrinterConfig): Promise<PrintResult> =>
    send(toWindowsAnsi(text), config, 'TEXT');

  const printTest = async (config: PrinterConfig): Promise<PrintResult> => {
    const { bytes, unmapped } = emitEscPos(buildTestTicketLayout(config), {
      ...(config.cutFeedDots === undefined ? {} : { cutFeedDots: config.cutFeedDots }),
    });
    const result = await printRaw(bytes, config);
    return { ...result, unmapped };
  };

  return { list, printRaw, printTest, printText };
}

/**
 * Parse `Get-Printer | ConvertTo-Json`.
 *
 * Tolerant on purpose: PowerShell emits a bare object for a single printer and
 * an array otherwise, and a machine with no printers emits nothing at all.
 */
export function parsePrinterList(output: string): Printer[] {
  const trimmed = output.trim();
  if (trimmed === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const record = row as Record<string, unknown>;
    const name = record['Name'];
    if (typeof name !== 'string' || name === '') return [];
    const status = record['PrinterStatus'];
    return [
      {
        name,
        ...(record['IsDefault'] === true ? { isDefault: true } : {}),
        ...(status === undefined || status === null ? {} : { status: String(status) }),
      },
    ];
  });
}

/** Single-quote for PowerShell: the only escape inside '...' is a doubled '. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Run the script from a FILE, not from standard input.
 *
 * It used to be piped to `-Command -`, and on a real till that produced
 * nothing at all: no output, no error, exit code 0, and no print job. The same
 * machine ran a one-line script through that channel happily, and `Add-Type`
 * in FullLanguage happily - so what it refused was a multi-line script arriving
 * that way. `-File` executes it as a script, which is what it is, and gives a
 * real exit code and real error output.
 *
 * WITH A BYTE ORDER MARK. Windows PowerShell 5.1 reads a .ps1 without one as
 * ANSI, so a printer name with an accent would arrive mangled - and a printer
 * name that does not match opens nothing.
 */
async function runPowerShell(script: string): Promise<PowerShellResult> {
  const directory = await mkdtemp(join(tmpdir(), 'brb-ps-'));
  const path = join(directory, 'job.ps1');
  await writeFile(path, `\ufeff${script}`, 'utf8');

  try {
    return await new Promise<PowerShellResult>((resolve, reject) => {
      execFile(
        POWERSHELL,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`${error.message}${stderr === '' ? '' : `: ${stderr.trim()}`}`));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

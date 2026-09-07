import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ConfigPatch } from '@brb/shared';

/**
 * Host configuration (plan section 38).
 *
 * The host owns the settings, not the extension: the extension keeps only what
 * is purely about its own UI. That way a reinstalled extension does not lose the
 * printer setup, and the CLI path works with no browser involved at all.
 */

export const BridgeConfigSchema = z.object({
  printer: z.object({
    /** Empty until configured. No model is hardcoded (plan section 65). */
    name: z.string().default(''),
    paperWidth: z.number().positive().default(80),
    printableWidth: z.number().positive().default(72),
    columns: z.number().int().positive().default(42),
  }),
  printing: z.object({
    autoPrint: z.boolean().default(false),
    showPreview: z.boolean().default(true),
    confidenceThreshold: z.number().min(0).max(1).default(0.9),
    allowedDirs: z.array(z.string()).default([]),
  }),
});

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export const DEFAULT_CONFIG: BridgeConfig = BridgeConfigSchema.parse({
  printer: {},
  printing: {},
});

export interface ConfigState {
  config: BridgeConfig;
  /** False when no config file exists yet - reported by GET_STATUS. */
  present: boolean;
  /** Set when a file existed but could not be used. */
  error?: string;
}

/**
 * Read the configuration.
 *
 * A missing file yields defaults and `present: false`; it does NOT create
 * anything, because reading state should not write state. A corrupt file also
 * yields defaults, plus an error to report - refusing to start because a JSON
 * file got truncated would strand the user with no way to fix it from the UI.
 */
export function loadConfig(path: string): ConfigState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { config: DEFAULT_CONFIG, present: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      config: DEFAULT_CONFIG,
      present: true,
      error: 'Le fichier de configuration est illisible (JSON invalide).',
    };
  }

  const result = BridgeConfigSchema.safeParse(withDefaults(parsed));
  if (!result.success) {
    return {
      config: DEFAULT_CONFIG,
      present: true,
      error: `Configuration invalide : ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '(racine)'} ${issue.message}`)
        .join(', ')}`,
    };
  }
  return { config: result.data, present: true };
}

/**
 * Merge a patch into the stored configuration and write it back.
 *
 * Written to a temporary file and renamed, so a crash or a full disk cannot
 * leave a half-written config behind - the file the host reads at startup is
 * either the old one or the new one.
 */
export function saveConfig(path: string, patch: ConfigPatch): BridgeConfig {
  const current = loadConfig(path).config;
  const merged = BridgeConfigSchema.parse({
    printer: { ...current.printer, ...patch.printer },
    printing: { ...current.printing, ...patch.printing },
  });

  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
  return merged;
}

/** Tolerate a file that omits a whole section. */
function withDefaults(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return { printer: {}, printing: {} };
  const record = value as Record<string, unknown>;
  return {
    printer: record['printer'] ?? {},
    printing: record['printing'] ?? {},
  };
}

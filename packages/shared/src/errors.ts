/** Error codes surfaced to the extension UI (plan section 40). */
export const BRIDGE_ERROR_CODES = [
  'NATIVE_HOST_NOT_FOUND',
  'NATIVE_HOST_FORBIDDEN',
  'NATIVE_HOST_CRASHED',
  'NATIVE_HOST_VERSION_MISMATCH',
  'INVALID_RECEIPT',
  'NOT_BOOKSY',
  'PRINTER_NOT_FOUND',
  'PRINTER_OFFLINE',
  'PARSING_FAILED',
  'PRINT_FAILED',
  'INVALID_MESSAGE',
  'FILE_NOT_ALLOWED',
  'NOT_IMPLEMENTED',
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export interface NativeError {
  code: BridgeErrorCode;
  message: string;
  /** Free-form diagnostic detail. Must never carry customer data. */
  detail?: string;
}

/** User-facing French copy. The extension renders these, not raw codes. */
export const BRIDGE_ERROR_MESSAGES: Record<BridgeErrorCode, string> = {
  NATIVE_HOST_NOT_FOUND:
    "Booksy Receipt Bridge n'est pas installé sur ce PC.",
  // Distinct from NOT_FOUND on purpose: the service IS installed, but its
  // manifest does not list this extension's id. Telling the user to install
  // something they already have would send them down the wrong path.
  NATIVE_HOST_FORBIDDEN:
    'Le service est installé mais n’autorise pas cette extension. Il doit être réenregistré avec son identifiant.',
  NATIVE_HOST_CRASHED:
    'Le service s’est arrêté avant de répondre.',
  NATIVE_HOST_VERSION_MISMATCH:
    'Le service installé est trop ancien pour cette version de l’extension.',
  INVALID_RECEIPT: 'Ce document ne contient pas les données attendues d’un reçu.',
  NOT_BOOKSY: 'Ce PDF n’est pas un reçu Booksy.',
  PRINTER_NOT_FOUND: 'L’imprimante configurée est introuvable.',
  PRINTER_OFFLINE: 'L’imprimante ne répond pas.',
  PARSING_FAILED: 'La lecture du reçu a échoué.',
  PRINT_FAILED: 'L’impression a échoué.',
  INVALID_MESSAGE: 'Message interne invalide.',
  FILE_NOT_ALLOWED: 'Ce fichier est hors des dossiers autorisés.',
  NOT_IMPLEMENTED:
    'Cette fonction n’est pas encore disponible dans la version installée du service.',
};

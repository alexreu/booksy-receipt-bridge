#!/bin/sh
# Installe Booksy Receipt Bridge pour l'utilisateur courant, sur macOS et Linux.
#
# Le pendant de Install.ps1, avec les mêmes règles : rien hors du profil de
# l'utilisateur, aucune élévation, une configuration existante conservée.
#
# Le manifeste Native Messaging est écrit dans le dossier de CHAQUE navigateur
# Chromium présent. Un navigateur absent est ignoré : sur un poste qui n'a que
# Chrome, écrire pour Brave créerait un dossier que personne ne lit.
#
# POSIX sh, pas bash : macOS livre bash 3.2 et certaines distributions n'ont que
# dash. Rien ici n'a besoin de plus.

set -eu

HOST_NAME='com.alexdevlab.booksy_receipt_bridge'
EXE_NAME='booksy-receipt-bridge'
SOURCE="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.local/share/BooksyReceiptBridge"
EXTENSION_ID='ndfcmfgnelpdjgpmaelpdgoccmjcpdjm'

usage() {
  cat <<'USAGE'
Usage : ./install.sh [--extension-id id1,id2]

  --extension-id  Identifiants autorisés à parler au service. Le Chrome Web
                  Store et Edge Add-ons en attribuent de différents ; séparez
                  par des virgules.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --extension-id) EXTENSION_ID="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin) PLATFORM='macos' ;;
  Linux)  PLATFORM='linux' ;;
  *) echo "Système non géré : $(uname -s). Sous Windows, utilisez Install.ps1." >&2; exit 1 ;;
esac

# --- 1. vérifier la livraison ----------------------------------------------
if [ ! -f "$SOURCE/$EXE_NAME" ]; then
  echo "$EXE_NAME introuvable dans $SOURCE. Lancez ce script depuis le dossier livré." >&2
  exit 1
fi
if [ ! -d "$SOURCE/pdfjs/standard_fonts" ]; then
  echo "Le dossier pdfjs/standard_fonts est absent : la lecture des PDF échouerait." >&2
  exit 1
fi

printf '\nBooksy Receipt Bridge — installation\n\n'

# --- 2. installer les fichiers ---------------------------------------------
mkdir -p "$INSTALL_DIR"
cp "$SOURCE/$EXE_NAME" "$INSTALL_DIR/$EXE_NAME"
chmod +x "$INSTALL_DIR/$EXE_NAME"
rm -rf "$INSTALL_DIR/pdfjs"
cp -R "$SOURCE/pdfjs" "$INSTALL_DIR/pdfjs"
EXE_PATH="$INSTALL_DIR/$EXE_NAME"
echo "  exécutable   $EXE_PATH"

# L'extension va à un emplacement stable plutôt que de rester dans le dossier
# décompressé : Chrome retient le CHEMIN d'une extension non empaquetée, et
# vider ses téléchargements casserait l'installation.
EXTENSION_PATH=''
if [ -f "$SOURCE/extension/manifest.json" ]; then
  rm -rf "$INSTALL_DIR/extension"
  cp -R "$SOURCE/extension" "$INSTALL_DIR/extension"
  EXTENSION_PATH="$INSTALL_DIR/extension"
  echo "  extension    $EXTENSION_PATH"
else
  echo "  extension    absente de la livraison, rien à copier"
fi

# --- 3. manifeste Native Messaging -----------------------------------------
# allowed_origins liste des origines EXACTES : les wildcards sont interdits.
#
# `read` rend faux sur une dernière ligne sans saut de ligne final, donc le
# `|| [ -n "$id" ]` : sans lui, un identifiant unique produisait une liste VIDE
# et Chrome refusait la connexion. Trouvé en lançant le script, pas en le
# relisant.
ORIGINS=$(printf '%s\n' "$EXTENSION_ID" | tr ',' '\n' | while IFS= read -r id || [ -n "$id" ]; do
  [ -n "$id" ] || continue
  printf '    "chrome-extension://%s/",\n' "$id"
done | sed '$ s/,$//')

if [ -z "$ORIGINS" ]; then
  echo "Aucun identifiant d'extension valide : le manifeste n'autoriserait personne." >&2
  exit 1
fi

MANIFEST="$INSTALL_DIR/$HOST_NAME.json"
cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Booksy Receipt Bridge",
  "path": "$EXE_PATH",
  "type": "stdio",
  "allowed_origins": [
$ORIGINS
  ]
}
EOF
echo "  manifeste    $MANIFEST"

# --- 4. un dossier par navigateur présent -----------------------------------
if [ "$PLATFORM" = 'macos' ]; then
  SUPPORT="$HOME/Library/Application Support"
  BROWSER_DIRS="$SUPPORT/Google/Chrome
$SUPPORT/Google/Chrome Beta
$SUPPORT/Google/Chrome Canary
$SUPPORT/Chromium
$SUPPORT/Microsoft Edge
$SUPPORT/BraveSoftware/Brave-Browser"
else
  CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
  BROWSER_DIRS="$CONFIG_HOME/google-chrome
$CONFIG_HOME/chromium
$CONFIG_HOME/microsoft-edge
$CONFIG_HOME/BraveSoftware/Brave-Browser"
fi

FOUND=0
OLD_IFS="$IFS"
IFS='
'
for dir in $BROWSER_DIRS; do
  [ -d "$dir" ] || continue
  mkdir -p "$dir/NativeMessagingHosts"
  cp "$MANIFEST" "$dir/NativeMessagingHosts/$HOST_NAME.json"
  echo "  enregistré   $(basename "$dir")"
  FOUND=$((FOUND + 1))
done
IFS="$OLD_IFS"

if [ "$FOUND" -eq 0 ]; then
  echo "  ATTENTION    aucun navigateur Chromium trouvé dans ce profil." >&2
fi

# --- 5. configuration, sans écraser l'existante -----------------------------
if [ "$PLATFORM" = 'macos' ]; then
  DATA_DIR="$HOME/Library/Application Support/BooksyReceiptBridge"
else
  DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/BooksyReceiptBridge"
fi
mkdir -p "$DATA_DIR"
CONFIG_PATH="$DATA_DIR/config.json"
if [ -f "$CONFIG_PATH" ]; then
  echo "  config       conservée ($CONFIG_PATH)"
else
  # Aucune imprimante par défaut : le modèle est choisi par l'utilisateur, et le
  # service refuse d'imprimer tant que le champ est vide.
  cat > "$CONFIG_PATH" <<'EOF'
{
  "printer": {
    "name": "",
    "kind": "thermal",
    "paperWidth": 80,
    "printableWidth": 72,
    "columns": 42
  },
  "printing": {
    "autoPrint": false,
    "showPreview": true,
    "confidenceThreshold": 0.9,
    "allowedDirs": []
  }
}
EOF
  echo "  config       $CONFIG_PATH"
fi

if [ -f "$SOURCE/uninstall.sh" ]; then
  cp "$SOURCE/uninstall.sh" "$INSTALL_DIR/uninstall.sh"
  chmod +x "$INSTALL_DIR/uninstall.sh"
fi

# --- 6. contrôle de bon fonctionnement --------------------------------------
printf '\n'
VERSION=$("$EXE_PATH" --version 2>/dev/null || true)
if [ -z "$VERSION" ]; then
  echo "Le service ne démarre pas : $EXE_PATH --version n'a rien répondu." >&2
  exit 1
fi
echo "  service      version $VERSION"

LOAD_FROM="${EXTENSION_PATH:-<dossier extension de la livraison>}"
cat <<EOF

Installation terminée.

  1. Dans Chrome, Chromium ou Edge, ouvrez la page des extensions :
       chrome://extensions   (Edge : edge://extensions)
     Activez le mode développeur, puis « Charger l'extension non empaquetée »
     et choisissez EXACTEMENT ce dossier :

       $LOAD_FROM

  2. Ouvrez le popup de l'extension : « Service connecté ».
  3. Choisissez l'imprimante dans Paramètres, ou en ligne de commande :

       "$EXE_PATH" config set printer.name "EPSON TM-T88V Receipt5"

  4. Ouvrez un reçu PDF dans un onglet et cliquez « Imprimer » : l'aperçu
     s'ouvre, vous validez.

Une mise à jour réécrit ce même dossier : rien à recharger à la main.

Désinstallation : "$INSTALL_DIR/uninstall.sh"
EOF

#!/bin/sh
# Désinstalle Booksy Receipt Bridge pour l'utilisateur courant, macOS et Linux.
#
# La configuration et les journaux sont CONSERVÉS sauf --purge : ce sont les
# données de l'utilisateur, et une réinstallation doit retrouver son imprimante.

set -eu

HOST_NAME='com.alexdevlab.booksy_receipt_bridge'
INSTALL_DIR="$HOME/.local/share/BooksyReceiptBridge"
PURGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    -h|--help) echo "Usage : ./uninstall.sh [--purge]"; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin)
    SUPPORT="$HOME/Library/Application Support"
    BROWSER_DIRS="$SUPPORT/Google/Chrome
$SUPPORT/Google/Chrome Beta
$SUPPORT/Google/Chrome Canary
$SUPPORT/Chromium
$SUPPORT/Microsoft Edge
$SUPPORT/BraveSoftware/Brave-Browser"
    DATA_DIR="$SUPPORT/BooksyReceiptBridge"
    ;;
  Linux)
    CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
    BROWSER_DIRS="$CONFIG_HOME/google-chrome
$CONFIG_HOME/chromium
$CONFIG_HOME/microsoft-edge
$CONFIG_HOME/BraveSoftware/Brave-Browser"
    DATA_DIR="$CONFIG_HOME/BooksyReceiptBridge"
    ;;
  *) echo "Système non géré. Sous Windows, utilisez Uninstall.ps1." >&2; exit 1 ;;
esac

printf '\nBooksy Receipt Bridge — désinstallation\n\n'

OLD_IFS="$IFS"
IFS='
'
for dir in $BROWSER_DIRS; do
  manifest="$dir/NativeMessagingHosts/$HOST_NAME.json"
  if [ -f "$manifest" ]; then
    rm -f "$manifest"
    echo "  retiré       $manifest"
  fi
done
IFS="$OLD_IFS"

if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "  fichiers     retirés de $INSTALL_DIR"
fi

if [ "$PURGE" -eq 1 ]; then
  if [ -d "$DATA_DIR" ]; then
    rm -rf "$DATA_DIR"
    echo "  données      retirées de $DATA_DIR"
  fi
elif [ -d "$DATA_DIR" ]; then
  echo "  données      conservées ($DATA_DIR, --purge pour les supprimer)"
fi

cat <<'EOF'

Terminé.

Le dossier de l'extension partait avec les fichiers : retirez-la aussi du
navigateur, sur chrome://extensions (Edge : edge://extensions), sinon elle y
reste affichée comme introuvable.
EOF

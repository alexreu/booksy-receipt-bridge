# Installation — Booksy Receipt Bridge

Ce dossier contient tout ce qui tourne sur le poste de caisse.

## Ce qu'il y a dedans

```
booksy-receipt-bridge.exe   le service, avec son propre runtime Node embarqué
pdfjs/                      polices et tables dont la lecture des PDF a besoin
extension/                  l'extension à charger dans Chrome ou Edge
Install.ps1                 installation pour l'utilisateur courant
Uninstall.ps1               désinstallation
```

## Installer

Le service s'installe lui-même, **sans droits administrateur et sans
PowerShell** — c'est la voie recommandée :

```powershell
.\booksy-receipt-bridge.exe install
```

```sh
./booksy-receipt-bridge install
```

Pourquoi : sur un poste d'entreprise, la stratégie d'exécution PowerShell
refuse souvent les scripts (« l'exécution de scripts est désactivée sur ce
système »), et un fichier téléchargé porte une marque « venu d'Internet » qui le
bloque même quand la stratégie l'autorise. Un exécutable n'est soumis ni à l'une
ni à l'autre.

Les scripts restent livrés pour qui les préfère : `.\Install.ps1` sous Windows,
`./install.sh` sous macOS et Linux. Si PowerShell refuse de les lancer :

```powershell
Unblock-File .\Install.ps1; powershell -ExecutionPolicy Bypass -File .\Install.ps1
```

L'exécutable va sous `%LOCALAPPDATA%\Programs\BooksyReceiptBridge`, et
l'enregistrement Native Messaging sous `HKCU`. Aucune élévation n'est demandée :
c'est délibéré, un poste de caisse contraint n'en donne pas forcément.

Chaque navigateur Chromium reçoit son entrée : sous Windows dans `HKCU`, sous
macOS et Linux dans le dossier `NativeMessagingHosts` du navigateur. Un
navigateur absent est ignoré — sous macOS et Linux, seuls ceux réellement
installés sont touchés.

L'extension est copiée elle aussi, sous
`%LOCALAPPDATA%\Programs\BooksyReceiptBridge\extension`. **Chargez-la depuis
là, pas depuis le dossier décompressé** : Chrome retient le chemin d'une
extension non empaquetée, et vider ses Téléchargements casserait
l'installation. Une mise à jour réécrit ce même dossier, donc il n'y a rien à
recharger à la main.

Puis :

1. `chrome://extensions` (Edge : `edge://extensions`) → mode développeur →
   « Charger l'extension non empaquetée » → le dossier ci-dessus.
2. Ouvrez le popup : « Service connecté ».
3. Paramètres → choisissez l'imprimante. Ou en ligne de commande :
   ```powershell
   & "$env:LOCALAPPDATA\Programs\BooksyReceiptBridge\booksy-receipt-bridge.exe" config set printer.name "EPSON TM-T88V Receipt5"
   ```
4. Ouvrez un reçu PDF dans un onglet, cliquez « Imprimer » : l'aperçu s'ouvre,
   vous choisissez l'imprimante et vous validez. Si les montants ne tombent pas
   en bout de ligne sur le papier, corrigez le nombre de colonnes dans les
   paramètres.

## Identifiant de l'extension

Le manifest du service liste des origines **exactes** — les wildcards sont
interdits. Si l'extension est chargée avec un autre identifiant que celui par
défaut, réinstallez en le passant :

```powershell
.\Install.ps1 -ExtensionId votreidentifiant
```

Le Chrome Web Store et Edge Add-ons attribuent des identifiants différents ;
`-ExtensionId a,b` en accepte plusieurs.

## Mises à jour

Le popup a un bouton « Vérifier ». Il ne part **jamais tout seul** : rien ne
contacte le réseau sans que vous le demandiez.

Le dépôt est public : **aucun jeton n'est nécessaire**. La requête part du
service, jamais du navigateur, et n'envoie rien d'autre qu'une demande de
version.

Si le dépôt redevenait privé, il faudrait poser un jeton GitHub en lecture
seule, une fois :

```powershell
& "$env:LOCALAPPDATA\Programs\BooksyReceiptBridge\booksy-receipt-bridge.exe" config set update.token ghp_votrejeton
```

Il resterait dans un fichier lisible par le seul compte Windows de l'utilisateur.

« Télécharger » dépose l'archive dans
`%APPDATA%\BooksyReceiptBridge\updates`. Décompressez-la et relancez
`Install.ps1` : l'installation écrase le service et conserve votre
configuration.

## En cas de problème

Les journaux sont dans `%APPDATA%\BooksyReceiptBridge\logs`. Ils ne contiennent
aucune donnée client : numéro de ticket, montants et messages d'erreur
seulement.

Diagnostic en ligne de commande :

```powershell
$exe = "$env:LOCALAPPDATA\Programs\BooksyReceiptBridge\booksy-receipt-bridge.exe"
& $exe status                      # service, config, imprimante
& $exe paths                       # où vivent config et journaux
& $exe ticket C:\chemin\recu.pdf   # lit un PDF et affiche le ticket
```

Un avertissement `Cannot load "@napi-rs/canvas"` au démarrage est normal : c'est
une dépendance optionnelle de pdf.js utilisée pour le **rendu** d'images, et ce
service ne fait que lire du texte.

## Ce qui n'est pas encore validé

L'impression a été construite et testée jusqu'à l'appel `WritePrinter`, mais
**pas sur une imprimante réelle**. Les critères AC14 (impression sans Ctrl+P) et
AC15 (aucune fenêtre Windows) attendent ce test. Voir `spikes/escpos-raw/`.

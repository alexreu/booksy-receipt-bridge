# Booksy Receipt Bridge

Imprime un reçu Booksy sur une imprimante de caisse, sans passer par la boîte de
dialogue d'impression du navigateur.

Le reçu s'ouvre en PDF dans un onglet. Un clic sur « Imprimer » dans l'extension
ouvre un **aperçu** : le ticket tel qu'il sortira, décodé depuis les octets qui
seront réellement envoyés. On y choisit l'imprimante, on valide, le ticket sort.

**Rien ne quitte le poste.** Pas de serveur, pas de télémétrie. Le seul accès
réseau est la vérification de mise à jour, et elle ne part que sur un clic.

## Pourquoi ESC/POS et pas le pilote du navigateur

Imprimer le PDF par le pilote donne un ticket illisible ou coupé : le pilote
applique une mise à l'échelle que personne ne contrôle.

Une imprimante thermique comprend l'ESC/POS. Envoyée en travail **RAW**, la
grille est fixe — 42 colonnes en Font A sur 80 mm — donc rien ne peut être
redimensionné ni rogné, et le rendu se vérifie en tests purs, sans imprimante
branchée.

Pour une imprimante **ordinaire** (laser, jet d'encre), l'ESC/POS n'a aucun
sens : elle recevrait des codes de contrôle imprimés comme du texte. Le même
ticket lui est donc envoyé rendu en PDF, à sa largeur réelle, dans le coin d'une
feuille A4. Le type d'imprimante se règle dans les paramètres.

## Comment c'est fait

```
Onglet Chrome / Edge affichant le reçu PDF
   ↓  extension MV3 — interface seulement, ne décide rien
Native Messaging
   ↓  service (Native Host) — la source de vérité
PDF → parser → Receipt → TicketLayout ─┬→ ESC/POS → spouleur RAW → thermique
                                       ├→ PDF A4  → spouleur     → ordinaire
                                       └→ SVG     → aperçu à l'écran
```

Trois principes tiennent l'ensemble :

1. **Le service est autonome.** Il imprime un reçu en ligne de commande, sans
   navigateur. L'extension n'est qu'une couche d'interface.
2. **Une seule géométrie.** Aperçu, impression thermique et rendu A4 sortent du
   même `TicketLayout` : ce qui est approuvé à l'écran ne peut pas diverger de
   ce qui sort du rouleau.
3. **Aucun recalcul fiscal.** Le Bridge lit, reformate, imprime. Une incohérence
   produit un avertissement, jamais une correction silencieuse.

L'extension n'a **aucun content script et aucune permission de site** : elle ne
s'exécute dans la page d'aucun domaine. Elle lit l'onglet actif au clic, grâce à
`activeTab`, et le service worker résout cet onglet lui-même — une page n'a donc
aucun moyen de désigner ce qui sera imprimé.

## Architecture des dossiers

```
apps/
  extension/          extension MV3 : service worker, popup, paramètres, aperçu
  native-host/        le service : protocole, configuration, impression, CLI
packages/
  shared/             modèle Receipt, protocole Native Messaging, schémas Zod
  pdf-inspector/      pdf.js → runs de texte avec coordonnées, puis lignes
  booksy-parser/      lignes → Receipt, avec avertissements
  ticket-layout/      Receipt → TicketLayout : la grille en colonnes
  receipt-renderer/   émetteurs ESC/POS, PDF A4, HTML, texte, et décodeur SVG
  printer/            PrinterAdapter : Windows (RAW), CUPS, mock, fichier
installer/            Install.ps1 et install.sh (Windows / macOS-Linux), README
fixtures/booksy/      PDF de test — seuls les *.anon.pdf sont committés
scripts/              build du binaire, clé d'extension, sondes de développement
spikes/escpos-raw/    protocole de mesure sur imprimante réelle
```

## Installer sur un poste

Chaque release porte une archive par système. Prendre la sienne dans la
[dernière release](https://github.com/alexreu/booksy-receipt-bridge/releases/latest),
la décompresser, puis, **sans droits administrateur** :

| Système | Archive | Commande |
|---|---|---|
| Windows | `…-windows.zip` | `.\booksy-receipt-bridge.exe install` |
| macOS | `…-macos.zip` | `./booksy-receipt-bridge install` |
| Linux | `…-linux.zip` | `./booksy-receipt-bridge install` |

**Le service s'installe lui-même.** Pas de PowerShell : sur un poste
d'entreprise, la stratégie d'exécution refuse souvent les scripts, et un fichier
téléchargé porte en plus une marque qui le bloque. Un exécutable n'est soumis ni
à l'une ni à l'autre. `Install.ps1` et `install.sh` restent livrés pour qui les
préfère.

Le service s'installe dans le profil de l'utilisateur — `%LOCALAPPDATA%` sous
Windows, `~/.local/share/BooksyReceiptBridge` ailleurs — et l'extension est
copiée à côté de lui. L'enregistrement Native Messaging va dans `HKCU` sous
Windows, et dans le dossier `NativeMessagingHosts` de **chaque navigateur
Chromium présent** sous macOS et Linux : Chrome, Chromium, Edge, Brave. Un
navigateur absent est ignoré. L'installeur affiche le chemin exact à charger.

Ensuite, une fois :

1. `chrome://extensions` (Edge : `edge://extensions`) → mode développeur →
   « Charger l'extension non empaquetée » → le dossier annoncé par l'installeur.
   **Pas** le dossier décompressé : Chrome retient ce chemin, et vider ses
   téléchargements casserait l'installation.
2. Popup de l'extension → « Service connecté ».
3. Paramètres → choisir l'imprimante et son type.

Pour retirer : `booksy-receipt-bridge uninstall`. La configuration et les
journaux sont conservés.

Détail et dépannage : [installer/README.md](installer/README.md).

**Mises à jour.** Un tag `v*` construit une archive par système — chacune sur son
propre runner, qui vérifie que le binaire lit vraiment un PDF avant de l'attacher
à la release. Le bouton « Vérifier » du popup interroge cette release et prend
l'archive de la machine où il tourne ; il ne part jamais de lui-même.

## Développement

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build:extension          # apps/extension/dist
pnpm build:host               # exécutable autonome pour cette machine
pnpm build:host --win         # la variante Windows, depuis n'importe quel poste
```

Piloter le service sans navigateur — il est la source de vérité :

```bash
pnpm host status
pnpm host config set printer.name "EPSON TM-T88V Receipt5"
pnpm host ticket ./fixtures/booksy/recu-1167.anon.pdf     # le ticket en texte
pnpm host escpos ./fixtures/booksy/recu-1167.anon.pdf     # les octets
pnpm inspect ./fixtures/booksy/recu-1167.anon.pdf         # coordonnées du PDF
```

Enregistrer le service pour le développement, sans quoi le popup n'a rien à
interroger — `--uninstall` fait le ménage :

```bash
pnpm host:install
```

Le pilote d'impression est choisi selon la plateforme : Windows en RAW, CUPS sur
macOS et Linux. `BRB_PRINTER=mock` force un pilote simulé, et l'interface annonce
alors que ces files ne sont pas de vraies imprimantes.

## Données sensibles

Un vrai reçu porte le nom d'un client.

- `fixtures/booksy/*.pdf` est gitignoré ; seuls les `*.anon.pdf` sont committés.
- `debug/` est gitignoré : il contient des sorties verbatim.
- Les journaux du service ne portent que numéro de ticket, montants et erreurs.

## Clé d'extension

`apps/extension/manifest.json` contient un champ `key` qui fige l'identifiant de
l'extension. Sans lui, l'identifiant change à chaque rechargement et le manifest
du service — qui liste des origines exactes, les wildcards étant interdits —
casse en permanence.

La clé privée `apps/extension/key.pem` est gitignorée ; elle ne sert qu'à signer
un `.crx`. `pnpm gen:extension-key` en régénère une. Publier sur le Chrome Web
Store et sur Edge Add-ons donnerait deux identifiants différents : le manifest du
service en accepte plusieurs (`Install.ps1 -ExtensionId a,b`).

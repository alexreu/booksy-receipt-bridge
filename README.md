# Booksy Receipt Bridge

Transforme les reçus Booksy en tickets thermiques 80 mm et les imprime
directement sur une imprimante de caisse (EPSON TM-T88V et compatibles ESC/POS).

Le plan complet et les décisions d'architecture vivent dans
[`.claude/plans/booksy-receipt-bridge.plan.md`](.claude/plans/booksy-receipt-bridge.plan.md).

## État

| Phase | Contenu | État |
|---|---|---|
| 0 | Monorepo, TypeScript, ESLint, Vitest, CI Windows, clé d'extension | fait |
| 1 | PDF Inspector (`pnpm inspect`) | fait |
| 1.5a | Layout ticket, émetteur ESC/POS, décodeur, adaptateurs d'impression | fait |
| 2 | Parser Booksy | fait |
| 3 | Renderer HTML 80 mm (aperçu) | fait |
| 4 | Native Host : protocole, `PING`, `GET_STATUS`, CLI autonome | fait |
| 5 | Extension MV3 reliée au host, popup de statut | fait |
| 1.5b | Spike matériel : spooler RAW + TM-T88V | **en attente d'un poste Windows** |
| 6 → 10 | Imprimante Windows, téléchargements, DOM Booksy, installeur, auto-print | à venir |

## Architecture

```
Booksy dans Chrome / Edge
    ↓  extension MV3 (couche UX uniquement)
Native Messaging
    ↓  Native Host Windows (source de vérité)
PDF → parser → Receipt → TicketLayout → ESC/POS → spooler RAW → TM-T88V
```

Deux principes structurants :

1. **Le Native Host est autonome.** Il doit pouvoir imprimer un PDF Booksy en
   CLI, sans extension. L'extension n'est qu'une couche UX.
2. **Deux chemins d'entrée indépendants.** Un bouton injecté dans Booksy *et* la
   détection des téléchargements. Si Booksy change son DOM, le second continue de
   fonctionner.

### Pourquoi ESC/POS et pas le driver Windows

`HTML → driver Windows 80 mm` est le pipeline qui échoue aujourd'hui : à 38 % le
texte est illisible, à 100 % le ticket est coupé. Le driver applique une mise à
l'échelle qu'on ne contrôle pas.

La TM-T88V est une imprimante ESC/POS. En job RAW sur le spooler, la grille est
fixe (42 colonnes en Font A sur 80 mm), donc rien ne peut être rescalé ni coupé —
et le rendu est vérifiable en tests purs, sans imprimante.

Le HTML reste produit, mais pour l'**aperçu** à l'écran, pas pour l'impression.

### La couche `TicketLayout`

```
Receipt ─→ TicketLayout ─┬→ EscPosEmitter  → octets → imprimante
        (lignes/colonnes) ├→ TextEmitter    → snapshots, logs
                          └→ HtmlEmitter    → aperçu (phase 3)
```

Tous les émetteurs consomment la même géométrie, donc ce qu'un snapshot montre et
ce que l'imprimante reçoit ne peuvent pas diverger. C'est ce qui rend AC12 et
AC13 vérifiables sur macOS.

### Invariant fiscal

Le Bridge **ne recalcule jamais** une TVA, un total, un prix ou une remise
(section 31 du plan). Il lit, reformate, imprime. Une incohérence produit un
`ParseWarning`, jamais une correction silencieuse.

Deux conséquences concrètes déjà appliquées :

- `formatDateTime` reformate les composants littéraux d'un horodatage et ne
  convertit **pas** de fuseau — un reçu émis à 15:09 s'imprime 15:09.
- **Limitation connue** : les montants sont stockés en `number`, donc la forme
  textuelle exacte du PDF n'est pas conservée. À trancher en phase 2 si la
  fidélité au caractère près devient nécessaire.

## Structure

```
apps/
  extension/        MV3 : service worker, popup (stubs phase 0)
  native-host/      stub phase 0 — protocole en phase 4
packages/
  shared/           modèle Receipt, protocole Native Messaging, codes d'erreur
  pdf-inspector/    pdfjs → PdfTextItem[] + regroupement en lignes
  booksy-parser/    (phase 2)
  ticket-layout/    Receipt → TicketLayout, géométrie et formatage
  receipt-renderer/ émetteurs ESC/POS, texte, HTML (phase 3)
  printer/          PrinterAdapter : mock, fichier, Windows (phase 6)
fixtures/booksy/    PDF — gitignorés sauf *.anon.pdf
debug/              sorties de l'inspecteur et des émetteurs — gitignoré
spikes/escpos-raw/  protocole de mesure matériel (phase 1.5b)
```

## Commandes

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

Inspecter un PDF :

```bash
pnpm inspect ./fixtures/booksy/ticket-996.pdf
```

Produit `debug/ticket-996.json` : chaque run de texte avec ses coordonnées, plus
les lignes reconstruites. Si le PDF n'a pas de couche texte, l'inspecteur le dit
plutôt que de rendre un JSON vide.

Produire les fichiers du spike matériel :

```bash
pnpm spike:sample
```

Piloter le host sans navigateur (il est la source de vérité, l'extension n'est
qu'une couche UX) :

```bash
pnpm host paths
pnpm host config set printer.name "EPSON TM-T88V Receipt5"
pnpm host status
pnpm host ticket ./fixtures/booksy/ticket-996.pdf
pnpm host html ./fixtures/booksy/ticket-996.pdf --out debug/apercu.html
```

Tester le protocole Native Messaging sans Chrome — le probe spawn le host et
parle le vrai format préfixé en longueur :

```bash
pnpm host:probe
pnpm host:probe --bad
pnpm host:probe --batch
```

Construire l'extension :

```bash
pnpm build:extension
```

Enregistrer le host pour le développement, sans quoi le popup n'a rien à
interroger :

```bash
pnpm host:install
```

Le manifest est écrit dans chaque répertoire `NativeMessagingHosts` détecté, avec
`allowed_origins` limité à l'identifiant exact de l'extension — les wildcards
sont interdits. `pnpm host:install --uninstall` fait le ménage.

Puis dans Chrome : `chrome://extensions` → mode développeur → « Charger
l'extension non empaquetée » → `apps/extension/dist`. Le popup doit afficher
« Service connecté ».

## Données sensibles

Les vrais reçus contiennent des noms de clients.

- `debug/` est intégralement gitignoré.
- `fixtures/booksy/*.pdf` est gitignoré ; seuls les fichiers `*.anon.pdf`
  anonymisés peuvent être committés.
- Aucune donnée ne sort du poste : pas de serveur distant, pas de télémétrie
  (AC19).

## Clé d'extension

`apps/extension/manifest.json` porte un champ `key` qui fige l'ID de
l'extension. Sans lui, l'ID change à chaque rechargement en mode non empaqueté et
le manifest du Native Host — qui liste des origines exactes, les wildcards étant
interdits — casse en permanence.

ID actuel : voir `apps/extension/.extension-id`.

La clé privée (`apps/extension/key.pem`) est gitignorée. Elle n'est nécessaire
que pour signer un `.crx` soi-même ; à conserver dans un gestionnaire de mots de
passe. Pour en régénérer une :

```bash
pnpm gen:extension-key
```

Au moment de la publication, les IDs attribués par le Chrome Web Store et par
Edge Add-ons peuvent différer : le manifest du host devra lister les deux
origines.

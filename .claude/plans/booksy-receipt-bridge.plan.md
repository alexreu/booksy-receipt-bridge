# Plan d'implémentation — Booksy Receipt Bridge

**Source** : plan fourni en conversation (68 sections)
**Cible** : Extension Chromium MV3 + Native Messaging Host Windows → ticket 80 mm sur EPSON TM-T88V
**Complexité globale** : Large (~55–85 h dev)
**État repo** : vide, pas de git, macOS (dev) / Windows (cible)

**Décisions actées (2026-09-07)**

1. **ESC/POS en chemin d'impression primaire**, HTML en aperçu seulement. Le driver
   Windows est écarté.
2. **Aucune machine Windows ni TM-T88V disponible actuellement.** Tout le code Windows
   reste derrière `PrinterAdapter` ; vérification hors ligne via `FilePrinterAdapter` +
   décodeur ESC/POS.
3. **Premier lot = Phases 0 + 1 + 1.5a** (spike hors ligne). Le 1.5b (matériel réel) est
   documenté et prêt à lancer, exécuté dès que le Windows + l'imprimante sont là.

---

## 1. Reformulation des exigences

Deux chemins d'entrée, un seul moteur :

```
A. Bouton injecté dans Booksy  ─┐
                                ├→ Service Worker ─→ Native Host ─→ TM-T88V
B. Détection chrome.downloads  ─┘
```

Le Native Host est la source de vérité : parsing PDF, validation, layout, impression,
config, logs. L'extension n'est qu'une couche UX. Le host doit fonctionner en CLI sans
extension (§58).

Invariant fiscal (§31) : **aucun recalcul** de TVA / total / prix / remise. Lecture,
reformatage, impression. Le parser peut *signaler* une incohérence (warning), jamais la
corriger.

---

## 2. Trois conflits techniques à trancher avant de coder

### 2.1 AC15 + AC20 + §37 sont mutuellement contradictoires

- **AC14/AC15** : impression sans Ctrl+P, sans fenêtre Windows.
- **AC20** : le client n'installe pas Node.js.
- **§37** : « Windows driver, pas ESC/POS dans la première implémentation ».
- **AC12/AC13** : ticket lisible, rien de coupé.

Or `HTML → moteur de rendu → driver Windows 80 mm` est **exactement le pipeline qui
échoue aujourd'hui** (le problème 38 % / 100 % du §1). Le driver applique une mise à
l'échelle qu'on ne contrôle pas de façon fiable, et il faut embarquer un moteur de rendu
(Chromium headless ou lib PDF) pour produire le document — ce qui alourdit fortement le
packaging exigé par AC20.

**DÉCISION ACTÉE : ESC/POS en chemin primaire, HTML en aperçu seulement.**

| Critère | ESC/POS raw (spooler RAW) | HTML → PDF → driver |
|---|---|---|
| AC13 (rien coupé) | déterministe : 42 colonnes Font A, aucune mise à l'échelle | dépend du driver + du scaling |
| AC15 (pas de dialogue) | natif (job RAW direct spooler) | nécessite un outil d'impression silencieuse |
| AC20 (pas de Node) | binaire seul, aucun moteur de rendu | + Chromium headless ou lib PDF embarqué |
| Testabilité macOS | snapshots de chaînes/octets purs | nécessite un rendu réel |
| Coupe papier / logo | commandes dédiées (`GS V`) | non |

La TM-T88V **est** une imprimante ESC/POS. Passer par le driver Windows, c'est traduire
en langage graphique ce que l'imprimante comprend nativement en texte. Et l'aperçu
HTML reste utile (§18 `showPreview`) — il n'a juste pas à être le format d'impression.

**Conséquence architecture** : introduire une représentation intermédiaire entre
`Receipt` et la sortie.

```
Receipt ─→ TicketLayout ─┬→ EscPosEmitter  → octets → spooler RAW → TM-T88V
        (lignes/colonnes) ├→ HtmlEmitter    → aperçu à l'écran
                          └→ TextEmitter    → snapshots de tests
```

`TicketLayout` = liste de lignes typées (`text` / `two-col` / `separator` / `qr` /
`feed` / `cut`) avec une largeur en caractères configurable. AC13 devient alors un test
pur : *« aucune ligne ne dépasse N colonnes et tous les champs du Receipt apparaissent
dans le layout »* — vérifiable sur macOS, sans imprimante.

**Option écartée** : `HTML → msedge --headless --print-to-pdf → impression PDF
silencieuse`. Ajoutait une dépendance à Edge et un outil d'impression PDF tiers, et
laissait AC13 à la merci du scaling driver. Le §37 (« pas d'ESC/POS dans la première
implémentation ») est donc explicitement révisé.

**Conséquence sur les AC** : AC12 et AC13 se testent désormais sur le `TicketLayout`
(assertions pures), pas sur un rendu papier. AC14 et AC15 restent à valider sur matériel
réel (Phase 1.5b / Phase 6).

### 2.2 Packaging sans Node.js — et build Windows depuis macOS

AC20 impose un exécutable autonome. Chaîne retenue :

```
src TS ─→ esbuild (bundle CJS unique) ─→ Node SEA (--experimental-sea-config + postject)
       ─→ booksy-receipt-bridge.exe
```

Points durs, à connaître avant de s'engager :

- **SEA exige un point d'entrée CommonJS** (Node 22/24). Source en ESM, bundle de sortie
  en CJS. `pdfjs-dist` doit être bundlé depuis son build `legacy`, worker désactivé.
- **Un module natif `.node` ne peut pas être embarqué dans le SEA.** Si on utilise
  `koffi` pour l'API spooler, le `.node` est livré à côté de l'exe par l'installeur.
- **La cross-compilation est techniquement possible** depuis macOS (télécharger
  `node.exe` win-x64, injecter le blob avec `postject`), **mais la signature de code
  demande Windows + un certificat**. Un exe non signé déclenche SmartScreen chez le
  client.
  → **Recommandation** : build en CI sur `windows-latest` dès la Phase 0 (workflow
  GitHub Actions), même avant d'avoir du code à builder. Corollaire : ce projet a besoin
  d'un repo git distant tôt.

### 2.3 Ce que le plan ne mentionne pas et qui va mordre

| Sujet | Réalité | Action |
|---|---|---|
| **Taille des messages** | Native Messaging plafonne **host → extension à 1 Mo**. Extension → host est large (4 Go). | L'aperçu renvoyé au popup doit être du HTML/texte, jamais un PNG rendu. Vérifier la taille avant d'émettre. |
| **ID d'extension instable** | En « load unpacked », l'ID change → `allowed_origins` casse à chaque rechargement. | Générer une paire de clés, poser la clé publique base64 dans `manifest.json` → `"key"`. ID déterministe en dev = ID de prod. À faire en **Phase 0**, sinon toute la Phase 5 est un enfer. |
| **Durée de vie du Service Worker MV3** | Le SW meurt après ~30 s d'inactivité. | Utiliser `sendNativeMessage` (one-shot) partout ; ne pas bâtir d'état en mémoire dans le SW. Toute la config vit côté host (§18). Coût : ~100–300 ms de démarrage de process par message — acceptable. |
| **Chemin V2 (bouton Booksy)** | Le bouton n'a pas de fichier local : il faut `fetch` le PDF avec les cookies de session, donc des **octets** dans l'extension, pas un chemin. | Deux messages distincts : `PRINT_RECEIPT_FROM_PATH` (chemin, §22) et `PRINT_RECEIPT_FROM_BYTES` (base64). Ne pas prétendre que le chemin local couvre les deux cas. |
| **Jeu de caractères ESC/POS** | AC exige « caractères français + symbole € ». Le € n'existe pas dans la codepage par défaut de la TM-T88V. | `ESC t 19` (PC858) ou `ESC t 16` (WPC1252) + transcodage explicite. À tester dès le spike. |
| **PII dans les fixtures** | Les vrais reçus contiennent des noms clients. | `debug/` intégralement gitignoré ; `fixtures/booksy/*.pdf` gitignoré par défaut, seules les versions anonymisées committées. À poser en Phase 0, **avant** le premier PDF réel. |
| **Duplicata fiscal** | Réimprimer un reçu NF525 dans une autre mise en page produit un second document. | Conserver intégralement la signature/certification d'origine (AC11) et marquer les réimpressions `DUPLICATA`. À valider avec ton comptable — non bloquant pour le code. |
| **E2E Playwright + Native Messaging** | Impossible de mocker un host natif dans un vrai Chrome. | `NativeHostClient` résolu au runtime ; en build E2E, `MockNativeHostClient` activé via un flag dans `chrome.storage.local`. Prévu dès la Phase 5, pas rajouté après. |

---

## 3. Réordonnancement proposé : un spike d'impression en Phase 1.5

Le plan place l'impression réelle en Phase 6 et l'installeur en Phase 9. **Les priorités
du §57 restent intactes** — mais l'ordre des priorités n'est pas l'ordre des risques.
L'exactitude fiscale est la priorité n°1 *et* le risque le plus faible (c'est du parsing
déterministe, testable). « Imprimer silencieusement sur une TM-T88V depuis un exe non-Node »
est la priorité n°3 *et* la seule inconnue capable d'invalider l'architecture entière.

→ Insérer un spike juste après la Phase 1. Comme aucune machine Windows n'est disponible
(décision 2), il se scinde en deux :

**1.5a — hors ligne, sur macOS, maintenant.** Contrairement au spike Windows, ce lot
n'est *pas* jetable : c'est le socle de `receipt-renderer`.

- `EscPosEmitter` : `TicketLayout` → octets (`ESC @`, `ESC t 19`, `ESC a`, `GS !`, `GS V`).
- Transcodage PC858 explicite, table de correspondance testée sur `é è à ç ù ° €`.
- `FilePrinterAdapter` : écrit le flux dans `debug/*.escpos.bin`.
- **Décodeur ESC/POS** (`escpos-decode`) : rejoue les octets et rend le ticket en texte
  monospace 42 colonnes + PNG. C'est lui qui remplace l'œil sur le papier.
- Snapshots : ticket nominal, prestation à nom long, multi-TVA, certification longue.

Ce que 1.5a prouve : la mise en page tient en 42 colonnes, rien n'est tronqué, les
accents et le € sont encodables. → AC12, AC13.

Ce que 1.5a **ne** prouve **pas** : que le spooler RAW accepte le job sans dialogue ni
droits admin, que la TM-T88V interprète bien la codepage choisie, que `GS V` coupe.
→ AC14, AC15 restent ouverts.

**1.5b — sur matériel, différé.** `spikes/escpos-raw/` : script Windows autonome +
procédure écrite, livrés en 1.5a, exécutés dès que le PC + l'imprimante sont
disponibles. À vérifier alors : (a) aucun dialogue, (b) 42 colonnes en Font A, (c)
`ESC t 19` rend correctement `é è à ç €`, (d) `GS V` coupe, (e) accès spooler sans
droits admin.

**Risque résiduel assumé** : si 1.5b révèle que la codepage ou le spooler RAW ne se
comportent pas comme prévu, seul l'`EscPosEmitter` est à retoucher — `TicketLayout`,
parser et protocole ne bougent pas. C'est précisément ce que la couche intermédiaire du
§2.1 achète.

Ordre final :

| Phase | Contenu | Gate de sortie |
|---|---|---|
| 0 | Monorepo, git, CI Windows, clé d'extension, gitignore PII | lint + typecheck + test verts |
| 1 | PDF Inspector (`pnpm inspect`) | JSON de coordonnées lisible produit |
| **1.5a** | **ESC/POS emitter + décodeur + FilePrinterAdapter (macOS)** | **snapshots 42 colonnes, € et accents encodés** |
| 2 | Parser Booksy (`parseBooksyReceipt`) | **fait** — AC7–AC11 sur PDF réel, confidence 1.0 |
| 3 | Renderer HTML 80 mm (aperçu) | **fait** — AC12, AC13 en tests purs |
| 1.5b | Spike matériel : spooler RAW + TM-T88V | AC14, AC15 — dès que le PC est dispo |
| 4 | Native Host : protocole, Zod, `PING`, `GET_STATUS`, CLI | **fait** — host pilotable sans Chrome |
| 5 | Extension MV3 : SW, popup, `NativeHostClient` | **fait** — AC3, AC4 |
| 6 | `WindowsPrinterAdapter` : `LIST_PRINTERS`, `PRINT_TEST`, `PRINT_RECEIPT` | AC5, AC6, AC14, AC15 |
| 7 | `chrome.downloads` + déduplication | AC16, AC17 |
| 8 | `BooksyDomAdapter` + injection bouton | AC18 (fallback intact) |
| 9 | Installeur Windows (`Setup.exe`) | AC1, AC2, AC20 |
| 10 | Auto-print sous seuil de confiance | — |

**Dépendance bloquante** : la Phase 2 ne peut pas démarrer sans un vrai PDF Booksy dans
`fixtures/booksy/`. Les phases 0, 1, 1.5 n'en ont pas besoin.

---

## 4. Structure cible

Conforme au §7, avec les ajouts justifiés ci-dessus (`ticket-layout` extrait du renderer,
`installer/`, CI) :

```
booksy-receipt-bridge/
├── apps/
│   ├── extension/                 # MV3 : background, popup, options, content, messaging
│   └── native-host/               # main.ts, messaging/, config/, logging/, cli/
├── packages/
│   ├── shared/                    # types Receipt, NativeMessage, schémas Zod, codes d'erreur
│   ├── pdf-inspector/             # extraction bas niveau pdfjs → PdfTextItem[]
│   ├── booksy-parser/             # parseBooksyReceipt() + confidence + warnings
│   ├── ticket-layout/             # Receipt → TicketLayout (largeur configurable)
│   ├── receipt-renderer/          # emitters : escpos / html / text
│   └── printer/                   # PrinterAdapter : windows / mock / file
├── fixtures/
│   ├── booksy/                    # PDF (gitignore sauf anonymisés)
│   └── booksy-dom/                # captures HTML anonymisées (§49)
├── debug/                         # gitignore total
├── installer/
├── .github/workflows/             # build Windows + SEA + lint/test
└── pnpm-workspace.yaml
```

Choix de build : **Vite nu, sans `@crxjs/vite-plugin`.** Le §6 le donnait comme
conditionnel (« si cela simplifie réellement »). Pour 4 points d'entrée (SW, popup,
options, content), un multi-entry Vite + un `manifest.ts` généré suffit, et évite la
dérive d'un plugin en beta. À reconsidérer si le HMR devient douloureux en Phase 8.

Packages privés consommés en TS source (`"main": "./src/index.ts"`), typecheck global par
`tsc -b`. Pas d'étape de build inter-packages → pas de problème d'ordre de compilation.

---

## 5. Premier lot à implémenter (Phases 0 + 1 + 1.5a)

Correspond à la « première mission » du §60, plus le socle ESC/POS hors ligne.
Estimation : ~12–16 h (1.5a est plus large que le spike jetable initialement prévu, mais
son code est conservé).

### Fichiers créés — Phase 0

| Fichier | Rôle |
|---|---|
| `package.json`, `pnpm-workspace.yaml` | workspace, scripts `lint` / `typecheck` / `test` / `inspect` |
| `tsconfig.base.json` + un `tsconfig.json` par package | strict, `noUncheckedIndexedAccess` |
| `eslint.config.js` | ESLint 9 flat + typescript-eslint |
| `vitest.config.ts` | workspace de tests |
| `.gitignore` | `debug/`, `fixtures/booksy/*.pdf`, `node_modules`, `dist` |
| `packages/shared/src/receipt.ts` | `Receipt`, `ReceiptItem`, `VatLine` (§30) |
| `packages/shared/src/native-protocol.ts` | `NativeMessage`, `NativeResponse`, `NativeMessageType`, schémas Zod (§13/14/44) |
| `packages/shared/src/errors.ts` | les 8 codes d'erreur du §40 |
| `apps/extension/manifest.json` | MV3 minimal + `"key"` (ID déterministe), permissions du §41 uniquement |
| `.github/workflows/ci.yml` | lint/typecheck/test + job build Windows |
| `scripts/gen-extension-key.mjs` | génère la paire de clés, sort la clé publique base64 |

Aucun content script, aucun `chrome.downloads`, aucun Native Messaging fonctionnel,
aucune impression — conforme au §60.

### Fichiers créés — Phase 1 (PDF Inspector)

| Fichier | Rôle |
|---|---|
| `packages/pdf-inspector/src/types.ts` | `PdfTextItem` (§32) |
| `packages/pdf-inspector/src/extract.ts` | `extractTextItems(buffer): Promise<PdfTextItem[]>` — pdfjs legacy, worker off, `isEvalSupported: false` |
| `packages/pdf-inspector/src/cli.ts` | `pnpm inspect <pdf>` → `debug/<nom>.json` |
| `packages/pdf-inspector/src/*.test.ts` | tests sur un PDF synthétique généré au build (pas de fixture PII requise) |

Détail important : les coordonnées pdfjs ont l'origine **en bas à gauche**. Pour un
parsing « par lignes » (§61) il faut y = haut décroissant. L'extracteur normalise en
`{ x, yTop, width, height, page }` et le documente — sinon tout le regroupement par
proximité de la Phase 2 raisonnera à l'envers.

### Fichiers créés — Phase 1.5a (ESC/POS hors ligne)

| Fichier | Rôle |
|---|---|
| `packages/ticket-layout/src/types.ts` | `TicketLayout`, `TicketLine` (`text` / `two-col` / `separator` / `feed` / `cut`), largeur en colonnes |
| `packages/ticket-layout/src/build.ts` | `buildTicketLayout(receipt, opts)` — troncature/wrap contrôlés, jamais de perte silencieuse |
| `packages/receipt-renderer/src/escpos/commands.ts` | constantes ESC/POS nommées (`ESC @`, `ESC t`, `ESC a`, `GS !`, `GS V`) |
| `packages/receipt-renderer/src/escpos/codepage.ts` | transcodage PC858, table testée sur `é è à ç ù ° €` |
| `packages/receipt-renderer/src/escpos/emit.ts` | `emitEscPos(layout): Uint8Array` |
| `packages/receipt-renderer/src/escpos/decode.ts` | décodeur : octets → texte 42 colonnes + PNG (vérification hors ligne) |
| `packages/printer/src/adapter.ts` | interface `PrinterAdapter` (§36) |
| `packages/printer/src/file-adapter.ts` | `FilePrinterAdapter` → `debug/*.escpos.bin` |
| `packages/printer/src/mock-adapter.ts` | `MockPrinterAdapter` |
| `spikes/escpos-raw/` | script Windows + `README` de procédure — livré, non exécuté (1.5b) |
| `packages/receipt-renderer/src/escpos/__snapshots__/` | ticket nominal, nom long, multi-TVA, certification longue |

Note : les fixtures de layout de 1.5a utilisent un `Receipt` **synthétique** écrit à la
main. Aucune dépendance au PDF réel, donc rien ne bloque. Le `Receipt` synthétique sera
remplacé par les sorties du parser en Phase 3.

---

## 6. Validation

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm inspect ./fixtures/booksy/ticket-996.pdf   # → debug/ticket-996.json
```

Le gate de sortie est le **code retour** de chacune de ces commandes, pas leur sortie
texte.

---

## 7. Risques

| Risque | Prob. | Impact | Mitigation |
|---|---|---|---|
| Codepage ou spooler RAW se comportent autrement que prévu | Moyenne | `EscPosEmitter` à retoucher | Seul l'emitter est concerné ; layout/parser/protocole intacts (couche §2.1) |
| AC14 / AC15 non validés avant la Phase 6 | **Certaine** (pas de matériel) | Découverte tardive d'un blocage d'impression | 1.5b prêt à lancer, procédure écrite ; à exécuter dès l'accès au PC — **ne pas laisser glisser jusqu'à la Phase 9** |
| Exe SEA non signé → SmartScreen bloque le client | Élevée | Installation refusée | Build+signature en CI Windows ; prévoir un certificat |
| `pdfjs-dist` récalcitrant au bundle SEA | Moyenne | Packaging | Build `legacy`, worker off ; validé en CI dès la Phase 0 |
| PDF Booksy sans couche texte (image scannée) | Faible | Parser impossible | Vérifié en Phase 1 sur le PDF réel — avant d'écrire le parser |
| Booksy change son DOM | Élevée à terme | Chemin A cassé | Chemin B (downloads) indépendant, AC18 testé ; fixtures DOM (§49) |
| Aucune machine Windows de test disponible | **Confirmé** | Bloque 1.5b, 6, 9 | Tout le code Windows derrière `PrinterAdapter` ; `FilePrinterAdapter` + décodeur ESC/POS pour vérifier sur macOS |
| Format PDF Booksy variable selon établissement/pays | Moyenne | Parser fragile | `confidence` + `warnings` ; refus d'impression sous seuil (§34) |

---

## 8. Acceptation du lot 1 — livré le 2026-09-07

- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test` → exit 0 (135 tests, 8 fichiers)
- [x] Structure §7 en place, avec les ajouts justifiés
- [x] ID d'extension déterministe (clé dans le manifest)
      → `ndfcmfgnelpdjgpmaelpdgoccmjcpdjm`, voir `apps/extension/.extension-id`
- [x] `debug/` et les PDF non anonymisés gitignorés
- [ ] **CI Windows verte — workflow écrit, jamais exécuté** : pas de remote git.
      `.github/workflows/ci.yml` a une matrice ubuntu + windows-latest. Elle ne
      prouvera rien avant le premier push.
- [x] `pnpm inspect` produit un JSON de coordonnées exploitable
- [x] `EscPosEmitter` + décodeur : snapshots verts (nominal, stress, minimal)
- [x] `é è à ç ù ° €` correctement encodés en PC858 (test dédié par caractère)
- [x] `spikes/escpos-raw/` + procédure livrés, prêts à exécuter sur Windows
- [x] Aucun parsing métier Booksy écrit (§60)

### Ce que le lot 1 a fait apparaître

Quatre choses découvertes en implémentant, à retenir pour les phases suivantes :

1. **pdf.js émet des runs de blanc synthétiques** (`text: " "`, `height: 0`) pour
   représenter l'écart entre deux colonnes d'une même ligne. Pris au pied de la
   lettre, leur `yTop` se décale d'une hauteur de police et casse le regroupement
   par ligne. L'extracteur récupère la taille de police depuis la matrice de
   texte et les marque `isWhitespace`. **Leur `x` et leur `width` mesurent
   l'écart exactement** — c'est un signal utile pour un parser en colonnes
   (§61) : `groupIntoLines(items, { includeWhitespace: true })`.
2. **`isEvalSupported` n'existe plus dans pdfjs-dist 5.x.** L'option a disparu en
   v5 ; il n'y a plus rien à désactiver.
3. **La conversion de fuseau est une transformation fiscale.** `new Date()`
   ré-exprimait un horodatage dans le fuseau de la machine : un reçu émis à 15:09
   s'imprimait 19:09. `formatDateTime` reformate désormais les composants
   littéraux, sans arithmétique de fuseau.
4. **Le contrôle visuel attrape ce que les tests structurels laissent passer.**
   Le premier `decodeToSvg` produisait un SVG valide, avec le bon texte, qui
   passait ses tests — et dont la mise en page mentait (remplissage effacé par le
   viewer, chevauchement en double hauteur). Les snapshots texte sont la
   vérification qui porte ; le SVG est un confort, à re-regarder à l'œil quand il
   change.

### Écarts assumés par rapport au plan initial

| Écart | Raison |
|---|---|
| Package `ticket-layout` séparé de `receipt-renderer` | rend AC12/AC13 testables en assertions pures |
| `PrinterAdapter.printRaw(bytes, …)` au lieu de `print(receipt, …)` (§36) | la couche imprimante n'a pas à connaître le modèle fiscal ; la composition se fait au-dessus |
| Décodeur en SVG, pas en PNG | pas de police bitmap à embarquer, texte sélectionnable, proportions double largeur/hauteur exactes |
| `PARSE_RECEIPT` prend un `ReceiptSource` discriminé (`path` \| `bytes`) | un seul type de message couvre le chemin téléchargement et le chemin bouton (§2.3) |
| Pas de `@crxjs/vite-plugin`, pas de React | 4 points d'entrée quasi statiques ; §6 les donnait comme conditionnels |
| `debug/` porte aussi les sorties ESC/POS (`.bin`, `.txt`, `.svg`) | même règle PII que le JSON de l'inspecteur |

### Prochaine action bloquante

Le spike 1.5b attend **un poste Windows**. Le protocole est dans
`spikes/escpos-raw/README.md`. C'est le seul blocage restant côté matériel.

---

## 11. Phase 5 — extension ↔ Native Host, livrée le 2026-09-07

349 tests, 24 fichiers. Quatre portes à exit 0. JavaScript de l'extension :
**7,4 kB**.

### Chaîne respectée (§9)

```
popup / content script ─→ chrome.runtime.sendMessage
                       ─→ service worker
                       ─→ chrome.runtime.sendNativeMessage ─→ host
```

Le service worker est le **seul** à parler au host. Le routeur vérifie
`sender.id === chrome.runtime.id` : `onMessage` est joignable depuis les content
scripts, qui tournent au contact d'une page web, et sans ce contrôle le worker
serait un relais ouvert vers le host. Le protocole interne est un **ensemble
fermé d'intentions** (`GET_HOST_STATE`, `PING_HOST`), pas un passe-plat : un
appelant ne peut pas nommer un type de message natif et le faire relayer. Testé.

### Zod sorti du bundle de l'extension

`@brb/shared` réexportait les schémas Zod, et l'extension embarquait **90 kB** de
validateur pour du code qui n'y tourne jamais — la validation est le travail du
host (§44).

`native-protocol.ts` ne contient plus que les types et les constantes ; les
schémas vivent dans `@brb/shared/schemas`. Le chunk est passé de **90,29 kB à
3,56 kB**.

L'union `NativeMessage` est donc écrite à la main **et** dérivée de Zod. Ce qui
rend cette duplication sûre : `expectTypeOf<ValidatedNativeMessage>().toEqualTypeOf<NativeMessage>()`
dans `schemas.test.ts`, vérifié par `pnpm typecheck`. Et un garde-fou de budget
dans la CI (60 kB) pour repérer une régression d'ordre de grandeur.

### Décisions

| Décision | Raison |
|---|---|
| `NativeHostClient.send` renvoie une `NativeResponse`, **ne lève jamais** | Un host absent et un host qui répond une erreur sont tous deux « ça n'a pas marché, voici pourquoi » ; l'UI a besoin du même chemin de code. |
| Trois codes d'erreur de transport au lieu d'un | `NATIVE_HOST_NOT_FOUND`, `NATIVE_HOST_FORBIDDEN`, `NATIVE_HOST_CRASHED`. Trois actions différentes : installer, réenregistrer avec le bon ID, consulter les logs. Dire « installez-le » à quelqu'un qui l'a déjà l'envoie dans la mauvaise direction. |
| Le texte brut de Chrome est toujours conservé dans `detail` | Chrome donne ces erreurs en anglais sans code ; matcher sur le texte est la seule option, donc un libellé reformulé doit rester diagnosticable. |
| `HostState` est une union discriminée | Le popup ne peut pas rendre un demi-état : « connecté mais version inconnue » n'est pas représentable. |
| `PING` puis `GET_STATUS` | PING est la réponse la moins chère à « y a-t-il quelque chose ». Si les protocoles divergent, inutile d'interpréter un `StatusData` dont la forme a pu changer. |
| Bouton « Imprimer un test » piloté par `status.supported` | Il s'allumera seul quand la phase 6 arrivera, et il ne peut pas promettre ce que le service installé ne sait pas faire. |
| `StatusData.printerName` ajouté | Le §17 veut le nom dans le popup ; le host le connaissait sans le remonter. |
| Pas de page Options | `GET_CONFIG` / `SET_CONFIG` ne sont pas implémentés (le host fait `PING` + `GET_STATUS`). Une page de réglages sans rien à régler serait un mensonge d'interface. Elle arrive en phase 6. |
| Pas de React | Une vue quasi statique. Le §6 l'autorisait sans l'imposer. |

### Installation du host en développement

```bash
pnpm host:install              # tous les navigateurs Chromium détectés
pnpm host:install --id XXXX    # ajouter un second ID (Chrome vs Edge, §52)
pnpm host:install --uninstall
```

Écrit le manifest dans les six répertoires `NativeMessagingHosts` détectés, avec
`allowed_origins` limité à l'ID exact — jamais de wildcard (§11).

**Un vrai piège trouvé là.** Le wrapper appelait `node_modules/.bin/tsx`, qui est
un script shell faisant `exec node`. Un host natif est lancé sans shell, depuis
un répertoire imprévisible et avec un environnement épuré : reproduit avec
`env -i` depuis `/`, il mourait sur `node: not found` — fatal avec node installé
par nvm ou fnm, ce qui est le cas ici. Le wrapper utilise désormais le chemin
absolu de node et de `tsx/dist/cli.mjs`. Revérifié sous `env -i` : exit 0, trame
correcte, **zéro octet résiduel** sur stdout.

### Le contrôle visuel ne marchait pas ici — et c'est devenu un test

Le panneau d'aperçu ne rend que des instantanés statiques : le JS de la page ne
s'exécute pas, donc un harness de popup y reste figé sur son état initial.

Plutôt que de renoncer, le câblage DOM a été extrait dans `popup/dom.ts` et il
est exercé **sous jsdom contre le vrai `index.html`**. C'est mieux que le
contrôle à l'œil : le test échoue si un `id` est renommé dans l'un des deux
fichiers, ce qui dans un navigateur ne se manifeste que par un popup vide.

### Vérifié dans un vrai Chrome le 2026-09-07

Chrome 152, extension chargée, popup ouvert : **« Service connecté »**, les
quatre lignes de la checklist renseignées, le nom d'imprimante affiché, le bouton
de test désactivé avec son motif, et le pilote `mock` nommé explicitement.

La chaîne complète a donc tourné : popup → service worker →
`sendNativeMessage` → wrapper → host → trame de réponse → UI.

**Trois pannes réelles trouvées là, qu'aucun test unitaire n'attrapait.**

**1. Chrome lance le host AVEC des arguments.** `main.ts` traitait tout argument
comme un mode CLI, donc `chrome-extension://<id>/` en argv[0] provoquait
« Commande inconnue » et un exit 2 — que l'extension voyait comme « Native host
has exited ». Le probe passait parce qu'il lance le host sans argument.

La sélection de mode vit maintenant dans `mode.ts` : le mode messaging est le
**défaut**, et seul un mot qui ressemble à une commande mal tapée obtient l'aide.
Un drapeau inconnu part en messaging — se tromper sur un futur drapeau de
navigateur tue le host, se tromper sur une faute de frappe n'affiche qu'un
usage. Sept tests, dont la régression exacte.

**2. `default_locale: "fr"` sans arborescence `_locales`.** Chrome refuse de
charger l'extension : « Default locale was specified, but _locales subtree is
missing. » Les libellés sont des littéraux français, il n'y avait rien à
pointer. Retiré, et `manifest.test.ts` couvre désormais neuf invariants du
manifest — la cohérence `default_locale`, les permissions minimales, l'absence
de wildcard, et le fait que les chemins déclarés existent réellement.

**3. `--load-extension` est ignoré par Chrome ≥ 137** sauf avec
`--disable-features=DisableLoadExtensionCommandLineSwitch`. Silencieusement :
aucune erreur, l'URL de l'extension ne résout simplement rien. À retenir pour
les tests Playwright du §47. Le chargement a finalement été fait par le domaine
CDP `Extensions.loadUnpacked`, qui a renvoyé exactement l'ID épinglé
`ndfcmfgnelpdjgpmaelpdgoccmjcpdjm` — preuve au passage que la clé du manifest
tient sa promesse et que `allowed_origins` correspondra.

**Une découverte sur les chemins.** Un navigateur lancé avec `--user-data-dir`
cherche le manifest du host sous **ce** répertoire, pas dans l'emplacement
utilisateur standard. Le popup annonçait le host absent alors que le manifest
standard était bien en place. `pnpm host:install --profile <dir>` couvre
désormais ce cas.

**Et la classification d'erreur de transport a été validée sur les vraies
chaînes de Chrome** — les deux, successivement : `Specified native messaging host
not found.` → `NATIVE_HOST_NOT_FOUND` → « Installez… », puis `Native host has
exited.` → `NATIVE_HOST_CRASHED` → « Consultez les journaux ». C'est exactement
ce que les trois codes distincts devaient acheter.

---

## 10. Phases 3 et 4 — livrées le 2026-09-07

288 tests, 19 fichiers. `lint`, `typecheck`, `test`, `build:extension` : exit 0.

### Phase 3 — renderer HTML

`emitHtml(layout, options)` produit l'aperçu écran. **Ce n'est pas le chemin
d'impression** : il sert le `showPreview` du §18.

L'invariant qui compte : HTML et ESC/POS consomment tous deux
`renderTicketLines`, et un test compare les lignes émises en HTML à
`layoutToLines` **caractère par caractère** sur les trois fixtures. Un aperçu qui
a l'air juste est donc une information sur le papier, pas une seconde hypothèse.

Deux détails de mise en œuvre non évidents :

- `white-space: pre` est indispensable — les lignes sont déjà remplies d'espaces
  par la couche layout, et sans lui le remplissage s'effondre et les colonnes se
  décalent.
- La taille de police est **résolue en TS**, pas en CSS :
  `printableWidth / columns / 0.6`, où 0,6 est le ratio d'avance des polices
  monospace courantes. C'est le seul moyen de dire à CSS « 42 caractères, cette
  largeur ». Une police d'un autre ratio décale légèrement l'aperçu ; elle ne
  peut pas décaler l'impression, qui est pilotée par les octets.
- Double taille : `font-size` pour la hauteur, `transform: scaleX(w/h)` pour la
  largeur. La double hauteur sort donc haute et étroite, comme sur l'imprimante,
  au lieu de simplement plus grosse.

Le HTML ne charge **rien** depuis le réseau — testé (`https?://`, `<script>`,
`@import`, `url(`) pour la CSP MV3 et AC19.

### Phase 4 — Native Host

```
stdin ─→ FrameReader ─→ Zod ─→ dispatch ─→ encodeFrame ─→ stdout
                                  ↓
                            config + logs
```

Implémente **`PING` et `GET_STATUS`**, et refuse tout le reste explicitement.

| Décision | Raison |
|---|---|
| `FrameReader` est un accumulateur **pur**, sans I/O | Les cas intéressants sont tous des frontières de chunk : une longueur coupée en deux lectures, plusieurs messages dans une lecture, un corps qui arrive en morceaux. Pénibles à reproduire sur un vrai pipe, triviaux sur une fonction. |
| Longueur déclarée > 32 Mo → **arrêt** de la lecture | Un writer hostile ne doit pas pouvoir faire allouer sans borne, et une longueur absurde rend la position du flux non fiable : mieux vaut s'arrêter que resynchroniser sur ce qui pourrait être des corps de messages. |
| Corps JSON invalide → signalé, **lecture poursuivie** | Le cadrage a tenu, seul le contenu était mauvais : la trame suivante reste lisible. |
| Réponse > 1 Mo → remplacée par une erreur explicite | Chrome jette une réponse trop grosse **sans erreur nulle part** ; l'extension attendrait indéfiniment. |
| Un type connu mais non implémenté → `NOT_IMPLEMENTED` | Un message de protocole valide qui arrivera en phase 6 ne doit pas être rapporté comme malformé. Code ajouté au §40. |
| `dispatch` ne lève **jamais** | Un host qui meurt sur un mauvais message est indiscernable d'un host non installé — la panne la moins diagnosticable qui soit. |
| `StatusData.printerAdapter` | L'adapter est injecté et vaut `mock` jusqu'à la phase 6. Sans ce champ, le popup afficherait une coche verte parce qu'un mock a répondu. |
| `id` récupéré même d'un message invalide | Sinon l'extension ne peut pas corréler la réponse. À défaut, `'unknown'`. |
| Config absente → défauts, **sans créer de fichier** | Lire un état ne doit pas écrire un état. |
| Config corrompue → défauts + erreur remontée | Refuser de démarrer parce qu'un JSON a été tronqué laisserait l'utilisateur sans moyen de le réparer depuis l'UI. |
| Écriture config en fichier temporaire + `rename` | Un crash ou un disque plein ne peut pas laisser une config à moitié écrite. |
| Logs : fichier + stderr, **jamais stdout** | `stdout` appartient au protocole. ESLint impose `no-console` sur ce répertoire, et un test vérifie qu'aucun octet ne part sur stdout. |
| Un dossier de logs non inscriptible n'arrête pas le host | Perdre une ligne de log ne vaut jamais de faire échouer une impression. |
| `BRB_DATA_DIR` | Les tests ne doivent jamais toucher la vraie config du poste. |

### Le host est autonome (§58)

```bash
pnpm host ping | status | paths
pnpm host config [set <clé> <valeur>]
pnpm host parse|ticket|html|escpos <pdf>
```

Vérifié sur le vrai reçu : `pnpm host ticket fixtures/booksy/recu-1167.pdf` sort
le ticket 42 colonnes sans navigateur.

### Tester le host sans Chrome (§63)

```bash
pnpm host:probe            # PING puis GET_STATUS
pnpm host:probe --bad      # type inconnu
pnpm host:probe --batch    # deux trames dans une seule écriture
```

Le probe **spawn le host et parle le vrai protocole préfixé en longueur**, donc
il teste ce qui casse réellement en production — le cadrage, et si quelque chose
a pollué stdout — là où les tests unitaires appellent le dispatcher directement.

### Bug attrapé à l'œil, pas par les tests

L'aperçu HTML du vrai reçu montrait **« Client n »** au lieu de « Client n° » :
le signe degré manquait dans `buildTicketLayout`, alors que la ligne Ticket
l'avait. Aucun test structurel ne pouvait le voir. Régression couverte
désormais — deuxième fois que le contrôle visuel rattrape ce que les assertions
laissent passer (cf. §8, `decodeToSvg`).

---

## 9. Phase 2 — parser, livrée le 2026-09-07

Faite sur `recu-1167.pdf` (reçu réel, non committé — capté par la règle PII).

**Résultat de bout en bout** : PDF → `parseBooksyReceipt` → `Receipt` →
`TicketLayout` → ESC/POS. Confidence **1.0**, **0 warning**, 30 lignes,
**0 ligne hors de la grille 42 colonnes**, 865 octets, **0 caractère substitué**.
AC7 à AC11 satisfaits sur un document réel.

### Structure du document réel

1 page A4, 70 runs, couche texte présente. Deux polices : `g_d0_f1` gras,
`g_d0_f2` normal. Sept blocs : en-tête ticket (deux colonnes, date en colonne
droite avec **libellé au-dessus de la valeur**), établissement, table des
prestations (en-tête sur **3 lignes**), Total TTC, table TVA (+ ligne de totaux
en gras), Résumé paiement, bloc NF525.

### Stratégie retenue : classification par type, pas par colonnes

Les frontières géométriques ont été mesurées : en-têtes à x = 34/350/416/464/544,
donc médianes à 192/383/440/504. Le `T2000` de la ligne d'article est centré à
**438** pour une frontière à **440** — deux points de marge. Une métrique de
police différente et il change de colonne.

Les colonnes sont en revanche distinctes **par type** : `^\d+\.$` index,
`^x\d+$` quantité, `^[A-Z]{1,3}\d{2,6}$` code TVA, `^\d+%$` taux,
`^-?[\d ]+,\d{2} €$` montant, le reste étant le libellé. La position n'arbitre
plus que les deux colonnes monétaires de la ligne d'article : à gauche le prix
unitaire brut, à droite le total.

Un seul champ est lu spatialement — la date de création, parce que Booksy met son
libellé en colonne droite et sa valeur sur la ligne suivante : on prend le run le
plus proche en dessous dont l'empan horizontal recouvre celui du libellé.

### Décisions et découvertes de la phase 2

| Point | Résolution |
|---|---|
| Les articles portent un **code** TVA (`T2000`), pas un taux | `ReceiptItem.vatCode` ajouté ; le taux est **lu** dans la table TVA et joint sur le code. Aucun calcul. |
| `certification.signature` **absent** du reçu réel | Le scoring de confiance ne l'exige pas — sinon tout reçu authentique tomberait sous le seuil. Seul l'horodatage de signature existe. |
| `totals.subtotal` | Lu dans la colonne « Total HT » de la ligne de totaux de la table TVA. Jamais sommé. |
| Total TTC illisible | Le parser **refuse** (`BooksyParseError` / `INVALID_RECEIPT`) au lieu de renvoyer un `Receipt` avec un total inventé. Un ticket à 0,00 € d'apparence correcte est plus dangereux qu'un refus. |
| Ancres et accents | pdf.js peut restituer « operation » là où la page montre « opération », selon l'encodage de police. Toutes les ancres acceptent les deux formes. |
| Détection ancrée sur `^` | Bug corrigé : les signaux `^Total TTC` et `^\(NF525\)` étaient testés contre un texte joint par `\n` sans flag `m`, donc **deux signaux sur sept étaient morts**. La détection teste maintenant run par run. |
| Code TVA hors table | Lu quand même comme un code (règle de forme), plus un `AMBIGUOUS_FIELD`. Le traiter comme de la prose perdait le code **et** le collait au libellé. |
| `Nombre d'impressions` et `Créé par` | **Volontairement ignorés** (décision du 2026-09-07). Booksy compte ses impressions ; les nôtres ne l'incrémentent pas, ce qui renforce le marquage `DUPLICATA`. |

### Fixtures et PII

Le reçu réel ne peut pas être committé. `scripts/anonymize-inspection.ts` produit
`fixtures/booksy/recu-1167.anon.json` (+ `.anon.pdf` régénéré) : **géométrie
réelle conservée, chaînes identifiantes remplacées**. Le PDF régénéré se
réinspecte à l'identique — mêmes 70 runs, mêmes 26 lignes.

Le script porte un garde-fou : il **refuse d'écrire** si une chaîne d'origine
survit dans la sortie. Ajouté après une vraie fuite — le tableau `lines` du CLI
était recopié verbatim à côté des runs nettoyés.

Le spike 1.5b attend **un poste Windows**. Le protocole est dans
`spikes/escpos-raw/README.md`.

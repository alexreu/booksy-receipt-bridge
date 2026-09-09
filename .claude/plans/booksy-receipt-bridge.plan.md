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
| 6a | `LIST_PRINTERS`, `PRINT_TEST`, `PRINT_RECEIPT`, options | **fait** — logiciel |
| 6b | `WindowsPrinterAdapter` sur matériel | AC5, AC6, AC14, AC15 — bloqué |
| 7 | `chrome.downloads` + déduplication | **fait** — AC16, AC17 |
| 8 | Impression du PDF de l'onglet actif | **fait** — AC18 (fallback intact) |
| 9 | Exécutable autonome + installeur + mises à jour | **fait** — AC20 démontré |
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

---

## 17. Phase 11 — un seul chemin : l'onglet, l'aperçu, l'impression, livrée le 2026-09-08

609 tests, 41 fichiers, quatre portes à exit 0. Extension : 25,7 kB — 9 kB de
moins qu'en phase 10, uniquement par soustraction.

### Le téléchargement disparaît du produit

Décision du 2026-09-08 : on ne télécharge rien. Un reçu s'ouvre dans un onglet,
l'extension le lit, le convertit et l'imprime. Ce qui a été supprimé :

| Supprimé | Pourquoi ça tombe |
|---|---|
| `downloads/` (filtre, magasin, veilleur) et la permission `downloads` | Plus rien à surveiller. Une permission que le code n'utilise plus est une promesse faite au navigateur pour rien. |
| Intentions `LIST_DETECTED`, `PRINT_DETECTED`, `DISMISS_DETECTED` | Elles ne servaient que la liste des téléchargements. |
| Intention `PRINT_ACTIVE_TAB` | L'impression directe n'a plus d'appelant : la popup passe toujours par l'aperçu. |
| Le badge de l'icône | Il comptait des reçus détectés qui n'existent plus. |
| Source d'aperçu `download` | `PreviewSource` n'a plus qu'un cas, et il ne porte **aucune adresse** : le worker lit l'onglet lui-même. |
| Cases « impression automatique après téléchargement » et « seuil de confiance » | L'impression automatique n'avait de déclencheur que le téléchargement. |
| Case « afficher un aperçu » | L'aperçu n'est plus une option : c'est le seul chemin, et c'est là que l'imprimante se choisit. |

Le host garde `printing.autoPrint`, `showPreview`, `confidenceThreshold` et
`allowedDirs` dans sa configuration : la source `path` sert encore à la CLI
(`ticket fichier.pdf`), et §23 la valide toujours. L'extension, elle, n'envoie
plus jamais de chemin.

### La popup n'a plus qu'un bouton, et il est toujours là

« Imprimer » ouvre l'aperçu. Rien d'autre : ni nom d'imprimante affiché, ni
liste, ni impression directe. Le bouton ne dépend plus d'une imprimante
configurée — un poste sans imprimante par défaut peut imprimer, puisque le choix
se fait dans l'aperçu, par travail, sans jamais être écrit dans la
configuration.

Il reste **visible en permanence**, grisé avec sa raison quand l'onglet n'affiche
pas de PDF. La première version le masquait dans ce cas : la popup se réduisait
alors à « Imprimer un test », ce qui donne à lire que cette extension n'imprime
pas de reçus. Un bouton grisé qui dit pourquoi est la version honnête — défaut
remonté par l'utilisateur, invisible aux tests puisque chacun lui passait un PDF.

### Un PDF local s'imprime, sans nouvelle permission

Un onglet `file://` était refusé : le worker ne peut pas lire un fichier du
disque sans une permission que ce projet ne demande pas. Mais **le service, si**
— et il le fait déjà proprement : il revalide le chemin contre ses dossiers
autorisés, résout les liens symboliques avant de comparer, et vérifie que le
fichier est bien un PDF (§23).

Le worker ne lit donc rien : il lit l'URL de l'onglet — c'est ce que `activeTab`
accorde au clic — en extrait le chemin et le passe au service. Deux routes, une
règle : `http(s)` voyage en octets faute de chemin à relire, `file:` voyage en
chemin. Vérifié dans Chrome sur `file:///Users/…/Downloads/recu-1167.pdf` :
`Ticket 1167 imprimé (856 octets)`. Un chemin hors des dossiers autorisés est
refusé par le service, comme avant.

### « Imprimer un test » disparaît

Un deuxième bouton d'impression dans une popup qui n'en veut qu'un, et une
règle imprimée n'est plus le moyen de caler la largeur : le nombre de colonnes
vit dans les Paramètres. L'intention `PRINT_TEST` quitte l'extension ; le
service la garde dans son protocole.

### La largeur redescend dans les Paramètres

La phase 10 mettait un champ « Colonnes » dans l'aperçu, qui refaisait le rendu
à chaque frappe. Utile pour caler une imprimante, inutile ensuite : le poste
n'imprime que du 80 mm (décision du 2026-09-09), la largeur est une propriété du
papier, pas une décision par ticket.

Le champ part, et avec lui le paramètre qui le portait — `columns` disparaît de
`RENDER_PREVIEW`, `PRINT_PREVIEW`, `RENDER_RECEIPT` et `PRINT_RECEIPT`. Le
parseur l'ignore désormais si un appelant l'attache : sans ça, une page aurait pu
faire imprimer un ticket à une largeur que personne n'a vue à l'écran. L'aperçu
continue d'**afficher** la largeur employée (« 856 octets, 42 colonnes ») : c'est
une information sur le travail, pas une commande.

Reste dans l'aperçu ce qui se décide par travail : l'imprimante.

### L'aperçu offre toutes les files du poste

`printerChoices` construit la liste et la sélection : l'imprimante configurée est
présélectionnée pour que le cas courant tienne en un clic ; si elle a disparu du
poste, **rien n'est sélectionné** — se rabattre en silence sur une autre file,
c'est sortir un reçu là où personne ne l'attend. Sur Windows, `Get-Printer`
énumère toutes les imprimantes installées, thermiques ou non : c'est l'utilisateur
qui juge, pas l'extension.

---

## 16. Phase 10 — aperçu avant impression, livrée le 2026-09-08

687 tests, 45 fichiers, quatre portes à exit 0. Extension : 34,8 kB.

### L'aperçu montre le travail réel, pas un sosie

`RENDER_RECEIPT` accepte un troisième format, `svg`, qui **émet les octets
ESC/POS puis les décode**. Ce qui est validé à l'écran est donc le job lui-même :
mêmes colonnes, mêmes doubles largeurs, mêmes caractères non représentables.
Un rendu HTML de la même mise en page aurait été un second dessin — joli, et
faux dès que le code page remplace un caractère.

Corollaire : la réponse porte `byteCount`, `columns` et `unmapped`. L'aperçu
peut dire « 812 octets, 42 colonnes » et signaler les caractères remplacés
**avant** que le papier sorte.

### La page ne détient qu'un identifiant

| Décision | Raison |
|---|---|
| Les octets ne quittent jamais le worker | Un onglet d'extension est un contexte de plus où un PDF de client pourrait traîner. La page reçoit `?id=`, rien d'autre. |
| Onglet actif → `bytes`, téléchargement → `path` | Le worker ne peut pas lire un fichier local ; le host, si. Garder le chemin fait **revalider la sécurité de chemin (§23) à chaque appel** au lieu d'une seule fois à la préparation. |
| Le libellé revient avec le rendu | Le passer dans l'URL aurait donné à la page une seconde source de vérité, modifiable par qui ouvre l'onglet. |
| `printerName` et `columns` par job | Un choix fait dans l'aperçu ne doit pas devenir silencieusement le défaut enregistré. |
| Trois aperçus en attente au maximum | Le stockage de session n'est pas une file d'attente ; au-delà, le plus ancien tombe. |

### Deux vrais défauts trouvés par les tests

1. **`RENDER_PREVIEW` perdait son `id`.** L'intention était rangée avec les
   lectures simples, dont l'analyse renvoie `{ kind }` avant même de regarder
   les autres champs. Le rendu partait donc toujours sur un aperçu vide.
2. **La règle du routeur était une liste de refus.** Toute intention *nouvelle*
   était par construction autorisée depuis un contexte de page — l'inverse de ce
   qu'on veut d'un défaut. Elle est devenue une liste d'autorisation : seules
   les lectures y figurent, tout le reste exige l'origine de l'extension.

### Le SVG est assaini même s'il vient de nous

Il est produit par ce projet, à partir d'octets que ce projet a émis. Il arrive
tout de même **sous forme de chaîne, dans un document vivant** : il est analysé
par `DOMParser`, réduit aux formes que le décodeur produit (`svg g rect text
line tspan`) et débarrassé de tout attribut `on*`. Un `<script>` dans un SVG
importé s'exécute ; celui-là ne peut pas exister.

### Ce que la sécurité de chemin a fait au passage

Le premier essai de rendu n'a rien sorti : `resolveSource` a refusé la fixture,
qui n'est pas dans les Téléchargements. Le §23 fonctionne, y compris contre
son auteur. Le rendu s'est fait par octets.

### Vérifié dans Chrome 152 le 2026-09-08

Fixture anonymisée servie en `http://127.0.0.1`, onglet actif → popup →
« Imprimer ce ticket » : l'onglet d'aperçu s'ouvre, titré par le libellé venu
avec le rendu, et affiche le ticket décodé — en-tête double largeur, totaux,
ligne de découpe.

| Ce qui est démontré | Preuve |
|---|---|
| L'aperçu est bien le job | La page annonce « 856 octets, 42 colonnes » ; le journal du service écrit `Ticket 1167 imprimé (712 octets)` après passage à 32 colonnes — la même valeur que la page affichait alors. |
| La calibration est vivante | 32 colonnes : le ticket se rétrécit, l'adresse passe sur deux lignes, le compte d'octets suit. |
| Un choix ponctuel reste ponctuel | Imprimé à 32 colonnes, `config.json` porte toujours `columns: 42`. |
| Pas de réimpression depuis un onglet resté ouvert | Rechargé après impression, l'aperçu répond « Cet aperçu a expiré ». |

**Le seul incident : un service worker périmé.** `PREPARE_PREVIEW` et
`RENDER_PREVIEW` revenaient « Message interne inconnu » alors que le bundle sur
le disque — vérifié octet par octet en copiant `chrome-extension://…/background/
index.js` — contenait bien les deux. Chrome sert les pages depuis le disque mais
garde le script du worker enregistré à l'installation : les pages étaient
neuves, le routeur non. « Mettre à jour » sur `chrome://extensions` a réglé le
cas. À retenir pour la procédure de test : recharger l'extension ne suffit pas
toujours, il faut vérifier que le worker a bien changé.

---

## 15. Phase 9 — exécutable autonome, installeur, mises à jour, livrée le 2026-09-08

645 tests, 43 fichiers, quatre portes à exit 0.

### AC20 est démontré, pas seulement conçu

`pnpm build:host` produit un binaire unique de 113 Mo qui embarque son runtime.
Testé pour de vrai sur macOS : `--version`, `ping`, et surtout
`ticket recu-1167.anon.pdf` qui sort le ticket complet avec `confidence 1`.
Aucun Node installé n'est requis.

**Trois pannes réelles trouvées en le construisant**, aucune détectable par les
tests unitaires :

1. **macOS tue un binaire modifié.** L'injection SEA invalide sa signature et le
   système l'arrête par SIGKILL — exit 137, aucune sortie. Une re-signature
   ad-hoc après `postject` règle le cas.
2. **`createRequire(import.meta.url)` casse en sortie CommonJS.** `import.meta`
   n'y existe pas, donc `createRequire(undefined)` levait **à l'initialisation
   du module**, tuant le host avant tout traitement. Corrigé sur deux fronts :
   l'appel est devenu paresseux (jamais atteint dans un binaire), et le build
   définit `import.meta.url` sur `__filename` — que `createRequire` accepte.
3. **pdf.js exige des globales DOM et un module de worker.** Bundlé, il levait
   `DOMMatrix is not defined`, puis cherchait `pdf.worker.mjs` à côté de
   l'exécutable. Des stubs **inertes** couvrent les globales — on ne fait que
   lire du texte, jamais de rendu, et ils lèvent si quelque chose tentait de
   rasteriser. Le worker et les polices sont livrés à côté du binaire, et
   `workerSrc` pointe dessus explicitement au lieu de laisser pdf.js deviner.

Corollaire architectural : `pdfjsAssetRoot()` cherche dans trois endroits, dans
l'ordre — variable d'environnement, à côté de l'exécutable, puis résolution npm.
Sans le deuxième, un host installé ne peut lire aucun PDF.

### Installeur : PowerShell, sans élévation

`Install.ps1` plutôt qu'un `Setup.exe` compilé : ça fonctionne aujourd'hui, sans
chaîne de build Windows, et la logique est relisible en diff. Tout va dans le
profil utilisateur — exécutable sous `%LOCALAPPDATA%`, registre sous `HKCU` —
ce qui est la préférence explicite du §12 et évite une élévation qu'un poste
contraint ne donnera pas.

Chaque navigateur Chromium reçoit son entrée ; un navigateur absent est ignoré,
pas signalé comme une erreur (§53). La configuration existante est **conservée**,
et la désinstallation garde config et journaux sauf `-Purge` : ce sont les
données de l'utilisateur.

### Mises à jour : le service fait le réseau, jamais l'extension

Le §50 ne prévoyait pas de mécanisme de mise à jour ; il est ajouté à la demande
du 2026-09-08.

| Décision | Raison |
|---|---|
| **Jamais automatique** | Le §AC19 dit qu'aucune donnée ne part vers un serveur distant. Une vérification de version n'envoie rien d'un reçu, mais un service qui téléphone sans qu'on le lui demande n'est pas ce que ce critère a en tête. Aucun timer, aucune vérification au démarrage. |
| **Le host fait la requête** | L'extension aurait besoin d'une permission d'hôte pour github.com et mettrait le jeton dans le navigateur. Là, le jeton reste dans un fichier lisible par le seul compte de l'utilisateur. |
| **Jeton optionnel** | Un dépôt **privé** n'expose pas ses assets publiquement. Le même chemin de code sert les deux cas : jeton posé → dépôt privé ; pas de jeton → releases publiques. |
| **Un tag est la procédure de release** | La CI Windows construit l'archive, **vérifie que le binaire lit un PDF**, et l'attache à la release. C'est elle que le bouton « Vérifier » interroge. |
| Une version illisible n'est jamais « plus récente » | Proposer une mise à jour sur la foi d'un tag que personne ne sait analyser est pire que n'en proposer aucune. |
| « Vérification impossible » ≠ « à jour » | Confondre les deux laisserait un jeton mal configuré passer pour une bonne nouvelle. |

### La contrainte que Chrome impose

Chrome **ne met pas à jour** une extension hors Web Store. Le mécanisme livré
télécharge donc l'archive et dit où elle est ; `Install.ps1` remplace le service,
et l'extension se recharge depuis le dossier `extension/` de l'archive. Une mise
à jour reste une action de l'utilisateur — ce n'est pas un choix de conception,
c'est la limite du navigateur.

### Prochaine action bloquante

Le spike 1.5b attend **un poste Windows**. Le protocole est dans
`spikes/escpos-raw/README.md`. C'est le seul blocage restant côté matériel.

---

## 14. Phase 8 — révisée : le PDF de l'onglet actif, livrée le 2026-09-07

594 tests, 38 fichiers, quatre portes à exit 0. Extension : 25,7 kB.

### Le §67 est abandonné, sur décision du 2026-09-07

Le plan prévoyait un `BooksyDomAdapter` injectant un bouton dans la page Booksy.
**Il n'y aura pas de page Booksy** : le reçu s'ouvre comme un PDF dans un onglet.

J'avais commencé l'adaptateur — stratégies d'ancrage, bouton, `MutationObserver`
— sur des fixtures DOM **inventées**, faute de capture réelle. Ce travail est
supprimé, non committé. C'est la bonne issue : il aurait eu exactement la
faiblesse que le parser aurait eue sans le vrai PDF.

### Ce que la révision achète

| | `BooksyDomAdapter` (abandonné) | PDF de l'onglet actif |
|---|---|---|
| Content script | oui | **aucun** |
| `host_permissions` | domaines Booksy | **aucune** |
| Connaissance du DOM d'un site | oui, à re-deviner à chaque refonte | **aucune** |
| Sites couverts | Booksy uniquement | tout onglet affichant un PDF |
| Vérifiable sans vraie page | non | oui, sauf un maillon |

`activeTab` remplace les permissions d'hôte : elle est accordée **au clic** sur
l'icône, donc aucun site n'est listé dans le manifest. Le §42 est respecté à son
niveau le plus strict.

### Le worker résout l'onglet lui-même

`PRINT_ACTIVE_TAB` **ne porte aucune URL**. Le service worker interroge
`chrome.tabs.query` de son côté, donc il n'y a aucune adresse d'appelant à
valider et rien qu'une page pourrait désigner. Un test vérifie qu'une URL
attachée par un appelant est ignorée.

Détection d'un onglet PDF par deux signaux : le chemin se termine en `.pdf`, ou
le titre de l'onglet le fait — le visualiseur intégré met le nom du fichier en
titre, et c'est souvent le seul endroit où l'extension apparaît. Les schémas
`blob:`, `data:`, `file:` et `chrome-extension:` sont refusés : le worker ne peut
pas les récupérer, ou pas sans des permissions que cette extension ne demande
délibérément pas.

### Le maillon que je n'ai pas pu vérifier

`activeTab` n'est accordée que lorsque l'utilisateur **invoque** réellement
l'extension. Mesuré dans le navigateur : sans invocation,
`chrome.tabs.query({active:true})` renvoie `[{}]` — un onglet sans `url` ni
`title`. Et `chrome.action.openPopup()` appelé par programme réussit **sans**
accorder la permission.

Mon harnais CDP ne peut donc pas reproduire un vrai clic sur l'icône. **Reste non
vérifié** : que le `fetch` du service worker honore le grant `activeTab`. Si ce
n'était pas le cas, le correctif serait de faire le `fetch` depuis le popup ou
via `chrome.scripting` — un changement contenu à un fichier.

Ce que cette mesure a produit d'utile : le cas « pas d'accès à l'onglet » est
maintenant **distingué** de « cet onglet n'est pas un PDF ». Dire « pas un PDF »
d'un onglet qui en est manifestement un enverrait chercher au mauvais endroit.

Et le message évite de blâmer l'utilisateur : dire « ouvrez le popup depuis
l'icône » à quelqu'un qui vient de le faire est pire que se taire. Il pointe vers
le chemin qui, lui, est prouvé : « Téléchargez le reçu : il sera détecté
automatiquement. »

### Simplification demandée le 2026-09-08

La liste du popup gardait les reçus déjà imprimés, marqués « déjà imprimé »
avec un bouton « Retirer ». C'était de l'historique, pas de l'action.

Un reçu imprimé **quitte la liste** désormais. Le titre passe de « Reçus
téléchargés » à « À imprimer », qui dit ce que la section contient. Retiré avec :
`printedAt`, `updateDetected`, l'état `printed` des lignes, la variante de
bouton, et la règle CSS associée. `MAX_DETECTED` descend de 10 à 5 — quelques
reçus en attente, jamais un journal.

Ça ne coûte rien en sûreté : la protection contre le double tirage n'a jamais
vécu là. C'est le host qui tient sa propre fenêtre de déduplication
(`printing/dedupe.ts`), et un test vérifie qu'une impression **échouée** laisse
l'entrée en place — seul un succès la retire.

### AC18 tient toujours

Les deux chemins du §59 restent indépendants. Le chemin B — détection des
téléchargements — est vérifié de bout en bout et **ne demande aucun accès aux
onglets**. Si l'onglet actif est illisible, l'extension reste entièrement
utilisable.

---

## 13. Phase 7 — détection des téléchargements, livrée le 2026-09-07

562 tests, 37 fichiers, quatre portes à exit 0. Extension : 22 kB.

**Le workflow V1 du §4 tourne de bout en bout dans Chrome 152** : téléchargement
→ détection → « Ticket n° 1167 · 300,00 € » dans le popup → clic → « Ticket 1167
imprimé. » → la ligne passe à « déjà imprimé ». Vérifié en repartant d'un
stockage de session vidé.

### Le filtre du §20 aurait manqué tous les vrais reçus

Le plan proposait `ticket-*.pdf`. Le fichier réellement téléchargé s'appelle
**`recu-1167.pdf`**. Ce motif n'aurait rien détecté.

Mais inspecter *tous* les PDF téléchargés — relevés bancaires, contrats — est
plus d'accès que cette fonction n'a besoin, même si le host est local et que
rien ne sort du poste.

Le critère retenu est donc la **provenance** : un `.pdf` terminé venant de
Booksy (URL ou referrer, suffixe sur un point pour que
`booksy.com.evil.example` ne passe pas). Un nom de fichier en forme de reçu est
accepté aussi, ce qui couvre un fichier re-enregistré hors du flux navigateur.
Dans les deux cas ce n'est qu'un **candidat** : le host ouvre et décide (§21).
Le popup dit franchement « reconnu par son nom de fichier » quand c'est le
signal le plus faible qui a joué.

Autres filtres : `.crdownload` rejeté (Chrome écrit le partiel là, l'ouvrir
lirait un PDF tronqué), `exists: false` rejeté, `state === 'complete'` exigé.

### Un vrai piège MV3, observé dans le navigateur

Le log du host l'a livré : au moment du téléchargement, une connexion
**ouverte à 23:11:41 et jamais fermée** — le processus a été tué. La détection
n'a abouti qu'à 23:12:08, 27 secondes plus tard.

Cause : un service worker MV3 peut être évincé pendant qu'un appel natif est en
vol, et `sendNativeMessage` ne le maintient pas en vie comme le ferait un port
ouvert. Le processus host meurt avec lui.

**Plutôt que de me battre pour la durée de vie du worker, la détection est
rendue auto-réparatrice** : `LIST_DETECTED` fait une passe de rattrapage sur les
téléchargements récents avant de répondre. Ça couvre aussi un redémarrage du
navigateur et une extension installée après le téléchargement. Le gestionnaire
`onChanged` reste, en meilleure intention.

Corollaire nécessaire : les ids déjà soumis au host sont mémorisés
(`checkedDownloadIds`), **avant** l'appel et non après — sinon chaque ouverture
du popup re-soumettrait les mêmes PDF sans rapport.

### Rien n'est imprimé automatiquement

La détection et l'impression sont séparées : le worker n'envoie que
`PARSE_RECEIPT`, jamais `PRINT_RECEIPT`, et un test l'affirme. L'utilisateur se
voit proposer un bouton.

`PRINT_DETECTED` prend un **id de téléchargement, jamais un chemin** : le worker
utilise le chemin qu'il a lui-même enregistré, donc rien dans une page ne peut
désigner un fichier à ouvrir. Et c'est une intention en écriture, donc refusée à
un content script.

### État dans le stockage, pas en mémoire

Un worker MV3 est évincé en quelques secondes ; l'événement de téléchargement le
réveille, et il est presque certainement éteint quand l'utilisateur ouvre le
popup. `chrome.storage.session` est la bonne étagère : elle survit à l'éviction
et disparaît à la fermeture du navigateur, ce qui est exactement la durée de vie
d'une liste « à l'instant ».

La liste des reçus détectés a sa propre source, donc `applyPopupView` ne la
touche pas — même raisonnement que pour `#feedback` en phase 6a.

---

## 12. Phase 6a — impression côté logiciel, livrée le 2026-09-07

483 tests, 33 fichiers, quatre portes à exit 0. JavaScript de l'extension :
14,8 kB. **Le protocole est désormais intégralement implémenté** — un test
compare `SUPPORTED` à `NATIVE_MESSAGE_TYPES`, donc un type ajouté au schéma sans
handler échoue en CI au lieu d'atteindre un utilisateur.

### `WindowsPrinterAdapter` : PowerShell, pas de FFI

Les octets doivent atteindre `WritePrinter` en datatype RAW, donc appeler
`winspool.drv`. Un module natif (koffi) serait plus rapide, mais **un `.node` ne
peut pas être embarqué dans un exécutable Node SEA** : il faudrait le livrer à
côté et le retrouver au runtime, contre AC20. PowerShell avec un P/Invoke inline
coûte quelques centaines de millisecondes au démarrage et n'exige rien
d'installé.

RAW est tout l'intérêt : il contourne le rendu et la mise en page du pilote,
donc rien ne remet le ticket à l'échelle et aucune fenêtre n'apparaît (AC14,
AC15). Si le spike 1.5b montre que le coût de démarrage ou un antivirus rend ça
impraticable, **seul ce fichier change**.

Les octets passent par un fichier temporaire, pas par la ligne de commande : un
flux ESC/POS est binaire et truffé de caractères de contrôle qu'aucun
échappement shell ne survit.

### Sécurité des chemins (§23)

`resolveSource` n'ouvre un fichier que s'il est absolu, en `.pdf`, dans un
dossier autorisé (Téléchargements plus `printing.allowedDirs`), un fichier
régulier, sous 20 Mo, et commençant par `%PDF-`.

**L'ordre compte** : la containment est vérifiée **après** résolution des liens
symboliques. Un lien dans Téléchargements pointant vers `~/.ssh/id_rsa` passe
tous les contrôles textuels — c'est précisément l'attaque que cet ordre bloque,
et elle a son test.

`isInside` compare sur le séparateur : sans ça, `Downloads-secret` passerait
pour être dans `Downloads`.

### Déduplication : sur disque, pas en mémoire (§54)

`sendNativeMessage` démarre un **nouveau processus host à chaque message**, donc
tout ce qui est retenu dans une variable a disparu avant l'arrivée du second
clic — précisément le clic à attraper. Conséquence directe du choix « one-shot »
du §2.3, et la raison pour laquelle l'historique est un fichier.

Clé par déclencheur : un clic humain est identifié par ce qui est imprimé sur le
ticket, un déclenchement automatique par le **hash du fichier**, pour qu'un
nouveau téléchargement du même reçu ne produise pas un second ticket.

**Limite assumée** : deux processus host en course peuvent lire l'historique
avant que l'un des deux n'écrive, et imprimer deux fois. Réduire ça demanderait
un vrai verrou de fichier ; la fenêtre de protection fait le travail, et le coût
d'une course perdue est un ticket en trop.

### Le seuil de confiance vit dans le host

`PRINT_RECEIPT` prend un `trigger`. En `auto`, le host exige
`confidence >= confidenceThreshold` et refuse en dessous (§34) ; en `user`, il
imprime ce qu'il a lu et rapporte la confiance. La règle est côté host parce que
le host possède la configuration (§68).

Tous les refus se produisent **avant qu'un seul octet n'atteigne le spooler** —
le papier ne se dé-imprime pas. Un test vérifie que l'adapter n'a rien reçu dans
chaque cas de refus.

### Trois bugs réels trouvés en pilotant Chrome

Encore une fois, aucun test unitaire ne les attrapait.

**1. Aucun retour après « Imprimer un test ».** Le message allait dans `#hint`,
puis le re-render qui suit l'impression le réécrasait. Corrigé en **supprimant le
couplage d'ordre** plutôt qu'en réordonnant : un élément `#feedback` dédié, que
`applyPopupView` ne touche pas. Régression couverte.

**2. La page Options ne pouvait rien enregistrer.** Je distinguais un content
script par la présence de `sender.tab` — mais une page d'extension **ouverte dans
un onglet** en a aussi, et la page Options est déclarée `open_in_tab`. Le bon
discriminant est l'**origine** : `chrome-extension://<id>`. Un content script a
l'origine de sa page web.

**3. Rejet silencieux dans le formulaire.** `<input max="120">` déclenche la
validation native HTML5, qui **annule l'événement `submit`** : ni `buildPatch` ni
aucun message ne s'exécutait. Une valeur hors bornes ne disait rien, une valeur
dans les bornes mais incohérente donnait un message. Formulaire passé en
`novalidate`, toute la validation dans `buildPatch`.

### Une correction d'honnêteté d'interface

« Imprimer automatiquement » était activable, car je l'avais lié à
`supported.includes('PRINT_RECEIPT')` côté host. Mais la capacité manquante est
dans l'**extension** : détection des téléchargements (phase 7) et déclencheur
(phase 10). Le host sait imprimer un reçu aujourd'hui ; rien ne le lui demande
automatiquement. Piloté maintenant par `AUTO_PRINT_IMPLEMENTED`, à basculer en
phase 10.

### Vérifié dans Chrome 152

Popup : quatre coches vertes, nom d'imprimante, bouton de test **actif**, et le
clic renvoie « Ticket de test envoyé. Caractères remplacés : ’ œ » — le rapport
de substitution qui servira sur la vraie imprimante.

Options : liste peuplée par `LIST_PRINTERS`, note honnête « pilote « mock » : ce
ne sont pas de vraies imprimantes », largeurs et seuil lus dans le host,
enregistrement persisté (42 → 56 colonnes vérifié sur disque), validation
refusée avec son message.

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

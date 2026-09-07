# Spike 1.5b — impression ESC/POS brute sur TM-T88V

Ce dossier n'est **pas** du code de production. C'est le protocole de mesure qui
tranche les critères AC14 et AC15 (impression sans Ctrl+P, sans fenêtre Windows).

Il est livré en phase 1.5a et exécuté dès qu'un poste Windows + l'imprimante sont
disponibles. Tant qu'il n'a pas tourné, **AC14 et AC15 restent non validés**.

## Ce que le spike doit prouver

| # | Question | Comment on répond |
|---|---|---|
| a | Aucune boîte de dialogue n'apparaît | observation directe pendant l'exécution |
| b | 42 colonnes tiennent en Font A sur 80 mm | la règle de colonnes du ticket de test se termine en bout de ligne |
| c | `ESC t 19` (PC858) rend `é è à ç ù ° €` | ligne « Caractères » du ticket de test |
| d | `GS V 66` coupe le papier | le ticket se détache seul |
| e | Le spooler est accessible **sans droits admin** | exécuter dans un PowerShell non élevé |

Si (e) échoue, l'installeur devra demander l'élévation, ce qui contredit la
préférence `HKCU` de la section 12 du plan. C'est le résultat le plus important
du spike.

## Procédure

Sur le Mac :

```bash
pnpm spike:sample
```

Produit dans `debug/` :

```
spike-test-ticket.escpos.bin   les octets à envoyer
spike-test-ticket.txt          le rejeu texte, pour comparer avec le papier
spike-test-ticket.svg          le rejeu visuel
spike-nominal-ticket.escpos.bin
...
```

Copier `spikes/escpos-raw/` et les `.escpos.bin` sur le poste Windows, puis dans
un PowerShell **non élevé** :

```powershell
.\Get-Printers.ps1
.\Print-RawEscPos.ps1 -PrinterName "EPSON TM-T88V Receipt5" -Path .\spike-test-ticket.escpos.bin
```

## Relever le résultat

Comparer le papier avec `spike-test-ticket.txt`. Noter :

- le nombre de colonnes réellement imprimées (la règle `1234567890…`) ;
- les caractères substitués ou absents ;
- si une fenêtre est apparue ;
- si l'élévation a été nécessaire ;
- le comportement de la coupe.

Consigner le verdict dans `.claude/plans/booksy-receipt-bridge.plan.md`, section 3.

## Si ça échoue

Un échec ici ne touche que `EscPosEmitter`. `TicketLayout`, le parser et le
protocole ne dépendent pas de ces octets — c'est la raison d'être de la couche
intermédiaire (section 2.1 du plan).

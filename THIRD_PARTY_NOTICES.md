# Third-party software in MacCAD 2027

MacCAD 2027 bundles the open-source components below. Their licences apply to those components.

## Licence of MacCAD 2027 as a whole

MacCAD 2027 includes **GPL-3.0** components (LibreDWG and @mlightcad/libredwg-web, used for reading and writing DWG files), so the combined program must be distributed under the **GNU General Public License v3.0 or later** (`package.json`: `GPL-3.0-or-later`). If you receive a MacCAD 2027 binary you are entitled to its complete corresponding source code; contact the distributor or ask for it where you got the binary. The full GPL-3.0 text: <https://www.gnu.org/licenses/gpl-3.0.txt> (a copy should be placed in a `LICENSE` file before public distribution).

### Trial and licence key

The following manual-key description applies to direct-download builds. Mac App Store builds use
Apple StoreKit 2 subscriptions instead: monthly and annual products, with a two-week introductory
free trial when configured in App Store Connect and offered to an eligible customer. The trial
starts only after the customer confirms the subscription with Apple. Those builds do not use
computer-bound licence keys or a separate local 15-day trial. This distribution option does not
change the open-source licence or source-availability obligations described above. App Store
distribution compatibility must be reviewed before submission.

The program starts a 15-day trial on first launch and is view-only afterwards unless a licence key is entered. A key is checked on the user's own Mac with a public key; nothing is sent over a network. A key is tied to one computer by its Computer ID, a code derived from the Mac that the licence window shows; it leaves the Mac only if the user e-mails it. This is part of the program's source code, which stays available under the GPL like everything else: anyone may read it, change it and rebuild the program under the terms of the GPL. The key buys the right to keep using the supplied build and its updates and support; it does not take away the freedoms the GPL gives.

## Components

| Component | Version | Licence | Used for | Source |
|---|---|---|---|---|
| Electron | 33.4.11 | MIT (Chromium and its dependencies under their own licences, see `LICENSES.chromium.html` in the app bundle) | application shell | https://github.com/electron/electron |
| LibreDWG (`bin/dxf2dwg`, static build) | 0.13.3 | GPL-3.0-or-later | writing DWG (R2000) | https://www.gnu.org/software/libredwg/ |
| @mlightcad/libredwg-web (LibreDWG compiled to WebAssembly) | 0.7.17 | GPL-3.0 | reading DWG | https://github.com/mlightcad/libredwg-web |
| OpenCascade Technology (WebAssembly build in `replicad-opencascadejs`) | 1.1.0 | LGPL-2.1 with the OCCT exception | 3D solid modelling kernel | https://dev.opencascade.org/ , https://github.com/sgenoud/replicad |
| replicad | 1.1.0 | MIT | JavaScript API of the 3D kernel | https://github.com/sgenoud/replicad |
| pdf.js (`pdfjs-dist`) | 6.4.299 | Apache-2.0 | importing vector PDF | https://github.com/mozilla/pdf.js |
| polygon-clipping | 0.15.7 | MIT | 2D region union / subtract / intersect | https://github.com/mfogel/polygon-clipping |

OpenCascade is dynamically replaceable: the kernel is loaded as separate files (the OpenCascade files shipped with the program) so it can be swapped for a modified build, as the LGPL requires.

## Fonts (bundled so that text never breaks)

| Font | Licence |
|---|---|
| NanumGothic, NanumMyeongjo (NAVER) | SIL Open Font License 1.1 |
| Liberation Sans / Serif / Mono (Red Hat) | SIL Open Font License 1.1 |
| DejaVu Sans | Bitstream Vera / DejaVu free licence |
| osifont | GNU LGPL v3 with font exception |

## Not included

- No Autodesk code, fonts or resources are included. AutoCAD, DWG, DXF and AutoLISP are trademarks or formats of their owners; MacCAD 2027 is an independent program that reads and writes the published DXF format and, through LibreDWG, the DWG format.
- Writing DWG through LibreDWG is experimental. Files written by MacCAD 2027 are verified by reading them back, but have not been verified in Autodesk products.

/**
 * @file palette.js
 * @brief The Modeling palette: a docked panel with the 3D tools in groups (Solid, Surface, Mesh,
 * UCS, Draw, Modify), like the tool palettes of other CAD programs. A tool that this version does
 * not have is shown dimmed with a note instead of being left out.
 */
import { ICONS } from './icons.js';
import { def } from './registry.js';

/** Groups: [title, [[label, command, icon], ...]]. A null command = not available. */
export const MODELING_GROUPS = [
  ['Solid', [
    ['Box', 'BOX', 'box'], ['Cylinder', 'CYLINDER', 'cylinder'], ['Cone', 'CONE', 'cone'], ['Sphere', 'SPHERE', 'sphere'],
    ['Torus', 'TORUS', 'torus'], ['Wedge', 'WEDGE', 'wedge'], ['Pyramid', 'PYRAMID', 'pyramid'],
    ['Extrude', 'EXTRUDE', 'extrude'], ['Revolve', 'REVOLVE', 'revolve'], ['Sweep', 'SOLIDSWEEP', 'sweep'], ['Loft', 'SOLIDLOFT', 'loft'],
    ['Union', 'UNION', 'union'], ['Subtract', 'SUBTRACT', 'subtract'], ['Intersect', 'INTERSECT', 'intersect'],
    ['Slice', 'SLICE', 'slice'], ['Interfere', 'INTERFERE', 'interfere'],
    ['Push / Pull Face', 'PRESSPULL', 'presspull'], ['Fillet Edge', 'FILLETEDGE', 'filletedge'], ['Chamfer Edge', 'CHAMFEREDGE', 'chamferedge'], ['Taper Faces', 'TAPERFACES', 'chamfer'],
    ['Shell', 'SHELL', 'shellsolid'], ['Hole', 'HOLE', 'hole'], ['Imprint', 'IMPRINT', 'imprint'],
    ['Mass Properties', 'MASSPROP', 'massprop'],
  ]],
  ['Surface Create', [
    ['Planar', 'PLANARSURFACE', 'surfplanar'], ['Network', 'NETWORKSURFACE', 'surfnetwork'],
    ['Patch', 'PATCH', 'surfpatch'], ['Bridge G0–G2', 'BRIDGESURFACE', 'surfbridge'],
    ['Fill Boundary', 'FILLSURFACE', 'surffill'], ['Extrude', 'SURFACEEXTRUDE', 'surfextrude'],
    ['Revolve', 'SURFACEREVOLVE', 'surfrevolve'], ['Through Curves', 'THROUGHCURVES', 'surfthrough'], ['Swept', 'SURFACESWEEP', 'surfsweep'],
  ]],
  ['Surface Edit & Topology', [
    ['Extract Face', 'EXTRACTFACE', 'extractface'], ['Body Copy', 'EXTRACTBODY', 'bodycopy'],
    ['Unsew', 'UNSEW', 'unsew'], ['Delete Face · no heal', 'DELETEFACE', 'deleteface'],
    ['Sew', 'SEW', 'sew'], ['Check Body', 'CHECKBODY', 'checkbody'], ['Merge Faces', 'MERGEFACES', 'mergefaces'], ['Split Body', 'SPLITBODY', 'splitbody'],
    ['Trim Body', 'TRIMBODY', 'trimbody'], ['Trim by Face', 'TRIMSHEET', 'trimface'], ['Trim by Edge', 'SURFACETRIM', 'trimedge'], ['Untrim', 'UNTRIM', 'untrimface'],
    ['Extend edge · EX', 'EXTEND', 'extendsheet'], ['Trim & Extend · planar', 'TRIMEXTEND', 'trimextend'],
    ['Replace Face', 'REPLACEFACE', 'replaceface'], ['Divide Face', 'DIVIDEFACE', 'divideface'], ['Thicken', 'THICKEN', 'thickensheet'], ['Edit Parameters', 'EDITFEATURE', 'editfeature'],
  ]],
  ['Facet / Mesh', [
    ['Import STL', 'STLIN', 'stlimport'], ['Convert to facets', 'CONVERTMESH', 'tomesh'],
    ['Facet Boolean', 'FACETBOOLEAN', 'facetboolean'], ['Fill Hole', 'FILLHOLE', 'fillholemesh'],
    ['Split Facet', 'SPLITFACET', 'splitfacet'], ['Trim Facet', 'TRIMFACET', 'trimfacet'], ['Refine mesh', 'REMESH', 'remesh'],
    ['Merge coplanar facets', 'DECIMATE', 'decimatemesh'], ['Fit Plane', 'FITSURFACE', 'fitplane'],
  ]],
  ['UCS', [
    ['World', 'UCSWORLD', 'grid'], ['Previous', 'UCSPREV', 'undo'], ['3 Point', 'UCS3POINT', 'point'], ['Face', 'UCSFACE', 'ucsface'], ['View', 'UCSVIEW', 'ucsview'],
  ]],
  ['3D Modify', [
    ['3D Move', '3DMOVE', 'move3d'], ['3D Rotate', 'ROTATE3D', 'rotate3d'], ['3D Mirror', '3DMIRROR', 'mirror3d'], ['3D Array', '3DARRAY', 'array'], ['3D Orbit', '3DORBIT', 'orbit'],
  ]],
];

/** The docked palette. */
export class ModelingPalette {
  /** @param {object} app the application object */
  constructor(app) {
    this.app = app;
    this.open = new Set(['Solid', 'Surface Create', 'Surface Edit & Topology', 'Facet / Mesh']);
    this.root = document.createElement('div');
    this.root.id = 'mpalette';
    this.root.hidden = true;
    this.build();
  }

  /** Builds the groups. */
  build() {
    const head = document.createElement('div');
    head.className = 'mp-head';
    const title = document.createElement('b');
    title.textContent = 'Modeling';
    head.append(title);
    const pop = document.createElement('button');
    pop.textContent = '\u29C9';
    pop.title = 'Open as a separate window / dock it again';
    pop.onclick = () => this.setFloating(!this.root.classList.contains('float'));
    head.append(pop);
    this.dragHandle(head);
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = 'Close the palette (PALETTE)';
    x.onclick = () => this.toggle(false);
    head.append(x);
    this.root.append(head);
    MODELING_GROUPS.forEach(([title, tools]) => {
      const sec = document.createElement('div');
      sec.className = 'mp-sec';
      const h = document.createElement('div');
      h.className = 'mp-h';
      h.textContent = title;
      const grid = document.createElement('div');
      grid.className = 'mp-grid';
      const paint = () => {
        sec.classList.toggle('closed', !this.open.has(title));
      };
      h.onclick = () => {
        if (this.open.has(title)) this.open.delete(title);
        else this.open.add(title);
        paint();
      };
      tools.forEach(([label, cmd, icon]) => {
        const b = document.createElement('button');
        b.className = `mp-tool${cmd ? '' : ' off'}`;
        b.disabled = !cmd;
        b.title = cmd ? `${label} (${cmd})` : `${label}: not available in this version`;
        b.innerHTML = `${ICONS[icon] || ''}<span>${label}</span>`;
        b.onclick = () => {
          if (!cmd) this.app.echo(`${label} (${title}) is not available in this version.`);
          else this.app.exec(cmd);
        };
        grid.append(b);
      });
      sec.append(h, grid);
      paint();
      this.root.append(sec);
    });
  }

  /** Floating window or docked panel; the choice is remembered. */
  setFloating(on) {
    const row = document.querySelector('#centerrow');
    this.root.classList.toggle('float', on);
    if (on) document.body.append(this.root);
    else if (row) row.append(this.root);
    this.app.settings.paletteFloat = on;
    this.app.saveSettings();
    this.app.redraw();
  }

  /** The floating window is moved by its title bar. */
  dragHandle(head) {
    head.addEventListener('mousedown', (e) => {
      if (!this.root.classList.contains('float') || e.target.tagName === 'BUTTON') return;
      const r = this.root.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (m) => {
        this.root.style.left = `${Math.max(0, m.clientX - dx)}px`;
        this.root.style.top = `${Math.max(0, m.clientY - dy)}px`;
        this.root.style.right = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  /** Shows or hides the panel. */
  toggle(on) {
    this.root.hidden = on === undefined ? !this.root.hidden : !on;
    this.app.settings.palette = !this.root.hidden;
    this.app.saveSettings();
    this.app.redraw();
  }
}

/** Puts the palette next to the drawing and opens it in 3D views. */
export function initPalette(app) {
  const row = document.querySelector('#centerrow');
  if (!row) return;
  const palette = new ModelingPalette(app);
  app.palette = palette;
  row.append(palette.root);
  if (app.settings.paletteFloat) palette.setFloating(true);
  let wasThreeD = false;
  app.on('view3d', () => {
    const is3 = !!app.v3;
    if (is3 && !wasThreeD && app.settings.palette !== false) palette.root.hidden = false;
    if (!is3 && wasThreeD) palette.root.hidden = true;
    wasThreeD = is3;
  });
}

def('PALETTE MODELING', async (c) => {
  if (c.app.palette) c.app.palette.toggle();
});

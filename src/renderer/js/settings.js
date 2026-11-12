import { DialogHost } from './dialogs.js';
import { applyUiMode } from './uimode.js';
import { HAS_3D } from './features.js';
const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
export async function openSettings(app) {
  const root = node('div', 'preferences'), side = node('nav', 'preferences-nav'), content = node('div', 'preferences-content');
  root.append(side, content);
  const status = node('p', 'preferences-status', 'Changes are applied and saved immediately.');
  const s = app.settings;
  const commit = (key, value) => {
    s[key] = value;
    if (key === 'uiMode') s.uiModeChosen = true;
    if (key === 'lwt') app.doc.props.lwdisplay = value;
    if (key === 'palette') app.palette?.toggle(value);
    if (key === 'paletteFloat') app.palette?.setFloating(value);
    app.saveSettings(); app.emit('settings'); applyUiMode(app); app.redraw();
    status.textContent = 'Saved. Changes are applied immediately.';
  };
  const row = (label, input, help) => {
    const e = node('label', 'preference-row'), text = node('span');
    text.append(node('b', '', label)); if (help) text.append(node('small', '', help));
    e.append(text, input); return e;
  };
  const select = (key, label, values, help) => {
    const input = node('select'); input.name = key;
    for (const [value, text] of values) { const o = node('option', '', text); o.value = value; input.append(o); }
    input.value = s[key]; input.onchange = () => commit(key, input.value); return row(label, input, help);
  };
  const checkbox = (key, label, help) => {
    const input = node('input'); input.type = 'checkbox'; input.name = key; input.checked = !!s[key];
    input.onchange = () => commit(key, input.checked); return row(label, input, help);
  };
  const number = (key, label, min, max, fallback, help) => {
    const input = node('input'); input.type = 'number'; input.name = key; input.step = 'any'; input.min = min; input.max = max; input.value = s[key] ?? fallback;
    input.onchange = () => {
      const n = Number(input.value);
      if (!input.value || !Number.isFinite(n) || n < min || n > max) { input.setAttribute('aria-invalid', 'true'); status.textContent = `${label}: enter a number from ${min} to ${max}.`; return; }
      input.removeAttribute('aria-invalid'); commit(key, n);
    }; return row(label, input, help);
  };
  let nextCommand;
  const link = (label, cmd) => { const b = node('button', 'preference-link', label+' →'); b.onclick = () => { nextCommand = cmd; root.closest('.dlg').querySelector('.df .primary').click(); }; return b; };
  const pages = [
    ['Appearance', () => [select('theme', 'Colour theme', [['system','Follow macOS'],['light','Light · 밝은 모드'],['dark','Dark · 다크 모드']], 'Applies to windows, settings, menus and palettes.'),
      select('uiMode','Interface mode',[['beginner','Beginner · 초보자'],['advanced','Advanced · 고급']], 'Beginner: larger labeled tools and guidance. Advanced: compact toolbars.'),
      checkbox('whiteBg','White drawing canvas','The drawing background is independent of the interface theme.'), checkbox('paperBg','White layout paper'), checkbox('ucsIcon','Show UCS icon')]],
    ['Drafting', () => [checkbox('grid','Show grid'), select('gridStyle','Grid style',[['lines','Lines'],['dots','Dots']]), number('gridSpacing','Grid spacing',0.001,1e6,10),number('gridMajor','Major line interval',1,100,5),checkbox('snap','Snap to grid'),number('snapSpacing','Snap spacing',0.001,1e6,10),checkbox('ortho','Orthogonal drawing'),checkbox('polar','Polar tracking'),number('polarInc','Polar angle',1,180,90),checkbox('osnap','Object snapping'),checkbox('otrack','Object snap tracking'),checkbox('dyn','Dynamic input'),link('Object snap modes and detailed drafting settings','DSETTINGS')]],
    ...(HAS_3D ? [['Modeling', () => [checkbox('palette','Show Modeling palette'),checkbox('paletteFloat','Floating Modeling palette'),number('modelingTolerance','Sewing tolerance',1e-8,1,1e-6,'In drawing units. Large tolerances may join unintended edges.'),checkbox('keepModelingInputs','Keep original bodies','Retain source bodies for surface and mesh operations.'),checkbox('selectionPreview3d','Preview 3D faces and edges','Highlights the face and nearest edge under the pointer.'),checkbox('faceUcs','Show UCS on hovered face','Shows the face plane and local X/Y/Z directions before selection.'),number('selectionAperture3d','3D edge selection range (px)',6,40,14,'Larger values make narrow and curved edges easier to select.'),checkbox('studioEdges','Show edges in Studio'),checkbox('floorReflect','Floor reflections'),link('Visual style','VSCURRENT'),link('Studio appearance','STUDIO')]]] : []),
    ['Input & selection', () => [number('crosshair','Crosshair size (%)',1,100,100),number('pickbox','Pickbox size (px)',1,20,4),number('aperture','Snap aperture (px)',3,50,10,'3D midpoints use a slightly wider capture range.'),checkbox('grips','Enable selection grips'),checkbox('lwt','Display lineweights'),checkbox('zoomWheelReverse','Reverse scroll-wheel zoom'),link('Command aliases','ALIASEDIT')]],
    ['Files & extensions', () => [link('Drawing units','UNITS'),link('Toolbars','TOOLBAR'),link('Load AutoLISP application','APPLOAD'),link('Optional AI setup (download separately)','AISETTINGS'),link('Subscription and licence','LICENSE')]],
  ];
  const show = (index) => {
    content.replaceChildren(node('h2','',pages[index][0]), ...pages[index][1](), status);
    [...side.children].forEach((b,i) => b.setAttribute('aria-pressed',String(i===index)));
  };
  pages.forEach(([title],i) => { const b=node('button','',title); b.onclick=()=>show(i); side.append(b); }); show(0);
  await DialogHost.show({ title:'Settings', body:root, width:760, buttons:[{label:'Done',value:true,primary:true}] });
  if (nextCommand) setTimeout(()=>app.exec(nextCommand),0);
}

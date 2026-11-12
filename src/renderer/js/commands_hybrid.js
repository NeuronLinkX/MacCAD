import {def as registerCommand,alias as registryAlias,CmdError,CANCEL} from './registry.js';
import * as K from './kernel3d.js';
import * as H from './hybrid3d.js';
import * as M from './mesh3d.js';
import * as E from './entities.js';
import * as G from './geom.js';
import {Doc} from './doc.js';
import {Solid3dCommands as S} from './commands_3d.js';
import * as CV from './curve3d.js';
import {api} from './apibridge.js';
/** Modeling mistakes (a missing crossing, an open boundary) are shown as a plain message; opaque kernel failures get a readable one. */
const guarded=fn=>async c=>{
 try{return await fn(c);}
 catch(e){
  if(e===CANCEL||e instanceof CmdError)throw e;
  const msg=typeof e?.message==='string'&&e.message&&e.message!=='Exception'?e.message:'The 3D kernel could not complete this operation with the selected geometry. Nothing was changed.';
  throw new CmdError(msg);
 }
};
const def=(names,fn,opts={})=>registerCommand(names,guarded(fn),{...opts,feature:'3d'});
const body=e=>e.type==='solid3d', tol=c=>c.app.settings.modelingTolerance??1e-6;
async function ready(c){await K.initKernel();if(!c.app.v3)c.app.enter3D('swiso');}
async function face(c,prompt){await ready(c);return c.app.request('face',prompt);}
const trimCurve=e=>e.type==='line'||e.type==='pline';
/** One request that takes a face of a sheet/solid, a solid edge, or a drawn line / arc / polyline / circle. */
const anyHit=(c,prompt,extra={})=>c.app.request('edge',prompt,{mode:'edge',curves:CV.isCurve,faces:true,...extra});
/** A click on the edge of a sheet means the sheet; a click on a drawn curve stays a curve. */
function faceOrCurve(hit){
 if(!hit||typeof hit==='string'||hit.curve||hit.face)return hit;
 if(hit.edge){
  const faces=K.baseShape(hit.e).shape.faces,own=faces.filter(f=>f.edges.some(ed=>ed.hashCode===hit.edge.id));
  if(faces.length===1)return{e:hit.e,face:{faceId:faces[0].hashCode}};
  if(own.length===1)return{e:hit.e,face:{faceId:own[0].hashCode}};
  throw new Error('That edge belongs to two faces. Click inside the face you mean, or click a drawn line.');
 }
 return hit;
}
/**
 * Asks for the cutting surface: a face of a sheet or solid (extended until it passes through the
 * targets), a drawn line/curve (swept through the targets along its plane normal), or a plane.
 * @returns {Promise<{shape: object, params: object, source: object|null}|null>}
 */
async function pickCutter(c,targets,prompt='Select the cutting surface: a sheet or solid face, or a drawn line / curve [Plane]'){
 await ready(c);
 let hit;
 for(;;){
  const raw=await anyHit(c,prompt,{kw:['Plane']});
  if(!raw)return null;
  try{hit=faceOrCurve(raw);break;}catch(error){c.echo(error.message);}
 }
 if(hit==='Plane'){
  const mode=await S.planeKeyword(c,targets,'Cutting plane [XY/YZ/ZX/3points] <XY>',['XY','YZ','ZX','3points'],'XY');if(!mode)return null;
  const plane=await S.planeFromKeyword(c,mode);if(!plane)return null;
  return{shape:H.planeSheet(targets.map(K.bakedShape),plane.o,plane.n),params:{tool:'plane',...plane},source:null};
 }
 return{shape:CV.cutterFromPick(hit,c.doc,targets),params:{tool:hit.curve?'curve':'face',toolId:hit.e.id,...(hit.face?{toolFaceId:hit.face.faceId}:{})},source:hit.e,hit};
}
/** After a cut: lets the user click the unwanted part(s); Enter keeps everything that is left. */
async function chooseRemoval(c,made){
 let left=[...made];if(left.length<2)return;
 c.echo(`Divided into ${left.length} parts. Click a part to delete it; Enter keeps the rest.`);
 try{
  while(left.length>1){
   const r=await c.app.request('face','Click the part to delete (Enter = keep all that is left)',{solids:left});
   if(!r)break;
   if(!left.includes(r.e)){c.echo('Click one of the parts that were just made.');continue;}
   c.erase([r.e]);left=left.filter(e=>e!==r.e);c.app.sel=new Set(left.map(e=>e.id));c.app.changed();
  }
 }finally{c.app.faceHl=[];c.app.redraw();}
}
/** Cuts bodies with a sheet and lets the user delete the parts they do not want. */
async function trimBodies(c,targets,cutter,op='TRIMBODY'){
 const {parts,untouched}=CV.splitBodies(targets,cutter.shape);
 if(!parts.length)throw new Error('The cutting surface does not pass through the body. Move it across the body, or use a drawn line that crosses it.');
 if(untouched.length)c.echo(`${untouched.length} body/bodies were not crossed by the cutting surface and stay as they are.`);
 const sources=[...new Set(parts.map(p=>p.source))];
 const made=results(c,sources,parts.map(p=>p.shape),op,{...cutter.params,preserveOffcuts:true},{eraseInputs:true});
 await chooseRemoval(c,made);
 return made;
}

/** Local 2D entity point -> model-space XYZ, including a saved side/face drawing plane. */
export function entityWorldPoint(e,p){
 if(!e?.plane)return[p.x,p.y,p.z||0];
 const {o,x,y,n}=e.plane,z=p.z||0;
 return[o[0]+x[0]*p.x+y[0]*p.y+n[0]*z,o[1]+x[1]*p.x+y[1]*p.y+n[1]*z,o[2]+x[2]*p.x+y[2]*p.y+n[2]*z];
}
function entityLocalPoint(e,p){
 if(!e?.plane)return{x:p.x,y:p.y,z:p.z||0};
 const {o,x,y,n}=e.plane,d=[p.x-o[0],p.y-o[1],(p.z||0)-o[2]];
 return{x:d[0]*x[0]+d[1]*x[1]+d[2]*x[2],y:d[0]*y[0]+d[1]*y[1]+d[2]*y[2],z:d[0]*n[0]+d[1]*n[1]+d[2]*n[2]};
}
/** Turns a selected solid edge, LINE, polyline segment or snapped two-point cutter into a kernel edge. */
export function trimReferenceEdge(ref,doc){
 if(ref?.edge)return H.edgeOf(ref.e,ref.edge.id);
 if(ref?.points)return K.lib().makeLine(ref.points[0],ref.points[1]);
 if(!ref?.curve)throw new Error('Select a cutting LINE, polyline segment or solid edge.');
 if(ref.curve.type==='line')return K.lib().makeLine(entityWorldPoint(ref.e,ref.curve.p1),entityWorldPoint(ref.e,ref.curve.p2));
 if(ref.curve.type==='pline'){
  const pick=ref.p?entityLocalPoint(ref.e,ref.p):ref.curve.pts[0];
  const segments=E.prims(ref.curve,doc).filter(p=>p.k==='s');
  if(!segments.length)throw new Error('Select a straight polyline segment as the cutting boundary.');
  const segment=segments.reduce((best,p)=>!best||G.nearestOnPrim(p,pick).d<G.nearestOnPrim(best,pick).d?p:best,null);
  return K.lib().makeLine(entityWorldPoint(ref.e,segment.a),entityWorldPoint(ref.e,segment.b));
 }
 throw new Error('Select a cutting LINE, polyline segment or solid edge.');
}
async function trimReference(c){
 const ref=await c.app.request('edge','1/2 Select cutting LINE, polyline segment or solid edge [2Points]',{mode:'edge',curves:trimCurve,kw:['2Points']});
 if(ref!=='2Points')return ref;
 const p1=await c.point('Specify first cutting point',{world3d:true,noOrtho:true});if(!p1)return null;
 const p2=await c.point('Specify second cutting point',{base:p1,world3d:true,noOrtho:true});if(!p2)return null;
 if(Math.hypot(p2.x-p1.x,p2.y-p1.y,(p2.z||0)-(p1.z||0))<=tol(c))throw new Error('The two cutting points must be different.');
 return{points:[[p1.x,p1.y,p1.z||0],[p2.x,p2.y,p2.z||0]]};
}
function results(c,inputs,shapes,op,parameters={},options={}){
  // Build and validate every output before modifying the document, so failure is atomic.
  const editable = ['THICKEN','SEW','PATCH'].includes(op);
  const feature = {id:crypto.randomUUID(),operation:op,parameters,sourceIds:inputs.map(e=>e.id),
    ...(editable?{inputs:inputs.map(e=>({brep:K.bakedShape(e).serialize()}))}:{})};
  shapes.forEach(H.check);
  const made=shapes.map(shape=>{
    const e=S.solidEntity(c,shape,inputs[0]);e.bodyKind=options.mesh?'mesh':H.kind(shape);
    e.feature=feature;return e;
  });
  if(options.eraseInputs||(!options.copy&&!c.app.settings.keepModelingInputs))c.erase([...new Set(inputs)]);
  c.addAll(made);c.app.sel=new Set(made.map(e=>e.id));c.app.changed();
  c.echo(`${op}: ${made.length} ${options.mesh?'facet':made[0]?.bodyKind||'sheet'} body/bodies. Input parameters are stored with the result.${parameters.preserveOffcuts?' All cut parts were kept.':''}`);return made;
}
/** Keeps every cut fragment while putting the fragment nearest the user's pick first. */
export function cutPartsNearestFirst(parts,p){
 const v=K.lib().makeVertex([p.x,p.y,p.z||0]);
 try{return [...parts].sort((a,b)=>K.lib().measureDistanceBetween(a,v)-K.lib().measureDistanceBetween(b,v));}
 finally{v.delete();}
}
/** Keeps every solid fragment while putting fragments on the user's chosen plane side first. */
export function cutPartsSelectedSideFirst(parts,plane,p){
 const signed=q=>q.reduce((s,x,i)=>s+(x-plane.o[i])*plane.n[i],0),side=signed([p.x,p.y,p.z||0]);
 if(Math.abs(side)<1e-9)throw new Error('Choose a point away from the cutting plane.');
 const ranked=parts.map((shape,index)=>{const props=K.lib().measureShapeVolumeProperties(shape);try{return{shape,index,score:signed(props.centerOfMass)*side};}finally{props.delete();}});
 return ranked.sort((a,b)=>b.score-a.score||a.index-b.index).map(x=>x.shape);
}
async function pickedFaces(c){
  const picks=[];await ready(c);c.echo('Click faces; Enter finishes. Click a selected face again to remove it.');
  try{for(;;){const r=await c.app.request('face','Select face(s), then Enter');if(!r)break;const i=picks.findIndex(p=>p.e===r.e&&p.face.faceId===r.face.faceId);if(i<0)picks.push(r);else picks.splice(i,1);c.app.faceHl=picks;c.app.redraw();}}
  finally{c.app.faceHl=[];c.app.redraw();}return picks;
}
/** Display points of a drawn curve in model space, for the orange highlight. */
function curvePts(e,doc){
 const out=[];
 for(const p of E.prims(e,doc)){
  if(p.k==='s'){out.push(CV.worldPoint(e,p.a),CV.worldPoint(e,p.b));continue;}
  let span=(p.a1-p.a0)%(Math.PI*2);if(span<=0)span+=Math.PI*2;
  for(let i=0;i<=32;i++){const a=p.a0+span*i/32;out.push(CV.worldPoint(e,{x:p.c.x+Math.cos(a)*p.r,y:p.c.y+Math.sin(a)*p.r}));}
 }
 return out;
}
const hitPts=(c,p)=>p.curve?curvePts(p.curve,c.doc):p.edge.pts;
/** Kernel edges (a drawn polyline gives several) of one pick. */
function pickEdges(c,p){return p.curve?CV.curveEdges(p.curve,c.doc):[H.edgeOf(p.e,p.edge.id)];}
const sameHit=(a,b)=>a.e===b.e&&(a.curve?!!b.curve:a.edge.id===b.edge?.id);
async function pickedEdges(c,prompt='Select boundary edges or drawn curves; Enter finishes'){
 const picks=[];await ready(c);c.echo('Click boundary edges or drawn lines/curves; Enter finishes. Click a selected one again to remove it.');
 try{for(;;){const r=await c.app.request('edge',prompt,{mode:'edge',curves:CV.isCurve});if(!r||(!r.edge&&!r.curve))break;const i=picks.findIndex(p=>sameHit(p,r));if(i<0)picks.push(r);else picks.splice(i,1);c.app.edgeHl=picks.map(p=>({pts:hitPts(c,p)}));c.app.redraw();}}
 finally{c.app.edgeHl=[];c.app.redraw();}return picks;
}
/** One wire (edge or drawn curve) from a pick. */
function pickWire(c,hit){return hit.curve?CV.curveWire(hit.curve,c.doc):K.lib().assembleWire([H.edgeOf(hit.e,hit.edge.id)]);}
/** A closed profile face from a pick: a face, or a closed drawn shape. */
function pickProfileFace(c,hit){
 if(hit.face)return H.faceOf(hit.e,hit.face.faceId);
 if(hit.curve){const f=CV.curveFace(hit.curve,c.doc);if(!f)throw new Error('The drawn shape is not closed. Close it first.');return f;}
 throw new Error('Pick a closed drawn shape or a face as the profile.');
}
const curveOrEdge=(c,prompt,extra)=>c.app.request('edge',prompt,{mode:'edge',curves:CV.isCurve,...extra});
for(const command of ['UNSEW','DELETEFACE','EXTRACTFACE'])def(command,async c=>{
  const picks=await pickedFaces(c);if(!picks.length)return;
  if(command==='DELETEFACE')c.echo('Delete Face: Heal is OFF. Remaining faces become an open sheet; automatic healing is not supported.');
  const entities=[...new Set(picks.map(p=>p.e))],outputs=[];
  for(const e of entities){const ids=picks.filter(p=>p.e===e).map(p=>p.face.faceId);const r=H.unsew(e,ids,tol(c));
    if(command!=='EXTRACTFACE'&&r.remainder)outputs.push(r.remainder);if(command!=='DELETEFACE')outputs.push(...r.detached);}
  results(c,entities,outputs,command,{tolerance:tol(c),heal:false},{copy:command==='EXTRACTFACE'});
});
def('EXTRACTBODY',async c=>{await ready(c);const ents=await c.select('Select bodies to copy',{filter:body});if(ents.length)results(c,ents,ents.map(e=>K.bakedShape(e).clone()),'EXTRACTBODY',{}, {copy:true});});
for(const command of ['SEW','PATCH'])def(command,async c=>{
 await ready(c);const ents=await c.select('Select sheets/faces to join',{filter:body});if(!ents.length)return;
 const tolerance=await c.number('Sewing tolerance',{def:tol(c)});if(tolerance==null)return;
 const shapes=ents.map(K.bakedShape);let out,freeEdges=0,resultKind;
 if(command==='PATCH'){out=H.patch(shapes,tolerance);resultKind=H.kind(out);}
 else{const sewn=H.sew(shapes,tolerance);out=sewn.shape;freeEdges=sewn.freeEdges;resultKind=sewn.kind;}
 results(c,ents,[out],command,{tolerance,freeEdges,resultKind});
 if(command==='SEW'&&resultKind!=='solid')c.echo(`SEW is still an open sheet (${freeEdges} free boundary edge(s)). UNION/SUBTRACT/INTERSECT require 0. Fill the missing boundary, then run PATCH or SEW again.`);
 else c.echo(`${command}: watertight solid confirmed; Boolean operations are available.`);
});
def('CHECKBODY BODYCHECK CHECKSOLID',async c=>{
 await ready(c);const ents=await c.select('Select 3D bodies to check',{filter:body});if(!ents.length)return;
 for(const e of ents){
  const status=H.topologyStatus(K.bakedShape(e),tol(c)),label=`Body ${e.id}`;
  if(status.booleanReady)c.echo(`${label}: watertight solid, ${status.faces} face(s), ${status.solids} solid(s), volume ${c.fmt(status.volume)}. UNION/SUBTRACT/INTERSECT ready.`);
  else c.echo(`${label}: open sheet, ${status.faces} face(s), ${status.freeEdges} free boundary edge(s), ${status.multipleEdges} non-manifold edge(s). Fill the missing boundary and use SEW or PATCH.`);
 }
});
def('MERGEFACES UNIFYFACES REMOVESEAM',async c=>{
 await ready(c);const ents=await c.select('Select united solid or sheet bodies with coplanar face seams',{filter:e=>body(e)&&e.bodyKind!=='mesh'});if(!ents.length)return;
 const inputs=[],outputs=[];let removedFaces=0,removedEdges=0;
 for(const e of ents){const before=K.bakedShape(e),after=H.unifyFaces(before),df=before.faces.length-after.faces.length,de=before.edges.length-after.edges.length;
  if(df>0||de>0){inputs.push(e);outputs.push(after);removedFaces+=Math.max(0,df);removedEdges+=Math.max(0,de);}else after.delete();}
 if(!outputs.length)throw new Error('No coplanar or same-surface face seams were found. Unite touching solids first, or check that the faces lie on the same plane.');
 results(c,inputs,outputs,'MERGEFACES',{method:'same-domain',removedFaces,removedEdges});
 c.echo(`Merge Faces: removed ${removedFaces} redundant face(s) and ${removedEdges} seam edge(s).`);
});
def('THICKEN',async c=>{await ready(c);const ents=await c.select('Select sheet(s) to thicken',{filter:body});if(!ents.length)return;const t=await c.number('Thickness (negative reverses side)',{def:1});if(t==null)return;results(c,ents,ents.map(e=>H.thicken(K.bakedShape(e),t)),'THICKEN',{thickness:t});});
def('PRESSPULL PUSHPULL PP MOVEFACE OFFSETFACE',async c=>{
 await ready(c);
 const hit=await c.app.request('face','Select a planar solid face to push or pull');if(!hit)return;
 const input=K.bakedShape(hit.e);if(H.kind(input)!=='solid')throw new Error('PRESSPULL requires a closed solid body.');
 const selected=H.faceOf(hit.e,hit.face.faceId);if(selected.geomType!=='PLANE')throw new Error('PRESSPULL currently supports planar solid faces.');
 const centerVector=selected.center,center=centerVector.toTuple();centerVector.delete();
 const normalVector=selected.normalAt(center),rawNormal=normalVector.toTuple();normalVector.delete();
 const normalLength=Math.hypot(...rawNormal);if(!(normalLength>1e-12))throw new Error('The selected face has no usable normal direction.');
 const normal=rawNormal.map(value=>value/normalLength),base={x:center[0],y:center[1],z:center[2]};
 c.app.faceHl=[hit];c.app.redraw();
 let distance;
 try{
  distance=await c.dist('Drag the face outward/inward or enter distance (+ outward, - inward)',{
   base,direction3d:normal,noOrtho:true,noSnap:true,rubber:false,def:c.app.pressPullDistance??10,
   preview:d=>Math.abs(d)>tol(c)?S.safely(()=>[S.tempEntity(H.pressPullFace(input,selected,d,tol(c)))],[]):[],
  });
 }finally{c.app.faceHl=[];c.app.redraw();}
 if(distance==null)return;if(!(Math.abs(distance)>tol(c)))throw new Error('Pull distance must be non-zero.');
 const output=H.pressPullFace(input,selected,distance,tol(c));c.app.pressPullDistance=distance;
 results(c,[hit.e],[output],'PRESSPULL',{faceId:hit.face.faceId,distance,direction:normal,mode:distance>0?'add':'remove'},{eraseInputs:true});
});
def('SHELL HOLLOW',async c=>{
 const picks=await pickedFaces(c);if(!picks.length)return;const entities=[...new Set(picks.map(p=>p.e))];
 if(entities.length!==1)throw new Error('Select opening faces from one solid body.');
 const input=K.bakedShape(entities[0]);if(H.kind(input)!=='solid')throw new Error('SHELL requires a closed solid body.');
 const thickness=await c.number('Wall thickness (positive, inward)',{def:c.app.shellThickness??1});if(thickness==null)return;c.app.shellThickness=thickness;
 const faces=picks.map(p=>H.faceOf(p.e,p.face.faceId));
 results(c,entities,[H.shellSolid(input,faces,thickness,tol(c))],'SHELL',{faceIds:picks.map(p=>p.face.faceId),thickness},{eraseInputs:true});
});
def('HOLE',async c=>{
 const hit=await face(c,'Select planar face for hole');if(!hit)return;const input=K.bakedShape(hit.e),selected=H.faceOf(hit.e,hit.face.faceId);
 if(H.kind(input)!=='solid')throw new Error('HOLE requires a closed solid body.');if(selected.geomType!=='PLANE')throw new Error('HOLE currently requires a planar placement face.');
 const cp=selected.center,np=selected.normalAt(),center=cp.toTuple(),normal=np.toTuple();cp.delete();np.delete();
 const point=await c.point('Specify hole center',{workPlane:{o:center,n:normal},world3d:true,noOrtho:true});if(!point)return;
 const diameter=await c.number('Hole diameter',{def:c.app.holeDiameter??10});if(diameter==null)return;
 const depth=await c.number('Hole depth <0 = Through all>',{def:c.app.holeDepth??0});if(depth==null)return;c.app.holeDiameter=diameter;c.app.holeDepth=depth;
 const output=H.hole(input,selected,[point.x,point.y,point.z||0],diameter,depth,tol(c));
 results(c,[hit.e],[output],'HOLE',{faceId:hit.face.faceId,center:[point.x,point.y,point.z||0],diameter,depth:depth||'through'},{eraseInputs:true});
});
def('IMPRINT',async c=>{
 await ready(c);const targets=await c.select('Select one target solid',{filter:body,pre:false});if(targets.length!==1)throw new Error('Select exactly one target solid.');
 const tool=await face(c,'Select imprinting sheet or face');if(!tool||tool.e===targets[0])return;
 const output=H.imprint(K.bakedShape(targets[0]),H.faceOf(tool.e,tool.face.faceId));
 results(c,targets,[output],'IMPRINT',{toolId:tool.e.id,toolFaceId:tool.face.faceId},{copy:true});
});
def('SECTION SECTIONPLANE SEC',async c=>{
 await ready(c);const ents=await c.select('Select solid bodies to section',{filter:body});if(!ents.length)return;
 const mode=await S.planeKeyword(c,ents,'Section plane [XY/YZ/ZX/3points] <XY>',['XY','YZ','ZX','3points'],'XY');if(!mode)return;const plane=await S.planeFromKeyword(c,mode);if(!plane)return;
 const made=[];for(const entity of ents){const section=H.sectionEdges(K.bakedShape(entity),plane.o,plane.n),toLocal=p=>{const d=p.map((v,i)=>v-section.plane.o[i]);return{x:d.reduce((s,v,i)=>s+v*section.plane.x[i],0),y:d.reduce((s,v,i)=>s+v*section.plane.y[i],0),b:0};};
  for(const edge of section.edges){const count=edge.geomType==='LINE'?2:33,pts=Array.from({length:count},(_,i)=>{const p=edge.pointAt(i/(count-1)),tuple=p.toTuple();p.delete();return toLocal(tuple);});made.push(c.stamp(E.mk(pts.length===2?'line':'pline',pts.length===2?{p1:pts[0],p2:pts[1],plane:section.plane}:{pts,closed:false,plane:section.plane})));edge.delete();}}
 c.addAll(made);c.app.sel=new Set(made.map(e=>e.id));c.app.changed();c.echo(`SECTION: ${made.length} exact section curve(s) created on the cutting plane.`);
});
def('SPLITBODY',async c=>{
 await ready(c);const ents=await c.select('Select target solid(s)',{filter:e=>body(e)&&e.bodyKind!=='sheet'});if(!ents.length)return;
 const mode=await S.planeKeyword(c,ents,'Cutting tool [XY/YZ/ZX/3points/Sheet] <XY>',['XY','YZ','ZX','3points','Sheet'],'XY');if(!mode)return;
 let shapes,params={tool:mode};
 if(mode==='Sheet'){
  const cutter=await pickCutter(c,ents,'Select the cutting sheet face or a drawn line / curve');if(!cutter)return;
  const r=CV.splitBodies(ents,cutter.shape);if(!r.parts.length)throw new Error('The cutting surface does not pass through the body.');
  shapes=r.parts.map(x=>x.shape);params={...params,...cutter.params};
 }else{const plane=await S.planeFromKeyword(c,mode);if(!plane)return;shapes=ents.flatMap(e=>H.splitPlane(K.bakedShape(e),plane.o,plane.n));params={...params,...plane};if(shapes.length<=ents.length)throw new Error('The plane did not divide the selected bodies.');}
 results(c,ents,shapes,'SPLITBODY',params);
});
def('TRIMBODY TRIMSOLID SOLIDTRIM',async c=>{
 await ready(c);const ents=await c.select('Select the solid body(ies) to trim',{filter:e=>body(e)&&e.bodyKind!=='sheet'&&e.bodyKind!=='mesh'});if(!ents.length)return;
 const cutter=await pickCutter(c,ents);if(!cutter)return;
 await trimBodies(c,ents,cutter,'TRIMBODY');
});
def('BRIDGESURFACE',async c=>{
 await ready(c);const a=await curveOrEdge(c,'Select first boundary edge or drawn curve');if(!a||(!a.edge&&!a.curve))return;const b=await curveOrEdge(c,'Select second boundary edge or drawn curve');if(!b||(!b.edge&&!b.curve))return;
 if(sameHit(a,b))throw new Error('Choose two different edges.');
 const drawn=!!(a.curve||b.curve);
 const continuity=drawn?'G0':await c.keyword('Boundary continuity [G0/G1/G2] <G0> (G3 unavailable)',['G0','G1','G2'],'G0');if(!continuity)return;
 const support=r=>{const faces=K.baseShape(r.e).shape.faces.filter(f=>f.edges.some(e=>e.hashCode===r.edge.id));if(faces.length!==1)throw new Error('For G1/G2 use an open sheet edge with exactly one supporting face.');return H.faceOf(r.e,faces[0].hashCode);};
 const wa=pickWire(c,a),wb=pickWire(c,b);
 let shape;
 if(drawn||continuity==='G0')shape=H.throughCurves([wa,wb],true);
 else shape=H.bridge(H.edgeOf(a.e,a.edge.id),H.edgeOf(b.e,b.edge.id),support(a),support(b),continuity);
 results(c,[a.e,b.e],[shape],'BRIDGESURFACE',{continuity},{copy:true});
});
def('FILLSURFACE TRANSITIONFACE NSIDEDSURFACE',async c=>{
 const picks=await pickedEdges(c,'Pick the boundary edges or drawn curves of a closed loop; Enter to create the face');
 const edges=picks.flatMap(p=>pickEdges(c,p)),sources=[...new Set(picks.map(p=>p.e))];
 if(edges.length<3&&!(edges.length===1&&edges[0].geomType==='CIRCLE'))throw new Error('Select a closed boundary: at least three connected edges, or one closed shape.');
 results(c,sources,[H.fillBoundary(edges)],'FILLSURFACE',{continuity:'G0',edgeCount:edges.length},{copy:true});
});
async function extendSelectedEdge(c){
 await ready(c);
 const hit=await c.app.request('edge','Select the sheet boundary edge to extend',{mode:'edge'});if(!hit?.edge)return;
 const baseShape=K.baseShape(hit.e).shape;
 if(baseShape.faces.length!==1)throw new Error('EXTEND works on one sheet face at a time. Use Unsew or Extract Face first, then select its boundary edge.');
 const sourceFace=baseShape.faces[0];
 if(!sourceFace.edges.some(edge=>edge.hashCode===hit.edge.id))throw new Error('The selected edge is not a boundary of this face.');
 const input=H.faceOf(hit.e,sourceFace.hashCode),edge=H.edgeOf(hit.e,hit.edge.id),frame=H.extensionFrame(input,edge);
 const base={x:frame.base[0],y:frame.base[1],z:frame.base[2]},workPlane={o:frame.base,n:frame.normal};
 c.app.edgeHl=[{pts:hit.edge.pts}];c.app.redraw();
 let distance;
 try{
  distance=await c.dist('Drag outward or enter the surface extension distance',{
   base,workPlane,direction3d:frame.direction,noOrtho:true,noSnap:true,rubber:false,
   preview:d=>d>tol(c)?S.safely(()=>[S.tempEntity(H.extendSurfaceEdge(input,edge,d,tol(c)))],[]):[],
  });
 }finally{c.app.edgeHl=[];c.app.redraw();}
 if(distance==null)return;
 if(!(distance>tol(c)))throw new Error('Move outward from the selected edge or enter a positive extension distance.');
 const output=H.extendSurfaceEdge(input,edge,distance,tol(c));
 results(c,[hit.e],[output],'EXTEND',{edgeId:hit.edge.id,distance,surfaceType:frame.surfaceType,workflow:'edge-drag'});
}
def('EXTENDSHEET',extendSelectedEdge);
def('SURFACEEXTEND',extendSelectedEdge);
for(const command of ['TRIMSHEET','DIVIDEFACE'])def(command,async c=>{
 const target=await face(c,'Select the face to trim or divide');if(!target)return;
 const cutter=await pickCutter(c,[target.e],'Select the cutting face, or a drawn line / curve [Plane]');if(!cutter)return;
 const input=H.faceOf(target.e,target.face.faceId),parts=H.split(input,cutter.shape);
 const made=results(c,[target.e],parts,command,{...cutter.params,preserveOffcuts:true},{copy:H.kind(K.bakedShape(target.e))==='solid'});
 made.forEach(e=>e.untrimBrep=input.serialize());
 if(command==='TRIMSHEET')await chooseRemoval(c,made);
});
def('TRIMBYEDGE TRIMCURVE',async c=>{
 const target=await face(c,'Select planar sheet face to trim');if(!target)return;
 const input=H.faceOf(target.e,target.face.faceId);if(input.geomType!=='PLANE')throw new Error('Trim by Edge currently requires a planar target face.');
 c.app.faceHl=[target];c.app.redraw();
 let ref;
 try{ref=await trimReference(c);}finally{c.app.faceHl=[];c.app.redraw();}
 if(!ref?.edge&&!ref?.curve&&!ref?.points)return;
 const reference=trimReferenceEdge(ref,c.doc);
 let parts;try{parts=H.splitFaceByEdge(input,reference);}finally{reference.delete();}
 const made=results(c,[target.e],parts,'TRIMBYEDGE',{referenceId:ref.e?.id||null,edgeId:ref.edge?.id||null,preserveOffcuts:true},{copy:H.kind(K.bakedShape(target.e))==='solid'});
 made.forEach(e=>e.untrimBrep=input.serialize());
 await chooseRemoval(c,made);
});
def('SURFACETRIM',async c=>{
 await ready(c);const ref=await trimReference(c);if(!ref?.edge&&!ref?.curve&&!ref?.points)return;
 const target=await face(c,'2/2 Select planar face/area to trim');if(!target)return;
 const input=H.faceOf(target.e,target.face.faceId);if(input.geomType!=='PLANE')throw new Error('TRIM currently requires a planar target face.');
 const reference=trimReferenceEdge(ref,c.doc);
 let parts;try{parts=H.splitFaceByEdge(input,reference);}finally{reference.delete();}
 const made=results(c,[target.e],parts,'TRIM',{boundaryId:ref.e?.id||null,edgeId:ref.edge?.id||null,workflow:'2D-style',preserveOffcuts:true},{copy:H.kind(K.bakedShape(target.e))==='solid'});
 made.forEach(e=>e.untrimBrep=input.serialize());
 await chooseRemoval(c,made);
});
def('UNTRIM',async c=>{await ready(c);const selected=await c.select('Select a sheet made by Trim/Divide Face',{filter:e=>body(e)&&!!e.untrimBrep});if(!selected.length)return;
 const seen=new Set(),inputs=[],shapes=[];
 for(const e of selected){const key=e.feature?.id||e.id;if(seen.has(key))continue;seen.add(key);const group=e.feature?.id?c.app.doc.model.filter(x=>x.feature?.id===key&&x.untrimBrep):[e];inputs.push(...group);shapes.push(K.lib().deserializeShape(e.untrimBrep));}
 results(c,inputs,shapes,'UNTRIM',{}, {eraseInputs:true});
});
def('REPLACEFACE',async c=>{
 const old=await face(c,'Select the face to replace');if(!old)return;const replacement=await face(c,'Select the replacement face (a sheet or any other face)');if(!replacement)return;
 const input=K.bakedShape(old.e);
 if(H.kind(input)==='solid'){
  const out=H.replaceFace(input,H.faceOf(old.e,old.face.faceId),H.faceOf(replacement.e,replacement.face.faceId),tol(c));
  return void results(c,[old.e],[out],'REPLACEFACE',{replacementId:replacement.e.id,faceId:old.face.faceId},{eraseInputs:true});
 }
 const r=H.unsew(old.e,[old.face.faceId],tol(c));if(!r.remainder)throw new Error('Select a face of a solid with other faces remaining.');
 const out=H.patch([r.remainder,H.faceOf(replacement.e,replacement.face.faceId)],tol(c));results(c,[old.e],[out],'REPLACEFACE',{replacementId:replacement.e.id,tolerance:tol(c)});
});
def('THROUGHCURVES SURFACELOFT',async c=>{
 await ready(c);const picks=[];c.echo('Select the sections in order (faces, edges or drawn shapes); Enter finishes.');
 for(;;){const f=await anyHit(c,'Pick next section; Enter to finish');if(!f)break;picks.push(f);}
 if(picks.length<2)return;
 const wires=picks.map(p=>p.face?H.faceOf(p.e,p.face.faceId).outerWire():pickWire(c,p));
 results(c,[...new Set(picks.map(p=>p.e))],[H.throughCurves(wires)],'THROUGHCURVES',{}, {copy:true});
});
def('SOLIDSWEEP SWEEP',async c=>{
 await ready(c);const profile=await anyHit(c,'Select the closed profile (a face or a closed drawn shape)');if(!profile)return;
 const path=await curveOrEdge(c,'Select the sweep path (edge or drawn line / curve)');if(!path||(!path.edge&&!path.curve))return;
 const transition=await c.keyword('Corner transition [Right/Round/Transformed] <Right>',['Right','Round','Transformed'],'Right');if(!transition)return;
 const profileFace=pickProfileFace(c,profile),pathWire=pickWire(c,path);
 const output=H.solidSweep(profileFace,pathWire,{transitionMode:transition.toLowerCase()});
 results(c,[...new Set([profile.e,path.e])],[output],'SOLIDSWEEP',{transition},{copy:true});
});
def('SOLIDLOFT LOFT',async c=>{
 await ready(c);const picks=[];c.echo('Select closed sections in order (faces or closed drawn shapes); Enter finishes.');
 for(;;){const hit=await anyHit(c,'Pick next closed section; Enter to finish');if(!hit)break;picks.push(hit);}
 if(picks.length<2)throw new Error('Select at least two closed sections.');
 const mode=await c.keyword('Loft surface [Smooth/Ruled] <Smooth>',['Smooth','Ruled'],'Smooth');if(!mode)return;
 const faces=picks.map(p=>pickProfileFace(c,p));
 results(c,[...new Set(picks.map(p=>p.e))],[H.solidLoft(faces,mode==='Ruled')],'SOLIDLOFT',{mode},{copy:true});
});
def('NETWORKSURFACE SURFACENETWORK NETWORK',async c=>{
 const boundary=await pickedEdges(c,'Select the closed outer boundary (edges or drawn curves); Enter finishes');
 const boundaryEdges=boundary.flatMap(p=>pickEdges(c,p));if(boundaryEdges.length<3&&!(boundaryEdges.length===1&&boundaryEdges[0].geomType==='CIRCLE'))throw new Error('Select a closed boundary: at least three connected edges, or one closed shape.');
 c.echo('Optional: select internal guide curves; Enter creates the surface.');
 const guides=await pickedEdges(c,'Select internal guide curves; Enter finishes');
 const guideEdges=guides.flatMap(p=>pickEdges(c,p));
 try{results(c,[...new Set([...boundary,...guides].map(p=>p.e))],[H.networkSurface(boundaryEdges,guideEdges)],'NETWORKSURFACE',{boundaryCount:boundaryEdges.length,guideCount:guideEdges.length},{copy:true});}
 finally{[...boundaryEdges,...guideEdges].forEach(edge=>edge.delete());}
});
def('PLANARSURFACE',async c=>{
 await ready(c);
 const closedShape=e=>CV.isCurve(e)&&CV.isClosedCurve(e);
 let p=await c.point('Specify the first boundary point or [Object] to use a closed drawn shape',{kw:['Object']});
 if(p==='Object'){
  const hit=await c.app.request('edge','Select the closed drawn shape',{mode:'edge',curves:closedShape});if(!hit?.curve)return;
  return void results(c,[],[H.check(CV.curveFace(hit.curve,c.doc))],'PLANARSURFACE',{source:'object'});
 }
 const pts=[];
 for(;p&&typeof p==='object';p=await c.point('Specify planar boundary point; Enter to finish'))pts.push([p.x,p.y,p.z||0]);
 if(pts.length>=3)results(c,[],[H.planar(pts)],'PLANARSURFACE');
 else if(pts.length)throw new Error('A planar surface needs at least three points, or a closed drawn shape.');
});
def('SURFACEEXTRUDE EXTRUDESURFACE',async c=>{
 await ready(c);
 const hit=await curveOrEdge(c,'Select the line, arc, polyline, circle or edge to extrude into a sheet');if(!hit||(!hit.edge&&!hit.curve))return;
 const wire=pickWire(c,hit);let dir=hit.curve?CV.planeNormal(hit.curve):[0,0,1],both=false;
 const wb=wire.boundingBox.bounds,base={x:(wb[0][0]+wb[1][0])/2,y:(wb[0][1]+wb[1][1])/2,z:(wb[0][2]+wb[1][2])/2};
 const make=d=>CV.extrudeShape(both?wire.clone().translate(dir.map(x=>-x*d)):wire,dir.map(x=>x*d*(both?2:1)));
 let h;
 for(;;){
  h=await c.dist('Specify the extrusion height [Direction/Both sides]',{base,direction3d:dir,noOrtho:true,noSnap:true,rubber:false,kw:['Direction','Both'],def:c.app.surfExtHeight??10,
   preview:d=>typeof d==='number'&&Math.abs(d)>tol(c)?S.safely(()=>[S.tempEntity(make(d))],[]):[]});
  if(h==='Direction'){
   const p1=await c.point('Specify the first point of the direction',{world3d:true,noOrtho:true});if(!p1)return;
   const p2=await c.point('Specify the second point of the direction',{base:p1,world3d:true,noOrtho:true});if(!p2)return;
   const v=[p2.x-p1.x,p2.y-p1.y,(p2.z||0)-(p1.z||0)],l=Math.hypot(...v);if(!(l>tol(c)))throw new Error('The two direction points must be different.');dir=v.map(x=>x/l);continue;
  }
  if(h==='Both'){both=!both;c.echo(`Both sides: ${both?'on':'off'}.`);continue;}
  break;
 }
 if(typeof h!=='number'||!(Math.abs(h)>tol(c)))return;c.app.surfExtHeight=h;
 results(c,hit.e&&hit.edge?[hit.e]:[],[make(h)],'SURFACEEXTRUDE',{height:h,direction:dir,both},{copy:true});
});
def('SURFACEREVOLVE',async c=>{
 await ready(c);const hit=await curveOrEdge(c,'Select the line, arc, polyline, circle or edge to revolve into a sheet');if(!hit||(!hit.edge&&!hit.curve))return;
 const a=await c.point('Specify the axis start point or define the axis by [X/Y/Z]',{kw:['X','Y','Z'],world3d:true,noOrtho:true});if(!a)return;
 let o,dir;
 if(typeof a==='string'){
  const p=await c.point(`Specify a point on the ${a} axis <0,0,0>`,{def:{x:0,y:0,z:0},world3d:true});o=p&&typeof p==='object'?[p.x,p.y,p.z||0]:[0,0,0];dir=a==='X'?[1,0,0]:a==='Y'?[0,1,0]:[0,0,1];
 }else{
  const b=await c.point('Specify the axis end point',{base:a,world3d:true,noOrtho:true});if(!b)return;
  o=[a.x,a.y,a.z||0];dir=[b.x-a.x,b.y-a.y,(b.z||0)-(a.z||0)];if(!(Math.hypot(...dir)>tol(c)))throw new Error('The axis points must be different.');
 }
 const angle=await c.number('Revolution angle in degrees',{def:360});if(!angle)return;
 const wire=pickWire(c,hit),oc=K.lib().getOC(),axis=K.lib().makeAx1(o,dir),maker=new oc.BRepPrimAPI_MakeRevol(wire.wrapped,axis,Math.min(360,Math.abs(angle))*Math.PI/180*Math.sign(angle),false);
 try{results(c,hit.edge?[hit.e]:[],[H.check(K.lib().cast(maker.Shape()))],'SURFACEREVOLVE',{angle,axisOrigin:o,axisDirection:dir},{copy:true});}finally{maker.delete();axis.delete();}
});
def('SURFACESWEEP',async c=>{
 await ready(c);const profile=await curveOrEdge(c,'Select the profile (edge or drawn line / curve)');if(!profile||(!profile.edge&&!profile.curve))return;const path=await curveOrEdge(c,'Select the sweep path (edge or drawn line / curve)');if(!path||(!path.edge&&!path.curve))return;
 const out=K.lib().genericSweep(pickWire(c,profile),pickWire(c,path),{},true);const shape=Array.isArray(out)?out[0]:out;
 results(c,[profile,path].filter(h=>h.edge).map(h=>h.e),[H.check(shape)],'SURFACESWEEP',{}, {copy:true});
});
def('SURFOFFSET OFFSETSURFACE',async c=>{
 await ready(c);const ents=await c.select('Select sheet(s) to offset',{filter:e=>body(e)&&e.bodyKind==='sheet'});if(!ents.length)return;
 const d=await c.number('Offset distance (negative goes to the other side)',{def:c.app.surfOffset??5});if(d==null)return;c.app.surfOffset=d;
 results(c,ents,ents.map(e=>H.offsetSurface(K.bakedShape(e),d,tol(c))),'SURFOFFSET',{distance:d},{copy:true});
});
def('CONVTOSURFACE',async c=>{
 await ready(c);const ents=await c.select('Select solids or closed drawn shapes to convert to surfaces',{filter:e=>(body(e)&&e.bodyKind!=='sheet')||(CV.isCurve(e)&&CV.isClosedCurve(e))});if(!ents.length)return;
 const out=[];
 for(const e of ents){
  if(body(e)){const shape=K.bakedShape(e),faces=shape.faces.map(f=>f.clone());out.push(H.sew(faces,tol(c),false).shape);}
  else out.push(H.check(CV.curveFace(e,c.doc)));
 }
 results(c,ents,out,'CONVTOSURFACE',{},{eraseInputs:true});
});
def('CONVTOSOLID',async c=>{
 await ready(c);const ents=await c.select('Select closed surfaces or facet bodies to convert to a solid',{filter:body});if(!ents.length)return;
 const shapes=[];for(const e of ents){const sewn=H.sew([K.bakedShape(e)],tol(c));if(sewn.kind!=='solid')throw new Error(`The surface is still open (${sewn.freeEdges} free boundary edge(s)). Close the gaps with PATCH or FILLSURFACE first.`);shapes.push(sewn.shape);}
 results(c,ents,shapes,'CONVTOSOLID',{},{eraseInputs:true});
});
def('CONVERTMESH',async c=>{await ready(c);const ents=await c.select('Select bodies to tessellate',{filter:body});if(!ents.length)return;const accuracy=await c.number('Tessellation tolerance',{def:.2});if(!(accuracy>0))return;results(c,ents,ents.map(e=>H.facetBody(M.weld(H.toMesh(K.bakedShape(e),accuracy)),tol(c))),'CONVERTMESH',{accuracy},{mesh:true});});
def('FACETBOOLEAN',async c=>{await ready(c);const ents=await c.select('Select two closed facet or solid bodies (first is target)',{filter:body});if(ents.length!==2)throw new Error('Select exactly two closed bodies.');const op=await c.keyword('Operation [Unite/Subtract/Intersect] <Unite>',['Unite','Subtract','Intersect'],'Unite');if(!op)return;
 const [a,b]=ents.map(K.bakedShape);if(H.kind(a)!=='solid'||H.kind(b)!=='solid')throw new Error('Facet Boolean requires watertight bodies. Use Fill Hole / Sew first.');
 const out=op==='Unite'?K.fuse(a,b):op==='Subtract'?K.cut(a,b):K.common(a,b);results(c,ents,[H.facetBody(M.weld(H.toMesh(out)),tol(c))],'FACETBOOLEAN',{operation:op},{mesh:true});});
def('FILLHOLE',async c=>{await ready(c);const ents=await c.select('Select open facet bodies',{filter:body});if(ents.length)results(c,ents,ents.map(e=>H.fillHoles(K.bakedShape(e),tol(c))),'FILLHOLE',{tolerance:tol(c)},{mesh:true});});
def('SPLITFACET',async c=>{await ready(c);const ents=await c.select('Select facet bodies',{filter:body});if(!ents.length)return;const mode=await S.planeKeyword(c,ents,'Cutting plane [XY/YZ/ZX/3points] <XY>',['XY','YZ','ZX','3points'],'XY');if(!mode)return;const pl=await S.planeFromKeyword(c,mode);if(!pl)return;const parts=ents.flatMap(e=>H.splitPlane(K.bakedShape(e),pl.o,pl.n));if(parts.length<=ents.length)throw new Error('The plane does not split the selection.');results(c,ents,parts,'SPLITFACET',pl,{mesh:true});});
for(const command of ['REMESH','DECIMATE'])def(command,async c=>{await ready(c);const ents=await c.select(command==='REMESH'?'Select facets for uniform 1-to-4 refinement':'Select facets to merge coplanar regions (preserves geometry)',{filter:body});if(!ents.length)return;
 const outputs=ents.map(e=>command==='REMESH'?H.facetBody(M.refine(H.toMesh(K.bakedShape(e))),tol(c)):H.simplifyFacets(K.bakedShape(e)));results(c,ents,outputs,command,{method:command==='REMESH'?'midpoint subdivision':'coplanar region merge'},{mesh:true});});
def('FITSURFACE',async c=>{const picks=await pickedFaces(c);if(!picks.length)return;const tolerance=await c.number('Maximum fitting deviation',{def:.01});if(!(tolerance>0))return;
 const fit=M.fitPlane(picks.flatMap(hit=>H.toMesh(H.faceOf(hit.e,hit.face.faceId)).vertices),tolerance);results(c,[...new Set(picks.map(p=>p.e))],[H.planar(fit.points)],'FITSURFACE',{type:'plane',tolerance,maxDeviation:fit.error},{copy:true});});
export async function openMeshFile(app,file){await K.initKernel();const shape=H.facetBody(M.parseSTL(file.stlBytes),app.settings.modelingTolerance??1e-6),doc=new Doc();doc.name=(file.name||'Mesh').replace(/\.stl$/i,'');doc.sourcePath=file.isSample?null:file.path;doc.model.push(E.mk('solid3d',{...K.solidProps(shape),bodyKind:'mesh',bb:S.boundsOf(shape)}));doc.dirty=true;app.openTab(doc);app.enter3D('swiso');app.zoomExtents(false);app.echo('STL imported as a faceted B-rep body.');}
def('STLIN',async c=>{const f=await api.openFile({filters:[{name:'STL mesh',extensions:['stl']}]});if(f&&!f.error)await openMeshFile(c.app,f);});
def('TRIMEXTEND TRIMEXT',async c=>{
 await ready(c);
 const first=faceOrCurve(await anyHit(c,'1/2 Select a solid or sheet face to trim, or a drawn line / curve'));if(!first||typeof first==='string')return;
 const second=faceOrCurve(await anyHit(c,'2/2 Select the other face or drawn line / curve [Plane]',{kw:['Plane']}));if(!second)return;
 const solidFace=h=>h.face&&H.kind(K.bakedShape(h.e))==='solid';
 // a drawn line or curve (or a plane) cuts the other object
 if(first.curve||second==='Plane'||second.curve){
  if(first.curve&&second.curve)throw new Error('Select a face or solid to trim, and a line, curve or face to trim it with.');
  const target=first.curve?second:first,toolHit=first.curve?first:second;
  if(target==='Plane')throw new Error('Select the object to trim first, then the plane.');
  let cutter;
  if(toolHit==='Plane'){
   const mode=await S.planeKeyword(c,[target.e],'Cutting plane [XY/YZ/ZX/3points] <XY>',['XY','YZ','ZX','3points'],'XY');if(!mode)return;
   const plane=await S.planeFromKeyword(c,mode);if(!plane)return;cutter={shape:H.planeSheet([K.bakedShape(target.e)],plane.o,plane.n),params:{tool:'plane',...plane}};
  }else cutter={shape:CV.cutterFromPick(toolHit,c.doc,[target.e]),params:{tool:'curve',toolId:toolHit.e.id}};
  if(solidFace(target)||(H.kind(K.bakedShape(target.e))==='solid'))return void await trimBodies(c,[target.e],cutter,'TRIMEXTEND');
  const input=H.faceOf(target.e,target.face.faceId),parts=H.split(input,cutter.shape);
  const made=results(c,[target.e],parts,'TRIMEXTEND',{...cutter.params,preserveOffcuts:true});made.forEach(e=>e.untrimBrep=input.serialize());
  return void await chooseRemoval(c,made);
 }
 if(first.e===second.e)throw new Error('Select two separate bodies.');
 // a solid and a face: the solid is cut by the (extended) face
 if(solidFace(first)||solidFace(second)){
  const solidHit=solidFace(first)?first:second,toolHit=solidHit===first?second:first;
  return void await trimBodies(c,[solidHit.e],{shape:CV.cutterFromPick(toolHit,c.doc,[solidHit.e]),params:{tool:'face',toolId:toolHit.e.id}},'TRIMEXTEND');
 }
 // two sheets: both are extended and cut by each other
 const reach=Math.max(1,Math.hypot(...[0,1,2].map(i=>{const bs=[first,second].map(h=>K.bakedShape(h.e).boundingBox.bounds);return Math.max(...bs.map(b=>b[1][i]))-Math.min(...bs.map(b=>b[0][i]));})));
 const distance=await c.number('Maximum planar extension distance',{def:Math.round(reach*100)/100});if(!(distance>0))return;
 const a=H.faceOf(first.e,first.face.faceId),b=H.faceOf(second.e,second.face.faceId);
 const ea=H.extendPlanar(a,distance),eb=H.extendPlanar(b,distance);
 const aparts=H.split(ea,eb),bparts=H.split(eb,ea);
 const made=results(c,[first.e,second.e],[...aparts,...bparts],'TRIMEXTEND',{distance,preserveOffcuts:true},{eraseInputs:true});
 await chooseRemoval(c,made);
});
def('EDITFEATURE',async c=>{
 await ready(c);const selected=await c.select('Select a Thicken / Sew / Patch result to edit',{filter:e=>body(e)&&!!e.feature?.inputs});if(selected.length!==1)throw new Error('Select exactly one editable feature result.');
 const original=selected[0].feature, group=c.app.doc.model.filter(e=>e.feature?.id===original.id);
 const transforms=JSON.stringify(selected[0].ops||[]);
 if(group.some(e=>JSON.stringify(e.ops||[])!==transforms))throw new Error('Feature outputs were moved separately. Undo those moves before editing this shared feature.');
 const input=original.inputs.map(p=>K.Solids.applyOps(K.lib().deserializeShape(p.brep),selected[0].ops));
 const feature={...original,inputs:input.map(shape=>({brep:shape.serialize()}))},parameters={...feature.parameters};let shapes;
 if(feature.operation==='THICKEN'){
  const t=await c.number('New thickness',{def:parameters.thickness});if(t==null)return;parameters.thickness=t;shapes=input.map(s=>H.thicken(s,t));
 }else{
  const tolerance=await c.number('New sewing tolerance',{def:parameters.tolerance});if(tolerance==null)return;parameters.tolerance=tolerance;
  shapes=[feature.operation==='PATCH'?H.patch(input,tolerance):H.sew(input,tolerance).shape];
 }
 shapes.forEach(H.check);
 const made=shapes.map(shape=>{const e=S.solidEntity(c,H.check(shape),selected[0]);e.bodyKind=H.kind(shape);e.feature={...feature,parameters};return e;});
 c.erase(group);c.addAll(made);c.echo(`${feature.operation} rebuilt from its saved inputs.`);
});

def('TRIMFACET',async c=>{
 await ready(c);const ents=await c.select('Select closed facet bodies to trim',{filter:body});if(!ents.length)return;
 const mode=await S.planeKeyword(c,ents,'Cutting plane [XY/YZ/ZX/3points] <XY>',['XY','YZ','ZX','3points'],'XY');if(!mode)return;
 const pl=await S.planeFromKeyword(c,mode);if(!pl)return;
 const p=await c.point('Pick the primary side (all cut parts will be kept)');if(!p)return;
 const parts=cutPartsSelectedSideFirst(ents.flatMap(e=>H.splitPlane(K.bakedShape(e),pl.o,pl.n)),pl,p);
 if(!parts.length)throw new Error('The plane did not divide the selected bodies.');
 results(c,ents,parts,'TRIMFACET',{...pl,preserveOffcuts:true},{mesh:true});
});

/** Names other CAD programs use for the same surface tools. */
const aliasNames={SURFTRIM:'TRIMSHEET',SURFEXTEND:'EXTENDSHEET',SURFBLEND:'BRIDGESURFACE',SURFPATCH:'FILLSURFACE',SURFNETWORK:'NETWORKSURFACE',PLANESURF:'PLANARSURFACE',TRIMSURFACE:'TRIMSHEET',EXTENDSURFACE:'EXTENDSHEET',SURFACETHICKEN:'THICKEN',SURFSEW:'SEW',DELETEFACES:'DELETEFACE',TRIMSOLIDS:'TRIMBODY',SOLIDSPLIT:'SPLITBODY',MERGEFACE:'MERGEFACES'};
for(const[a,name]of Object.entries(aliasNames))registryAlias(a,name);

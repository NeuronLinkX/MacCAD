/** Exact B-rep surface topology. Sheets use the existing B-rep entity/rendering path. */
import * as K from './kernel3d.js';
const R = () => K.lib();
const OC = () => R().getOC();
export function valid(shape) {
  const check = new (OC().BRepCheck_Analyzer)(shape.wrapped, true, false);
  try { return check.IsValid(); } finally { check.delete(); }
}
export function kind(shape) {
  if (shape instanceof R().Solid) return 'solid';
  if (shape instanceof R().CompSolid) return 'solid';
  // Boolean and topology builders can return a Compound that contains one or more valid solids.
  // Measuring an open shell can report a signed pseudo-volume, so inspect its contained topology.
  try { if (shape.solids?.length) return 'solid'; } catch { /* sheets contain no solids */ }
  return 'sheet';
}
export function check(shape) { if (!shape || shape.wrapped.IsNull() || !valid(shape)) throw new Error('The operation produced invalid topology. Inputs were preserved.'); if (shape instanceof R().Solid && K.volume(shape) < 0) shape.wrapped.Reverse(); return shape; }
export function sew(shapes, tolerance = 1e-6, solidify = true) {
  if (!Number.isFinite(tolerance) || tolerance < 1e-8 || tolerance > 1) throw new Error('Sewing tolerance must be between 1e-8 and 1 drawing unit.');
  if (!shapes.length) throw new Error('Select faces or sheets to sew.');
  const builder = new (OC().BRepBuilderAPI_Sewing)(tolerance, true, true, true, false);
  try {
    shapes.forEach((shape) => builder.Add(shape.wrapped)); builder.Perform();
    let shape = R().cast(builder.SewedShape());
    if (builder.NbMultipleEdges() > 0) throw new Error('Sewing creates a non-manifold edge. Remove overlapping faces.');
    const freeEdges = builder.NbFreeEdges();
    if (solidify && freeEdges === 0 && kind(shape) !== 'solid') {
      let solid = null;
      if (shape instanceof R().Shell && shape.wrapped.Closed()) {
        const fixer = new (OC().ShapeFix_Solid)();
        try { solid = R().cast(fixer.SolidFromShell(shape.wrapped)); } finally { fixer.delete(); }
      } else if (shape.faces.length) {
        // Sewing can return a Compound that contains one closed shell. Building from its faces
        // avoids leaving a watertight result tagged as a sheet merely because of that wrapper type.
        try { solid = R().makeSolid(shape.faces); } catch { solid = null; }
      }
      if (solid && kind(solid) === 'solid' && K.volume(solid) > tolerance ** 3) shape = solid;
      else {
        if (solid) solid.delete();
        throw new Error('The closed shell does not enclose one valid volume. Check face orientation or overlapping faces.');
      }
    }
    return { shape: check(shape), freeEdges, kind: kind(shape) };
  } finally { builder.delete(); }
}

/** Reports whether a B-Rep is ready for solid Boolean operations and why an open result is not. */
export function topologyStatus(shape, tolerance = 1e-6) {
  const builder = new (OC().BRepBuilderAPI_Sewing)(tolerance, true, true, true, false);
  try {
    builder.Add(shape.wrapped); builder.Perform();
    const shapeKind = kind(shape), solidCount = shapeKind === 'solid' ? Math.max(1, shape.solids?.length || 0) : 0;
    return {
      kind: shapeKind,
      valid: valid(shape),
      faces: shape.faces.length,
      solids: solidCount,
      freeEdges: builder.NbFreeEdges(),
      multipleEdges: builder.NbMultipleEdges(),
      volume: shapeKind === 'solid' ? Math.abs(K.volume(shape)) : 0,
      booleanReady: shapeKind === 'solid' && solidCount > 0 && valid(shape),
    };
  } finally { builder.delete(); }
}
export function faceOf(entity, id) {
  const face = K.baseShape(entity).shape.faces.find((f) => f.hashCode === id);
  if (!face) throw new Error('The selected face no longer exists. Select it again.');
  return K.Solids.applyOps(face.clone(), entity.ops);
}
export function edgeOf(entity, id) {
  const edge = K.baseShape(entity).shape.edges.find((e) => e.hashCode === id);
  if (!edge) throw new Error('The selected edge no longer exists. Select it again.');
  return K.Solids.applyOps(edge.clone(), entity.ops);
}
export function unsew(entity, ids, tolerance = 1e-6) {
  const selected = new Set(ids), faces = K.baseShape(entity).shape.faces;
  if (!selected.size || [...selected].some((id) => !faces.some((f) => f.hashCode === id))) throw new Error('Select at least one valid face.');
  const detached = faces.filter((f) => selected.has(f.hashCode)).map((f) => K.Solids.applyOps(f.clone(), entity.ops));
  const remaining = faces.filter((f) => !selected.has(f.hashCode)).map((f) => K.Solids.applyOps(f.clone(), entity.ops));
  return { detached, remainder: remaining.length ? sew(remaining, tolerance, false).shape : null };
}
export function patch(shapes, tolerance) {
  const result = sew(shapes, tolerance);
  if (result.kind !== 'solid') throw new Error(`Patch is not watertight (${result.freeEdges} free edges). Original bodies were preserved.`);
  return result.shape;
}
export function thicken(sheet, thickness) {
  if (!Number.isFinite(thickness) || Math.abs(thickness) < 1e-8) throw new Error('Thickness must be non-zero. Use a negative value for the opposite side.');
  if (kind(sheet) === 'solid') throw new Error('Thicken requires an open sheet or face.');
  const builder = new (OC().BRepOffsetAPI_MakeThickSolid)();
  try {
    builder.MakeThickSolidBySimple(sheet.wrapped, thickness);
    const result = check(R().cast(builder.Shape()));
    if (kind(result) !== 'solid') throw new Error('Could not create a solid at this thickness.');
    return result;
  } finally { builder.delete(); }
}

/** Offsets a sheet or face along its normal (a negative distance goes the other way). */
export function offsetSurface(shape, distance, tolerance = 1e-6) {
  if (!Number.isFinite(distance) || Math.abs(distance) < tolerance) throw new Error('The offset distance must not be zero.');
  const maker = new (OC().BRepOffsetAPI_MakeOffsetShape)();
  try {
    maker.PerformBySimple(shape.wrapped, distance);
    return check(R().cast(maker.Shape()));
  } catch (error) { throw new Error(error?.message && error.message !== 'Exception' ? error.message : 'This surface cannot be offset by that distance (a curvature radius is smaller than the offset).'); }
  finally { maker.delete(); }
}

/** Hollows a solid by removing selected faces and offsetting the remaining skin inward. */
export function shellSolid(body, removeFaces, thickness, tolerance = 1e-3) {
  if (kind(body) !== 'solid') throw new Error('SHELL requires one closed solid body.');
  if (!removeFaces?.length) throw new Error('Select at least one face to open.');
  if (!Number.isFinite(thickness) || !(thickness > tolerance)) throw new Error('Wall thickness must be positive and larger than the modeling tolerance.');
  try {
    const result = check(body.shell({ thickness, filter: { find: () => removeFaces } }, tolerance));
    if (kind(result) !== 'solid' || !(Math.abs(K.volume(result)) > tolerance ** 3)) throw new Error('The requested wall thickness removes the whole body.');
    return result;
  } catch (error) { throw new Error(error?.message || 'The selected faces could not be shelled at that thickness.'); }
}

/** Cuts a cylindrical blind or through hole from a planar face along its inward normal. */
export function hole(body, face, center, diameter, depth = 0, tolerance = 1e-6) {
  if (kind(body) !== 'solid') throw new Error('HOLE requires one closed solid body.');
  if (!face || face.geomType !== 'PLANE') throw new Error('Select a planar face for the hole.');
  if (!Number.isFinite(diameter) || !(diameter > tolerance * 2)) throw new Error('Hole diameter must be positive.');
  if (!Number.isFinite(depth) || depth < 0) throw new Error('Hole depth must be 0 (through) or a positive number.');
  const nv = face.normalAt(center), n0 = nv.toTuple(); nv.delete();
  const nl = Math.hypot(...n0); if (!(nl > 1e-12)) throw new Error('The selected face has no usable normal.');
  const outward = n0.map(v=>v/nl), bounds=body.boundingBox.bounds, diagonal=Math.hypot(...bounds[1].map((v,i)=>v-bounds[0][i]));
  const length=depth>tolerance?depth:diagonal*2+tolerance*10,origin=center.map((v,i)=>v+outward[i]*tolerance*2),direction=outward.map(v=>-v);
  const cutter=R().makeCylinder(diameter/2,length,origin,direction);
  try {
    const result=check(K.cut(body,cutter));
    if (kind(result)!=='solid'||!(K.volume(result)<K.volume(body)-tolerance**3)) throw new Error('The hole does not remove material from the body.');
    return result;
  } finally { cutter.delete(); }
}

/** Imprints a sheet onto a body, preserving all resulting partitions in one model entity. */
export function imprint(body, tool) {
  if (kind(body) !== 'solid') throw new Error('IMPRINT requires one closed solid body.');
  const oc=OC(),args=new oc.NCollection_List_TopoDS_Shape(),tools=new oc.NCollection_List_TopoDS_Shape(),splitter=new oc.BRepAlgoAPI_Splitter();
  try {
    args.Append(body.wrapped);tools.Append(tool.wrapped);splitter.SetArguments(args);splitter.SetTools(tools);splitter.Build();
    const result=check(R().cast(splitter.Shape()));
    if (result.faces.length<=body.faces.length) throw new Error('The tool does not cross or divide any face of the body.');
    if (Math.abs(Math.abs(K.volume(result))-Math.abs(K.volume(body)))>Math.max(1e-7,Math.abs(K.volume(body))*1e-7)) throw new Error('Imprint unexpectedly changed the body volume.');
    return result;
  } finally { splitter.delete();args.delete();tools.delete(); }
}

/** Applies an exact OCCT draft to arbitrary faces, held at a planar neutral face. */
export function draftFaces(body, faces, angleDegrees, neutralFace) {
  if (kind(body)!=='solid')throw new Error('DRAFTFACE requires one closed solid body.');
  if(!faces?.length)throw new Error('Select at least one face to taper.');
  if(!Number.isFinite(angleDegrees)||Math.abs(angleDegrees)>=89)throw new Error('Draft angle must be between -89 and 89 degrees.');
  if(!neutralFace||neutralFace.geomType!=='PLANE')throw new Error('Select a planar neutral face.');
  const op=neutralFace.center,np=neutralFace.normalAt(),origin=op.toTuple(),normal=np.toTuple();op.delete();np.delete();
  const direction=R().asDir(normal),plane=R().makePln(origin,normal),builder=new (OC().BRepOffsetAPI_DraftAngle)(body.wrapped);
  try{
    faces.forEach(face=>builder.Add(face.wrapped,direction,angleDegrees*Math.PI/180,plane,false));
    if(!builder.AddDone())throw new Error('One or more selected faces cannot be drafted from that neutral face.');
    builder.Build();const result=check(R().cast(builder.ModifiedShape(body.wrapped)));
    if(kind(result)!=='solid')throw new Error('Draft did not produce a closed solid.');return result;
  }finally{builder.delete();direction.delete();plane.delete();}
}

/** Exact intersection edges between a body and an arbitrary plane. */
export function sectionEdges(body,origin,normal){
 if(kind(body)!=='solid')throw new Error('SECTION requires a closed solid body.');
 const nl=Math.hypot(...normal);if(!(nl>1e-12))throw new Error('Section plane normal is degenerate.');
 const n=normal.map(v=>v/nl),seed=Math.abs(n[2])<.9?[0,0,1]:[0,1,0],cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],unit=v=>{const l=Math.hypot(...v);return v.map(x=>x/l);};
 const x=unit(cross(seed,n)),y=cross(n,x),bounds=body.boundingBox.bounds,size=Math.max(1,Math.hypot(...bounds[1].map((v,i)=>v-bounds[0][i]))*2);
 const point=(a,b)=>origin.map((v,i)=>v+x[i]*a*size+y[i]*b*size),planeFace=R().makePolygon([point(-1,-1),point(1,-1),point(1,1),point(-1,1)]),section=new (OC().BRepAlgoAPI_Section)(body.wrapped,planeFace.wrapped,false);
 try{section.Approximation(true);section.ComputePCurveOn1(true);section.ComputePCurveOn2(true);section.Build();const shape=R().cast(section.Shape()),edges=shape.edges.map(edge=>edge.clone());shape.delete();if(!edges.length)throw new Error('The section plane does not intersect the body.');return{edges,plane:{o:[...origin],x,y,n}};}
 finally{section.delete();planeFace.delete();}
}

/**
 * Moves one planar solid face along its outward normal. A positive distance adds material and a
 * negative distance removes material, which is the direct-modeling PRESSPULL operation.
 */
export function pressPullFace(body, face, distance, tolerance = 1e-6) {
  if (kind(body) !== 'solid') throw new Error('PRESSPULL requires a closed solid body. Sew the body first.');
  if (!face || face.geomType !== 'PLANE') throw new Error('PRESSPULL currently supports planar solid faces.');
  if (!Number.isFinite(distance) || Math.abs(distance) <= tolerance)
    throw new Error('Pull distance must be non-zero. Drag outward to add material or inward to remove it.');
  const centerVector = face.center, center = centerVector.toTuple(); centerVector.delete();
  const normalVector = face.normalAt(center), rawNormal = normalVector.toTuple(); normalVector.delete();
  const length = Math.hypot(...rawNormal);
  if (!(length > 1e-12)) throw new Error('The selected face has no usable normal direction.');
  const normal = rawNormal.map((value) => value / length);
  const vector = new (R().Vector)(normal.map((value) => value * distance));
  let prism, booleanResult, cleaned;
  try {
    prism = R().basicFaceExtrusion(face, vector);
    booleanResult = distance > 0
      ? body.fuse(prism)
      : body.cut(prism);
    cleaned = unifyFaces(booleanResult);
    if (kind(cleaned) !== 'solid' || cleaned.solids.length !== 1 || K.volume(cleaned) <= tolerance ** 3)
      throw new Error('The pull would remove the body or create separate solids. Use a shorter inward distance.');
    return check(cleaned);
  } catch (error) {
    if (cleaned) cleaned.delete();
    throw new Error(error?.message || 'The selected face could not be pushed or pulled by that distance.');
  } finally {
    if (booleanResult) booleanResult.delete();
    if (prism) prism.delete();
    vector.delete();
  }
}
/**
 * Replaces one face of a solid by another surface: the material between the old face and the new
 * surface is added (new surface outside) or removed (new surface inside). A flat replacement is
 * extended so it covers the whole face.
 */
export function replaceFace(body, face, replacement, tolerance = 1e-6) {
  if (kind(body) !== 'solid') throw new Error('Replace Face on a solid needs a closed solid body.');
  const centerVector = face.center, center = centerVector.toTuple(); centerVector.delete();
  const normalVector = face.normalAt(center), rawNormal = normalVector.toTuple(); normalVector.delete();
  const length = Math.hypot(...rawNormal);
  if (!(length > 1e-12)) throw new Error('The face has no usable normal direction.');
  const normal = rawNormal.map((v) => v / length);
  const reach = Math.max(1, Math.hypot(...[0, 1, 2].map((i) => {
    const boxes = [body, face, replacement].map((s) => s.boundingBox.bounds);
    return Math.max(...boxes.map((b) => b[1][i])) - Math.min(...boxes.map((b) => b[0][i]));
  }))) * 2;
  const tool = replacement.geomType === 'PLANE' ? extendPlanar(replacement, reach) : replacement;
  const probe = R().makeVertex(center);
  const nearest = (parts) => parts.reduce((best, part) => {
    const d = R().measureDistanceBetween(part, probe);
    return !best || d < best.d ? { part, d } : best;
  }, null).part;
  const swept = (sign) => new (R().Vector)(normal.map((v) => v * sign * reach));
  const region = (sign) => {
    const vector = swept(sign);
    let prism;
    try {
      prism = R().basicFaceExtrusion(face, vector);
      try { return nearest(split(prism, tool)); } catch (error) { if (/does not divide/i.test(error.message || '')) return null; throw error; }
    } finally { vector.delete(); }
  };
  try {
    let result;
    const outer = region(1);
    if (outer) result = body.fuse(outer);
    else {
      const inner = region(-1);
      if (!inner) throw new Error('The replacement surface does not cross the path of the face. Choose a surface that lies over or under it.');
      result = body.cut(inner);
    }
    const cleaned = unifyFaces(result);
    if (kind(cleaned) !== 'solid' || cleaned.solids.length !== 1 || K.volume(cleaned) <= tolerance ** 3) throw new Error('The replacement would leave no single solid. Choose a surface that stays inside the body\'s outline.');
    return check(cleaned);
  } finally { probe.delete(); }
}
export function split(body, tool) {
  const oc = OC(), args = new oc.NCollection_List_TopoDS_Shape(), tools = new oc.NCollection_List_TopoDS_Shape(), splitter = new oc.BRepAlgoAPI_Splitter();
  try {
    args.Append(body.wrapped); tools.Append(tool.wrapped); splitter.SetArguments(args); splitter.SetTools(tools); splitter.Build();
    const result = check(R().cast(splitter.Shape()));
    const parts = body instanceof R().Solid ? result.solids : result.faces;
    if (parts.length < 2) throw new Error('The tool does not divide this body.');
    return parts.map((s) => check(s));
  } finally { splitter.delete(); args.delete(); tools.delete(); }
}
export function bridge(edge1, edge2, support1, support2, continuity = 'G0') {
  if (!['G0', 'G1', 'G2'].includes(continuity)) throw new Error('This kernel supports G0/G1/G2 boundary constraints; G3 is unavailable.');
  if (continuity === 'G0') return check(R().loft([R().assembleWire([edge1]), R().assembleWire([edge2])], { ruled: true }, true));
  if (!support1 || !support2) throw new Error('G1/G2 requires a supporting face for both edges.');
  // Coplanar support surfaces share position, tangent and zero curvature exactly.
  if (support1.geomType === 'PLANE' && support2.geomType === 'PLANE') {
    const n = support1.normalAt().toTuple(), m = support2.normalAt().toTuple();
    const d = support2.center.toTuple().map((v,i)=>v-support1.center.toTuple()[i]);
    if (Math.abs(Math.abs(n.reduce((s,v,i)=>s+v*m[i],0))-1)<1e-8 && Math.abs(d.reduce((s,v,i)=>s+v*n[i],0))<1e-7)
      return check(R().loft([R().assembleWire([edge1]),R().assembleWire([edge2])], {ruled:true}, true));
  }
  const oc = OC(), filling = new oc.BRepOffsetAPI_MakeFilling(3, 20, 3, false, 1e-6, 1e-5, .01, .1, 8, 12);
  try {
    const order = continuity === 'G1' ? oc.GeomAbs_Shape.GeomAbs_G1 : oc.GeomAbs_Shape.GeomAbs_G2;
    filling.Add(edge1.wrapped, support1.wrapped, order, true);
    filling.Add(edge2.wrapped, support2.wrapped, order, true);
    const a = edge1.startPoint.toTuple(), b = edge1.endPoint.toTuple();
    let c = edge2.startPoint.toTuple(), d = edge2.endPoint.toTuple();
    const dist = (p,q) => Math.hypot(...p.map((v,i)=>v-q[i]));
    if (dist(a,c)+dist(b,d)>dist(a,d)+dist(b,c)) [c,d]=[d,c];
    const ends = [R().makeLine(a,c),R().makeLine(b,d)];
    ends.forEach((edge) => filling.Add(edge.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true));
    filling.Build();
    if (!filling.IsDone() || filling.G0Error() > 1e-5 || filling.G1Error() > .01 || (continuity === 'G2' && filling.G2Error() > .1))
      throw new Error('The requested boundary continuity could not be satisfied.');
    return check(R().cast(filling.Shape()));
  } catch (error) {
    throw new Error(error?.message || `${continuity} bridge could not be constructed for these supports. Try G0 or change the boundary edges.`);
  } finally { filling.delete(); }
}
export function fillBoundary(edges) {
  if (!edges || !edges.length || (edges.length < 3 && !(edges.length === 1 && edges[0].geomType === 'CIRCLE'))) throw new Error('Select at least three boundary edges, or one closed shape.');
  const close=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]))<=1e-7,pool=edges.map(e=>e.clone()),ordered=[pool.shift()];
  const start=ordered[0].startPoint.toTuple();let end=ordered[0].endPoint.toTuple();
  while(pool.length){
    const i=pool.findIndex(e=>close(e.startPoint.toTuple(),end)||close(e.endPoint.toTuple(),end));
    if(i<0){ordered.forEach(e=>e.delete());pool.forEach(e=>e.delete());throw new Error('The selected edges are disconnected. Select one continuous boundary loop.');}
    let edge=pool.splice(i,1)[0];
    if(!close(edge.startPoint.toTuple(),end)){const reversed=edge.flipOrientation();edge.delete();edge=reversed;}
    ordered.push(edge);end=edge.endPoint.toTuple();
  }
  if(!close(start,end)){ordered.forEach(e=>e.delete());throw new Error('The selected boundary is open. Add the missing edge before filling.');}
  let wire;
  try { wire = R().assembleWire(ordered); }
  catch { ordered.forEach(e=>e.delete());throw new Error('The selected edges are disconnected. Select one continuous boundary loop.'); }
  ordered.forEach(e=>e.delete());
  try {
    try { return check(R().makeFace(wire)); }
    catch { return check(R().makeNonPlanarFace(wire)); }
  } finally { wire.delete(); }
}

/** Splits a planar face with the projection of a reference edge along the face normal. */
export function splitFaceByEdge(face, edge) {
  if (!face || face.geomType !== 'PLANE') throw new Error('Trim by Edge requires a planar target face.');
  if (!edge) throw new Error('Select a valid reference edge.');
  const nv = face.normalAt(), n0 = nv.toTuple(); nv.delete();
  const nl = Math.hypot(...n0); if (!(nl > 1e-12)) throw new Error('The target face has no usable normal.');
  const n = n0.map((v) => v / nl), boxes = [face.boundingBox.bounds, edge.boundingBox.bounds];
  const lo = [0,1,2].map(i=>Math.min(...boxes.map(b=>b[0][i]))),hi=[0,1,2].map(i=>Math.max(...boxes.map(b=>b[1][i])));
  const radius = Math.max(1, Math.hypot(...hi.map((v,i)=>v-lo[i])) * 2);
  const shifted = edge.clone().translate(n.map((v) => -v * radius));
  const vector = new (R().Vector)(n.map((v) => v * radius * 2));
  const maker = new (OC().BRepPrimAPI_MakePrism)(shifted.wrapped, vector.wrapped, false, true);
  let tool;
  try {
    tool = R().cast(maker.Shape());
    const parts = split(face, tool);
    if (parts.length < 2) throw new Error('The reference edge does not cross the target face.');
    return parts;
  } catch (error) {
    if (/does not divide|reference edge/i.test(error.message || '')) throw new Error('The reference edge does not cross the target face.');
    throw error;
  } finally {
    if (tool) tool.delete();
    maker.delete(); vector.delete(); shifted.delete();
  }
}
export function throughCurves(wires, ruled = false) {
  if (wires.length < 2) throw new Error('Select at least two section loops.');
  return check(R().loft(wires, { ruled }, true));
}

/** Sweeps a closed face (including matching inner loops) along one continuous path. */
export function solidSweep(face, path, options = {}) {
  if (!face || !path) throw new Error('Select one closed profile face and one path edge.');
  const outer = face.clone().outerWire(), spine = path instanceof R().Wire ? path.clone() : R().assembleWire([path.clone()]);
  const holes = face.clone().innerWires();
  let result;
  try {
    result = check(R().genericSweep(outer, spine, options, false));
    for (const hole of holes) {
      const cutter = check(R().genericSweep(hole, spine, options, false));
      const cut = check(K.cut(result, cutter));
      result.delete(); cutter.delete(); result = cut;
    }
    if (kind(result) !== 'solid' || !(Math.abs(K.volume(result)) > 1e-10)) throw new Error('The profile and path did not produce a closed volume.');
    return result;
  } catch (error) {
    if (result) result.delete();
    throw new Error(error?.message || 'The profile could not be swept along that path.');
  } finally { outer.delete(); spine.delete(); holes.forEach((wire) => wire.delete()); }
}

/** Lofts corresponding closed face loops into one solid; equal hole counts are supported. */
export function solidLoft(faces, ruled = false) {
  if (!faces || faces.length < 2) throw new Error('Select at least two closed section faces.');
  const outer = faces.map((face) => face.clone().outerWire());
  const inner = faces.map((face) => face.clone().innerWires());
  const holeCount = inner[0].length;
  if (inner.some((wires) => wires.length !== holeCount)) {
    [...outer, ...inner.flat()].forEach((wire) => wire.delete());
    throw new Error('Every loft section must have the same number of inner loops.');
  }
  let result;
  try {
    result = check(R().loft(outer, { ruled }, false));
    for (let index = 0; index < holeCount; index += 1) {
      const cutter = check(R().loft(inner.map((wires) => wires[index]), { ruled }, false));
      const cut = check(K.cut(result, cutter));
      result.delete(); cutter.delete(); result = cut;
    }
    if (kind(result) !== 'solid' || !(Math.abs(K.volume(result)) > 1e-10)) throw new Error('The sections did not produce a closed volume.');
    return result;
  } catch (error) {
    if (result) result.delete();
    throw new Error(error?.message || 'The selected sections could not be lofted.');
  } finally { [...outer, ...inner.flat()].forEach((wire) => wire.delete()); }
}

/** Builds a fitted surface from a closed boundary and optional internal guide curves. */
export function networkSurface(boundaryEdges, guideEdges = []) {
  if (!boundaryEdges || !boundaryEdges.length || (boundaryEdges.length < 3 && !(boundaryEdges.length === 1 && boundaryEdges[0].geomType === 'CIRCLE'))) throw new Error('Select at least three connected boundary edges, or one closed shape.');
  const filling = new (OC().BRepOffsetAPI_MakeFilling)(3, 20, 3, false, 1e-6, 1e-5, .01, .1, 8, 12);
  try {
    boundaryEdges.forEach((edge) => filling.Add(edge.wrapped, OC().GeomAbs_Shape.GeomAbs_C0, true));
    guideEdges.forEach((edge) => filling.Add(edge.wrapped, OC().GeomAbs_Shape.GeomAbs_C0, false));
    filling.Build();
    if (!filling.IsDone()) throw new Error('The boundary and guide curves do not define one surface.');
    return check(R().cast(filling.Shape()));
  } catch (error) {
    throw new Error(error?.message || 'Network surface construction failed. Check that the boundary is closed and guides meet it.');
  } finally { filling.delete(); }
}
export function extendPlanar(face, distance) {
  if (face.geomType !== 'PLANE') throw new Error('Extend Sheet currently supports planar faces only. Curved-sheet extension is unavailable.');
  if (!(distance > 0) || !Number.isFinite(distance)) throw new Error('Extension distance must be positive.');
  const oc = OC(), surface = oc.BRep_Tool.Surface(face.wrapped), {uMin:u0,uMax:u1,vMin:v0,vMax:v1} = face.UVBounds;
  const maker = new oc.BRepBuilderAPI_MakeFace(surface,u0-distance,u1+distance,v0-distance,v1+distance,1e-7);
  try { return check(R().cast(maker.Face())); } finally { maker.delete(); surface.delete(); }
}
const length3 = (v) => Math.hypot(v[0], v[1], v[2]);
const unit3 = (v) => { const n=length3(v);if(!(n>1e-12))throw new Error('The selected edge has no usable surface direction.');return v.map(x=>x/n); };
/**
 * Finds the UV side and outward tangent for one boundary edge. The returned frame drives both the
 * mouse drag and the exact surface extension, so planar and curved sheets use the same workflow.
 */
export function extensionFrame(face, edge) {
  if (!face || !edge) throw new Error('Select one boundary edge of a sheet face.');
  const bounds=face.UVBounds,{uMin,uMax,vMin,vMax}=bounds,duRange=Math.abs(uMax-uMin),dvRange=Math.abs(vMax-vMin);
  if(!(duRange>1e-12&&dvRange>1e-12))throw new Error('The selected face has degenerate surface bounds.');
  const samples=[];
  for(const t of [.1,.5,.9]){const p=edge.pointAt(t);try{samples.push(face.uvCoordinates(p.toTuple()));}finally{p.delete();}}
  const choices=[
    {side:'uMin',axis:0,bound:uMin,range:duRange,sign:-1},
    {side:'uMax',axis:0,bound:uMax,range:duRange,sign:1},
    {side:'vMin',axis:1,bound:vMin,range:dvRange,sign:-1},
    {side:'vMax',axis:1,bound:vMax,range:dvRange,sign:1},
  ].map(c=>({...c,error:Math.max(...samples.map(uv=>Math.abs(uv[c.axis]-c.bound)/c.range))})).sort((a,b)=>a.error-b.error);
  const selected=choices[0];
  if(selected.error>1e-4)throw new Error('Select an outer UV boundary edge. Interior or trimmed diagonal edges cannot be extended directly.');
  const midpoint=edge.pointAt(.5),base=midpoint.toTuple(),uv=face.uvCoordinates(base);midpoint.delete();
  const oc=OC(),surface=new oc.BRepAdaptor_Surface(face.wrapped,false),point=new oc.gp_Pnt(),dU=new oc.gp_Vec(),dV=new oc.gp_Vec();
  try{
    surface.D1(uv[0],uv[1],point,dU,dV);
    const derivative=selected.axis===0?[dU.X(),dU.Y(),dU.Z()]:[dV.X(),dV.Y(),dV.Z()],metric=length3(derivative);
    if(!(metric>1e-12))throw new Error('The selected edge has no usable surface direction.');
    const direction=unit3(derivative.map(x=>x*selected.sign)),nv=face.normalAt(base),normal=unit3(nv.toTuple());nv.delete();
    return{...selected,bounds,base:[point.X(),point.Y(),point.Z()],direction,normal,parameterPerUnit:1/metric,surfaceType:face.geomType};
  }finally{dV.delete();dU.delete();point.delete();surface.delete();}
}
/** Extends only the selected boundary side, continuing the face's underlying surface flow. */
export function extendSurfaceEdge(face, edge, distance, tolerance = 1e-6) {
  if (!(distance > 0) || !Number.isFinite(distance)) throw new Error('Extension distance must be positive.');
  const frame=extensionFrame(face,edge),next={...frame.bounds},delta=distance*frame.parameterPerUnit;
  next[frame.side]+=frame.sign*delta;
  const oc=OC(),surface=oc.BRep_Tool.Surface(face.wrapped),maker=new oc.BRepBuilderAPI_MakeFace(surface,next.uMin,next.uMax,next.vMin,next.vMax,tolerance);
  try{return check(R().cast(maker.Face()));}
  catch(error){throw new Error(`${frame.surfaceType} surface flow could not be extended by ${distance}: ${error?.message||'kernel failure'}`);}
  finally{maker.delete();surface.delete();}
}
export function planar(points) { return check(R().makePolygon(points)); }
export function facetBody(mesh, tolerance = 1e-6) {
  if (!mesh.triangles.length || mesh.triangles.length > 12000) throw new Error('Facet operations support 1–12,000 triangles per body. Reduce larger scans before import.');
  const faces = mesh.triangles.map((tri) => planar(tri.map((i) => mesh.vertices[i])));
  return sew(faces, tolerance).shape;
}
export function toMesh(shape, tolerance = .1) {
  const m = shape.mesh({ tolerance, angularTolerance: .2 });
  const vertices = [], triangles = [];
  for (let i=0;i<m.vertices.length;i+=3) vertices.push(m.vertices.slice(i,i+3));
  for (let i=0;i<m.triangles.length;i+=3) triangles.push(m.triangles.slice(i,i+3));
  return {vertices,triangles};
}
/** Removes redundant edges between adjacent faces on the same plane or analytic surface. */
export function unifyFaces(shape) {
  const oc = OC(), builder = new oc.ShapeUpgrade_UnifySameDomain(shape.wrapped, true, true, false);
  try { builder.Build(); return check(R().cast(builder.Shape())); } finally { builder.delete(); }
}
/** Boolean-unites bodies, removes shared/internal partitions and merges coplanar outside faces. */
export function unionBodies(shapes) {
  if (!Array.isArray(shapes) || shapes.length < 2) throw new Error('Select at least two solid bodies.');
  let result = shapes[0];
  for (let i = 1; i < shapes.length; i += 1)
    result = result.fuse(shapes[i]);
  const cleaned = unifyFaces(result);
  if (kind(cleaned) !== 'solid' || cleaned.solids.length !== 1)
    throw new Error('The selected bodies must touch or overlap to form one solid union.');
  return cleaned;
}
export const simplifyFacets = unifyFaces;
export function freeBoundaryLoops(shape, tolerance = 1e-6) {
  const builder = new (OC().BRepBuilderAPI_Sewing)(tolerance,true,true,true,false);
  try {
    builder.Add(shape.wrapped); builder.Perform();
    if (builder.NbMultipleEdges()) throw new Error('Non-manifold mesh: repair intersecting or duplicate faces first.');
    const edges=Array.from({length:builder.NbFreeEdges()},(_,i)=>R().cast(builder.FreeEdge(i+1)));
    const close=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]))<=tolerance;
    const loops=[];
    while(edges.length) {
      const first=edges.shift(), loop=[first]; let start=first.startPoint.toTuple(),end=first.endPoint.toTuple();
      while(!close(start,end)) {
        const candidates=edges.map((e,i)=>({e,i,a:e.startPoint.toTuple(),b:e.endPoint.toTuple()})).filter(({a,b})=>close(a,end)||close(b,end));
        if(candidates.length!==1)throw new Error('Boundary is open or branched; automatic hole filling is ambiguous.');
        const {e,i,a,b}=candidates[0]; edges.splice(i,1);loop.push(e);end=close(a,end)?b:a;
      }
      loops.push(loop);
    }
    return loops;
  } finally {builder.delete();}
}
export function fillHoles(shape,tolerance=1e-6) {
  const loops=freeBoundaryLoops(shape,tolerance);
  if(!loops.length)throw new Error('This mesh has no open boundary.');
  return patch([shape,...loops.map(edges=>{
    const wire=R().assembleWire(edges);
    try{return R().makeFace(wire);}catch{return R().makeNonPlanarFace(wire);}
  })],tolerance);
}
/** A flat cutting sheet through `origin` that is large enough to pass completely through every shape in `shapes`. */
export function planeSheet(shapes, origin, normal) {
  const length=Math.hypot(...normal);if(!Number.isFinite(length)||length<1e-12)throw new Error('Invalid plane normal.');
  const n=normal.map(v=>v/length),axis=Math.abs(n[2])<.9?[0,0,1]:[0,1,0];
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  let u=cross(n,axis);u=u.map(v=>v/Math.hypot(...u));const v=cross(n,u);
  const radius=2*Math.max(1,...shapes.flatMap(s=>s.boundingBox.bounds).map(p=>Math.hypot(...p.map((x,i)=>x-origin[i]))));
  const points=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([a,b])=>origin.map((x,i)=>x+radius*(a*u[i]+b*v[i])));
  return planar(points);
}
/** Finite cutting sheet spans the body's bounds, avoiding a fixed world-size clipping box. */
export function splitPlane(body, origin, normal) {
  if (!(body instanceof R().Solid)) throw new Error('Plane splitting requires a closed solid/facet body. Sew or Fill Hole first.');
  return split(body,planeSheet([body],origin,normal));
}

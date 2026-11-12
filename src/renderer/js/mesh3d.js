/** Small/medium STL meshes. Geometry errors are rejected before modifying a document. */
export function weld(mesh, tolerance=1e-7) {
  const vertices=[],triangles=[],lookup=new Map(),seen=new Set();
  const remap=mesh.vertices.map((p)=>{
    if(p.length!==3||p.some(v=>!Number.isFinite(v)))throw new Error('Mesh contains invalid coordinates.');
    const key=p.map(v=>Math.round(v/tolerance)).join(',');
    if(!lookup.has(key)){lookup.set(key,vertices.length);vertices.push([...p]);}return lookup.get(key);
  });
  for(const f of mesh.triangles){
    if(f.length!==3||f.some(i=>!Number.isInteger(i)||i<0||i>=remap.length))throw new Error('Invalid triangle index.');
    const tri=f.map(i=>remap[i]);if(new Set(tri).size!==3)continue;
    const key=[...tri].sort((a,b)=>a-b).join(',');if(seen.has(key))throw new Error('Mesh contains duplicate triangles.');seen.add(key);triangles.push(tri);
  }
  if(!triangles.length)throw new Error('The mesh has no non-degenerate triangles.');
  return {vertices,triangles};
}
export function parseSTL(bytes) {
  const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes),v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  const vertices=[],triangles=[];
  const add=(p)=>{const i=vertices.length;vertices.push(...p);triangles.push([i,i+1,i+2]);};
  const count=b.length>=84?v.getUint32(80,true):0;
  if(count&&84+50*count===b.length){
    if(count>12000)throw new Error('This release supports STL files with up to 12,000 triangles.');
    for(let i=0;i<count;i++){const off=84+i*50+12;add([0,1,2].map(j=>[0,1,2].map(k=>v.getFloat32(off+j*12+k*4,true))));}
  }else{
    const text=new TextDecoder().decode(b),re=/vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi;let m,p=[];
    while((m=re.exec(text))){p.push(m.slice(1).map(Number));if(p.length===3){add(p);p=[];}if(triangles.length>12000)throw new Error('This release supports up to 12,000 STL triangles.');}
    if(p.length||!triangles.length)throw new Error('Invalid STL file.');
  }
  return weld({vertices,triangles});
}
export function refine(input) {
  const mesh=weld(input),vertices=mesh.vertices.map(p=>[...p]),triangles=[],cache=new Map();
  if(mesh.triangles.length*4>12000)throw new Error('Refinement would exceed the 12,000-triangle limit.');
  const mid=(a,b)=>{const key=[a,b].sort((x,y)=>x-y).join(',');if(!cache.has(key)){cache.set(key,vertices.length);vertices.push(vertices[a].map((v,i)=>(v+vertices[b][i])/2));}return cache.get(key);};
  for(const [a,b,c] of mesh.triangles){const ab=mid(a,b),bc=mid(b,c),ca=mid(c,a);triangles.push([a,ab,ca],[ab,b,bc],[ca,bc,c],[ab,bc,ca]);}return {vertices,triangles};
}
export function fitPlane(points,tolerance) {
  if(points.length<3||!(tolerance>0))throw new Error('Plane fitting requires three points and a positive tolerance.');
  const center=[0,1,2].map(i=>points.reduce((s,p)=>s+p[i],0)/points.length),a=Array.from({length:3},()=>[0,0,0]),v=[[1,0,0],[0,1,0],[0,0,1]];
  for(const p of points){const d=p.map((x,i)=>x-center[i]);for(let i=0;i<3;i++)for(let j=0;j<3;j++)a[i][j]+=d[i]*d[j];}
  for(let step=0;step<40;step++){
    let p=0,q=1;for(const [i,j]of[[0,2],[1,2]])if(Math.abs(a[i][j])>Math.abs(a[p][q]))[p,q]=[i,j];
    if(Math.abs(a[p][q])<1e-12)break;const angle=.5*Math.atan2(2*a[p][q],a[q][q]-a[p][p]),c=Math.cos(angle),s=Math.sin(angle);
    const ap=a[p][p],aq=a[q][q],off=a[p][q];a[p][p]=c*c*ap-2*s*c*off+s*s*aq;a[q][q]=s*s*ap+2*s*c*off+c*c*aq;a[p][q]=a[q][p]=0;
    for(let i=0;i<3;i++){if(i!==p&&i!==q){const x=a[i][p],y=a[i][q];a[i][p]=a[p][i]=c*x-s*y;a[i][q]=a[q][i]=s*x+c*y;}const x=v[i][p],y=v[i][q];v[i][p]=c*x-s*y;v[i][q]=s*x+c*y;}
  }
  const eigen=[0,1,2].sort((i,j)=>a[i][i]-a[j][j]);if(a[eigen[1]][eigen[1]]<1e-12)throw new Error('Points are collinear.');
  const normal=v.map(row=>row[eigen[0]]),u=v.map(row=>row[eigen[2]]),w=v.map(row=>row[eigen[1]]),dot=(x,y)=>x.reduce((n,t,i)=>n+t*y[i],0);
  const projected=points.map(p=>{const d=p.map((x,i)=>x-center[i]);return{x:dot(d,u),y:dot(d,w),error:Math.abs(dot(d,normal))};});
  const error=Math.max(...projected.map(p=>p.error));if(error>tolerance)throw new Error(`Not planar within tolerance: maximum deviation ${error.toPrecision(5)}. Cylinder/NURBS fitting is not supported.`);
  const sorted=projected.sort((a,b)=>a.x-b.x||a.y-b.y),cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x),lower=[],upper=[];
  for(const p of sorted){while(lower.length>=2&&cross(lower.at(-2),lower.at(-1),p)<=0)lower.pop();lower.push(p);}
  for(const p of [...sorted].reverse()){while(upper.length>=2&&cross(upper.at(-2),upper.at(-1),p)<=0)upper.pop();upper.push(p);}
  return{points:[...lower.slice(0,-1),...upper.slice(0,-1)].map(p=>center.map((x,i)=>x+p.x*u[i]+p.y*w[i])),error,normal};
}

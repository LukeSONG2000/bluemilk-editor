// Camera metadata and explicit capture via an already-loaded RenderDoc API.
// ABI from bundled RenderDoc 1.46 renderdoc_app.h, compatible v1.6 pointer table.
globalThis.captureGraphicsFrame=(request)=>{
 let stage='module';
 try{
 const module=Process.findModuleByName('renderdoc.dll');
 if(!module)throw Error('RenderDoc must be loaded before graphics initialization');
 const output=Memory.alloc(Process.pointerSize);output.writePointer(ptr(0));
 const getApi=new NativeFunction(module.getExportByName('RENDERDOC_GetAPI'),'int',['int','pointer']);
 stage='GetAPI';if(getApi(10600,output)!==1)throw Error('RenderDoc API 1.6 unavailable');
 const api=output.readPointer();if(api.isNull())throw Error('Null RenderDoc API');
 const fn=(index,result,args)=>new NativeFunction(api.add(index*Process.pointerSize).readPointer(),result,args);
 stage='GetNumCaptures';const count=fn(13,'uint',[])();
 stage='GetCaptureFilePathTemplate';const template=fn(12,'pointer',[])().readUtf8String();
 stage='IsFrameCapturing';const busy=!!fn(20,'uint',[])();
 const captures=[];
 for(let i=Math.max(0,count-4);i<count;i++){
  stage='GetCapture '+i;
  const size=Memory.alloc(4);size.writeU32(0);
  const get=fn(14,'uint',['uint','pointer','pointer','pointer']);
  if(!get(i,ptr(0),size,ptr(0)))throw Error('RenderDoc capture enumeration failed');
  const length=size.readU32();if(!length||length>32768)throw Error('Invalid capture path length');
  const path=Memory.alloc(length);
  if(!get(i,path,size,ptr(0)))throw Error('RenderDoc capture path unavailable');
  captures.push({index:i,path:path.readUtf8String()});
 }
 if(request.action==='graphics-capture'){
  const root=request.allowedRoot?.replace(/\\/g,'/').toLowerCase().replace(/\/$/,'')+'/';
  if(!request.allowedRoot||!template.replace(/\\/g,'/').toLowerCase().startsWith(root)||template.includes('..'))throw Error('Capture template is outside requested logs directory');
  if(busy)throw Error('RenderDoc capture already in progress');
  stage='TriggerCapture';fn(15,'void',[])();
 }
 return {readConfirmed:true,captureRequested:request.action==='graphics-capture',countBefore:count,capturing:busy,
  captures,template,scope:'One queued frame via original RenderDoc API; verify a new RDC before claiming capture success'};
 }catch(error){throw Error('RenderDoc '+stage+': '+String(error));}
};
globalThis.readGraphicsProfile=()=>{
 const R=RuntimeApi,S=SceneApi,errors=[];
 const read=(type,method,object,kind)=>{
  try{const v=S.invoke(type,method,object);return kind==='string'?S.string(v):R.unbox(v,kind);}
  catch(e){errors.push({type,method,error:String(e)});return null;}
 };
 let pipeline=null;
 try{const p=S.invoke('UnityEngine.Rendering.GraphicsSettings','get_currentRenderPipeline',R.nil);pipeline=p.isNull()?'built-in':R.fullName(R.classOf(p));}
 catch(e){errors.push({type:'pipeline',error:String(e)});}
 const device={};
 for(const [name,kind] of [['graphicsDeviceType','i32'],['graphicsDeviceName','string'],['graphicsDeviceVersion','string'],['supportsMotionVectors','bool']])
  device[name]=read('UnityEngine.SystemInfo','get_'+name,R.nil,kind);
 const cameras=S.all('UnityEngine.Camera').map(c=>({name:S.name(c),
  active:read('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(c),'bool'),
  enabled:read('UnityEngine.Behaviour','get_enabled',c,'bool'),
  renderingPath:read('UnityEngine.Camera','get_actualRenderingPath',c,'i32'),
  depthTextureMode:read('UnityEngine.Camera','get_depthTextureMode',c,'i32'),
  allowHDR:read('UnityEngine.Camera','get_allowHDR',c,'bool'),
  allowMSAA:read('UnityEngine.Camera','get_allowMSAA',c,'bool'),
  pixelWidth:read('UnityEngine.Camera','get_pixelWidth',c,'i32'),
  pixelHeight:read('UnityEngine.Camera','get_pixelHeight',c,'i32')}));
 return {readConfirmed:true,readOnly:true,pipeline,device,cameras,
  nvidiaModules:Process.enumerateModules().filter(m=>/^(nvngx|sl[.])/i.test(m.name)).map(m=>m.name),errors,
  scope:'Camera metadata, not GPU buffers. Null means unavailable. Camera flags do not prove effective AA or absence of custom depth/motion resources.'};
};

'use strict';
// Read one small original NGUI nine-slice. No hooks or changes to game objects.
rpc.exports.uisprite=name=>RuntimeApi.runOnMainThreadOnce(()=>{
 const R=RuntimeApi,S=SceneApi,A=R.arg;
 if(typeof name!=='string'||!/^[a-zA-Z0-9_-]{1,96}$/.test(name))throw Error('Invalid sprite name');
 const candidates=S.all('UISprite').filter(s=>S.string(S.invoke('UISprite','get_spriteName',s))===name);
 let atlas=null,data=R.nil;
 if(candidates.length){atlas=S.invoke('UISprite','get_atlas',candidates[0]);data=S.invoke('UISprite','GetAtlasSprite',candidates[0]);}
 else{
  const text=R.api('string_new','pointer',['pointer'])(Memory.allocUtf8String(name)),handle=R.retain(text);
  try{for(const candidate of S.all('UIAtlas')){const found=S.invoke('UIAtlas','GetSprite',candidate,[A.ref(text)],['System.String']);if(!found.isNull()){atlas=candidate;data=found;break;}}}
  finally{R.release(handle);}
 }
 if(data.isNull()||!atlas)throw Error('Original UI sprite is not loaded; open the battle details once');
 const fields={};for(const n of ['x','y','width','height','borderLeft','borderTop','borderRight','borderBottom'])fields[n]=R.readValue(data,n,'i32');
 const {x,y,width,height}=fields;
 if(width<1||height<1||width>512||height>512)throw Error('Original UI sprite exceeds bounds');
 for(let i=0;i<8;i++){const next=R.readRef(atlas,'mReplacement');if(next.isNull())break;atlas=next;}
 const texture=S.invoke('UnityEngine.Material','get_mainTexture',R.readRef(atlas,'material'));
 const w=R.unbox(S.invoke('UnityEngine.Texture','get_width',texture),'i32'),h=R.unbox(S.invoke('UnityEngine.Texture','get_height',texture),'i32');
 if(w>8192||h>8192)throw Error('Original UI atlas exceeds readback limit');
 if(x<0||y<0||x+width>w||y+height>h)throw Error('Original atlas rectangle exceeds bounds');
 const previous=S.invoke('UnityEngine.RenderTexture','get_active',R.nil);let rt=null,copy=null;
 try{
  rt=R.newObject(R.findClass('UnityEngine.RenderTexture'),undefined,[A.value('i32',w),A.value('i32',h),A.value('i32',0)]);
  S.invoke('UnityEngine.Graphics','Blit',R.nil,[A.ref(texture),A.ref(rt)],['UnityEngine.Texture','UnityEngine.RenderTexture']);
  S.invoke('UnityEngine.RenderTexture','set_active',R.nil,[A.ref(rt)]);
  copy=R.newObject(R.findClass('UnityEngine.Texture2D'),undefined,[A.value('i32',width),A.value('i32',height)]);
  const rect=Memory.alloc(16);[x,h-y-height,width,height].forEach((v,i)=>rect.add(i*4).writeFloat(v));
  S.invoke('UnityEngine.Texture2D','ReadPixels',copy,[A.byRef(rect),A.value('i32',0),A.value('i32',0),A.value('bool',false)],['UnityEngine.Rect','System.Int32','System.Int32','System.Boolean']);
  const colors=S.invoke('UnityEngine.Texture2D','GetPixels32',copy,[]);
  if(Number(R.api('array_length','size_t',['pointer'])(colors))!==width*height)throw Error('Unexpected original pixel count');
  const rgba=Array.from(new Uint8Array(colors.add(32).readByteArray(width*height*4)));
  return {name,width,height,rgba,bottomUp:true,nineGrid:[fields.borderLeft,fields.borderTop,fields.borderRight,fields.borderBottom]};
 }finally{
  S.invoke('UnityEngine.RenderTexture','set_active',R.nil,[A.ref(previous)]);
  for(const object of [copy,rt])if(object)S.invoke('UnityEngine.Object','Destroy',R.nil,[A.ref(object)],['UnityEngine.Object']);
 }
});

'use strict';
// Original protobuf APIs. This does not clone BattleDataDO or enter battles.
// WARNING: DeepClone drops struct defaults (Stat id1/ui-1 ->0/0, BucketItem id empty ->null).
// Not a semantically faithful clone; capture must serialize the original input directly.
globalThis.cloneOriginalBattleProto=source=>{
 const R=RuntimeApi,S=SceneApi;
 if(source.isNull()||R.fullName(R.classOf(source))!=='Protos.BattleData')throw Error('Expected original Protos.BattleData');
 const copy=S.invoke('ProtoBuf.Serializer+NonGeneric','DeepClone',R.nil,[R.arg.ref(source)]);
 if(copy.isNull()||copy.equals(source)||R.fullName(R.classOf(copy))!=='Protos.BattleData')throw Error('Original protobuf clone failed');
 const handle=R.retain(copy);
 return {object:copy,release:()=>R.release(handle)};
};
globalThis.serializeOriginalBattleProto=source=>{
 const R=RuntimeApi,S=SceneApi;
 if(source.isNull()||R.fullName(R.classOf(source))!=='Protos.BattleData')throw Error('Expected original Protos.BattleData');
 const stream=R.api('object_new','pointer',['pointer'])(R.findClass('System.IO.MemoryStream')),handle=R.retain(stream);
 try{
  S.invoke('System.IO.MemoryStream','.ctor',stream);
  S.invoke('ProtoBuf.Serializer+NonGeneric','Serialize',R.nil,[R.arg.ref(stream),R.arg.ref(source)]);
  const bytes=S.invoke('System.IO.MemoryStream','ToArray',stream);
  const size=R.api('array_length','size_t',['pointer'])(bytes).toNumber();
  if(size>16*1024*1024)throw Error('Battle proto exceeds capture limit');
  return bytes.add(32).readByteArray(size);
 }finally{try{S.invoke('System.IO.Stream','Close',stream);}finally{R.release(handle);}}
};

globalThis.deserializeOriginalRuntimeProto=(bytes,type)=>{
 const R=RuntimeApi,S=SceneApi;
 if(!['Protos.BattleData','Protos.Inventory','Protos.UnitDef'].includes(type))throw Error('Unsupported runtime proto type');
 if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>16*1024*1024)throw Error('Invalid battle proto bytes');
 const array=R.api('array_new','pointer',['pointer','size_t'])(R.findClass('System.Byte'),bytes.length),arrayHandle=R.retain(array);
 const stream=R.api('object_new','pointer',['pointer'])(R.findClass('System.IO.MemoryStream')),streamHandle=R.retain(stream);
 try{
  array.add(32).writeByteArray(bytes);
  S.invoke('System.IO.MemoryStream','.ctor',stream,[R.arg.ref(array)],['System.Byte[]']);
  const object=S.invoke('ProtoBuf.Serializer+NonGeneric','Deserialize',R.nil,[R.arg.ref(S.type(type)),R.arg.ref(stream)]);
  if(object.isNull()||R.fullName(R.classOf(object))!==type)throw Error('Original protobuf deserialization failed');
  const handle=R.retain(object);
  return {object,release:()=>R.release(handle)};
 }finally{try{S.invoke('System.IO.Stream','Close',stream);}finally{R.release(streamHandle);R.release(arrayHandle);}}
};

globalThis.deserializeOriginalBattleProto=bytes=>deserializeOriginalRuntimeProto(bytes,'Protos.BattleData');
globalThis.deserializeOriginalInventoryProto=bytes=>deserializeOriginalRuntimeProto(bytes,'Protos.Inventory');

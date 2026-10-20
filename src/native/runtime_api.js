'use strict';
// Concatenate before a root-owned Frida experiment. Defines helpers only: no
// hooks, business-method invocation, account serialization, or sends on load.
globalThis.RuntimeApi = (() => {
  const module = Process.getModuleByName('GameAssembly.dll'), P = Process.pointerSize;
  if (P !== 8) throw Error('This observed client contract requires a 64-bit process');
  const nil = ptr(0), cache = new Map();
  function api(name, result, args) {
    const key = name + ':' + result + ':' + args.join(',');
    if (!cache.has(key)) cache.set(key, new NativeFunction(module.getExportByName('il2cpp_' + name), result, args));
    return cache.get(key);
  }
  // Metadata is immutable within this IL2CPP script session. Cache successful
  // resolutions only; never cache instances, mutable field values or results.
  const classCache=new Map(),fieldCache=new Map(),methodCache=new Map(),nameCache=new Map();
  const referenceCache=new Map(),valueTypeCache=new Map(),flagsCache=new Map(),arityCache=new Map();
  const utf = text => Memory.allocUtf8String(text);
  const number = value => typeof value === 'number' ? value : value.toNumber();
  function required(pointer, description) { if (!pointer || pointer.isNull()) throw Error(description + ' is null'); return pointer; }
  const classOf = object => api('object_get_class','pointer',['pointer'])(required(object,'object'));
  function fullName(klass) {
    required(klass,'class');
    const key=klass.toString();if(nameCache.has(key))return nameCache.get(key);
    const name = api('class_get_name','pointer',['pointer'])(klass).readUtf8String();
    const outer = api('class_get_declaring_type','pointer',['pointer'])(klass);
    if (!outer.isNull()){const value=fullName(outer)+'+'+name;nameCache.set(key,value);return value;}
    const ns = api('class_get_namespace','pointer',['pointer'])(klass).readUtf8String();
    const value=ns?ns+'.'+name:name;nameCache.set(key,value);return value;
  }
  let classes,classIndex;
  function allClasses(refresh = false) {
    if (classes && !refresh) return classes;
    classCache.clear();
    const count = Memory.alloc(P), domain = api('domain_get','pointer',[])();
    const assemblies = api('domain_get_assemblies','pointer',['pointer','pointer'])(domain,count);
    const rows = [];
    for (let i=0;i<number(count.readU64());i++) {
      const image = api('assembly_get_image','pointer',['pointer'])(assemblies.add(i*P).readPointer());
      const imageName = api('image_get_name','pointer',['pointer'])(image).readUtf8String();
      const length = number(api('image_get_class_count','size_t',['pointer'])(image));
      for (let j=0;j<length;j++) {
        const klass = api('image_get_class','pointer',['pointer','size_t'])(image,j);
        if (!klass.isNull()) rows.push({klass,image,imageName,name:fullName(klass)});
      }
    }
    classIndex=new Map();
    for(const row of rows){const entries=classIndex.get(row.name)||[];entries.push(row);classIndex.set(row.name,entries);}
    classes = rows; return rows;
  }
  function findClass(name, imageName) {
    const normalized=name.replace(/\//g,'+'),key=JSON.stringify([normalized,imageName||null]);
    if(classCache.has(key))return classCache.get(key);
    allClasses();
    const entries=classIndex.get(normalized)||[];
    const matches=imageName?entries.filter(c=>c.imageName===imageName):entries;
    if (matches.length!==1) throw Error('Class must resolve uniquely: '+name+' matches='+matches.length);
    classCache.set(key,matches[0].klass);return matches[0].klass;
  }
  function field(klass, name) {
    const key=JSON.stringify([klass.toString(),name]);if(fieldCache.has(key))return fieldCache.get(key);
    for (let c=klass;!c.isNull();c=api('class_get_parent','pointer',['pointer'])(c)) {
      const f=api('class_get_field_from_name','pointer',['pointer','pointer'])(c,utf(name));
      if (!f.isNull()){fieldCache.set(key,f);return f;}
    }
    throw Error('Field absent: '+fullName(klass)+'.'+name);
  }
  function fieldType(f) { return api('field_get_type','pointer',['pointer'])(f); }
  function isReference(f) {
    const key=f.toString();if(referenceCache.has(key))return referenceCache.get(key);
    const value=computeIsReference(f);referenceCache.set(key,value);return value;
  }
  function computeIsReference(f) {
    const type=fieldType(f),kind=api('type_get_type','int',['pointer'])(type);
    if ([0x0e,0x12,0x14,0x1c,0x1d].includes(kind)) return true;
    if (kind===0x15) return !api('class_is_valuetype','bool',['pointer'])(api('class_from_type','pointer',['pointer'])(type));
    return false;
  }
  function fieldFlags(f){
    const key=f.toString();if(!flagsCache.has(key))flagsCache.set(key,api('field_get_flags','uint',['pointer'])(f));return flagsCache.get(key);
  }
  function fieldBuffer(object, f, bytes) {
    const buffer=Memory.alloc(bytes);
    const flags=fieldFlags(f);
    if (flags & 0x10) api('field_static_get_value','void',['pointer','pointer'])(f,buffer);
    else api('field_get_value','void',['pointer','pointer','pointer'])(required(object,'field owner'),f,buffer);
    return buffer;
  }
  function readRef(object,name,staticClass) {
    const f=field(staticClass || classOf(object),name);
    if (!isReference(f)) throw Error('Not a reference field: '+name);
    return fieldBuffer(object,f,P).readPointer();
  }
  const primitives={bool:[1,'readU8','writeU8'],i8:[1,'readS8','writeS8'],u8:[1,'readU8','writeU8'],
    i16:[2,'readS16','writeS16'],u16:[2,'readU16','writeU16'],i32:[4,'readS32','writeS32'],u32:[4,'readU32','writeU32'],
    i64:[8,'readS64','writeS64'],u64:[8,'readU64','writeU64'],f32:[4,'readFloat','writeFloat'],f64:[8,'readDouble','writeDouble']};
  function primitive(kind) { if (!primitives[kind]) throw Error('Unknown primitive '+kind); return primitives[kind]; }
  function checkValueField(f, kind) {
    const key=JSON.stringify([f.toString(),kind]);if(valueTypeCache.has(key))return;
    if(isReference(f)) throw Error('Cannot interpret a managed reference as '+kind);
    let type=fieldType(f),c=api('class_from_type','pointer',['pointer'])(type);
    if(api('class_is_enum','bool',['pointer'])(c)) type=api('class_enum_basetype','pointer',['pointer'])(c);
    const code=api('type_get_type','int',['pointer'])(type);
    const mapped={2:'bool',4:'i8',5:'u8',6:'i16',7:'u16',8:'i32',9:'u32',10:'i64',11:'u64',12:'f32',13:'f64'};
    if(mapped[code]!==kind) throw Error('Field primitive mismatch: native type='+code+' requested='+kind);
    valueTypeCache.set(key,true);
  }
  function readValue(object,name,kind,staticClass) {
    const f=field(staticClass || classOf(object),name);checkValueField(f,kind);
    const p=primitive(kind),value=fieldBuffer(object,f,p[0])[p[1]]();return kind==='bool'?value!==0:value;
  }
  function setField(object,f,buffer) {
    if(fieldFlags(f)&0x10) api('field_static_set_value','void',['pointer','pointer'])(f,buffer);
    else api('field_set_value','void',['pointer','pointer','pointer'])(required(object,'field owner'),f,buffer);
  }
  function writeRef(object,name,value,staticClass) {
    const f=field(staticClass || classOf(object),name);if(!isReference(f))throw Error('Not reference field '+name);
    // Unity 6000.3.17f1 libil2cpp/vm/Field.cpp: SetValue/StaticSetValue call
    // SetValueRaw(..., deref_pointer=false). References are the value itself,
    // unlike primitive fields which receive an address of their value.
    setField(object,f,value || nil);
  }
  function writeValue(object,name,kind,value,staticClass) {
    const f=field(staticClass || classOf(object),name);checkValueField(f,kind);
    const p=primitive(kind),buffer=Memory.alloc(p[0]);buffer[p[2]](kind==='bool'?(value?1:0):value);setField(object,f,buffer);
  }
  function findMethod(klass,name,count,parameterTypes) {
    const key=JSON.stringify([klass.toString(),name,count??null,parameterTypes??null]);
    if(methodCache.has(key))return methodCache.get(key);
    const candidates=[],it=Memory.alloc(P);it.writePointer(nil);
    let m;
    while(!(m=api('class_get_methods','pointer',['pointer','pointer'])(klass,it)).isNull()) {
      if(api('method_get_name','pointer',['pointer'])(m).readUtf8String()!==name)continue;
      const n=api('method_get_param_count','uint',['pointer'])(m);if(count!==undefined && n!==count)continue;
      if(parameterTypes && parameterTypes.some((t,i)=>api('type_get_name','pointer',['pointer'])(api('method_get_param','pointer',['pointer','uint'])(m,i)).readUtf8String()!==t))continue;
      candidates.push(m);
    }
    if(candidates.length!==1)throw Error('Method must resolve uniquely '+fullName(klass)+'.'+name+' matches='+candidates.length);
    methodCache.set(key,candidates[0]);return candidates[0];
  }
  const arg={ref:value=>({kind:'ref',value:value||nil}),value:(kind,value)=>({kind,value}),
    byRef:address=>({kind:'byRef',value:address})};
  function invoke(method,object,args=[]) {
    const key=method.toString();if(!arityCache.has(key))arityCache.set(key,api('method_get_param_count','uint',['pointer'])(method));
    if(arityCache.get(key)!==args.length)throw Error('Invocation argument count mismatch');
    const params=Memory.alloc(Math.max(1,args.length)*P),keep=[];
    args.forEach((a,i)=>{
      if(a.kind==='ref'||a.kind==='byRef')params.add(i*P).writePointer(a.value);
      else {const p=primitive(a.kind),value=Memory.alloc(p[0]);value[p[2]](a.kind==='bool'?(a.value?1:0):a.value);keep.push(value);params.add(i*P).writePointer(value);}
    });
    const exception=Memory.alloc(P);exception.writePointer(nil);
    let result;
    try{result=api('runtime_invoke','pointer',['pointer','pointer','pointer','pointer'])(method,object||nil,params,exception);}
    catch(cause){
      let target=method.toString();
      try{target=fullName(api('method_get_class','pointer',['pointer'])(method))+'.'+api('method_get_name','pointer',['pointer'])(method).readUtf8String();}catch{}
      const error=Error('Native invocation failed: '+target+'; '+String(cause));
      error.nativeInvocation=target;error.cause=cause;throw error;
    }
    const ex=exception.readPointer();
    if(!ex.isNull()) {const error=Error('Managed exception type: '+fullName(classOf(ex)));error.managedException=ex;throw error;}
    return result; // value returns are boxed; explicit unbox below
  }
  function unbox(object,kind) {const p=primitive(kind);return api('object_unbox','pointer',['pointer'])(required(object,'boxed return'))[p[1]]();}
  const handles=new Set();
  function retain(object) {
    if(!object || object.isNull())return 0;
    // Unity 6000.3.17f1 il2cpp-api-types.h: Il2CppGCHandle is void*, not uint32.
    const handle=api('gchandle_new','pointer',['pointer','bool'])(object,0);handles.add(handle);return handle;
  }
  function release(handle) {if(handles.delete(handle))api('gchandle_free','void',['pointer'])(handle);}
  function releaseAll() {for(const handle of [...handles])release(handle);}
  function newObject(klass,constructor,args=[]) {
    const object=required(api('object_new','pointer',['pointer'])(klass),'allocated object');
    const handle=retain(object);
    try {invoke(constructor || findMethod(klass,'.ctor',args.length),object,args);return object;}
    catch(error){release(handle);throw error;}
  }
  function bindings() {
    const injector=readRef(nil,'_instance',findClass('Injector'));
    const binder=readRef(required(injector,'Injector instance'),'_binder');
    const dictionary=readRef(binder,'_typeMap'),entries=readRef(dictionary,'_entries');
    if(entries.isNull())return [];
    const element=api('class_get_element_class','pointer',['pointer'])(classOf(entries));
    const stride=api('class_value_size','int',['pointer','pointer'])(element,Memory.alloc(4));
    const offset=f=>number(api('field_get_offset','size_t',['pointer'])(field(element,f)))-2*P;
    const vo=offset('value'),ko=offset('key');
    if(vo<0 || ko<0 || vo+P>stride || ko+P>stride)throw Error('Dictionary entry layout mismatch');
    // This client's exports omit array_addr_with_size. The observed 64-bit
    // Il2CppArray layout is klass/monitor/bounds/max_length/data at 0/8/16/24/32,
    // independently used by inspect_bindings.js against this same live build.
    const length=number(api('array_length','size_t',['pointer'])(entries));
    const headerLength=number(entries.add(24).readU64());
    const n=readValue(dictionary,'_count','i32'),rows=[];
    if(!Number.isSafeInteger(length) || length<0 || length!==headerLength ||
       !Number.isSafeInteger(stride) || stride<=0 || stride>0x10000 ||
       n<0 || n>length || !Number.isSafeInteger(length*stride))
      throw Error('Dictionary array length/stride boundary mismatch');
    const data=entries.add(32);
    for(let i=0;i<n;i++){
      const byteOffset=i*stride;
      if(byteOffset<0 || byteOffset+stride>length*stride)throw Error('Dictionary entry outside array');
      const entry=data.add(byteOffset);
      const binding=entry.add(vo).readPointer(),key=entry.add(ko).readPointer();if(binding.isNull()||key.isNull())continue;
      const instance=readRef(binding,'_instance');if(instance.isNull())continue;
      const keyClass=api('class_from_system_type','pointer',['pointer'])(key);
      rows.push({boundType:fullName(required(keyClass,'binding key class')),instanceType:fullName(classOf(instance)),instance,binding});
    }
    return rows;
  }
  function findBound(name) {
    // Ask the existing Type -> binding dictionary directly. Read the current
    // injector, dictionary and instance on every call, including scene changes.
    // Interface-bound implementations retain the original fallback below.
    let klass;
    try{klass=findClass(name);}catch(error){if(!String(error).includes('Class must resolve uniquely:'))throw error;}
    if(klass){
      const injector=readRef(nil,'_instance',findClass('Injector'));
      const binder=readRef(required(injector,'Injector instance'),'_binder');
      const dictionary=readRef(binder,'_typeMap');
      const type=api('type_get_object','pointer',['pointer'])(api('class_get_type','pointer',['pointer'])(klass));
      const output=Memory.alloc(P);output.writePointer(nil);
      const found=unbox(invoke(findMethod(classOf(dictionary),'TryGetValue',2),dictionary,[arg.ref(type),arg.byRef(output)]),'bool');
      if(found){
        const binding=output.readPointer();
        if(!binding.isNull()){
          const instance=readRef(binding,'_instance');if(!instance.isNull())return instance;
        }
      }
    }
    const rows=bindings(),exact=rows.filter(r=>r.boundType===name),found=exact.length?exact:rows.filter(r=>r.instanceType===name);
    const unique=[...new Map(found.map(r=>[r.instance.toString(),r])).values()];
    if(unique.length!==1)throw Error('Bound instance must resolve uniquely: '+name+' matches='+unique.length);
    return unique[0].instance;
  }
  const mainThreadJobs=new Set();
  let dispatcherHook=null,dispatching=false;
  function runOnMainThreadOnce(callback,timeoutMs=15000) {
    // Keep one interceptor for the script lifetime. Repeated attach/detach from
    // inside the dispatcher callback is unsuitable for a continuous observer.
    if(!dispatcherHook){
      const method=findMethod(findClass('MainThreadDispatcher'),'ProcessActions',0),address=method.readPointer();
      if(!address.equals(module.base.add(0x116d220)))throw Error('Dispatcher MethodInfo/RVA mismatch');
      dispatcherHook=Interceptor.attach(address,{onLeave(){
        if(dispatching)return;dispatching=true;
        try{
          for(const job of [...mainThreadJobs]){
            if(!mainThreadJobs.delete(job))continue;
            clearTimeout(job.timer);
            try{job.resolve(job.callback());}catch(error){job.reject(error);}
          }
        }finally{dispatching=false;}
      }});
    }
    return new Promise((resolve,reject)=>{
      const job={callback,resolve,reject,timer:null};
      job.timer=setTimeout(()=>{
        if(mainThreadJobs.delete(job))reject(Error('Original main-thread dispatcher did not tick'));
      },timeoutMs);
      mainThreadJobs.add(job);
    });
  }
  return {module,nil,api,classOf,fullName,allClasses,findClass,field,readRef,readValue,writeRef,writeValue,
    findMethod,arg,invoke,unbox,newObject,bindings,findBound,runOnMainThreadOnce,retain,release,releaseAll,
    string:text=>{const object=api('string_new','pointer',['pointer'])(utf(text));retain(object);return object;}};
})();

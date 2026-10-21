"""Compile verified package-local CommonJS sources without evaluating them."""
import json


def bundle(archive, manifest):
    files = {name: archive.read(name).decode('utf-8') for name in manifest['files']
             if name.endswith(('.js', '.json'))}
    if len(files) == 1:
        return files[manifest['entry']]
    prefix = '// BlueMilkModules:' + json.dumps(files, ensure_ascii=True) + '\n'
    return prefix + '''const packageFiles = %s, cache = Object.create(null);
function load(name) {
 if (!Object.prototype.hasOwnProperty.call(packageFiles,name)) throw Error('Package module absent: '+name);
 if (cache[name]) return cache[name].exports;
 const item={exports:{}};cache[name]=item;
 if(name.endsWith('.json')) {item.exports=JSON.parse(packageFiles[name]);return item.exports;}
 const require=request=>{
  if(typeof request!=='string'||!request.startsWith('.'))throw Error('Only package-relative modules are supported');
  const parts=name.split('/').slice(0,-1);
  for(const part of request.split('/')) {
   if(part==='.'||part==='')continue;
   if(part==='..'){if(!parts.length)throw Error('Package module escapes root');parts.pop();}
   else parts.push(part);
  }
  const target=parts.join('/');
  const found=[target,target+'.js',target+'.json'].find(p=>Object.prototype.hasOwnProperty.call(packageFiles,p));
  if(!found)throw Error('Package module absent: '+request);
  return load(found);
 };
 new Function('module','exports','require',packageFiles[name]+'\\n//# sourceURL=bluemilk/'+name)(item,item.exports,require);
 return item.exports;
}
module.exports=load(%s);
''' % (json.dumps(files, ensure_ascii=True), json.dumps(manifest['entry']))

import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const text=fs.readFileSync(new URL('./runtime_api.js',import.meta.url),'utf8');
const source=text.slice(text.indexOf('  function invoke('),text.indexOf('  function unbox('));
const nil={isNull:()=>true};
let fail=false,metadataFail=false;
const c=vm.createContext({P:8,nil,arityCache:new Map(),Memory:{alloc:()=>({writePointer(){},readPointer:()=>nil})},
 fullName:()=>{if(metadataFail)throw Error('metadata unavailable');return 'StateController';},
 api:name=>({method_get_param_count:()=>0,runtime_invoke:()=>{if(fail)throw Error('system error');return 42;},
 method_get_class:()=>null,method_get_name:()=>({readUtf8String:()=> 'EnterState'})})[name]});
vm.runInContext(source,c);
const method={toString:()=> '0x123'};
assert.equal(c.invoke(method,nil),42);
fail=true;
assert.throws(()=>c.invoke(method,nil),error=>error.nativeInvocation==='StateController.EnterState'&&error.cause.message==='system error');
metadataFail=true;
assert.throws(()=>c.invoke(method,nil),/0x123; Error: system error/);
assert.throws(()=>c.invoke(method,nil,[{}]),/argument count/);
console.log('PASS native invocation diagnostics preserve success and cause, tolerate unavailable method metadata');

import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const context = vm.createContext({rpc:{exports:{}}});
vm.runInContext(fs.readFileSync(new URL('../sdk/mod_runtime.js', import.meta.url), 'utf8'), context);
const manifest = JSON.parse(fs.readFileSync(new URL('../examples/lifecycle/mod.json', import.meta.url), 'utf8'));
const source = fs.readFileSync(new URL('../examples/lifecycle/main.js', import.meta.url), 'utf8');
const mods = context.BlueMilkMods;
assert.equal(mods.registerPackage(manifest, source, 'a'.repeat(64)).state, 'disabled');
for (let i = 0; i < 2; i++) {
  assert.equal((await mods.command('enable', {id:manifest.id})).state, 'enabled');
  assert.equal((await mods.command('disable', {id:manifest.id})).state, 'disabled');
}
assert.equal((await mods.shutdown()).stopped, true);
console.log('PASS example registration and two lifecycle cycles (isolated, no game)');

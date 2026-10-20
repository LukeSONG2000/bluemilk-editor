import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual factory with an original one-node failure-chain fixture.
// This tests resource ownership, not the game's evaluator or RNG semantics.
const source = fs.readFileSync(new URL('../src/native/original_ai_priority.js', import.meta.url), 'utf8');
function fixture(failures) {
  class Ref {
    constructor(fields = {}) { this.fields = fields; }
    equals(other) { return this === other; }
    readPointer() { return this; }
  }
  const nil = new Ref();
  const success = new Ref(), failure = new Ref({ _nextNode: nil });
  const node = new Ref({ '<SuccessResult>k__BackingField': success, '<FailureResult>k__BackingField': failure });
  const tree = new Ref({ _rootNode: node });
  const context = new Ref({ '<GameDataDomainController>k__BackingField': new Ref({ _abilityDecisionTreeDO: tree }) });
  const graph = { root: 0, evaluateBasic: true, nodes: [{ success: { next: null }, failure: { next: null } }] };
  let detachAttempts = 0, callback;
  const runtime = {
    nil, arg: { ref: x => x, value: (_type, x) => x },
    readRef: (p, f) => p.fields[f] ?? nil,
    readValue: (p, f) => p.fields[f] ?? 0,
    writeRef: (p, f, v) => { p.fields[f] = v; },
    writeValue: (p, f, _type, v) => { p.fields[f] = v; },
    findClass: name => name,
    findMethod: () => new Ref(),
    newObject: (type, _ctor, args) => new Ref(type === 'AbilityDecisionTreeDO' ? { _rootNode: args[1] } : {}),
    classOf: () => 'BattleUnitController', invoke: () => 1, unbox: x => x,
  };
  const scope = {
    RuntimeApi: runtime, readOriginalAITree: () => ({ graph }),
    Interceptor: { attach(_address, hooks) {
      callback = hooks.onEnter;
      return { detach() { detachAttempts++; if (detachAttempts <= failures) throw Error('detach failed'); } };
    } },
  };
  vm.runInNewContext(source, scope);
  const handle = scope.installOriginalAIPriority(context, [0]);
  const controller = new Ref({ _battleContext: context });
  const aiContext = new Ref({ Self: new Ref() });
  function enter() {
    const args = [controller, node, aiContext];
    callback(args);
    return args[1] !== node;
  }
  return { handle, enter, attempts: () => detachAttempts };
}

for (const failures of [0, 1, 3]) {
  const f = fixture(failures);
  assert.equal(f.enter(), true, 'active override substitutes the private root');
  for (let i = 0; i < failures; i++) {
    assert.throws(() => f.handle.stop(), /detach failed/);
    assert.equal(f.enter(), false, 'failed cleanup must already stop substitutions');
    assert.equal(f.attempts(), i + 1);
  }
  f.handle.stop();
  assert.equal(f.enter(), false);
  assert.equal(f.attempts(), failures + 1, 'cleanup retries until detach succeeds');
  f.handle.stop();
  assert.equal(f.attempts(), failures + 1, 'successful cleanup is idempotent');
}
console.log('AI priority cleanup: success, repeated detach failures, inert callbacks, retry and idempotency passed');

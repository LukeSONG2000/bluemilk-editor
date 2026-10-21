import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/native/original_ai_trace.js', import.meta.url), 'utf8');
function fixture({ attachFailure = 0, detachFailure = 0 } = {}) {
  let installed = 0, failed = false, reads = 0;
  const callbacks = [], detached = [], attempts = [];
  const scope = {
    RuntimeApi: { arg: {}, findClass: x => x, findMethod: () => ({ readPointer: () => 1 }),
      readRef() { reads++; throw Error('unexpected read after stopping'); } },
    SceneApi: {},
    Interceptor: { attach(_address, handlers) {
      const id = ++installed;
      if (id === attachFailure) throw Error('attach failure');
      callbacks.push(handlers);
      return { detach() {
        attempts.push(id);
        if (id === detachFailure && !failed) { failed = true; throw Error('detach failure'); }
        detached.push(id);
      } };
    } },
  };
  vm.runInNewContext(source, scope);
  return { scope, callbacks, detached, attempts, reads: () => reads,
    install: () => scope.installOriginalAITrace({}, {}) };
}
function checkStoppedCallbacks(f) {
  for (const handlers of f.callbacks) {
    // Simulate callbacks queued before stopping; they must not inspect native data.
    handlers.onEnter?.call({}, [null]);
    handlers.onLeave?.call({ row: {} }, null);
  }
  assert.equal(f.reads(), 0);
}

const success = fixture();
const a = success.install();
a.stop(); a.stop();
assert.deepEqual(success.detached, [4, 3, 2, 1]);
checkStoppedCallbacks(success);

const retry = fixture({ detachFailure: 3 });
const b = retry.install();
assert.throws(() => b.stop(), /detach failure/);
assert.deepEqual(retry.detached, [4]);
checkStoppedCallbacks(retry);
b.stop(); b.stop();
assert.deepEqual(retry.attempts, [4, 3, 3, 2, 1]);
assert.deepEqual(retry.detached, [4, 3, 2, 1]);

for (const attachFailure of [1, 2, 3, 4]) {
  const f = fixture({ attachFailure });
  assert.throws(f.install, error => {
    assert.match(error.message, /attach failure/);
    assert.equal(error.cleanupHandle, undefined, 'successful rollback needs no retained handle');
    return true;
  });
  assert.deepEqual(f.detached, Array.from({ length: attachFailure - 1 }, (_, i) => attachFailure - 1 - i));
  checkStoppedCallbacks(f);
}

const partial = fixture({ attachFailure: 3, detachFailure: 2 });
let installationError;
try { partial.install(); } catch (error) { installationError = error; }
assert.match(installationError.message, /attach failure/);
assert.match(installationError.cleanupError, /detach failure/);
assert.equal(typeof installationError.cleanupHandle.stop, 'function');
checkStoppedCallbacks(partial);

// Execute the actual owning trial's handoff block, not a second implementation.
const probe = fs.readFileSync(new URL('../src/native/probe_visual.js', import.meta.url), 'utf8');
const start = probe.indexOf('   if(options.traceAI)try{');
const end = probe.indexOf('\n   }', probe.indexOf('    throw error;', start)) + '\n   }'.length;
assert.ok(start >= 0 && end > start);
const owner = { options: { traceAI: true }, f: { context: {} },
  installOriginalAITrace() { throw installationError; } };
assert.throws(() => vm.runInNewContext(probe.slice(start, end), owner), /attach failure/);
assert.equal(owner.trialAITrace, installationError.cleanupHandle);
owner.trialAITrace.stop(); owner.trialAITrace.stop();
assert.deepEqual(partial.attempts, [2, 2, 1]);
assert.deepEqual(partial.detached, [2, 1]);
console.log('AI trace cleanup: reverse stop, partial attach rollback, retry, inert callbacks and owner handoff passed');

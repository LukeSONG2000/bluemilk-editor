'use strict';
// Read on demand through the loader; no polling, hooks, navigation or battle input.
module.exports = sdk => {
  let lifecycle = 'enabled';
  return {
    ready: Promise.resolve(),
    status: () => ({ lifecycle }),
    command(name, payload) {
      if (name !== 'snapshot') throw Error('Unknown command');
      return sdk.battle.snapshot(payload);
    },
    stop() { lifecycle = 'stopped'; return { lifecycle }; }
  };
};

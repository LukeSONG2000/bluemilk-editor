'use strict';
// No hooks or game mutations. Every enable creates a fresh lifecycle handle.
module.exports = () => {
  let lifecycle = 'enabled';
  return {
    ready: Promise.resolve(),
    status: () => ({ lifecycle }),
    stop: async () => {
      lifecycle = 'stopped';
      return { lifecycle };
    }
  };
};

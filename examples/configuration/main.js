'use strict';
module.exports = sdk => {
  const config = sdk.config.read();
  // Validate before acquiring resources; the loader stores JSON, not a schema.
  if (config.label !== undefined && typeof config.label !== 'string')
    throw Error('label must be a string');
  let lifecycle = 'enabled';
  return {
    ready: Promise.resolve(),
    status: () => ({ lifecycle, label: config.label ?? 'Hello BlueMilk' }),
    stop: async () => {
      lifecycle = 'stopped';
      return { lifecycle };
    }
  };
};

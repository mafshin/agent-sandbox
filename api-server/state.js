'use strict';

// Shared browser readiness flag.
// Using a module avoids circular imports between index.js and routes/browser.js.
let _ready = false;

module.exports = {
  isBrowserReady: () => _ready,
  setBrowserReady: (value) => { _ready = value; },
};

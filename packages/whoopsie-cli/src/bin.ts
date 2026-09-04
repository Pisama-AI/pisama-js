#!/usr/bin/env node

console.error(
  '@whoopsie/cli is retired and performs no network or repository changes. ' +
    'Install @pisama/cli@0.11.3 or newer and run the equivalent pisama command.',
);
process.exitCode = 1;

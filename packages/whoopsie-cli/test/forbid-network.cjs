const fs = require('node:fs');

function blocked() {
  if (process.env.WHOOPSIE_NETWORK_SENTINEL) {
    fs.appendFileSync(process.env.WHOOPSIE_NETWORK_SENTINEL, 'network-attempt\n');
  }
  throw new Error('retirement tombstone attempted network access');
}

global.fetch = blocked;
for (const name of ['node:http', 'node:https']) {
  const api = require(name);
  api.request = blocked;
  api.get = blocked;
}
const net = require('node:net');
net.connect = blocked;
net.createConnection = blocked;

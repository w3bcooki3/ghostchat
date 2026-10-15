// Local PeerJS signaling server for development and tests.
const { PeerServer } = require('peer');
const port = +process.env.PORT || 9000;
PeerServer({ port, host: '127.0.0.1', path: '/gc', allow_discovery: false }, () => console.log('peer server on', port));

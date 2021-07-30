# `@corestore/networker`
[![Build Status](https://travis-ci.com/andrewosh/corestore-networker.svg?branch=master)](https://travis-ci.com/andrewosh/corestore-networker)

A corestore networking module that uses [hyperswarm](https://github.com/hyperswarm/network) to discovery peers. This module powers the networking portion of the [Hyperspace](https://github.com/hyperspace-org/hyperspace).

Calls to `configure` will not be persisted across restarts, so you'll need to use a separate database that maps discovery keys to network configurations. The Hyperdrive daemon uses [Level](https://github.com/level/level) for this.

Since corestore has an all-to-all replication model (any shared cores between two peers will be automatically replicated), only one connection needs to be maintained per peer. If multiple connections are opened to a single peer as a result of that peer announcing many keys, then these connections will be automatically deduplicated by comparing NOISE keypairs.

### Upgrading from corestore-swarm-networking
This module's going through a major change + a rename as part of our push to develop [Hyperspace](https://github.com/hyperspace-org/hyperspace). With these updates, `@corestore/networker` and Hyperspace's `network` APIs are now interchangeable! 

If you've previously been using `corestore-swarm-networking` and you'd like to upgrade, [`UPGRADE.md`](https://github.com/andrewosh/corestore-swarm-networking/blob/master/UPGRADE.md) explains the changes.

### Installation
```
npm i @corestore/networker
```

### Usage
```js
const Networker = require('@corestore/networker')
const Corestore = require('corestore')
const ram = require('random-access-memory')

const store = new Corestore(ram)
await store.ready()

const networker = new Networker(store)

// Start announcing or lookup up a discovery key on the DHT.
await networker.configure(discoveryKey, { announce: true, lookup: true })

// Stop announcing or looking up a discovery key.
networker.configure(discoveryKey, { announce: false, lookup: false })

// Shut down the swarm (and unnanounce all keys)
await networker.close()
```

### API

#### `const networker = new Networker(corestore, networkingOptions = {})`
Creates a new SwarmNetworker that will open replication streams on the `corestore` instance argument.

`networkOpts` is an options map that can include all [hyperswarm](https://github.com/hyperswarm/hyperswarm) options (which will be passed to the internal swarm instance) as well as:
```js
{
  id: crypto.randomBytes(32), // A randomly-generated peer ID,
  keyPair: HypercoreProtocol.keyPair(), // A NOISE keypair that's used across all connections.
  onauthenticate: (remotePublicKey, cb) => { cb() }, // A NOISE keypair authentication hook
  swarm: hyperswarm(), // A hyperswarm instance to use (e.g., hyperswarm-web in the browser)
}
```

#### `networker.peers`
The list of currently-connected peers. Each Peer object has the form:
```
{
  remotePublicKey: 0xabc..., // The remote peer's NOISE key.
  remoteAddress: '10.23.4...:8080', // The remote peer's host/port.
  type: 'tcp' | 'utp', // The connection type
  stream // The connection's HypercoreProtocol stream
}
```

#### `networker.on('peer-add', peer)`
Emitted when a new connection has been established with `peer`.

#### `networker.on('peer-remove', peer)`
Emitted when `peer`'s connection has been closed.

#### `await networker.configure(discoveryKey, opts = {})`
Join or leave the swarm with the `discoveryKey` argument as the topic.

If this is the first time `configure` has been called, the swarm instance will be created automatically.

Waits for the topic to be fully joined/left before resolving.

`opts` is an options map of network configuration options that can include:
```js
  announce: true, // Announce the discovery key on the swarm
  lookup: true  // Look up the discovery key on the swarm,
  flush: true // Wait for a complete swarm flush before resolving.
```

#### `networker.joined(discoveryKey)`
Returns `true` if that discovery key is being swarmed.

#### `networker.flushed(discoveryKey)`
Returns true if the swarm has discovered and attempted to connect to all peers announcing `discoveryKey`.

#### `networker.listen()`
Starts listening for connections on Hyperswarm's default port.

This is called automatically before the first call to `configure`.

#### `await networker.close()`
Shut down the swarm networker.

This will close all replication streams and then destroy the swarm instance. It will wait for all topics to be unannounced, so it might take some time.

### Swarm Extensions
`@corestore/networker` introduces stream-level extensions that operate on each connection. They adhere to Hypercore's [extension API](https://github.com/hypercore-protocol/hypercore#ext--feedregisterextensionname-handlers).

#### `const ext = await networker.registerExtension(name, { encoding, onmessage, onerror })`
Registers an extension with name `name`.

The `onmessage` and `onerror` handlers are both optional methods. `onerror` is an errback, and `onmessage` must have the signature:

```js
function onmessage (msg, peer) {
  // `msg` is the (optionally-decoded) message that was received from `peer`.
  // `peer` is a `Peer` object (described above in `networker.peers`)
}
```

#### `ext.send(msg, peer)`
Send `msg` (which will optionally be encoded by the extension's encoding opt) to `peer`. `peer` must be a Peer object taken from `networker.peers` or emitted by the networker's `peer-add` event.

#### `ext.broadcast(msg)`
Broadcast `msg` to all currently-connected peers.

#### `ext.destroy()`
Destroy the extension and unregister it from all connections.

### License
MIT

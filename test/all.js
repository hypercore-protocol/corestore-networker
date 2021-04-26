const test = require('tape')
const ram = require('random-access-memory')
const dht = require('@hyperswarm/dht')
const hypercoreCrypto = require('hypercore-crypto')
const HypercoreProtocol = require('hypercore-protocol')
const Corestore = require('corestore')

const CorestoreNetworker = require('..')

const BOOTSTRAP_PORT = 3100
var bootstrap = null

test('simple replication', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()

  const core1 = store1.get()
  const core2 = store2.get(core1.key)

  await networker1.configure(core1.discoveryKey)
  await networker2.configure(core2.discoveryKey)

  await append(core1, 'hello')
  const data = await get(core2, 0)
  t.same(data, Buffer.from('hello'))

  await cleanup([networker1, networker2])
  t.end()
})

test('replicate multiple top-level cores', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()

  const core1 = store1.get()
  const core2 = store1.get()
  const core3 = store2.get(core1.key)
  const core4 = store2.get(core2.key)

  await networker1.configure(core1.discoveryKey)
  await networker1.configure(core2.discoveryKey)
  await networker2.configure(core2.discoveryKey)
  await networker2.configure(core3.discoveryKey)

  await append(core1, 'hello')
  await append(core2, 'world')
  const d1 = await get(core3, 0)
  const d2 = await get(core4, 0)
  t.same(d1, Buffer.from('hello'))
  t.same(d2, Buffer.from('world'))

  await cleanup([networker1, networker2])
  t.end()
})

test('replicate to multiple receivers', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()
  const { store: store3, networker: networker3 } = await create()

  const core1 = store1.get()
  const core2 = store2.get(core1.key)
  const core3 = store3.get(core1.key)

  await networker1.configure(core1.discoveryKey)
  await networker2.configure(core2.discoveryKey)
  await networker3.configure(core3.discoveryKey)

  await append(core1, 'hello')
  const d1 = await get(core2, 0)
  const d2 = await get(core3, 0)
  t.same(d1, Buffer.from('hello'))
  t.same(d2, Buffer.from('hello'))

  await cleanup([networker1, networker2, networker3])
  t.end()
})

test('replicate sub-cores', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()

  const core1 = store1.get()
  const core3 = store2.get(core1.key)

  await networker1.configure(core1.discoveryKey)
  await networker2.configure(core3.discoveryKey)

  const core2 = store1.get({ parents: [core1.key] })
  const core4 = store2.get({ key: core2.key, parents: [core3.key] })

  await append(core1, 'hello')
  await append(core2, 'world')
  const d1 = await get(core3, 0)
  const d2 = await get(core4, 0)
  t.same(d1, Buffer.from('hello'))
  t.same(d2, Buffer.from('world'))

  await cleanup([networker1, networker2])
  t.end()
})

test('can replicate using a custom keypair', async t => {
  const keyPair1 = HypercoreProtocol.keyPair()
  const keyPair2 = HypercoreProtocol.keyPair()
  const { store: store1, networker: networker1 } = await create({ keyPair: keyPair1 })
  const { store: store2, networker: networker2 } = await create({ keyPair: keyPair2 })

  const core1 = store1.get()
  const core3 = store2.get(core1.key)

  await networker1.configure(core1.discoveryKey)
  await networker2.configure(core3.discoveryKey)

  const core2 = store1.get()
  const core4 = store2.get({ key: core2.key })

  await append(core1, 'hello')
  await append(core2, 'world')
  const d1 = await get(core3, 0)
  const d2 = await get(core4, 0)
  t.same(d1, Buffer.from('hello'))
  t.same(d2, Buffer.from('world'))

  {
    const streams = [...networker1.streams]
    t.same(streams[0].remotePublicKey, keyPair2.publicKey)
    t.same(streams[0].publicKey, keyPair1.publicKey)
  }

  {
    const streams = [...networker2.streams]
    t.same(streams[0].remotePublicKey, keyPair1.publicKey)
    t.same(streams[0].publicKey, keyPair2.publicKey)
  }

  await cleanup([networker1, networker2])
  t.end()
})

test('join status only emits flushed after all handshakes', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()
  const { store: store3, networker: networker3 } = await create()

  const core1 = store1.get()
  const core2 = store2.get(core1.key)
  await append(core1, 'hello')

  let join2Flushed = 0
  let join3Flushed = 0
  let join2FlushPeers = 0
  let join3FlushPeers = 0

  // If ifAvail were not blocked, the get would immediately return with null (unless the connection's established immediately).
  await networker1.configure(core1.discoveryKey)
  networker2.on('flushed', dkey => {
    if (!dkey.equals(core1.discoveryKey)) return
    join2Flushed++
    join2FlushPeers = core2.peers.length
  })
  await networker2.configure(core1.discoveryKey)

  const core3 = store3.get(core1.key)
  networker3.on('flushed', (dkey) => {
    if (!dkey.equals(core1.discoveryKey)) return
    join3Flushed++
    join3FlushPeers = core3.peers.length
    allFlushed()
  })
  networker3.configure(core1.discoveryKey)

  async function allFlushed () {
    t.same(join2Flushed, 1)
    t.true(join2FlushPeers >= 1)
    t.same(join3Flushed, 1)
    t.true(join3FlushPeers >= 2)
    await cleanup([networker1, networker2, networker3])
    t.end()
  }
})

test('can destroy multiple times', async t => {
  const { networker } = await create()

  await networker.close()
  await networker.close()
  t.pass('closed successfully')

  await cleanup([networker])
  t.end()
})

test('peers are correctly added/removed', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()
  const { networker: networker3 } = await create()

  const dkey = hypercoreCrypto.randomBytes(32)
  await networker1.configure(dkey)

  const twoJoinsProm = new Promise(resolve => {
    networker1.once('peer-add', peer => {
      t.true(peer.remotePublicKey.equals(networker2.keyPair.publicKey))
      networker1.once('peer-add', peer => {
        t.true(peer.remotePublicKey.equals(networker3.keyPair.publicKey))
        t.same(networker1.peers.size, 2)
        return resolve()
      })
    })
  })

  const twoLeavesProm = new Promise(resolve => {
    networker1.once('peer-remove', peer => {
      t.true(peer.remotePublicKey.equals(networker2.keyPair.publicKey))
      networker1.once('peer-remove', peer => {
        t.true(peer.remotePublicKey.equals(networker3.keyPair.publicKey))
        t.same(networker1.peers.size, 0)
        return resolve()
      })
    })
  })

  await networker2.configure(dkey, { announce: false, lookup: true, flush: true })
  await networker3.configure(dkey, { announce: false, lookup: true, flush: true })

  await new Promise(resolve => setTimeout(resolve, 100))

  await networker2.close()
  await networker3.close()

  await Promise.all([twoJoinsProm, twoLeavesProm])

  await cleanup([networker1])
  t.end()
})

test('can register stream-wide extensions', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()
  const { networker: networker3 } = await create()

  const froms = [networker2.keyPair.publicKey, networker3.keyPair.publicKey]
  const msgs = ['hello', 'world']
  let received = 0

  var onmessage = null
  const allReceivedProm = new Promise(resolve => {
    onmessage = (msg, from) => {
      t.true(from.remotePublicKey.equals(froms[received]))
      t.same(msg, msgs[received])
      received++
      if (received === froms.length) return resolve()
    }
  })

  const extension = {
    name: 'test-extension',
    encoding: 'utf8',
    onmessage
  }
  networker1.registerExtension(extension)
  const n2Ext = networker2.registerExtension(extension)
  const n3Ext = networker3.registerExtension(extension)

  networker2.on('peer-add', peer => {
    n2Ext.send('hello', peer)
  })
  networker3.on('peer-add', peer => {
    n3Ext.send('world', peer)
  })
  const dkey = hypercoreCrypto.randomBytes(32)
  await networker1.configure(dkey)
  await networker2.configure(dkey, { announce: false, lookup: true, flush: true })
  await networker3.configure(dkey, { announce: false, lookup: true, flush: true })

  await new Promise(resolve => setTimeout(resolve, 100))
  await allReceivedProm

  await cleanup([networker1, networker2, networker3])
  t.end()
})

test('can register extensions with the same name', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()
  const { networker: networker3 } = await create()

  const froms = [networker2.keyPair.publicKey, networker3.keyPair.publicKey]
  const msgs = ['hello', 'world']
  let received = 0

  var onmessage = null
  const allReceivedProm = new Promise(resolve => {
    onmessage = (msg, from) => {
      t.true(from.remotePublicKey.equals(froms[received]))
      t.same(msg, msgs[received])
      received++
      if (received === froms.length) return resolve()
    }
  })

  const extensionOne = {
    name: 'test-extension',
    encoding: 'utf8',
    onmessage
  }
  const extensionTwo = {
    name: 'test-extension',
    encoding: 'utf8',
    onmessage
  }
  networker1.registerExtension(extensionOne)
  networker1.registerExtension(extensionTwo)
  const n2Ext = networker2.registerExtension(extensionTwo)
  const n3Ext = networker3.registerExtension(extensionTwo)

  networker2.on('peer-add', peer => {
    n2Ext.send('hello', peer)
  })
  networker3.on('peer-add', peer => {
    n3Ext.send('world', peer)
  })
  const dkey = hypercoreCrypto.randomBytes(32)
  await networker1.configure(dkey)
  await networker2.configure(dkey, { announce: false, lookup: true, flush: true })
  await networker3.configure(dkey, { announce: false, lookup: true, flush: true })

  await new Promise(resolve => setTimeout(resolve, 100))
  await allReceivedProm

  await cleanup([networker1, networker2, networker3])
  t.end()
})

test('can register function based extensions', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()
  const { networker: networker3 } = await create()

  const froms = [networker2.keyPair.publicKey, networker3.keyPair.publicKey]
  const msgs = ['hello', 'world']
  let received = 0

  var onmessage = null
  const allReceivedProm = new Promise(resolve => {
    onmessage = (msg, from) => {
      t.true(from.remotePublicKey.equals(froms[received]))
      t.same(msg, msgs[received])
      received++
      if (received === froms.length) return resolve()
    }
  })

  const extension = (ext) => ({
    encoding: 'utf8',
    onmessage
  })

  // Note: Must use name outside of the function handler for now
  networker1.registerExtension('test-extension', extension)
  const n2Ext = networker2.registerExtension('test-extension', extension)
  const n3Ext = networker3.registerExtension('test-extension', extension)

  networker2.on('peer-add', peer => {
    n2Ext.send('hello', peer)
  })
  networker3.on('peer-add', peer => {
    n3Ext.send('world', peer)
  })
  const dkey = hypercoreCrypto.randomBytes(32)
  await networker1.configure(dkey)
  await networker2.configure(dkey, { announce: false, lookup: true, flush: true })
  await networker3.configure(dkey, { announce: false, lookup: true, flush: true })

  await new Promise(resolve => setTimeout(resolve, 100))
  await allReceivedProm

  await cleanup([networker1, networker2, networker3])
  t.end()
})

test('can use other encodings', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()
  const { networker: networker3 } = await create()

  const froms = [networker2.keyPair.publicKey, networker3.keyPair.publicKey]
  const msgs = [{ message: 'hello' }, { message: 'world' }]
  let received = 0

  var onmessage = null
  const allReceivedProm = new Promise(resolve => {
    onmessage = (msg, from) => {
      t.true(from.remotePublicKey.equals(froms[received]))
      t.same(msg, msgs[received])
      received++
      if (received === froms.length) return resolve()
    }
  })

  const extension = {
    name: 'test-extension',
    encoding: 'json',
    onmessage
  }
  networker1.registerExtension(extension)
  const n2Ext = networker2.registerExtension(extension)
  const n3Ext = networker3.registerExtension(extension)

  networker2.on('peer-add', peer => {
    n2Ext.send({ message: 'hello' }, peer)
  })
  networker3.on('peer-add', peer => {
    n3Ext.send({ message: 'world' }, peer)
  })
  const dkey = hypercoreCrypto.randomBytes(32)
  await networker1.configure(dkey)
  await networker2.configure(dkey, { announce: false, lookup: true, flush: true })
  await networker3.configure(dkey, { announce: false, lookup: true, flush: true })

  await new Promise(resolve => setTimeout(resolve, 100))
  await allReceivedProm

  await cleanup([networker1, networker2, networker3])
  t.end()
})

test('bidirectional extension send/receive', async t => {
  const { networker: networker1 } = await create()
  const { networker: networker2 } = await create()

  var firstReceivedProm = null
  var secondReceivedProm = null

  {
    let onmessage = null
    let ext = null

    firstReceivedProm = new Promise(resolve => {
      onmessage = (msg, from) => {
        t.true(from.remotePublicKey.equals(networker2.keyPair.publicKey))
        t.same(msg, 'hello')
        ext.send('world', from)
        return resolve()
      }
    })

    ext = networker1.registerExtension({
      name: 'test-extension',
      encoding: 'utf8',
      onmessage
    })
  }

  {
    let onmessage = null
    let ext = null

    secondReceivedProm = new Promise(resolve => {
      onmessage = (msg, from) => {
        t.true(from.remotePublicKey.equals(networker1.keyPair.publicKey))
        t.same(msg, 'world')
        return resolve()
      }
    })

    ext = networker2.registerExtension({
      name: 'test-extension',
      encoding: 'utf8',
      onmessage
    })

    networker2.on('peer-add', peer => {
      ext.send('hello', peer)
    })
  }

  const dkey = hypercoreCrypto.randomBytes(32)
  await networker1.configure(dkey)
  await networker2.configure(dkey, { announce: false, lookup: true, flush: true })

  await new Promise(resolve => setTimeout(resolve, 100))

  await firstReceivedProm
  await secondReceivedProm

  await cleanup([networker1, networker2])
  t.end()
})

test('onauthentication hook', async t => {
  t.plan(2)
  const { networker: networker1 } = await create({
    onauthenticate (peerPublicKey, cb) {
      t.deepEquals(peerPublicKey, networker2.keyPair.publicKey)
      cb()
    }
  })
  const { networker: networker2 } = await create()

  const dkey = hypercoreCrypto.randomBytes(32)
  await networker1.configure(dkey)
  await networker2.configure(dkey)

  await new Promise(resolve => setTimeout(resolve, 100))
  await cleanup([networker1, networker2])
  t.end()
})

async function create (opts = {}) {
  if (!bootstrap) {
    bootstrap = dht({
      bootstrap: false
    })
    bootstrap.listen(BOOTSTRAP_PORT)
    await new Promise(resolve => {
      return bootstrap.once('listening', resolve)
    })
  }
  const store = new Corestore(ram)
  await store.ready()
  const networker = new CorestoreNetworker(store, { ...opts, bootstrap: `localhost:${BOOTSTRAP_PORT}` })
  return { store, networker }
}

function append (core, data) {
  return new Promise((resolve, reject) => {
    core.append(data, err => {
      if (err) return reject(err)
      return resolve()
    })
  })
}

function get (core, idx, opts = {}) {
  return new Promise((resolve, reject) => {
    core.get(idx, opts, (err, data) => {
      if (err) return reject(err)
      return resolve(data)
    })
  })
}

async function cleanup (networkers) {
  for (const networker of networkers) {
    await networker.close()
  }
  if (bootstrap) {
    await bootstrap.destroy()
    bootstrap = null
  }
}

const test = require('tape')
const ram = require('random-access-memory')
const dht = require('@hyperswarm/dht')
const HypercoreProtocol = require('hypercore-protocol')
const Corestore = require('corestore')

const SwarmNetworker = require('..')

const BOOTSTRAP_PORT = 3100
var bootstrap = null

test('simple replication', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()

  const core1 = await store1.get()
  const core2 = await store2.get(core1.key)

  await networker1.join(core1.discoveryKey)
  await networker2.join(core2.discoveryKey)

  await append(core1, 'hello')
  const data = await get(core2, 0)
  t.same(data, Buffer.from('hello'))

  await cleanup([networker1, networker2])
  t.end()
})

test('replicate multiple top-level cores', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()

  const core1 = await store1.get()
  const core2 = await store1.get()
  const core3 = await store2.get(core1.key)
  const core4 = await store2.get(core2.key)

  await networker1.join(core1.discoveryKey)
  await networker1.join(core2.discoveryKey)
  await networker2.join(core2.discoveryKey)
  await networker2.join(core3.discoveryKey)

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

  const core1 = await store1.get()
  const core2 = await store2.get(core1.key)
  const core3 = await store3.get(core1.key)

  await networker1.join(core1.discoveryKey)
  await networker2.join(core2.discoveryKey)
  await networker3.join(core3.discoveryKey)

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

  const core1 = await store1.get()
  const core3 = await store2.get(core1.key)

  await networker1.join(core1.discoveryKey)
  await networker2.join(core3.discoveryKey)

  const core2 = await store1.get({ parents: [core1.key] })
  const core4 = await store2.get({ key: core2.key, parents: [core3.key]})

  await append(core1, 'hello')
  await append(core2, 'world')
  const d1 = await get(core3, 0)
  const d2 = await get(core4, 0)
  t.same(d1, Buffer.from('hello'))
  t.same(d2, Buffer.from('world'))

  await cleanup([networker1, networker2])
  t.end()
})

test('can replication with a custom keypair', async t => {
  const keyPair1 = HypercoreProtocol.keyPair('seed1')
  const keyPair2 = HypercoreProtocol.keyPair('seed2')
  const { store: store1, networker: networker1 } = await create({ keyPair: keyPair1 })
  const { store: store2, networker: networker2 } = await create({ keyPair: keyPair2 })

  const core1 = await store1.get()
  const core3 = await store2.get(core1.key)

  await networker1.join(core1.discoveryKey)
  await networker2.join(core3.discoveryKey)

  const core2 = await store1.get()
  const core4 = await store2.get({ key: core2.key })

  await append(core1, 'hello')
  await append(core2, 'world')
  const d1 = await get(core3, 0)
  const d2 = await get(core4, 0)
  t.same(d1, Buffer.from('hello'))
  t.same(d2, Buffer.from('world'))

  t.same(networker1._replicationStreams[0].remotePublicKey, keyPair2.publicKey)
  t.same(networker1._replicationStreams[0].publicKey, keyPair1.publicKey)
  t.same(networker2._replicationStreams[0].remotePublicKey, keyPair1.publicKey)
  t.same(networker2._replicationStreams[0].publicKey, keyPair2.publicKey)

  await cleanup([networker1, networker2])
  t.end()
})

test.skip('each corestore only opens one connection per peer', async t => {
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
  const store =  new Corestore(ram)
  await store.ready()
  const networker = new SwarmNetworker(store,  { ...opts, bootstrap: `localhost:${BOOTSTRAP_PORT}` })
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
  for (let networker of networkers) {
    await networker.close()
  }
  if (bootstrap) {
    await bootstrap.destroy()
    bootstrap = null
  }
}

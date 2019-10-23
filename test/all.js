const test = require('tape')
const ram = require('random-access-memory')
const Corestore = require('corestore')

const SwarmNetworker = require('..')

test.only('simple replication', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()

  const core1 = await store1.get()
  const core2 = await store2.get(core1.key)
  console.log('after cores')
  networker1.seed(core1.discoveryKey)
  networker2.seed(core2.discoveryKey)

  await append(core1, 'hello')
  // This will fail if ifAvailable: true
  const data = await get(core2, 0, { ifAvailable: false })
  t.same(data, Buffer.from('hello'))

  await cleanup([networker1, networker2])
  t.end()
})

test.skip('each corestore only opens one connection per peer', async t => {
  t.end()
})

async function create () {
  const store =  new Corestore(ram)
  await store.ready()
  const networker = new SwarmNetworker(store, { bootstrap: false })
  networker.listen()
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
    console.log('getting here')
    core.get(idx, opts, (err, data) => {
      console.log('got err:', err, 'data:', data)
      if (err) return reject(err)
      return resolve(data)
    })
  })
}

async function cleanup (networkers) {
  for (let networker of networkers) {
    await networker.close()
  }
}

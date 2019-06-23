const crypto = require('crypto')
const { EventEmitter } = require('events')
const { pipeline } = require('stream')

const datEncoding = require('dat-encoding')
const hypercoreProtocol = require('hypercore-protocol')
const hyperswarm = require('hyperswarm')
const duplexify = require('duplexify')
const pump = require('pump')

const log = require('debug')('corestore:network')

class SwarmNetworker extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.opts = opts
    this.id = opts.id || crypto.randomBytes(32)

    this._swarm = hyperswarm(opts)
    this._replicatorFactory = null
    this._replicationStreams = new Map()

    this._swarm.on('error', err => this.emit('error', err))
    this._swarm.on('connection', (socket, details) => {
      const discoveryKey = details.peer ? details.peer.topic : null
      this._createReplicationStream(discoveryKey, socket)
    })
  }

  _createReplicationStream (discoveryKey, socket) {
    const self = this

    const streamOpts = {
      live: true,
      encrypt: false,
      id: this.id
    }

    var streams
    var replicationStream
    const proxy = duplexify()

    if (discoveryKey) {
      var dkeyString = datEncoding.encode(discoveryKey)
      createStream(discoveryKey, onstream)
    } else {
      replicationStream = hypercoreProtocol(streamOpts)
      proxy.setReadable(replicationStream)
      proxy.setWritable(replicationStream)
      replicationStream.once('feed', discoveryKey => {
        dkeyString = datEncoding.encode(discoveryKey)
        createStream(discoveryKey, replicationStream, onstream)
      })
    }

    pump(socket, proxy, socket, err => {
      if (err) self.emit('replication-error', err)
      return onclose()
    })

    function onstream (err) {
      if (err) return proxy.destroy(err)
      if (proxy.destroyed) return
      if (discoveryKey) {
        proxy.setReadable(replicationStream)
        proxy.setWritable(replicationStream)
      }
    }

    function onclose () {
      if (!streams) return
      const idx = streams.indexOf(replicationStream)
      if (idx !== -1) streams.splice(idx, 1)
    }

    function createStream (discoveryKey, stream, cb) {
      if (typeof stream === 'function') return createStream(discoveryKey, null, stream)

      const keyString = datEncoding.encode(discoveryKey)
      streams = self._replicationStreams.get(keyString)
      if (!self._replicatorFactory) return cb(new Error('The replicator factory must be set prior to announcing.'))

      return self._replicatorFactory(keyString)
        .then(replicate => {
          if (!replicate || !streams) return cb(new Error('The swarm requested a discovery key which is not being seeded.'))

          const innerStream = replicate({ ...streamOpts, stream })
          replicationStream = stream || innerStream
          streams.push(replicationStream)

          return cb(null)
        })
      .catch(cb)
    }
  }

  setReplicatorFactory (replicatorFactory) {
    this._replicatorFactory = replicatorFactory
  }

  seed (discoveryKey) {
    if (this._swarm.destroyed) return

    const keyString = datEncoding.encode(discoveryKey)
    var streams = this._replicationStreams.get(keyString)
    if (streams && streams.length) return

    streams = []
    this._replicationStreams.set(keyString, streams)

    this._swarm.join(discoveryKey, {
      announce: true,
      lookup: true
    })
  }

  unseed (discoveryKey) {
    if (this._swarm.destroyed) return

    if (typeof discoveryKey === 'string') discoveryKey = Buffer.from(discoveryKey, 'hex')
    this._swarm.leave(discoveryKey)

    const keyString = datEncoding.encode(discoveryKey)
    const streams = this._replicationStreams.get(keyString)
    if (!streams || !streams.length) return

    for (let stream of streams) {
      stream.destroy()
    }

    this._replicationStreams.delete(keyString)
  }

  async close () {
    return new Promise((resolve, reject) => {
      for (let [dkey,] of new Map(...[this._replicationStreams])) {
        this.unseed(datEncoding.decode(dkey))
      }
      this._swarm.destroy(err => {
        if (err) return reject(err)
        return resolve()
      })
    })
  }
}

module.exports = SwarmNetworker

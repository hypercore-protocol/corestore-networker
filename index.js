const crypto = require('crypto')
const { EventEmitter } = require('events')
const { pipeline } = require('stream')

const datEncoding = require('dat-encoding')
const hypercoreProtocol = require('hypercore-protocol')
const hyperswarm = require('@hyperswarm/network')
const pump = require('pump')
const duplexify = require('duplexify')

const log = require('debug')('corestore:network')

class SwarmNetworker extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.opts = opts
    this.id = opts.id || crypto.randomBytes(32)

    this._swarm = hyperswarm(opts)
    this._replicationStreams = new Map()
    this._replicators = new Map()

    this._swarm.on('error', err => this.emit('error', err))
    this._swarm.on('connection', (socket, details) => {
      const discoveryKey = details.peer ? details.peer.topic : null
      this._createReplicationStream(discoveryKey, socket)
    })
  }

  _createReplicationStream (discoveryKey, socket) {
    const self = this

    // TODO: Support encrypted replication streams.
    const streamOpts = {
      live: true,
      encrypt: false,
      id: this.id
    }
    var streams

    if (discoveryKey) {
      var dkeyString = datEncoding.encode(discoveryKey)
      var stream = createStream(discoveryKey)
    } else {
      stream = hypercoreProtocol(streamOpts)
      stream.once('feed', discoveryKey => {
        dkeyString = datEncoding.encode(discoveryKey)
        createStream(discoveryKey, stream)
      })
    }

    pump(socket, stream, socket, err => {
      if (err) self.emit('replication-error', err)
      return onclose()
    })

    function onclose () {
      if (!streams) return
      const idx = streams.indexOf(stream)
      if (idx !== -1) streams.splice(idx, 1)
    }

    function createStream (discoveryKey, stream) {
      const keyString = datEncoding.encode(discoveryKey)

      const replicate = self._replicators.get(keyString)
      streams = self._replicationStreams.get(keyString)
      if (!replicate || !streams) throw new Error('The swarm requested a discovery key which is not being seeded.')

      const innerStream = replicate({ ...streamOpts, stream })
      streams.push(stream || innerStream)

      return innerStream
    }
  }

  seed (discoveryKey, replicate) {
    const keyString = datEncoding.encode(discoveryKey)
    const streams = []

    this._replicationStreams.set(keyString, streams)
    this._replicators.set(keyString, replicate)

    this._swarm.join(discoveryKey, {
      announce: true,
      lookup: true
    })
  }

  unseed (discoveryKey) {
    this._swarm.leave(discoveryKey)

    const keyString = datEncoding.encode(discoveryKey)
    const streams = this._replicationStreams.get(keyString)
    if (!streams || !streams.length) return

    for (let stream of streams) {
      stream.destroy()
    }

    this._replicationStreams.delete(keyString)
    this._replicators.delete(keyString)
  }

  async close () {
    return new Promise(resolve => {
      for (let [dkey,] of new Map(...[this._replicators])) {
        this.unseed(datEncoding.decode(dkey))
      }
      this._swarm.discovery.destroy()
      this._swarm.server.close()
      return resolve()
    })
  }
}

module.exports = SwarmNetworker

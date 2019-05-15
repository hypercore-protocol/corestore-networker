const crypto = require('crypto')
const { EventEmitter } = require('events')
const { pipeline } = require('stream')

const datEncoding = require('dat-encoding')
const hypercoreProtocol = require('hypercore-protocol')
const discoverySwarm = require('discovery-swarm')
const swarmDefaults = require('dat-swarm-defaults')
const duplexify = require('duplexify')

const log = require('debug')('corestore:network')

class SwarmNetworker extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.opts = opts
    this.id = opts.id || crypto.randomBytes(32)

    this._swarm = discoverySwarm(swarmDefaults({
      id: this.id,
      hash: false,
      utp: defaultTrue(opts.utp),
      tcp: defaultTrue(opts.tcp),
      dht: defaultTrue(opts.dht),
      stream: this._createReplicationStream.bind(this)
    }))
    this._replicationStreams = new Map()
    this._replicators = new Map()

    this._swarm.listen(opts.port || 3005)
    this._swarm.on('error', err => this.emit('error', err))
  }

  _createReplicationStream (info) {
    const self = this
    const streamOpts = {
      live: true,
      encrypt: false,
      id: this.id
    }

    if (info.channel) {
      const stream = getStream(info.channel) 
      stream.peerInfo = info
      return stream
    } else {
      const proxy = hypercoreProtocol(streamOpts)
      proxy.peerInfo = info
      proxy.once('feed', discoveryKey => {
        getStream(discoveryKey, proxy)
      })
      return proxy
    }

    function getStream (discoveryKey, stream) {
      const keyString = datEncoding.encode(discoveryKey)

      const replicate = self._replicators.get(keyString)
      const streams = self._replicationStreams.get(keyString)
      if (!replicate || !streams) throw new Error('The swarm requested a discovery key which is not being seeded.')

      // TODO: Support encrypted replication streams.
      return replicate({ ...streamOpts, stream })
    }
  }

  ready () {
    return new Promise(resolve => this._swarm.on('listening', resolve))
  }

  seed (discoveryKey, replicate) {
    const keyString = datEncoding.encode(discoveryKey)
    const streams = []

    this._replicationStreams.set(keyString, streams)
    this._replicators.set(keyString, replicate)

    this._swarm.join(discoveryKey)
  }

  unseed (discoveryKey) {
    this._swarm.leave(discoveryKey)

    const keyString = datEncoding.encode(discoveryKey)
    const streams = this._replicationStreams.get(keyString)
    if (!streams) return

    for (let stream of streams) {
      stream.destroy()
    }

    this._replicationStreams.delete(keyString)
    this._replicators.delete(keyString)
  }

  async close () {
    return new Promise((resolve, reject) => {
      this._swarm.destroy(err => {
        if (err) return reject(err)
        return resolve()
      })
    })
  }
}

module.exports = SwarmNetworker

function defaultTrue (x) {
  return x === undefined ? true : x
}

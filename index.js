const crypto = require('crypto')
const { EventEmitter } = require('events')

const datEncoding = require('dat-encoding')
const HypercoreProtocol = require('hypercore-protocol')
const hyperswarm = require('hyperswarm')
const pump = require('pump')

const log = require('debug')('corestore:network')

const OUTER_STREAM = Symbol('corestore-outer-stream')

class SwarmNetworker extends EventEmitter {
  constructor (corestore, opts = {}) {
    super()
    this.corestore = corestore
    this.id = opts.id || crypto.randomBytes(32)
    this.opts = opts

    this._replicationOpts = {
      id: this.id,
      encrypt: true,
      live: true
    }

    this._seeding = new Set()
    this._replicationStreams = []
    this._streamsByDiscoveryKey = new Map()

    // Set in listen
    this._swarm = null
  }

  _handleTopic (protocolStream, discoveryKey) {
    // This is the active replication case -- we're requesting that a particular discovery key be replicated.
    const dkeyString = datEncoding.encode(discoveryKey)
    if (!this._seeding.has(dkeyString)) return
    // The initiator parameter here is ignored, since we're passing in a stream.
    this.corestore.replicate(false, discoveryKey, {
      ...this._replicationOpts,
      stream: protocolStream
    })
    var discoveryKeyStreams = this._streamsByDiscoveryKey.get(dkeyString)
    if (!discoveryKeyStreams) {
      discoveryKeyStreams = []
      this._streamsByDiscoveryKey.set(dkeyString, discoveryKeyStreams)
    }
    discoveryKeyStreams.push(protocolStream)
  }

  listen () {
    this._swarm = hyperswarm({
      ...this.opts,
      queue: { multiplex: true }
    })
    this._swarm.on('error', err => this.emit('error', err))
    this._swarm.on('connection', (socket, info) => {
      const isInitiator = !!info.client
      if (socket.remoteAddress === '::ffff:127.0.0.1' || socket.remoteAddress === '127.0.0.1') return null

      const protocolStream = new HypercoreProtocol(isInitiator, {
        onchannelclose: (discoveryKey) => {
          const dkeyString = datEncoding.encode(discoveryKey)
          const streams = this._streamsByDiscoveryKey.get(dkeyString)
          if (!streams || !streams.length) return
          streams.splice(streams.indexOf(protocolStream), 1)
          if (!streams.length) this._streamsByDiscoveryKey.delete(dkeyString)
        },
        ondiscoverykey: (discoveryKey) => {
          this._handleTopic(protocolStream, discoveryKey)
        }
      })
      this._replicationStreams.push(protocolStream)

      for (const discoveryKey of info.topics) {
        this._handleTopic(protocolStream, discoveryKey)
      }
      info.on('topic', discoveryKey => {
        this._handleTopic(protocolStream, discoveryKey)
      })

      return pump(socket, protocolStream, socket, err => {
        if (err) this.emit('replication-error', err)
        this._replicationStreams.splice(this._replicationStreams.indexOf(protocolStream), 1)
      })
    })
  }

  seed (discoveryKey, opts = {}) {
    if (!this._swarm) throw new Error('Seed can only be called after the swarm is created.')
    if (this._swarm.destroyed) return

    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : datEncoding.encode(discoveryKey)
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey: datEncoding.decode(discoveryKey)

    this._seeding.add(keyString)
    this._swarm.join(keyBuf, {
      announce: opts.announce !== false,
      lookup: opts.lookup !== false
    })
  }

  unseed (discoveryKey) {
    if (!this._swarm) throw new Error('Unseed can only be called after the swarm is created.')
    if (this._swarm.destroyed) return

    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : datEncoding.encode(discoveryKey)
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey: datEncoding.decode(discoveryKey)

    this._seeding.delete(keyString)
    this._swarm.leave(keyBuf)

    const streams = this._streamsByDiscoveryKey.get(keyString)
    if (!streams || !streams.length) return

    for (let stream of [...streams]) {
      stream.close(keyBuf)
    }

    this._streamsByDiscoveryKey.delete(keyString)
  }

  async close () {
    if (!this._swarm) return null
    return new Promise((resolve, reject) => {
      for (const dkey of [...this._seeding]) {
        this.unseed(dkey)
      }
      for (const stream of this._replicationStreams) {
        stream.destroy()
      }
      this._swarm.destroy(err => {
        if (err) return reject(err)
        this._swarm = null
        return resolve()
      })
    })
  }
}

module.exports = SwarmNetworker

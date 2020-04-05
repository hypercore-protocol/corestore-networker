const crypto = require('crypto')
const { EventEmitter } = require('events')
const { promisify } = require('util')

const datEncoding = require('dat-encoding')
const HypercoreProtocol = require('hypercore-protocol')
const hyperswarm = require('hyperswarm')
const pump = require('pump')
const eos = require('end-of-stream')

const log = require('debug')('corestore:network')

const OUTER_STREAM = Symbol('corestore-outer-stream')

class SwarmNetworker extends EventEmitter {
  constructor (corestore, opts = {}) {
    super()
    this.corestore = corestore
    this.id = opts.id || crypto.randomBytes(32)
    this.opts = opts
    this.keyPair = opts.keyPair || HypercoreProtocol.keyPair()

    this._replicationOpts = {
      id: this.id,
      encrypt: true,
      live: true,
      keyPair: this.keyPair
    }

    this._seeding = new Set()
    this._replicationStreams = []

    // Set in listen
    this.swarm = null
  }

  _replicate (protocolStream) {
    // The initiator parameter here is ignored, since we're passing in a stream.
    this.corestore.replicate(false, {
      ...this._replicationOpts,
      stream: protocolStream
    })
  }

  _listen () {
    const self = this
    if (this.swarm) return

    this.swarm = hyperswarm({
      ...this.opts,
      queue: { multiplex: true }
    })
    this.swarm.on('error', err => this.emit('error', err))
    this.swarm.on('connection', (socket, info) => {
      const isInitiator = !!info.client
      if (socket.remoteAddress === '::ffff:127.0.0.1' || socket.remoteAddress === '127.0.0.1') return null
      const peerInfo = info.peer
      const discoveryKey = peerInfo && peerInfo.topic
      var finishedHandshake = false

      // We the core's ifAvailable guard until the connection's handshake has succeeded or the stream closes.
      if (discoveryKey) {
        var handshaking = true
        var core = this.corestore.get({ discoveryKey })
        core.ifAvailable.wait()
      }

      const protocolStream = new HypercoreProtocol(isInitiator, { ...this._replicationOpts })
      protocolStream.on('handshake', () => {
        const deduped = info.deduplicate(protocolStream.publicKey, protocolStream.remotePublicKey)
        if (deduped) {
          ifAvailableContinue()
          return
        }
        finishedHandshake = true
        onhandshake()
      })
      protocolStream.on('close', () => {
        this.emit('stream-closed', protocolStream, peerInfo, finishedHandshake)
        ifAvailableContinue()
      })

      pump(socket, protocolStream, socket, err => {
        if (err) this.emit('replication-error', err)
        const idx = this._replicationStreams.indexOf(protocolStream)
        if (idx === -1) return
        this._replicationStreams.splice(idx, 1)
      })

      this.emit('stream-opened', protocolStream, peerInfo)

      function onhandshake () {
        self._replicate(protocolStream)
        self._replicationStreams.push(protocolStream)
        self.emit('handshake', protocolStream, peerInfo)
        ifAvailableContinue()
      }

      function ifAvailableContinue () {
        if (core && handshaking) {
          handshaking = false
          core.ifAvailable.continue()
        }
      }
    })
  }

  status (discoveryKey) {
    return this.swarm && this.swarm.status(discoveryKey)
  }

  async join (discoveryKey, opts = {}) {
    if (this.swarm && this.swarm.destroyed) return null
    if (!this.swarm) {
      this._listen()
      return this.join(discoveryKey, opts)
    }
    const self = this

    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : datEncoding.encode(discoveryKey)
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey : datEncoding.decode(discoveryKey)
    var initialLength = 0

    const core = getCoreIfLoaded()
    if (core) core.ifAvailable.wait()

    if (opts.loadForLength) {
      await new Promise(resolve => core.ready(resolve))
      initialLength = core.length
    }

    try {
      this._seeding.add(keyString)
      this.swarm.join(keyBuf, {
        announce: opts.announce !== false,
        lookup: opts.lookup !== false,
        length: () => {
          const core = getCoreIfLoaded()
          return Math.max(initialLength, (core && core.length) || 0)
        }
      }, (err, res) => {
        if (core && !err && res.maxLength) {
          core.setExpectedLength(res.maxLength)
        }
      })
      if (opts.flush !== false) {
        await promisify(this.swarm.flush.bind(this.swarm))()
        if (opts.loadForLength && !core.peers.length) {
          core.close()
        }
      }
    } finally {
      if (core) core.ifAvailable.continue()
    }

    function getCoreIfLoaded () {
      if (self.corestore.isLoaded({ discoveryKey: keyBuf }) || opts.loadForLength) {
        return self.corestore.get({ discoveryKey: keyBuf })
      }
      return null
    }
  }

  async leave (discoveryKey) {
    if (this.swarm && this.swarm.destroyed) return
    if (!this.swarm) {
      this._listen()
      return this.leave(discoveryKey)
    }

    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : datEncoding.encode(discoveryKey)
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey : datEncoding.decode(discoveryKey)

    this._seeding.delete(keyString)
    await new Promise((resolve, reject) => {
      this.swarm.leave(keyBuf, err => {
        if (err) return reject(err)
        return resolve()
      })
    })

    for (let stream of this._replicationStreams) {
      stream.close(keyBuf)
    }
  }

  async close () {
    if (!this.swarm) return null

    const leaving = [...this._seeding].map(dkey => this.leave(dkey))
    await Promise.all(leaving)

    const closingStreams = this._replicationStreams.map(stream => {
      return new Promise(resolve => {
        stream.destroy()
        eos(stream, () => resolve())
      })
    })
    await Promise.all(closingStreams)

    return new Promise((resolve, reject) => {
      this.swarm.destroy(err => {
        if (err) return reject(err)
        this.swarm = null
        return resolve()
      })
    })
  }
}

module.exports = SwarmNetworker

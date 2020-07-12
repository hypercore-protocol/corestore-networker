const crypto = require('crypto')
const { EventEmitter } = require('events')
const { promisify } = require('util')

const { NanoresourcePromise: Nanoresource } = require('nanoresource-promise/emitter')
const HypercoreProtocol = require('hypercore-protocol')
const hyperswarm = require('hyperswarm')
const codecs = require('codecs')
const pump = require('pump')
const eos = require('end-of-stream')

const log = require('debug')('corestore:network')

const OUTER_STREAM = Symbol('networker-outer-stream')
const STREAM_PEER = Symbol('networker-stream-peer')

class CorestoreNetworker extends Nanoresource {
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

    this.streams = new Set()
    this.peers = new Set()

    this._joined = new Set()
    this._flushed = new Set()
    this._configurations = new Map()

    this._extensions = new Set()

    this._streamsProcessing = 0
    this._streamsProcessed = 0

    // Set in listen
    this.swarm = null

    this.setMaxListeners(0)
  }

  _replicate (protocolStream) {
    // The initiator parameter here is ignored, since we're passing in a stream.
    this.corestore.replicate(false, {
      ...this._replicationOpts,
      stream: protocolStream
    })
  }

  async _join (discoveryKey, opts = {}) {
    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : discoveryKey.toString('hex')
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey : Buffer.from(discoveryKey, 'hex')

    this._joined.add(keyString)
    this.emit('joined', keyBuf)
    this.swarm.join(keyBuf, {
      announce: opts.announce,
      lookup: opts.lookup
    })
    if (opts.flush !== false) {
      await promisify(this.swarm.flush.bind(this.swarm))()
      if (!this._joined.has(keyString)) {
        return
      }
      const processingAfterFlush = this._streamsProcessing
      if (this._streamsProcessed >= processingAfterFlush) {
        this._flushed.add(keyString)
        this.emit('flushed', keyBuf)
      } else {
        // Wait until the stream processing has caught up.
        const processedListener =  () => {
          if (!this._joined.has(keyString)) {
            this.removeListener('stream-processed', processedListener)
            return
          }
          if (this._streamsProcessed >= processingAfterFlush) {
            this._flushed.add(keyString)
            this.emit('flushed', keyBuf)
            this.removeListener('stream-processed', processedListener)
          }
        }
        this.on('stream-processed', processedListener)
      }
    }
  }

  async _leave (discoveryKey) {
    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : discoveryKey.toString('hex')
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey : Buffer.from(discoveryKey, 'hex')

    this._joined.delete(keyString)

    await new Promise((resolve, reject) => {
      this.swarm.leave(keyBuf, err => {
        if (err) return reject(err)
        return resolve()
      })
    })

    for (let stream of this.streams) {
      stream.close(keyBuf)
    }
  }

  _registerAllExtensions (peer) {
    for (const ext of this._extensions) {
      ext._registerExtension(peer)
    }
  }

  _unregisterAllExtensions (peer) {
    for (const ext of this._extensions) {
      ext._unregisterExtension(peer)
    }
  }

  _addStream (stream) {
    this._replicate(stream)
    this.streams.add(stream)

    const peer = intoPeer(stream)
    this.peers.add(peer)
    stream[STREAM_PEER] = peer

    this._registerAllExtensions(peer)

    this.emit('peer-add', peer)
    this.emit('handshake', stream)
  }

  _removeStream (stream) {
    this.streams.delete(stream)
    if (stream[STREAM_PEER]) {
      const peer = stream[STREAM_PEER]
      this._unregisterAllExtensions(peer)
      this.peers.delete(peer)
      this.emit('peer-remove', peer)
    }
  }

  _open () {
    const self = this
    if (this.swarm) return

    this.swarm = hyperswarm({
      ...this.opts,
      announceLocalNetwork: true,
      queue: { multiplex: true }
    })
    this.swarm.on('error', err => this.emit('error', err))
    this.swarm.on('connection', (socket, info) => {
      const isInitiator = !!info.client
      if (socket.remoteAddress === '::ffff:127.0.0.1' || socket.remoteAddress === '127.0.0.1') return null
      const peerInfo = info.peer
      const discoveryKey = peerInfo && peerInfo.topic

      var finishedHandshake = false
      var processed = false

      const protocolStream = new HypercoreProtocol(isInitiator, { ...this._replicationOpts })
      protocolStream.on('handshake', () => {
        const deduped = info.deduplicate(protocolStream.publicKey, protocolStream.remotePublicKey)
        if (!deduped) {
          finishedHandshake = true
          self._addStream(protocolStream)
        }
        if (!processed) {
          processed = true
          this._streamsProcessed++
          this.emit('stream-processed')
        }
      })
      protocolStream.on('close', () => {
        this.emit('stream-closed', protocolStream, info, finishedHandshake)
        if (!processed) {
          processed = true
          this._streamsProcessed++
          this.emit('stream-processed')
        }
      })

      pump(socket, protocolStream, socket, err => {
        if (err) this.emit('replication-error', err)
        this._removeStream(protocolStream)
      })

      this.emit('stream-opened', protocolStream, info)
      this._streamsProcessing++
    })
  }

  listen () {
    return this.open()
  }

  status (discoveryKey) {
    if (Buffer.isBuffer(discoveryKey)) discoveryKey = discoveryKey.toString('hex')
    return this._configurations.get(discoveryKey)
  }

  allStatuses () {
    return this._configurations
  }

  async configure (discoveryKey, opts = {}) {
    if (this.swarm && this.swarm.destroyed) return null
    if (!this.swarm) {
      this.listen()
      return this.configure(discoveryKey, opts)
    }
    const self = this

    const config = {
      announce: opts.announce !== false,
      lookup: opts.lookup !== false
    }
    opts = { ...opts, ...config }

    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : discoveryKey.toString('hex')
    this._configurations.set(keyString, opts)

    const joining = config.announce || config.lookup
    if (joining) {
      return this._join(discoveryKey, opts)
    } else {
      return this._leave(discoveryKey)
    }
  }

  joined (discoveryKey) {
    if (typeof discoveryKey !== 'string') discoveryKey = discoveryKey.toString('hex')
    return this._joined.has(discoveryKey)
  }

  flushed (discoveryKey) {
    if (typeof discoveryKey !== 'string') discoveryKey = discoveryKey.toString('hex')
    return this._flushed.has(discoveryKey)
  }

  registerExtension (name, handlers) {
    if (name && typeof name === 'object') return this.registerExtension(null, name)
    const ext = new SwarmExtension(this, name || handlers.name, handlers)
    this._extensions.add(ext)
    for (const peer of this.peers) {
      ext._registerExtension(peer)
    }
    return ext
  }

  async _close () {
    if (!this.swarm) return null

    for (const ext of this._extensions) {
      ext.destroy()
    }
    this._extensions.clear()

    for (const stream of this.streams) {
      stream.destroy()
    }

    return new Promise((resolve, reject) => {
      this.swarm.destroy(err => {
        if (err) return reject(err)
        this.swarm = null
        return resolve()
      })
    })
  }
}

module.exports = CorestoreNetworker

class SwarmExtension {
  constructor (networker, name, opts) {
    this.networker = networker
    this.name = name
    this.encoding = codecs((opts && opts.encoding) || 'binary')
    this._peerExtensions = new Map()

    this.onmessage = opts.onmessage
    this.onerror = opts.onerror
  }

  _registerExtension (peer) {
    peer.stream.extensions.exclusive = false
    const peerExt = peer.stream.registerExtension(this.name, {
      encoding: this.encoding,
      onmessage: this.onmessage && (message => this.onmessage(message, peer)),
      onerror: this.onerror && (err => this.onerror(err))
    })
    this._peerExtensions.set(peer, peerExt)
  }

  _unregisterExtension (peer) {
    if (!this._peerExtensions.has(peer)) return
    const peerExt = this._peerExtensions.get(peer)
    peerExt.destroy()
    this._peerExtensions.delete(peer)
  }

  broadcast (message) {
    if (this.encoding) message = this.encoding.encode(message)
    for (const peerExt of this._peerExtensions.values()) {
      peerExt.send(message)
    }
  }

  send (message, peer) {
    const peerExt = this._peerExtensions.get(peer)
    if (!peer) throw new Error('Peer must be specified.')
    if (!peerExt) throw new Error('Extension not registered for peer ' + peer.remotePublicKey.toString('hex'))
    if (this.encoding) message = this.encoding.encode(message)
    peerExt.send(message)
  }

  destroy () {
    for (const peerExt of this._peerExtensions.values()) {
      peerExt.destroy()
    }
    this._peerExtensions.clear()
    this.onmessage = null
    this.onerror = null
  }
}

function intoPeer (stream) {
  return {
    remotePublicKey: stream.remotePublicKey,
    remoteAddress: stream.remoteAddress,
    type: stream.remoteType,
    stream
  }
}

function noop () {}

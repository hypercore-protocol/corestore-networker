const crypto = require('crypto')
const { EventEmitter } = require('events')

const datEncoding = require('dat-encoding')
const HypercoreProtocol = require('hypercore-protocol')
const hyperswarm = require('hyperswarm')
const pump = require('pump')

const log = require('debug')('corestore:network')

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
    this._replicationStreams = new Map()

    // Set in listen
    this._swarm = null
  }

  _handleTopic (protocolStream, discoveryKey) {
    // This is the active replication case -- we're requesting that a particular discovery key be replicated.
    const dkeyString = datEncoding.encode(discoveryKey)
    if (!this._seeding.has(dkeyString)) return
    // The initiator parameter here is ignored, since we're passing in a stream.
    const stream = this.corestore.replicate(false, discoveryKey, {
      ...this._replicationOpts,
      stream: protocolStream
    })
    this._addStream(dkeyString, stream)
  }

  _addStream (discoveryKey, stream) {
    var streams = this._replicationStreams.get(discoveryKey)
    if (!streams) {
      streams = []
      this._replicationStreams.set(discoveryKey, streams)
    }
    streams.push(stream)

    /*
    stream.on('finish', onclose)
    stream.on('end', onclose)
    stream.on('close', onclose)
    */
    var closed = false

    function onclose () {
      if (closed) return
      console.log('STREAM IS CLOSING')
      streams.splice(streams.indexOf(stream), 1)
      closed = true
    }
  }

  listen () {
    this._swarm = hyperswarm({
      ...this.opts,
      queue: { multiplex: true }
    })
    this._swarm.on('error', err => this.emit('error', err))
    this._swarm.on('connection', (socket, info) => {
      const isInitiator = !!info.client
      console.log(this.id, 'INFO PEER', info.peer)
      console.log('socket remoteaddr:', socket.remoteAddress)
      if (socket.remoteAddress === '::ffff:127.0.0.1' || socket.remoteAddress === '127.0.0.1') return

      console.log('info.topics.length:', info.topics.length)
      const protocolStream = new HypercoreProtocol(isInitiator)
      for (const discoveryKey of info.topics) {
        this._handleTopic(protocolStream, discoveryKey)
      }
      info.on('topic', discoveryKey => {
        console.log('TOPIC:', discoveryKey)
        this._handleTopic(protocolStream, discoveryKey)
      })
      /*
      protocolStream.on('close', () => {
        console.log('PROTOCOL STREAM IS CLOSING')
      })
      protocolStream.on('error', err => {
        console.error('PROTOCOL STREAM ERROR:', err)
      })
      */
      protocolStream.on('discovery-key', discoveryKey => {
        this._handleTopic(protocolStream, discoveryKey)
      })
      return pump(socket, protocolStream, socket, err => {
        if (err) this.emit('replication-error', err)
      })
    })
  }

  seed (discoveryKey) {
    if (!this._swarm) throw new Error('Seed can only be called after the swarm is created.')
    if (this._swarm.destroyed) return

    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : datEncoding.encode(discoveryKey)
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey: datEncoding.decode(discoveryKey)

    console.log(this.id, 'SEEDING KEYSTRING:', keyString)
    this._seeding.add(keyString)
    this._swarm.join(keyBuf, {
      announce: true,
      lookup: true
    })
  }

  unseed (discoveryKey) {
    if (!this._swarm) throw new Error('Unseed can only be called after the swarm is created.')
    if (this._swarm.destroyed) return

    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : datEncoding.encode(discoveryKey)
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey: datEncoding.decode(discoveryKey)

    this._seeding.delete(keyString)
    this._swarm.leave(keyBuf)

    const streams = this._replicationStreams.get(keyString)
    if (!streams || !streams.length) return

    for (let stream of [...streams]) {
      stream.destroy()
    }

    this._replicationStreams.delete(keyString)
  }

  async close () {
    if (!this._swarm) return null
    return new Promise((resolve, reject) => {
      for (let [dkey,] of new Map(...[this._replicationStreams])) {
        if (dkey) this.unseed(datEncoding.decode(dkey))
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

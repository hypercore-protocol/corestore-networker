const { EventEmitter } = require('events')

const datEncoding = require('dat-encoding')
const hyperswarm = require('hyperswarm')
const pump = require('pump')

const log = require('debug')('corestore:network')

class SwarmNetworker extends EventEmitter {
  constructor (megastore, opts = {}) {
    super()
    this.megastore = megastore
    this.opts = opts

    this._seeding = new Set()
    this._replicationStreams = new Map()

    // Set in listen
    this._swarm = null
  }

  _handleConnection (socket, details) {
    var discoveryKey = details.peer ? details.peer.topic : null
    if (discoveryKey) {
      discoveryKey = datEncoding.encode(discoveryKey)
      if (!this._seeding.has(discoveryKey)) {
        return socket.destroy(new Error('Networker is not seeding: ' + discoveryKey))
      }
    }
    console.log('CALLING REPLICATE WITH DKEY:', discoveryKey)
    const stream = this.megastore.replicate(discoveryKey)
    if (discoveryKey) {
      this._addStream(discoveryKey, stream)
    } else {
      stream.on('feed', dkey => {
        const keyString = datEncoding.encode(dkey)
        this._addStream(keyString, stream)
      })
    }
    pump(socket, stream, socket, err => {
      if (err) this.emit('replication-error', err)
    })
  }

  _addStream (discoveryKey, stream) {
    var streams = this._replicationStreams.get(discoveryKey)
    if (!streams) {
      streams = []
      this._replicationStreams.set(discoveryKey, streams)
    }
    streams.push(stream)

    stream.on('finish', onclose)
    stream.on('end', onclose)
    stream.on('close', onclose)
    var closed = false

    function onclose () {
      if (closed) return
      streams.splice(streams.indexOf(stream), 1)
      closed = true
    }
  }

  listen () {
    this._swarm = hyperswarm(this.opts)
    this._swarm.on('error', err => this.emit('error', err))
    this._swarm.on('connection', (socket, details) => {
      this._handleConnection(socket, details)
    })
  }

  seed (discoveryKey) {
    if (!this._swarm) throw new Error('Seed can only be called after the swarm is created.')
    if (this._swarm.destroyed) return

    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : datEncoding.encode(discoveryKey)
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey: datEncoding.decode(discoveryKey)

    console.error('SWARM JOINING WITH KEY:', discoveryKey)
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

const crypto = require('crypto')

const datEncoding = require('dat-encoding')
const discoverySwarm = require('discovery-swarm')
const swarmDefaults = require('dat-swarm-defaults')

const log = require('debug')('corestore:network')

class SwarmNetworker {
  constructor (opts = {}) {
    this.opts = opts
    this.id = opts.id || crypto.randomBytes(32)

    this._swarm = discoverySwarm(swarmDefaults({
      id: this.id,
      hash: false,
      utp: false && defaultTrue(opts.utp),
      tcp: defaultTrue(opts.tcp),
      dht: defaultTrue(opts.dht),
      stream: this._createReplicationStream.bind(this)
    }))
    this._replicationStreams = new Map()
    this._replicators = new Map()

    console.log('LISTENING WIHT OPTS:', opts)
    this._swarm.listen(opts.port || 3005)
  }

  _createReplicationStream (info) {
    console.log('CREATING REPLICATION STREAM FOR INFO:', info)
    if (!info.channel) return
    const keyString = datEncoding.encode(info.channel)

    const replicate = this._replicators.get(keyString)
    const streams = this._replicationStreams.get(keyString)
    if (!replicate || !streams) throw new Error('The swarm requested a discovery key which is not being seeded.')

    // TODO: Support encrypted replication streams.
    const stream = replicate({
      live: true,
      encrypt: false,
      id: this.id
    })

    streams.push(stream)
    return stream
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

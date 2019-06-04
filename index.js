const http = require('http')
const httpProxy = require('http-proxy')
const request = require('request')
const crypto = require('crypto')
const _ = require('underscore')

class TransloaditNotifyUrlProxy {
  constructor (secret, notifyUrl) {
    this._server = null
    this._proxy = null

    this._secret = secret | ''
    this._notifyUrl = notifyUrl || 'http://127.0.0.1:3000/transloadit'

    this._defaults = {
      target: 'https://api2.transloadit.com/assemblies/',
      port: 8888,
      pollInterval: 2000,
    }
    this._settings = {}
  }

  run (opts) {
    if (opts === undefined) {
      opts = {}
    }
    this._settings = _.extend(this._defaults, opts)

    this._createProxy()
    this._createServer()
  }

  close () {
    if (this._server !== null) {
      this._server.close()
      this._server = null
    }

    if (this._proxy !== null) {
      this._proxy.close()
      this._proxy = null
    }
  }

  _createProxy () {
    this._proxy = httpProxy.createProxyServer({
      target: this._settings.target
    })
  }

  _createServer () {
    this._server = http.createServer((req, res) => {
      this._proxy.web(req, res)
      this._proxy.on('proxyRes', (res) => {
        let body = ''

        res.on('data', (chunk) => {
          body += chunk
        })

        res.on('end', () => {
          const assemblyUrl = JSON.parse(body).assembly_url
          this._out("Received proxy response, polling assemblyUrl: %s", assemblyUrl)

          this._pollAssembly(assemblyUrl)
        })
      })
    }).listen(this._settings.port)

    this._out("Listening on http://localhost:%d, forwarding to %s, notifying %s",
      this._settings.port,
      this._settings.target,
      this._notifyUrl
    )
  }

  _pollAssembly (assemblyUrl) {
    const opts = {
      retries: 10,
      minTimeout: this._settings.pollInterval,
      maxTimeout: this._settings.pollInterval,
    }
    const operation = retry.operation(opts)

    operation.attempt((currentAttempt) => {
      this._checkAssembly(assemblyUrl, (err, response) => {
        if (!err && response) {
          console.debug("%s valid response, notifying.", assemblyUrl)
          return this._notify(response)
        }

        console.debug("%s not completed, checking again.", assemblyUrl)
        if (operation.retry(err)) {
          return
        }

        this._out("No attempts left, giving up on checking assemblyUrl: %s", assemblyUrl)
      })
    })
  }

  _checkAssembly (assemblyUrl, cb) {
    request.get(assemblyUrl, (err, res, body) => {
      let response = JSON.parse(body)
      let err = null
      let msg = ''

      if (!response || !response.ok) {
        err = new Error('No ok field found in Assembly response.')
        return cb(err)
      }

      if (response.ok == 'ASSEMBLY_COMPLETED') {
        this._out('%s completed.', assemblyUrl)
        return cb(null, response)
      }

      if (response.ok == 'ASSEMBLY_UPLOADING'){
        msg = `${assemblyUrl} is still uploading.`
        this._out(msg)
        return cb(new Error(msg))
      }

      if (response.ok == 'ASSEMBLY_EXECUTING'){
        msg = `${assemblyUrl} is still executing.`
        this._out(msg)
        return cb(new Error(msg))
      }

      cb(new Error(`${assemblyUrl} - unknown Assembly state found.`))
    })
  }

  _notify (response) {
    const stringified = JSON.stringify(response)
    const signature = this._getSignature(stringified)

    request.post(this._notifyUrl, {
      form: {
        transloadit: stringified,
        signatture: signature,
      }
    })
  }

  _getSignature (toSign) {
    return crypto
      .createHmac('sha1', this._secret)
      .update(Buffer.from(toSign, 'utf-8'))
      .digest('hex')
  }

  _out (msg, ...args) {
    console.log(msg, ...args)
  }
}

module.exports = TransloaditNotifyUrlProxy

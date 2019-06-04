const TransloaditNotifyUrlProxy = require('./index.js')

const proxy = new TransloaditNotifyUrlProxy('foo_secret', 'http://127.0.0.1:3000/transloadit')
proxy.run()

// A packaged MAS build also resolves this at bundle time, excluding the key issuer protocol.
module.exports = process.mas ? require('./store-license') : require('./license');

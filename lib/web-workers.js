'use strict';

var cluster = require('cluster');
var net = require('net');
var assert = require('assert');
var numCPUs = require('os').cpus().length;

var async = require('async');
var express = require('express');
var lmdb = require('node-lmdb');
var morgan = require('morgan');
var bodyParser = require('body-parser');
var compression = require('compression');
var bitcore = require('bitcore-lib');
var _ = require('lodash');
var bodyParser = require('body-parser');
var compression = require('compression');
var morgan = require('morgan');

var db = require('./db');
var Config = require('./config');
var models = require('./models');
var utils = require('./utils');
var validators = require('./validators');

function WebWorker(options) {
  this.db = null;
  this._initOptions(options);
  this._initClients();
}

WebWorker.prototype._initOptions = function(options) {

  this.network = bitcore.Networks.get(options.network);
  assert(this.network, '"network" is an expected option, please specify "livenet", "testnet" or "regtest"');

  assert(options.bitcoinHeight, '"bitcoinHeight" is expected');
  assert(options.bitcoinHash, '"bitcoinHash" is expected');
  assert(options.clientsConfig && options.clientsConfig.length > 0, '"clientsConfig" is expected');
  assert(options.port, '"port" is an expected option');

  this.port = options.port;
  this.bitcoinHeight = options.bitcoinHeight; // TODO update these values
  this.bitcoinHash = options.bitcoinHash;
  this.clientsConfig = options.clientsConfig;
  this.config = new Config({
    network: this.network,
    path: options.path
  });

  this.defaults = {
    historyBlockRange: options.historyBlockRange || WebWorker.DEFAULT_HISTORY_BLOCK_RANGE,
    historyConcurrency: options.historyConcurrency || WebWorker.DEFAULT_HISTORY_CONCURRENCY
  };
};

WebWorker.DEFAULT_HISTORY_BLOCK_RANGE = 144; // one day
WebWorker.DEFAULT_HISTORY_CONCURRENCY = 5;

WebWorker.prototype.start = function(callback) {
  var self = this;
  var dbPath = self.config.getDatabasePath();
  self.db = db.open(dbPath, true);

  async.series([
    function(next) {
      self._connectWriterSocket(next);
    },
    function(next) {
      self._startListener(next);
    }
  ], function(err) {
    if (err) {
      return callback(err);
    }
    callback();
  });

};

WebWorker.prototype.stop = function(callback) {
  if (this.db) {
    db.close(this.db);
    setImmediate(callback);
  } else {
    setImmediate(callback);
  }
};

WebWorker.prototype._initClients = function() {
  var clients = utils.getClients(this.clientsConfig);
  utils.setClients(this, clients);
};

WebWorker.prototype._connectWriterSocket = function(callback) {
  var self = this;
  var path = this.config.getWriterSocketPath();

  this._writerCallbacks = {};

  this._writerSocket = net.connect({path: path}, function() {
    callback();
  });

  this._writerSocket.on('error', function(err) {
    console.error(err);
  });

  var buffer = '';

  this._writerSocket.on('data', function(data) {

    buffer += data.toString('utf8');

    var msg;
    try {
      msg = JSON.parse(buffer);
      buffer = '';
    } catch(e) {
      return;
    }

    if (msg.id && self._writerCallbacks[msg.id]) {
      var error = null;
      if (msg.error) {
        // TODO get stack from worker?
        error = new Error(error.message);
      }
      self._writerCallbacks[msg.id](error, msg.result);
    }
  });
};

WebWorker.prototype._queueWriterTask = function(method, params, priority, callback) {
  var self = this;
  assert(Array.isArray(params), '"params" is expected to be an array');
  assert(_.isFunction(callback), '"callback" is expected to be a function');

  var taskId = utils.getTaskId();
  this._writerCallbacks[taskId] = callback;

  var msg = JSON.stringify({
    task: {
      id: taskId,
      method: method,
      params: params
    },
    priority: priority
  });

  self._writerSocket.write(msg, 'utf8', function(err) {
    if (err) {
      return console.error(err);
    }
  });
};

WebWorker.prototype._importTransaction = function(walletId, txid, callback) {
  var self = this;

  this.clients.getRawTransaction(txid.toString('hex'), 1, function(err, response) {
    if (err) {
      return callback(utils.wrapRPCError(err));
    }
    var transaction = response.result;
    self._queueWriterTask('saveTransaction', [walletId, transaction], 1 /* priority */, function(err) {
      if (err) {
        return callback(err);
      }
      callback(null, transaction);
    });
  });
};

WebWorker.prototype.getWalletTransactions = function(walletId, options, callback) {
  var self = this;
  var txn = this.db.env.beginTxn({readOnly: true});

  this._getLatestTxids(txn, walletId, options, function(err, result) {
    if (err) {
      txn.abort();
      return callback(err);
    }
    // TODO Using mapLimit or map here will cause concurrency isssue
    // that will halt when using _importTransaction
    async.mapSeries(result.txids, function(txid, next) {
      var key = models.WalletTransaction.getKey(walletId, txid);
      var buffer = txn.getBinary(self.db.txs, key.toString('hex'));
      if (!buffer) {
        self._importTransaction(walletId, txid, function(err, tx) {
          next(err, tx);
        });
      } else {
        var tx = models.WalletTransaction.fromBuffer(walletId, buffer);
        next(null, tx.value);
      }
    }, function(err, transactions) {
      txn.abort();
      if (err) {
        return callback(err);
      }
      callback(null, {
        transactions: transactions,
        start: result.start,
        end: result.end
      });
    });
  });
};

WebWorker.prototype._getLatestTxids = function(txn, walletId, options, callback) {
  var txids = [];

  try {
    options = validators.sanitizeRangeOptions(options);
  } catch(err) {
    return callback(err);
  }

  var cursor = new lmdb.Cursor(txn, this.db.txids);

  var start = models.WalletTxid.create(walletId, options.height, options.index);
  var found = cursor.goToRange(start.getKey().toString('hex'));
  if (!found) {
    found = cursor.goToPrev();
  }

  function iterator() {
    cursor.getCurrentBinary(function(key, value) {
      txids.push(value);

      var prevFound = cursor.goToPrev();
      if (prevFound && txids.length < options.limit) {
        // TODO make sure maximum call stack is not reached
        iterator();
      } else {
        cursor.close();
        // TODO include blockhash of start/tip height?
        var result = {
          txids: txids,
          start: {
            height: options.height,
            index: options.index
          }
        };
        // Only include "end" if there are more results
        if (txids.length === options.limit) {
          result.end = models.WalletTxid.parseKey(key);
        }
        callback(null, result);
      }
    });
  }

  if (found) {
    iterator();
  } else {
    cursor.close();
    callback(null, {
      txids: txids,
      start: {
        height: options.height,
        index: options.index
      }
    });
  }

};

/**
 * Will get the latest transaction ids for the wallet.
 * @param options
 * @param options.height - Starting block height
 * @param options.index - Starting block index
 * @param options.limit - Total number of txids to return
 * @param options.buffers - Include results as a buffer
 */
WebWorker.prototype.getWalletTxids = function(walletId, options, callback) {
  var txn = this.db.env.beginTxn({readOnly: true});

  this._getLatestTxids(txn, walletId, options, function(err, result) {
    txn.abort();
    if (err) {
      return callback(err);
    }

    if (!options.buffers) {
      result.txids = result.txids.map(function(txid) {
        return txid.toString('hex');
      });
    }
    callback(null, result);
  });

};

WebWorker.prototype._startListener = function() {
  var self = this;

  var app = express();

  // Include server bitcoin information for the request for middleware use
  app.use(function(req, res, next) {
    req.network = self.network;
    req.networkName = self.config.getNetworkName();
    req.bitcoinHeight = self.bitcoinHeight;
    req.bitcoinHash = self.bitcoinHash;
    next();
  });

  //Setup logging
  morgan.token('remote-forward-addr', function(req){
    return utils.getRemoteAddress(req);
  });
  var logFormat = ':remote-forward-addr ":method :url" :status :res[content-length] :response-time ":user-agent" ';
  var logStream = utils.createLogStream(function(data) {
    console.info(data.toString());
  });
  app.use(morgan(logFormat, {stream: logStream}));

  //Enable compression
  app.use(compression());

  //Enable body parsers
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({extended: true}));

  //Enable CORS
  app.use(utils.enableCORS);

  //Set bitcoin headers in the response
  app.use(function(req, res, next) {
    res.header('x-bitcoin-network', req.networkName);
    res.header('x-bitcoin-height', req.bitcoinHeight);
    res.header('x-bitcoin-hash', req.bitcoinHash);
    res.header('x-powered-by', 'bwsv2');
    next();
  });

  app.get('/wallets/:walletId/txids', validators.checkWalletId, validators.checkRangeParams, function(req, res) {
    self.getWalletTxids(req.walletId, req.range, function(err, txids) {
      if (err) {
        return utils.sendError(err, res);
      }
      res.jsonp(txids);
    });
  });

  app.get('/wallets/:walletId/transactions', validators.checkWalletId, validators.checkRangeParams, function(req, res) {
    self.getWalletTransactions(req.walletId, req.range, function(err, txs) {
      if (err) {
        return utils.sendError(err, res);
      }
      res.jsonp(txs);
    });
  });

  app.put('/wallets/:walletId/addresses/:address', validators.checkWalletId, validators.checkAddress, function(req, res) {
    var addresses = [req.address];
    var walletId = req.walletId;
    self._queueWriterTask('importWalletAddresses', [walletId, addresses], 5 /* priority */, function(err, newAddresses) {
      if (err) {
        return utils.sendError(err, res);
      }
      if (!newAddresses.length) {
        return res.status(200).jsonp({
          address: req.address
        });
      }
      res.status(201).jsonp({
        address: req.address
      });
    });
  });

  app.post('/wallets/:walletId/addresses', validators.checkWalletId, validators.checkAddresses, function(req, res) {
    var addresses = req.addresses;
    var walletId = req.walletId;
    self._queueWriterTask('importWalletAddresses', [walletId, addresses], 10 /* priority */, function(err, newAddresses) {
      if (err) {
        return utils.sendError(err, res);
      }
      if (!newAddresses.length) {
        return res.status(204).end();
      }
      res.status(201).jsonp({
        addresses: newAddresses
      });
    });
  });

  app.put('/wallets/:walletId', validators.checkWalletId, function(req, res) {
    var params = [req.walletId];
    self._queueWriterTask('createWallet', params, 20, function(err, walletId) {
      if (err) {
        return utils.sendError(err, res);
      }
      if (!walletId) {
        return res.status(204).end();
      }
      res.status(201).jsonp({
        walletId: walletId
      });
    });
  });

  // Not Found
  app.use(function(req, res) {
    res.status(404).jsonp({
      status: 404,
      url: req.originalUrl,
      error: 'Not found'
    });
  });

  app.listen(this.port);

};

if (require.main === module) {

  process.title = 'wallet-web';

  var options = JSON.parse(process.argv[2]);

  if (cluster.isMaster) {
    var workers = [];
    for (var i = 0; i < numCPUs; i++) {
      var workerProcess = cluster.fork();
      workers.push(workerProcess);
    }

    function loadWorker(worker, next) {
      worker.send({start: true}, next);
    }

    async.eachSeries(workers, loadWorker, function(err) {
      if (err) {
        throw err;
      }
    });

  } else {

    var worker = new WebWorker(options);

    function start() {
      worker.start(function(err) {
        if (err) {
          throw err;
        }
        process.send('ready');
      });
    }

    process.on('message', function(msg) {
      if (msg.start) {
        start();
      }
    });

    process.on('SIGINT', function() {
      worker.stop(function(err) {
        if (err) {
          throw err;
        }
        process.exit(0);
      });
    });
  }
}

module.exports = WebWorker;

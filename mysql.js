/**
 * modella-mysql
 *
 * MySQL storage plugin for Modella.
 *
 * @author Alex Mingoia <talk@alexmingoia.com>
 * @link https://github.com/bloodhound/modella-mysql
 */

/**
 * Dependencies.
 */

var extend = require('extend');
var lingo = require('lingo').en;
var mysql = require('mysql');
var build = require('mongo-sql').sql;

/**
 * Models share connection pool
 */

var pool;

/**
 * Initialize a new MySQL plugin with given `settings`.
 *
 * Refer to felixge/node-mysql documentation for available settings.
 *
 * @param {Object} settings
 * @return {Function}
 * @api public
 */

module.exports = function(settings) {
  settings.multipleStatement = true;
  if (!pool) {
    pool = module.exports.pool = mysql.createPool(settings);
    pool.on('connection', configureConnection);
    process.once('exit', pool.end.bind(pool));
  }
  return function(Model) {
    Model.db = pool;
    if (!Model.tableName) {
      Model.tableName = lingo.pluralize(Model.modelName.toLowerCase());
    }
    extend(Model, plugin);
    return Model;
  };
};

/**
 * Enable ANSI_QUOTES and set query formatter for new connections.
 */

function configureConnection(connection) {
  // Set query value escape character to `$1, $2, $3..` to conform to
  // mongo-sql's query value escape character.
  connection.config.queryFormat = plugin.queryFormat;
  // Enable ANSI_QUOTES for compatibility with queries generated by mongo-sql
  connection.query('SET SESSION sql_mode=ANSI_QUOTES', [], function(err) {
    if (err) throw err;
  });
};

/**
 * Expose the mysql module
 */

module.exports.mysql = mysql;

/**
 * Plugin for Modella's Model.use()
 */

var plugin = module.exports.plugin = {};

/**
 * Define one-to-many relationship with given `Model`.
 *
 * @example
 *
 *     User.hasMany(Post, { as: 'posts', foreignKey: 'user_id' });
 *     // creates instance methods:
 *     // user.posts([query], callback)
 *     // user.newPost([data], callback)
 *
 *     // Use your own all and create methods
 *     User.hasMany(Post, {
 *       as: 'posts',
 *       all: function(query, callback) {
 *         // ...
 *       },
 *       create: function(data, callback) {
 *         // ...
 *       }
 *     });
 *
 * @param {modella.Model} Model
 * @param {Object} options
 * @api public
 */

plugin.hasMany = function(Model, options) {
  // user.posts()
  this.prototype[options.as] = options.all || function(query, cb) {
    if (typeof query == 'function') {
      cb = query;
      query = {};
    }
    query.where = query.where || {};
    query.where[options.foreignKey] = this.primary();
    Model.all(query, cb);
  };
  // user.newPost()
  this.prototype['new' + Model.modelName] = options.create || function(data) {
    var model = new Model(data);
    model[options.foreignKey](this.primary());
    return model;
  };
};

/**
 * Find model with given `id` or `query`.
 *
 * @param {Number|Object} id
 * @param {Function(err, model)} callback
 * @api public
 */

plugin.find = plugin.get = function(id, callback) {
  var query = typeof id == 'object' ? id : { where: { id: id } };
  var sql = build(extend({
    type: 'select',
    table: this.tableName
  }, query));
  this.db.query(sql.toString(), sql.values, function(err, rows, fields) {
    if (err) return callback(err);
    var model;
    if (rows && rows.length) {
      model = new (this)(rows[0]);
      return callback(null, model);
    }
    var error = new Error("Could not find " + id + ".");
    error.code = error.status = 404;
    return callback(error);
  }.bind(this));
};

/**
 * Find all models with given `query`.
 *
 * @param {Object} query
 * @param {Function(err, collection)} callback
 * @api public
 */

plugin.all = function(query, callback) {
  var sql = build(extend({
    type: 'select',
    table: this.tableName
  }, this.preprocessQuery(query)));
  this.db.query(sql.toString(), sql.values, function(err, rows, fields) {
    if (err) return callback(err);
    var collection = [];
    if (rows && rows.length) {
      for (var len = rows.length, i=0; i<len; i++) {
        collection.push(new (this)(rows[i]));
      }
    }
    callback(null, collection);
  }.bind(this));
};

/**
 * Count models with given `query`.
 *
 * @param {Object} query
 * @param {Function(err, count)} callback
 * @api public
 */

plugin.count = function(query, callback) {
  var sql = build(extend({
    type: 'select',
    columns: ['count(*)'],
    table: this.tableName
  }, this.preprocessQuery(query)));
  this.db.query(sql.toString(), sql.values, function(err, rows, fields) {
    if (err) return callback(err);
    var count = rows[0]['count(*)'];
    callback(null, count);
  }.bind(this));
};

/**
 * Save.
 *
 * @param {Function(err, attrs)} fn
 * @api private
 */

plugin.save = function(fn) {
  var sql = build({
    type: 'insert',
    table: this.model.tableName,
    values: this.model.preprocessValues(this.toJSON())
  });
  this.model.db.query(sql.toString(), sql.values, function(err, rows, fields) {
    if (err) return fn(err);
    this.primary(rows.insertId);
    fn(null, fields);
  }.bind(this));
};

/**
 * Update.
 *
 * @param {Function(err, attrs)} fn
 * @api private
 */

plugin.update = function(fn) {
  var body = this.changed();
  var where = {};
  where[this.model.primaryKey] = this.primary();
  var sql = build({
    type: 'update',
    table: this.model.tableName,
    where: where,
    values: this.model.preprocessValues(body)
  });
  this.model.db.query(sql.toString(), sql.values, function(err, rows, fields) {
    if (err) return fn(err);
    fn(null, fields);
  }.bind(this));
};

/**
 * Remove.
 *
 * @param {Function(err, attrs)} fn
 * @api private
 */

plugin.remove = function(fn) {
  var query = {
    type: 'delete',
    table: this.model.tableName,
    where: {}
  };
  query.where[this.model.primaryKey] = this.primary();
  var sql = build(query);
  this.model.db.query(sql.toString(), sql.values, function(err, rows) {
    if (err) return fn(err);
    fn();
  }.bind(this));
};

/**
 * Preprocess query.
 *
 * @param {Object} query
 * @return {Object}
 * @api private
 */

plugin.preprocessQuery = function(query) {
  var keywords = [];
  for (var key in query) {
    if (query.hasOwnProperty(key) && key.match(/(where|Join)$/)) {
      keywords.push(key);
    }
    if (!isNaN(query[key])) {
      query[key] = Number(query[key]);
    }
  }
  // If no keywords, assume where query
  if (keywords.length == 0) {
    query.where = {};
    for (var param in query) {
      if (query.hasOwnProperty(param)) {
        if (!param.match(/(where|offset|limit|order|groupBy)$/)) {
          query.where[param] = query[param];
          delete query[param];
        }
      }
    }
  }
  return query;
};

/**
 * Preprocess values.
 *
 * @param {Array} values
 * @return {Array}
 * @api private
 */

plugin.preprocessValues = function(values) {
  for (var key in values) {
    if (this.attrs[key].dataFormatter) {
      values[key] = this.attrs[key].dataFormatter(values[key], this);
    }
    else if (values[key] instanceof Date) {
      values[key] = Math.floor(values[key].getTime() / 1000);
    }
    else if (typeof values[key] === 'object') {
      values[key] = JSON.stringify(values[key]);
    }
    else if (typeof values[key] === 'boolean') {
      values[key] = values[key] ? 1 : 'NULL';
    }
  }
  return values;
};

/**
 * node-mysql query formatter.
 *
 * node-mysql uses `?` whereas mongo-sql uses `$1, $2, $3...`,
 * so we have to implement our own query formatter assigned
 * when extending the model class.
 *
 * @link https://github.com/felixge/node-mysql#custom-format
 *
 * @param {String} query
 * @param {Array} values
 * @return {String}
 * @api private
 */

plugin.queryFormat = function(query, values) {
  if (!values || !values.length) return query;
  return query.replace(/\$\d+/g, function(match) {
    var i = Number(String(match).substr(1)) - 1;
    if (values[i]) return this.escape(values[i]);
    return match;
  }.bind(this));
};

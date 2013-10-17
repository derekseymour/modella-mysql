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
 * Initialize a new MySQL plugin with given `settings`.
 *
 * Refer to felixge/node-mysql documentation for available settings.
 *
 * @param {Object} settings
 * @return {Function}
 * @api public
 */

var plugin = function(settings) {
  settings.multipleStatement = true;
  // Models share connection pool through shared settings object
  if (!settings.pool) {
    settings.pool = mysql.createPool(settings);
    settings.pool.on('connection', configureConnection);
    process.once('exit', settings.pool.end.bind(settings.pool));
  }
  return function(Model) {
    Model.db = settings.pool;
    Model.relations = Model.relations || {};
    if (!Model.tableName) {
      Model.tableName = lingo.pluralize(Model.modelName.toLowerCase());
    }
    extend(Model, plugin);
    var toJSON = Model.prototype.toJSON;
    Model.prototype.toJSON = function() {
      var attrs = this.model.attrs;
      var json = toJSON.call(this);
      for (var attr in json) {
        if (attrs[attr].type == 'date') {
          json[attr] = Math.ceil(this[attr]().getTime() / 1000);
        }
      }
      return json;
    };
    var attr = Model.attr;
    Model.attr = function(name, options) {
      attr.call(Model, name, options);
      if (Model.attrs[name].type == 'date') {
        Model.prototype[name] = function(val) {
          if (val) {
            if (typeof val == 'number') {
              val = new Date(val * 1000);
            }
            this.attrs[name] = val;
          }
          return this.attrs[name];
        };
      }
      return this;
    };
    Model.on('initialize', function(model) {
      for (var key in model.attrs) {
        if (model.model.attrs[key].type == 'date'
        && typeof model.attrs[key] == 'number') {
          model.attrs[key] = new Date(model.attrs[key] * 1000);
        }
      }
    });
    return Model;
  };
};

/**
 * Expose `plugin`
 */

module.exports = plugin;

/**
 * Expose the mysql module
 */

plugin.adapter = mysql;

/**
 * Define a "has many" relationship.
 *
 * @example
 *
 *     User.hasMany('posts', { model: Post, foreignKey: 'userId' });
 *
 *     user.posts(function(err, posts) {
 *       // ...
 *     });
 *
 *     var post = user.posts.create();
 *
 * @param {String} name
 * @param {Object} params The `model` constructor and `foreignKey` name are required.
 * @api public
 */

plugin.hasMany = function(name, params) {
  this.prototype[name] = function(query, cb) {
    if (typeof query == 'function') {
      cb = query;
      query = {};
    }
    query.where = query.where || {};
    if (params.through) {
      if (typeof params.through != 'string') {
        params.through = params.through.tableName;
      }
      query.innerJoin = {};
      query.innerJoin[params.through] = {};
      query.innerJoin[params.through][params.fromKey] = '$' + params.model.tableName + '.' + params.model.primaryKey + '$';
      query.where[params.through + '.' + params.foreignKey] = this.primary();
    }
    else {
      query.where[params.foreignKey] = this.primary();
    }
    params.model.all(query, cb);
  };
  this.prototype[name].create = function(data) {
    data[params.foreignKey] = this.model.primary();
    return new params.model(data);
  };
  this.on('initialize', function(model) {
    model[name].model = model;
  });
  params.model.relations[this.modelName] = {
    type: 'hasMany',
    name: name,
    params: params
  };
};

/**
 * Define a "belongs to" relationship.
 *
 * @example
 *
 *     Post.belongsTo(User, { as: 'author', foreignKey: 'userId' });
 *
 *     post.author(function(err, user) {
 *       // ...
 *     });
 *
 * @param {modella.Model} Model
 * @param {Object} params The `as` and `foreignKey` names are required.
 * @api public
 */

plugin.belongsTo = function(Model, params) {
  Model.prototype[params.as] = function(cb) {
    var query = {};
    query[Model.primaryKey] = this[params.foreignKey]();
    Model.find(query, cb);
  };
};

/**
 * Define a "has and belongs to many" relationship.
 *
 * @example
 *
 *     Post.hasAndBelongsToMany('tags', {
 *       as: 'posts',
 *       model: Tag,
 *       fromKey: 'postId',
 *       toKey: 'tagId'
 *     });
 *
 *     post.tags(function(err, tags) {
 *       // ...
 *     });
 *
 *     tag.posts(function(err, posts) {
 *       // ...
 *     });
 *
 * @param {modella.Model} Model
 * @param {Object} params
 * @api public
 */

plugin.hasAndBelongsToMany = function(name, params) {
  if (!params.through) {
    params.through = this.modelName + params.model.modelName;
    if (this.modelName > params.model.modelName) {
      params.through = params.model.modelName + this.modelName;
    }
  }
  this.hasMany(name, {
    model: params.model,
    through: params.through,
    fromKey: params.fromKey,
    foreignKey: params.toKey
  });
  params.model.hasMany(params.as, {
    model: this,
    through: params.through,
    fromKey: params.toKey,
    foreignKey: params.fromKey
  });
};

plugin.find = plugin.get = function(id, callback) {
  var query = typeof id == 'object' ? id : { where: { id: id } };
  var relation = this.relations[query.related ? query.related.model.modelName : ''];
  if (relation) query = this.relationQuery(relation, query);
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
  query = this.preprocessQuery(query);
  var relation = this.relations[query.related ? query.related.model.modelName : ''];
  if (relation) query = this.relationQuery(relation, query);
  var sql = build(extend({
    type: 'select',
    table: this.tableName
  }, query));
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
  query = this.preprocessQuery(query);
  var relation = this.relations[query.related ? query.related.model.modelName : ''];
  if (relation) query = this.relationQuery(relation, query);
  var sql = build(extend({
    type: 'select',
    columns: ['count(*)'],
    table: this.tableName
  }, query));
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
        if (!param.match(/(related|where|offset|limit|order|groupBy)$/)) {
          query.where[param] = query[param];
          delete query[param];
        }
      }
    }
  }
  return query;
};

/**
 * Process relation queries from `query.related`.
 *
 * @param {Object} relation
 * @param {Object} query
 * @return {Object} Returns modified query.
 * @api public
 */

plugin.relationQuery = function(relation, query) {
  var params = relation.params;
  if (params.through) {
    if (typeof params.through != 'string') {
      params.through = params.through.tableName;
    }
    query.innerJoin = {};
    query.innerJoin[params.through] = {};
    query.innerJoin[params.through][params.fromKey] = '$' + params.model.tableName + '.' + params.model.primaryKey + '$';
    query.where[params.through + '.' + params.foreignKey] = query.related.primary();
  }
  else {
    query.where[params.foreignKey] = query.related.primary();
  }
  delete query.related;
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
    else if (values[key] === undefined) {
      delete values[key];
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
    if (values[i] !== undefined) return this.escape(values[i]);
    return match;
  }.bind(this));
};

/**
 * Enable ANSI_QUOTES and set query formatter for new connections.
 *
 * @api private
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

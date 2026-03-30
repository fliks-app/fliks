/**
 * Module dependencies.
 */
var passport = require('passport-strategy')
  , util = require('util');

function Strategy(options, verify) {
  if (typeof options == 'function') {
    verify = options;
    options = {};
  }
  if (!verify) { throw new TypeError('HTTPHeaderStrategy requires a verify callback'); }

  passport.Strategy.call(this);
  this.name = 'header';
  this._verify = verify;
  this._realm = options.realm || 'Users';
  this._header = options.header || 'authorization';
  this._param = options.param || 'access_token';
  if (options.scope) {
    this._scope = (Array.isArray(options.scope)) ? options.scope : [ options.scope ];
  }
  this._passReqToCallback = options.passReqToCallback;
}

/**
 * Inherit from `passport.Strategy`.
 */
util.inherits(Strategy, passport.Strategy);

/**
 * Authenticate request based on the contents of a HTTP Bearer authorization
 * header, body parameter, or query parameter.
 *
 * @param {Object} req
 * @api protected
 */
Strategy.prototype.authenticate = function(req) {
  var token;

  if (req.headers && req.headers[this._header.toLowerCase()]) {
    var parts = req.headers[this._header.toLowerCase()].split(' ');
    if (parts.length === 2) {
      var scheme = parts[0]
        , credentials = parts[1];

      if (/^Bearer$/i.test(scheme)) {
        token = credentials;
      }
    }else if(parts.length === 1){
      token = parts[0];
    }
     else {
      return this.fail(400);
    }
  }

  if (req.body && req.body[this._param]) {
    if (token) { return this.fail(400); }
    token = req.body[this._param];
  }

  if (req.query && req.query[this._param]) {
    if (token) { return this.fail(400); }
    token = req.query[this._param];
  }

  if (!token) { return this.fail(this._challenge()); }

  var self = this;

  function verified(err, user, info) {
    if (err) { return self.error(err); }
    if (!user) {
      if (typeof info == 'string') {
        info = { message: info }
      }
      info = info || {};
      return self.fail(self._challenge('invalid_token', info.message));
    }
    self.success(user, info);
  }

  if (self._passReqToCallback) {
    this._verify(req, token, verified);
  } else {
    this._verify(token, verified);
  }
};

/**
 * Build authentication challenge.
 *
 * @api private
 */
Strategy.prototype._challenge = function(code, desc, uri) {
  var challenge = 'Bearer realm="' + this._realm + '"';
  if (this._scope) {
    challenge += ', scope="' + this._scope.join(' ') + '"';
  }
  if (code) {
    challenge += ', error="' + code + '"';
  }
  if (desc && desc.length) {
    challenge += ', error_description="' + desc + '"';
  }
  if (uri && uri.length) {
    challenge += ', error_uri="' + uri + '"';
  }

  return challenge;
};


/**
 * Expose `Strategy`.
 */
module.exports = Strategy;

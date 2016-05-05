// require_auth Haraka plugin

// requires authentication on connections when relaying

var net_utils = require('./net_utils');

exports.register = function() {
  this.register_hook('mail', 'require_authentication');
};

exports.require_authentication = function (next, connection, params) {
  var plugin = this;

  if (connection.relaying) return next();

  connection.logdebug(plugin, 'Attempting to relay without authentication. Denying');

  return next(DENY, 'Authentication required');
};

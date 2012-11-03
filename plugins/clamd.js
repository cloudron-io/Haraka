// clamd

var sock = require('./line_socket');

var defaults = {
    clamd_socket: 'localhost:3310',
    timeout: 60,
    max_size: 26214400,
    only_with_attachments: 0,
};

exports.hook_data = function (next, connection) {
    var plugin = this;
    // Load config
    var config = this.config.get('clamd.ini');
    for (var key in defaults) {
        config.main[key] = config.main[key] || defaults[key];
    }
    if (config.main['only_with_attachments']) {
        var transaction = connection.transaction;
        transaction.parse_body = 1;
        transaction.attachment_hooks(function (ctype, filename, body) {
            connection.logdebug(plugin, 'found ctype=' + ctype + ', filename=' + filename);
            transaction.notes.clamd_found_attachment = 1;
        });
    }
    return next();
}   

exports.hook_data_post = function (next, connection) {
    var plugin = this;
    var transaction = connection.transaction;

    // Config
    var config = this.config.get('clamd.ini');
    for (var key in defaults) {
        config.main[key] = config.main[key] || defaults[key];
    }

    // Do we need to run?
    if (config.main['only_with_attachments'] &&
        !transaction.notes.clamd_found_attachment)
    {
        connection.logdebug(plugin, 'skipping: no attachments found');
        return next();
    }

    // Limit message size
    if (transaction.data_bytes > config.main.max_size) {
        connection.loginfo(plugin, 'skipping: message exceeds maximum size');
        return next();
    }

    // TODO: allow a list of hosts to try
    var socket = new sock.Socket();
    if (config.main.clamd_socket.match(/\//)) {
        // assume unix socket
        socket.connect(config.main.clamd_socket);
    }
    else {
        var hostport = config.main.clamd_socket.split(/:/);
        socket.connect((hostport[1] || 3310), hostport[0]);
    }

    socket.setTimeout(config.main.timeout * 1000);

    socket.on('timeout', function () {
        connection.logerror(plugin, "connection timed out");
        socket.destroy();
        return next(DENYSOFT,'Virus scanner timed out');
    });
    socket.on('error', function (err) {
        connection.logerror(plugin, "connection failed: " + err);
        socket.destroy();
        return next(DENYSOFT,'Error connecting to virus scanner');
    });
    socket.on('connect', function () {
        var hp = socket.address(),
          addressInfo = hp === null ? '' : ' ' + hp.address + ':' + hp.port;
        connection.logdebug(plugin, 'connected to host' + addressInfo);
        socket.write("zINSTREAM\0", function () {
            transaction.messageStream.pipe(socket, { clamd_style: true });
        });
    });
    
    var result = "";
    socket.on('line', function (line) {
        connection.logprotocol(plugin, 'C:' + line);
        result = line.replace(/\r?\n/, '');
    });
    
    socket.on('end', function () {
        var m;
        if (/^stream: OK/.test(result)) {
            // OK
            return next();
        }
        else if ((m = /^stream: (\S+) FOUND/.exec(result))) {
            // Virus found
            if (m && m[1]) {
                var virus = m[1];
            }
            return next(DENY, 'Message is infected with ' +
                        (virus || 'UNKNOWN'));
        }
        else if (/size limit exceeded/.test(result)) {
            connection.logerror(plugin, 'INSTREAM size limit exceeded. ' +
                                        'Check StreamMaxLength in clamd.conf');
            // Continue as StreamMaxLength default is 25Mb
            return next();
        } else {
            // Unknown result
            connection.logerror(plugin, 'unknown result: ' + result);
            return next(DENYSOFT, 'Error running virus scanner');
        }
        return next();
    });
};

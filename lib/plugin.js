// Load modules

var Catbox = require('catbox');
var Hoek = require('hoek');
var Items = require('items');
var Kilt = require('kilt');
var Connection = require('./connection');
var Ext = require('./ext');
var Package = require('../package.json');
var Schema = require('./schema');


// Declare internals

var internals = {};


exports = module.exports = internals.Plugin = function (server, connections, env, parent) {         // env can be a realm or plugin name

    var self = this;

    Kilt.call(this, connections, server._events);

    this._parent = parent;

    // Public interface

    this.root = server;
    this.app = this.root._app;
    this.connections = connections;
    this.load = this.root._heavy.load;
    this.methods = this.root._methods.methods;
    this.mime = this.root._mime;
    this.plugins = this.root._plugins;
    this.settings = this.root._settings;
    this.version = Package.version;

    this.realm = typeof env !== 'string' ? env : {
        _extensions: {
            onPreAuth: new Ext(this.root),
            onPostAuth: new Ext(this.root),
            onPreHandler: new Ext(this.root),
            onPostHandler: new Ext(this.root),
            onPreResponse: new Ext(this.root)
        },
        modifiers: {
            route: {}
        },
        plugin: env,
        pluginOptions: {},
        plugins: {},
        settings: {
            bind: undefined,
            files: {
                relativeTo: undefined
            }
        }
    };

    this.auth = {
        default: function (opts) {

            self._applyChild('auth.default', 'auth', 'default', [opts]);
        },
        scheme: function (name, scheme) {

            self._applyChild('auth.scheme', 'auth', 'scheme', [name, scheme]);
        },
        strategy: function (name, scheme, mode, opts) {

            self._applyChild('auth.strategy', 'auth', 'strategy', [name, scheme, mode, opts]);
        },
        test: function (name, request, next) {

            return request.connection.auth.test(name, request, next);
        }
    };

    this._single();

    // Decorations

    var methods = Object.keys(this.root._decorations);
    for (var i = 0, il = methods.length; i < il; ++i) {
        var method = methods[i];
        this[method] = this.root._decorations[method];
    }
};

Hoek.inherits(internals.Plugin, Kilt);


internals.Plugin.prototype._single = function () {

    if (this.connections &&
        this.connections.length === 1) {

        this.info = this.connections[0].info;
        this.listener = this.connections[0].listener;
        this.registrations = this.connections[0].registrations;
    }
    else {
        this.info = null;
        this.listener = null;
        this.registrations = null;
    }
};


internals.Plugin.prototype.select = function (/* labels */) {

    var labels = [];
    for (var i = 0, il = arguments.length; i < il; ++i) {
        labels.push(arguments[i]);
    }

    labels = Hoek.flatten(labels);
    return this._select(labels);
};


internals.Plugin.prototype._select = function (labels, plugin) {

    var connections = this.connections;

    if (labels &&
        labels.length) {            // Captures both empty arrays and empty strings

        Hoek.assert(this.connections, 'Cannot select inside a connectionless plugin');

        connections = [];
        for (var i = 0, il = this.connections.length; i < il; ++i) {
            var connection = this.connections[i];
            if (Hoek.intersect(connection.settings.labels, labels).length) {
                connections.push(connection);
            }
        }

        if (!plugin &&
            connections.length === this.connections.length) {

            return this;
        }
    }

    var env = (plugin !== undefined ? plugin : this.realm);                     // Allow empty string
    return new internals.Plugin(this.root, connections, env, this);
};


internals.Plugin.prototype._clone = function (connections, plugin) {

    var env = (plugin !== undefined ? plugin : this.realm);                     // Allow empty string
    return new internals.Plugin(this.root, connections, env, this);
};


internals.Plugin.prototype.register = function (plugins /*, [options], callback */) {

    var self = this;

    var options = (typeof arguments[1] === 'object' ? arguments[1] : {});
    var callback = (typeof arguments[1] === 'object' ? arguments[2] : arguments[1]);

    Hoek.assert(typeof callback === 'function', 'A callback function is required to register a plugin');

    if (this.realm.modifiers.route.prefix ||
        this.realm.modifiers.route.vhost) {

        options = Hoek.clone(options);
        options.routes = options.routes || {};

        options.routes.prefix = (this.realm.modifiers.route.prefix || '') + (options.routes.prefix || '') || undefined;
        options.routes.vhost = this.realm.modifiers.route.vhost || options.routes.vhost;
    }

    options = Schema.apply('register', options);

    /*
        var register = function (server, options, next) { return next(); };
        register.attributes = {
            pkg: require('../package.json'),
            name: 'plugin',
            version: '1.1.1',
            multiple: false,
            dependencies: [],
            connections: false,
            once: true
        };

        var item = {
            register: register,
            options: options        // -optional--
        };

        - OR -

        var item = function () {}
        item.register = register;
        item.options = options;

        var plugins = register, items, [register, item]
    */

    var registrations = [];
    plugins = [].concat(plugins);
    for (var i = 0, il = plugins.length; i < il; ++i) {
        var plugin = plugins[i];

        if (typeof plugin === 'function') {
            if (!plugin.register) {                                 // plugin is register() function
                plugin = { register: plugin };
            }
            else {
                plugin = Hoek.shallow(plugin);                      // Convert function to object
            }
        }

        if (plugin.register.register) {                             // Required plugin
            plugin.register = plugin.register.register;
        }

        plugin = Schema.apply('plugin', plugin);

        var attributes = plugin.register.attributes;
        var registration = {
            register: plugin.register,
            name: attributes.name || attributes.pkg.name,
            version: attributes.version || attributes.pkg.version,
            multiple: attributes.multiple,
            pluginOptions: plugin.options,
            dependencies: attributes.dependencies,
            connections: attributes.connections,
            options: {
                once: attributes.once || (plugin.once !== undefined ? plugin.once : options.once),
                routes: {
                    prefix: plugin.routes.prefix || options.routes.prefix,
                    vhost: plugin.routes.vhost || options.routes.vhost
                },
                select: plugin.select || options.select
            }
        };

        registrations.push(registration);
    }

    this.root._registring = true;

    Items.serial(registrations, function (item, next) {

        var selection = self._select(item.options.select, item.name);
        selection.realm.modifiers.route.prefix = item.options.routes.prefix;
        selection.realm.modifiers.route.vhost = item.options.routes.vhost;
        selection.realm.pluginOptions = item.pluginOptions || {};

        // Protect against multiple registrations

        if (!item.connections) {
            if (self.root._registrations[item.name]) {
                if (item.options.once) {
                    return next();
                }

                Hoek.assert(item.multiple, 'Plugin', item.name, 'already registered');
            }
            else {
                self.root._registrations[item.name] = { version: item.version };
            }
        }

        var connections = [];
        if (selection.connections) {
            for (var j = 0, jl = selection.connections.length; j < jl; ++j) {
                var connection = selection.connections[j];
                if (connection.registrations[item.name]) {
                    if (item.options.once) {
                        continue;
                    }

                    Hoek.assert(item.multiple, 'Plugin', item.name, 'already registered in:', connection.info.uri);
                }
                else {
                    connection.registrations[item.name] = { version: item.version };
                }

                connections.push(connection);
            }

            if (item.options.once &&
                item.connections &&
                !connections.length) {

                return next();                                              // All the connections already registered
            }
        }

        selection.connections = (item.connections ? connections : null);
        selection._single();

        if (item.dependencies) {
            selection.dependency(item.dependencies);
        }

        if (!item.connections) {
            selection.connection = self.connection;
        }

        // Register

        item.register(selection, item.pluginOptions || {}, next);
    }, function (err) {

        self.root._registring = false;
        return callback(err);
    });
};


internals.Plugin.prototype.after = function (method, options) {

    options = options || {};

    if (Array.isArray(options) ||
        typeof options === 'string') {                      // For backwards compatibility

        options = { after: options };
    }

    this.ext('onPreStart', method, options);
};


internals.Plugin.prototype.bind = function (context) {

    Hoek.assert(typeof context === 'object', 'bind must be an object');
    this.realm.settings.bind = context;
};


internals.Plugin.prototype.cache = function (options, _segment) {

    options = Schema.apply('cachePolicy', options);

    var segment = options.segment || _segment || (this.realm.plugin ? '!' + this.realm.plugin : '');
    Hoek.assert(segment, 'Missing cache segment name');

    var cacheName = options.cache || '_default';
    var cache = this.root._caches[cacheName];
    Hoek.assert(cache, 'Unknown cache', cacheName);
    Hoek.assert(!cache.segments[segment] || cache.shared || options.shared, 'Cannot provision the same cache segment more than once');
    cache.segments[segment] = true;

    return new Catbox.Policy(options, cache.client, segment);
};


internals.Plugin.prototype.decorate = function (type, property, method) {

    Hoek.assert(['reply', 'request', 'server'].indexOf(type) !== -1, 'Unknown decoration type:', type);
    Hoek.assert(property, 'Missing decoration property name');
    Hoek.assert(typeof property === 'string', 'Decoration property must be a string');
    Hoek.assert(property[0] !== '_', 'Property name cannot begin with an underscore:', property);

    // Request

    if (type === 'request') {
        return this.root._requestor.decorate(property, method);
    }

    // Reply

    if (type === 'reply') {
        return this.root._replier.decorate(property, method);
    }

    // Server

    Hoek.assert(!this.root._decorations[property], 'Server decoration already defined:', property);
    Hoek.assert(this[property] === undefined && this.root[property] === undefined, 'Cannot override the built-in server interface method:', property);

    this.root._decorations[property] = method;

    this[property] = method;
    var parent = this._parent;
    while (parent) {
        parent[property] = method;
        parent = parent._parent;
    }
};


internals.Plugin.prototype.dependency = function (dependencies, after) {

    Hoek.assert(this.realm.plugin, 'Cannot call dependency() outside of a plugin');
    Hoek.assert(!after || typeof after === 'function', 'Invalid after method');

    dependencies = [].concat(dependencies);
    this.root._dependencies.push({ plugin: this.realm.plugin, connections: this.connections, deps: dependencies });

    if (after) {
        this.after(after, dependencies);
    }
};


internals.Plugin.prototype.expose = function (key, value) {

    Hoek.assert(this.realm.plugin, 'Cannot call expose() outside of a plugin');

    var plugin = this.realm.plugin;
    this.root.plugins[plugin] = this.root.plugins[plugin] || {};

    if (typeof key === 'string') {
        this.root.plugins[plugin][key] = value;
    }
    else {
        Hoek.merge(this.root.plugins[plugin], key);
    }
};


internals.Plugin.prototype.ext = function (events) {        // (event, method, options) -OR- (events)

    if (typeof events === 'string') {
        events = { type: arguments[0], method: arguments[1], options: arguments[2] };
    }

    events = Schema.apply('exts', events);

    for (var i = 0, il = events.length; i < il; ++i) {
        this._ext(events[i]);
    }
};


internals.Plugin.prototype._ext = function (event) {

    event = Hoek.shallow(event);
    event.plugin = this;
    var type = event.type;

    if (!this.root._extensions[type]) {

        // Realm route extensions

        if (event.options.sandbox === 'plugin') {
            Hoek.assert(this.realm._extensions[type], 'Unknown event type', type);
            return this.realm._extensions[type].add(event);
        }

        // Connection route extensions

        return this._apply('ext', Connection.prototype._ext, [event]);
    }

    // Server extensions

    Hoek.assert(!event.options.sandbox, 'Cannot specify sandbox option for server extension');
    Hoek.assert(type !== 'onPreStart' || this.root._state === 'stopped', 'Cannot add onPreStart (after) extension after the server was initialized');
    this.root._extensions[type].add(event);
};


internals.Plugin.prototype.handler = function (name, method) {

    Hoek.assert(typeof name === 'string', 'Invalid handler name');
    Hoek.assert(!this.root._handlers[name], 'Handler name already exists:', name);
    Hoek.assert(typeof method === 'function', 'Handler must be a function:', name);
    Hoek.assert(!method.defaults || typeof method.defaults === 'object' || typeof method.defaults === 'function', 'Handler defaults property must be an object or function');
    this.root._handlers[name] = method;
};


internals.Plugin.prototype.inject = function (options, callback) {

    Hoek.assert(this.connections.length === 1, 'Method not available when the selection has more than one connection or none');
    return this.connections[0].inject(options, callback);
};


internals.Plugin.prototype.log = function (tags, data, timestamp, _internal) {

    tags = (Array.isArray(tags) ? tags : [tags]);
    var now = (timestamp ? (timestamp instanceof Date ? timestamp.getTime() : timestamp) : Date.now());

    var event = {
        timestamp: now,
        tags: tags,
        data: data,
        internal: !!_internal
    };

    var tagsMap = Hoek.mapToObject(event.tags);
    this.root._events.emit('log', event, tagsMap);

    if (this.root._settings.debug &&
        this.root._settings.debug.log &&
        Hoek.intersect(tagsMap, this.root._settings.debug.log, true)) {

        console.error('Debug:', event.tags.join(', '), (data ? '\n    ' + (data.stack || (typeof data === 'object' ? Hoek.stringify(data) : data)) : ''));
    }
};


internals.Plugin.prototype._log = function (tags, data) {

    return this.log(tags, data, null, true);
};


internals.Plugin.prototype.lookup = function (id) {

    Hoek.assert(this.connections.length === 1, 'Method not available when the selection has more than one connection or none');
    return this.connections[0].lookup(id);
};


internals.Plugin.prototype.match = function (method, path, host) {

    Hoek.assert(this.connections.length === 1, 'Method not available when the selection has more than one connection or none');
    return this.connections[0].match(method, path, host);
};


internals.Plugin.prototype.method = function (name, method, options) {

    return this.root._methods.add(name, method, options, this.realm);
};


internals.Plugin.prototype.path = function (relativeTo) {

    Hoek.assert(relativeTo && typeof relativeTo === 'string', 'relativeTo must be a non-empty string');
    this.realm.settings.files.relativeTo = relativeTo;
};


internals.Plugin.prototype.route = function (options) {

    Hoek.assert(arguments.length === 1, 'Method requires a single object argument or a single array of objects');
    Hoek.assert(typeof options === 'object', 'Invalid route options');
    Hoek.assert(this.connections, 'Cannot add route from a connectionless plugin');
    Hoek.assert(this.connections.length, 'Cannot add a route without any connections');

    this._apply('route', Connection.prototype._route, [options, this]);
};


internals.Plugin.prototype.state = function (name, options) {

    this._applyChild('state', 'states', 'add', [name, options]);
};


internals.Plugin.prototype.table = function (host) {

    Hoek.assert(this.connections, 'Cannot request routing table from a connectionless plugin');

    var table = [];
    for (var i = 0, il = this.connections.length; i < il; ++i) {
        var connection = this.connections[i];
        table.push({ info: connection.info, labels: connection.settings.labels, table: connection.table(host) });
    }

    return table;
};


internals.Plugin.prototype._apply = function (type, func, args) {

    Hoek.assert(this.connections, 'Cannot add ' + type + ' from a connectionless plugin');
    Hoek.assert(this.connections.length, 'Cannot add ' + type + ' without a connection');

    for (var i = 0, il = this.connections.length; i < il; ++i) {
        func.apply(this.connections[i], args);
    }
};


internals.Plugin.prototype._applyChild = function (type, child, func, args) {

    Hoek.assert(this.connections, 'Cannot add ' + type + ' from a connectionless plugin');
    Hoek.assert(this.connections.length, 'Cannot add ' + type + ' without a connection');

    for (var i = 0, il = this.connections.length; i < il; ++i) {
        var obj = this.connections[i][child];
        obj[func].apply(obj, args);
    }
};

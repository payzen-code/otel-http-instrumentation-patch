"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpInstrumentation = void 0;
/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const api_1 = require("@opentelemetry/api");
const core_1 = require("@opentelemetry/core");
const semver = require("semver");
const url = require("url");
const utils = require("./utils");
const version_1 = require("./version");
const instrumentation_1 = require("@opentelemetry/instrumentation");
const core_2 = require("@opentelemetry/core");
const events_1 = require("events");
/**
 * Http instrumentation instrumentation for Opentelemetry
 */
class HttpInstrumentation extends instrumentation_1.InstrumentationBase {
    constructor(config) {
        super('@opentelemetry/instrumentation-http', version_1.VERSION, config);
        /** keep track on spans not ended */
        this._spanNotEnded = new WeakSet();
        this._version = process.versions.node;
        this._headerCapture = this._createHeaderCapture();
    }
    _updateMetricInstruments() {
        this._httpServerDurationHistogram = this.meter.createHistogram('http.server.duration', {
            description: 'measures the duration of the inbound HTTP requests',
            unit: 'ms',
            valueType: api_1.ValueType.DOUBLE,
        });
        this._httpClientDurationHistogram = this.meter.createHistogram('http.client.duration', {
            description: 'measures the duration of the outbound HTTP requests',
            unit: 'ms',
            valueType: api_1.ValueType.DOUBLE,
        });
    }
    _getConfig() {
        return this._config;
    }
    setConfig(config) {
        super.setConfig(config);
        this._headerCapture = this._createHeaderCapture();
    }
    init() {
        return [this._getHttpsInstrumentation(), this._getHttpInstrumentation()];
    }
    _getHttpInstrumentation() {
        return new instrumentation_1.InstrumentationNodeModuleDefinition('http', ['*'], _moduleExports => {
            const moduleExports = _moduleExports.default ? _moduleExports.default : _moduleExports;
            this._diag.debug(`Applying patch for http@${this._version}`);
            if ((0, instrumentation_1.isWrapped)(moduleExports.request)) {
                this._unwrap(moduleExports, 'request');
            }
            this._wrap(moduleExports, 'request', this._getPatchOutgoingRequestFunction('http'));
            if ((0, instrumentation_1.isWrapped)(moduleExports.get)) {
                this._unwrap(moduleExports, 'get');
            }
            this._wrap(moduleExports, 'get', this._getPatchOutgoingGetFunction(moduleExports.request));
            if ((0, instrumentation_1.isWrapped)(moduleExports.Server.prototype.emit)) {
                this._unwrap(moduleExports.Server.prototype, 'emit');
            }
            this._wrap(moduleExports.Server.prototype, 'emit', this._getPatchIncomingRequestFunction('http'));
            return moduleExports;
        }, moduleExports => {
            if (moduleExports === undefined)
                return;
            this._diag.debug(`Removing patch for http@${this._version}`);
            this._unwrap(moduleExports, 'request');
            this._unwrap(moduleExports, 'get');
            this._unwrap(moduleExports.Server.prototype, 'emit');
        });
    }
    _getHttpsInstrumentation() {
        return new instrumentation_1.InstrumentationNodeModuleDefinition('https', ['*'], _moduleExports => {
            const moduleExports = _moduleExports.default ? _moduleExports.default : _moduleExports;
            this._diag.debug(`Applying patch for https@${this._version}`);
            if ((0, instrumentation_1.isWrapped)(moduleExports.request)) {
                this._unwrap(moduleExports, 'request');
            }
            this._wrap(moduleExports, 'request', this._getPatchHttpsOutgoingRequestFunction('https'));
            if ((0, instrumentation_1.isWrapped)(moduleExports.get)) {
                this._unwrap(moduleExports, 'get');
            }
            this._wrap(moduleExports, 'get', this._getPatchHttpsOutgoingGetFunction(moduleExports.request));
            if ((0, instrumentation_1.isWrapped)(moduleExports.Server.prototype.emit)) {
                this._unwrap(moduleExports.Server.prototype, 'emit');
            }
            this._wrap(moduleExports.Server.prototype, 'emit', this._getPatchIncomingRequestFunction('https'));
            return moduleExports;
        }, moduleExports => {
            if (moduleExports === undefined)
                return;
            this._diag.debug(`Removing patch for https@${this._version}`);
            this._unwrap(moduleExports, 'request');
            this._unwrap(moduleExports, 'get');
            this._unwrap(moduleExports.Server.prototype, 'emit');
        });
    }
    /**
     * Creates spans for incoming requests, restoring spans' context if applied.
     */
    _getPatchIncomingRequestFunction(component) {
        return (original) => {
            return this._incomingRequestFunction(component, original);
        };
    }
    /**
     * Creates spans for outgoing requests, sending spans' context for distributed
     * tracing.
     */
    _getPatchOutgoingRequestFunction(component) {
        return (original) => {
            return this._outgoingRequestFunction(component, original);
        };
    }
    _getPatchOutgoingGetFunction(clientRequest) {
        return (_original) => {
            // Re-implement http.get. This needs to be done (instead of using
            // getPatchOutgoingRequestFunction to patch it) because we need to
            // set the trace context header before the returned http.ClientRequest is
            // ended. The Node.js docs state that the only differences between
            // request and get are that (1) get defaults to the HTTP GET method and
            // (2) the returned request object is ended immediately. The former is
            // already true (at least in supported Node versions up to v10), so we
            // simply follow the latter. Ref:
            // https://nodejs.org/dist/latest/docs/api/http.html#http_http_get_options_callback
            // https://github.com/googleapis/cloud-trace-nodejs/blob/master/src/instrumentations/instrumentation-http.ts#L198
            return function outgoingGetRequest(options, ...args) {
                const req = clientRequest(options, ...args);
                req.end();
                return req;
            };
        };
    }
    /** Patches HTTPS outgoing requests */
    _getPatchHttpsOutgoingRequestFunction(component) {
        return (original) => {
            const instrumentation = this;
            return function httpsOutgoingRequest(
            // eslint-disable-next-line node/no-unsupported-features/node-builtins
            options, ...args) {
                var _a;
                // Makes sure options will have default HTTPS parameters
                if (component === 'https' &&
                    typeof options === 'object' &&
                    ((_a = options === null || options === void 0 ? void 0 : options.constructor) === null || _a === void 0 ? void 0 : _a.name) !== 'URL') {
                    options = Object.assign({}, options);
                    instrumentation._setDefaultOptions(options);
                }
                return instrumentation._getPatchOutgoingRequestFunction(component)(original)(options, ...args);
            };
        };
    }
    _setDefaultOptions(options) {
        options.protocol = options.protocol || 'https:';
        options.port = options.port || 443;
    }
    /** Patches HTTPS outgoing get requests */
    _getPatchHttpsOutgoingGetFunction(clientRequest) {
        return (original) => {
            const instrumentation = this;
            return function httpsOutgoingRequest(
            // eslint-disable-next-line node/no-unsupported-features/node-builtins
            options, ...args) {
                return instrumentation._getPatchOutgoingGetFunction(clientRequest)(original)(options, ...args);
            };
        };
    }
    /**
     * Attach event listeners to a client request to end span and add span attributes.
     *
     * @param request The original request object.
     * @param options The arguments to the original function.
     * @param span representing the current operation
     * @param startTime representing the start time of the request to calculate duration in Metric
     * @param metricAttributes metric attributes
     */
    _traceClientRequest(request, hostname, span, startTime, metricAttributes) {
        if (this._getConfig().requestHook) {
            this._callRequestHook(span, request);
        }
        /*
         * User 'response' event listeners can be added before our listener,
         * force our listener to be the first, so response emitter is bound
         * before any user listeners are added to it.
         */
        request.prependListener('response', (response) => {
            const responseAttributes = utils.getOutgoingRequestAttributesOnResponse(response);
            span.setAttributes(responseAttributes);
            metricAttributes = Object.assign(metricAttributes, utils.getOutgoingRequestMetricAttributesOnResponse(responseAttributes));
            if (this._getConfig().responseHook) {
                this._callResponseHook(span, response);
            }
            this._headerCapture.client.captureRequestHeaders(span, header => request.getHeader(header));
            this._headerCapture.client.captureResponseHeaders(span, header => response.headers[header]);
            api_1.context.bind(api_1.context.active(), response);
            this._diag.debug('outgoingRequest on response()');
            response.on('end', () => {
                this._diag.debug('outgoingRequest on end()');
                let status;
                if (response.aborted && !response.complete) {
                    status = { code: api_1.SpanStatusCode.ERROR };
                }
                else {
                    status = {
                        code: utils.parseResponseStatus(api_1.SpanKind.CLIENT, response.statusCode),
                    };
                }
                span.setStatus(status);
                if (this._getConfig().applyCustomAttributesOnSpan) {
                    (0, instrumentation_1.safeExecuteInTheMiddle)(() => this._getConfig().applyCustomAttributesOnSpan(span, request, response), () => { }, true);
                }
                this._closeHttpSpan(span, api_1.SpanKind.CLIENT, startTime, metricAttributes);
            });
            response.on(events_1.errorMonitor, (error) => {
                this._diag.debug('outgoingRequest on error()', error);
                utils.setSpanWithError(span, error);
                const code = utils.parseResponseStatus(api_1.SpanKind.CLIENT, response.statusCode);
                span.setStatus({ code, message: error.message });
                this._closeHttpSpan(span, api_1.SpanKind.CLIENT, startTime, metricAttributes);
            });
        });
        request.on('close', () => {
            this._diag.debug('outgoingRequest on request close()');
            if (!request.aborted) {
                this._closeHttpSpan(span, api_1.SpanKind.CLIENT, startTime, metricAttributes);
            }
        });
        request.on(events_1.errorMonitor, (error) => {
            this._diag.debug('outgoingRequest on request error()', error);
            utils.setSpanWithError(span, error);
            this._closeHttpSpan(span, api_1.SpanKind.CLIENT, startTime, metricAttributes);
        });
        this._diag.debug('http.ClientRequest return request');
        return request;
    }
    _incomingRequestFunction(component, original) {
        const instrumentation = this;
        return function incomingRequest(event, ...args) {
            // Only traces request events
            if (event !== 'request') {
                return original.apply(this, [event, ...args]);
            }
            const request = args[0];
            const response = args[1];
            const pathname = request.url
                ? url.parse(request.url).pathname || '/'
                : '/';
            const method = request.method || 'GET';
            instrumentation._diag.debug(`${component} instrumentation incomingRequest`);
            if (utils.isIgnored(pathname, instrumentation._getConfig().ignoreIncomingPaths, (e) => instrumentation._diag.error('caught ignoreIncomingPaths error: ', e)) ||
                (0, instrumentation_1.safeExecuteInTheMiddle)(() => { var _a, _b; return (_b = (_a = instrumentation._getConfig()).ignoreIncomingRequestHook) === null || _b === void 0 ? void 0 : _b.call(_a, request); }, (e) => {
                    if (e != null) {
                        instrumentation._diag.error('caught ignoreIncomingRequestHook error: ', e);
                    }
                }, true)) {
                return api_1.context.with((0, core_1.suppressTracing)(api_1.context.active()), () => {
                    api_1.context.bind(api_1.context.active(), request);
                    api_1.context.bind(api_1.context.active(), response);
                    return original.apply(this, [event, ...args]);
                });
            }
            const headers = request.headers;
            const spanAttributes = utils.getIncomingRequestAttributes(request, {
                component: component,
                serverName: instrumentation._getConfig().serverName,
                hookAttributes: instrumentation._callStartSpanHook(request, instrumentation._getConfig().startIncomingSpanHook),
            });
            const spanOptions = {
                kind: api_1.SpanKind.SERVER,
                attributes: spanAttributes,
            };
            const startTime = (0, core_1.hrTime)();
            const metricAttributes = utils.getIncomingRequestMetricAttributes(spanAttributes);
            const ctx = api_1.propagation.extract(api_1.ROOT_CONTEXT, headers);
            const span = instrumentation._startHttpSpan(`${component.toLocaleUpperCase()} ${method}`, spanOptions, ctx);
            const rpcMetadata = {
                type: core_2.RPCType.HTTP,
                span,
            };
            return api_1.context.with((0, core_2.setRPCMetadata)(api_1.trace.setSpan(ctx, span), rpcMetadata), () => {
                api_1.context.bind(api_1.context.active(), request);
                api_1.context.bind(api_1.context.active(), response);
                if (instrumentation._getConfig().requestHook) {
                    instrumentation._callRequestHook(span, request);
                }
                if (instrumentation._getConfig().responseHook) {
                    instrumentation._callResponseHook(span, response);
                }
                instrumentation._headerCapture.server.captureRequestHeaders(span, header => request.headers[header]);
                // After 'error', no further events other than 'close' should be emitted.
                let hasError = false;
                response.on('close', () => {
                    if (hasError) {
                        return;
                    }
                    instrumentation._onServerResponseFinish(request, response, span, metricAttributes, startTime);
                });
                response.on(events_1.errorMonitor, (err) => {
                    hasError = true;
                    instrumentation._onServerResponseError(span, metricAttributes, startTime, err);
                });
                return (0, instrumentation_1.safeExecuteInTheMiddle)(() => original.apply(this, [event, ...args]), error => {
                    if (error) {
                        utils.setSpanWithError(span, error);
                        instrumentation._closeHttpSpan(span, api_1.SpanKind.SERVER, startTime, metricAttributes);
                        throw error;
                    }
                });
            });
        };
    }
    _outgoingRequestFunction(component, original) {
        const instrumentation = this;
        return function outgoingRequest(options, ...args) {
            if (!utils.isValidOptionsType(options)) {
                return original.apply(this, [options, ...args]);
            }
            const extraOptions = typeof args[0] === 'object' &&
                (typeof options === 'string' || options instanceof url.URL)
                ? args.shift()
                : undefined;
            const { origin, pathname, method, optionsParsed } = utils.getRequestInfo(options, extraOptions);
            /**
             * Node 8's https module directly call the http one so to avoid creating
             * 2 span for the same request we need to check that the protocol is correct
             * See: https://github.com/nodejs/node/blob/v8.17.0/lib/https.js#L245
             */
            if (component === 'http' &&
                semver.lt(process.version, '9.0.0') &&
                optionsParsed.protocol === 'https:') {
                return original.apply(this, [optionsParsed, ...args]);
            }
            if (utils.isIgnored(origin + pathname, instrumentation._getConfig().ignoreOutgoingUrls, (e) => instrumentation._diag.error('caught ignoreOutgoingUrls error: ', e)) ||
                (0, instrumentation_1.safeExecuteInTheMiddle)(() => {
                    var _a, _b;
                    return (_b = (_a = instrumentation
                        ._getConfig()).ignoreOutgoingRequestHook) === null || _b === void 0 ? void 0 : _b.call(_a, optionsParsed);
                }, (e) => {
                    if (e != null) {
                        instrumentation._diag.error('caught ignoreOutgoingRequestHook error: ', e);
                    }
                }, true)) {
                return original.apply(this, [optionsParsed, ...args]);
            }
            const operationName = `${component.toUpperCase()} ${method}`;
            const { hostname, port } = utils.extractHostnameAndPort(optionsParsed);
            const attributes = utils.getOutgoingRequestAttributes(optionsParsed, {
                component,
                port,
                hostname,
                hookAttributes: instrumentation._callStartSpanHook(optionsParsed, instrumentation._getConfig().startOutgoingSpanHook),
            });
            const startTime = (0, core_1.hrTime)();
            const metricAttributes = utils.getOutgoingRequestMetricAttributes(attributes);
            const spanOptions = {
                kind: api_1.SpanKind.CLIENT,
                attributes,
            };
            const span = instrumentation._startHttpSpan(operationName, spanOptions);
            const parentContext = api_1.context.active();
            const requestContext = api_1.trace.setSpan(parentContext, span);
            if (!optionsParsed.headers) {
                optionsParsed.headers = {};
            }
            api_1.propagation.inject(requestContext, optionsParsed.headers);
            return api_1.context.with(requestContext, () => {
                /*
                 * The response callback is registered before ClientRequest is bound,
                 * thus it is needed to bind it before the function call.
                 */
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    args[args.length - 1] = api_1.context.bind(parentContext, cb);
                }
                const request = (0, instrumentation_1.safeExecuteInTheMiddle)(() => original.apply(this, [optionsParsed, ...args]), error => {
                    if (error) {
                        utils.setSpanWithError(span, error);
                        instrumentation._closeHttpSpan(span, api_1.SpanKind.CLIENT, startTime, metricAttributes);
                        throw error;
                    }
                });
                instrumentation._diag.debug(`${component} instrumentation outgoingRequest`);
                api_1.context.bind(parentContext, request);
                return instrumentation._traceClientRequest(request, hostname, span, startTime, metricAttributes);
            });
        };
    }
    _onServerResponseFinish(request, response, span, metricAttributes, startTime) {
        const attributes = utils.getIncomingRequestAttributesOnResponse(request, response);
        metricAttributes = Object.assign(metricAttributes, utils.getIncomingRequestMetricAttributesOnResponse(attributes));
        this._headerCapture.server.captureResponseHeaders(span, header => response.getHeader(header));
        span.setAttributes(attributes).setStatus({
            code: utils.parseResponseStatus(api_1.SpanKind.SERVER, response.statusCode),
        });
        if (this._getConfig().applyCustomAttributesOnSpan) {
            (0, instrumentation_1.safeExecuteInTheMiddle)(() => this._getConfig().applyCustomAttributesOnSpan(span, request, response), () => { }, true);
        }
        this._closeHttpSpan(span, api_1.SpanKind.SERVER, startTime, metricAttributes);
    }
    _onServerResponseError(span, metricAttributes, startTime, error) {
        utils.setSpanWithError(span, error);
        this._closeHttpSpan(span, api_1.SpanKind.SERVER, startTime, metricAttributes);
    }
    _startHttpSpan(name, options, ctx = api_1.context.active()) {
        /*
         * If a parent is required but not present, we use a `NoopSpan` to still
         * propagate context without recording it.
         */
        const requireParent = options.kind === api_1.SpanKind.CLIENT
            ? this._getConfig().requireParentforOutgoingSpans
            : this._getConfig().requireParentforIncomingSpans;
        let span;
        const currentSpan = api_1.trace.getSpan(ctx);
        if (requireParent === true && currentSpan === undefined) {
            span = api_1.trace.wrapSpanContext(api_1.INVALID_SPAN_CONTEXT);
        }
        else if (requireParent === true && (currentSpan === null || currentSpan === void 0 ? void 0 : currentSpan.spanContext().isRemote)) {
            span = currentSpan;
        }
        else {
            span = this.tracer.startSpan(name, options, ctx);
        }
        this._spanNotEnded.add(span);
        return span;
    }
    _closeHttpSpan(span, spanKind, startTime, metricAttributes) {
        if (!this._spanNotEnded.has(span)) {
            return;
        }
        span.end();
        this._spanNotEnded.delete(span);
        // Record metrics
        const duration = (0, core_1.hrTimeToMilliseconds)((0, core_1.hrTimeDuration)(startTime, (0, core_1.hrTime)()));
        if (spanKind === api_1.SpanKind.SERVER) {
            this._httpServerDurationHistogram.record(duration, metricAttributes);
        }
        else if (spanKind === api_1.SpanKind.CLIENT) {
            this._httpClientDurationHistogram.record(duration, metricAttributes);
        }
    }
    _callResponseHook(span, response) {
        (0, instrumentation_1.safeExecuteInTheMiddle)(() => this._getConfig().responseHook(span, response), () => { }, true);
    }
    _callRequestHook(span, request) {
        (0, instrumentation_1.safeExecuteInTheMiddle)(() => this._getConfig().requestHook(span, request), () => { }, true);
    }
    _callStartSpanHook(request, hookFunc) {
        if (typeof hookFunc === 'function') {
            return (0, instrumentation_1.safeExecuteInTheMiddle)(() => hookFunc(request), () => { }, true);
        }
    }
    _createHeaderCapture() {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
        const config = this._getConfig();
        return {
            client: {
                captureRequestHeaders: utils.headerCapture('request', (_c = (_b = (_a = config.headersToSpanAttributes) === null || _a === void 0 ? void 0 : _a.client) === null || _b === void 0 ? void 0 : _b.requestHeaders) !== null && _c !== void 0 ? _c : []),
                captureResponseHeaders: utils.headerCapture('response', (_f = (_e = (_d = config.headersToSpanAttributes) === null || _d === void 0 ? void 0 : _d.client) === null || _e === void 0 ? void 0 : _e.responseHeaders) !== null && _f !== void 0 ? _f : []),
            },
            server: {
                captureRequestHeaders: utils.headerCapture('request', (_j = (_h = (_g = config.headersToSpanAttributes) === null || _g === void 0 ? void 0 : _g.server) === null || _h === void 0 ? void 0 : _h.requestHeaders) !== null && _j !== void 0 ? _j : []),
                captureResponseHeaders: utils.headerCapture('response', (_m = (_l = (_k = config.headersToSpanAttributes) === null || _k === void 0 ? void 0 : _k.server) === null || _l === void 0 ? void 0 : _l.responseHeaders) !== null && _m !== void 0 ? _m : []),
            },
        };
    }
}
exports.HttpInstrumentation = HttpInstrumentation;
//# sourceMappingURL=http.js.map
const BackOff = require('backo');
const joi = require('joi');

const BACKOFF_PARAMS = { min: 1000, max: 300000, jitter: 0.1, factor: 1.5 };

const backbeatTaskConfigJoi = {
    retryTimeoutS: joi.number().default(300),
};

function logg(str) {
    process.stdout.write(str);
    process.stdout.write('\n');
}

/**
 * @class BackbeatTask
 */
class BackbeatTask {
    /**
     * @constructor
     * @param {Object} [config] - config object containing various
     *   task-specific configuration
     * @param {Number} [config.retryTimeoutS] - timeout of retries, in
     *   seconds
     */
    constructor(config) {
        this.config = joi.attempt(config || {}, backbeatTaskConfigJoi,
                                  'invalid backbeat task config');
    }

    retry(args, done) {
        const { actionDesc, logFields,
                actionFunc, shouldRetryFunc, onRetryFunc, log } = args;
        const backoffCtx = new BackOff(BACKOFF_PARAMS);
        let nbRetries = 0;
        const startTime = Date.now();
        const self = this;

        function _handleRes(...args) {
            const err = args[0];
            if (err) {
                if (!shouldRetryFunc(err)) {
                    if (err.destReq) {
                        logg('HELLO WORLD-3');
                        err.destReq.abort();
                        err.incomingMsg.abort();
                        // eslint-disable-next-line no-param-reassign
                        delete err.destReq;
                        // eslint-disable-next-line no-param-reassign
                        delete err.incomingMsg;
                    }
                    return done(err);
                }
                if (onRetryFunc) {
                    onRetryFunc(err);
                }

                const now = Date.now();
                if (now > (startTime + self.config.retryTimeoutS * 1000)) {
                    log.error(
                        `retried for too long to ${actionDesc}, giving up`,
                        Object.assign({
                            nbRetries,
                            retryTotalMs: `${now - startTime}`,
                        }, logFields || {}), log);
                    if (err.destReq) {
                        logg('HELLO WORLD-4');
                        err.destReq.abort();
                        err.incomingMsg.abort();
                        // eslint-disable-next-line no-param-reassign
                        delete err.destReq;
                        // eslint-disable-next-line no-param-reassign
                        delete err.incomingMsg;
                    }
                    return done(err);
                }
                const retryDelayMs = backoffCtx.duration();
                log.info(`temporary failure to ${actionDesc}, scheduled retry`,
                         Object.assign({ nbRetries,
                                         retryDelay: `${retryDelayMs}ms` },
                                       logFields || {}));
                nbRetries += 1;
                return setTimeout(() => actionFunc(_handleRes), retryDelayMs);
            }
            if (nbRetries > 0) {
                const now = Date.now();
                log.info(`succeeded to ${actionDesc} after retries`,
                         Object.assign({
                             nbRetries,
                             retryTotalMs: `${now - startTime}`,
                         }, logFields || {}));
            }
            return done(...args);
        }
        actionFunc(_handleRes);
    }
}

module.exports = BackbeatTask;
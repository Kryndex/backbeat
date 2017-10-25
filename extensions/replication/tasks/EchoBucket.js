const async = require('async');

const errors = require('arsenal').errors;

const BackbeatTask = require('../../../lib/tasks/BackbeatTask');
const SetupReplication = require('../utils/SetupReplication');

class EchoBucket extends BackbeatTask {
    /**
     * Process a single replication entry
     *
     * @constructor
     * @param {QueueProcessor} qp - queue processor instance
     */
    constructor(qp) {
        const qpState = qp.getStateVars();
        super({
            retryTimeoutS: qpState.repConfig.queueProcessor.retryTimeoutS,
        });
        Object.assign(this, qpState);
        this._bidirectionalReplication =
            qpState.repConfig.queueProcessor.bidirectionalReplication;
    }

    _getSourceAccountCreds(sourceEntry, log, done) {
        const canonicalId = sourceEntry.getOwnerCanonicalID();
        let displayName;
        let email;
        let accountCreds;

        const sourceS3Vault = this.vaultClientCache.getClient('source:s3');
        const sourceAdminVault =
                  this.vaultClientCache.getClient('source:admin');
        async.waterfall([
            done => {
                // XXX HACK: will not work with > 1000 account, needs
                // a proper route to get account name from canonical
                // ID
                sourceAdminVault.listAccounts(
                    { maxItems: 1000 }, (err, data) => {
                        if (err) {
                            return done(err);
                        }
                        data.accounts.forEach(account => {
                            if (account.canonicalId === canonicalId) {
                                displayName = account.name;
                            }
                        });
                        if (!displayName) {
                            return done(errors.InternalError);
                        }
                        return done();
                    });
            },
            done => sourceS3Vault.getEmailAddresses(
                [canonicalId], { reqUid: log.getSerializedUids() }, done),
            (res, done) => {
                email = res.message.body[canonicalId];
                accountCreds = this.accountCredsCache[canonicalId];
                if (accountCreds) {
                    return done(null, null);
                }
                return sourceAdminVault.generateAccountAccessKey(
                    displayName, done);
            }, (res, done) => {
                if (res) {
                    accountCreds = {
                        accessKeyId: res.id,
                        secretAccessKey: res.value,
                    };
                    this.accountCredsCache[canonicalId] = accountCreds;
                }
                return done();
            },
        ], err => {
            if (err) {
                return done(err);
            }
            return done(null, displayName, email, accountCreds);
        });
    }

    _getTargetAccountCreds(sourceEntry, displayName, email, log, done) {
        let canonicalId;
        let accountCreds;
        const { host, port } = this.destHosts.pickHost();
        // if no nginx proxy is used, the client port is preset in the
        // profile and the provided port is only used in the cache key
        const destAdminVault = this.vaultClientCache.getClient('dest:admin',
                                                               host, port);
        const destS3Vault = this.vaultClientCache.getClient('dest:s3',
                                                            host, port);

        async.waterfall([
            done => destS3Vault.getCanonicalIds(
                [email], { reqUid: log.getSerializedUids() }, done),
            (res, done) => {
                if (res.message.body[email] === 'NotFound') {
                    return destAdminVault.createAccount(displayName, { email },
                                                        done);
                }
                return done(null,
                            { account: {
                                canonicalId: res.message.body[email],
                            } });
            }, (res, done) => {
                canonicalId = res.account.canonicalId;
                accountCreds = this.accountCredsCache[canonicalId];
                if (accountCreds) {
                    return done(null, null);
                }
                return destAdminVault.generateAccountAccessKey(displayName,
                                                               done);
            }, (res, done) => {
                if (res) {
                    accountCreds = {
                        accessKeyId: res.id,
                        secretAccessKey: res.value,
                    };
                    this.accountCredsCache[canonicalId] = accountCreds;
                }
                return done();
            },
        ], err => {
            if (err) {
                return done(err);
            }
            return done(null, accountCreds);
        });
    }

    processQueueEntry(sourceEntry, done) {
        const log = this.logger.newRequestLogger();
        let displayName;
        let email;
        let srcCreds;
        let tgtCreds;

        if (process.env.BACKBEAT_ECHO_TEST_MODE === '1' &&
            sourceEntry.getBucket().endsWith('-dest')) {
            return process.nextTick(done);
        }
        return async.waterfall([
            done => this._getSourceAccountCreds(sourceEntry, log, done),
            (_displayName, _email, _srcCreds, done) => {
                displayName = _displayName;
                email = _email;
                srcCreds = _srcCreds;
                this._getTargetAccountCreds(sourceEntry, displayName, email,
                                            log, done);
            },
            (_tgtCreds, done) => {
                tgtCreds = _tgtCreds;
                // test hook to cope with using same endpoint for
                // source and destination
                const destBucket =
                          (process.env.BACKBEAT_ECHO_TEST_MODE === '1' ?
                           `${sourceEntry.getBucket()}-dest` :
                           sourceEntry.getBucket());
                const setupReplication = new SetupReplication({
                    source: {
                        bucket: sourceEntry.getBucket(),
                        credentials: srcCreds,
                        s3: this.sourceConfig.s3,
                        vault: this.sourceConfig.auth.vault,
                        transport: this.sourceConfig.transport,
                    },
                    target: {
                        bucket: destBucket,
                        credentials: tgtCreds,
                        hosts: this.destHosts,
                        vault: this.destConfig.auth.vault,
                        transport: this.destConfig.transport,
                    },
                    retryTimeoutS: this.repConfig.queueProcessor.retryTimeoutS,
                    skipSourceBucketCreation: true,
                    bidirectionalReplication: this._bidirectionalReplication,
                    log,
                });
                setupReplication.setupReplication(done);
            },
            (info, done) => {
                log.end().info(
                    'echo mode: configured replication for bucket',
                    Object.assign({ bucket: sourceEntry.getBucket(),
                                    userName: displayName,
                                    userEmail: email },
                                  info));
                done();
            },
        ], err => {
            if (err) {
                log.end().error(
                    'echo mode: error during replication configuration',
                    { bucket: sourceEntry.getBucket(),
                      userName: displayName,
                      userEmail: email,
                      error: err,
                    });
            }
            return done(err);
        });
    }
}

module.exports = EchoBucket;

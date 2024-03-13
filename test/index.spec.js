'use strict'
const { startTestServer, appendMessage } = require('./imapTestServer')
const expect = require('chai').expect

let serverInstance = null
beforeEach(function () {
    return startTestServer().then(function (server) {
        serverInstance = server
    })
})
afterEach(function () {
    serverInstance.close()
})

const config = {
    imap: {
        user: 'testuser',
        password: 'testpass',
        host: 'localhost',
        port: 1143,
        tls: false,
        authTimeout: 3000,
    },
}

describe('imap-simple', function () {
    this.timeout(20000)

    const imaps = require('../dist')

    it('lists unseen emails only', function () {
        return imaps.connect(config).then(function (connection) {
            return connection
                .openBox('INBOX')
                .then(function () {
                    return appendMessage(
                        connection,
                        'jim@example.com',
                        'unseen 1',
                    )
                })
                .then(function () {
                    return appendMessage(
                        connection,
                        'john@example.com',
                        'seen 2',
                        '\\Seen',
                    )
                })
                .then(function () {
                    return appendMessage(
                        connection,
                        'james@example.com',
                        'unseen 3',
                    )
                })
                .then(function () {
                    const searchCriteria = ['UNSEEN']

                    const fetchOptions = {
                        bodies: ['HEADER', 'TEXT'],
                        markSeen: false,
                    }

                    return connection
                        .search(searchCriteria, fetchOptions)
                        .then(function (results) {
                            const subjects = results.map(function (res) {
                                return res.parts.filter(function (part) {
                                    return part.which === 'HEADER'
                                })[0].body.subject[0]
                            })

                            expect(subjects).to.eql(['unseen 1', 'unseen 3'])
                            console.log(subjects)
                        })
                })
        })
    })

    it('deletes messages', function () {
        return imaps.connect(config).then(function (connection) {
            return connection
                .openBox('INBOX')
                .then(function () {
                    return appendMessage(
                        connection,
                        'jim@example.com',
                        'hello from jim',
                    )
                })
                .then(function () {
                    return appendMessage(
                        connection,
                        'bob@example.com',
                        'hello from bob',
                    )
                })
                .then(function () {
                    return appendMessage(
                        connection,
                        'bob@example.com',
                        'hello again from bob',
                    )
                })
                .then(function () {
                    return connection.search(['ALL'], { bodies: ['HEADER'] })
                })
                .then(function (messages) {
                    const uidsToDelete = messages
                        .filter(function (message) {
                            return (
                                message.parts.filter(function (part) {
                                    return part.which === 'HEADER'
                                })[0].body.to[0] === 'bob@example.com'
                            )
                        })
                        .map(function (message) {
                            return message.attributes.uid
                        })

                    return connection.deleteMessage(uidsToDelete)
                })
                .then(function () {
                    return connection.search(['ALL'], { bodies: ['HEADER'] })
                })
                .then(function (messages) {
                    const subjects = messages.map(function (res) {
                        return res.parts.filter(function (part) {
                            return part.which === 'HEADER'
                        })[0].body.subject[0]
                    })

                    expect(subjects).to.eql(['hello from jim'])
                    console.log(subjects)
                })
        })
    })
})

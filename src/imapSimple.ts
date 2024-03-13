import Imap, { type ImapMessage } from 'imap'
import * as nodeify from 'nodeify'
import { EventEmitter } from 'events'
import * as qp from 'quoted-printable'
import * as iconvlite from 'iconv-lite'
import * as utf8 from 'utf8'
import * as uuencode from 'uuencode'

import { getMessage, type Message } from './helpers/getMessage'
import { ConnectionTimeoutError } from './errors'

const IMAP_EVENTS = [
  'alert',
  'mail',
  'expunge',
  'uidvalidity',
  'update',
  'close',
  'end',
] as const

/**
 * Constructs an instance of ImapSimple
 *
 * @param {object} imap a constructed node-imap connection
 */
export class ImapSimple extends EventEmitter {
  /** flag to determine whether we should suppress ECONNRESET from bubbling up to listener */
  private ending = false

  constructor(private readonly imap: Imap) {
    super()

    // pass most node-imap `Connection` events through 1:1
    IMAP_EVENTS.forEach((event) => {
      this.imap.on(event, this.emit.bind(this, event))
    })

    // special handling for `error` event
    this.imap.on('error', (err) => {
      // if .end() has been called and an 'ECONNRESET' error is received, don't bubble
      if (err && this.ending && err.code.toUpperCase() === 'ECONNRESET') {
        return
      }
      this.emit('error', err)
    })
  }

  /**
   * disconnect from the imap server
   */
  end() {
    // set state flag to suppress 'ECONNRESET' errors that are triggered when .end() is called.
    // it is a known issue that has no known fix. This just temporarily ignores that error.
    // https://github.com/mscdex/node-imap/issues/391
    // https://github.com/mscdex/node-imap/issues/395
    this.ending = true

    // using 'close' event to unbind ECONNRESET error handler, because the node-imap
    // maintainer claims it is the more reliable event between 'end' and 'close'.
    // https://github.com/mscdex/node-imap/issues/394
    this.imap.once('close', () => {
      this.ending = false
    })

    this.imap.end()
  }

  /**
   * Open a mailbox
   *
   * @param {string} boxName The name of the box to open
   * @param {function} [callback] Optional callback, receiving signature (err, boxName)
   * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving to `boxName`
   * @memberof ImapSimple
   */
  openBox(boxName: string, callback?: Function) {
    if (callback) {
      return nodeify(this.openBox(boxName), callback)
    }

    return new Promise((resolve, reject) => {
      this.imap.openBox(boxName, (err, result) => {
        err ? reject(err) : resolve(result)
      })
    })
  }

  /**
   * Close a mailbox
   *
   * @param {boolean} [autoExpunge=true] If autoExpunge is true, any messages marked as Deleted in the currently open mailbox will be remove
   * @param {function} [callback] Optional callback, receiving signature (err)
   * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving to `boxName`
   * @memberof ImapSimple
   */
  closeBox(autoExpunge = true, callback?: Function) {
    if (typeof autoExpunge === 'function') {
      callback = autoExpunge
      autoExpunge = true
    }

    if (callback) {
      return nodeify(this.closeBox(autoExpunge), callback)
    }

    return new Promise<void>((resolve, reject) => {
      this.imap.closeBox(autoExpunge, (err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  /**
   * Search the currently open mailbox, and retrieve the results
   *
   * Results are in the form:
   *
   * [{
   *   attributes: object,
   *   parts: [ { which: string, size: number, body: string }, ... ]
   * }, ...]
   *
   * See node-imap's ImapMessage signature for information about `attributes`, `which`, `size`, and `body`.
   * For any message part that is a `HEADER`, the body is automatically parsed into an object.
   *
   * @param {object} searchCriteria Criteria to use to search. Passed to node-imap's .search() 1:1
   * @param {object} fetchOptions Criteria to use to fetch the search results. Passed to node-imap's .fetch() 1:1
   * @param {function} [callback] Optional callback, receiving signature (err, results)
   * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving to `results`
   * @memberof ImapSimple
   */
  search(
    searchCriteria: any,
    fetchOptions: any,
    callback?: Function,
  ): Promise<Message[]> {
    if (!callback && typeof fetchOptions === 'function') {
      callback = fetchOptions
      fetchOptions = null
    }

    if (callback) {
      return nodeify(this.search(searchCriteria, fetchOptions), callback)
    }

    return new Promise((resolve, reject) => {
      this.imap.search(searchCriteria, (err, uids) => {
        if (err) {
          reject(err)
          return
        }

        if (uids.length === 0) {
          resolve([])
          return
        }

        const fetch = this.imap.fetch(uids, fetchOptions)
        let messagesRetrieved = 0
        const messages: Message[] = []

        function fetchOnMessage(message, seqNo: number) {
          getMessage(message).then(function (message) {
            message.seqNo = seqNo
            messages[seqNo] = message

            messagesRetrieved++
            if (messagesRetrieved === uids.length) {
              fetchCompleted()
            }
          })
        }

        function fetchCompleted() {
          // pare array down while keeping messages in order
          const pared = messages.filter((m) => !!m)
          resolve(pared)
        }

        function fetchOnError(err) {
          fetch.removeListener('message', fetchOnMessage)
          fetch.removeListener('end', fetchOnEnd)
          reject(err)
        }

        function fetchOnEnd() {
          fetch.removeListener('message', fetchOnMessage)
          fetch.removeListener('error', fetchOnError)
        }

        fetch.on('message', fetchOnMessage)
        fetch.once('error', fetchOnError)
        fetch.once('end', fetchOnEnd)
      })
    })
  }

  /**
   * Download a "part" (either a portion of the message body, or an attachment)
   *
   * @param {object} message The message returned from `search()`
   * @param {object} part The message part to be downloaded, from the `message.attributes.struct` Array
   * @param {function} [callback] Optional callback, receiving signature (err, data)
   * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving to `data`
   * @memberof ImapSimple
   */
  getPartData(message: Message, part, callback?: Function) {
    if (callback) {
      return nodeify(this.getPartData(message, part), callback)
    }

    return new Promise((resolve, reject) => {
      const fetch = this.imap.fetch(message.attributes.uid, {
        bodies: [part.partID],
        struct: true,
      })

      function fetchOnMessage(msg: ImapMessage) {
        getMessage(msg).then((result) => {
          if (result.parts.length !== 1) {
            reject(
              new Error('Got ' + result.parts.length + ' parts, should get 1'),
            )
            return
          }

          const data = result.parts[0].body

          const encoding = part.encoding.toUpperCase()

          if (encoding === 'BASE64') {
            resolve(new Buffer(data, 'base64'))
            return
          }

          if (encoding === 'QUOTED-PRINTABLE') {
            if (
              part.params?.charset &&
              part.params.charset.toUpperCase() === 'UTF-8'
            ) {
              resolve(new Buffer(utf8.decode(qp.decode(data))).toString())
            } else {
              resolve(new Buffer(qp.decode(data)).toString())
            }
            return
          }

          if (encoding === '7BIT') {
            resolve(new Buffer(data).toString('ascii'))
            return
          }

          if (encoding === '8BIT' || encoding === 'BINARY') {
            const charset = part.params?.charset || 'utf-8'
            resolve(iconvlite.decode(new Buffer(data), charset))
            return
          }

          if (encoding === 'UUENCODE') {
            const parts = data.toString().split('\n') // remove newline characters
            const merged = parts.splice(1, parts.length - 4).join('') // remove excess lines and join lines with empty string
            resolve(uuencode.decode(merged))
            return
          }

          // if it gets here, the encoding is not currently supported
          reject(new Error('Unknown encoding ' + part.encoding))
        })
      }

      function fetchOnError(err) {
        fetch.removeListener('message', fetchOnMessage)
        fetch.removeListener('end', fetchOnEnd)
        reject(err)
      }

      function fetchOnEnd() {
        fetch.removeListener('message', fetchOnMessage)
        fetch.removeListener('error', fetchOnError)
      }

      fetch.once('message', fetchOnMessage)
      fetch.once('error', fetchOnError)
      fetch.once('end', fetchOnEnd)
    })
  }

  /**
   * Moves the specified message(s) in the currently open mailbox to another mailbox.
   *
   * @param {string|Array} source The node-imap `MessageSource` indicating the message(s) from the current open mailbox
   *  to move.
   * @param {string} boxName The mailbox to move the message(s) to.
   * @param {function} [callback] Optional callback, receiving signature (err)
   * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving when the action succeeds.
   * @memberof ImapSimple
   */
  moveMessage(source: any, boxName: string, callback?: Function) {
    if (callback) {
      return nodeify(this.moveMessage(source, boxName), callback)
    }

    return new Promise<void>((resolve, reject) => {
      this.imap.move(source, boxName, (err) => {
        if (err) {
          reject(err)
          return
        }

        resolve()
      })
    })
  }

  /**
   * Adds the provided label(s) to the specified message(s).
   *
   * This is a Gmail extension method (X-GM-EXT-1)
   *
   * @param {string|Array} source The node-imap `MessageSource` indicating the message(s) to add the label(s) to.
   * @param {string|Array} labels Either a single string or an array of strings indicating the labels to add to the
   *  message(s).
   * @param {function} [callback] Optional callback, receiving signature (err)
   * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving when the action succeeds.
   * @memberof ImapSimple
   */
  addMessageLabel(source: any, labels, callback?: Function) {
    if (callback) {
      return nodeify(this.addMessageLabel(source, labels), callback)
    }

    return new Promise<void>((resolve, reject) => {
      // @ts-expect-error
      this.imap.addLabels(source, labels, (err) => {
        if (err) {
          reject(err)
          return
        }

        resolve()
      })
    })
  }

  /**
   * Remove the provided label(s) from the specified message(s).
   *
   * This is a Gmail extension method (X-GM-EXT-1)
   *
   * @param {string|Array} source The node-imap `MessageSource` indicating the message(s) to remove the label(s) from.
   * @param {string|Array} labels Either a single string or an array of strings indicating the labels to remove from the
   *  message(s).
   * @param {function} [callback] Optional callback, receiving signature (err)
   * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving when the action succeeds.
   * @memberof ImapSimple
   */
  removeMessageLabel(source: any, labels, callback?: Function) {
    if (callback) {
      return nodeify(this.removeMessageLabel(source, labels), callback)
    }

    return new Promise<void>((resolve, reject) => {
      // @ts-expect-error
      this.imap.delLabels(source, labels, (err) => {
        if (err) {
          reject(err)
          return
        }

        resolve()
      })
    })
  }

  /**
   * Adds the provided flag(s) to the specified message(s).
   *
   * @param {string|Array} uid The messages uid
   * @param {string|Array} flags Either a single string or an array of strings indicating the flags to add to the
   *  message(s).
   * @param {function} [callback] Optional callback, receiving signature (err)
   * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving when the action succeeds.
   * @memberof ImapSimple
   */
  addFlags(uid, flags, callback?: Function) {
    if (callback) {
      return nodeify(this.addFlags(uid, flags), callback)
    }

    return new Promise<void>((resolve, reject) => {
      this.imap.addFlags(uid, flags, (err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  /**
   * Removes the provided flag(s) to the specified message(s).
   *
   * @param {string|Array} uid The messages uid
   * @param {string|Array} flags Either a single string or an array of strings indicating the flags to remove from the
   *  message(s).
   * @param {function} [callback] Optional callback, receiving signature (err)
   * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving when the action succeeds.
   * @memberof ImapSimple
   */
  delFlags(uid, flags, callback?: Function) {
    if (callback) {
      return nodeify(this.delFlags(uid, flags), callback)
    }

    return new Promise<void>((resolve, reject) => {
      this.imap.delFlags(uid, flags, (err) => {
        if (err) {
          reject(err)
          return
        }

        resolve()
      })
    })
  }

  /**
   * Deletes the specified message(s).
   *
   * @param {string|Array} uid The uid or array of uids indicating the messages to be deleted
   * @param {function} [callback] Optional callback, receiving signature (err)
   * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving when the action succeeds.
   * @memberof ImapSimple
   */
  deleteMessage(uid, callback?: Function) {
    if (callback) {
      return nodeify(this.deleteMessage(uid), callback)
    }

    return new Promise<void>((resolve, reject) => {
      this.imap.addFlags(uid, '\\Deleted', (err) => {
        if (err) {
          reject(err)
          return
        }
        this.imap.expunge((err) => {
          if (err) {
            reject(err)
            return
          }
          resolve()
        })
      })
    })
  }

  /**
     * Appends a mime-encoded message to a mailbox
     *
     * @param {string|Buffer} message The messages to append to the mailbox
     * @param {object} [options]
     * @param {string} [options.mailbox] The mailbox to append the message to.
     Defaults to the currently open mailbox.
    * @param {string|Array<String>} [options.flag] A single flag (e.g. 'Seen') or an array
    of flags (e.g. ['Seen', 'Flagged']) to append to the message. Defaults to
    no flags.
    * @param {function} [callback] Optional callback, receiving signature (err)
    * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving when the action succeeds.
    * @memberof ImapSimple
    */
  append(message, options, callback?: Function) {
    if (callback) {
      return nodeify(this.append(message, options), callback)
    }

    return new Promise<void>((resolve, reject) => {
      this.imap.append(message, options, (err) => {
        if (err) {
          reject(err)
          return
        }

        resolve()
      })
    })
  }

  /**
   * Returns a list of mailboxes (folders).
   *
   * @param {function} [callback] Optional callback containing 'boxes' object.
   * @returns {undefined|Promise} Returns a promise when no callback is specified,
   *  resolving when the action succeeds.
   */

  getBoxes(callback?: Function) {
    if (callback) {
      return nodeify(this.getBoxes(), callback)
    }

    return new Promise((resolve, reject) => {
      this.imap.getBoxes(function (err, boxes) {
        if (err) {
          reject(err)
          return
        }

        resolve(boxes)
      })
    })
  }

  /**
   * Add new mailbox (folder)
   *
   * @param {string} boxName The name of the box to added
   * @param {function} [callback] Optional callback, receiving signature (err, boxName)
   * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving to `boxName`
   * @memberof ImapSimple
   */
  addBox(boxName, callback?: Function) {
    if (callback) {
      return nodeify(this.addBox(boxName), callback)
    }

    return new Promise((resolve, reject) => {
      this.imap.addBox(boxName, (err) => {
        if (err) {
          reject(err)
          return
        }

        resolve(boxName)
      })
    })
  }

  /**
   * Delete mailbox (folder)
   *
   * @param {string} boxName The name of the box to deleted
   * @param {function} [callback] Optional callback, receiving signature (err, boxName)
   * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving to `boxName`
   * @memberof ImapSimple
   */
  delBox(boxName, callback?: Function) {
    if (callback) {
      return nodeify(this.delBox(boxName), callback)
    }

    return new Promise((resolve, reject) => {
      this.imap.delBox(boxName, (err) => {
        if (err) {
          reject(err)
          return
        }

        resolve(boxName)
      })
    })
  }
}

/**
 * Connect to an Imap server, returning an ImapSimple instance, which is a wrapper over node-imap to
 * simplify it's api for common use cases.
 *
 * @param {object} options
 * @param {object} options.imap Options to pass to node-imap constructor 1:1
 * @param {function} [callback] Optional callback, receiving signature (err, connection)
 * @returns {undefined|Promise} Returns a promise when no callback is specified, resolving to `connection`
 */
export function connect(options, callback?: Function) {
  options = options || {}
  options.imap = options.imap || {}

  // support old connectTimeout config option. Remove in v2.0.0
  if (options.hasOwnProperty('connectTimeout')) {
    console.warn(
      '[imap-simple] connect: options.connectTimeout is deprecated. ' +
        'Please use options.imap.authTimeout instead.',
    )
    options.imap.authTimeout = options.connectTimeout
  }

  // set default authTimeout
  options.imap.authTimeout = options.imap.hasOwnProperty('authTimeout')
    ? options.imap.authTimeout
    : 2000

  if (callback) {
    return nodeify(connect(options), callback)
  }

  return new Promise((resolve, reject) => {
    const imap = new Imap(options.imap)

    function imapOnReady() {
      imap.removeListener('error', imapOnError)
      imap.removeListener('close', imapOnClose)
      imap.removeListener('end', imapOnEnd)
      resolve(new ImapSimple(imap))
    }

    function imapOnError(err) {
      if (err.source === 'timeout-auth') {
        err = new ConnectionTimeoutError(options.imap.authTimeout)
      }

      imap.removeListener('ready', imapOnReady)
      imap.removeListener('close', imapOnClose)
      imap.removeListener('end', imapOnEnd)
      reject(err)
    }

    function imapOnEnd() {
      imap.removeListener('ready', imapOnReady)
      imap.removeListener('error', imapOnError)
      imap.removeListener('close', imapOnClose)
      reject(new Error('Connection ended unexpectedly'))
    }

    function imapOnClose() {
      imap.removeListener('ready', imapOnReady)
      imap.removeListener('error', imapOnError)
      imap.removeListener('end', imapOnEnd)
      reject(new Error('Connection closed unexpectedly'))
    }

    imap.once('ready', imapOnReady)
    imap.once('error', imapOnError)
    imap.once('close', imapOnClose)
    imap.once('end', imapOnEnd)

    if (options.hasOwnProperty('onmail')) {
      imap.on('mail', options.onmail)
    }

    if (options.hasOwnProperty('onexpunge')) {
      imap.on('expunge', options.onexpunge)
    }

    if (options.hasOwnProperty('onupdate')) {
      imap.on('update', options.onupdate)
    }

    imap.connect()
  })
}

/**
 * Given the `message.attributes.struct`, retrieve a flattened array of `parts` objects that describe the structure of
 * the different parts of the message's body. Useful for getting a simple list to iterate for the purposes of,
 * for example, finding all attachments.
 *
 * Code taken from http://stackoverflow.com/questions/25247207/how-to-read-and-save-attachments-using-node-imap
 *
 * @param {Array} struct The `message.attributes.struct` value from the message you wish to retrieve parts for.
 * @param {Array} [parts] The list of parts to push to.
 * @returns {Array} a flattened array of `parts` objects that describe the structure of the different parts of the
 *  message's body
 */
export function getParts(struct, parts) {
  parts = parts || []
  for (let i = 0; i < struct.length; i++) {
    if (Array.isArray(struct[i])) {
      getParts(struct[i], parts)
    } else if (struct[i].partID) {
      parts.push(struct[i])
    }
  }
  return parts
}

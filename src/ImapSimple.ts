import Imap, { type ImapMessage } from 'imap'
import { EventEmitter } from 'events'
import * as qp from 'quoted-printable'
import * as iconvlite from 'iconv-lite'
import * as utf8 from 'utf8'
import * as uuencode from 'uuencode'

import { getMessage, type Message } from './helpers/getMessage'

const IMAP_EVENTS = [
  'alert',
  'mail',
  'expunge',
  'uidvalidity',
  'update',
  'close',
  'end',
] as const

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
   * @returns {undefined|Promise} Returns a promise, resolving to `boxName`
   */
  openBox(boxName: string) {
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
   * @returns {undefined|Promise} Returns a promise, resolving to `boxName`
   */
  closeBox(autoExpunge = true) {
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
   * @returns {undefined|Promise} Returns a promise, resolving to `results`
   */
  search(searchCriteria: any, fetchOptions: any = null): Promise<Message[]> {
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
          getMessage(message).then((message) => {
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
   * @returns {undefined|Promise} Returns a promise, resolving to `data`
   */
  getPartData(message: Message, part) {
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
            resolve(Buffer.from(data, 'base64'))
            return
          }

          if (encoding === 'QUOTED-PRINTABLE') {
            if (
              part.params?.charset &&
              part.params.charset.toUpperCase() === 'UTF-8'
            ) {
              resolve(Buffer.from(utf8.decode(qp.decode(data))).toString())
            } else {
              resolve(Buffer.from(qp.decode(data)).toString())
            }
            return
          }

          if (encoding === '7BIT') {
            resolve(Buffer.from(data).toString('ascii'))
            return
          }

          if (encoding === '8BIT' || encoding === 'BINARY') {
            const charset = part.params?.charset || 'utf-8'
            resolve(iconvlite.decode(Buffer.from(data), charset))
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
   * @returns {undefined|Promise} Returns a promise, resolving when the action succeeds.
   */
  moveMessage(source: any, boxName: string) {
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
   * @returns {undefined|Promise} Returns a promise, resolving when the action succeeds.
   */
  addMessageLabel(source: any, labels) {
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
   * @returns {undefined|Promise} Returns a promise, resolving when the action succeeds.
   */
  removeMessageLabel(source: any, labels) {
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
   * @returns {undefined|Promise} Returns a promise, resolving when the action succeeds.
   */
  addFlags(uid, flags) {
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
   * @returns {undefined|Promise} Returns a promise, resolving when the action succeeds.
   */
  delFlags(uid, flags) {
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
   * @returns {undefined|Promise} Returns a promise, resolving when the action succeeds.
   */
  deleteMessage(uid) {
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
    * @returns {undefined|Promise} Returns a promise, resolving when the action succeeds.
     */
  append(message, options) {
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
   * @returns {undefined|Promise} Returns a promise,
   *  resolving when the action succeeds.
   */

  getBoxes() {
    return new Promise((resolve, reject) => {
      this.imap.getBoxes((err, boxes) => {
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
   * @returns {undefined|Promise} Returns a promise, resolving to `boxName`
   */
  addBox(boxName: string) {
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
   * @returns {undefined|Promise} Returns a promise, resolving to `boxName`
   */
  delBox(boxName: string) {
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

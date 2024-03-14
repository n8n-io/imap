import Imap, { type Config as ImapConfig } from 'imap'
import { ImapSimple } from './ImapSimple';
import { ConnectionClosedError, ConnectionEndedError, ConnectionTimeoutError } from './errors'

export interface ImapSimpleConnectOptions {
  /** Options to pass to node-imap constructor. */
  imap: ImapConfig;

  /** Server event emitted when new mail arrives in the currently open mailbox. */
  onMail?: ((numNewMail: number) => void) | undefined;

  /** Server event emitted when a message was expunged externally. seqNo is the sequence number (instead of the unique UID) of the message that was expunged. If you are caching sequence numbers, all sequence numbers higher than this value MUST be decremented by 1 in order to stay synchronized with the server and to keep correct continuity. */
  onExpunge?: ((seqNo: number) => void) | undefined;

  /** Server event emitted when message metadata (e.g. flags) changes externally. */
  onUpdate?: ((seqNo: number, info: any) => void) | undefined;
}

/**
* Connect to an Imap server, returning an ImapSimple instance, which is a wrapper over node-imap to simplify it's api for common use cases.
*/
export function connect(options: ImapSimpleConnectOptions): Promise<ImapSimple> {
  const authTimeout = options.imap.authTimeout ?? 2000;
  options.imap.authTimeout = authTimeout

  const imap = new Imap(options.imap)

  return new Promise<ImapSimple>((resolve, reject) => {
    const cleanUp = () => {
      imap.removeListener('ready', imapOnReady)
      imap.removeListener('error', imapOnError)
      imap.removeListener('close', imapOnClose)
      imap.removeListener('end', imapOnEnd)
    };

    const imapOnReady = () => {
      cleanUp()
      resolve(new ImapSimple(imap))
    }

    const imapOnError = (err: Error & { source?: string }) => {
      if (err.source === 'timeout-auth') {
        err = new ConnectionTimeoutError(authTimeout)
      }

      cleanUp()
      reject(err)
    }

    const imapOnEnd = () => {
      cleanUp()
      reject(new ConnectionEndedError())
    }

    const imapOnClose = () => {
      cleanUp()
      reject(new ConnectionClosedError())
    }

    imap.once('ready', imapOnReady)
    imap.once('error', imapOnError)
    imap.once('close', imapOnClose)
    imap.once('end', imapOnEnd)

    if (options.hasOwnProperty('onMail')) {
      imap.on('mail', options.onMail)
    }

    if (options.hasOwnProperty('onExpunge')) {
      imap.on('expunge', options.onExpunge)
    }

    if (options.hasOwnProperty('onEUpdate')) {
      imap.on('update', options.onUpdate)
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
 * @returns {Array} a flattened array of `parts` objects that describe the structure of the different parts of the
 *  message's body
 */
export function getParts(
  /** The `message.attributes.struct` value from the message you wish to retrieve parts for. */
  struct: any[],
  /** The list of parts to push to. */
  parts: any[] = [],
) {
  for (let i = 0; i < struct.length; i++) {
    if (Array.isArray(struct[i])) {
      getParts(struct[i], parts)
    } else if (struct[i].partID) {
      parts.push(struct[i])
    }
  }
  return parts
}

export { ImapSimple } from './ImapSimple';

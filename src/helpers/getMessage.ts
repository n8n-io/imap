import { parseHeader, type ImapMessage, type ImapMessageBodyInfo } from 'imap'

export interface Part {
  which: string
  size: number
  body: string
}
export interface Message {
  attributes: any
  parts: Array<Part>
  seqNo?: number
}

/**
 * Given an 'ImapMessage' from the node-imap library, retrieves the `Message`
 *
 * @returns {Promise} a promise resolving to `message` with schema as described above
 */
export function getMessage(
  /** an ImapMessage from the node-imap library */
  message: ImapMessage,
): Promise<Message> {
  return new Promise(function (resolve) {
    let attributes: any
    const messageParts = []
    const isHeader = /^HEADER/g

    function messageOnBody(
      stream: NodeJS.ReadableStream,
      info: ImapMessageBodyInfo,
    ) {
      let body: string = ''

      function streamOnData(chunk: Buffer) {
        body += chunk.toString('utf8')
      }

      stream.on('data', streamOnData)

      stream.once('end', function streamOnEnd() {
        stream.removeListener('data', streamOnData)

        const part: Part = {
          which: info.which,
          size: info.size,
          body,
        }

        if (isHeader.test(part.which)) {
          // TODO: fix this
          // @ts-expect-error
          part.body = parseHeader(part.body)
        }

        messageParts.push(part)
      })
    }

    function messageOnAttributes(attrs) {
      attributes = attrs
    }

    function messageOnEnd() {
      message.removeListener('body', messageOnBody)
      message.removeListener('attributes', messageOnAttributes)
      resolve({
        attributes,
        parts: messageParts,
      })
    }

    message.on('body', messageOnBody)
    message.once('attributes', messageOnAttributes)
    message.once('end', messageOnEnd)
  })
}

import { parseHeader, type ImapMessage, type ImapMessageBodyInfo, type ImapMessageAttributes } from 'imap'

export interface MessageBodyPart extends ImapMessageBodyInfo {
  /** string type where which=='TEXT', complex Object where which=='HEADER' */
  body: string | object
}

export interface Message {
  attributes: ImapMessageAttributes
  parts: Array<MessageBodyPart>
  seqNo?: number
}

/**
 * Given an 'ImapMessage' from the node-imap library, retrieves the `Message`
 */
export function getMessage(
  /** an ImapMessage from the node-imap library */
  message: ImapMessage,
): Promise<Message> {
  return new Promise((resolve) => {
    let attributes: ImapMessageAttributes
    const parts: Array<MessageBodyPart> = []

    const messageOnBody = (
      stream: NodeJS.ReadableStream,
      info: ImapMessageBodyInfo,
    ) => {
      let body: string = ''

      const streamOnData = (chunk: Buffer) => {
        body += chunk.toString('utf8')
      }

      stream.on('data', streamOnData)
      stream.once('end', () => {
        stream.removeListener('data', streamOnData)

        parts.push({
          which: info.which,
          size: info.size,
          body: /^HEADER/g.test(info.which) ? parseHeader(body as string) : body,
        })
      })
    }

    const messageOnAttributes = (attrs: ImapMessageAttributes) => {
      attributes = attrs
    }

    const messageOnEnd = () => {
      message.removeListener('body', messageOnBody)
      message.removeListener('attributes', messageOnAttributes)
      resolve({ attributes, parts })
    }

    message.on('body', messageOnBody)
    message.once('attributes', messageOnAttributes)
    message.once('end', messageOnEnd)
  })
}

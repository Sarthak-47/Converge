import { createDecipheriv } from 'node:crypto'

/**
 * Opens a value the API sealed with its SecretBox (AES-256-GCM: a 12-byte nonce, then the ciphertext and the
 * 16-byte tag, with the row's context as associated data). The worker needs this for one thing only: the Git
 * credential of the repository it is pushing to.
 */
export function openSealed(box: Buffer, context: string, base64Key: string): string {
  const key = Buffer.from(base64Key, 'base64')
  if (key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64-encoded')
  const nonce = box.subarray(0, 12)
  const tag = box.subarray(box.length - 16)
  const ciphertext = box.subarray(12, box.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(context, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

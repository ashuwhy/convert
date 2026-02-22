/**
 * Encryption/decryption using Web Crypto API.
 * Uses PBKDF2 for key derivation and AES-256-GCM for authenticated encryption.
 *
 * Ciphertext layout: [16-byte salt] [12-byte IV] [ciphertext + 16-byte GCM tag]
 */

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 100_000;

/**
 * Derive an AES-256-GCM key from a password and salt.
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        encoder.encode(password),
        "PBKDF2",
        false,
        ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: new Uint8Array(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

/**
 * Encrypt data with a password using AES-256-GCM.
 * Returns: salt (16) + iv (12) + ciphertext
 */
export async function encrypt(data: Uint8Array, password: string): Promise<Uint8Array> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const key = await deriveKey(password, salt);

    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        key,
        new Uint8Array(data)
    );

    const result = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertext.byteLength);
    result.set(salt, 0);
    result.set(iv, SALT_LENGTH);
    result.set(new Uint8Array(ciphertext), SALT_LENGTH + IV_LENGTH);
    return result;
}

/**
 * Decrypt data that was encrypted with `encrypt()`.
 * Expects: salt (16) + iv (12) + ciphertext
 */
export async function decrypt(data: Uint8Array, password: string): Promise<Uint8Array> {
    const salt = new Uint8Array(data.slice(0, SALT_LENGTH));
    const iv = new Uint8Array(data.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH));
    const ciphertext = new Uint8Array(data.slice(SALT_LENGTH + IV_LENGTH));
    const key = await deriveKey(password, salt);

    const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        key,
        ciphertext as BufferSource
    );

    return new Uint8Array(plaintext);
}

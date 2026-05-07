import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { RescueCipher, x25519, getMXEPublicKey, getArciumProgram } from "@arcium-hq/client";
import { PROGRAM_ID } from "./program";

export { RescueCipher, x25519 };

export async function getMXEPublicKeyWithRetry(
  provider: AnchorProvider,
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const key = await getMXEPublicKey(provider, PROGRAM_ID);
      if (key) return key;
    } catch (_) {}
    if (attempt < maxRetries)
      await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

export async function setupCipher(provider: AnchorProvider) {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const mxePublicKey = await getMXEPublicKeyWithRetry(provider);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  return { privateKey, publicKey, cipher };
}

export function encryptBid(
  cipher: RescueCipher,
  amount: bigint,
  bidderLo: bigint,
  bidderHi: bigint
): { nonce: Uint8Array; ciphertexts: number[][] } {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const ciphertexts = cipher.encrypt([amount, bidderLo, bidderHi], nonce);
  return { nonce, ciphertexts };
}

// Split a 32-byte pubkey into lo/hi u128 (little-endian, matching the Rust struct)
export function pubkeyToLoHi(pubkey: PublicKey): { lo: bigint; hi: bigint } {
  const bytes = pubkey.toBytes();
  let lo = 0n;
  let hi = 0n;
  for (let i = 0; i < 16; i++) lo |= BigInt(bytes[i]) << BigInt(8 * i);
  for (let i = 0; i < 16; i++) hi |= BigInt(bytes[16 + i]) << BigInt(8 * i);
  return { lo, hi };
}

// Deserialize a little-endian Uint8Array to BigInt
export function deserializeLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result |= BigInt(bytes[i]) << BigInt(8 * i);
  }
  return result;
}

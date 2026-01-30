import { NextRequest, NextResponse } from 'next/server';
import { getRequestContext } from '@cloudflare/next-on-pages';
import type { Env, Member, MemberPair } from '@/lib/types';

export const runtime = 'edge';

// Inline push test to capture full details
export async function GET(request: NextRequest) {
  const deviceId = request.cookies.get('deviceId')?.value;
  if (!deviceId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const slotParam = request.nextUrl.searchParams.get('slot');
    const slot: 1 | 2 = slotParam === '2' ? 2 : 1;
    const { env } = getRequestContext() as unknown as { env: Env };
    const db = env.DB;

    if (!db) {
      return NextResponse.json({ error: 'No database' });
    }

    // Get sender
    const sender = await db
      .prepare('SELECT * FROM members WHERE device_id = ?')
      .bind(deviceId)
      .first<Member>();

    if (!sender) {
      return NextResponse.json({ error: 'Not paired' });
    }

    let useLegacySchema = false;
    let senderPair: MemberPair | null = null;

    try {
      senderPair = await db
        .prepare('SELECT * FROM member_pairs WHERE member_id = ? AND slot = ?')
        .bind(sender.id, slot)
        .first<MemberPair>();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('no such table: member_pairs')) {
        useLegacySchema = true;
      } else {
        throw error;
      }
    }

    if (!useLegacySchema && !senderPair) {
      return NextResponse.json({ error: `No pairing in slot ${slot}`, slot });
    }

    let partner: Member | null = null;
    if (useLegacySchema) {
      partner = await db
        .prepare('SELECT * FROM members WHERE pair_id = ? AND device_id != ?')
        .bind(sender.pair_id, deviceId)
        .first<Member>();
    } else if (senderPair) {
      const partnerPair = await db
        .prepare('SELECT * FROM member_pairs WHERE pair_id = ? AND member_id != ?')
        .bind(senderPair.pair_id, sender.id)
        .first<MemberPair>();

      if (partnerPair) {
        partner = await db
          .prepare('SELECT * FROM members WHERE id = ?')
          .bind(partnerPair.member_id)
          .first<Member>();
      }
    }

    if (!partner) {
      return NextResponse.json({ error: 'No partner', slot });
    }

    if (!partner.push_endpoint || !partner.push_p256dh || !partner.push_auth) {
      return NextResponse.json({
        error: 'Partner has no push subscription',
        hasPushEndpoint: !!partner.push_endpoint,
        hasPushP256dh: !!partner.push_p256dh,
        hasPushAuth: !!partner.push_auth,
      });
    }

    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
      return NextResponse.json({ error: 'VAPID keys not configured' });
    }

    // Try to send push and capture full details
    const result = await testPush(
      partner,
      { title: 'Test', body: 'Debug push test' },
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY,
      env.VAPID_SUBJECT || 'mailto:hello@cooling.app'
    );

    return NextResponse.json({ slot, ...result });
  } catch (error) {
    return NextResponse.json({
      error: 'Exception',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

interface PushPayload {
  title: string;
  body: string;
}

async function testPush(
  member: Member,
  payload: PushPayload,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<object> {
  const steps: string[] = [];

  try {
    steps.push('Decoding VAPID keys');
    const privateKeyBytes = new Uint8Array(base64UrlDecode(vapidPrivateKey));
    const publicKeyBytes = new Uint8Array(base64UrlDecode(vapidPublicKey));

    steps.push(`Private key: ${privateKeyBytes.length} bytes, Public key: ${publicKeyBytes.length} bytes`);

    if (publicKeyBytes.length !== 65) {
      return { error: 'Invalid public key length', expected: 65, got: publicKeyBytes.length, steps };
    }
    if (privateKeyBytes.length !== 32) {
      return { error: 'Invalid private key length', expected: 32, got: privateKeyBytes.length, steps };
    }

    steps.push('Importing VAPID private key as JWK');
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: base64UrlEncode(publicKeyBytes.slice(1, 33)),
        y: base64UrlEncode(publicKeyBytes.slice(33, 65)),
        d: base64UrlEncode(privateKeyBytes),
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    steps.push('VAPID key imported successfully');

    steps.push('Creating VAPID JWT');
    const jwt = await createVapidJwt(member.push_endpoint!, vapidSubject, privateKey);
    steps.push(`JWT created: ${jwt.substring(0, 50)}...`);

    steps.push('Sending push ping (no payload)');
    const response = await fetch(member.push_endpoint!, {
      method: 'POST',
      headers: {
        'Content-Length': '0',
        'TTL': '86400',
        'Authorization': `vapid t=${jwt}, k=${vapidPublicKey}`,
      },
    });

    const responseText = await response.text().catch(() => '');
    steps.push(`Response: ${response.status} ${response.statusText}`);

    return {
      success: response.ok || response.status === 201,
      status: response.status,
      statusText: response.statusText,
      responseBody: responseText,
      steps,
      endpoint: member.push_endpoint!.substring(0, 60) + '...',
    };
  } catch (error) {
    return {
      error: 'Exception during push',
      message: error instanceof Error ? error.message : String(error),
      steps,
    };
  }
}

function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

async function createVapidJwt(
  endpoint: string,
  subject: string,
  privateKey: CryptoKey
): Promise<string> {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const expiration = Math.floor(Date.now() / 1000) + 12 * 60 * 60;

  const header = { alg: 'ES256', typ: 'JWT' };
  const payload = { aud: audience, exp: expiration, sub: subject };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );

  const rawSignature = derToRaw(new Uint8Array(signature));
  const signatureB64 = base64UrlEncode(rawSignature);

  return `${unsignedToken}.${signatureB64}`;
}

function derToRaw(sig: Uint8Array): Uint8Array {
  // Already raw format (r || s, 64 bytes)
  if (sig.length === 64) {
    return sig;
  }

  // DER format: 0x30 [len] 0x02 [r-len] [r] 0x02 [s-len] [s]
  if (sig[0] !== 0x30) {
    throw new Error(`Unknown signature format: length=${sig.length}, first byte=0x${sig[0].toString(16)}`);
  }

  const raw = new Uint8Array(64);
  let offset = 2;

  if (sig[offset] !== 0x02) throw new Error('Invalid DER: expected 0x02 for r');
  offset++;
  const rLen = sig[offset];
  offset++;
  const rStart = rLen === 33 && sig[offset] === 0 ? offset + 1 : offset;
  const rBytes = sig.slice(rStart, offset + rLen);
  raw.set(rBytes, 32 - rBytes.length);
  offset += rLen;

  if (sig[offset] !== 0x02) throw new Error('Invalid DER: expected 0x02 for s');
  offset++;
  const sLen = sig[offset];
  offset++;
  const sStart = sLen === 33 && sig[offset] === 0 ? offset + 1 : offset;
  const sBytes = sig.slice(sStart, offset + sLen);
  raw.set(sBytes, 64 - sBytes.length);

  return raw;
}

async function encryptPayload(
  payload: string,
  p256dh: string,
  auth: string
): Promise<Uint8Array> {
  const subscriberPublicKey = base64UrlDecode(p256dh);
  const authSecret = base64UrlDecode(auth);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const subscriberKey = await crypto.subtle.importKey(
    'raw',
    subscriberPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: subscriberKey },
    ephemeralKeyPair.privateKey,
    256
  );

  const ephemeralPublicKey = await crypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey);

  const { key, nonce } = await deriveKeyAndNonce(
    sharedSecret,
    authSecret,
    ephemeralPublicKey,
    subscriberPublicKey,
    salt
  );

  const paddedPayload = addPadding(new TextEncoder().encode(payload));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce), tagLength: 128 },
    key,
    toArrayBuffer(paddedPayload)
  );

  const recordSize = new Uint8Array(4);
  new DataView(toArrayBuffer(recordSize)).setUint32(0, 4096, false);

  const ephemeralPubKeyBytes = new Uint8Array(ephemeralPublicKey);
  const header = new Uint8Array(86);
  header.set(salt, 0);
  header.set(recordSize, 16);
  header[20] = 65;
  header.set(ephemeralPubKeyBytes, 21);

  const result = new Uint8Array(header.length + encrypted.byteLength);
  result.set(header);
  result.set(new Uint8Array(encrypted), header.length);

  return result;
}

async function deriveKeyAndNonce(
  sharedSecret: ArrayBuffer,
  authSecret: ArrayBuffer,
  ephemeralPublicKey: ArrayBuffer,
  subscriberPublicKey: ArrayBuffer,
  salt: Uint8Array
): Promise<{ key: CryptoKey; nonce: Uint8Array }> {
  const sharedKey = await crypto.subtle.importKey('raw', sharedSecret, { name: 'HKDF' }, false, ['deriveBits']);

  const info = createInfo('WebPush: info\0', new Uint8Array(subscriberPublicKey), new Uint8Array(ephemeralPublicKey));
  const prkBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', salt: authSecret, info: toArrayBuffer(info), hash: 'SHA-256' },
    sharedKey,
    256
  );

  const prkKey = await crypto.subtle.importKey('raw', prkBits, { name: 'HKDF' }, false, ['deriveBits', 'deriveKey']);

  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', salt: toArrayBuffer(salt), info: toArrayBuffer(cekInfo), hash: 'SHA-256' },
    prkKey,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt']
  );

  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
  const nonceBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', salt: toArrayBuffer(salt), info: toArrayBuffer(nonceInfo), hash: 'SHA-256' },
    prkKey,
    96
  );

  return { key, nonce: new Uint8Array(nonceBits) };
}

function createInfo(prefix: string, subscriberPublicKey: Uint8Array, ephemeralPublicKey: Uint8Array): Uint8Array {
  const prefixBytes = new TextEncoder().encode(prefix);
  const info = new Uint8Array(prefixBytes.length + 2 + subscriberPublicKey.length + 2 + ephemeralPublicKey.length);
  let offset = 0;

  info.set(prefixBytes, offset);
  offset += prefixBytes.length;
  info[offset++] = 0;
  info[offset++] = subscriberPublicKey.length;
  info.set(subscriberPublicKey, offset);
  offset += subscriberPublicKey.length;
  info[offset++] = 0;
  info[offset++] = ephemeralPublicKey.length;
  info.set(ephemeralPublicKey, offset);

  return info;
}

function addPadding(payload: Uint8Array): Uint8Array {
  const padded = new Uint8Array(payload.length + 1);
  padded.set(payload);
  padded[payload.length] = 2;
  return padded;
}

function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): ArrayBuffer {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer.slice(0, bytes.length) as ArrayBuffer;
}

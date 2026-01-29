import { NextRequest, NextResponse } from 'next/server';
import { getRequestContext } from '@cloudflare/next-on-pages';
import type { Env, Member, MemberPair, ChompResponse } from '@/lib/types';
import { sendPushNotification } from '@/lib/push';

// Oven duration in seconds
const OVEN_SECONDS = 108;

export const runtime = 'edge';

function isDebugRequest(request: NextRequest): boolean {
  const header = request.headers.get('x-debug');
  if (header === '1' || header === 'true') {
    return true;
  }
  const devParam = request.nextUrl.searchParams.get('dev');
  return devParam === '1';
}

export async function POST(request: NextRequest) {
  const debug = isDebugRequest(request);

  try {
    // Get device ID from cookie
    const deviceId = request.cookies.get('deviceId')?.value;
    if (!deviceId) {
      return NextResponse.json<ChompResponse>(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      );
    }

    // Get slot from query params (default to 1)
    const slotParam = request.nextUrl.searchParams.get('slot');
    const slot: 1 | 2 = slotParam === '2' ? 2 : 1;

    // Get Cloudflare bindings
    const { env } = getRequestContext() as unknown as { env: Env };
    const db = env.DB;

    if (!db) {
      // Development mode - return mock response
      return NextResponse.json<ChompResponse>({
        success: true,
        ovenSeconds: OVEN_SECONDS,
        slot,
      });
    }

    // Get the sender member
    const sender = await db
      .prepare('SELECT * FROM members WHERE device_id = ?')
      .bind(deviceId)
      .first<Member>();

    if (!sender) {
      return NextResponse.json<ChompResponse>(
        { success: false, error: 'Not paired' },
        { status: 403 }
      );
    }

    const now = Math.floor(Date.now() / 1000);

    // Try to use new schema (member_pairs)
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

    // Handle legacy schema
    if (useLegacySchema) {
      return handleLegacyBuzz(sender, db, env, now, debug);
    }

    if (!senderPair) {
      return NextResponse.json<ChompResponse>(
        { success: false, error: `No pairing in slot ${slot}` },
        { status: 403 }
      );
    }

    // Check if sender is still in oven (per-slot cooldown)
    if (senderPair.last_sent_at) {
      const elapsed = now - senderPair.last_sent_at;
      if (elapsed < OVEN_SECONDS) {
        const remaining = OVEN_SECONDS - elapsed;
        return NextResponse.json<ChompResponse>(
          { success: false, remainingSeconds: remaining, slot },
          { status: 429 }
        );
      }
    }

    // Get the partner in this slot's pair
    const partnerPair = await db
      .prepare('SELECT * FROM member_pairs WHERE pair_id = ? AND member_id != ?')
      .bind(senderPair.pair_id, sender.id)
      .first<MemberPair>();

    if (!partnerPair) {
      return NextResponse.json<ChompResponse>(
        { success: false, error: 'Partner not found' },
        { status: 404 }
      );
    }

    // Get partner member for push notification
    const partner = await db
      .prepare('SELECT * FROM members WHERE id = ?')
      .bind(partnerPair.member_id)
      .first<Member>();

    if (!partner) {
      return NextResponse.json<ChompResponse>(
        { success: false, error: 'Partner member not found' },
        { status: 404 }
      );
    }

    // Update timestamps in member_pairs
    try {
      await db.batch([
        // Update sender's last_sent_at
        db
          .prepare('UPDATE member_pairs SET last_sent_at = ? WHERE member_id = ? AND slot = ?')
          .bind(now, sender.id, slot),
        // Update partner's last_received_at
        db
          .prepare('UPDATE member_pairs SET last_received_at = ? WHERE member_id = ? AND pair_id = ?')
          .bind(now, partnerPair.member_id, senderPair.pair_id),
        // Update pair's last_chomp_at for display purposes
        db
          .prepare('UPDATE pairs SET last_chomp_at = ? WHERE id = ?')
          .bind(now, senderPair.pair_id),
      ]);
    } catch (error) {
      console.error('Failed to update timestamps:', error);
      throw error;
    }

    // Send push notification to partner (title: "Chomp", empty body)
    if (partner.push_endpoint && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      try {
        await sendPushNotification(
          partner,
          { title: 'Chomp', body: '' },
          env.VAPID_PUBLIC_KEY,
          env.VAPID_PRIVATE_KEY,
          env.VAPID_SUBJECT || 'mailto:hello@cooling.app'
        );
      } catch (error) {
        console.error('Push send error:', error);
      }
    }

    return NextResponse.json<ChompResponse>({
      success: true,
      ovenSeconds: OVEN_SECONDS,
      slot,
    });
  } catch (error) {
    console.error('Chomp error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json<ChompResponse>(
      { success: false, error: debug ? `Internal error: ${message}` : 'Internal error' },
      { status: 500 }
    );
  }
}

// Legacy schema handling (before member_pairs migration)
async function handleLegacyBuzz(
  sender: Member,
  db: Env['DB'],
  env: Env,
  now: number,
  debug: boolean
): Promise<NextResponse<ChompResponse>> {
  // Check if sender is still in oven (legacy)
  if (sender.last_chomp_at) {
    const elapsed = now - sender.last_chomp_at;
    if (elapsed < OVEN_SECONDS) {
      const remaining = OVEN_SECONDS - elapsed;
      return NextResponse.json<ChompResponse>(
        { success: false, remainingSeconds: remaining, slot: 1 },
        { status: 429 }
      );
    }
  }

  // Get the partner member (legacy)
  const partner = await db
    .prepare('SELECT * FROM members WHERE pair_id = ? AND device_id != ?')
    .bind(sender.pair_id, sender.device_id)
    .first<Member>();

  if (!partner) {
    return NextResponse.json<ChompResponse>(
      { success: false, error: 'Partner not found' },
      { status: 404 }
    );
  }

  // Update timestamps (legacy)
  try {
    await db.batch([
      db.prepare('UPDATE members SET last_chomp_at = ? WHERE id = ?').bind(now, sender.id),
      db
        .prepare('UPDATE members SET last_received_at = ? WHERE id = ?')
        .bind(now, partner.id),
      db.prepare('UPDATE pairs SET last_chomp_at = ? WHERE id = ?').bind(now, sender.pair_id),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('no such column: last_chomp_at') || message.includes('no such column: last_received_at')) {
      console.warn('last_chomp_at missing; retrying updates where possible.');
      await Promise.all([
        db
          .prepare('UPDATE members SET last_chomp_at = ? WHERE id = ?')
          .bind(now, sender.id)
          .run()
          .catch((memberError) => {
            const memberMessage =
              memberError instanceof Error ? memberError.message : String(memberError);
            if (memberMessage.includes('no such column: last_chomp_at')) {
              console.warn('Members.last_chomp_at missing; update skipped until migration runs.');
              return;
            }
            throw memberError;
          }),
        db
          .prepare('UPDATE members SET last_received_at = ? WHERE id = ?')
          .bind(now, partner.id)
          .run()
          .catch((receivedError) => {
            const receivedMessage =
              receivedError instanceof Error ? receivedError.message : String(receivedError);
            if (receivedMessage.includes('no such column: last_received_at')) {
              console.warn('Members.last_received_at missing; update skipped until migration runs.');
              return;
            }
            throw receivedError;
          }),
        db
          .prepare('UPDATE pairs SET last_chomp_at = ? WHERE id = ?')
          .bind(now, sender.pair_id)
          .run()
          .catch((pairError) => {
            const pairMessage =
              pairError instanceof Error ? pairError.message : String(pairError);
            if (pairMessage.includes('no such column: last_chomp_at')) {
              console.warn('Pairs.last_chomp_at missing; update skipped until migration runs.');
              return;
            }
            throw pairError;
          }),
      ]);
    } else {
      throw error;
    }
  }

  // Send push notification to partner
  if (partner.push_endpoint && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    try {
      await sendPushNotification(
        partner,
        { title: 'Chomp', body: '' },
        env.VAPID_PUBLIC_KEY,
        env.VAPID_PRIVATE_KEY,
        env.VAPID_SUBJECT || 'mailto:hello@cooling.app'
      );
    } catch (error) {
      console.error('Push send error:', error);
    }
  }

  return NextResponse.json<ChompResponse>({
    success: true,
    ovenSeconds: OVEN_SECONDS,
    slot: 1,
  });
}

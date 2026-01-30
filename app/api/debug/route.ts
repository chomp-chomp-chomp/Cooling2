import { NextRequest, NextResponse } from 'next/server';
import { getRequestContext } from '@cloudflare/next-on-pages';
import type { Env, Member, MemberPair } from '@/lib/types';

export const runtime = 'edge';

// Debug endpoint to check push subscription status
// Access: /api/debug
export async function GET(request: NextRequest) {
  try {
    const deviceId = request.cookies.get('deviceId')?.value;
    const slotParam = request.nextUrl.searchParams.get('slot');
    const slot: 1 | 2 = slotParam === '2' ? 2 : 1;

    const { env } = getRequestContext() as unknown as { env: Env };
    const db = env.DB;

    const hasVapidPublic = !!env.VAPID_PUBLIC_KEY;
    const hasVapidPrivate = !!env.VAPID_PRIVATE_KEY;
    const hasVapidSubject = !!env.VAPID_SUBJECT;

    if (!db) {
      return NextResponse.json({
        error: 'No database',
        vapid: { hasPublic: hasVapidPublic, hasPrivate: hasVapidPrivate, hasSubject: hasVapidSubject },
      });
    }

    if (!deviceId) {
      return NextResponse.json({
        error: 'No deviceId cookie',
        vapid: { hasPublic: hasVapidPublic, hasPrivate: hasVapidPrivate, hasSubject: hasVapidSubject },
      });
    }

    // Get current member
    const member = await db
      .prepare('SELECT * FROM members WHERE device_id = ?')
      .bind(deviceId)
      .first<Member>();

    if (!member) {
      return NextResponse.json({
        error: 'Not paired',
        deviceId,
        vapid: { hasPublic: hasVapidPublic, hasPrivate: hasVapidPrivate, hasSubject: hasVapidSubject },
      });
    }

    let useLegacySchema = false;
    let memberPair: MemberPair | null = null;

    try {
      memberPair = await db
        .prepare('SELECT * FROM member_pairs WHERE member_id = ? AND slot = ?')
        .bind(member.id, slot)
        .first<MemberPair>();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('no such table: member_pairs')) {
        useLegacySchema = true;
      } else {
        throw error;
      }
    }

    if (!useLegacySchema && !memberPair) {
      return NextResponse.json({
        error: `No pairing in slot ${slot}`,
        slot,
        deviceId,
        vapid: { hasPublic: hasVapidPublic, hasPrivate: hasVapidPrivate, hasSubject: hasVapidSubject },
        you: {
          id: member.id,
          hasPushEndpoint: !!member.push_endpoint,
          hasPushKeys: !!member.push_p256dh && !!member.push_auth,
          pushEndpointPreview: member.push_endpoint?.slice(0, 50) + '...',
        },
        partner: null,
      });
    }

    let partner: Member | null = null;
    if (useLegacySchema) {
      partner = await db
        .prepare('SELECT * FROM members WHERE pair_id = ? AND device_id != ?')
        .bind(member.pair_id, deviceId)
        .first<Member>();
    } else if (memberPair) {
      const partnerPair = await db
        .prepare('SELECT * FROM member_pairs WHERE pair_id = ? AND member_id != ?')
        .bind(memberPair.pair_id, member.id)
        .first<MemberPair>();

      if (partnerPair) {
        partner = await db
          .prepare('SELECT * FROM members WHERE id = ?')
          .bind(partnerPair.member_id)
          .first<Member>();
      }
    }

    return NextResponse.json({
      deviceId,
      slot,
      vapid: {
        hasPublic: hasVapidPublic,
        hasPrivate: hasVapidPrivate,
        hasSubject: hasVapidSubject,
      },
      you: {
        id: member.id,
        hasPushEndpoint: !!member.push_endpoint,
        hasPushKeys: !!member.push_p256dh && !!member.push_auth,
        pushEndpointPreview: member.push_endpoint?.slice(0, 50) + '...',
      },
      partner: partner ? {
        id: partner.id,
        hasPushEndpoint: !!partner.push_endpoint,
        hasPushKeys: !!partner.push_p256dh && !!partner.push_auth,
        pushEndpointPreview: partner.push_endpoint?.slice(0, 50) + '...',
      } : null,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

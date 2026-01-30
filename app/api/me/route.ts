import { NextRequest, NextResponse } from 'next/server';
import { getRequestContext } from '@cloudflare/next-on-pages';
import type { Env, Member, MemberPair, MeResponse, SlotState } from '@/lib/types';

const OVEN_SECONDS = 108;

export const runtime = 'edge';

interface MemberPairWithPartner extends MemberPair {
  hasPartner?: boolean;
}

export async function GET(request: NextRequest) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const deviceId = request.cookies.get('deviceId')?.value;

    if (!deviceId) {
      return NextResponse.json<MeResponse>({
        paired: false,
        ovenRemainingSeconds: 0,
        hasPartner: false,
        serverNow: now,
        slots: { 1: false, 2: false },
        stateBySlot: {},
      });
    }

    // Get Cloudflare bindings
    const { env } = getRequestContext() as unknown as { env: Env };
    const db = env.DB;

    if (!db) {
      // Development mode
      return NextResponse.json<MeResponse>({
        paired: true,
        ovenRemainingSeconds: 0,
        hasPartner: true,
        serverNow: now,
        slots: { 1: true, 2: false },
        stateBySlot: {
          1: { lastSentAt: null, lastReceivedAt: null },
        },
      });
    }

    // Get the member
    const member = await db
      .prepare('SELECT * FROM members WHERE device_id = ?')
      .bind(deviceId)
      .first<Member>();

    if (!member) {
      return NextResponse.json<MeResponse>({
        paired: false,
        ovenRemainingSeconds: 0,
        hasPartner: false,
        serverNow: now,
        slots: { 1: false, 2: false },
        stateBySlot: {},
      });
    }

    // Try to get member_pairs for this member (new schema)
    let memberPairs: MemberPairWithPartner[] = [];
    let useLegacySchema = false;

    try {
      const result = await db
        .prepare('SELECT * FROM member_pairs WHERE member_id = ? ORDER BY slot')
        .bind(member.id)
        .all<MemberPair>();
      memberPairs = result.results || [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('no such table: member_pairs')) {
        // Fall back to legacy schema (single pairing via members table)
        useLegacySchema = true;
      } else {
        throw error;
      }
    }

    // If using legacy schema or no member_pairs exist, use old behavior
    if (useLegacySchema || memberPairs.length === 0) {
      // Check for partner using old schema
      const partner = await db
        .prepare('SELECT * FROM members WHERE pair_id = ? AND device_id != ?')
        .bind(member.pair_id, deviceId)
        .first<Member>();

      // Calculate oven remaining (legacy)
      let ovenRemaining = 0;
      if (member.last_chomp_at) {
        const elapsed = now - member.last_chomp_at;
        if (elapsed < OVEN_SECONDS) {
          ovenRemaining = OVEN_SECONDS - elapsed;
        }
      }

      // Create slot 1 state from legacy member data
      const slot1State: SlotState = {
        lastSentAt: member.last_chomp_at ?? null,
        lastReceivedAt: member.last_received_at ?? null,
      };

      return NextResponse.json<MeResponse>({
        paired: true,
        ovenRemainingSeconds: ovenRemaining,
        hasPartner: !!partner,
        serverNow: now,
        slots: { 1: true, 2: false },
        stateBySlot: {
          1: slot1State,
        },
      });
    }

    // New schema: build slots and stateBySlot from member_pairs
    const slots = { 1: false, 2: false };
    const hasPartnerBySlot: { 1?: boolean; 2?: boolean } = {};
    const stateBySlot: { 1?: SlotState; 2?: SlotState } = {};
    let hasAnyPartner = false;
    let firstSlotOvenRemaining = 0;

    for (const mp of memberPairs) {
      const slotNum = mp.slot as 1 | 2;
      slots[slotNum] = true;

      // Check if this slot has a partner
      const partnerCount = await db
        .prepare('SELECT COUNT(*) as count FROM member_pairs WHERE pair_id = ? AND member_id != ?')
        .bind(mp.pair_id, member.id)
        .first<{ count: number }>();

      const slotHasPartner = !!(partnerCount && partnerCount.count > 0);
      hasPartnerBySlot[slotNum] = slotHasPartner;

      if (slotHasPartner) {
        hasAnyPartner = true;
      }

      stateBySlot[slotNum] = {
        lastSentAt: mp.last_sent_at ?? null,
        lastReceivedAt: mp.last_received_at ?? null,
      };

      // Calculate oven remaining for slot 1 (for backward compatibility)
      if (slotNum === 1 && mp.last_sent_at) {
        const elapsed = now - mp.last_sent_at;
        if (elapsed < OVEN_SECONDS) {
          firstSlotOvenRemaining = OVEN_SECONDS - elapsed;
        }
      }
    }

    return NextResponse.json<MeResponse>({
      paired: slots[1] || slots[2],
      ovenRemainingSeconds: firstSlotOvenRemaining,
      hasPartner: hasAnyPartner,
      hasPartnerBySlot,
      serverNow: now,
      slots,
      stateBySlot,
    });
  } catch (error) {
    console.error('Me error:', error);
    return NextResponse.json<MeResponse>({
      paired: false,
      ovenRemainingSeconds: 0,
      hasPartner: false,
      serverNow: Math.floor(Date.now() / 1000),
      slots: { 1: false, 2: false },
      stateBySlot: {},
    });
  }
}

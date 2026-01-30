import { NextRequest, NextResponse } from 'next/server';
import { getRequestContext } from '@cloudflare/next-on-pages';
import type { Env, Pair, Member, MemberPair, PairRequest, PairResponse } from '@/lib/types';
import { sha256, generateId, generatePairCode } from '@/lib/crypto';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  try {
    const body: PairRequest = await request.json();
    const { code, deviceId, slot: requestedSlot } = body;

    if (!deviceId) {
      return NextResponse.json<PairResponse>(
        { ok: false, success: false, paired: false, error: 'Device ID required' },
        { status: 400 }
      );
    }

    // Get Cloudflare bindings
    const { env } = getRequestContext() as unknown as { env: Env };
    const db = env.DB;

    if (!db) {
      // Development mode - return mock response
      const response = NextResponse.json<PairResponse>({
        ok: true,
        success: true,
        paired: true,
        slot: 1,
        slots: { 1: true, 2: false },
      });
      response.cookies.set('deviceId', deviceId, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 60 * 60 * 24 * 365,
        path: '/',
      });
      return response;
    }

    // Get existing member (if any)
    let member = await db
      .prepare('SELECT * FROM members WHERE device_id = ?')
      .bind(deviceId)
      .first<Member>();

    // Check existing member_pairs (if member exists)
    let existingPairs: MemberPair[] = [];
    let useLegacySchema = false;

    if (member) {
      try {
        const result = await db
          .prepare('SELECT * FROM member_pairs WHERE member_id = ? ORDER BY slot')
          .bind(member.id)
          .all<MemberPair>();
        existingPairs = result.results || [];
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
        return handleLegacyPairing(request, db, member, code, deviceId);
      }
    }

    // Determine slot to use
    const slot1Exists = existingPairs.some(mp => mp.slot === 1);
    const slot2Exists = existingPairs.some(mp => mp.slot === 2);

    let targetSlot: 1 | 2;
    if (requestedSlot !== undefined) {
      targetSlot = requestedSlot;
      // Check if requested slot is already filled
      if ((targetSlot === 1 && slot1Exists) || (targetSlot === 2 && slot2Exists)) {
        // Slot already has a pairing - check if it's same code or different
        const existingMemberPair = existingPairs.find(mp => mp.slot === targetSlot);
        if (existingMemberPair && code) {
          const codeHash = await sha256(code.toUpperCase().replace(/-/g, ''));
          const pair = await db
            .prepare('SELECT * FROM pairs WHERE id = ?')
            .bind(existingMemberPair.pair_id)
            .first<Pair>();
          if (pair && pair.pair_code_hash === codeHash) {
            // Same pairing, return current state
            return returnCurrentState(db, member!, existingPairs, deviceId);
          }
        }
        // Different pairing for existing slot - replace it
        await db
          .prepare('DELETE FROM member_pairs WHERE member_id = ? AND slot = ?')
          .bind(member!.id, targetSlot)
          .run();
      }
    } else {
      // Auto-assign slot
      if (!slot1Exists) {
        targetSlot = 1;
      } else if (!slot2Exists) {
        targetSlot = 2;
      } else {
        return NextResponse.json<PairResponse>(
          { ok: false, success: false, error: 'both_slots_filled', slots: { 1: true, 2: true } },
          { status: 400 }
        );
      }
    }

    // Generate or validate code and get/create pair
    let pairCode: string | undefined;
    let normalizedCode: string;
    let codeHash: string;

    if (!code) {
      pairCode = generatePairCode();
      normalizedCode = pairCode.toUpperCase().replace(/-/g, '');
      codeHash = await sha256(normalizedCode);
    } else {
      normalizedCode = code.toUpperCase().replace(/-/g, '');
      if (normalizedCode.length !== 8) {
        return NextResponse.json<PairResponse>(
          { ok: false, success: false, paired: false, error: 'Invalid code format' },
          { status: 400 }
        );
      }
      codeHash = await sha256(normalizedCode);
    }

    // Check if pair already exists with this code
    let existingPair = await db
      .prepare('SELECT * FROM pairs WHERE pair_code_hash = ?')
      .bind(codeHash)
      .first<Pair>();

    let pairId: string;
    let hasPartner = false;

    if (existingPair) {
      pairId = existingPair.id;

      // Check if we're already in this pair (in any slot)
      if (member) {
        const alreadyInPair = existingPairs.some(mp => mp.pair_id === pairId);
        if (alreadyInPair) {
          // Just return current state
          return returnCurrentState(db, member, existingPairs, deviceId);
        }
      }

      // Check how many members are in this pair
      // Try member_pairs first, fall back to members table
      let memberCount = 0;
      try {
        const pairMembers = await db
          .prepare('SELECT COUNT(*) as count FROM member_pairs WHERE pair_id = ?')
          .bind(pairId)
          .first<{ count: number }>();
        memberCount = pairMembers?.count || 0;
      } catch (error) {
        // Fall back to checking members table (legacy schema)
        const pairMembers = await db
          .prepare('SELECT COUNT(*) as count FROM members WHERE pair_id = ?')
          .bind(pairId)
          .first<{ count: number }>();
        memberCount = pairMembers?.count || 0;
      }

      if (memberCount >= 2) {
        return NextResponse.json<PairResponse>(
          { ok: false, success: false, paired: false, error: 'Pair is full' },
          { status: 409 }
        );
      }

      hasPartner = memberCount === 1;
    } else {
      // Create new pair
      pairId = generateId();
      await db
        .prepare('INSERT INTO pairs (id, pair_code_hash) VALUES (?, ?)')
        .bind(pairId, codeHash)
        .run();
    }

    // Now create member if it doesn't exist (we now have a valid pairId)
    if (!member) {
      const memberId = generateId();
      await db
        .prepare('INSERT INTO members (id, device_id, pair_id) VALUES (?, ?, ?)')
        .bind(memberId, deviceId, pairId)
        .run();
      member = await db
        .prepare('SELECT * FROM members WHERE device_id = ?')
        .bind(deviceId)
        .first<Member>();

      if (!member) {
        return NextResponse.json<PairResponse>(
          { ok: false, success: false, paired: false, error: 'Failed to create member' },
          { status: 500 }
        );
      }
    }

    // Add member_pair entry
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare(
        'INSERT INTO member_pairs (member_id, pair_id, slot, created_at) VALUES (?, ?, ?, ?)'
      )
      .bind(member.id, pairId, targetSlot, now)
      .run();

    // Update member's pair_id for legacy compatibility (use first slot's pair)
    if (targetSlot === 1 || !slot1Exists) {
      await db
        .prepare('UPDATE members SET pair_id = ? WHERE id = ?')
        .bind(pairId, member.id)
        .run();
    }

    // Get updated slot status
    const updatedPairs = await db
      .prepare('SELECT * FROM member_pairs WHERE member_id = ? ORDER BY slot')
      .bind(member.id)
      .all<MemberPair>();

    const slots = {
      1: (updatedPairs.results || []).some(mp => mp.slot === 1),
      2: (updatedPairs.results || []).some(mp => mp.slot === 2),
    };

    const response = NextResponse.json<PairResponse>({
      ok: true,
      success: true,
      paired: hasPartner,
      waiting: !hasPartner,
      slot: targetSlot,
      pairCode: pairCode,
      slots,
    });

    response.cookies.set('deviceId', deviceId, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 365,
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Pair error:', error);
    return NextResponse.json<PairResponse>(
      { ok: false, success: false, paired: false, error: 'Internal error' },
      { status: 500 }
    );
  }
}

// Helper function to return current state
async function returnCurrentState(
  db: Env['DB'],
  member: Member,
  existingPairs: MemberPair[],
  deviceId: string
): Promise<NextResponse<PairResponse>> {
  // Check for partners in each slot
  let hasPartner = false;
  for (const mp of existingPairs) {
    const partnerCount = await db
      .prepare('SELECT COUNT(*) as count FROM member_pairs WHERE pair_id = ? AND member_id != ?')
      .bind(mp.pair_id, member.id)
      .first<{ count: number }>();
    if (partnerCount && partnerCount.count > 0) {
      hasPartner = true;
      break;
    }
  }

  const slots = {
    1: existingPairs.some(mp => mp.slot === 1),
    2: existingPairs.some(mp => mp.slot === 2),
  };

  const response = NextResponse.json<PairResponse>({
    ok: true,
    success: true,
    paired: hasPartner,
    waiting: !hasPartner,
    slots,
  });

  response.cookies.set('deviceId', deviceId, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
  });

  return response;
}

// Legacy schema handling (before member_pairs migration)
async function handleLegacyPairing(
  _request: NextRequest,
  db: Env['DB'],
  member: Member,
  code: string | undefined,
  deviceId: string
): Promise<NextResponse<PairResponse>> {
  // If no code, create new pairing
  if (!code) {
    const pairCode = generatePairCode();
    const codeHash = await sha256(pairCode.toUpperCase().replace(/-/g, ''));
    const pairId = generateId();

    await db.batch([
      db.prepare('INSERT INTO pairs (id, pair_code_hash) VALUES (?, ?)').bind(pairId, codeHash),
      db.prepare('UPDATE members SET pair_id = ? WHERE id = ?').bind(pairId, member.id),
    ]);

    const response = NextResponse.json<PairResponse>({
      ok: true,
      success: true,
      paired: false,
      waiting: true,
      slot: 1,
      pairCode,
      slots: { 1: true, 2: false },
    });
    response.cookies.set('deviceId', deviceId, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 365,
      path: '/',
    });
    return response;
  }

  const normalizedCode = code.toUpperCase().replace(/-/g, '');
  if (normalizedCode.length !== 8) {
    return NextResponse.json<PairResponse>(
      { ok: false, success: false, paired: false, error: 'Invalid code format' },
      { status: 400 }
    );
  }

  const codeHash = await sha256(normalizedCode);

  // Check if already paired
  if (member.pair_id) {
    const partner = await db
      .prepare('SELECT * FROM members WHERE pair_id = ? AND device_id != ?')
      .bind(member.pair_id, deviceId)
      .first<Member>();

    const response = NextResponse.json<PairResponse>({
      ok: true,
      success: true,
      paired: !!partner,
      waiting: !partner,
      slot: 1,
      slots: { 1: true, 2: false },
    });
    response.cookies.set('deviceId', deviceId, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 365,
      path: '/',
    });
    return response;
  }

  // Check if pair exists
  const existingPair = await db
    .prepare('SELECT * FROM pairs WHERE pair_code_hash = ?')
    .bind(codeHash)
    .first<Pair>();

  if (existingPair) {
    const members = await db
      .prepare('SELECT COUNT(*) as count FROM members WHERE pair_id = ?')
      .bind(existingPair.id)
      .first<{ count: number }>();

    if ((members?.count || 0) >= 2) {
      return NextResponse.json<PairResponse>(
        { ok: false, success: false, paired: false, error: 'Pair is full' },
        { status: 409 }
      );
    }

    await db
      .prepare('UPDATE members SET pair_id = ? WHERE id = ?')
      .bind(existingPair.id, member.id)
      .run();

    const response = NextResponse.json<PairResponse>({
      ok: true,
      success: true,
      paired: true,
      slot: 1,
      slots: { 1: true, 2: false },
    });
    response.cookies.set('deviceId', deviceId, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 365,
      path: '/',
    });
    return response;
  }

  // Create new pair
  const pairId = generateId();
  await db.batch([
    db.prepare('INSERT INTO pairs (id, pair_code_hash) VALUES (?, ?)').bind(pairId, codeHash),
    db.prepare('UPDATE members SET pair_id = ? WHERE id = ?').bind(pairId, member.id),
  ]);

  const response = NextResponse.json<PairResponse>({
    ok: true,
    success: true,
    paired: false,
    waiting: true,
    slot: 1,
    slots: { 1: true, 2: false },
  });
  response.cookies.set('deviceId', deviceId, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
  });
  return response;
}

// GET endpoint to generate a new pairing code
export async function GET() {
  const code = generatePairCode();
  return NextResponse.json({ code });
}

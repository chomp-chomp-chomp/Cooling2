"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useState } from "react";

type SectionKey = "readme" | "versionNotes" | "tos" | "antiFaq" | "knownIssues";

type Section = {
  key: SectionKey;
  title: string;
  content: string; // markdown-ish plain text; render as pre-wrapped text for now
  defaultOpen?: boolean;
};

const README_MD = `Cooling is a small app for two people.

It does one thing:
it lets you send a simple signal to someone you care about.

There is one button.
Pressing it sends a buzz.

There is no chat.
There is no feed.
There is no obligation to respond.

The buzz is not a message.
It does not ask a question.
It does not require an answer.

It exists so you can say “I thought of you”
without turning that thought into a task.

This app is intentionally minimal.
It is designed to be used briefly and then left alone.

If you want to know why it is shaped this way,
the notes below explain what has already been decided.
`;

const VERSION_NOTES_MD = `We are drowning in communication.

Not because we speak too much,
but because every utterance has been conscripted into labor.

Every message now demands:
availability,
coherence,
continuity,
response.

Silence is no longer neutral.
It is interpreted as failure.

The buzz is not a message.
It contains no information.
This is not an oversight.

Information belongs to exchange.
The buzz refuses closure.

It says only:
“I thought of you — and I will not elaborate.”

The heart-cookie button is a fetish object.
It absorbs anxiety so the relationship does not have to.

You press the button
so you don’t have to press the other person.

Cooling is limited to two people.
The moment a third appears,
the gesture becomes performance.
Desire dies in public.

After a buzz, you must wait.
Desire is delayed.
Restraint is enforced.

Nothing is optimized.
Nothing compounds.
No surplus value is produced.

If this app ever adds replies,
metrics,
feeds,
or explanation:
delete it.

This app is complete because it does not progress.
`;

const TOS_MD = `By using Cooling, you agree to these terms.

If you do not agree, do not use the app.
If you use the app, you have already agreed.

Cooling provides a single function:
the ability to send a buzz.

A buzz is not a request.
A buzz is not a promise.
A buzz is not a debt.

Cooling does not obligate:
a response,
an explanation,
or continuation.

A mandatory waiting period exists between buzzes.
This is intentional.

Cooling collects only the minimum data required to function.
If this ever changes, the service has failed.

No emotional outcomes are guaranteed.
Misinterpretation is not the responsibility of the system.

The service may end at any time.
No explanation will be provided.

Nothing here is meant to solve anything.
`;

const ANTI_FAQ_MD = `What does the buzz mean?
Nothing specific.

Why can’t I send another buzz right away?
Because you already sent one.

Can they see that I buzzed?
They feel it.

Why isn’t there a reply button?
Replies turn signals into negotiations.

What if they don’t buzz back?
Then nothing happens.

Is this for romantic partners?
It is for people who can tolerate ambiguity.

Can I customize the messages?
No.

Is this a joke?
Only if sincerity makes you uncomfortable.

Is this supposed to fix something?
No.
`;

const KNOWN_ISSUES_MD = `Buzzes are ambiguous.
This will not be fixed.

The other person may not respond.
This is working as intended.

Buzzes cannot be sent repeatedly.
This is permanent.

You may want to say more.
This sensation is expected.

There are no read receipts.
Surveillance is excluded by design.

Some users report relief after buzzing.
Some report anxiety.
Both are unplanned side effects.

The app only supports two people.
This is a structural limit.

There is no correct way to use the app.
This is intentional.

Nothing is resolved.
This is out of scope.
`;

/**
 * Notes page:
 * - README open by default
 * - Chevron indicators
 * - "Additional documentation below."
 * - Entire row tappable
 * - Faint divider line
 * - Calm animation timing
 */
export default function Notes() {
  const router = useRouter();
  const sections: Section[] = useMemo(
    () => [
      { key: "readme", title: "README", content: README_MD, defaultOpen: true },
      { key: "versionNotes", title: "Version Notes", content: VERSION_NOTES_MD },
      { key: "tos", title: "ToS", content: TOS_MD },
      { key: "antiFaq", title: "Anti-FAQ", content: ANTI_FAQ_MD },
      { key: "knownIssues", title: "Known Issues", content: KNOWN_ISSUES_MD },
    ],
    []
  );

  // One-open-at-a-time accordion (recommended for clarity on mobile)
  const [openKey, setOpenKey] = useState<SectionKey>("readme");

  // Track whether slot 2 exists (to conditionally show "Another Cooling" link)
  const [slot2Exists, setSlot2Exists] = useState<boolean | null>(null);

  useEffect(() => {
    async function checkSlots() {
      try {
        const res = await fetch("/api/me");
        if (res.ok) {
          const data: { slots?: { 1: boolean; 2: boolean } } = await res.json();
          if (data.slots) {
            setSlot2Exists(data.slots[2] === true);
          } else {
            setSlot2Exists(false);
          }
        }
      } catch {
        // Ignore errors
      }
    }
    checkSlots();
  }, []);

  const handleAnotherCooling = useCallback(() => {
    // Set pending slot in localStorage and navigate to home for pairing
    localStorage.setItem("pendingSlot", "2");
    router.push("/");
  }, [router]);

  function toggle(key: SectionKey) {
    setOpenKey((prev) => (prev === key ? prev : key));
  }

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        <nav style={styles.nav}>
          <Link href="/" style={styles.backLink}>
            ← Back
          </Link>
        </nav>
        <h1 style={styles.h1}>Documentation</h1>

        <div style={styles.accordion} role="list">
          {sections.map((s, idx) => {
            const isOpen = openKey === s.key;
            const headerId = `acc-${s.key}-header`;
            const panelId = `acc-${s.key}-panel`;

            return (
              <div
                key={s.key}
                style={{
                  ...styles.item,
                  ...(idx === 0 ? styles.itemFirst : null),
                }}
                role="listitem"
              >
                {/* Whole row is a button for tapability */}
                <button
                  type="button"
                  id={headerId}
                  aria-controls={panelId}
                  aria-expanded={isOpen}
                  onClick={() => toggle(s.key)}
                  style={styles.rowButton}
                >
                  <span style={styles.title}>{s.title}</span>
                  <span
                    aria-hidden="true"
                    style={{
                      ...styles.chevron,
                      transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                    }}
                  >
                    ▸
                  </span>
                </button>

                {/* Optional microcopy line after README 
                {s.key === "readme" && (
                  <div style={styles.microcopyWrap}>
                    <div style={styles.microcopy}>
                      Additional documentation below.
                    </div>
                  </div>
                )} */}

                {/* Animated panel (calm timing) */}
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={headerId}
                  style={{
                    ...styles.panelOuter,
                    gridTemplateRows: isOpen ? "1fr" : "0fr",
                  }}
                >
                  <div style={styles.panelInner}>
                    <div style={styles.panelContent}>
                      {/* Render as pre-wrapped text (no markdown parser needed) */}
                      <div style={styles.textBlock}>{s.content}</div>
                    </div>
                  </div>
                </div>

                {/* Faint divider */}
                <div style={styles.divider} />
              </div>
            );
          })}
        </div>

        {/* "Another Cooling is possible." - only shown when slot 2 doesn't exist */}
        {slot2Exists === false && (
          <div style={styles.anotherCoolingWrap}>
            <button
              type="button"
              onClick={handleAnotherCooling}
              style={styles.anotherCoolingLink}
            >
              Another Cooling is possible.
            </button>
          </div>
        )}

        <div style={styles.fixLink}>
          <Link href="/notifications" style={styles.subtleLink}>
            Enable notifications
          </Link>
        </div>
      </div>
    </main>
  );
}

/**
 * “Calm procedural” motion:
 * - short duration, gentle easing, no bounce
 * - grid row animation avoids measuring height
 */
const styles: Record<string, React.CSSProperties> = {
  page: {
    background: "#ffffff",
    minHeight: "100vh",
    color: "#111",
  },
  container: {
    maxWidth: 680,
    margin: "0 auto",
    padding: "24px 18px 48px",
  },
  nav: {
    marginBottom: 8,
  },
  backLink: {
    fontSize: 13,
    textDecoration: "none",
    color: "inherit",
    opacity: 0.6,
  },
  h1: {
    fontSize: 20,
    fontWeight: 600,
    margin: "4px 0 16px",
    letterSpacing: 0.2,
  },
  accordion: {
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.08)",
    overflow: "hidden",
  },
  item: {
    background: "#fff",
  },
  itemFirst: {},
  rowButton: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "14px 14px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    // tap target comfort
    minHeight: 48,
  },
  title: {
    fontSize: 15,
    fontWeight: 600,
  },
  chevron: {
    fontSize: 16,
    lineHeight: "16px",
    transition: "transform 180ms cubic-bezier(0.2, 0.0, 0.0, 1.0)",
    opacity: 0.85,
  },
  microcopyWrap: {
    padding: "0 14px 6px",
  },
  microcopy: {
    fontSize: 12.5,
    opacity: 0.6,
  },
  panelOuter: {
    display: "grid",
    transition: "grid-template-rows 220ms cubic-bezier(0.2, 0.0, 0.0, 1.0)",
  },
  panelInner: {
    overflow: "hidden",
  },
  panelContent: {
    padding: "8px 14px 14px",
  },
  textBlock: {
    whiteSpace: "pre-wrap",
    lineHeight: 1.5,
    fontSize: 14,
    opacity: 0.95,
  },
  divider: {
    height: 1,
    background: "rgba(0,0,0,0.06)",
  },
  fixLink: {
    marginTop: 24,
    textAlign: "center",
  },
  subtleLink: {
    fontSize: 13,
    textDecoration: "none",
    color: "inherit",
    opacity: 0.5,
  },
  anotherCoolingWrap: {
    marginTop: 24,
    textAlign: "center",
  },
  anotherCoolingLink: {
    fontSize: 14,
    lineHeight: 1.5,
    color: "inherit",
    opacity: 0.95,
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    textDecoration: "none",
  },
};
"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type AppState = "loading" | "install" | "pair" | "waiting" | "ready";
type SlotNum = 1 | 2;

interface SlotState {
  lastSentAt: number | null;
  lastReceivedAt: number | null;
}

interface SlotsInfo {
  slots: { 1: boolean; 2: boolean };
  stateBySlot: { 1?: SlotState; 2?: SlotState };
}

const OVEN_SECONDS = 108;

export default function HomePage() {
  const [appState, setAppState] = useState<AppState>("loading");
  const [activeSlot, setActiveSlot] = useState<SlotNum>(1);
  const [slotsInfo, setSlotsInfo] = useState<SlotsInfo>({
    slots: { 1: false, 2: false },
    stateBySlot: {},
  });

  // Active slot state
  const [sentRemaining, setSentRemaining] = useState<number>(0);
  const [receivedRemaining, setReceivedRemaining] = useState<number>(0);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [lastReceivedAt, setLastReceivedAt] = useState<number | null>(null);

  // Inactive slot state (for received ring indicator)
  const [inactiveReceivedRemaining, setInactiveReceivedRemaining] = useState<number>(0);

  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [lastChompRelative, setLastChompRelative] = useState<string>("never");
  const [isSending, setIsSending] = useState(false);
  const [pairCode, setPairCode] = useState("");
  const [inputCode, setInputCode] = useState("");
  const [deviceId, setDeviceId] = useState<string>("");
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [devMode, setDevMode] = useState(false);
  const buzzAudioRef = useRef<HTMLAudioElement | null>(null);
  const prevReceivedRef = useRef<number>(0);

  // Long press state
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [showSlotToast, setShowSlotToast] = useState(false);
  const [showHintToast, setShowHintToast] = useState(false);

  // Pending slot for second pairing (set from Notes page link or hint toast)
  const [pendingSlot, setPendingSlot] = useState<SlotNum | null>(null);

  const logDebug = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setDebugLogs((prev) => [`[${timestamp}] ${message}`, ...prev].slice(0, 80));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setDevMode(params.get("dev") === "1");
  }, []);

  // Load activeSlot from localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem("activeSlot");
    if (stored === "2") {
      setActiveSlot(2);
    }
  }, []);

  // Check for pendingSlot (set by Notes page "Another Cooling" link or hint toast)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const pending = localStorage.getItem("pendingSlot");
    if (pending === "2") {
      setPendingSlot(2);
      localStorage.removeItem("pendingSlot");
    }
  }, []);

  // Save activeSlot to localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem("activeSlot", String(activeSlot));
  }, [activeSlot]);

  // Initialize buzz audio
  useEffect(() => {
    buzzAudioRef.current = new Audio("/buzz.mp3");
    buzzAudioRef.current.preload = "auto";
  }, []);

  const playBuzz = useCallback(() => {
    try {
      if (buzzAudioRef.current) {
        buzzAudioRef.current.currentTime = 0;
        buzzAudioRef.current.play().catch(() => {});
      }
    } catch (e) {
      // Audio playback may be blocked
    }
  }, []);

  // Detect new chomps from polling (receivedRemaining goes from 0 to >0)
  useEffect(() => {
    if (receivedRemaining > 0 && prevReceivedRef.current === 0) {
      playBuzz();
    }
    prevReceivedRef.current = receivedRemaining;
  }, [receivedRemaining, playBuzz]);

  // Check if running in standalone mode (installed PWA)
  const isStandalone = useCallback(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    if (params.get("dev") === "1") return true;
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as any).standalone === true
    );
  }, []);

  // Generate or retrieve device ID and set cookie
  useEffect(() => {
    let id = localStorage.getItem("deviceId");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("deviceId", id);
    }
    document.cookie = `deviceId=${id}; path=/; max-age=31536000; SameSite=Strict`;
    setDeviceId(id);
  }, []);

  // Compute remaining seconds for both slots based on stateBySlot
  const computeSlotRemaining = useCallback(
    (slotState: SlotState | undefined, alignedNow: number) => {
      if (!slotState) return { sent: 0, received: 0 };
      const sent = slotState.lastSentAt
        ? Math.max(0, OVEN_SECONDS - (alignedNow - slotState.lastSentAt))
        : 0;
      const received = slotState.lastReceivedAt
        ? Math.max(0, OVEN_SECONDS - (alignedNow - slotState.lastReceivedAt))
        : 0;
      return { sent, received };
    },
    []
  );

  // Update slot remaining timers when slotsInfo or activeSlot changes
  useEffect(() => {
    const alignedNow = Math.floor((Date.now() + serverOffsetMs) / 1000);
    const activeState = slotsInfo.stateBySlot[activeSlot];
    const inactiveSlot: SlotNum = activeSlot === 1 ? 2 : 1;
    const inactiveState = slotsInfo.stateBySlot[inactiveSlot];

    if (activeState) {
      const { sent, received } = computeSlotRemaining(activeState, alignedNow);
      setSentRemaining(sent);
      setReceivedRemaining(received);
      setLastSentAt(activeState.lastSentAt);
      setLastReceivedAt(activeState.lastReceivedAt);
    }

    if (inactiveState && slotsInfo.slots[inactiveSlot]) {
      const { received } = computeSlotRemaining(inactiveState, alignedNow);
      setInactiveReceivedRemaining(received);
    } else {
      setInactiveReceivedRemaining(0);
    }
  }, [slotsInfo, activeSlot, serverOffsetMs, computeSlotRemaining]);

  // Fetch full status including all slots from /api/me
  const fetchFullStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/me");
      if (!res.ok) {
        const body = await res.text();
        logDebug(`me failed (${res.status}) ${body}`);
        return null;
      }
      const data: {
        paired?: boolean;
        hasPartner?: boolean;
        serverNow?: number;
        slots?: { 1: boolean; 2: boolean };
        stateBySlot?: { 1?: SlotState; 2?: SlotState };
      } = await res.json();

      const serverNow = data.serverNow ?? Math.floor(Date.now() / 1000);
      const offsetMs = serverNow * 1000 - Date.now();
      setServerOffsetMs(offsetMs);

      if (data.slots && data.stateBySlot) {
        setSlotsInfo({
          slots: data.slots,
          stateBySlot: data.stateBySlot,
        });
      }

      logDebug(
        `me ok (paired=${data.paired ?? false}, hasPartner=${data.hasPartner ?? false}, slots=${JSON.stringify(data.slots)})`
      );

      return data;
    } catch (e) {
      logDebug("me failed (network)");
      return null;
    }
  }, [logDebug]);

  // Fetch status for active slot only
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/status?slot=${activeSlot}`);
      if (!res.ok) {
        const body = await res.text();
        logDebug(`status failed (${res.status}) ${body}`);
        return;
      }
      const data: {
        ovenRemainingSeconds?: number;
        lastChompRelative?: string;
        serverNow?: number;
        lastSentAt?: number | null;
        lastReceivedAt?: number | null;
      } = await res.json();

      const serverNow = data.serverNow ?? Math.floor(Date.now() / 1000);
      const offsetMs = serverNow * 1000 - Date.now();
      const alignedNow = Math.floor((Date.now() + offsetMs) / 1000);
      setServerOffsetMs(offsetMs);
      setLastSentAt(data.lastSentAt ?? null);
      setLastReceivedAt(data.lastReceivedAt ?? null);

      const sentRemainingSeconds = data.lastSentAt
        ? Math.max(0, OVEN_SECONDS - (alignedNow - data.lastSentAt))
        : 0;
      const receivedRemainingSeconds = data.lastReceivedAt
        ? Math.max(0, OVEN_SECONDS - (alignedNow - data.lastReceivedAt))
        : 0;

      setSentRemaining(sentRemainingSeconds);
      setReceivedRemaining(receivedRemainingSeconds);
      setLastChompRelative(data.lastChompRelative || "never");

      // Update stateBySlot for active slot
      setSlotsInfo((prev) => ({
        ...prev,
        stateBySlot: {
          ...prev.stateBySlot,
          [activeSlot]: {
            lastSentAt: data.lastSentAt ?? null,
            lastReceivedAt: data.lastReceivedAt ?? null,
          },
        },
      }));

      logDebug(
        `status ok (slot=${activeSlot}, sentRemaining=${sentRemainingSeconds}, receivedRemaining=${receivedRemainingSeconds})`
      );
    } catch (e) {
      logDebug("status failed (network)");
    }
  }, [activeSlot, logDebug]);

  // Listen for service worker messages (push received while app is open)
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "chomp-received") {
        playBuzz();
        // Fetch full status to get both slots' state
        fetchFullStatus();
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, [playBuzz, fetchFullStatus]);

  // Initialize app state
  useEffect(() => {
    async function init() {
      if (!isStandalone()) {
        setAppState("install");
        return;
      }

      if ("serviceWorker" in navigator) {
        try {
          const reg = await navigator.serviceWorker.register("/sw.js");
          reg.update();
        } catch (e) {
          console.error("SW registration failed:", e);
        }
      }

      // Check pairing status and get slot info
      const data = await fetchFullStatus();
      if (!data) {
        logDebug("init failed; defaulting to pair (network)");
        setAppState("pair");
        return;
      }

      logDebug(`me ok (paired=${data.paired ?? false}, hasPartner=${data.hasPartner ?? false})`);

      // Check for pending slot 2 pairing request
      const pending = localStorage.getItem("pendingSlot");
      if (pending === "2" && !data.slots?.[2]) {
        localStorage.removeItem("pendingSlot");
        setPendingSlot(2);
        setAppState("pair");
        logDebug("showing pair screen for slot 2");
        return;
      }

      if (data.paired && data.hasPartner) {
        setAppState("ready");
        await fetchStatus();
        await subscribeToPush();
      } else if (data.paired && !data.hasPartner) {
        setAppState("waiting");
        const stored = localStorage.getItem("pairCode");
        if (stored) setPairCode(stored);
        await subscribeToPush();
      } else {
        setAppState("pair");
      }
    }

    if (deviceId) {
      init();
    }
  }, [deviceId, isStandalone, fetchFullStatus, fetchStatus, logDebug]);

  // Listen for visibility changes to refetch status
  useEffect(() => {
    if (appState !== "ready") return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchFullStatus();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [appState, fetchFullStatus]);

  // Poll for status updates while app is open
  useEffect(() => {
    if (appState !== "ready") return;

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchFullStatus();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [appState, fetchFullStatus]);

  // Oven timer countdown for both slots
  useEffect(() => {
    const hasActiveState =
      slotsInfo.stateBySlot[activeSlot]?.lastSentAt ||
      slotsInfo.stateBySlot[activeSlot]?.lastReceivedAt;
    const inactiveSlot: SlotNum = activeSlot === 1 ? 2 : 1;
    const hasInactiveState =
      slotsInfo.slots[inactiveSlot] &&
      slotsInfo.stateBySlot[inactiveSlot]?.lastReceivedAt;

    if (!hasActiveState && !hasInactiveState) return;

    const timer = setInterval(() => {
      const alignedNow = Math.floor((Date.now() + serverOffsetMs) / 1000);

      // Update active slot
      const activeState = slotsInfo.stateBySlot[activeSlot];
      if (activeState) {
        const nextSent = activeState.lastSentAt
          ? Math.max(0, OVEN_SECONDS - (alignedNow - activeState.lastSentAt))
          : 0;
        const nextReceived = activeState.lastReceivedAt
          ? Math.max(0, OVEN_SECONDS - (alignedNow - activeState.lastReceivedAt))
          : 0;
        setSentRemaining(nextSent);
        setReceivedRemaining(nextReceived);
      }

      // Update inactive slot received remaining
      const inactiveState = slotsInfo.stateBySlot[inactiveSlot];
      if (inactiveState && slotsInfo.slots[inactiveSlot]) {
        const nextInactiveReceived = inactiveState.lastReceivedAt
          ? Math.max(0, OVEN_SECONDS - (alignedNow - inactiveState.lastReceivedAt))
          : 0;
        setInactiveReceivedRemaining(nextInactiveReceived);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [slotsInfo, activeSlot, serverOffsetMs]);

  useEffect(() => {
    if (!deviceId) return;
    logDebug(`device ready (${deviceId.slice(0, 8)}...)`);
  }, [deviceId, logDebug]);

  // Subscribe to push notifications
  async function subscribeToPush() {
    logDebug("push: starting subscription flow");

    if (!("Notification" in window)) {
      logDebug("push: Notification API not available");
      return;
    }
    if (Notification.permission !== "granted") {
      logDebug("push: permission not granted");
      return;
    }

    try {
      await ensurePushSubscription({ forceResubscribe: false });
      logDebug("push: subscription ensured");
    } catch (e) {
      console.error("Push subscription failed:", e);
      logDebug(`push: error - ${e}`);
    }
  }

  async function ensurePushSubscription({ forceResubscribe }: { forceResubscribe: boolean }) {
    if (!("serviceWorker" in navigator)) {
      logDebug("push: serviceWorker not available");
      return;
    }
    if (!("PushManager" in window)) {
      logDebug("push: PushManager not available");
      return;
    }

    logDebug("push: waiting for service worker ready");
    const registration = await navigator.serviceWorker.ready;
    logDebug("push: service worker ready");

    let subscription = await registration.pushManager.getSubscription();
    logDebug(`push: existing subscription: ${subscription ? "yes" : "no"}`);

    if (subscription && forceResubscribe) {
      await subscription.unsubscribe();
      subscription = null;
      logDebug("push: unsubscribed existing (force)");
    }

    if (!subscription) {
      logDebug("push: fetching VAPID key");
      const vapidRes = await fetch("/api/vapid-key");
      const vapidData = (await vapidRes.json()) as { publicKey?: string };
      logDebug(`push: VAPID key: ${vapidData.publicKey ? "present" : "MISSING"}`);
      if (!vapidData.publicKey) {
        logDebug("push: no VAPID key, aborting");
        return;
      }

      const padding = "=".repeat((4 - (vapidData.publicKey.length % 4)) % 4);
      const base64 = (vapidData.publicKey + padding)
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const rawData = window.atob(base64);
      const applicationServerKey = new Uint8Array(rawData.length);
      for (let i = 0; i < rawData.length; i++) {
        applicationServerKey[i] = rawData.charCodeAt(i);
      }

      logDebug("push: creating subscription");
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      logDebug(`push: subscription created: ${subscription ? "yes" : "no"}`);
    }

    if (subscription) {
      logDebug("push: sending subscription to server");
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          subscription: subscription.toJSON(),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        logDebug(`push: server save failed (${res.status}) ${body}`);
        return;
      }
      logDebug("push: subscription saved to server");
    } else {
      logDebug("push: no subscription to save");
    }
  }

  // Handle pairing
  async function handlePair(code: string) {
    try {
      // Include slot parameter if we have a pending slot
      const body: { code: string; deviceId: string; slot?: SlotNum } = { code, deviceId };
      if (pendingSlot) {
        body.slot = pendingSlot;
      }

      const res = await fetch("/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body = await res.text();
        logDebug(`pair failed (${res.status}) ${body}`);
        return;
      }
      const data: {
        ok?: boolean;
        success?: boolean;
        paired?: boolean;
        waiting?: boolean;
        slot?: SlotNum;
        slots?: { 1: boolean; 2: boolean };
      } = await res.json();

      if (data.ok || data.success) {
        // Clear pending slot after successful pairing
        setPendingSlot(null);

        if (data.slots) {
          setSlotsInfo((prev) => ({ ...prev, slots: data.slots! }));
        }
        if (data.slot) {
          setActiveSlot(data.slot);
        }

        if (data.paired) {
          setAppState("ready");
          await fetchFullStatus();
          await subscribeToPush();
        } else if (data.waiting) {
          setAppState("waiting");
          localStorage.setItem("pairCode", code);
          setPairCode(code);
          await subscribeToPush();
        }
        logDebug(`pair ok (paired=${data.paired ?? false}, waiting=${data.waiting ?? false}, slot=${data.slot})`);
      }
    } catch (e) {
      console.error("Pairing failed:", e);
      logDebug("pair failed (network)");
    }
  }

  // Generate new code
  async function handleGenerateCode() {
    try {
      const res = await fetch("/api/pair");
      if (!res.ok) {
        const body = await res.text();
        logDebug(`pair code generation failed (${res.status}) ${body}`);
        return;
      }
      const data: { code?: string } = await res.json();
      if (data.code) {
        logDebug(`pair code generated (${data.code})`);
        handlePair(data.code);
      }
    } catch (e) {
      console.error("Code generation failed:", e);
      logDebug("pair code generation failed (network)");
    }
  }

  // Handle chomp
  async function handleChomp() {
    if (isSending || sentRemaining > 0) return;
    setIsSending(true);

    try {
      const res = await fetch(`/api/buzz?slot=${activeSlot}`, {
        method: "POST",
        headers: devMode ? { "x-debug": "1" } : undefined,
      });

      if (res.status === 429) {
        const data = (await res.json().catch(() => null)) as { remainingSeconds?: number } | null;
        const remaining = Number(data?.remainingSeconds ?? 0);
        setSentRemaining(Math.max(0, remaining));
        logDebug(`chomp rate-limited (${remaining}s)`);
        return;
      }

      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { ovenSeconds?: number } | null;
        const oven = Number(data?.ovenSeconds ?? OVEN_SECONDS);
        setSentRemaining(oven);
        const alignedNow = Math.floor((Date.now() + serverOffsetMs) / 1000);
        setLastSentAt(alignedNow);

        // Update stateBySlot for active slot
        setSlotsInfo((prev) => ({
          ...prev,
          stateBySlot: {
            ...prev.stateBySlot,
            [activeSlot]: {
              ...prev.stateBySlot[activeSlot],
              lastSentAt: alignedNow,
            },
          },
        }));

        logDebug(`chomp ok (slot=${activeSlot}, oven=${oven}s)`);
      } else {
        const body = await res.text();
        logDebug(`chomp failed (${res.status}) ${body}`);
      }
    } finally {
      setTimeout(() => setIsSending(false), 120);
    }
  }

  // Poll for partner when waiting
  useEffect(() => {
    if (appState !== "waiting") return;

    const interval = setInterval(async () => {
      const data = await fetchFullStatus();
      if (data?.paired && data?.hasPartner) {
        setAppState("ready");
        await fetchStatus();
        await subscribeToPush();
        logDebug("partner joined");
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [appState, deviceId, fetchFullStatus, fetchStatus]);

  // Long press handling for slot switching or hint
  const handleCookiePressStart = useCallback(() => {
    // If slot 2 exists, long-press switches slots
    if (slotsInfo.slots[2]) {
      longPressTimerRef.current = setTimeout(() => {
        const newSlot: SlotNum = activeSlot === 1 ? 2 : 1;
        setActiveSlot(newSlot);
        setShowSlotToast(true);
        logDebug(`switched to slot ${newSlot}`);

        // Hide toast after 700ms
        setTimeout(() => setShowSlotToast(false), 700);
      }, 500);
      return;
    }

    // Slot 2 doesn't exist - check if hint has been shown
    const hintShown = localStorage.getItem("seenSecondCoolingHint") === "true";
    if (hintShown) {
      // Hint already shown, do nothing
      return;
    }

    // Show the one-time hint
    longPressTimerRef.current = setTimeout(() => {
      setShowHintToast(true);
      localStorage.setItem("seenSecondCoolingHint", "true");
      logDebug("showed second cooling hint");

      // Hide toast after 700ms
      setTimeout(() => setShowHintToast(false), 700);
    }, 500);
  }, [slotsInfo.slots, activeSlot, logDebug]);

  const handleCookiePressEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // Handle tapping the hint toast to go to pairing for slot 2
  const handleHintToastTap = useCallback(() => {
    setShowHintToast(false);
    setPendingSlot(2);
    setAppState("pair");
    logDebug("navigating to pair for slot 2 via hint");
  }, [logDebug]);

  const inOven = sentRemaining > 0;
  const hasSlot2 = slotsInfo.slots[2];

  const debugPanel = devMode ? (
    <section style={styles.debugPanel}>
      <div style={styles.debugTitle}>Debug log</div>
      <button
        type="button"
        onClick={subscribeToPush}
        style={{ fontSize: 12, padding: "6px 12px", marginBottom: 8, border: "1px solid #ccc", borderRadius: 4, background: "#fff" }}
      >
        Enable Notifications
      </button>
      <div style={styles.debugBody}>
        {debugLogs.length === 0 ? "No logs yet." : debugLogs.join("\n")}
      </div>
    </section>
  ) : null;

  // Render based on state
  if (appState === "loading") {
    return (
      <main style={styles.page}>
        <div style={styles.centerWrap}>
          <div style={styles.status}>loading</div>
        </div>
        {debugPanel}
      </main>
    );
  }

  if (appState === "install") {
    return (
      <main style={styles.page}>
        <div style={styles.centerWrap}>
          <Image
            src="/heart-cookie.png"
            alt="Heart cookie"
            width={160}
            height={160}
            priority
            style={{ opacity: 0.6 }}
          />
          <div style={{ ...styles.status, marginTop: 24 }}>
            Add to Home Screen to continue
          </div>
          <div style={styles.installHint}>
            Tap the share button, then &quot;Add to Home Screen&quot;
          </div>
        </div>
        <footer style={styles.footer}>
          <Link href="/about" style={styles.footerLink}>
            About
          </Link>
        </footer>
        {debugPanel}
      </main>
    );
  }

  if (appState === "pair") {
    return (
      <main style={styles.page}>
        <div style={styles.centerWrap}>
          <Image
            src="/heart-cookie.png"
            alt="Heart cookie"
            width={120}
            height={120}
            priority
            style={{ opacity: 0.5 }}
          />

          <div style={styles.pairSection}>
            <div style={styles.pairLabel}>Enter a code to pair</div>
            <input
              type="text"
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              maxLength={9}
              style={styles.pairInput}
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => handlePair(inputCode)}
              disabled={inputCode.replace(/-/g, "").length !== 8}
              style={{
                ...styles.pairButton,
                opacity: inputCode.replace(/-/g, "").length === 8 ? 1 : 0.5,
              }}
            >
              Pair
            </button>
          </div>

          <div style={styles.dividerText}>or</div>

          <button
            type="button"
            onClick={handleGenerateCode}
            style={styles.generateButton}
          >
            Create new pair
          </button>
        </div>
        <footer style={styles.footer}>
          <Link href="/about" style={styles.footerLink}>
            About
          </Link>
        </footer>
        {debugPanel}
      </main>
    );
  }

  if (appState === "waiting") {
    return (
      <main style={styles.page}>
        <div style={styles.centerWrap}>
          <Image
            src="/heart-cookie.png"
            alt="Heart cookie"
            width={160}
            height={160}
            priority
            style={{ opacity: 0.5 }}
          />

          <div style={styles.waitingSection}>
            <div style={styles.waitingLabel}>Share this code with your person</div>
            <div style={styles.codeDisplay}>{formatCode(pairCode)}</div>
            <div style={styles.waitingHint}>Waiting for them to join...</div>
          </div>
        </div>
        <footer style={styles.footer}>
          <Link href="/about" style={styles.footerLink}>
            About
          </Link>
        </footer>
        {debugPanel}
      </main>
    );
  }

  // Ready state - main chomp interface
  return (
    <main style={styles.page}>
      <div style={styles.centerWrap}>
        <button
          type="button"
          onClick={handleChomp}
          onMouseDown={handleCookiePressStart}
          onMouseUp={handleCookiePressEnd}
          onMouseLeave={handleCookiePressEnd}
          onTouchStart={handleCookiePressStart}
          onTouchEnd={handleCookiePressEnd}
          onTouchCancel={handleCookiePressEnd}
          disabled={inOven || isSending}
          aria-disabled={inOven || isSending}
          style={{
            ...styles.heartButton,
            transform: isSending ? "scale(0.98)" : "scale(1)",
            opacity: inOven ? 0.7 : 1,
          }}
        >
          <Image
            src={inOven ? "/heart-cookie.png" : "/round-cookie.png"}
            alt="Cookie"
            width={240}
            height={240}
            priority
            style={styles.heartImage as React.CSSProperties}
          />
          {receivedRemaining > 0 ? (
            <Image
              src="/heart-cookie.png"
              alt="Received chomp"
              width={48}
              height={48}
              priority
              style={styles.receivedBadge as React.CSSProperties}
            />
          ) : null}
        </button>

        {/* Orientation dots - only shown when slot 2 exists */}
        {hasSlot2 && (
          <div style={styles.dotsContainer}>
            {/* Slot 1 dot */}
            <div style={styles.dotWrapper}>
              <div
                style={{
                  ...styles.dot,
                  ...(activeSlot === 1 ? styles.dotActive : styles.dotInactive),
                }}
              />
              {/* Ring around inactive dot if it has received */}
              {activeSlot === 2 && inactiveReceivedRemaining > 0 && (
                <div style={styles.dotRing} />
              )}
            </div>

            {/* Slot 2 dot */}
            <div style={styles.dotWrapper}>
              <div
                style={{
                  ...styles.dot,
                  ...(activeSlot === 2 ? styles.dotActive : styles.dotInactive),
                }}
              />
              {/* Ring around inactive dot if it has received */}
              {activeSlot === 1 && inactiveReceivedRemaining > 0 && (
                <div style={styles.dotRing} />
              )}
            </div>
          </div>
        )}

        {/* Slot switch toast */}
        {showSlotToast && (
          <div style={styles.slotToast}>another cooling</div>
        )}

        {/* One-time hint toast (tappable to go to pairing) */}
        {showHintToast && (
          <button
            type="button"
            onClick={handleHintToastTap}
            style={styles.hintToast}
          >
            another cooling
          </button>
        )}

        <div style={styles.statusWrap}>
          <div style={styles.status}>
            {inOven ? `in the oven • ${sentRemaining} seconds` : "Cooling"}
          </div>
          <div style={styles.lastChomp}>last chomp received: {lastChompRelative}</div>
        </div>
      </div>

      <footer style={styles.footer}>
        <Link href="/about" style={styles.footerLink}>
          About
        </Link>
      </footer>
      {debugPanel}
    </main>
  );
}

function formatCode(code: string): string {
  const clean = code.replace(/-/g, "").toUpperCase();
  if (clean.length <= 4) return clean;
  return `${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    background: "#ffffff",
    minHeight: "100vh",
    color: "#111",
    display: "flex",
    flexDirection: "column",
  },
  centerWrap: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px 18px",
    gap: 14,
  },
  heartButton: {
    border: "none",
    background: "transparent",
    padding: 0,
    cursor: "pointer",
    transition:
      "transform 120ms cubic-bezier(0.2, 0.0, 0.0, 1.0), opacity 120ms linear",
    position: "relative",
    WebkitTapHighlightColor: "transparent",
  },
  heartImage: {
    display: "block",
    userSelect: "none",
  },
  receivedBadge: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 48,
    height: 48,
    pointerEvents: "none",
  },
  statusWrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  },
  status: {
    fontSize: 14,
    opacity: 0.85,
  },
  lastChomp: {
    fontSize: 12,
    opacity: 0.55,
  },
  footer: {
    padding: "16px 18px",
    display: "flex",
    justifyContent: "center",
  },
  footerLink: {
    fontSize: 13,
    opacity: 0.7,
    textDecoration: "none",
    color: "inherit",
  },
  footerSep: {
    fontSize: 13,
    opacity: 0.4,
    margin: "0 8px",
  },
  debugPanel: {
    borderTop: "1px solid rgba(0, 0, 0, 0.1)",
    padding: "12px 18px 20px",
    fontSize: 12,
    background: "#fafafa",
    color: "#222",
  },
  debugTitle: {
    fontWeight: 600,
    marginBottom: 6,
  },
  debugBody: {
    whiteSpace: "pre-wrap",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    opacity: 0.8,
  },
  installHint: {
    fontSize: 12,
    opacity: 0.6,
    textAlign: "center",
    maxWidth: 240,
    marginTop: 8,
  },
  pairSection: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    marginTop: 24,
  },
  pairLabel: {
    fontSize: 14,
    opacity: 0.75,
  },
  pairInput: {
    fontSize: 20,
    fontFamily: "monospace",
    textAlign: "center",
    padding: "12px 16px",
    border: "1px solid rgba(0,0,0,0.15)",
    borderRadius: 8,
    outline: "none",
    width: 180,
    letterSpacing: 2,
  },
  pairButton: {
    fontSize: 14,
    padding: "10px 24px",
    border: "1px solid rgba(0,0,0,0.2)",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
  },
  dividerText: {
    fontSize: 12,
    opacity: 0.5,
    margin: "16px 0",
  },
  generateButton: {
    fontSize: 14,
    padding: "10px 20px",
    border: "none",
    borderRadius: 6,
    background: "rgba(0,0,0,0.06)",
    cursor: "pointer",
  },
  waitingSection: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    marginTop: 24,
  },
  waitingLabel: {
    fontSize: 14,
    opacity: 0.75,
  },
  codeDisplay: {
    fontSize: 28,
    fontFamily: "monospace",
    letterSpacing: 3,
    padding: "16px 24px",
    background: "rgba(0,0,0,0.03)",
    borderRadius: 8,
  },
  waitingHint: {
    fontSize: 12,
    opacity: 0.5,
    marginTop: 8,
  },
  // Orientation dots styles
  dotsContainer: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginTop: 8,
  },
  dotWrapper: {
    position: "relative",
    width: 10,
    height: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: "50%",
    transition: "opacity 150ms ease, background-color 150ms ease",
  },
  dotActive: {
    backgroundColor: "#111",
    opacity: 0.7,
  },
  dotInactive: {
    backgroundColor: "transparent",
    border: "1px solid rgba(0, 0, 0, 0.3)",
    opacity: 0.5,
  },
  dotRing: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: "50%",
    border: "1px solid rgba(0, 0, 0, 0.4)",
    opacity: 0.4,
    pointerEvents: "none",
    animation: "fadeIn 150ms ease",
  },
  slotToast: {
    position: "absolute",
    bottom: 180,
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: 13,
    opacity: 0.7,
    padding: "8px 16px",
    background: "rgba(0, 0, 0, 0.05)",
    borderRadius: 6,
    pointerEvents: "none",
  },
  hintToast: {
    position: "absolute",
    bottom: 180,
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: 13,
    opacity: 0.7,
    padding: "8px 16px",
    background: "rgba(0, 0, 0, 0.05)",
    borderRadius: 6,
    border: "none",
    cursor: "pointer",
    color: "inherit",
  },
};

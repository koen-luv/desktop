/**
 * Listen-party flows: invite/answer handshakes, phase transitions, teardown.
 *
 * No server exists anywhere in this file — only RTCPeerConnection objects
 * (via PartyConnection) wired into the store. Codes travel out of band
 * (share sheet / clipboard / any chat app the users already have).
 */
import { createTranslatorSync, getStoredLocale } from "@/languages";
import { useAuthStore } from "@/features/auth";
import { PartyConnection, type PartyMessage } from "./partySession";
import { usePartyStore } from "./store/partyStore";
import { broadcastHostState } from "./hooks/usePartySync";

/**
 * ICE either establishes within a few seconds or never will (STUN-only, no
 * TURN relay), so a handshake still closed after this is dead.
 */
const CONNECT_TIMEOUT_MS = 25_000;

/** Host: the single unanswered invite — an SDP offer is answerable once. */
let pendingHostId: string | null = null;
let hostTimer: number | null = null;
let guestTimer: number | null = null;

function tr(key: string, vars?: Record<string, string | number>): string {
  return createTranslatorSync(getStoredLocale())(key, vars);
}

function clearHostTimer(): void {
  if (hostTimer !== null) window.clearTimeout(hostTimer);
  hostTimer = null;
}

function clearGuestTimer(): void {
  if (guestTimer !== null) window.clearTimeout(guestTimer);
  guestTimer = null;
}

function ownName(): string {
  const user = useAuthStore.getState().user;
  return user?.displayName || user?.username || tr("party.guest_default_name");
}

/** Guest failure: end the attempt outright so the control lock can't stick. */
function failGuest(message: string): void {
  const store = usePartyStore.getState();
  store.reset();
  usePartyStore.setState({ phase: "error", error: message });
}

/** Host failure: local only — any connected guests keep playing. */
function failHost(message: string): void {
  usePartyStore.setState({ phase: "error", error: message });
}

// --- Host -----------------------------------------------------------------

/** Host: start (or restart) the invite flow. Replaces any unanswered invite. */
export function startHostParty(): void {
  const store = usePartyStore.getState();
  if (store.role === "guest") return;
  clearHostTimer();

  if (pendingHostId) {
    const stale = store.hostConnections.get(pendingHostId);
    store.hostConnections.delete(pendingHostId);
    stale?.close();
    pendingHostId = null;
  }

  usePartyStore.setState({
    role: "host",
    phase: "creating-invite",
    code: null,
    answerInput: "",
    error: null,
  });

  const id = `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let conn: PartyConnection;
  try {
    conn = new PartyConnection(
      {
        onOpen: () => onHostOpen(id, conn),
        onMessage: (message) => onHostMessage(id, message),
        onClose: () => onHostClose(id),
      },
      true,
    );
  } catch {
    failHost(tr("party.error_unsupported"));
    return;
  }

  store.hostConnections.set(id, conn);
  pendingHostId = id;

  conn
    .createInviteCode()
    .then((code) => {
      // A newer invite may have superseded this one while ICE gathered.
      if (pendingHostId !== id) return;
      usePartyStore.setState({ phase: "invite-ready", code });
    })
    .catch(() => {
      if (pendingHostId === id) pendingHostId = null;
      usePartyStore.getState().hostConnections.delete(id);
      conn.close();
      failHost(tr("party.error_invite_failed"));
    });
}

function onHostOpen(id: string, conn: PartyConnection): void {
  clearHostTimer();
  if (pendingHostId === id) pendingHostId = null;
  const store = usePartyStore.getState();
  // Discarded while gathering (a newer invite replaced it) — ignore.
  if (store.hostConnections.get(id) !== conn) return;

  usePartyStore.setState({
    phase: "connected",
    error: null,
    guests: [...store.guests, { id, name: tr("party.guest_default_name") }],
  });
  conn.send({ t: "hello", name: ownName() });
  // Push full state immediately so the guest starts synced, not after 5s.
  broadcastHostState();
}

function onHostMessage(id: string, message: PartyMessage): void {
  if (message.t === "hello") {
    const store = usePartyStore.getState();
    usePartyStore.setState({
      guests: store.guests.map((g) =>
        g.id === id ? { ...g, name: message.name } : g,
      ),
    });
    return;
  }
  // "bye" just precedes the channel closing; state belongs to guests (no
  // subscribers exist on the host, so this is a harmless no-op).
  usePartyStore.getState().emitMessage(message);
}

function onHostClose(id: string): void {
  const store = usePartyStore.getState();
  const wasPending = pendingHostId === id;
  if (wasPending) {
    pendingHostId = null;
    clearHostTimer();
  }
  store.hostConnections.delete(id);
  const guests = store.guests.filter((g) => g.id !== id);

  if (wasPending) {
    // The handshake never completed (ICE failed or the guest gave up).
    usePartyStore.setState({
      guests,
      phase: "error",
      error: tr("party.error_connect_failed"),
    });
    return;
  }

  // A connected guest dropped — keep the party (and any pending invite) as-is.
  const keep = guests.length > 0 || pendingHostId !== null;
  usePartyStore.setState({
    guests,
    phase: keep ? store.phase : "idle",
    code: keep ? store.code : null,
    error: keep ? store.error : null,
  });
}

/** Host: apply the pasted reply; the channel opens once ICE connects. */
export async function submitHostAnswer(): Promise<void> {
  const store = usePartyStore.getState();
  const answer = store.answerInput.trim();
  const connId = pendingHostId;
  if (!answer || !connId) return;
  const conn = store.hostConnections.get(connId);
  if (!conn) return;

  clearHostTimer();
  usePartyStore.setState({ phase: "connecting", error: null });

  try {
    await conn.acceptAnswerCode(answer);
  } catch {
    // Decode failed → the offer was never consumed; the invite stays usable.
    usePartyStore.setState({
      phase: "invite-ready",
      error: tr("party.error_invalid_code"),
    });
    return;
  }

  hostTimer = window.setTimeout(() => {
    if (conn.isOpen) return;
    if (pendingHostId === connId) pendingHostId = null;
    const st = usePartyStore.getState();
    st.hostConnections.delete(connId);
    st.setAnswerInput("");
    conn.close();
    failHost(tr("party.error_timeout"));
  }, CONNECT_TIMEOUT_MS);
}

// --- Guest ----------------------------------------------------------------

/** Guest: consume a pasted invite; the reply code comes back for sharing. */
export async function joinParty(inviteCode: string): Promise<void> {
  const code = inviteCode.trim();
  clearGuestTimer();
  usePartyStore.getState().reset();
  usePartyStore.setState({
    role: "guest",
    phase: code ? "joining" : "error",
    pendingInvite: code,
    error: code ? null : tr("party.error_empty_invite"),
  });
  if (!code) return;

  let conn: PartyConnection;
  try {
    conn = new PartyConnection(
      {
        onOpen: () => {
          clearGuestTimer();
          conn.send({ t: "hello", name: ownName() });
          usePartyStore.setState({ phase: "connected", error: null });
        },
        onMessage: (message) => usePartyStore.getState().emitMessage(message),
        onClose: (reason) => {
          if (reason === "local") return;
          failGuest(
            tr(
              reason === "failed"
                ? "party.error_connect_failed"
                : "party.error_host_left",
            ),
          );
        },
      },
      false,
    );
  } catch {
    failGuest(tr("party.error_unsupported"));
    return;
  }

  usePartyStore.setState({ guestConnection: conn });

  try {
    const answer = await conn.createAnswerCode(code);
    usePartyStore.setState({ phase: "answer-ready", code: answer });
    // The host may never paste the reply — don't wait forever.
    guestTimer = window.setTimeout(() => {
      if (conn.isOpen) return;
      failGuest(tr("party.error_timeout"));
    }, CONNECT_TIMEOUT_MS);
  } catch {
    failGuest(tr("party.error_invalid_code"));
  }
}

// --- Shared ---------------------------------------------------------------

/** Leave (or abandon) the current session and close the sheet. */
export function leaveParty(): void {
  clearHostTimer();
  clearGuestTimer();
  const store = usePartyStore.getState();
  store.reset();
  store.setOpen(false);
}

/** Leave the error screen: guests always end; hosts keep whatever is healthy. */
export function dismissPartyError(): void {
  const store = usePartyStore.getState();
  if (store.role === "guest") {
    store.reset();
    return;
  }
  const hosting = store.guests.length > 0;
  usePartyStore.setState({
    phase: hosting ? "connected" : "idle",
    code: null,
    error: null,
  });
}

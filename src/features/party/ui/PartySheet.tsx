import { useEffect, useState } from "react";
import Button from "@/shared/ui/Button";
import Dialog from "@/shared/ui/Dialog";
import { showToast } from "@/shared/ui";
import { useTranslation, type TFunction } from "@/languages";
import { nativeCopy, nativeShare } from "@/platform";
import {
  CheckLine,
  CloseLine,
  Copy2Line,
  Group2Line,
  Share2Line,
} from "@mingcute/react";
import { usePartyStore, type PartyGuestInfo } from "../store/partyStore";
import {
  dismissPartyError,
  joinParty,
  leaveParty,
  startHostParty,
  submitHostAnswer,
} from "../partyController";

const font = { fontFamily: "var(--font-inter), sans-serif" } as const;

const codeBoxClass =
  "w-full resize-none rounded-md border border-border-primary bg-bg-primary px-[12px] py-[10px] font-mono text-[12px] leading-[1.5] text-text-primary outline-none select-all";
const inputClass =
  "w-full resize-none rounded-md border border-border-primary bg-bg-primary px-[14px] py-[10px] font-mono text-[13px] text-text-primary placeholder:text-text-tertiary outline-none transition-[border-color] duration-150 focus:border-text-secondary";

async function copyText(text: string, t: TFunction): Promise<void> {
  let ok = nativeCopy(text);
  if (!ok && typeof navigator !== "undefined" && navigator.clipboard) {
    ok = await navigator.clipboard
      .writeText(text)
      .then(() => true)
      .catch(() => false);
  }
  showToast(
    ok ? t("party.copied") : t("party.copy_failed"),
    ok ? "checkmark" : "error",
  );
}

function SpinnerRow({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-[9px] rounded-lg border border-border-primary bg-bg-primary px-[12px] py-[11px] text-[13px] text-text-secondary"
      style={font}
    >
      <span className="h-[14px] w-[14px] shrink-0 animate-spin rounded-full border-2 border-text-secondary border-t-transparent" />
      {label}
    </div>
  );
}

function StepLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`text-[12px] font-[500] text-text-secondary ${className}`}
      style={font}
    >
      {children}
    </span>
  );
}

function CodeBox({ value }: { value: string }) {
  return (
    <textarea
      readOnly
      rows={5}
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      className={codeBoxClass}
      style={font}
    />
  );
}

function ShareCopyRow({ text }: { text: string }) {
  const { t } = useTranslation();
  const doShare = () => {
    if (nativeShare(text)) return;
    if (typeof navigator !== "undefined" && navigator.share) {
      // A dismissed share sheet is not an error — the copy button is right
      // next to it, so swallow and move on.
      void navigator.share({ text }).catch(() => undefined);
      return;
    }
    void copyText(text, t);
  };
  return (
    <div className="flex gap-[8px]">
      <Button
        type="button"
        variant="primary"
        size="sm"
        className="flex-1"
        onClick={doShare}
      >
        <Share2Line size={15} />
        {t("party.share")}
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => void copyText(text, t)}
      >
        <Copy2Line size={15} />
        {t("party.copy")}
      </Button>
    </div>
  );
}

function GuestList({ guests }: { guests: PartyGuestInfo[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-[6px] rounded-lg border border-border-primary bg-bg-primary px-[12px] py-[9px]">
      <span
        className="text-[12px] font-[500] text-text-secondary"
        style={font}
      >
        {t("party.listening_count", { count: guests.length })}
      </span>
      {guests.map((guest) => (
        <div
          key={guest.id}
          className="flex items-center gap-[8px] text-[13px] text-text-primary"
          style={font}
        >
          <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-accent-primary" />
          <span className="truncate">{guest.name}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Listen-party sheet. Session state lives in the party store/controller, so
 * closing the dialog never interrupts a running party.
 */
export function PartySheet() {
  const { t } = useTranslation();
  const open = usePartyStore((s) => s.open);
  const setOpen = usePartyStore((s) => s.setOpen);
  const role = usePartyStore((s) => s.role);
  const phase = usePartyStore((s) => s.phase);
  const code = usePartyStore((s) => s.code);
  const error = usePartyStore((s) => s.error);
  const guests = usePartyStore((s) => s.guests);
  const answerInput = usePartyStore((s) => s.answerInput);
  const setAnswerInput = usePartyStore((s) => s.setAnswerInput);

  // The join paste box stays component-local: it survives sheet toggles
  // without being worth a store field.
  const [inviteInput, setInviteInput] = useState("");
  const [joinForm, setJoinForm] = useState(false);

  useEffect(() => {
    if (phase === "idle") setJoinForm(false);
    else if (phase === "joining") setInviteInput("");
  }, [phase]);

  const subtitle =
    role === "host"
      ? t("party.host_subtitle")
      : role === "guest"
        ? t("party.guest_subtitle")
        : t("party.subtitle");

  let body: React.ReactNode;
  if (phase === "error") {
    body = (
      <div className="flex flex-col gap-[12px]">
        <div className="flex items-start gap-[9px] rounded-lg border border-accent-primary/20 bg-accent-primary/10 px-[12px] py-[11px] text-[13px] leading-[1.45] text-text-primary" style={font}>
          <CloseLine size={16} className="mt-[1px] shrink-0 text-accent-primary" />
          <span>{error}</span>
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="w-full"
          onClick={dismissPartyError}
        >
          {t("common.back")}
        </Button>
      </div>
    );
  } else if (phase === "idle") {
    body = (
      <div className="flex flex-col gap-[12px]">
        <p
          className="m-0 text-[13px] leading-[1.5] text-text-secondary"
          style={font}
        >
          {t("party.description")}
        </p>
        {!joinForm ? (
          <div className="flex flex-col gap-[8px]">
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="w-full"
              onClick={startHostParty}
            >
              <Group2Line size={16} />
              {t("party.start")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => setJoinForm(true)}
            >
              <Share2Line size={16} />
              {t("party.join")}
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-[10px]"
            onSubmit={(e) => {
              e.preventDefault();
              void joinParty(inviteInput);
            }}
          >
            <textarea
              autoFocus
              rows={4}
              placeholder={t("party.invite_placeholder")}
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              className={inputClass}
              style={font}
            />
            <div className="flex justify-end gap-[8px]">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setJoinForm(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!inviteInput.trim()}
              >
                {t("party.continue")}
              </Button>
            </div>
          </form>
        )}
      </div>
    );
  } else if (role === "host") {
    body = (
      <div className="flex flex-col gap-[12px]">
        {phase === "creating-invite" && (
          <SpinnerRow label={t("party.creating_invite")} />
        )}

        {phase === "invite-ready" && code && (
          <div className="flex flex-col gap-[8px]">
            <StepLabel>{t("party.step_share_invite")}</StepLabel>
            <CodeBox value={code} />
            <ShareCopyRow text={code} />
            <StepLabel className="mt-[6px]">
              {t("party.step_paste_reply")}
            </StepLabel>
            <textarea
              rows={4}
              placeholder={t("party.reply_placeholder")}
              value={answerInput}
              onChange={(e) => setAnswerInput(e.target.value)}
              className={inputClass}
              style={font}
            />
            {error && (
              <span className="text-[12px] text-accent-primary" style={font}>
                {error}
              </span>
            )}
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="w-full"
              disabled={!answerInput.trim()}
              onClick={() => void submitHostAnswer()}
            >
              {t("party.connect")}
            </Button>
          </div>
        )}

        {phase === "connecting" && (
          <SpinnerRow label={t("party.connecting")} />
        )}

        {phase === "connected" && (
          <div
            className="flex items-center gap-[8px] rounded-lg border border-border-primary bg-bg-primary px-[12px] py-[10px] text-[13px] text-text-secondary"
            style={font}
          >
            <CheckLine size={16} className="shrink-0 text-accent-primary" />
            {t("party.host_subtitle")}
          </div>
        )}

        {guests.length > 0 && <GuestList guests={guests} />}

        {phase === "connected" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={startHostParty}
          >
            <Group2Line size={15} />
            {t("party.invite_another")}
          </Button>
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={leaveParty}
        >
          {t("party.leave")}
        </Button>
      </div>
    );
  } else {
    // Guest: joining → answer-ready → connected.
    body = (
      <div className="flex flex-col gap-[12px]">
        {phase === "joining" && <SpinnerRow label={t("party.reading_invite")} />}

        {phase === "answer-ready" && code && (
          <div className="flex flex-col gap-[8px]">
            <StepLabel>{t("party.step_send_reply")}</StepLabel>
            <CodeBox value={code} />
            <ShareCopyRow text={code} />
            <p className="m-0 text-[12px] text-text-tertiary" style={font}>
              {t("party.waiting_hint")}
            </p>
          </div>
        )}

        {phase === "connecting" && (
          <SpinnerRow label={t("party.connecting")} />
        )}

        {phase === "connected" && (
          <div
            className="flex items-center gap-[8px] rounded-lg border border-border-primary bg-bg-primary px-[12px] py-[10px] text-[13px] text-text-primary"
            style={font}
          >
            <CheckLine size={16} className="shrink-0 text-accent-primary" />
            {t("party.synced_hint")}
          </div>
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={leaveParty}
        >
          {t("party.leave")}
        </Button>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen} maxWidth={440} className="pt-[18px]">
      <div className="flex flex-col gap-[14px] px-[20px] pb-[16px]">
        <div className="flex items-start justify-between gap-[10px]">
          <div className="flex min-w-0 items-center gap-[10px]">
            <span className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-border-alpha-14 text-text-secondary">
              <Group2Line size={18} />
            </span>
            <div className="min-w-0">
              <h2
                className="m-0 text-[17px] font-[500] text-text-primary"
                style={font}
              >
                {t("party.title")}
              </h2>
              <p
                className="m-0 mt-[1px] truncate text-[12px] text-text-tertiary"
                style={font}
              >
                {subtitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => setOpen(false)}
            className="inline-flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-md border-none bg-transparent text-text-tertiary transition-colors hover:bg-border-alpha-14 hover:text-text-primary cursor-pointer"
          >
            <CloseLine size={16} />
          </button>
        </div>
        {body}
      </div>
    </Dialog>
  );
}

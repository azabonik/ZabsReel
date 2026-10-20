// The web shell's in-app approval dialog (platform.ts reviewInPage): "Allow
// media from \\nas?", the Keep dialog for a server added outside ZedMix,
// or only "couldn't read its list". The page shows it and the shell writes the
// store; Electron shows the same wording in a native dialog instead.
//
// An alertdialog: focus starts on the default button (Keep offline, Remove),
// Tab stays inside, Esc answers with the default, and focus goes back to the
// control that opened it. No key reaches the editor's shortcuts meanwhile.
import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PendingReview } from "./platform";
import { Alert } from "./icons";
import "./networkcomputers.css";

export function ReviewDialog({ review }: { review: PendingReview }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const answer = review.resolve;

  // Focus the default button; give focus back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    firstRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // A key whose target is outside the dialog (focus dropped on <body>) must
  // not reach the editor either: Esc answers, anything else refocuses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogRef.current?.contains(e.target as Node)) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.key === "Escape") answer(false);
      else firstRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [answer]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      answer(false);
      return;
    }
    if (e.key !== "Tab") return;
    const buttons = [...(dialogRef.current?.querySelectorAll("button") ?? [])];
    if (!buttons.length) return;
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.shiftKey ? (i <= 0 ? buttons.length - 1 : i - 1) : (i + 1) % buttons.length;
    e.preventDefault();
    buttons[next].focus();
  };

  const detail = review.kind === "unread" ? [] : review.text.detail.split("\n\n");
  return (
    <>
      <div className="scrim" />
      <div
        ref={dialogRef}
        className="session-notice review-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="review-title"
        aria-describedby="review-detail"
        onKeyDown={onKeyDown}
      >
        <h3 id="review-title"><Alert size={16} /> {review.text.title}</h3>
        <div id="review-detail">
          <p className="review-message">{review.text.message}</p>
          {detail.map((p, i) => <p key={i}>{p}</p>)}
        </div>
        <div className="review-actions">
          {review.kind === "unread" ? (
            <button ref={firstRef} className="btn" onClick={() => answer(false)}>OK</button>
          ) : (
            <>
              <button ref={firstRef} className="btn" onClick={() => answer(false)}>{review.text.buttons[0]}</button>
              <button className="btn btn-primary" onClick={() => answer(true)}>{review.text.buttons[1]}</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

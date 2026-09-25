import { FileUp, Link2 } from "lucide-react";
import { useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { APP_NAME } from "../../shared/brand";
import { formatBytes, type Limits } from "../../shared/config";
import type { ConfigResponse } from "../../shared/contracts";
import type { OpenStage } from "../document/openDocument";
import type { StoredDocumentMeta } from "../storage/db";

export interface ImportScreenProps {
  limits: Limits;
  translation: ConfigResponse["translation"] | null;
  stage: OpenStage | null;
  error: string | null;
  notice: string | null;
  continueDoc: { meta: StoredDocumentMeta; pageIndex: number | null } | null;
  linkValue: string;
  onLinkChange(value: string): void;
  onOpenFile(file: File): void;
  onOpenLink(url: string): void;
  onOpenSample(): void;
  onContinue(): void;
  onClearData(): Promise<boolean>;
}

const STAGE_LABEL: Record<OpenStage, string> = {
  reading: "Reading file…",
  fetching: "Fetching paper…",
  opening: "Opening PDF…",
};

export function ImportScreen(props: ImportScreenProps) {
  const { limits, stage, error, notice, continueDoc } = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  const linkId = useId();
  const hintId = useId();
  const busy = stage !== null;

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = event.dataTransfer.files[0];
    if (file) props.onOpenFile(file);
  };

  const onSubmitLink = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && props.linkValue.trim()) props.onOpenLink(props.linkValue.trim());
  };

  const privacy =
    props.translation && props.translation.available && props.translation.location === "local"
      ? "Your PDF stays in this browser. Translation runs on a model on this computer; selected text never leaves it."
      : "Your PDF stays in this browser. When you translate, only the selected text and a little surrounding context are sent to the translation service.";

  return (
    <div className="import" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <header className="import-top">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            {APP_NAME.charAt(0)}
          </span>
          {APP_NAME}
        </span>
      </header>

      <main className="import-main">
        <h1>Read papers across languages</h1>
        <p className="import-lede">Open a paper and translate the passages you select.</p>

        <div
          className={`dropzone${dragging ? " is-dragging" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = busy ? "none" : "copy";
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={onDrop}
        >
          <p className="dropzone-title">Drop a PDF here</p>
          <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={busy}>
            <FileUp size={16} aria-hidden="true" />
            Upload PDF
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) props.onOpenFile(file);
            }}
          />
          <p className="dropzone-hint">
            Text-based PDFs up to {formatBytes(limits.maxFileBytes)} and {limits.maxPages} pages
          </p>
        </div>

        <div className="or-divider">or</div>

        <form className="link-form" onSubmit={onSubmitLink}>
          <label htmlFor={linkId}>Paste paper link</label>
          <div className="link-row">
            <input
              id={linkId}
              className="text-input"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://arxiv.org/abs/… or a direct PDF link"
              value={props.linkValue}
              onChange={(event) => props.onLinkChange(event.target.value)}
              aria-describedby={hintId}
              disabled={busy}
            />
            <button type="submit" className="btn" disabled={busy || !props.linkValue.trim()}>
              <Link2 size={16} aria-hidden="true" />
              Open paper
            </button>
          </div>
          <p id={hintId} className="field-hint">
            Works with arXiv abstract or PDF pages and public links that return a PDF. Pages behind a login or paywall won't open.
          </p>
        </form>

        <div aria-live="polite">
          {stage && (
            <div className="status-line" role="status">
              <span className="spinner" aria-hidden="true" />
              {STAGE_LABEL[stage]}
            </div>
          )}
        </div>
        <div aria-live="assertive">
          {error && !stage && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </div>
        {notice && !stage && !error && <div className="notice-box">{notice}</div>}

        {continueDoc && (
          <section className="panel continue" aria-label="Continue reading">
            <div className="continue-text">
              <p className="continue-label">Continue reading</p>
              <p className="continue-title" title={continueDoc.meta.title}>
                {continueDoc.meta.title}
              </p>
              <p className="continue-meta">
                {continueDoc.pageIndex !== null
                  ? `Page ${continueDoc.pageIndex + 1} of ${continueDoc.meta.pageCount}`
                  : `${continueDoc.meta.pageCount} pages`}
              </p>
            </div>
            <button type="button" className="btn" onClick={props.onContinue} disabled={busy}>
              Continue
            </button>
          </section>
        )}

        <div className="import-secondary">
          <button type="button" className="btn-link" onClick={props.onOpenSample} disabled={busy}>
            Try a sample paper
          </button>
        </div>

        <footer className="import-footer">
          <p>{privacy}</p>
          <p>
            Your reading position and translations are saved in this browser only.{" "}
            {confirmClear ? (
              <span className="confirm-inline">
                Remove the saved paper and translations?
                <button
                  type="button"
                  className="btn-link"
                  onClick={async () => {
                    const ok = await props.onClearData();
                    setConfirmClear(false);
                    setCleared(ok ? "Saved data removed." : "Couldn't remove saved data in this browser.");
                  }}
                >
                  Remove
                </button>
                <button type="button" className="btn-link" onClick={() => setConfirmClear(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn-link"
                onClick={() => {
                  setCleared(null);
                  setConfirmClear(true);
                }}
              >
                Clear saved data
              </button>
            )}
            {cleared && (
              <span role="status" style={{ marginLeft: 8 }}>
                {cleared}
              </span>
            )}
          </p>
        </footer>
      </main>
    </div>
  );
}

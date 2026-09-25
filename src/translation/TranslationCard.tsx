import { Copy, RotateCw, X } from "lucide-react";
import { forwardRef, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { getTargetLanguage, SOURCE_LANGUAGE_NAMES, TARGET_LANGUAGES, type TargetLanguageCode } from "../../shared/languages";
import { copyText } from "../lib/clipboard";
import type { CardState } from "./controller";

export interface TranslationCardProps {
  card: CardState;
  sheet: boolean;
  style?: CSSProperties;
  /** True when the server runs the test-only mock provider. */
  mockProvider: boolean;
  onClose(): void;
  onRetry(): void;
  onTranslateAnyway(): void;
  onChooseLanguage(code: TargetLanguageCode): void;
  /** Reports the card's natural (unconstrained) height for placement. */
  onNaturalHeight(height: number): void;
}

const SOURCE_PREVIEW_CHARS = 220;

export const TranslationCard = forwardRef<HTMLDivElement, TranslationCardProps>(function TranslationCard(props, ref) {
  const { card } = props;
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const { onNaturalHeight } = props;

  useEffect(() => {
    setExpanded(false);
    setCopied(null);
  }, [card.snapshot.id]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  // Natural height = header + full body content + footer (the body may be scroll-limited).
  useEffect(() => {
    const measure = () => {
      const total =
        (headerRef.current?.offsetHeight ?? 0) + (contentRef.current?.offsetHeight ?? 0) + 14 + (footerRef.current?.offsetHeight ?? 0) + 2;
      onNaturalHeight(total);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of [headerRef.current, contentRef.current, footerRef.current]) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [onNaturalHeight, card.status]);

  const target = "targetLang" in card ? getTargetLanguage(card.targetLang) : null;
  const detected = card.snapshot.sourceLang ? SOURCE_LANGUAGE_NAMES[card.snapshot.sourceLang] : null;
  const sourceText = card.snapshot.text;
  const long = sourceText.length > SOURCE_PREVIEW_CHARS || sourceText.split("\n").length > 3;
  const isMock = card.status === "done" ? card.provider === "mock" : props.mockProvider;

  return (
    <div
      ref={ref}
      className={`card${props.sheet ? " is-sheet" : ""}`}
      style={props.style}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-status={card.status}
    >
      <div className="card-header" ref={headerRef}>
        <span id={titleId} className="card-lang">
          {target ? target.label : "Translation"}
        </span>
        {detected && target && <span className="card-lang-from">from {detected}</span>}
        {isMock && <span className="card-badge">Test mode · mock translation</span>}
        <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close translation" title="Close (Esc)">
          <X size={17} aria-hidden="true" />
        </button>
      </div>

      <div className="card-body">
        <div ref={contentRef}>
          <div className="card-source">
            <span className="visually-hidden">Original text: </span>
            <div className={`card-source-text${long && !expanded ? " is-clamped" : ""}`} lang={card.snapshot.sourceLang ?? undefined}>
              {sourceText}
            </div>
            {long && (
              <button type="button" className="btn-link" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
                {expanded ? "Show less" : "Show full selection"}
              </button>
            )}
          </div>

          {(card.snapshot.excluded.furniture > 0 || card.snapshot.excluded.otherColumn > 0) && (
            <p className="card-warning">Page headers, page numbers, or text from the other column were left out of this selection.</p>
          )}
          {card.snapshot.unreliable === "some" && (
            <p className="card-warning">Some characters in this part of the PDF couldn't be read reliably, so the text above may differ from the page.</p>
          )}

          <CardBody {...props} target={target} />
        </div>
      </div>

      {card.status === "done" && (
        <div className="card-footer" ref={footerRef}>
          <button
            type="button"
            className="btn"
            onClick={async () => setCopied((await copyText(card.translation)) ? "ok" : "fail")}
          >
            <Copy size={15} aria-hidden="true" />
            Copy translation
          </button>
          <span className="copy-toast" role="status" aria-live="polite">
            {copied === "ok" ? "Copied" : copied === "fail" ? "Couldn't copy" : ""}
          </span>
          {card.cached && <span className="card-note">Saved translation</span>}
        </div>
      )}
      {card.status === "error" && (
        <div className="card-footer" ref={footerRef}>
          {card.error.retryable || card.error.code !== "not_configured" ? (
            <button type="button" className="btn" onClick={props.onRetry}>
              <RotateCw size={15} aria-hidden="true" />
              Retry
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
});

function CardBody(props: TranslationCardProps & { target: ReturnType<typeof getTargetLanguage> | null }) {
  const { card } = props;
  switch (card.status) {
    case "need-language":
      return (
        <div>
          <p className="card-info">Choose the language to translate into. You can change it any time from “Translate to”.</p>
          <div className="lang-grid">
            {TARGET_LANGUAGES.map((language) => (
              <button key={language.code} type="button" className="btn" onClick={() => props.onChooseLanguage(language.code)}>
                {language.label}
                {language.nativeLabel !== language.label && <span className="native">{language.nativeLabel}</span>}
              </button>
            ))}
          </div>
        </div>
      );
    case "same-language":
      return (
        <div>
          <p className="card-info">
            This passage already appears to be in {props.target?.label ?? "the selected language"}. Choose another language, or translate
            it anyway.
          </p>
          <div className="lang-grid">
            {TARGET_LANGUAGES.filter((language) => language.code !== card.targetLang).map((language) => (
              <button key={language.code} type="button" className="btn" onClick={() => props.onChooseLanguage(language.code)}>
                {language.label}
              </button>
            ))}
          </div>
          <p style={{ margin: "10px 0 0" }}>
            <button type="button" className="btn-link" onClick={props.onTranslateAnyway}>
              Translate anyway
            </button>
          </p>
        </div>
      );
    case "loading":
      return (
        <div aria-busy="true">
          {card.partial ? (
            <p className="card-translation is-partial" lang={langAttr(card.targetLang)}>
              {card.partial}
            </p>
          ) : (
            <div className="skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          )}
          <p className="card-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Translating…
          </p>
        </div>
      );
    case "done":
      return (
        <p className="card-translation" lang={langAttr(card.targetLang)} role="status" aria-live="polite" aria-atomic="true">
          {card.translation}
        </p>
      );
    case "error":
      return (
        <p className="card-error" role="alert">
          {card.error.message}
        </p>
      );
  }
}

function langAttr(code: TargetLanguageCode): string {
  return code === "zh-Hans" ? "zh-Hans" : code;
}

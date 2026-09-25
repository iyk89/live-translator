import { ArrowLeft, ChevronLeft, ChevronRight, Minus, MoveHorizontal, Plus } from "lucide-react";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { TARGET_LANGUAGES, isTargetLanguageCode, type TargetLanguageCode } from "../../shared/languages";
import { MAX_ZOOM, MIN_ZOOM } from "./layout";

export interface ToolbarProps {
  title: string;
  pageIndex: number;
  pageCount: number;
  zoom: number;
  fitWidth: boolean;
  targetLang: TargetLanguageCode | null;
  onBack(): void;
  onGoToPage(pageIndex: number): void;
  onZoomStep(direction: 1 | -1): void;
  onFitWidth(): void;
  onTargetLang(code: TargetLanguageCode): void;
}

export function Toolbar(props: ToolbarProps) {
  const { pageIndex, pageCount } = props;
  const [pageText, setPageText] = useState(String(pageIndex + 1));
  const pageInputId = useId();
  const langId = useId();

  useEffect(() => setPageText(String(pageIndex + 1)), [pageIndex]);

  const commitPage = () => {
    const value = Number.parseInt(pageText, 10);
    if (Number.isFinite(value)) {
      const clamped = Math.min(pageCount, Math.max(1, value));
      props.onGoToPage(clamped - 1);
      setPageText(String(clamped));
    } else {
      setPageText(String(pageIndex + 1));
    }
  };

  const onPageKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitPage();
      (event.target as HTMLInputElement).select();
    } else if (event.key === "Escape") {
      setPageText(String(pageIndex + 1));
    }
  };

  return (
    <header className="toolbar" role="toolbar" aria-label="Reader">
      <button type="button" className="icon-btn" onClick={props.onBack} aria-label="Open another paper" title="Open another paper">
        <ArrowLeft size={18} aria-hidden="true" />
      </button>
      <div className="toolbar-title" title={props.title}>
        {props.title}
      </div>

      <div className="toolbar-group" aria-label="Pages">
        <button
          type="button"
          className="icon-btn page-step"
          onClick={() => props.onGoToPage(pageIndex - 1)}
          disabled={pageIndex <= 0}
          aria-label="Previous page"
          title="Previous page"
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <label htmlFor={pageInputId} className="visually-hidden">
          Page number
        </label>
        <input
          id={pageInputId}
          className="page-input"
          inputMode="numeric"
          value={pageText}
          onChange={(event) => setPageText(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
          onKeyDown={onPageKey}
          onBlur={commitPage}
          onFocus={(event) => event.target.select()}
        />
        <span className="page-total" aria-label={`of ${pageCount} pages`}>
          / {pageCount}
        </span>
        <button
          type="button"
          className="icon-btn page-step"
          onClick={() => props.onGoToPage(pageIndex + 1)}
          disabled={pageIndex >= pageCount - 1}
          aria-label="Next page"
          title="Next page"
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>

      <span className="toolbar-sep" aria-hidden="true" />

      <div className="toolbar-group zoom-group" aria-label="Zoom">
        <button
          type="button"
          className="icon-btn zoom-step"
          onClick={() => props.onZoomStep(-1)}
          disabled={props.zoom <= MIN_ZOOM + 0.001}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Minus size={17} aria-hidden="true" />
        </button>
        <span className="zoom-value" aria-live="polite" aria-label={`Zoom ${Math.round(props.zoom * 100)} percent`}>
          {Math.round(props.zoom * 100)}%
        </span>
        <button
          type="button"
          className="icon-btn zoom-step"
          onClick={() => props.onZoomStep(1)}
          disabled={props.zoom >= MAX_ZOOM - 0.001}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Plus size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn btn-quiet fit-btn"
          onClick={props.onFitWidth}
          aria-pressed={props.fitWidth}
          title="Fit to width"
        >
          <MoveHorizontal size={16} aria-hidden="true" />
          <span className="fit-label">Fit width</span>
          <span className="visually-hidden">(fit to width)</span>
        </button>
      </div>

      <span className="toolbar-sep" aria-hidden="true" />

      <div className="lang-select">
        <label htmlFor={langId} className="lang-select-label">
          Translate to
        </label>
        <select
          id={langId}
          className={props.targetLang ? "" : "is-unset"}
          value={props.targetLang ?? ""}
          aria-label="Translate to"
          onChange={(event) => {
            if (isTargetLanguageCode(event.target.value)) props.onTargetLang(event.target.value);
          }}
        >
          {!props.targetLang && (
            <option value="" disabled>
              Choose language
            </option>
          )}
          {TARGET_LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </select>
      </div>
    </header>
  );
}

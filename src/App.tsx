import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { APP_NAME } from "../shared/brand";
import type { TargetLanguageCode } from "../shared/languages";
import { openDocument, OpenError, type DocumentSource, type OpenedDocument, type OpenStage } from "./document/openDocument";
import { ImportScreen } from "./import/ImportScreen";
import { limitsFrom, useServerConfig } from "./lib/useServerConfig";

const Reader = lazy(() => import("./reader/Reader").then((module) => ({ default: module.Reader })));
import {
  clearAllData,
  loadCurrentDocumentMeta,
  loadDocumentBytes,
  loadPosition,
  saveCurrentDocument,
  type ReadingPosition,
  type StoredDocumentMeta,
} from "./storage/db";
import { loadTargetLanguage, saveTargetLanguage } from "./storage/settings";

interface Session {
  opened: OpenedDocument;
  position: ReadingPosition | null;
  storageNotice: string | null;
}

type Route = "import" | "read";

function routeFromHash(): Route {
  return window.location.hash.startsWith("#/read") ? "read" : "import";
}

export function App() {
  const serverConfig = useServerConfig();
  const limits = limitsFrom(serverConfig);
  const config = serverConfig.status === "ready" ? serverConfig.config : null;

  const [route, setRoute] = useState<Route>(routeFromHash);
  const [session, setSession] = useState<Session | null>(null);
  const [stage, setStage] = useState<OpenStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkValue, setLinkValue] = useState("");
  const [targetLang, setTargetLang] = useState<TargetLanguageCode | null>(loadTargetLanguage);
  const [saved, setSaved] = useState<{ meta: StoredDocumentMeta; pageIndex: number | null } | null>(null);
  const openCounter = useRef(0);
  const openAbort = useRef<AbortController | null>(null);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.title = route === "read" && session ? `${session.opened.meta.title} · ${APP_NAME}` : APP_NAME;
  }, [route, session]);

  const refreshSaved = useCallback(async () => {
    const meta = await loadCurrentDocumentMeta();
    if (!meta) {
      setSaved(null);
      return;
    }
    const position = await loadPosition(meta.fingerprint);
    setSaved({ meta, pageIndex: position?.pageIndex ?? null });
  }, []);

  useEffect(() => {
    if (route === "import") void refreshSaved();
  }, [route, refreshSaved]);

  const navigate = (next: Route) => {
    const hash = next === "read" ? "#/read" : "#/";
    if (window.location.hash !== hash) window.location.hash = hash;
    setRoute(next);
  };

  const open = useCallback(
    async (source: DocumentSource) => {
      const id = ++openCounter.current;
      openAbort.current?.abort();
      const abort = new AbortController();
      openAbort.current = abort;
      setError(null);
      setNotice(null);
      setStage(source.kind === "saved" ? "opening" : null);
      try {
        const opened = await openDocument(source, limits, (next) => id === openCounter.current && setStage(next), abort.signal);
        if (id !== openCounter.current) {
          await opened.destroy();
          return;
        }
        const position = await loadPosition(opened.meta.fingerprint);
        const previous = sessionRef.current;
        if (previous && previous.opened !== opened) void previous.opened.destroy();
        const next: Session = { opened, position, storageNotice: null };
        setSession(next);
        setStage(null);
        navigate("read");
        if (source.kind !== "saved") {
          const result = await saveCurrentDocument(opened.meta, opened.bytes);
          if (!result.ok && id === openCounter.current) {
            setSession((current) =>
              current?.opened === opened
                ? {
                    ...current,
                    storageNotice:
                      result.reason === "quota"
                        ? "This browser is out of storage space, so this paper won't be restored after a refresh. You can keep reading."
                        : "This browser isn't allowing Passage to save, so this paper won't be restored after a refresh. You can keep reading.",
                  }
                : current,
            );
          }
        }
      } catch (caught) {
        if (id !== openCounter.current || abort.signal.aborted) return;
        setStage(null);
        setError(caught instanceof OpenError ? caught.message : "Something went wrong while opening this paper. Please try again.");
      }
    },
    [limits],
  );

  // A refresh on the reader route reopens the saved paper at its saved position.
  const restoreAttempted = useRef(false);
  useEffect(() => {
    if (route !== "read" || session || restoreAttempted.current) return;
    restoreAttempted.current = true;
    void (async () => {
      const meta = await loadCurrentDocumentMeta();
      const bytes = meta ? await loadDocumentBytes(meta.fingerprint) : null;
      if (!meta || !bytes) {
        navigate("import");
        setNotice("Your last paper isn't saved in this browser. Open it again to continue.");
        return;
      }
      await open({ kind: "saved", meta, bytes });
    })();
  }, [route, session, open]);

  // The open paper counts as "available" even when the browser refused to save it.
  const continueDoc = saved ?? (session ? { meta: session.opened.meta, pageIndex: null } : null);

  const onContinue = async () => {
    if (session && (!saved || session.opened.meta.fingerprint === saved.meta.fingerprint)) {
      setSession({ ...session, position: await loadPosition(session.opened.meta.fingerprint) });
      navigate("read");
      return;
    }
    if (!saved) return;
    const bytes = await loadDocumentBytes(saved.meta.fingerprint);
    if (!bytes) {
      setError("The saved paper couldn't be loaded from this browser. Open the file again.");
      return;
    }
    await open({ kind: "saved", meta: saved.meta, bytes });
  };

  const onTargetLang = (code: TargetLanguageCode) => {
    setTargetLang(code);
    saveTargetLanguage(code);
  };

  if (route === "read" && session) {
    return (
      <Suspense fallback={<OpeningStatus label="Opening your paper…" />}>
        <Reader
        key={session.opened.meta.fingerprint + (session.position?.updatedAt ?? "")}
        opened={session.opened}
        initialPosition={session.position}
        config={config}
        maxSelectionChars={limits.maxSelectionChars}
        targetLang={targetLang}
        onTargetLang={onTargetLang}
        onBack={() => navigate("import")}
        storageNotice={session.storageNotice}
        />
      </Suspense>
    );
  }

  if (route === "read") {
    return <OpeningStatus label="Opening your paper…" />;
  }

  return (
    <ImportScreen
      limits={limits}
      translation={config?.translation ?? null}
      stage={stage}
      error={error}
      notice={notice ?? (serverConfig.status === "offline" ? "The Passage server isn't responding. Uploads still work; links and translation need the server." : null)}
      continueDoc={continueDoc}
      linkValue={linkValue}
      onLinkChange={setLinkValue}
      onOpenFile={(file) => void open({ kind: "file", file })}
      onOpenLink={(url) => void open({ kind: "link", url })}
      onOpenSample={() => void open({ kind: "sample" })}
      onContinue={() => void onContinue()}
      onClearData={async () => {
        const result = await clearAllData();
        if (result.ok) {
          // Forget the open paper too, so nothing is offered for "Continue reading".
          if (session) void session.opened.destroy();
          setSession(null);
          setSaved(null);
          setTargetLang(null);
          saveTargetLanguage(null);
        }
        return result.ok;
      }}
    />
  );
}

function OpeningStatus({ label }: { label: string }) {
  return (
    <div className="import">
      <div className="status-line" role="status" style={{ marginTop: "30vh" }}>
        <span className="spinner" aria-hidden="true" />
        {label}
      </div>
    </div>
  );
}

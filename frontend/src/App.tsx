import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  SunIcon,
  MoonIcon,
  ComputerDesktopIcon,
  ArrowUpTrayIcon,
  DocumentIcon,
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
  XMarkIcon,
  BookOpenIcon,
  MagnifyingGlassIcon,
  ArrowDownTrayIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
} from "@heroicons/react/24/outline";

const CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_PARALLEL = 3;

type Locale = "zh" | "en" | "cat";
type Theme = "system" | "light" | "dark";
type Page = "upload" | "library" | "view";

const THEME_CYCLE: Theme[] = ["system", "dark", "light"];
const THEME_ICONS: Record<Theme, typeof SunIcon> = {
  system: ComputerDesktopIcon,
  dark: MoonIcon,
  light: SunIcon,
};

interface TranslationSchema {
  title: string;
  description: string;
  supportHint: string;
  dragDropHint: string;
  fileCaptured: string;
  filesSelected: string;
  uploadButton: string;
  uploadAll: string;
  uploadingButton: string;
  uploadProgress: string;
  fileProgress: string;
  uploadCompleted: string;
  uploadSuccess: string;
  uploadError: string;
  chunkFailed: string;
  chooseLanguage: string;
  themeSystem: string;
  themeDark: string;
  themeLight: string;
  navUpload: string;
  navLibrary: string;
  navView: string;
  libraryTitle: string;
  libraryEmpty: string;
  libraryEmptyHint: string;
  librarySearch: string;
  libraryUpload: string;
  viewTitle: string;
  viewNotSelected: string;
  viewDownload: string;
  viewUnsupported: string;
  viewLoading: string;
  viewError: string;
}

const localeModules = import.meta.glob<{ default: TranslationSchema }>(
  "./locales/*.json",
);
const LOCALE_CACHE = new Map<Locale, TranslationSchema>();

async function loadLocale(locale: Locale): Promise<TranslationSchema> {
  const cached = LOCALE_CACHE.get(locale);
  if (cached) return cached;
  const loader = localeModules[`./locales/${locale}.json`];
  if (!loader) throw new Error(`Unknown locale: ${locale}`);
  const mod = await loader();
  LOCALE_CACHE.set(locale, mod.default as unknown as TranslationSchema);
  return mod.default as unknown as TranslationSchema;
}

const defaultLocale: Locale = navigator.language.startsWith("zh") ? "zh" : "en";

interface FileItem {
  id: string;
  file: File;
  progress: number;
  status: "pending" | "uploading" | "done" | "error";
}

function getSystemPref(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface ChunkTask {
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
  fileHash: string;
  chunkData: ArrayBuffer;
}

export default function App() {
  const [page, setPage] = useState<Page>("upload");
  const [theme, setTheme] = useState<Theme>("system");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  const [t, setT] = useState<TranslationSchema | null>(null);
  const [viewHash, setViewHash] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load locale
  useEffect(() => {
    loadLocale(locale).then(setT);
  }, [locale]);

  // Sync dark class to <html>
  useEffect(() => {
    const isDark = theme === "dark" || (theme === "system" && getSystemPref());
    document.documentElement.classList.toggle("dark", isDark);
  }, [theme]);

  // Listen to system preference changes when in "system" mode
  useEffect(() => {
    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      document.documentElement.classList.toggle("dark", mq.matches);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const cycleTheme = () => {
    setTheme((prev) => {
      const idx = THEME_CYCLE.indexOf(prev);
      return THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    });
  };

  const ThemeIcon = THEME_ICONS[theme];

  const addFiles = useCallback((fileList: FileList) => {
    const newItems: FileItem[] = Array.from(fileList).map((f) => ({
      id: crypto.randomUUID(),
      file: f,
      progress: 0,
      status: "pending" as const,
    }));
    setFiles((prev) => [...prev, ...newItems]);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
    }
    e.target.value = "";
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const uploadAll = async () => {
    setUploading(true);
    const apiBaseUrl = import.meta.env.VITE_API_URL;
    const pendingFiles = files.filter((f) => f.status !== "done");

    // 1. Mark all pending files as uploading
    setFiles((prev) =>
      prev.map((f) =>
        pendingFiles.some((p) => p.id === f.id)
          ? { ...f, status: "uploading" as const, progress: 0 }
          : f,
      ),
    );

    // 2. Pre-process: read buffers + SHA256 for ALL files upfront
    const tasks: ChunkTask[] = [];
    const fileProgress = new Map<string, { done: number; total: number }>();

    for (const item of pendingFiles) {
      const fileBuffer = await item.file.arrayBuffer();
      const fileHash = await sha256Hex(fileBuffer);
      const total = Math.ceil(item.file.size / CHUNK_SIZE);
      fileProgress.set(item.id, { done: 0, total });

      for (let i = 0; i < total; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, item.file.size);
        tasks.push({
          fileId: item.id,
          chunkIndex: i,
          totalChunks: total,
          fileHash,
          chunkData: fileBuffer.slice(start, end),
        });
      }
    }

    // 3. Global worker pool
    const GLOBAL_CONCURRENCY = MAX_PARALLEL * 2; // 6
    let nextIdx = 0;
    const totalChunks = tasks.length;
    const erroredFiles = new Set<string>();

    const worker = async () => {
      while (nextIdx < totalChunks) {
        const idx = nextIdx;
        nextIdx += 1;
        const task = tasks[idx];

        // Skip if this file already errored
        if (erroredFiles.has(task.fileId)) continue;

        const headers: Record<string, string> = {
          "X-File-Hash": task.fileHash,
          "X-Total-Chunks": String(task.totalChunks),
          "X-Chunk-Index": String(task.chunkIndex),
        };

        try {
          const res = await fetch(`${apiBaseUrl}/api/upload/chunk`, {
            method: "POST",
            headers,
            body: task.chunkData,
          });
          if (!res.ok) throw new Error(await res.text());

          // Update per-file progress
          const prog = fileProgress.get(task.fileId)!;
          prog.done += 1;
          const pct = Math.round((prog.done / prog.total) * 100);
          setFiles((prev) =>
            prev.map((f) =>
              f.id === task.fileId ? { ...f, progress: pct } : f,
            ),
          );
        } catch {
          erroredFiles.add(task.fileId);
        }
      }
    };

    // 4. Launch workers
    const workers = Array.from(
      { length: Math.min(GLOBAL_CONCURRENCY, totalChunks) },
      () => worker(),
    );
    await Promise.all(workers);

    // 5. Finalize: mark done / error
    setFiles((prev) =>
      prev.map((f) => {
        if (!pendingFiles.some((p) => p.id === f.id)) return f;
        if (erroredFiles.has(f.id)) return { ...f, status: "error" as const };
        return { ...f, status: "done" as const, progress: 100 };
      }),
    );

    setUploading(false);
  };

  const totalSizeMB =
    files.reduce((s, f) => s + f.file.size, 0) / (1024 * 1024);
  const hasFiles = files.length > 0;
  const allDone = hasFiles && files.every((f) => f.status === "done");

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200 transition-colors duration-200 flex flex-col items-center p-4 sm:p-6 font-sans antialiased">
      {!t ? (
        <div className="flex items-center justify-center py-40">
          <ArrowPathIcon className="w-6 h-6 animate-spin text-zinc-400" />
        </div>
      ) : (
        <div className="w-full max-w-lg">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-bold tracking-tight">{t.title}</h1>
              <p className="text-sm text-zinc-400 dark:text-zinc-500 mt-0.5">
                {t.description}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={cycleTheme}
                className="p-2 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                title={
                  theme === "system"
                    ? t.themeSystem
                    : theme === "dark"
                      ? t.themeDark
                      : t.themeLight
                }
              >
                <ThemeIcon className="w-5 h-5" />
              </button>
              <select
                value={locale}
                onChange={(e) => {
                  setLocale(e.target.value as Locale);
                }}
                className="text-xs rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="zh">中文</option>
                <option value="en">EN</option>
                <option value="cat">喵~</option>
              </select>
            </div>
          </div>

          {/* Navigation */}
          <NavBar
            page={page}
            onTabChange={(p) => {
              setPage(p);
              if (p !== "view") setViewHash(null);
            }}
            t={t}
          />

          {page === "upload" ? (
            <>
              {/* Drop Zone */}
              <div
                onClick={() => inputRef.current?.click()}
                className="relative rounded-2xl border-2 border-dashed p-12 text-center cursor-pointer transition-all duration-200 border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600 bg-zinc-50/50 dark:bg-zinc-900/50"
              >
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <div className="mb-3">
                  <ArrowUpTrayIcon className="w-10 h-10 mx-auto text-zinc-300 dark:text-zinc-600" />
                </div>
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                  {t.dragDropHint}
                </p>
                <p className="text-xs text-zinc-400 dark:text-zinc-600 mt-1.5">
                  {t.supportHint}
                </p>
              </div>

              {hasFiles && (
                <div className="mt-5 space-y-2 max-h-72 overflow-y-auto">
                  {files.map((item) => (
                    <div
                      key={item.id}
                      className="group flex items-center gap-3 px-3.5 py-3 rounded-xl text-sm border bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800"
                    >
                      <span className="shrink-0">
                        {item.status === "done" ? (
                          <CheckCircleIcon className="w-5 h-5 text-green-500" />
                        ) : item.status === "error" ? (
                          <XCircleIcon className="w-5 h-5 text-red-500" />
                        ) : item.status === "uploading" ? (
                          <ArrowPathIcon className="w-5 h-5 text-blue-500 animate-spin" />
                        ) : (
                          <DocumentIcon className="w-5 h-5 text-zinc-400" />
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="truncate font-medium text-zinc-800 dark:text-zinc-200">
                          {item.file.name}
                        </p>
                        <p className="text-xs text-zinc-400 dark:text-zinc-500">
                          {(item.file.size / (1024 * 1024)).toFixed(2)} MB
                        </p>
                      </div>
                      {item.status === "pending" && !uploading && (
                        <button
                          onClick={() => removeFile(item.id)}
                          className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-500 transition-all"
                        >
                          <XMarkIcon className="w-4 h-4" />
                        </button>
                      )}
                      {item.status === "uploading" && (
                        <div className="w-24">
                          <div className="flex justify-between text-xs text-zinc-400 mb-1">
                            <span>{item.progress}%</span>
                          </div>
                          <div className="w-full bg-zinc-200 dark:bg-zinc-700 rounded-full h-1">
                            <div
                              className="bg-blue-500 h-full rounded-full transition-all duration-300"
                              style={{ width: `${item.progress}%` }}
                            />
                          </div>
                        </div>
                      )}
                      {item.status === "done" && (
                        <span className="text-xs text-green-600 dark:text-green-400 font-medium shrink-0">
                          {t.uploadCompleted}
                        </span>
                      )}
                      {item.status === "error" && !uploading && (
                        <button
                          onClick={() => removeFile(item.id)}
                          className="text-red-500 hover:text-red-600 shrink-0"
                        >
                          <XMarkIcon className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {hasFiles && (
                <div className="mt-5 flex items-center justify-between pt-4 border-t border-zinc-100 dark:border-zinc-800">
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">
                    {t.filesSelected
                      .replace("{count}", String(files.length))
                      .replace("{size}", totalSizeMB.toFixed(1))}
                  </span>
                  {allDone ? (
                    <span className="text-sm text-green-600 dark:text-green-400 font-medium">
                      {t.uploadSuccess}
                    </span>
                  ) : (
                    <button
                      onClick={uploadAll}
                      disabled={uploading}
                      className={`px-5 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                        uploading
                          ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                          : "bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-100 active:scale-[0.97] shadow-sm"
                      }`}
                    >
                      {uploading ? `${t.uploadingButton}…` : t.uploadAll}
                    </button>
                  )}
                </div>
              )}
            </>
          ) : page === "library" ? (
            <LibraryView
              onUpload={() => setPage("upload")}
              onView={(hash) => {
                setViewHash(hash);
                setPage("view");
              }}
            />
          ) : (
            <ViewPage hash={viewHash} onBack={() => setPage("library")} t={t} />
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Navigation Bar ─── */

function NavBar({
  page,
  onTabChange,
  t,
}: {
  page: Page;
  onTabChange: (p: Page) => void;
  t: TranslationSchema;
}) {
  const tabs: { key: Page; icon: typeof SunIcon; label: string }[] = [
    { key: "upload", icon: ArrowUpTrayIcon, label: t.navUpload },
    { key: "library", icon: BookOpenIcon, label: t.navLibrary },
    { key: "view", icon: EyeIcon, label: t.navView },
  ];

  return (
    <div className="flex gap-1 mb-6 p-1 rounded-xl bg-zinc-100 dark:bg-zinc-800">
      {tabs.map(({ key, icon: Icon, label }) => (
        <button
          key={key}
          onClick={() => onTabChange(key)}
          className={`flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            page === key
              ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm"
              : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
          }`}
        >
          <Icon className="w-4 h-4" />
          <span className="hidden sm:inline">{label}</span>
          <span className="sm:hidden">{label.slice(0, 2)}</span>
        </button>
      ))}
    </div>
  );
}

/* ─── Library Page ─── */

interface LibraryFile {
  hash: string;
  size: number;
  modified: string;
}

function LibraryView({
  onUpload,
  onView,
}: {
  onUpload: () => void;
  onView: (hash: string) => void;
}) {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const pageSize = 20;

  // TODO: replace with real API call when backend is ready
  useEffect(() => {
    setLoading(true);
    fetch(`/api/library?page=${page}&page_size=${pageSize}`)
      .then((r) => (r.ok ? r.json() : { files: [], total: 0 }))
      .then((data) => {
        setFiles(data.files);
        setTotal(data.total);
      })
      .catch(() => {
        // Backend not ready yet — show empty state
        setFiles([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const filtered = search
    ? files.filter((f) => f.hash.includes(search))
    : files;

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-zinc-400">
        <ArrowPathIcon className="w-8 h-8 animate-spin mb-3" />
        <p className="text-sm">Loading library…</p>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-zinc-400">
        <BookOpenIcon className="w-12 h-12 mb-4 text-zinc-300 dark:text-zinc-600" />
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Library is empty
        </p>
        <p className="text-xs text-zinc-400 dark:text-zinc-600 mt-1">
          Uploaded files will appear here
        </p>
        <button
          onClick={onUpload}
          className="mt-6 px-5 py-2 rounded-lg text-sm font-medium bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-100 active:scale-[0.97] shadow-sm transition-all flex items-center gap-2"
        >
          <ArrowUpTrayIcon className="w-4 h-4" />
          Upload files
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Search */}
      <div className="relative mb-4">
        <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by hash…"
          className="w-full pl-9 pr-3 py-2 rounded-lg text-sm bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-400"
        />
      </div>

      {/* File list */}
      <div className="space-y-2">
        {filtered.map((f) => (
          <div
            key={f.hash}
            className="flex items-center gap-3 px-3.5 py-3 rounded-xl text-sm border bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800"
          >
            <DocumentIcon className="w-5 h-5 text-zinc-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
                {f.hash}
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
                {(f.size / (1024 * 1024)).toFixed(2)} MB · {f.modified}
              </p>
            </div>
            <a
              href={`/api/library/${f.hash}`}
              download
              className="p-2 rounded-lg text-zinc-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-all"
              title="Download"
            >
              <ArrowDownTrayIcon className="w-4 h-4" />
            </a>
            <button
              onClick={() => onView(f.hash)}
              className="p-2 rounded-lg text-zinc-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-all"
              title="Preview"
            >
              <EyeIcon className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-5 text-sm">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="p-2 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            <ChevronLeftIcon className="w-4 h-4" />
          </button>
          <span className="text-xs text-zinc-400">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="p-2 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            <ChevronRightIcon className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Floating upload button */}
      <button
        onClick={onUpload}
        className="fixed bottom-6 right-6 w-12 h-12 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 shadow-lg hover:shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center justify-center"
        title="Upload files"
      >
        <ArrowUpTrayIcon className="w-5 h-5" />
      </button>
    </div>
  );
}

/* ─── View / Preview Page ─── */

function ViewPage({
  hash,
  onBack,
  t,
}: {
  hash: string | null;
  onBack: () => void;
  t: TranslationSchema;
}) {
  if (!hash) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-zinc-400">
        <EyeIcon className="w-12 h-12 mb-4 text-zinc-300 dark:text-zinc-600" />
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          {t.viewNotSelected}
        </p>
        <button
          onClick={onBack}
          className="mt-4 text-xs text-blue-500 hover:text-blue-600 transition-colors"
        >
          ← {t.navLibrary}
        </button>
      </div>
    );
  }

  const fileUrl = `/api/library/${hash}`;

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 mb-4 transition-colors"
      >
        <ChevronLeftIcon className="w-3.5 h-3.5" />
        {t.navLibrary}
      </button>

      <div className="flex items-center justify-between mb-4">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate text-zinc-800 dark:text-zinc-200">
            {hash}
          </p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
            {t.viewTitle}
          </p>
        </div>
        <a
          href={fileUrl}
          download
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          <ArrowDownTrayIcon className="w-3.5 h-3.5" />
          {t.viewDownload}
        </a>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 overflow-hidden">
        <div className="flex flex-col items-center justify-center py-20 text-zinc-400">
          <DocumentIcon className="w-12 h-12 mb-3 text-zinc-300 dark:text-zinc-600" />
          <p className="text-sm">{t.viewUnsupported}</p>
          <a
            href={fileUrl}
            download
            className="mt-4 flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors"
          >
            <ArrowDownTrayIcon className="w-3.5 h-3.5" />
            {t.viewDownload}
          </a>
        </div>
      </div>
    </div>
  );
}
